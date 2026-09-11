import type Database from 'better-sqlite3';
import type {
  BackupHealth,
  LatestAutomaticBackup,
  OffDeviceBackupHealth,
} from '../../shared/backup';
import { win32 } from 'node:path';
import { readBusinessTimezone } from '../settings/settingsRepository';
import { readOffDeviceBackupDestination } from '../settings/offDeviceBackupSettingsRepository';
import {
  latestBackupRecord,
  latestCompletedBackupRecord,
  latestFailedBackupRecord,
  listBackupRecords,
} from './backupRecordsRepository';
import { backupDirFor } from './backupNaming';
import type { OffDeviceDestinationVerifier } from './offDeviceDestination';
import { OFF_DEVICE_DESTINATION_ERROR_CODES } from './offDeviceDestination';
import { AUTOMATIC_BACKUP_LOCAL_TIME, isAutomaticBackupOverdue } from './backupSchedule';

/**
 * Backup health / status DTO (`REQ-BACKUP-007`, `REQ-BACKUP-010`;
 * `POS_WORKFLOWS.md §96`; `TEST-BACKUP-011`, `TEST-BACKUP-020`).
 *
 * Pure read: no snapshot, no write, no network. Designed as the single source of
 * backup-health truth so Phase 2M's Support & Diagnostics can render it without
 * re-deriving overdue/last-success logic.
 *
 * `overdue` is a protection warning only — the caller must never present it as
 * "database corrupted".
 */
export function computeBackupHealth(
  db: Database.Database,
  options?: { readonly now?: Date; readonly offDevice?: OffDeviceBackupHealth },
): BackupHealth {
  const now = options?.now ?? new Date();
  const timeZone = readBusinessTimezone(db);

  // LOCAL_DISK health is authoritative and intentionally isolated from any
  // best-effort OFF_DEVICE copy result.
  const latestAutomatic = latestBackupRecord(db, 'AUTOMATIC', 'LOCAL_DISK');
  const lastSuccessfulAutomatic = latestCompletedBackupRecord(db, 'AUTOMATIC', 'LOCAL_DISK');
  const latestFailure = latestFailedBackupRecord(db, 'LOCAL_DISK');

  let lastAutomatic: LatestAutomaticBackup | null = null;
  if (latestAutomatic) {
    lastAutomatic =
      latestAutomatic.status === 'COMPLETED'
        ? { outcome: 'COMPLETED', at: latestAutomatic.completedAt ?? latestAutomatic.startedAt }
        : {
            outcome: 'FAILED',
            at: latestAutomatic.startedAt,
            errorCode: latestAutomatic.errorCode ?? 'BACKUP_FAILED',
          };
  }

  return {
    lastAutomatic,
    lastSuccessfulAutomaticAt: lastSuccessfulAutomatic?.completedAt ?? null,
    overdue: isAutomaticBackupOverdue({
      now,
      timeZone,
      lastSuccessfulCompletedAt: lastSuccessfulAutomatic?.completedAt ?? null,
    }),
    lastFailure: latestFailure
      ? {
          backupType: latestFailure.backupType,
          at: latestFailure.startedAt,
          errorCode: latestFailure.errorCode ?? 'BACKUP_FAILED',
        }
      : null,
    protection: options?.offDevice?.state === 'HEALTHY' ? 'OFF_DEVICE' : 'LOCAL_DISK_ONLY',
    offDevice: options?.offDevice ?? { state: 'NOT_CONFIGURED' },
    automaticEnabled: true,
    schedule: { cadence: 'DAILY', atLocalTime: AUTOMATIC_BACKUP_LOCAL_TIME },
  };
}

function samePath(a: string, b: string): boolean {
  return win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase();
}

