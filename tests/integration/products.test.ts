import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openConfiguredConnection } from '../../src/main/database/connection';
import { runMigrations } from '../../src/main/database/migrationRunner';
import { PRODUCTION_MIGRATIONS } from '../../src/main/database/migrations';
import { createProductService } from '../../src/main/products/productService';
import { isAppError } from '../../src/main/shared/appError';
import {
  backupGateUnreachable,
  createCapturingLogger,
  createMigratedDb,
  makeTempDir,
} from '../helpers/database';
import type { CreateProductInput } from '../../src/shared/products';

/**
 * Products vertical-slice integration tests against real SQLite
 * (`TEST_PLAN.md` TEST-PROD-001..009 + task `§21` regression list).
 */

const T = '2026-09-07T12:00:00.000Z';

function service(db: Database.Database, now: () => string = () => T) {
  return createProductService({ db, now });
}

function baseInput(overrides: Partial<CreateProductInput> = {}): CreateProductInput {
  return {
    name: 'iPhone 15 128GB',
    brand: 'Apple',
    model: 'iPhone 15',
    condition: 'NEW',
    sellingPriceCents: 59900,
    quantity: 0,
    ...overrides,
  };
}

let db: Database.Database;

beforeEach(async () => {
  db = await createMigratedDb();
});

afterEach(() => {
  db.close();
});

describe('TEST-PROD-001 — Create Product', () => {
  it('persists a valid product and returns it as an active record', () => {
    const product = service(db).create(baseInput({ quantity: 5 }));
    expect(product.name).toBe('iPhone 15 128GB');
    expect(product.isActive).toBe(true);
    expect(product.quantityOnHand).toBe(5);

    const row = db.prepare('SELECT COUNT(*) AS c FROM products').get() as { c: number };
    expect(row.c).toBe(1);
  });

  it('appears in local search by name, brand, model', () => {
    service(db).create(baseInput({ quantity: 1 }));
    expect(service(db).search({ query: 'iphone' })).toHaveLength(1);
    expect(service(db).search({ query: 'Apple' })).toHaveLength(1);
    expect(service(db).search({ query: 'nokia' })).toHaveLength(0);
  });
});

describe('TEST-PROD-002 — Initial Inventory Movement', () => {
  it('creates one INITIAL_STOCK +5 movement for starting quantity 5', () => {
    const product = service(db).create(baseInput({ quantity: 5 }));
    const movements = db
      .prepare('SELECT * FROM inventory_movements WHERE product_id = ?')
      .all(product.id) as Record<string, unknown>[];
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      movement_type: 'INITIAL_STOCK',
      quantity_before: 0,
      quantity_change: 5,
      quantity_after: 5,
      sale_id: null,
      reverses_movement_id: null,
      reason: null,
    });
  });

  it('creates NO movement for starting quantity 0', () => {
    const product = service(db).create(baseInput({ quantity: 0 }));
    const count = db
      .prepare('SELECT COUNT(*) AS c FROM inventory_movements WHERE product_id = ?')
      .get(product.id) as { c: number };
    expect(count.c).toBe(0);
  });
});

describe('TEST-PROD-003 / TEST-PROD-004 — Duplicate barcode / SKU', () => {
  it('rejects a second product with the same barcode (typed DUPLICATE_BARCODE)', () => {
    service(db).create(baseInput({ barcode: '123456789' }));
    try {
      service(db).create(baseInput({ barcode: '123456789', name: 'Other' }));
      expect.unreachable();
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('DUPLICATE_BARCODE');
    }
    expect(db.prepare('SELECT COUNT(*) AS c FROM products').get()).toMatchObject({ c: 1 });
  });

  it('rejects a second product with the same SKU (typed DUPLICATE_SKU)', () => {
    service(db).create(baseInput({ sku: 'ABC-100' }));
    try {
      service(db).create(baseInput({ sku: 'ABC-100', name: 'Other' }));
      expect.unreachable();
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('DUPLICATE_SKU');
    }
  });

  it('SKU and barcode uniqueness stay case-sensitive', () => {
    service(db).create(baseInput({ sku: 'ABC-100', barcode: 'AB12' }));
    expect(() =>
      service(db).create(baseInput({ sku: 'abc-100', barcode: 'ab12', name: 'Lower' })),
    ).not.toThrow();
  });
});

