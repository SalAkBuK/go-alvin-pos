import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { Logger } from '../app/logger';
import { backupDirFor, parseManagedBackupFile } from './backupNaming';
import { deleteBackupRecord, listBackupRecords } from './backupRecordsRepository';
import type { BackupRecordRow } from './backupRecordsRepository';
import { AUTOMATIC_RETENTION_DAYS, MANUAL_RETENTION_DAYS } from './backupSchedule';
import { sanitizedOsErrorCode } from './backupSnapshot';

/**
 * Bounded retention cleanup (`REQ-BACKUP-006`; `DATA_MODEL.md §36B`;
 * `POS_WORKFLOWS.md §65` step 7).
 *
 * Only files the application can prove are its own AUTOMATIC / MANUAL backup
 * artifacts are ever touched. Guarantees, enforced here:
 *
 *  - AUTOMATIC backups older than 14 days are pruned (`LOCAL_DISK` and
 *    `OFF_DEVICE` alike — the fixed V1 off-device periods are identical to
 *    the local defaults by design, `PRODUCT_SCOPE.md §23`);
 *  - MANUAL backups older than 90 days are pruned;
 *  - PRE_MIGRATION backups are never pruned (recovery/migration evidence; also
 *    never OFF_DEVICE — the local-first copy step never duplicates them);
 *  - the single most recent verified usable backup is never pruned, even if
 *    it is past its age policy — applied INDEPENDENTLY per `location_kind`
 *    (Phase 2L-C.1 fix): an `OFF_DEVICE` survivor can never justify deleting
 *    the last otherwise-eligible `LOCAL_DISK` backup, and a `LOCAL_DISK`
 *    survivor can never justify deleting the last `OFF_DEVICE` backup. Local
 *    recovery must remain usable on its own even when off-device protection
 *    happens to look newer (a paired off-device copy's `completed_at` is
 *    always slightly later than its local counterpart's, which would
 *    otherwise make a location-agnostic "keep the newest" rule systematically
 *    prefer the `OFF_DEVICE` row);
 *  - the active operational database is out of scope entirely (retention only
 *    ever walks the local `backups/automatic`/`backups/manual` subdirectories
 *    and, when a destination is configured, the same two subdirectories
 *    inside the exact app-managed `OFF_DEVICE` directory);
 *  - a prune failure for one file never corrupts or removes any other backup;
 *  - pruning an `OFF_DEVICE` row also removes its matching sidecar manifest —
 *    a sidecar is never swept independently of the SQLite file it describes.
 *
 * Pruning removes the file *and* its `backup_records` row together; the durable
 * `BACKUP_COMPLETED` audit event remains the permanent evidence that the backup
 * once existed.
 */

const DAY_MS = 86_400_000;

export interface RetentionPlan {
  readonly prune: readonly BackupRecordRow[];
  readonly keep: readonly BackupRecordRow[];
}

/** Decide which COMPLETED AUTOMATIC/MANUAL rows are out of policy. Pure. */
export function planRetention(records: readonly BackupRecordRow[], now: Date): RetentionPlan {
  const completed = records.filter((r) => r.status === 'COMPLETED');
  const nowMs = now.getTime();

  const overAge = (r: BackupRecordRow): boolean => {
    if (r.completedAt === null) {
      return false;
    }
    const ageMs = nowMs - new Date(r.completedAt).getTime();
    if (r.backupType === 'AUTOMATIC') {
      return ageMs > AUTOMATIC_RETENTION_DAYS * DAY_MS;
    }
    if (r.backupType === 'MANUAL') {
      return ageMs > MANUAL_RETENTION_DAYS * DAY_MS;
    }
    return false; // PRE_MIGRATION — never pruned by age
  };

  let prune = completed.filter(overAge);

  // Never prune the only verified usable backup — decided INDEPENDENTLY per
  // `location_kind` (Phase 2L-C.1 fix). Pooling LOCAL_DISK and OFF_DEVICE
  // together here would let an OFF_DEVICE row's naturally-later
  // `completed_at` (it is always recorded strictly after its paired local
  // row's, since the off-device copy step runs after the local backup
  // commits) systematically "outrank" the LOCAL_DISK row and get chosen as
  // the sole survivor — deleting the last local recovery backup even though a
  // healthy local copy is exactly what must never be sacrificed for an
  // off-device one, and vice versa.
  for (const locationKind of ['LOCAL_DISK', 'OFF_DEVICE'] as const) {
    const completedHere = completed.filter((r) => r.locationKind === locationKind);
    const pruneHere = prune.filter((r) => r.locationKind === locationKind);
    const survivorsHere = completedHere.filter((r) => !pruneHere.includes(r));
    if (survivorsHere.length === 0 && pruneHere.length > 0) {
      const newest = [...pruneHere].sort(byCompletedAtDesc)[0]!;
      prune = prune.filter((r) => r !== newest);
    }
  }

  const prunedIds = new Set(prune.map((r) => r.id));
  return { prune, keep: completed.filter((r) => !prunedIds.has(r.id)) };
}

function byCompletedAtDesc(a: BackupRecordRow, b: BackupRecordRow): number {
  return (b.completedAt ?? '').localeCompare(a.completedAt ?? '');
}

