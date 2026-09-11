import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

/**
 * Extension for a snapshot still being written. A crash mid-copy leaves a
 * `*.sqlite.partial` file, which retention/orphan cleanup can unambiguously
 * remove — a final `*.sqlite` artifact is never deleted merely for lacking a
 * `backup_records` row (Phase 2L-B Item 17).
 */
export const PARTIAL_SNAPSHOT_SUFFIX = '.partial';

/**
 * The one WAL-safe SQLite snapshot + verification primitive
 * (`DATA_MODEL.md §54`, "Backup and Recovery-Copy Safety Under WAL";
 * `ARCHITECTURE.md §37`; `POS_WORKFLOWS.md §65`).
 *
 * Every backup Go Phones POS produces — automatic, manual, and pre-migration —
 * goes through {@link createSqliteSnapshot}. It uses the SQLite Online Backup
 * API exposed by `better-sqlite3` (`Database.prototype.backup()`), the mechanism
 * the architecture fixed for WAL databases. A raw `copyFile()` of the live main
 * `.sqlite` file (even after `wal_checkpoint`) is explicitly prohibited and is
 * never performed here.
 *
 * Because `db.backup()` copies pages in batches and yields the event loop
 * between them, a checkout transaction *can* commit on the same connection while
 * a backup is in progress. SQLite's online-backup semantics fold same-connection
 * writes into the backing pages, so the finished file is a transactionally
 * consistent snapshot as of backup completion — it reflects the state entirely
 * before or entirely after that checkout, never a torn mix (`TEST-BACKUP-002A`).
 */

/** Stable, sanitized error codes for a snapshot or verification failure. */
export const BACKUP_SNAPSHOT_ERROR_CODES = {
  writeFailed: 'BACKUP_WRITE_FAILED',
  notReadable: 'BACKUP_NOT_READABLE',
  integrityFailed: 'BACKUP_INTEGRITY_FAILED',
  fkViolations: 'BACKUP_FK_VIOLATIONS',
  notGoPhonesSchema: 'BACKUP_NOT_GO_PHONES_SCHEMA',
  schemaVersionMismatch: 'BACKUP_SCHEMA_VERSION_MISMATCH',
  criticalTableUnreadable: 'BACKUP_CRITICAL_TABLE_UNREADABLE',
} as const;

export type BackupSnapshotErrorCode =
  (typeof BACKUP_SNAPSHOT_ERROR_CODES)[keyof typeof BACKUP_SNAPSHOT_ERROR_CODES];

/**
 * The OS / SQLite error token (`err.code`, e.g. `ENOSPC`, `EACCES`, `EBUSY`,
 * `SQLITE_IOERR`) when it is a plain uppercase identifier — never a path, a
 * message, or a secret. Returns `undefined` for anything else, so a backup
 * diagnostic event can carry a useful classification without leaking a raw
 * exception string or filesystem path.
 */
export function sanitizedOsErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code) && code.length <= 40
    ? code
    : undefined;
}

export type VerifyBackupResult =
  | { readonly ok: true; readonly schemaVersion: number }
  | { readonly ok: false; readonly errorCode: string; readonly message: string };

/**
 * The tables a restored backup must contain and be able to read
 * (`DATA_MODEL.md §52`). Presence is checked for all; a representative read is
 * done against the core few so "critical schema/table state is readable" is
 * actually exercised, not just asserted structurally.
 */
export const BACKUP_REQUIRED_TABLES = [
  'products',
  'customers',
  'sales',
  'sale_items',
  'payments',
  'inventory_movements',
  'settings',
  'google_sheet_export_jobs',
  'checkout_requests',
  'counters',
  'audit_events',
  'backup_records',
  'schema_migrations',
] as const;

const REPRESENTATIVE_READ_TABLES = [
  'schema_migrations',
  'settings',
  'counters',
  'products',
  'sales',
  'audit_events',
] as const;

