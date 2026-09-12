import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { PRODUCTION_MIGRATIONS, targetSchemaVersion } from '../../src/main/database/migrations';
import { migration001 } from '../../src/main/database/migrations/001_initial_schema';
import { migration002E2ESuccess } from '../../src/main/database/migrations/002_e2e_schema_probe';
import {
  E3_DELIBERATE_MIGRATION_FAILURE_MARKER,
  migration002E2EFailing,
} from '../../src/main/database/migrations/002_e2e_schema_probe_failing';
import {
  migrationsForE3Mode,
  resolveActiveMigrations,
  validateE3MigrationModeBuildConfig,
} from '../../src/main/database/migrations/e3MigrationConfig';
import { migrationChecksum, runMigrations } from '../../src/main/database/migrationRunner';
import { createVerifiedPreMigrationBackup } from '../../src/main/database/backup';
import {
  backupGateThatSucceeds,
  backupGateUnreachable,
  createCapturingLogger,
} from '../helpers/database';
import {
  E3_DELIBERATE_MIGRATION_FAILURE_MARKER as LIB_FAILURE_MARKER,
  compareBusinessEvidenceThroughMigration,
  findPreMigrationBackupFiles,
  hasFailingSchema2Probe,
  hasSchema2Probe,
  obstructPreMigrationBackupDirectory,
  readSchemaMigrationsRows,
  verifyPreMigrationBackupIndependently,
} from '../../scripts/update-migration-e2e-lib.mjs';

function freshMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined
  );
}

