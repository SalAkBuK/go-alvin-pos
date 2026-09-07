import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openConfiguredConnection } from '../../src/main/database/connection';
import { runMigrations } from '../../src/main/database/migrationRunner';
import { PRODUCTION_MIGRATIONS } from '../../src/main/database/migrations';
import { createProductService } from '../../src/main/products/productService';
import {
  backupGateUnreachable,
  createCapturingLogger,
  createMigratedDb,
  makeTempDir,
} from '../helpers/database';
import type { CreateProductInput } from '../../src/shared/products';

/**
 * Barcode lookup — product/inventory-relevant parts of `TEST_PLAN.md`
 * TEST-SCAN-001, 002, 004, 005. Repeated-cart-scan behaviour is deferred to
 * checkout.
 */

const T = '2026-09-07T12:00:00.000Z';

function baseInput(overrides: Partial<CreateProductInput>): CreateProductInput {
  return {
    name: 'iPhone 15',
    brand: 'Apple',
    model: 'iPhone 15',
    condition: 'NEW',
    sellingPriceCents: 59900,
    quantity: 3,
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

describe('TEST-SCAN-001 — Known Barcode', () => {
  it('returns the matching active product', () => {
    const svc = createProductService({ db, now: () => T });
    const created = svc.create(baseInput({ barcode: '123456789' }));
    const result = svc.findByBarcode('123456789');
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.product.id).toBe(created.id);
    }
  });

  it('trims surrounding whitespace some scanners append, but keeps case exact', () => {
    const svc = createProductService({ db, now: () => T });
    svc.create(baseInput({ barcode: 'AbC123' }));
    expect(svc.findByBarcode('  AbC123\n').found).toBe(true);
    expect(svc.findByBarcode('abc123').found).toBe(false);
  });
});

describe('TEST-SCAN-002 — Unknown Barcode', () => {
  it('returns a typed, non-fatal not-found result', () => {
    const svc = createProductService({ db, now: () => T });
    expect(svc.findByBarcode('999999999')).toEqual({ found: false });
  });
});

describe('TEST-SCAN-004 — Barcode Leading Zero (persist + reload)', () => {
  it('preserves leading zeroes through storage and a database reopen', async () => {
    const temp = makeTempDir();
    const file = join(temp.path, 'db.sqlite');
    try {
      let conn = openConfiguredConnection(file);
      await runMigrations(conn, PRODUCTION_MIGRATIONS, {
        logger: createCapturingLogger().logger,
        appVersion: 'test',
        createPreMigrationBackup: backupGateUnreachable(),
      });
      createProductService({ db: conn, now: () => T }).create(
        baseInput({ barcode: '001234567890' }),
      );
      conn.close();

      conn = openConfiguredConnection(file);
      const stored = conn.prepare('SELECT barcode FROM products').get() as { barcode: string };
      expect(stored.barcode).toBe('001234567890');
      expect(typeof stored.barcode).toBe('string');
      const lookup = createProductService({ db: conn }).findByBarcode('001234567890');
      expect(lookup.found).toBe(true);
      // A numerically-equal but differently-written barcode must NOT match.
      expect(createProductService({ db: conn }).findByBarcode('1234567890').found).toBe(false);
      conn.close();
    } finally {
      temp.cleanup();
    }
  });
});

describe('TEST-SCAN-005 — Local/offline barcode lookup', () => {
  it('resolves entirely from local SQLite with no network dependency', () => {
    const svc = createProductService({ db, now: () => T });
    svc.create(baseInput({ barcode: '5551112223' }));
    // No fetch/network is available in this test environment; the call still works.
    expect(svc.findByBarcode('5551112223').found).toBe(true);
  });

  it('does not return an archived product for normal selling behaviour', () => {
    const svc = createProductService({ db, now: () => T });
    const created = svc.create(baseInput({ barcode: '7778889990' }));
    svc.archive(created.id);
    expect(svc.findByBarcode('7778889990')).toEqual({ found: false });
  });
});
