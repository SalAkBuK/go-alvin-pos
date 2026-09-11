import { mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type {
  BackupHealth,
  BackupType,
  ManualBackupResult,
  OffDeviceBackupConfiguration,
  OffDeviceCopyResult,
} from '../../shared/backup';
import { appendAuditEvent } from '../audit/appendAuditEvent';
import type { Logger } from '../app/logger';
import { appErrors } from '../shared/appError';
import { readBusinessTimezone } from '../settings/settingsRepository';
import { computeBackupHealth, computeOffDeviceBackupHealth } from './backupHealth';
import { backupDirFor, backupFileName } from './backupNaming';
import {
  insertCompletedBackupRecord,
  insertFailedBackupRecord,
  latestCompletedBackupRecord,
} from './backupRecordsRepository';
import { applyRetention } from './backupRetention';
import { isAutomaticBackupDue } from './backupSchedule';
import {
  BACKUP_SNAPSHOT_ERROR_CODES,
  createSqliteSnapshot,
  sanitizedOsErrorCode,
  sha256File,
  verifySqliteBackup,
} from './backupSnapshot';
import { copyBackupOffDevice } from './offDeviceCopy';
import {
  OFF_DEVICE_MANAGED_DIRECTORY_NAME,
  createOffDeviceDestinationVerifier,
  offDeviceDirectoryLabel,
} from './offDeviceDestination';
import type { OffDeviceDestinationVerifier } from './offDeviceDestination';
import {
  clearOffDeviceBackupDestination,
  readOffDeviceBackupDestination,
  writeOffDeviceBackupDestination,
} from '../settings/offDeviceBackupSettingsRepository';

/**
 * Snapshot + verification succeeded but the backup could not be recorded — the
 * database went away between the verified artifact and the `backup_records` +
 * audit write (e.g. `will-quit` closed the connection during an in-flight
 * automatic backup). The unrecorded artifact is removed; no COMPLETED row is
 * ever produced for it.
 */
const BACKUP_PERSIST_FAILED = 'BACKUP_PERSIST_FAILED';

type BackupFailureStage = 'snapshot' | 'verification' | 'persist';

/**
 * `BackupService` (`ARCHITECTURE.md §10`) — the owner-facing backup capability
 * for Phase 2L's backup-creation half.
 *
 * Responsibilities: manual backup, recurring automatic backup, WAL-safe
 * snapshot creation, verification (integrity + FK + schema version + critical
 * tables + SHA-256), `backup_records` + audit evidence, bounded retention, and
 * the backup-health DTO. Whole-database **restore** and off-device destinations
 * are a later slice and are not here.
 *
 * Concurrency: one in-process mutex. A manual and an automatic backup never
 * overlap, and the scheduler never starts a second run while one is active
 * (`REQ-BACKUP-005`, `TEST-BACKUP-008`). A checkout that commits *during* a
 * backup is safe by construction — see `backupSnapshot.ts`.
 */

export interface BackupServiceDeps {
  readonly db: Database.Database;
  /** Root backups directory (`paths.backups`). */
  readonly backupsRoot: string;
  readonly databaseFile?: string;
  readonly appVersion: string;
  readonly logger: Logger;
  /** Overridable clock for deterministic tests. */
  readonly now?: () => Date;
  /**
   * When it returns `true`, a RESTORE / MIGRATION owns the exclusive database
   * lifecycle and no new backup may start (Phase 2L-B Item 7). Optional so the
   * backup-creation tests need no coordinator.
   */
  readonly isExclusiveMaintenanceActive?: () => boolean;
  /** Injectable so CI never needs real multiple disks. */
  readonly offDeviceVerifier?: OffDeviceDestinationVerifier;
}

export interface BackupService {
  /** Owner-initiated `Back Up Now`. Throws a typed `AppError` on failure. */
  createManual(): Promise<ManualBackupResult>;
  /** Run one automatic backup if the schedule says it is owed. Never throws. */
  runAutomaticIfDue(): Promise<{ readonly ran: boolean; readonly ok: boolean }>;
  /** Backup health / status DTO. Pure read. */
  status(): BackupHealth;
  statusVerified(): Promise<BackupHealth>;
  /** Verify and persist an owner-selected parent directory (main process only). */
  configureOffDevice(selectedDirectory: string): Promise<OffDeviceBackupConfiguration>;
  clearOffDevice(): Promise<OffDeviceBackupConfiguration>;
  offDeviceConfiguration(): Promise<OffDeviceBackupConfiguration>;
  /** `true` while a backup is running (scheduler overlap guard). */
  readonly busy: boolean;
  /**
   * Resolves once any in-flight backup has settled its `backup_records` + audit
   * write. Restore calls this before closing the connection so no backup
   * callback runs a write on a closing/closed handle (Phase 2L-B Item 7).
   */
  awaitIdle(): Promise<void>;
}

type RunOutcome =
  | {
      readonly ok: true;
      readonly recordId: string;
      readonly filePath: string;
      readonly fileName: string;
      readonly sizeBytes: number;
      readonly checksumSha256: string;
      readonly schemaVersion: number;
      readonly startedAt: string;
      readonly completedAt: string;
      readonly offDevice: OffDeviceCopyResult;
    }
  | { readonly ok: false; readonly errorCode: string };

export function createBackupService(deps: BackupServiceDeps): BackupService {
  const { db, backupsRoot, appVersion, logger } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const offDeviceVerifier = deps.offDeviceVerifier ?? createOffDeviceDestinationVerifier();
  const databaseFile = deps.databaseFile ?? db.name;

  let inProgress = false;
  let activeRun: Promise<RunOutcome> | null = null;

  function sourceSchemaVersion(): number {
    const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
      version: number | null;
    };
    return row.version ?? 0;
  }

  /**
   * The one sanitized structured diagnostic event for a backup failure
   * (`POS_WORKFLOWS.md §66`, `TEST-BACKUP-009`). Carries only enum-like tokens —
   * `backupType`, the failure `stage`, the stable `BACKUP_*` code, and the OS/
   * SQLite `err.code` when it is a plain identifier. Never a raw exception
   * string, a filesystem path, a secret, customer data, or OAuth material.
   */
  function logFailure(
    backupType: BackupType,
    stage: BackupFailureStage,
    errorCode: string,
    error?: unknown,
  ): void {
    logger.error('backup', 'backup.failed', {
      backupType,
      stage,
      errorCode,
      ...(error === undefined ? {} : { osErrorCode: sanitizedOsErrorCode(error) }),
    });
  }

  function recordFailure(backupType: BackupType, startedAt: string, errorCode: string): void {
    // Failure evidence must be durable when SQLite is still writable
    // (`POS_WORKFLOWS.md §66`, `ARCHITECTURE.md §42.2`). If it is not, the
    // diagnostic log is the record — never pretend the audit write succeeded.
    try {
      db.transaction(() => {
        insertFailedBackupRecord(db, {
          backupType,
          locationKind: 'LOCAL_DISK',
          sourceAppVersion: appVersion,
          sourceSchemaVersion: safeSchemaVersion(),
          startedAt,
          errorCode,
        });
        appendAuditEvent(db, {
          eventType: 'BACKUP_FAILED',
          occurredAt: now().toISOString(),
          actorType: backupType === 'MANUAL' ? 'USER' : 'SYSTEM',
          outcome: 'FAILURE',
          appVersion,
          subjectType: 'BACKUP',
          reason: errorCode,
          details: { backupType, locationKind: 'LOCAL_DISK' },
        });
      }).immediate();
    } catch (auditError) {
      // SQLite itself is gone (e.g. shutdown closed the connection) — the
      // diagnostic log is now the only record. Sanitized fields only.
      logger.error('backup', 'backup.failure.evidence-unavailable', {
        backupType,
        errorCode,
        osErrorCode: sanitizedOsErrorCode(auditError),
      });
    }
  }

  function recordOffDeviceFailure(
    backupType: Exclude<BackupType, 'PRE_MIGRATION'>,
    startedAt: string,
    errorCode: string,
  ): void {
    try {
      db.transaction(() => {
        insertFailedBackupRecord(db, {
          backupType,
          locationKind: 'OFF_DEVICE',
          sourceAppVersion: appVersion,
          sourceSchemaVersion: safeSchemaVersion(),
          startedAt,
          errorCode,
        });
        appendAuditEvent(db, {
          eventType: 'BACKUP_FAILED',
          occurredAt: now().toISOString(),
          actorType: backupType === 'MANUAL' ? 'USER' : 'SYSTEM',
          outcome: 'FAILURE',
          appVersion,
          subjectType: 'BACKUP',
          reason: errorCode,
          details: { backupType, locationKind: 'OFF_DEVICE' },
        });
      }).immediate();
    } catch (error) {
      logger.error('backup', 'backup.off-device.failure-evidence-unavailable', {
        backupType,
        errorCode,
        osErrorCode: sanitizedOsErrorCode(error),
      });
    }
  }

  function safeSchemaVersion(): number | null {
    try {
      return sourceSchemaVersion();
    } catch {
      return null;
    }
  }

  async function copyLocalArtifactOffDevice(
    local: Omit<Extract<RunOutcome, { readonly ok: true }>, 'offDevice'>,
    backupType: Exclude<BackupType, 'PRE_MIGRATION'>,
  ): Promise<OffDeviceCopyResult> {
    const configured = readOffDeviceBackupDestination(db);
    if (!configured) {
      return { outcome: 'NOT_CONFIGURED' };
    }

    const offStartedAt = now().toISOString();
    const copied = await copyBackupOffDevice({
      verifier: offDeviceVerifier,
      operationalDatabasePath: databaseFile,
      offDeviceBackupsRoot: configured.destinationPath,
      sourceFilePath: local.filePath,
      fileName: local.fileName,
      backupType,
      logicalBackupId: local.recordId,
      sourceAppVersion: appVersion,
      sourceSchemaVersion: local.schemaVersion,
      expectedChecksumSha256: local.checksumSha256,
      expectedSizeBytes: local.sizeBytes,
      createdAt: local.startedAt,
      completedAt: local.completedAt,
    });

    if (!copied.ok) {
      recordOffDeviceFailure(backupType, offStartedAt, copied.errorCode);
      logger.warn('backup', 'backup.off-device.failed', {
        backupType,
        errorCode: copied.errorCode,
      });
      return { outcome: 'FAILED', errorCode: copied.errorCode };
    }

    const completedAt = now().toISOString();
    try {
      db.transaction(() => {
        insertCompletedBackupRecord(db, {
          backupType,
          locationKind: 'OFF_DEVICE',
          fileName: copied.fileName,
          storagePath: copied.destinationDirectory,
          sourceAppVersion: appVersion,
          sourceSchemaVersion: local.schemaVersion,
          targetAppVersion: null,
          sizeBytes: copied.sizeBytes,
          checksumSha256: copied.checksumSha256,
          startedAt: offStartedAt,
          completedAt,
        });
        appendAuditEvent(db, {
          eventType: 'BACKUP_COMPLETED',
          occurredAt: completedAt,
          actorType: backupType === 'MANUAL' ? 'USER' : 'SYSTEM',
          outcome: 'SUCCESS',
          appVersion,
          subjectType: 'BACKUP',
          details: {
            backupType,
            locationKind: 'OFF_DEVICE',
            sizeBytes: copied.sizeBytes,
          },
        });
      }).immediate();
    } catch (error) {
      recordOffDeviceFailure(backupType, offStartedAt, BACKUP_PERSIST_FAILED);
      logger.error('backup', 'backup.off-device.persist-failed', {
        backupType,
        errorCode: BACKUP_PERSIST_FAILED,
        osErrorCode: sanitizedOsErrorCode(error),
      });
      return { outcome: 'FAILED', errorCode: BACKUP_PERSIST_FAILED };
    }
    logger.info('backup', 'backup.off-device.completed', {
      backupType,
      sizeBytes: copied.sizeBytes,
    });
    return { outcome: 'COMPLETED', completedAt };
  }

  async function runBackup(backupType: BackupType): Promise<RunOutcome> {
    if (inProgress) {
      logger.info('backup', 'backup.skipped.in-progress', { backupType });
      return { ok: false, errorCode: 'BACKUP_IN_PROGRESS' };
    }
    if (deps.isExclusiveMaintenanceActive?.()) {
      // A restore owns the DB lifecycle — never start a snapshot against a
      // closing / swapping database (Phase 2L-B Item 7).
      logger.info('backup', 'backup.skipped.maintenance', { backupType });
      return { ok: false, errorCode: 'MAINTENANCE_IN_PROGRESS' };
    }
    if (!db.open) {
      return { ok: false, errorCode: 'DATABASE_UNAVAILABLE' };
    }

    inProgress = true;
    const startedAt = now().toISOString();
    const schemaVersion = safeSchemaVersion() ?? 0;
    const dir = backupDirFor(backupsRoot, backupType);
    const fileName = backupFileName(backupType, schemaVersion, now());
    const filePath = join(dir, fileName);

    try {
      logger.info('backup', 'backup.started', { backupType });

      try {
        await createSqliteSnapshot(db, filePath);
      } catch (error) {
        logFailure(backupType, 'snapshot', BACKUP_SNAPSHOT_ERROR_CODES.writeFailed, error);
        safeRemove(filePath);
        recordFailure(backupType, startedAt, BACKUP_SNAPSHOT_ERROR_CODES.writeFailed);
        return { ok: false, errorCode: BACKUP_SNAPSHOT_ERROR_CODES.writeFailed };
      }

      const verification = verifySqliteBackup(filePath, { expectedSchemaVersion: schemaVersion });
      if (!verification.ok) {
        logFailure(backupType, 'verification', verification.errorCode);
        safeRemove(filePath);
        recordFailure(backupType, startedAt, verification.errorCode);
        return { ok: false, errorCode: verification.errorCode };
      }

      const sizeBytes = statSync(filePath).size;
      const checksumSha256 = await sha256File(filePath);
      const completedAt = now().toISOString();

      let recordId = '';
      db.transaction(() => {
        recordId = insertCompletedBackupRecord(db, {
          backupType,
          locationKind: 'LOCAL_DISK',
          fileName,
          storagePath: dir,
          sourceAppVersion: appVersion,
          sourceSchemaVersion: schemaVersion,
          targetAppVersion: null,
          sizeBytes,
          checksumSha256,
          startedAt,
          completedAt,
        });
        appendAuditEvent(db, {
          eventType: 'BACKUP_COMPLETED',
          occurredAt: completedAt,
          actorType: backupType === 'MANUAL' ? 'USER' : 'SYSTEM',
          outcome: 'SUCCESS',
          appVersion,
          subjectType: 'BACKUP',
          details: { backupType, locationKind: 'LOCAL_DISK', sizeBytes },
        });
      }).immediate();

      logger.info('backup', 'backup.completed', { backupType, sizeBytes });

      const localOutcome = {
        ok: true as const,
        recordId,
        filePath,
        fileName,
        sizeBytes,
        checksumSha256,
        schemaVersion,
        startedAt,
        completedAt,
      };
      const offDevice: OffDeviceCopyResult =
        backupType === 'PRE_MIGRATION'
          ? { outcome: 'NOT_CONFIGURED' }
          : await copyLocalArtifactOffDevice(localOutcome, backupType);

      try {
        const offDeviceRoot = readOffDeviceBackupDestination(db)?.destinationPath ?? null;
        applyRetention(db, backupsRoot, now(), logger, offDeviceRoot);
      } catch (retentionError) {
        // A retention failure must never corrupt the backup we just made.
        logger.warn('backup', 'backup.retention.failed', {
          osErrorCode: sanitizedOsErrorCode(retentionError),
        });
      }

      return { ...localOutcome, offDevice };
    } catch (error) {
      // The snapshot verified, but recording it failed — the database went away
      // between the good artifact and its `backup_records` + audit write (the
      // shutdown race: `will-quit` closed the connection mid-backup). Never let
      // this reject: `runAutomaticIfDue` must not throw, and `createManual` must
      // surface a typed `BACKUP_FAILED`, not a generic INTERNAL error. The
      // unrecorded artifact is removed so it can never be mistaken for a usable
      // backup; `recordFailure` is best-effort (it also fails on a closed DB,
      // then the diagnostic log is the record).
      logFailure(backupType, 'persist', BACKUP_PERSIST_FAILED, error);
      safeRemove(filePath);
      recordFailure(backupType, startedAt, BACKUP_PERSIST_FAILED);
      return { ok: false, errorCode: BACKUP_PERSIST_FAILED };
    } finally {
      inProgress = false;
    }
  }

  function safeRemove(path: string): void {
    try {
      rmSync(path, { force: true });
    } catch {
      /* best effort */
    }
  }

  /** Run a backup while publishing its promise for {@link BackupService.awaitIdle}. */
  function trackedRunBackup(backupType: BackupType): Promise<RunOutcome> {
    const run = runBackup(backupType);
    activeRun = run;
    void run.finally(() => {
      if (activeRun === run) {
        activeRun = null;
      }
    });
    return run;
  }

  return {
    get busy(): boolean {
      return inProgress;
    },

    async awaitIdle(): Promise<void> {
      const run = activeRun;
      if (run) {
        try {
          await run;
        } catch {
          /* a failed backup is already logged/recorded; nothing to do here */
        }
      }
    },

    async createManual(): Promise<ManualBackupResult> {
      const outcome = await trackedRunBackup('MANUAL');
      if (!outcome.ok) {
        if (outcome.errorCode === 'BACKUP_IN_PROGRESS') {
          throw appErrors.backupInProgress();
        }
        throw appErrors.backupFailed();
      }
      return {
        status: 'COMPLETED',
        fileName: outcome.fileName,
        sizeBytes: outcome.sizeBytes,
        completedAt: outcome.completedAt,
        locationKind: 'LOCAL_DISK',
        ...(outcome.offDevice.outcome === 'NOT_CONFIGURED' ? {} : { offDevice: outcome.offDevice }),
      };
    },

    async runAutomaticIfDue(): Promise<{ ran: boolean; ok: boolean }> {
      if (inProgress || deps.isExclusiveMaintenanceActive?.()) {
        return { ran: false, ok: false };
      }
      let due: boolean;
      try {
        const timeZone = readBusinessTimezone(db);
        const lastSuccess = latestCompletedBackupRecord(db, 'AUTOMATIC', 'LOCAL_DISK');
        due = isAutomaticBackupDue({
          now: now(),
          timeZone,
          lastSuccessfulCompletedAt: lastSuccess?.completedAt ?? null,
        });
      } catch (error) {
        logger.warn('backup', 'backup.schedule.check-failed', {
          osErrorCode: sanitizedOsErrorCode(error),
        });
        return { ran: false, ok: false };
      }
      if (!due) {
        return { ran: false, ok: true };
      }
      const outcome = await trackedRunBackup('AUTOMATIC');
      return { ran: true, ok: outcome.ok };
    },

    async offDeviceConfiguration(): Promise<OffDeviceBackupConfiguration> {
      const configured = readOffDeviceBackupDestination(db);
      if (!configured) return { configured: false };
      const verification = await offDeviceVerifier.verify(databaseFile, configured.destinationPath);
      if (!verification.ok) {
        return {
          configured: true,
          destinationKind: null,
          displayName: offDeviceDirectoryLabel(configured.destinationPath),
          updatedAt: configured.updatedAt,
          verified: false,
        };
      }
      return {
        configured: true,
        destinationKind: verification.kind,
        displayName: verification.displayName,
        updatedAt: configured.updatedAt,
        verified: true,
      };
    },

    async configureOffDevice(selectedDirectory): Promise<OffDeviceBackupConfiguration> {
      const selected = await offDeviceVerifier.verify(databaseFile, selectedDirectory);
      if (!selected.ok) throw appErrors.offDeviceDestinationInvalid();

      const managedRoot = join(selected.canonicalPath, OFF_DEVICE_MANAGED_DIRECTORY_NAME);
      try {
        mkdirSync(managedRoot, { recursive: true });
      } catch {
        throw appErrors.offDeviceDestinationInvalid();
      }
      const managed = await offDeviceVerifier.verify(databaseFile, managedRoot);
      if (!managed.ok || managed.kind !== selected.kind) {
        throw appErrors.offDeviceDestinationInvalid();
      }
      const updatedAt = now().toISOString();
      writeOffDeviceBackupDestination(db, managed.canonicalPath, updatedAt);
      return {
        configured: true,
        destinationKind: managed.kind,
        displayName: managed.displayName,
        updatedAt,
        verified: true,
      };
    },

    async clearOffDevice(): Promise<OffDeviceBackupConfiguration> {
      clearOffDeviceBackupDestination(db);
      return { configured: false };
    },

    status(): BackupHealth {
      return computeBackupHealth(db, { now: now() });
    },

    async statusVerified(): Promise<BackupHealth> {
      const offDevice = await computeOffDeviceBackupHealth(db, {
        databaseFile,
        verifier: offDeviceVerifier,
        now: now(),
      });
      return computeBackupHealth(db, { now: now(), offDevice });
    },
  };
}