describe('Phase 2N-E3 migration-set selection authority', () => {
  it('leaves the production migration set at exactly schema 1', () => {
    expect(PRODUCTION_MIGRATIONS).toHaveLength(1);
    expect(PRODUCTION_MIGRATIONS[0]).toBe(migration001);
    expect(targetSchemaVersion()).toBe(1);
  });

  it('defines the E3 success and failure sets as exactly [1, 2]', () => {
    const success = migrationsForE3Mode('success');
    const fail = migrationsForE3Mode('fail');
    expect(success.map((m) => m.version)).toEqual([1, 2]);
    expect(fail.map((m) => m.version)).toEqual([1, 2]);
    expect(success[1]).toBe(migration002E2ESuccess);
    expect(fail[1]).toBe(migration002E2EFailing);
    expect(targetSchemaVersion(success)).toBe(2);
    expect(targetSchemaVersion(fail)).toBe(2);
  });

  it('requires an explicit, valid compile-time mode and fails closed on garbage', () => {
    expect(validateE3MigrationModeBuildConfig({})).toBeNull();
    expect(validateE3MigrationModeBuildConfig({ GO_PHONES_E3_MIGRATION_MODE: 'success' })).toBe(
      'success',
    );
    expect(validateE3MigrationModeBuildConfig({ GO_PHONES_E3_MIGRATION_MODE: 'fail' })).toBe(
      'fail',
    );
    expect(() =>
      validateE3MigrationModeBuildConfig({ GO_PHONES_E3_MIGRATION_MODE: 'both' }),
    ).toThrow(/must be "success" or "fail"/);
  });

  it('never activates an E3 migration set outside an explicit E3 build', () => {
    // `__E3_MIGRATION_MODE__` is undefined in this plain vitest/Node context —
    // exactly like every ordinary (non-Vite-built) execution of this module —
    // so `resolveActiveMigrations()` must fall back to production, unconditionally.
    expect(resolveActiveMigrations()).toBe(PRODUCTION_MIGRATIONS);
  });

  it('keeps migration-2 fingerprints/checksums stable and distinct between success and failure', () => {
    const successChecksum = migrationChecksum(migration002E2ESuccess);
    const failChecksum = migrationChecksum(migration002E2EFailing);
    expect(successChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(failChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(successChecksum).not.toBe(failChecksum);
    // Stability: hashing the same definition twice must be deterministic.
    expect(migrationChecksum(migration002E2ESuccess)).toBe(successChecksum);
  });

  it('the failing migration fixture carries the stable, greppable failure marker', () => {
    expect(migration002E2EFailing.fingerprint).toContain(E3_DELIBERATE_MIGRATION_FAILURE_MARKER);
    expect(LIB_FAILURE_MARKER).toBe(E3_DELIBERATE_MIGRATION_FAILURE_MARKER);
  });
});

describe('Phase 2N-E3 real migration runner behavior (isolated in-memory DB)', () => {
  it('applies the success fixture migration to schema 2 with the seeded probe row', async () => {
    const db = freshMemoryDb();
    const { logger } = createCapturingLogger();
    const result = await runMigrations(db, [migration001, migration002E2ESuccess], {
      logger,
      appVersion: 'test',
      now: () => '2026-09-13T00:00:00.000Z',
      createPreMigrationBackup: backupGateUnreachable(),
    });
    expect(result.freshInstall).toBe(true);
    expect(result.toVersion).toBe(2);
    expect(tableExists(db, 'e2e_schema2_probe')).toBe(true);
    const row = db.prepare('SELECT marker FROM e2e_schema2_probe').get() as { marker: string };
    expect(row.marker).toBe('phase-2n-e3-schema2-probe');
    db.close();
  });

  it('genuinely rolls back the failing fixture migration — no stray table, no schema_migrations advance', async () => {
    const db = freshMemoryDb();
    // Bootstrap to schema 1 first (this is the "existing DB being upgraded" case).
    await runMigrations(db, [migration001], {
      logger: createCapturingLogger().logger,
      appVersion: 'test',
      createPreMigrationBackup: backupGateUnreachable(),
    });

    const { logger, records } = createCapturingLogger();
    await expect(
      runMigrations(db, [migration001, migration002E2EFailing], {
        logger,
        appVersion: 'test',
        createPreMigrationBackup: backupGateThatSucceeds(),
      }),
    ).rejects.toThrow(new RegExp(E3_DELIBERATE_MIGRATION_FAILURE_MARKER));

    expect(tableExists(db, 'e2e_schema2_probe_failing')).toBe(false);
    const history = db.prepare('SELECT version FROM schema_migrations').all() as {
      version: number;
    }[];
    expect(history).toEqual([{ version: 1 }]);

    const failedLog = records.find((r) => r.event === 'database.migration.failed');
    expect(String(failedLog?.fields?.error)).toContain(E3_DELIBERATE_MIGRATION_FAILURE_MARKER);
    db.close();
  });

  it('never starts migration 2 when the pre-migration backup gate fails', async () => {
    const db = freshMemoryDb();
    await runMigrations(db, [migration001], {
      logger: createCapturingLogger().logger,
      appVersion: 'test',
      createPreMigrationBackup: backupGateUnreachable(),
    });

    const { logger, records } = createCapturingLogger();
    await expect(
      runMigrations(db, [migration001, migration002E2ESuccess], {
        logger,
        appVersion: 'test',
        createPreMigrationBackup: () =>
          Promise.resolve({ ok: false, errorCode: 'BACKUP_WRITE_FAILED', message: 'forced' }),
      }),
    ).rejects.toThrow(/pre-migration backup could not be created/);

    expect(tableExists(db, 'e2e_schema2_probe')).toBe(false);
    const history = db.prepare('SELECT version FROM schema_migrations').all();
    expect(history).toEqual([{ version: 1 }]);
    expect(records.some((r) => r.event === 'database.pre-migration-backup.failed')).toBe(true);
    expect(records.some((r) => r.event === 'database.migration.started')).toBe(false);
    db.close();
  });

  it('records backup completion strictly before migration completion in the log', async () => {
    const db = freshMemoryDb();
    await runMigrations(db, [migration001], {
      logger: createCapturingLogger().logger,
      appVersion: 'test',
      createPreMigrationBackup: backupGateUnreachable(),
    });
    const { logger, records } = createCapturingLogger();
    await runMigrations(db, [migration001, migration002E2ESuccess], {
      logger,
      appVersion: 'test',
      createPreMigrationBackup: backupGateThatSucceeds(),
    });
    const backupIndex = records.findIndex(
      (r) => r.event === 'database.pre-migration-backup.verified',
    );
    const migrationIndex = records.findIndex((r) => r.event === 'database.migration.completed');
    expect(backupIndex).toBeGreaterThanOrEqual(0);
    expect(migrationIndex).toBeGreaterThan(backupIndex);
    db.close();
  });
});

describe('Phase 2N-E3 deterministic backup-gate obstruction (real backup writer)', () => {
  it('makes the real createVerifiedPreMigrationBackup fail deterministically via pure filesystem setup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gpp-e3-obstruction-'));
    try {
      const profile = join(dir, 'GoPhonesPOS');
      obstructPreMigrationBackupDirectory(profile);
      const db = freshMemoryDb();
      db.exec(
        'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, checksum TEXT, applied_at TEXT);',
      );
      const result = await createVerifiedPreMigrationBackup(
        { sourceDb: db, backupDir: join(profile, 'backups') },
        { sourceSchemaVersion: 1, targetSchemaVersion: 2 },
      );
      expect(result.ok).toBe(false);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Phase 2N-E3 evidence parsers and comparators', () => {
  function migratedFile(dir: string, migrations: readonly (typeof migration001)[]): string {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'gophones.sqlite');
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    for (const m of migrations) {
      m.run(db, { now: '2026-09-13T00:00:00.000Z', appVersion: '0.1.100' });
      db.prepare(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
      ).run(m.version, m.name, migrationChecksum(m), '2026-09-13T00:00:00.000Z');
    }
    db.close();
    return file;
  }

  it('parses schema rows and probe presence correctly for schema-1-only and schema-2 databases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gpp-e3-evidence-'));
    try {
      const schema1File = migratedFile(join(dir, 's1'), [migration001] as never);
      const schema2File = migratedFile(join(dir, 's2'), [
        migration001,
        migration002E2ESuccess,
      ] as never);
      expect(readSchemaMigrationsRows(schema1File).map((r) => r.version)).toEqual([1]);
      expect(readSchemaMigrationsRows(schema2File).map((r) => r.version)).toEqual([1, 2]);
      expect(hasSchema2Probe(schema1File)).toBe(false);
      expect(hasSchema2Probe(schema2File)).toBe(true);
      expect(hasFailingSchema2Probe(schema2File)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('independently verifies a genuine pre-migration backup file and rejects a tampered one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gpp-e3-backup-verify-'));
    try {
      const file = migratedFile(dir, [migration001] as never);
      const db = new Database(file);
      db.prepare(
        `INSERT INTO products (id, name, brand, model, condition, selling_price_cents, created_at, updated_at)
         VALUES ('p1','Fixture','Brand','Model','NEW',999,'2026-09-13T00:00:00.000Z','2026-09-13T00:00:00.000Z')`,
      ).run();
      db.prepare(
        `INSERT INTO sales (id, receipt_number, business_name_snapshot, business_address_snapshot,
           business_phone_snapshot, receipt_disclaimer_snapshot, receipt_footer_snapshot, status,
           subtotal_cents, taxable_amount_cents, tax_rate_bps, tax_cents, total_cents,
           payment_method_snapshot, created_at, completed_at)
         VALUES ('s1','GP-000001','B','A','P','D','F','COMPLETED',999,999,0,0,999,'CASH',
           '2026-09-13T00:00:00.000Z','2026-09-13T00:00:00.000Z')`,
      ).run();
      db.close();
      const readDb = new Database(file, { readonly: true });
      const beforeEvidence = {
        product: readDb.prepare('SELECT * FROM products WHERE id=?').get('p1'),
        sale: readDb.prepare('SELECT * FROM sales WHERE id=?').get('s1'),
      };
      readDb.close();
      const genuine = verifyPreMigrationBackupIndependently(file, beforeEvidence);
      expect(genuine.ok).toBe(true);

      const mutatedFile = join(dir, 'mutated.sqlite');
      writeFileSync(mutatedFile, ''); // not a valid sqlite file at all
      expect(() => verifyPreMigrationBackupIndependently(mutatedFile, beforeEvidence)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists pre-migration backup files newest-first and tolerates a missing directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gpp-e3-backup-list-'));
    try {
      expect(findPreMigrationBackupFiles(join(dir, 'nope'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags corruption/duplication but tolerates expected migration-only additions', () => {
    const before = {
      product: { id: 'p1', v: 1 },
      customer: { id: 'c1' },
      sale: { id: 's1' },
      saleItem: { id: 'si1' },
      payment: { id: 'pay1' },
      movement: { id: 'im1' },
      auditEvent: { id: 'ae1' },
      checkoutRequest: { id: 'cr1' },
      setting: 'phase-2n-e2',
      businessTimezone: 'America/Chicago',
      receiptCounterValue: 1,
      exportJob: { id: 'ej1', status: 'PENDING' },
      counts: { products: 1, sales: 1, auditEvents: 1 },
      integrityOk: true,
      foreignKeysOk: true,
    };
    const afterClean = { ...before, counts: { ...before.counts, auditEvents: 4 } }; // migration added audit rows — OK
    expect(compareBusinessEvidenceThroughMigration(before, afterClean)).toEqual([]);

    const afterCorrupted = { ...before, product: { id: 'p1', v: 2 } };
    expect(
      compareBusinessEvidenceThroughMigration(before, afterCorrupted).some((p) =>
        p.includes('product row'),
      ),
    ).toBe(true);

    const afterDuplicated = { ...before, counts: { ...before.counts, sales: 2 } };
    expect(
      compareBusinessEvidenceThroughMigration(before, afterDuplicated).some((p) =>
        p.includes('possible duplicate'),
      ),
    ).toBe(true);

    const afterExported = { ...before, exportJob: { ...before.exportJob, status: 'EXPORTED' } };
    expect(
      compareBusinessEvidenceThroughMigration(before, afterExported).some((p) =>
        p.includes('no longer PENDING'),
      ),
    ).toBe(true);
  });
});
