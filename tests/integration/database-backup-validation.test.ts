import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVerifiedPreMigrationBackup } from '../../src/main/database/backup';
import { validateSchema } from '../../src/main/database/schemaValidation';
import { targetSchemaVersion } from '../../src/main/database/migrations';
import { createMigratedDb, makeTempDir } from '../helpers/database';

describe('pre-migration backup (§54, §36B, REQ-BACKUP-008)', () => {
  let temp: ReturnType<typeof makeTempDir>;

  beforeEach(() => {
    temp = makeTempDir();
  });

  afterEach(() => {
    temp.cleanup();
  });

  it('produces an independently readable SQLite file with the expected source version', async () => {
    const sourceFile = join(temp.path, 'source.sqlite');
    const sourceDb = await createMigratedDb(sourceFile);
    sourceDb
      .prepare(
        `INSERT INTO products
           (id, name, brand, model, condition, selling_price_cents, quantity_on_hand, created_at, updated_at)
         VALUES ('P-BK', 'Backed Up', 'B', 'M', 'NEW', 100, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      )
      .run();

    const result = await createVerifiedPreMigrationBackup(
      { sourceDb, backupDir: join(temp.path, 'backups') },
      { sourceSchemaVersion: 1, targetSchemaVersion: 2 },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const backupPath = join(result.storagePath, result.fileName);
    expect(existsSync(backupPath)).toBe(true);
    expect(createHash('sha256').update(readFileSync(backupPath)).digest('hex')).toBe(
      result.checksumSha256,
    );
    expect(result.sizeBytes).toBeGreaterThan(0);

    // Independently readable, with the data and schema version intact.
    const verifier = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      expect(String(verifier.pragma('quick_check', { simple: true })).toLowerCase()).toBe('ok');
      expect(
        (verifier.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number })
          .v,
      ).toBe(1);
      expect(
        (verifier.prepare("SELECT name FROM products WHERE id='P-BK'").get() as { name: string })
          .name,
      ).toBe('Backed Up');
    } finally {
      verifier.close();
    }
    sourceDb.close();
  });

  it('fails verification when the expected source schema version does not match', async () => {
    const sourceDb = await createMigratedDb(join(temp.path, 'source2.sqlite'));
    const result = await createVerifiedPreMigrationBackup(
      { sourceDb, backupDir: join(temp.path, 'backups2') },
      { sourceSchemaVersion: 99, targetSchemaVersion: 100 },
    );
    expect(result).toMatchObject({ ok: false, errorCode: 'BACKUP_SCHEMA_VERSION_MISMATCH' });
    sourceDb.close();
  });
});

describe('schema validation health gate (§11)', () => {
  let vtemp: ReturnType<typeof makeTempDir>;

  beforeEach(() => {
    vtemp = makeTempDir();
  });

  afterEach(() => {
    vtemp.cleanup();
  });

  it('passes for a freshly migrated file database with the full durability config', async () => {
    const db = await createMigratedDb(join(vtemp.path, 'valid.sqlite'));
    const validation = validateSchema(db, { expectedVersion: targetSchemaVersion() });
    expect(validation.failures).toEqual([]);
    expect(validation.ok).toBe(true);
    expect(validation.schemaVersion).toBe(1);
    db.close();
  });

  it('fails when a critical table is missing', async () => {
    const db = await createMigratedDb();
    db.exec('DROP TABLE payments');
    const validation = validateSchema(db, { expectedVersion: targetSchemaVersion() });
    expect(validation.ok).toBe(false);
    expect(validation.failures.some((f) => f.includes('payments'))).toBe(true);
    db.close();
  });

  it('fails when a required counter row is missing', async () => {
    const db = await createMigratedDb();
    db.prepare("DELETE FROM counters WHERE key='audit_sequence'").run();
    const validation = validateSchema(db, { expectedVersion: targetSchemaVersion() });
    expect(validation.ok).toBe(false);
    expect(validation.failures.some((f) => f.includes('audit_sequence'))).toBe(true);
    db.close();
  });

  it('fails when the schema version is not the expected one', async () => {
    const db = await createMigratedDb();
    const validation = validateSchema(db, { expectedVersion: 2 });
    expect(validation.ok).toBe(false);
    expect(validation.failures.some((f) => f.includes('schema version'))).toBe(true);
    db.close();
  });

  it('fails when durability pragmas are wrong', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gpp-val-'));
    try {
      // A file DB opened WITHOUT the configured connection: journal_mode stays 'delete'.
      const raw = new Database(join(dir, 'raw.sqlite'));
      raw.pragma('foreign_keys = ON');
      raw.exec(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, checksum TEXT, applied_at TEXT); INSERT INTO schema_migrations VALUES (1,'x','y','z');",
      );
      const validation = validateSchema(raw, { expectedVersion: 1 });
      expect(validation.ok).toBe(false);
      expect(validation.failures.some((f) => f.toLowerCase().includes('journal_mode'))).toBe(true);
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when PRAGMA foreign_key_check reports a violation', async () => {
    const db = await createMigratedDb();
    // Insert an orphan row with FK enforcement briefly off, then re-check.
    db.pragma('foreign_keys = OFF');
    db.prepare(
      `INSERT INTO sale_items
         (id, sale_id, product_id, product_name_snapshot, brand_snapshot, model_snapshot,
          condition_snapshot, listed_price_cents, sold_price_cents, discount_cents, quantity,
          line_subtotal_cents, line_total_cents, created_at)
       VALUES ('SI-ORPHAN', 'NO-SALE', 'NO-PRODUCT', 'x', 'b', 'm', 'NEW', 1, 1, 0, 1, 1, 1, '2026-01-01T00:00:00Z')`,
    ).run();
    db.pragma('foreign_keys = ON');

    const validation = validateSchema(db, { expectedVersion: 1 });
    expect(validation.ok).toBe(false);
    expect(validation.failures.some((f) => f.includes('foreign_key_check'))).toBe(true);
    db.close();
  });
});
