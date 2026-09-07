import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openConfiguredConnection } from '../../src/main/database/connection';
import { runMigrations } from '../../src/main/database/migrationRunner';
import { PRODUCTION_MIGRATIONS } from '../../src/main/database/migrations';
import { createInventoryService } from '../../src/main/inventory/inventoryService';
import { createProductService } from '../../src/main/products/productService';
import { isAppError } from '../../src/main/shared/appError';
import {
  backupGateUnreachable,
  createCapturingLogger,
  createMigratedDb,
  makeTempDir,
} from '../helpers/database';

/**
 * Manual inventory adjustment integration tests against real SQLite
 * (`TEST_PLAN.md` TEST-INV-005..007 + task `§21` atomicity/stale-quantity list).
 */

const T = '2026-09-07T12:00:00.000Z';

let db: Database.Database;

beforeEach(async () => {
  db = await createMigratedDb();
});

afterEach(() => {
  db.close();
});

function seedProduct(quantity: number): string {
  return createProductService({ db, now: () => T }).create({
    name: 'iPhone 15',
    brand: 'Apple',
    model: 'iPhone 15',
    condition: 'NEW',
    sellingPriceCents: 59900,
    quantity,
  }).id;
}

function inventory(now: () => string = () => T) {
  return createInventoryService({ db, appVersion: 'test', now });
}

describe('TEST-INV-005 — Manual Adjustment Increase', () => {
  it('5 with +2 → 7 and a MANUAL_ADJUSTMENT +2 movement', () => {
    const id = seedProduct(5);
    const { product, movement } = inventory().adjust({
      productId: id,
      mode: 'delta',
      delta: 2,
      reason: 'Physical stock recount',
    });
    expect(product.quantityOnHand).toBe(7);
    expect(movement).toMatchObject({
      movementType: 'MANUAL_ADJUSTMENT',
      quantityBefore: 5,
      quantityChange: 2,
      quantityAfter: 7,
      reason: 'Physical stock recount',
    });
  });

  it('accepts a target quantity and resolves it against the authoritative current value', () => {
    const id = seedProduct(5);
    const { product, movement } = inventory().adjust({
      productId: id,
      mode: 'target',
      targetQuantity: 9,
      reason: 'Recount',
    });
    expect(product.quantityOnHand).toBe(9);
    expect(movement.quantityChange).toBe(4);
    expect(movement.quantityBefore).toBe(5);
  });
});

describe('TEST-INV-006 — Manual Adjustment Decrease', () => {
  it('5 with -2 → 3 and a movement exists', () => {
    const id = seedProduct(5);
    const { product, movement } = inventory().adjust({
      productId: id,
      mode: 'delta',
      delta: -2,
      reason: 'Damaged unit removed',
    });
    expect(product.quantityOnHand).toBe(3);
    expect(movement.quantityChange).toBe(-2);
  });
});

describe('TEST-INV-007 — Invalid Negative Inventory', () => {
  it('1 with -2 is rejected and nothing changes', () => {
    const id = seedProduct(1);
    try {
      inventory().adjust({ productId: id, mode: 'delta', delta: -2, reason: 'oops' });
      expect.unreachable();
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('INVENTORY_NEGATIVE');
    }
    expect(
      db.prepare('SELECT quantity_on_hand AS q FROM products WHERE id = ?').get(id),
    ).toMatchObject({ q: 1 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM inventory_movements WHERE movement_type='MANUAL_ADJUSTMENT'",
        )
        .get(),
    ).toMatchObject({ c: 0 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS c FROM audit_events WHERE event_type='INVENTORY_ADJUSTED'")
        .get(),
    ).toMatchObject({ c: 0 });
  });

  it('rejects a zero-change adjustment', () => {
    const id = seedProduct(4);
    try {
      inventory().adjust({ productId: id, mode: 'delta', delta: 0, reason: 'noop' });
      expect.unreachable();
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('ADJUSTMENT_NO_CHANGE');
    }
  });

  it('requires a reason', () => {
    const id = seedProduct(4);
    expect(() =>
      inventory().adjust({ productId: id, mode: 'delta', delta: 1, reason: '   ' }),
    ).toThrow();
  });
});

describe('task §12 — adjustment writes a durable INVENTORY_ADJUSTED audit event', () => {
  it('allocates a monotonic audit sequence and records before/change/after', () => {
    const id = seedProduct(5);
    inventory().adjust({ productId: id, mode: 'delta', delta: 3, reason: 'Recount' });
    const event = db
      .prepare("SELECT * FROM audit_events WHERE event_type = 'INVENTORY_ADJUSTED'")
      .get() as Record<string, unknown>;
    expect(event).toMatchObject({
      actor_type: 'USER',
      outcome: 'SUCCESS',
      subject_type: 'PRODUCT',
      subject_id: id,
      reason: 'Recount',
      app_version: 'test',
    });
    expect(event['sequence']).toBe(1);
    const counter = db.prepare("SELECT value FROM counters WHERE key='audit_sequence'").get();
    expect(counter).toMatchObject({ value: 1 });
    const details = JSON.parse(event['details_json'] as string) as Record<string, unknown>;
    expect(details).toMatchObject({ quantityBefore: 5, quantityChange: 3, quantityAfter: 8 });
  });
});

describe('task §21 — adjustment atomicity', () => {
  it('a failing audit insert rolls back the quantity update AND the movement', () => {
    const id = seedProduct(5);
    // Break audit_events so appendAuditEvent throws inside the transaction.
    db.exec('ALTER TABLE audit_events RENAME TO audit_events_x');
    try {
      expect(() =>
        inventory().adjust({ productId: id, mode: 'delta', delta: 2, reason: 'x' }),
      ).toThrow();
    } finally {
      db.exec('ALTER TABLE audit_events_x RENAME TO audit_events');
    }
    expect(
      db.prepare('SELECT quantity_on_hand AS q FROM products WHERE id=?').get(id),
    ).toMatchObject({
      q: 5,
    });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM inventory_movements WHERE movement_type='MANUAL_ADJUSTMENT'",
        )
        .get(),
    ).toMatchObject({ c: 0 });
  });

  it('a failing movement insert rolls back the quantity update', () => {
    const id = seedProduct(5);
    db.exec('ALTER TABLE inventory_movements RENAME TO inventory_movements_x');
    try {
      expect(() =>
        inventory().adjust({ productId: id, mode: 'delta', delta: 2, reason: 'x' }),
      ).toThrow();
    } finally {
      db.exec('ALTER TABLE inventory_movements_x RENAME TO inventory_movements');
    }
    expect(
      db.prepare('SELECT quantity_on_hand AS q FROM products WHERE id=?').get(id),
    ).toMatchObject({
      q: 5,
    });
  });
});