function referencedByCompleted(
  records: readonly BackupRecordRow[],
  dir: string,
  fileName: string,
): boolean {
  return records.some(
    (r) => r.status === 'COMPLETED' && r.storagePath === dir && r.fileName === fileName,
  );
}

export interface ApplyRetentionResult {
  readonly prunedRecords: number;
  readonly prunedOrphanFiles: number;
  readonly failures: number;
}

/**
 * Execute a retention pass: prune out-of-policy records + their files, then
 * sweep orphaned managed files (a partial/aborted snapshot with no COMPLETED
 * row) from the automatic/manual directories. When `offDeviceBackupsRoot` is
 * given, the exact same sweep also runs against the configured app-managed
 * OFF_DEVICE directory; an unavailable destination (drive unplugged, share
 * unreachable) is skipped safely — a missing directory is simply not walked,
 * and any other cleanup failure there is caught and logged exactly like a
 * local one, never thrown (Phase 2L-C).
 */
export function applyRetention(
  db: Database.Database,
  backupsRoot: string,
  now: Date,
  logger: Logger,
  offDeviceBackupsRoot?: string | null,
): ApplyRetentionResult {
  const records = listBackupRecords(db);
  const plan = planRetention(records, now);

  let prunedRecords = 0;
  let failures = 0;

  for (const row of plan.prune) {
    try {
      if (row.storagePath && row.fileName && parseManagedBackupFile(row.fileName)) {
        const filePath = join(row.storagePath, row.fileName);
        if (existsSync(filePath)) {
          rmSync(filePath, { force: true });
        }
        if (row.locationKind === 'OFF_DEVICE') {
          const sidecarPath = `${filePath}.manifest.json`;
          if (existsSync(sidecarPath)) {
            rmSync(sidecarPath, { force: true });
          }
        }
      }
      deleteBackupRecord(db, row.id);
      prunedRecords += 1;
    } catch (error) {
      failures += 1;
      logger.warn('backup', 'backup.retention.prune-failed', {
        backupType: row.backupType,
        osErrorCode: sanitizedOsErrorCode(error),
      });
    }
  }

  // Orphan sweep (Phase 2L-B Item 17; Phase 2L-C extends it to the configured
  // OFF_DEVICE directory). Only unmistakable partial / aborted snapshots
  // (`*.sqlite.partial`) are removed. A *final* managed `*.sqlite` artifact
  // with no matching `backup_records` row is PRESERVED as recovery evidence
  // and merely noted — restoring an older backup rewinds the `backup_records`
  // catalogue, and a legitimate newer backup file must never be deleted just
  // because the restored catalogue no longer lists it. "When uncertain,
  // preserve a backup rather than delete recovery evidence." A dangling
  // sidecar with no matching `.sqlite` is left alone for the same reason — it
  // is only ever removed together with the file it describes, above.
  let prunedOrphanFiles = 0;
  const sweepRoots: ReadonlyArray<{
    readonly root: string;
    readonly locationKind: 'LOCAL_DISK' | 'OFF_DEVICE';
  }> = [
    { root: backupsRoot, locationKind: 'LOCAL_DISK' },
    ...(offDeviceBackupsRoot
      ? [{ root: offDeviceBackupsRoot, locationKind: 'OFF_DEVICE' as const }]
      : []),
  ];
  for (const { root, locationKind } of sweepRoots) {
    for (const type of ['AUTOMATIC', 'MANUAL'] as const) {
      const dir = backupDirFor(root, type);
      if (!existsSync(dir)) {
        continue;
      }
      let entries: readonly string[];
      try {
        entries = readdirSync(dir);
      } catch (error) {
        // The destination went away mid-sweep (e.g. a USB drive unplugged) —
        // skip it safely; the other root's sweep must still proceed.
        failures += 1;
        logger.warn('backup', 'backup.retention.sweep-unavailable', {
          locationKind,
          osErrorCode: sanitizedOsErrorCode(error),
        });
        continue;
      }
      for (const name of entries) {
        const isPartial = name.endsWith('.sqlite.partial');
        if (!isPartial) {
          if (parseManagedBackupFile(name) && !referencedByCompleted(records, dir, name)) {
            logger.info('backup', 'backup.retention.unreferenced-backup-preserved', {
              fileName: name,
              locationKind,
            });
          }
          continue;
        }
        try {
          const filePath = join(dir, name);
          // A `.partial` newer than 60s could belong to a backup running right now
          // (the service mutex makes that rare, but be safe) — leave it.
          if (Date.now() - statSync(filePath).mtimeMs < 60_000) {
            continue;
          }
          rmSync(filePath, { force: true });
          prunedOrphanFiles += 1;
          logger.info('backup', 'backup.retention.partial-removed', {
            fileName: name,
            locationKind,
          });
        } catch (error) {
          failures += 1;
          logger.warn('backup', 'backup.retention.partial-remove-failed', {
            locationKind,
            osErrorCode: sanitizedOsErrorCode(error),
          });
        }
      }
    }
  }

  if (prunedRecords > 0 || prunedOrphanFiles > 0 || failures > 0) {
    logger.info('backup', 'backup.retention.completed', {
      prunedRecords,
      prunedOrphanFiles,
      failures,
    });
  }
  return { prunedRecords, prunedOrphanFiles, failures };
}