describe('TEST-PROD-004A — Multiple products without SKU/barcode; blank becomes NULL', () => {
  it('accepts many SKU-less / barcode-less products', () => {
    service(db).create(baseInput({ name: 'A' }));
    service(db).create(baseInput({ name: 'B' }));
    service(db).create(baseInput({ name: 'C', sku: '   ', barcode: '' }));
    const nulls = db
      .prepare('SELECT COUNT(*) AS c FROM products WHERE sku IS NULL AND barcode IS NULL')
      .get() as { c: number };
    expect(nulls.c).toBe(3);
  });

  it('stores a blank/whitespace SKU and barcode as NULL, not empty string', () => {
    const product = service(db).create(baseInput({ sku: '  ', barcode: '   ' }));
    const row = db.prepare('SELECT sku, barcode FROM products WHERE id = ?').get(product.id);
    expect(row).toEqual({ sku: null, barcode: null });
  });
});

describe('TEST-PROD-005 — Archive Product', () => {
  it('sets is_active = 0, keeps the row, and removes it from sellable search', () => {
    const product = service(db).create(baseInput({ quantity: 2, name: 'ToArchive' }));
    const archived = service(db).archive(product.id);
    expect(archived.isActive).toBe(false);

    // Still in SQLite.
    expect(db.prepare('SELECT COUNT(*) AS c FROM products').get()).toMatchObject({ c: 1 });
    // Excluded from normal (sellable) search + list.
    expect(service(db).search({ query: 'ToArchive' })).toHaveLength(0);
    expect(service(db).list()).toHaveLength(0);
    // Visible to product management when explicitly requested.
    expect(service(db).list({ includeArchived: true })).toHaveLength(1);
    expect(service(db).search({ query: 'ToArchive', includeArchived: true })).toHaveLength(1);
  });
});

describe('TEST-PROD-007 — Allowed Product Conditions', () => {
  it.each(['NEW', 'USED', 'REFURBISHED'] as const)('accepts condition %s', (condition) => {
    expect(() => service(db).create(baseInput({ condition, name: condition }))).not.toThrow();
  });

  it('rejects an unsupported condition at the application layer', () => {
    try {
      service(db).create(baseInput({ condition: 'LIKE_NEW' as never }));
      expect.unreachable();
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('VALIDATION');
    }
  });
});

describe('TEST-PROD-008 — Complete Product Edit Persistence', () => {
  it('edits every editable field, bumps updated_at, and stays searchable after reopen', async () => {
    const temp = makeTempDir();
    const file = join(temp.path, 'db.sqlite');
    try {
      let conn = openConfiguredConnection(file);
      await runMigrations(conn, PRODUCTION_MIGRATIONS, {
        logger: createCapturingLogger().logger,
        appVersion: 'test',
        createPreMigrationBackup: backupGateUnreachable(),
      });

      const created = createProductService({ db: conn, now: () => T }).create(
        baseInput({ quantity: 4 }),
      );

      const later = '2026-09-08T09:00:00.000Z';
      const updated = createProductService({ db: conn, now: () => later }).update(created.id, {
        name: 'iPhone 15 Clearance',
        brand: 'Apple Inc',
        model: 'A2846',
        condition: 'REFURBISHED',
        sellingPriceCents: 48000,
        costPriceCents: 30000,
        sku: 'IP15-CLR',
        barcode: '0001112223',
        lowStockThreshold: 2,
      });
      expect(updated.updatedAt).toBe(later);
      expect(updated.quantityOnHand).toBe(4); // unchanged by a metadata edit
      // No inventory movement created for a metadata/price change.
      expect(conn.prepare('SELECT COUNT(*) AS c FROM inventory_movements').get()).toMatchObject({
        c: 1,
      });

      conn.close();
      conn = openConfiguredConnection(file);
      const reloaded = createProductService({ db: conn }).search({ query: 'Clearance' });
      expect(reloaded).toHaveLength(1);
      expect(reloaded[0]).toMatchObject({
        name: 'iPhone 15 Clearance',
        brand: 'Apple Inc',
        model: 'A2846',
        condition: 'REFURBISHED',
        sellingPriceCents: 48000,
        costPriceCents: 30000,
        sku: 'IP15-CLR',
        barcode: '0001112223',
        lowStockThreshold: 2,
        lowStock: false,
      });
      conn.close();
    } finally {
      temp.cleanup();
    }
  });

  it('rejects a generic edit that tries to change quantity', () => {
    const product = service(db).create(baseInput({ quantity: 5 }));
    try {
      service(db).update(product.id, {
        name: 'x',
        brand: 'x',
        model: 'x',
        condition: 'NEW',
        sellingPriceCents: 100,
        costPriceCents: null,
        sku: null,
        barcode: null,
        lowStockThreshold: null,
        quantity: 99,
      } as never);
      expect.unreachable();
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('VALIDATION');
    }
  });
});

