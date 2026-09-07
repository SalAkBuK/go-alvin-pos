import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openConfiguredConnection } from '../../src/main/database/connection';
import {
  MIGRATION_ERROR_CODES,
  MigrationError,
  migrationChecksum,
  runMigrations,
} from '../../src/main/database/migrationRunner';
import { migration001 } from '../../src/main/database/migrations/001_initial_schema';
import { PRODUCTION_MIGRATIONS } from '../../src/main/database/migrations';
import {
  backupGateThatFails,
  backupGateThatSucceeds,
  backupGateUnreachable,
  createCapturingLogger,
  makeFailingTestMigration,
  makeTempDir,
  makeTestMigration,
} from '../helpers/database';

const FIXED_NOW = (): string => '2026-09-07T00:00:00.000Z';

function freshMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

function baseDeps() {
  return {
    logger: createCapturingLogger(),
    appVersion: '0.1.0-test',
    now: FIXED_NOW,
  };
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined
  );
}

describe('TEST-DB-007 — fresh database runs migrations in order', () => {
  it('applies the production set and records history', async () => {
    const db = freshMemoryDb();
    const deps = baseDeps();

    const result = await runMigrations(db, PRODUCTION_MIGRATIONS, {
      logger: deps.logger.logger,
      appVersion: deps.appVersion,
      now: deps.now,
      createPreMigrationBackup: backupGateUnreachable(),
    });

    expect(result.freshInstall).toBe(true);
    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(1);
    expect(result.applied).toEqual([{ version: 1, name: 'initial_schema' }]);

    const history = db.prepare('SELECT version, name, checksum FROM schema_migrations').all() as {
      version: number;
      name: string;
      checksum: string;
    }[];
    expect(history).toEqual([
      { version: 1, name: 'initial_schema', checksum: migrationChecksum(migration001) },
    ]);
    db.close();
  });

  it('applies a multi-migration set strictly in ascending order', async () => {
    const db = freshMemoryDb();
    const deps = baseDeps();
    const set = [makeTestMigration(2, 'second'), migration001, makeTestMigration(3, 'third')];

    await runMigrations(db, set, {
      logger: deps.logger.logger,
      appVersion: deps.appVersion,
      now: deps.now,
      createPreMigrationBackup: backupGateUnreachable(),
    });

    const versions = (
      db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
        version: number;
      }[]
    ).map((row) => row.version);
    expect(versions).toEqual([1, 2, 3]);
    db.close();
  });
});

describe('TEST-DB-008 — reopen does not rerun applied migrations', () => {
  it('is a no-op on the second run', async () => {
    const temp = makeTempDir();
    try {
      const file = `${temp.path}/reopen.sqlite`;
      const db1 = openConfiguredConnection(file);
      await runMigrations(db1, PRODUCTION_MIGRATIONS, {
        logger: createCapturingLogger().logger,
        appVersion: 't',
        now: FIXED_NOW,
        createPreMigrationBackup: backupGateUnreachable(),
      });
      const firstApplied = db1
        .prepare('SELECT applied_at FROM schema_migrations WHERE version=1')
        .get();
      db1.close();

      const db2 = openConfiguredConnection(file);
      const capture = createCapturingLogger();
      const result = await runMigrations(db2, PRODUCTION_MIGRATIONS, {
        logger: capture.logger,
        appVersion: 't',
        now: () => '2099-01-01T00:00:00.000Z',
        createPreMigrationBackup: backupGateUnreachable(),
      });

      expect(result.freshInstall).toBe(false);
      expect(result.applied).toEqual([]);
      // applied_at unchanged → migration 001 was not re-executed.
      expect(db2.prepare('SELECT applied_at FROM schema_migrations WHERE version=1').get()).toEqual(
        firstApplied,
      );
      expect(capture.records.some((r) => r.event === 'database.migrations.up-to-date')).toBe(true);
      db2.close();
    } finally {
      temp.cleanup();
    }
  });

  it('does not re-execute a migration body that would error on a second run', async () => {
    const db = freshMemoryDb();
    const set = [migration001, makeTestMigration(2, 'marker_once')];
    const deps = {
      logger: createCapturingLogger().logger,
      appVersion: 't',
      now: FIXED_NOW,
      createPreMigrationBackup: backupGateThatSucceeds(),
    };
    await runMigrations(db, set, deps);
    // Second run: a re-execution of `CREATE TABLE marker_once` would throw.
    await expect(runMigrations(db, set, deps)).resolves.toMatchObject({ applied: [] });
    db.close();
  });
});

describe('migration failure does not falsely advance history', () => {
  it('rolls back and leaves schema_migrations at the last good version', async () => {
    const db = freshMemoryDb();
    const capture = createCapturingLogger();
    const set = [migration001, makeFailingTestMigration(2)];

    await expect(
      runMigrations(db, set, {
        logger: capture.logger,
        appVersion: 't',
        now: FIXED_NOW,
        createPreMigrationBackup: backupGateThatSucceeds(),
      }),
    ).rejects.toMatchObject({ code: MIGRATION_ERROR_CODES.applyFailed });

    const version = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {
      v: number;
    };
    expect(version.v).toBe(1);
    expect(tableExists(db, 'half_applied_v2')).toBe(false);
    expect(capture.records.some((r) => r.event === 'database.migration.failed')).toBe(true);
    db.close();
  });
});

