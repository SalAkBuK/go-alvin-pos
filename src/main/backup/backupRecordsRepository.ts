import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { BackupLocationKind, BackupType } from '../../shared/backup';

/**
 * `backup_records` SQL, isolated behind a repository (`ARCHITECTURE.md §12`;
 * `DATA_MODEL.md §36B`).
 *
 * The rows exist only for health, audit, retention, and migration evidence —
 * the backup files remain the backup. A COMPLETED row carries the full file
 * identity + provenance the `001` CHECK constraints require; a FAILED row
 * carries a stable sanitized `error_code` and whatever timestamps are available.
 * Raw exception text and filesystem paths outside the managed `storage_path`
 * are never persisted here.
 */

export interface BackupRecordRow {
  readonly id: string;
  readonly backupType: BackupType;
  readonly locationKind: BackupLocationKind;
  readonly status: 'COMPLETED' | 'FAILED';
  readonly fileName: string | null;
  readonly storagePath: string | null;
  readonly sourceAppVersion: string | null;
  readonly sourceSchemaVersion: number | null;
  readonly targetAppVersion: string | null;
  readonly sizeBytes: number | null;
  readonly checksumSha256: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly errorCode: string | null;
}

export interface CompletedBackupInput {
  readonly backupType: BackupType;
  readonly locationKind: BackupLocationKind;
  readonly fileName: string;
  readonly storagePath: string;
  readonly sourceAppVersion: string;
  readonly sourceSchemaVersion: number;
  /** Required for `PRE_MIGRATION`; may be null otherwise (`DATA_MODEL.md §36B`). */
  readonly targetAppVersion: string | null;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface FailedBackupInput {
  readonly backupType: BackupType;
  readonly locationKind: BackupLocationKind;
  readonly sourceAppVersion: string | null;
  readonly sourceSchemaVersion: number | null;
  readonly startedAt: string;
  readonly errorCode: string;
}

const SELECT_COLUMNS = `
  id, backup_type AS backupType, location_kind AS locationKind, status,
  file_name AS fileName, storage_path AS storagePath,
  source_app_version AS sourceAppVersion, source_schema_version AS sourceSchemaVersion,
  target_app_version AS targetAppVersion, size_bytes AS sizeBytes,
  checksum_sha256 AS checksumSha256, started_at AS startedAt,
  completed_at AS completedAt, error_code AS errorCode
`;

/**
 * Insert one COMPLETED backup row. Caller wraps this in the same
 * `BEGIN IMMEDIATE` transaction as the matching `BACKUP_COMPLETED` audit event
 * (`DATA_MODEL.md §36B`: "committed together when SQLite is writable").
 */
export function insertCompletedBackupRecord(
  db: Database.Database,
  input: CompletedBackupInput,
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO backup_records
       (id, backup_type, location_kind, status, file_name, storage_path,
        source_app_version, source_schema_version, target_app_version,
        size_bytes, checksum_sha256, started_at, completed_at, error_code)
     VALUES (?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    id,
    input.backupType,
    input.locationKind,
    input.fileName,
    input.storagePath,
    input.sourceAppVersion,
    input.sourceSchemaVersion,
    input.targetAppVersion,
    input.sizeBytes,
    input.checksumSha256,
    input.startedAt,
    input.completedAt,
  );
  return id;
}

/** Insert one FAILED backup row (stable sanitized `error_code`, file metadata null). */
export function insertFailedBackupRecord(db: Database.Database, input: FailedBackupInput): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO backup_records
       (id, backup_type, location_kind, status, file_name, storage_path,
        source_app_version, source_schema_version, target_app_version,
        size_bytes, checksum_sha256, started_at, completed_at, error_code)
     VALUES (?, ?, ?, 'FAILED', NULL, NULL, ?, ?, NULL, NULL, NULL, ?, NULL, ?)`,
  ).run(
    id,
    input.backupType,
    input.locationKind,
    input.sourceAppVersion,
    input.sourceSchemaVersion,
    input.startedAt,
    input.errorCode,
  );
  return id;
}

/** Every backup row, newest attempt first (`started_at DESC`). */
export function listBackupRecords(db: Database.Database): BackupRecordRow[] {
  return db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM backup_records ORDER BY started_at DESC, id DESC`)
    .all() as BackupRecordRow[];
}

/** The most recent attempt (COMPLETED or FAILED) of a given type, or `null`. */
export function latestBackupRecord(
  db: Database.Database,
  backupType: BackupType,
  locationKind?: BackupLocationKind,
): BackupRecordRow | null {
  const locationClause = locationKind === undefined ? '' : ' AND location_kind = ?';
  const params = locationKind === undefined ? [backupType] : [backupType, locationKind];
  return (
    (db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM backup_records
         WHERE backup_type = ?${locationClause} ORDER BY started_at DESC, id DESC LIMIT 1`,
      )
      .get(...params) as BackupRecordRow | undefined) ?? null
  );
}

/** The most recent COMPLETED backup of a given type, or `null`. */
export function latestCompletedBackupRecord(
  db: Database.Database,
  backupType: BackupType,
  locationKind?: BackupLocationKind,
): BackupRecordRow | null {
  const locationClause = locationKind === undefined ? '' : ' AND location_kind = ?';
  const params = locationKind === undefined ? [backupType] : [backupType, locationKind];
  return (
    (db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM backup_records
         WHERE backup_type = ? AND status = 'COMPLETED'${locationClause}
         ORDER BY completed_at DESC, id DESC LIMIT 1`,
      )
      .get(...params) as BackupRecordRow | undefined) ?? null
  );
}

/** The most recent FAILED backup of any type, or `null`. */
export function latestFailedBackupRecord(
  db: Database.Database,
  locationKind?: BackupLocationKind,
): BackupRecordRow | null {
  const locationClause = locationKind === undefined ? '' : ' AND location_kind = ?';
  const params = locationKind === undefined ? [] : [locationKind];
  return (
    (db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM backup_records
         WHERE status = 'FAILED'${locationClause} ORDER BY started_at DESC, id DESC LIMIT 1`,
      )
      .get(...params) as BackupRecordRow | undefined) ?? null
  );
}

/** Count of COMPLETED backup rows across all types (used to protect "the only usable backup"). */
export function countCompletedBackupRecords(db: Database.Database): number {
  return (
    db.prepare("SELECT COUNT(*) AS c FROM backup_records WHERE status = 'COMPLETED'").get() as {
      c: number;
    }
  ).c;
}

/** Delete one backup row by id (retention prune — the durable audit event remains the evidence). */
export function deleteBackupRecord(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM backup_records WHERE id = ?').run(id);
}
