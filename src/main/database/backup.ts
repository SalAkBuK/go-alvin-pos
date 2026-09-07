import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { PreMigrationBackupContext, PreMigrationBackupResult } from './types';

/**
 * Pre-migration backup (`DATA_MODEL.md §54`, `§36B`, `REQ-BACKUP-008`).
 *
 * Uses the SQLite Online Backup API (`better-sqlite3`'s `Database.backup()`) —
 * the mechanism the architecture fixed for WAL-safe copies. A raw
 * `copyFile(gophones.sqlite)` of a live WAL database is explicitly prohibited
 * and is never done here.
 *
 * This is only the amount of backup infrastructure schema migration needs. The
 * V1 backup *product* feature (scheduling, retention, restore UI, off-device
 * config, health UI) is a later slice and is not built here.
 */

function isoNow(): string {
  return new Date().toISOString();
}

function backupFileName(sourceSchemaVersion: number): string {
  // Colons are not path-safe on Windows; use a compact timestamp.
  const stamp = isoNow().replace(/[:.]/g, '-');
  return `gophones-pre-migration-v${sourceSchemaVersion}-${stamp}.sqlite`;
}

/**
 * Verify a backup file is an independently readable SQLite database that
 * contains the expected source schema version. Opens it as a *separate*
 * read-only connection — it must not depend on the live database at all.
 */
function verifyBackupFile(
  filePath: string,
  expectedSourceSchemaVersion: number,
): { ok: true } | { ok: false; errorCode: string; message: string } {
  let verifier: Database.Database | undefined;
  try {
    verifier = new Database(filePath, { readonly: true, fileMustExist: true });
    const quickCheck = String(verifier.pragma('quick_check', { simple: true })).toLowerCase();
    if (quickCheck !== 'ok') {
      return {
        ok: false,
        errorCode: 'BACKUP_INTEGRITY_FAILED',
        message: `quick_check returned "${quickCheck}"`,
      };
    }

    const fkViolations = verifier.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) {
      return {
        ok: false,
        errorCode: 'BACKUP_FK_VIOLATIONS',
        message: `${fkViolations.length} foreign-key violation(s) in backup`,
      };
    }

    const row = verifier.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
      version: number | null;
    };
    if (row.version !== expectedSourceSchemaVersion) {
      return {
        ok: false,
        errorCode: 'BACKUP_SCHEMA_VERSION_MISMATCH',
        message: `backup schema version ${String(row.version)} != expected ${expectedSourceSchemaVersion}`,
      };
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      errorCode: 'BACKUP_NOT_READABLE',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    verifier?.close();
  }
}

export interface CreatePreMigrationBackupOptions {
  readonly sourceDb: Database.Database;
  /** Directory that receives the backup file; created on demand. */
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
  const fileName = backupFileName(ctx.sourceSchemaVersion);
  const filePath = join(dir, fileName);

  try {
    mkdirSync(dir, { recursive: true });
    await options.sourceDb.backup(filePath);
  } catch (error) {
    return {
      ok: false,
      errorCode: 'BACKUP_WRITE_FAILED',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const verification = verifyBackupFile(filePath, ctx.sourceSchemaVersion);
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

  const bytes = readFileSync(filePath);
  return {
    ok: true,
    fileName: basename(filePath),
    storagePath: dirname(filePath),
    sizeBytes: statSync(filePath).size,
    checksumSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
