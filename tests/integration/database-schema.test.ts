import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertRequiredPragmas,
  openConfiguredConnection,
  REQUIRED_PRAGMAS,
} from '../../src/main/database/connection';
import { REQUIRED_V1_TABLES } from '../../src/main/database/schemaValidation';
import { createMigratedDb, makeTempDir } from '../helpers/database';

const EXPECTED_TABLES = [
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
];

const EXPECTED_INDEXES = [
  'ux_products_sku',
  'ux_products_barcode',
  'idx_products_name',
  'idx_products_brand',
  'idx_products_model',
  'idx_products_is_active',
  'idx_customers_phone_normalized',
  'idx_customers_name',
  'idx_sales_completed_at',
  'idx_sales_customer_id',
  'idx_sales_status',
  'idx_sale_items_sale_id',
  'idx_sale_items_product_id',
  'ux_inventory_movements_reverses',
  'idx_inventory_movements_product_id',
  'idx_inventory_movements_sale_id',
  'idx_inventory_movements_created_at',
  'idx_gsej_status',
  'idx_gsej_next_attempt_at',
  'ux_checkout_requests_sale_id',
  'idx_audit_events_event_type',
  'idx_audit_events_occurred_at',
  'idx_audit_events_subject',
  'idx_audit_events_correlation_id',
  'idx_backup_records_backup_type',
  'idx_backup_records_status',
  'idx_backup_records_completed_at',
];

function objectNames(db: Database.Database, type: 'table' | 'index'): Set<string> {
  const rows = db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type) as {
    name: string;
  }[];
  return new Set(rows.map((row) => row.name));
}

describe('001_initial_schema — tables, indexes, seeds', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = await createMigratedDb();
  });

  afterEach(() => {
    db.close();
  });

  it('creates every canonical V1 table', () => {
    const tables = objectNames(db, 'table');
    for (const table of EXPECTED_TABLES) {
      expect(tables.has(table)).toBe(true);
    }
    // The validator's required-table list matches the migration output.
    for (const table of REQUIRED_V1_TABLES) {
      expect(tables.has(table)).toBe(true);
    }
  });

  it('creates every required index (§37)', () => {
    const indexes = objectNames(db, 'index');
    for (const index of EXPECTED_INDEXES) {
      expect(indexes.has(index)).toBe(true);
    }
  });

  it('reaches schema version 1 with exactly one migration row', () => {
    const row = db
      .prepare('SELECT MAX(version) AS version, COUNT(*) AS count FROM schema_migrations')
      .get() as { version: number; count: number };
    expect(row.version).toBe(1);
    expect(row.count).toBe(1);
    const migration = db
      .prepare('SELECT name, checksum FROM schema_migrations WHERE version = 1')
      .get() as {
      name: string;
      checksum: string;
    };
    expect(migration.name).toBe('initial_schema');
    expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('initialises the two allocation counters at 0, exactly once', () => {
    const counters = db.prepare('SELECT key, value FROM counters ORDER BY key').all() as {
      key: string;
      value: number;
    }[];
    expect(counters).toEqual([
      { key: 'audit_sequence', value: 0 },
      { key: 'receipt_number', value: 0 },
    ]);
  });

  it('seeds only the documented default setting (business_timezone)', () => {
    const settings = db.prepare('SELECT key, value FROM settings ORDER BY key').all() as {
      key: string;
      value: string;
    }[];
    expect(settings).toEqual([{ key: 'business_timezone', value: 'America/Chicago' }]);
  });

  it('inserts no sample business data', () => {
    for (const table of [
      'products',
      'customers',
      'sales',
      'sale_items',
      'payments',
      'audit_events',
    ]) {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
      expect(row.count).toBe(0);
    }
  });

  it('passes PRAGMA foreign_key_check on a fresh database', () => {
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('production SQLite durability configuration (REQ-DB-007)', () => {
  let temp: ReturnType<typeof makeTempDir>;

  beforeEach(() => {
    temp = makeTempDir();
  });

  afterEach(() => {
    temp.cleanup();
  });

  it('applies WAL / synchronous=FULL / foreign_keys=ON / busy_timeout=5000 on a file connection', () => {
    const db = openConfiguredConnection(join(temp.path, 'pragmas.sqlite'));
    try {
      expect(Number(db.pragma('foreign_keys', { simple: true }))).toBe(
        REQUIRED_PRAGMAS.foreign_keys,
      );
      expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe(
        REQUIRED_PRAGMAS.journal_mode,
      );
      expect(Number(db.pragma('synchronous', { simple: true }))).toBe(REQUIRED_PRAGMAS.synchronous);
      expect(Number(db.pragma('busy_timeout', { simple: true }))).toBe(
        REQUIRED_PRAGMAS.busy_timeout,
      );
    } finally {
      db.close();
    }
  });

  it('rejects a connection whose durability pragmas were not applied', () => {
    const raw = new Database(join(temp.path, 'raw.sqlite'));
    raw.pragma('synchronous = NORMAL');
    try {
      expect(() => assertRequiredPragmas(raw)).toThrow(/durability configuration/i);
    } finally {
      raw.close();
    }
  });
});

describe('reopen preserves committed data', () => {
  let temp: ReturnType<typeof makeTempDir>;

  beforeEach(() => {
    temp = makeTempDir();
  });

  afterEach(() => {
    temp.cleanup();
  });

  it('keeps deterministic test rows across close and reopen', async () => {
    const file = join(temp.path, 'persist.sqlite');

    const db1 = await createMigratedDb(file);
    db1
      .prepare(
        `INSERT INTO products
           (id, name, brand, model, condition, selling_price_cents, quantity_on_hand, created_at, updated_at)
         VALUES ('P-TEST-1', 'Test Phone', 'TestBrand', 'TestModel', 'NEW', 19900, 3,
                 '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z')`,
      )
      .run();
    db1.close();

    const db2 = openConfiguredConnection(file);
    try {
      expect(
        db2.prepare('SELECT id, name, quantity_on_hand FROM products WHERE id = ?').get('P-TEST-1'),
      ).toEqual({ id: 'P-TEST-1', name: 'Test Phone', quantity_on_hand: 3 });
      expect(
        (db2.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v,
      ).toBe(1);
    } finally {
      db2.close();
    }
  });
});
