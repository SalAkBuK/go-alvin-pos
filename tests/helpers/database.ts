import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from '../../src/main/app/logger';
import { openConfiguredConnection } from '../../src/main/database/connection';
import { runMigrations } from '../../src/main/database/migrationRunner';
import { PRODUCTION_MIGRATIONS } from '../../src/main/database/migrations';
import type {
  Migration,
  PreMigrationBackupContext,
  PreMigrationBackupResult,
} from '../../src/main/database/types';

export interface LogRecord {
  readonly level: string;
  readonly category: string;
  readonly event: string;
  readonly fields: Record<string, unknown> | undefined;
}

export interface CapturingLogger {
  readonly logger: Logger;
  readonly records: readonly LogRecord[];
}

/** A `Logger`-shaped stub that records calls instead of writing to disk. */
export function createCapturingLogger(): CapturingLogger {
  const records: LogRecord[] = [];
  const make =
    (level: string) =>
    (category: string, event: string, fields?: Record<string, unknown>): void => {
      records.push({ level, category, event, fields });
    };
  const logger = {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    fatal: make('fatal'),
  } as unknown as Logger;
  return { logger, records };
}

export interface TempDir {
  readonly path: string;
  cleanup(): void;
}

export function makeTempDir(prefix = 'gpp-db-'): TempDir {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    cleanup(): void {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

/** A pre-migration backup gate stub that always succeeds (no real I/O). */
export function backupGateThatSucceeds(): (
  db: Database.Database,
  ctx: PreMigrationBackupContext,
) => Promise<PreMigrationBackupResult> {
  return (_db, ctx) =>
    Promise.resolve({
      ok: true,
      fileName: `stub-v${ctx.sourceSchemaVersion}.sqlite`,
      storagePath: '/stub',
      sizeBytes: 4096,
      checksumSha256: 'a'.repeat(64),
    });
}

/** A pre-migration backup gate stub that always fails. */
export function backupGateThatFails(
  errorCode = 'STUB_BACKUP_FAILED',
): (db: Database.Database, ctx: PreMigrationBackupContext) => Promise<PreMigrationBackupResult> {
  return () => Promise.resolve({ ok: false, errorCode, message: 'forced failure for test' });
}

/** Gate that must never be called (fresh installs skip the gate). */
export function backupGateUnreachable(): (
  db: Database.Database,
  ctx: PreMigrationBackupContext,
) => Promise<PreMigrationBackupResult> {
  return () => {
    throw new Error('pre-migration backup gate should not run for a fresh install');
  };
}

/**
 * A migrated database at the production schema version.
 * `':memory:'` keeps constraint tests fast (WAL is irrelevant there); pass a
 * file path to exercise reopen/persistence.
 */
export async function createMigratedDb(filename = ':memory:'): Promise<Database.Database> {
  const db =
    filename === ':memory:' ? new Database(':memory:') : openConfiguredConnection(filename);
  if (filename === ':memory:') {
    db.pragma('foreign_keys = ON');
  }
  const { logger } = createCapturingLogger();
  await runMigrations(db, PRODUCTION_MIGRATIONS, {
    logger,
    appVersion: 'test',
    createPreMigrationBackup: backupGateUnreachable(),
  });
  return db;
}

/** A trivial test-only migration that creates a marker table. Never a production `002`. */
export function makeTestMigration(
  version: number,
  tableName = `test_marker_v${version}`,
): Migration {
  const sql = `CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY, note TEXT NOT NULL);`;
  return {
    version,
    name: `test_migration_${version}`,
    fingerprint: sql,
    run(db): void {
      db.exec(sql);
    },
  };
}

/** A test-only migration whose body always throws once inside its transaction. */
export function makeFailingTestMigration(version: number): Migration {
  return {
    version,
    name: `failing_test_migration_${version}`,
    fingerprint: `failing-${version}`,
    run(db): void {
      db.exec(`CREATE TABLE half_applied_v${version} (id INTEGER PRIMARY KEY);`);
      throw new Error(`intentional failure in test migration ${version}`);
    },
  };
}