/** Reverify the configured destination before claiming current protection. */
export async function computeOffDeviceBackupHealth(
  db: Database.Database,
  options: {
    readonly databaseFile: string;
    readonly verifier: OffDeviceDestinationVerifier;
    readonly now?: Date;
  },
): Promise<OffDeviceBackupHealth> {
  const configured = readOffDeviceBackupDestination(db);
  if (!configured) return { state: 'NOT_CONFIGURED' };

  const configuredAt = new Date(configured.updatedAt).getTime();

  const verification = await options.verifier.verify(
    options.databaseFile,
    configured.destinationPath,
  );
  if (!verification.ok) {
    const unavailable =
      verification.errorCode === OFF_DEVICE_DESTINATION_ERROR_CODES.inaccessible ||
      verification.errorCode === OFF_DEVICE_DESTINATION_ERROR_CODES.notWritable;
    return {
      state: 'ATTENTION',
      reason: unavailable ? 'UNAVAILABLE' : 'VERIFICATION_FAILED',
      // A past success for the currently configured destination is still
      // meaningful context even though *today's* live verification failed —
      // matched against the stored configuration path itself, since a failed
      // verification has no fresh canonical path to compare against
      // (Phase 2L-C.1 fix). Current failure always still means ATTENTION:
      // history is never enough to mark protection healthy.
      lastSuccessfulAt: latestSuccessfulOffDeviceCompletion(
        db,
        configured.destinationPath,
        configuredAt,
      ),
      // Never fabricated: the destination kind (USB/NETWORK) is only ever
      // known from a fresh, successful verification — it is not persisted
      // anywhere, so a failed verification genuinely has none to report.
      destinationKind: null,
    };
  }

  const records = listBackupRecords(db).filter(
    (row) => row.locationKind === 'OFF_DEVICE' && new Date(row.startedAt).getTime() >= configuredAt,
  );
  const latestSuccessfulAt = latestSuccessfulOffDeviceCompletion(
    db,
    verification.canonicalPath,
    configuredAt,
  );
  if (latestSuccessfulAt === null) {
    return {
      state: 'ATTENTION',
      reason: 'NEVER_SUCCEEDED',
      lastSuccessfulAt: null,
      destinationKind: verification.kind,
    };
  }

  const latestFailure = records
    .filter((row) => row.status === 'FAILED')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (latestFailure && latestFailure.startedAt > latestSuccessfulAt) {
    return {
      state: 'ATTENTION',
      reason: 'LAST_COPY_FAILED',
      lastSuccessfulAt: latestSuccessfulAt,
      destinationKind: verification.kind,
    };
  }

  const stale = isAutomaticBackupOverdue({
    now: options.now ?? new Date(),
    timeZone: readBusinessTimezone(db),
    lastSuccessfulCompletedAt: latestSuccessfulAt,
  });
  if (stale) {
    return {
      state: 'ATTENTION',
      reason: 'STALE',
      lastSuccessfulAt: latestSuccessfulAt,
      destinationKind: verification.kind,
    };
  }
  return {
    state: 'HEALTHY',
    lastSuccessfulAt: latestSuccessfulAt,
    destinationKind: verification.kind,
  };
}

/**
 * The most recent COMPLETED `OFF_DEVICE` backup whose stored `storage_path`
 * still matches `destinationPath`'s managed `automatic`/`manual`
 * subdirectories, started at/after `configuredAtMs` — or `null` when none
 * exists. Shared by both the live-verified-success and live-verification-
 * failure paths above so "was there ever a real success for the destination
 * that's configured right now" is answered identically either way.
 */
function latestSuccessfulOffDeviceCompletion(
  db: Database.Database,
  destinationPath: string,
  configuredAtMs: number,
): string | null {
  const completed = listBackupRecords(db).filter(
    (row) =>
      row.locationKind === 'OFF_DEVICE' &&
      row.status === 'COMPLETED' &&
      row.storagePath !== null &&
      new Date(row.startedAt).getTime() >= configuredAtMs &&
      (samePath(row.storagePath, backupDirFor(destinationPath, 'AUTOMATIC')) ||
        samePath(row.storagePath, backupDirFor(destinationPath, 'MANUAL'))),
  );
  return (
    [...completed].sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))[0]
      ?.completedAt ?? null
  );
}
