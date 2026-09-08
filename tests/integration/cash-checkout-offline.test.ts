import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openConfiguredConnection } from '../../src/main/database/connection';
import { runMigrations } from '../../src/main/database/migrationRunner';
import { PRODUCTION_MIGRATIONS } from '../../src/main/database/migrations';
import { createSaleService } from '../../src/main/checkout/saleService';
import { backupGateUnreachable, createCapturingLogger, makeTempDir } from '../helpers/database';
import {
  buildCashRequest,
  seedBusiness,
  seedProduct,
  seedTaxRate,
  T0,
  T1,
  T2,
} from '../helpers/checkout';
import type { TempDir } from '../helpers/database';

/**
 * Phase 2E — offline / restart durability of a committed Cash sale
 * (`POS_WORKFLOWS.md §42`, `§58`, `§62`; `DATA_MODEL.md §56-57`;
 * `TEST_PLAN.md` TEST-IDEMP-004, TEST-RECNO-002; `REQ-OFF-001/008/009`).
 *
 * A real file-backed database (WAL) is closed and reopened between operations —
 * no network is involved anywhere in the sale path.
 */

let temp: TempDir;
let file: string;

beforeEach(() => {
  temp = makeTempDir('gpp-cash-offline-');
  file = join(temp.path, 'db.sqlite');
});
afterEach(() => temp.cleanup());

async function freshFileDb() {
  const conn = openConfiguredConnection(file);
  await runMigrations(conn, PRODUCTION_MIGRATIONS, {
    logger: createCapturingLogger().logger,
    appVersion: 'test',
    createPreMigrationBackup: backupGateUnreachable(),
  });
  return conn;
}

describe('a committed Cash sale survives close/reopen of the same file', () => {
  it('retains the sale, item, payment, inventory, movement, export job, request, and audit', async () => {
    let conn = await freshFileDb();
    seedTaxRate(conn);
    seedBusiness(conn);
    const p = seedProduct(conn, { quantity: 5, sellingPriceCents: 59900 });
    const req = buildCashRequest(conn, [{ productId: p.id, quantity: 2, soldPriceCents: 55000 }]);
    const result = createSaleService({
      db: conn,
      appVersion: 'test',
      now: () => T0,
    }).completeCashSale(req);
    conn.close();

    conn = openConfiguredConnection(file);
    const one = (sql: string, ...args: unknown[]) => conn.prepare(sql).get(...args);
    expect(one('SELECT COUNT(*) n FROM sales')).toEqual({ n: 1 });
    expect(
      one('SELECT receipt_number, total_cents FROM sales WHERE id = ?', result.saleId),
    ).toEqual({
      receipt_number: 'GP-000001',
      total_cents: result.totalCents,
    });
    expect(one('SELECT COUNT(*) n FROM sale_items WHERE sale_id = ?', result.saleId)).toEqual({
      n: 1,
    });
    expect(one('SELECT amount_cents FROM payments WHERE sale_id = ?', result.saleId)).toEqual({
      amount_cents: result.totalCents,
    });
    expect(one('SELECT quantity_on_hand n FROM products WHERE id = ?', p.id)).toEqual({ n: 3 });
    expect(
      one("SELECT quantity_change FROM inventory_movements WHERE movement_type = 'SALE'"),
    ).toEqual({ quantity_change: -2 });
    expect(
      one('SELECT status FROM google_sheet_export_jobs WHERE sale_id = ?', result.saleId),
    ).toEqual({ status: 'PENDING' });
    expect(one('SELECT status FROM checkout_requests WHERE request_id = ?', req.requestId)).toEqual(
      {
        status: 'COMPLETED',
      },
    );
    expect(one("SELECT COUNT(*) n FROM audit_events WHERE event_type = 'SALE_COMPLETED'")).toEqual({
      n: 1,
    });
    conn.close();
  });

  it('TEST-IDEMP-004 — retrying the original request after reopen returns the existing sale', async () => {
    let conn = await freshFileDb();
    seedTaxRate(conn);
    seedBusiness(conn);
    const p = seedProduct(conn, { quantity: 3 });
    const req = buildCashRequest(conn, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    const original = createSaleService({
      db: conn,
      appVersion: 'test',
      now: () => T0,
    }).completeCashSale(req);
    conn.close();

    conn = openConfiguredConnection(file);
    const replay = createSaleService({
      db: conn,
      appVersion: 'test',
      now: () => T1,
    }).completeCashSale(req);
    expect(replay.saleId).toBe(original.saleId);
    expect(replay.alreadyCompleted).toBe(true);
    expect(conn.prepare('SELECT COUNT(*) n FROM sales').get()).toEqual({ n: 1 });
    conn.close();
  });

  it('TEST-RECNO-002 — a second sale after reopen continues the receipt sequence', async () => {
    let conn = await freshFileDb();
    seedTaxRate(conn);
    seedBusiness(conn);
    const p = seedProduct(conn, { quantity: 5 });
    const first = createSaleService({
      db: conn,
      appVersion: 'test',
      now: () => T0,
    }).completeCashSale(
      buildCashRequest(conn, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]),
    );
    expect(first.receiptNumber).toBe('GP-000001');
    conn.close();

    conn = openConfiguredConnection(file);
    const second = createSaleService({
      db: conn,
      appVersion: 'test',
      now: () => T2,
    }).completeCashSale(
      buildCashRequest(conn, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]),
    );
    expect(second.receiptNumber).toBe('GP-000002');
    conn.close();
  });
});
