import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVerifiedPreMigrationBackup } from '../../src/main/database/backup';
import { MIGRATION_ERROR_CODES, runMigrations } from '../../src/main/database/migrationRunner';
import { migration001 } from '../../src/main/database/migrations/001_initial_schema';
import {
  createCapturingLogger,
  createMigratedDb,
  makeTempDir,
  makeTestMigration,
} from '../helpers/database';

/**
 * Phase 2L — the verified pre-migration backup gate wired into the REAL
 * migration path with the REAL WAL-safe snapshot mechanism
 * (`REQ-BACKUP-008`; `DATA_MODEL.md §36B`, `§54`;
 * `TEST-BACKUP-012`, `TEST-BACKUP-013`; adversarial 001-bootstrap exemption).
 *
 * A synthetic migration `002` proves ordering without committing a real
 * production schema change.
 */

let temp: ReturnType<typeof makeTempDir>;
let db: Database.Database;
let backupDir: string;

const NOW = (): string => '2026-09-10T09:00:00.000Z';

function realGate(dir: string) {
  return (
    sourceDb: Database.Database,
    ctx: Parameters<typeof createVerifiedPreMigrationBackup>[1],
  ) => createVerifiedPreMigrationBackup({ sourceDb, backupDir: dir }, ctx);
}

beforeEach(async () => {
  temp = makeTempDir('gpp-premig-');
  backupDir = join(temp.path, 'backups');
  db = await createMigratedDb(join(temp.path, 'gophones.sqlite'));
  db.prepare(
    `INSERT INTO products (id, name, brand, model, condition, selling_price_cents, quantity_on_hand, created_at, updated_at)
     VALUES ('P1', 'Existing', 'B', 'M', 'NEW', 100, 3, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run();
});

afterEach(() => {
  db.close();
  temp.cleanup();
});

describe('TEST-BACKUP-012 — verified pre-migration backup before any DDL', () => {
  it('creates + verifies + records the backup, then applies migration 002', async () => {
    const { logger, records } = createCapturingLogger();

    const result = await runMigrations(db, [migration001, makeTestMigration(2, 'seam_marker')], {
      logger,
      appVersion: '0.2.0-test',
      now: NOW,
      createPreMigrationBackup: realGate(backupDir),
    });

    expect(result.toVersion).toBe(2);
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'seam_marker'").get(),
    ).toBeDefined();

    // A real, independently-readable pre-migration snapshot exists.
    const preDir = join(backupDir, 'pre-migration');
    const files = readdirSync(preDir);
    expect(files).toHaveLength(1);
    const snapshot = new Database(join(preDir, files[0]!), { readonly: true, fileMustExist: true });
    try {
      expect(String(snapshot.pragma('quick_check', { simple: true })).toLowerCase()).toBe('ok');
      expect(
        (snapshot.prepare('SELECT MAX(version) v FROM schema_migrations').get() as { v: number }).v,
      ).toBe(1);
      // Taken BEFORE the DDL — the 002 marker table is absent from the backup.
      expect(
        snapshot.prepare("SELECT 1 FROM sqlite_master WHERE name = 'seam_marker'").get(),
      ).toBeUndefined();
      // The pre-migration business data is present.
      expect(snapshot.prepare('SELECT COUNT(*) c FROM products').get()).toEqual({ c: 1 });
    } finally {
      snapshot.close();
    }

    // Durable evidence: a COMPLETED PRE_MIGRATION row with target_app_version.
    const row = db
      .prepare(
        "SELECT * FROM backup_records WHERE backup_type = 'PRE_MIGRATION' AND status = 'COMPLETED'",
      )
      .get() as Record<string, unknown>;
    expect(row.target_app_version).toBe('0.2.0-test');
    expect(row.checksum_sha256).toMatch(/^[0-9a-f]{64}$/);

    // Ordering: BACKUP_COMPLETED is recorded before MIGRATION_COMPLETED.
    const events = db
      .prepare(
        "SELECT event_type, sequence FROM audit_events WHERE event_type IN ('BACKUP_COMPLETED','MIGRATION_COMPLETED') ORDER BY sequence",
      )
      .all() as Array<{ event_type: string }>;
    expect(events.map((e) => e.event_type)).toEqual(['BACKUP_COMPLETED', 'MIGRATION_COMPLETED']);
    expect(records.some((r) => r.event === 'database.pre-migration-backup.verified')).toBe(true);
  });
});

describe('TEST-BACKUP-013 — a failed pre-migration backup stops the migration before any DDL', () => {
  it('does not begin migration 002 and records the failure', async () => {
    const { logger } = createCapturingLogger();
    // A file where the pre-migration directory needs to be → snapshot write fails.
    writeFileSync(join(temp.path, 'backups'), 'not a directory');

    await expect(
      runMigrations(db, [migration001, makeTestMigration(2, 'must_not_exist')], {
        logger,
        appVersion: '0.2.0-test',
        now: NOW,
        createPreMigrationBackup: realGate(join(temp.path, 'backups', 'nested')),
      }),
    ).rejects.toMatchObject({ code: MIGRATION_ERROR_CODES.preMigrationBackupFailed });

    // DDL never ran.
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'must_not_exist'").get(),
    ).toBeUndefined();
    expect(
      (db.prepare('SELECT MAX(version) v FROM schema_migrations').get() as { v: number }).v,
    ).toBe(1);

    const failed = db
      .prepare(
        "SELECT * FROM backup_records WHERE backup_type = 'PRE_MIGRATION' AND status = 'FAILED'",
      )
      .get() as Record<string, unknown>;
    expect(failed.error_code).toBeTruthy();
    expect(failed.file_name).toBeNull();
  });
});

describe('adversarial — 001 bootstrap remains exempt from the pre-migration gate', () => {
  it('runs 001 on a brand-new database with no backup and no backup_records row', async () => {
    const fresh = new Database(':memory:');
    fresh.pragma('foreign_keys = ON');
    const { logger } = createCapturingLogger();
    let gateCalled = false;

    await runMigrations(fresh, [migration001], {
      logger,
      appVersion: '0.1.0-test',
      now: NOW,
      createPreMigrationBackup: () => {
        gateCalled = true;
        return Promise.reject(new Error('gate must not run for bootstrap'));
      },
    });

    expect(gateCalled).toBe(false);
    expect((fresh.prepare('SELECT COUNT(*) c FROM backup_records').get() as { c: number }).c).toBe(
      0,
    );
    expect(existsSync(join(temp.path, 'backups', 'pre-migration'))).toBe(false);
    fresh.close();
  });
});