/** SHA-256 of a file's exact bytes, streamed (deterministic for a given artifact). */
export async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Produce a transactionally consistent snapshot of `sourceDb` at `destPath`.
 * The parent directory is created on demand. Throws on any I/O failure — the
 * caller maps it to {@link BACKUP_SNAPSHOT_ERROR_CODES.writeFailed}.
 *
 * The SQLite Online Backup API copies page 1 verbatim, so the fresh file
 * inherits the source's WAL journal mode and would carry `-wal`/`-shm`
 * companions. Immediately after the copy the snapshot is normalized to a
 * single self-contained rollback-journal file (`journal_mode = DELETE`,
 * which checkpoints and folds in any WAL content) so the backup artifact is
 * one portable `.sqlite` file with a stable checksum.
 *
 * The copy is written to `<destPath>.partial` and renamed to `<destPath>` only
 * after normalization succeeds, so a crash mid-copy never leaves a truncated
 * file at the final name (Phase 2L-B Item 17).
 */
export async function createSqliteSnapshot(
  sourceDb: Database.Database,
  destPath: string,
): Promise<void> {
  mkdirSync(dirname(destPath), { recursive: true });
  const partialPath = `${destPath}${PARTIAL_SNAPSHOT_SUFFIX}`;
  try {
    rmSync(partialPath, { force: true });
  } catch {
    /* best effort */
  }
  await sourceDb.backup(partialPath);

  const snapshot = new Database(partialPath);
  try {
    snapshot.pragma('journal_mode = DELETE');
  } finally {
    snapshot.close();
  }
  renameSync(partialPath, destPath);
}

/**
 * Verify a backup file is an independently usable Go Phones POS database:
 * opens as its own read-only connection (never touching the live database),
 * runs `quick_check` + `foreign_key_check`, confirms the expected schema
 * version, and confirms every canonical table is present and the core ones are
 * readable.
 */
export function verifySqliteBackup(
  path: string,
  options: { readonly expectedSchemaVersion: number },
): VerifyBackupResult {
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });

    const quick = String(db.pragma('quick_check', { simple: true })).toLowerCase();
    if (quick !== 'ok') {
      return {
        ok: false,
        errorCode: BACKUP_SNAPSHOT_ERROR_CODES.integrityFailed,
        message: `quick_check returned "${quick}"`,
      };
    }

    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) {
      return {
        ok: false,
        errorCode: BACKUP_SNAPSHOT_ERROR_CODES.fkViolations,
        message: `${fkViolations.length} foreign-key violation(s) in backup`,
      };
    }

    const presentTables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((row) => row.name),
    );

    // `schema_migrations` is the definitive "is this a Go Phones POS database?"
    // marker — check it (and read it) first.
    if (!presentTables.has('schema_migrations')) {
      return {
        ok: false,
        errorCode: BACKUP_SNAPSHOT_ERROR_CODES.notGoPhonesSchema,
        message: 'backup has no schema_migrations table',
      };
    }
    let schemaVersion: number | null;
    try {
      schemaVersion = (
        db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
          version: number | null;
        }
      ).version;
    } catch (error) {
      return {
        ok: false,
        errorCode: BACKUP_SNAPSHOT_ERROR_CODES.notGoPhonesSchema,
        message: `schema_migrations not readable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // Schema-version match is checked before the table set, so a wrong-version
    // Go Phones POS backup is classified as a schema mismatch (→ a clear
    // "older/newer version" restore message) rather than "critical table
    // unreadable".
    if (schemaVersion !== options.expectedSchemaVersion) {
      return {
        ok: false,
        errorCode: BACKUP_SNAPSHOT_ERROR_CODES.schemaVersionMismatch,
        message: `backup schema version ${String(schemaVersion)} != expected ${options.expectedSchemaVersion}`,
      };
    }

    for (const table of BACKUP_REQUIRED_TABLES) {
      if (!presentTables.has(table)) {
        return {
          ok: false,
          errorCode: BACKUP_SNAPSHOT_ERROR_CODES.criticalTableUnreadable,
          message: `backup is missing required table "${table}"`,
        };
      }
    }

    for (const table of REPRESENTATIVE_READ_TABLES) {
      try {
        db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get();
      } catch (error) {
        return {
          ok: false,
          errorCode: BACKUP_SNAPSHOT_ERROR_CODES.criticalTableUnreadable,
          message: `table "${table}" not readable: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    return { ok: true, schemaVersion };
  } catch (error) {
    return {
      ok: false,
      errorCode: BACKUP_SNAPSHOT_ERROR_CODES.notReadable,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db?.close();
  }
}
