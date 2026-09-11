import { rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import {
  BACKUP_SNAPSHOT_ERROR_CODES,
  createSqliteSnapshot,
  sha256File,
  verifySqliteBackup,
} from '../backup/backupSnapshot';
import { backupFileName } from '../backup/backupNaming';
import type { PreMigrationBackupContext, PreMigrationBackupResult } from './types';

/**
 * Pre-migration backup (`DATA_MODEL.md §54`, `§36B`, `REQ-BACKUP-008`).
 *
 * Delegates to the shared WAL-safe snapshot primitive (`backup/backupSnapshot`)
 * — the same mechanism the Phase 2L automatic/manual backup service uses — so
 * there is exactly one snapshot implementation. A raw `copyFile()` of a live
 * WAL database is explicitly prohibited and is never done.
 *
 * The migration runner (`migrationRunner.ts`) calls this before any DDL when an
 * already-initialized database is being upgraded; a failed or unverifiable
 * result stops the migration (`REQ-BACKUP-008`, `TEST-BACKUP-012`,
 * `TEST-BACKUP-013`).
 */

export interface CreatePreMigrationBackupOptions {
  readonly sourceDb: Database.Database;
  /** Root backups directory; the pre-migration subdirectory is created on demand. */
  readonly backupDir: string;
}

/**
 * Create and verify one SQLite-consistent pre-migration backup. Returns a
 * structured result — the caller records `backup_records` and gates the
 * migration on `ok`.
 */
export async function createVerifiedPreMigrationBackup(
  options: CreatePreMigrationBackupOptions,
  ctx: PreMigrationBackupContext,
): Promise<PreMigrationBackupResult> {
  const dir = join(options.backupDir, 'pre-migration');
  const filePath = join(dir, backupFileName('PRE_MIGRATION', ctx.sourceSchemaVersion));

  try {
    await createSqliteSnapshot(options.sourceDb, filePath);
  } catch (error) {
    return {
      ok: false,
      errorCode: BACKUP_SNAPSHOT_ERROR_CODES.writeFailed,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const verification = verifySqliteBackup(filePath, {
    expectedSchemaVersion: ctx.sourceSchemaVersion,
  });
  if (!verification.ok) {
    // A backup that cannot be verified is not a backup — remove the artifact so
    // it can never be mistaken for a usable one.
    try {
      rmSync(filePath, { force: true });
    } catch {
      /* best effort */
    }
    return { ok: false, errorCode: verification.errorCode, message: verification.message };
  }

  return {
    ok: true,
    fileName: basename(filePath),
    storagePath: dirname(filePath),
    sizeBytes: statSync(filePath).size,
    checksumSha256: await sha256File(filePath),
  };
}