describe('task §21 — a stale renderer quantity cannot corrupt inventory', () => {
  it('uses the authoritative SQLite quantity, not any client-supplied previous value', () => {
    const id = seedProduct(5);
    // Simulate the real stock having moved to 8 (e.g. an earlier adjustment) while
    // a stale renderer still believes it is 5. A delta of +1 must land on 9, not 6.
    inventory().adjust({ productId: id, mode: 'delta', delta: 3, reason: 'first' });
    const { product } = inventory().adjust({
      productId: id,
      mode: 'delta',
      delta: 1,
      reason: 'second',
    });
    expect(product.quantityOnHand).toBe(9);
    // A target adjustment likewise computes its change from the live value.
    const again = inventory().adjust({
      productId: id,
      mode: 'target',
      targetQuantity: 2,
      reason: 'set',
    });
    expect(again.movement.quantityBefore).toBe(9);
    expect(again.movement.quantityChange).toBe(-7);
  });

  it('rejects an adjustment for a non-existent product', () => {
    try {
      inventory().adjust({ productId: 'no-such-id', mode: 'delta', delta: 1, reason: 'x' });
      expect.unreachable();
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('PRODUCT_NOT_FOUND');
    }
  });
});

describe('restart persistence proof (task §22)', () => {
  it('adjusted quantity + MANUAL_ADJUSTMENT movement + INVENTORY_ADJUSTED audit survive reopen', async () => {
    const temp = makeTempDir();
    const file = join(temp.path, 'db.sqlite');
    try {
      let conn = openConfiguredConnection(file);
      await runMigrations(conn, PRODUCTION_MIGRATIONS, {
        logger: createCapturingLogger().logger,
        appVersion: 'test',
        createPreMigrationBackup: backupGateUnreachable(),
      });
      const id = createProductService({ db: conn, now: () => T }).create({
        name: 'iPhone 15',
        brand: 'Apple',
        model: 'iPhone 15',
        condition: 'NEW',
        sellingPriceCents: 59900,
        quantity: 5,
      }).id;
      createInventoryService({ db: conn, appVersion: 'test', now: () => T }).adjust({
        productId: id,
        mode: 'delta',
        delta: 4,
        reason: 'Recount after reopen test',
      });
      conn.close();

      conn = openConfiguredConnection(file);
      expect(
        conn.prepare('SELECT quantity_on_hand AS q FROM products WHERE id=?').get(id),
      ).toMatchObject({ q: 9 });
      expect(
        conn
          .prepare(
            "SELECT quantity_after AS q FROM inventory_movements WHERE movement_type='MANUAL_ADJUSTMENT'",
          )
          .get(),
      ).toMatchObject({ q: 9 });
      expect(
        conn
          .prepare("SELECT COUNT(*) AS c FROM audit_events WHERE event_type='INVENTORY_ADJUSTED'")
          .get(),
      ).toMatchObject({ c: 1 });
      conn.close();
    } finally {
      temp.cleanup();
    }
  });
});