describe('TEST-PROD-009 — Low Stock Indication', () => {
  it('flags lowStock only at or below the threshold', () => {
    const above = service(db).create(
      baseInput({ name: 'Above', quantity: 5, lowStockThreshold: 3 }),
    );
    const at = service(db).create(baseInput({ name: 'At', quantity: 3, lowStockThreshold: 3 }));
    const below = service(db).create(
      baseInput({ name: 'Below', quantity: 1, lowStockThreshold: 3 }),
    );
    const noThreshold = service(db).create(baseInput({ name: 'None', quantity: 0 }));

    expect(above.lowStock).toBe(false);
    expect(at.lowStock).toBe(true);
    expect(below.lowStock).toBe(true);
    expect(below.zeroStock).toBe(false);
    expect(noThreshold.lowStock).toBe(false);
    expect(noThreshold.zeroStock).toBe(true);
  });
});

describe('task §21 — malformed numeric payloads are rejected before mutation', () => {
  it.each([
    { sellingPriceCents: 1.5 },
    { sellingPriceCents: Number.NaN },
    { sellingPriceCents: Number.POSITIVE_INFINITY },
    { sellingPriceCents: '599' as never },
    { sellingPriceCents: -1 },
    { sellingPriceCents: 10_000_000 },
    { quantity: -1 },
    { quantity: 2.5 },
    { lowStockThreshold: -1 },
    { costPriceCents: -5 },
  ])('rejects %o and writes nothing', (bad) => {
    expect(() => service(db).create(baseInput(bad))).toThrow();
    expect(db.prepare('SELECT COUNT(*) AS c FROM products').get()).toMatchObject({ c: 0 });
  });

  it('rejects unexpected fields', () => {
    expect(() => service(db).create(baseInput({ evil: 'DROP TABLE products' } as never))).toThrow(
      /unexpected field/i,
    );
  });
});

describe('task §21 — create + initial movement is atomic', () => {
  it('rolls the product back if the INITIAL_STOCK movement insert fails', () => {
    // Force the movement insert to fail by breaking the movements table mid-call.
    const svc = createProductService({
      db,
      now: () => {
        // Drop a NOT NULL-satisfying path: rename the table so the INSERT throws.
        db.exec('ALTER TABLE inventory_movements RENAME TO inventory_movements_x');
        return T;
      },
    });
    expect(() => svc.create(baseInput({ quantity: 5 }))).toThrow();
    db.exec('ALTER TABLE inventory_movements_x RENAME TO inventory_movements');
    expect(db.prepare('SELECT COUNT(*) AS c FROM products').get()).toMatchObject({ c: 0 });
  });
});

describe('restart persistence proof (task §22)', () => {
  it('product + quantity + INITIAL_STOCK survive close/reopen', async () => {
    const temp = makeTempDir();
    const file = join(temp.path, 'db.sqlite');
    try {
      let conn = openConfiguredConnection(file);
      await runMigrations(conn, PRODUCTION_MIGRATIONS, {
        logger: createCapturingLogger().logger,
        appVersion: 'test',
        createPreMigrationBackup: backupGateUnreachable(),
      });
      const created = createProductService({ db: conn, now: () => T }).create(
        baseInput({ quantity: 7, barcode: '001234567890' }),
      );
      conn.close();

      conn = openConfiguredConnection(file);
      const product = createProductService({ db: conn }).findByBarcode('001234567890');
      expect(product.found).toBe(true);
      if (product.found) {
        expect(product.product.id).toBe(created.id);
        expect(product.product.quantityOnHand).toBe(7);
      }
      const movement = conn
        .prepare(
          'SELECT movement_type, quantity_after FROM inventory_movements WHERE product_id = ?',
        )
        .get(created.id);
      expect(movement).toEqual({ movement_type: 'INITIAL_STOCK', quantity_after: 7 });
      conn.close();
    } finally {
      temp.cleanup();
    }
  });
});