describe('fail-closed on inconsistent history', () => {
  it('rejects an applied version this build does not define', async () => {
    const db = freshMemoryDb();
    await runMigrations(db, PRODUCTION_MIGRATIONS, {
      logger: createCapturingLogger().logger,
      appVersion: 't',
      now: FIXED_NOW,
      createPreMigrationBackup: backupGateUnreachable(),
    });
    db.prepare(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (2, 'ghost', 'x', ?)",
    ).run(FIXED_NOW());

    await expect(
      runMigrations(db, PRODUCTION_MIGRATIONS, {
        logger: createCapturingLogger().logger,
        appVersion: 't',
        now: FIXED_NOW,
        createPreMigrationBackup: backupGateUnreachable(),
      }),
    ).rejects.toMatchObject({ code: MIGRATION_ERROR_CODES.historyUnknownVersion });
    db.close();
  });

  it('rejects checksum drift on an already-applied migration', async () => {
    const db = freshMemoryDb();
    await runMigrations(db, PRODUCTION_MIGRATIONS, {
      logger: createCapturingLogger().logger,
      appVersion: 't',
      now: FIXED_NOW,
      createPreMigrationBackup: backupGateUnreachable(),
    });
    db.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1").run();

    await expect(
      runMigrations(db, PRODUCTION_MIGRATIONS, {
        logger: createCapturingLogger().logger,
        appVersion: 't',
        now: FIXED_NOW,
        createPreMigrationBackup: backupGateUnreachable(),
      }),
    ).rejects.toBeInstanceOf(MigrationError);
    db.close();
  });

  it('rejects a gap in applied history', async () => {
    const db = freshMemoryDb();
    await runMigrations(db, [migration001, makeTestMigration(2), makeTestMigration(3)], {
      logger: createCapturingLogger().logger,
      appVersion: 't',
      now: FIXED_NOW,
      createPreMigrationBackup: backupGateThatSucceeds(),
    });
    db.prepare('DELETE FROM schema_migrations WHERE version = 2').run();

    await expect(
      runMigrations(db, [migration001, makeTestMigration(2), makeTestMigration(3)], {
        logger: createCapturingLogger().logger,
        appVersion: 't',
        now: FIXED_NOW,
        createPreMigrationBackup: backupGateThatSucceeds(),
      }),
    ).rejects.toMatchObject({ code: MIGRATION_ERROR_CODES.historyGap });
    db.close();
  });

  it('rejects a non-contiguous migration set', async () => {
    const db = freshMemoryDb();
    await expect(
      runMigrations(db, [migration001, makeTestMigration(3)], {
        logger: createCapturingLogger().logger,
        appVersion: 't',
        now: FIXED_NOW,
        createPreMigrationBackup: backupGateThatSucceeds(),
      }),
    ).rejects.toMatchObject({ code: MIGRATION_ERROR_CODES.setNotContiguous });
    db.close();
  });
});

describe('migration testing seam — upgrade of an existing database', () => {
  it('applies a pending test migration when its pre-migration backup succeeds', async () => {
    const db = freshMemoryDb();
    // Establish a v1 database first.
    await runMigrations(db, PRODUCTION_MIGRATIONS, {
      logger: createCapturingLogger().logger,
      appVersion: 't',
      now: FIXED_NOW,
      createPreMigrationBackup: backupGateUnreachable(),
    });

    const capture = createCapturingLogger();
    const result = await runMigrations(db, [migration001, makeTestMigration(2, 'seam_ok')], {
      logger: capture.logger,
      appVersion: 't',
      now: FIXED_NOW,
      createPreMigrationBackup: backupGateThatSucceeds(),
    });

    expect(result.freshInstall).toBe(false);
    expect(result.toVersion).toBe(2);
    expect(tableExists(db, 'seam_ok')).toBe(true);
    expect(
      (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v,
    ).toBe(2);
    // A backup_records row + verified log line were produced.
    expect(
      (
        db.prepare("SELECT COUNT(*) AS c FROM backup_records WHERE status='COMPLETED'").get() as {
          c: number;
        }
      ).c,
    ).toBe(1);
    expect(capture.records.some((r) => r.event === 'database.pre-migration-backup.verified')).toBe(
      true,
    );
    db.close();
  });

  it('does NOT apply a pending migration when backup verification fails; schema stays at v1', async () => {
    const db = freshMemoryDb();
    await runMigrations(db, PRODUCTION_MIGRATIONS, {
      logger: createCapturingLogger().logger,
      appVersion: 't',
      now: FIXED_NOW,
      createPreMigrationBackup: backupGateUnreachable(),
    });

    const capture = createCapturingLogger();
    await expect(
      runMigrations(db, [migration001, makeTestMigration(2, 'seam_blocked')], {
        logger: capture.logger,
        appVersion: 't',
        now: FIXED_NOW,
        createPreMigrationBackup: backupGateThatFails('DISK_FULL'),
      }),
    ).rejects.toMatchObject({ code: MIGRATION_ERROR_CODES.preMigrationBackupFailed });

    expect(tableExists(db, 'seam_blocked')).toBe(false);
    expect(
      (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v,
    ).toBe(1);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS c FROM backup_records WHERE status='FAILED'").get() as {
          c: number;
        }
      ).c,
    ).toBe(1);
    expect(capture.records.some((r) => r.event === 'database.pre-migration-backup.failed')).toBe(
      true,
    );
    db.close();
  });
});
