import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openConfiguredConnection } from '../../src/main/database/connection';
import { runMigrations } from '../../src/main/database/migrationRunner';
import { PRODUCTION_MIGRATIONS } from '../../src/main/database/migrations';
import { createSaleService } from '../../src/main/checkout/saleService';
import { createReceiptService } from '../../src/main/checkout/receiptService';
import { createSalesHistoryService } from '../../src/main/salesHistory/salesHistoryService';
import { createVoidService } from '../../src/main/void/voidService';
import { backupGateUnreachable, createCapturingLogger, makeTempDir } from '../helpers/database';
import {
  buildCashRequest,
  seedBusiness,
  seedProduct,
  seedTaxRate,
  T0,
  T1,
} from '../helpers/checkout';
import type { TempDir } from '../helpers/database';

/**
 * Phase 2H — the void is local SQLite only and durable across restart
 * (`REQ-VOID-*`; `POS_WORKFLOWS.md §88`, `§58`-`§59`; `task §13`).
 *
 * `globalThis.fetch` is removed for the whole file, and a real file-backed WAL
 * database is closed and reopened after the void commits.
 */

let temp: TempDir;
let file: string;
const realFetch = globalThis.fetch;

beforeEach(() => {
  temp = makeTempDir('gpp-void-offline-');
  file = join(temp.path, 'db.sqlite');
  vi.stubGlobal('fetch', undefined);
});
afterEach(() => {
  temp.cleanup();
  globalThis.fetch = realFetch;
  vi.unstubAllGlobals();
});

async function freshFileDb() {
  const conn = openConfiguredConnection(file);
  await runMigrations(conn, PRODUCTION_MIGRATIONS, {
    logger: createCapturingLogger().logger,
    appVersion: 'test',
    createPreMigrationBackup: backupGateUnreachable(),
  });
  return conn;
}

describe('void succeeds offline and survives close/reopen', () => {
  it('no fetch is available; the void commits and every effect is durable after restart', async () => {
    expect(globalThis.fetch).toBeUndefined();

    let conn = await freshFileDb();
    seedTaxRate(conn);
    seedBusiness(conn);
    const p = seedProduct(conn, { quantity: 10, sellingPriceCents: 59900 });
    const sale = createSaleService({
      db: conn,
      appVersion: 'test',
      now: () => T0,
    }).completeCashSale(
      buildCashRequest(conn, [{ productId: p.id, quantity: 3, soldPriceCents: 55000 }]),
    );
    expect(
      (
        conn.prepare('SELECT quantity_on_hand q FROM products WHERE id = ?').get(p.id) as {
          q: number;
        }
      ).q,
    ).toBe(7);

    createVoidService({ db: conn, appVersion: 'test', now: () => T1 }).voidSale({
      saleId: sale.saleId,
      reason: 'offline void',
    });
    conn.close();

    conn = openConfiguredConnection(file);
    const one = (sql: string, ...args: unknown[]) => conn.prepare(sql).get(...args);

    expect(
      one(
        'SELECT status, voided_at, void_reason, sync_version FROM sales WHERE id = ?',
        sale.saleId,
      ),
    ).toEqual({
      status: 'VOIDED',
      voided_at: T1,
      void_reason: 'offline void',
      sync_version: 2,
    });
    expect(one('SELECT quantity_on_hand q FROM products WHERE id = ?', p.id)).toEqual({ q: 10 });
    expect(
      one(
        "SELECT COUNT(*) n FROM inventory_movements WHERE sale_id = ? AND movement_type = 'VOID_REVERSAL'",
        sale.saleId,
      ),
    ).toEqual({ n: 1 });
    expect(
      one(
        "SELECT COUNT(*) n FROM audit_events WHERE event_type = 'SALE_VOIDED' AND subject_id = ?",
        sale.saleId,
      ),
    ).toEqual({
      n: 1,
    });
    expect(
      one(
        'SELECT status, target_sync_version FROM google_sheet_export_jobs WHERE sale_id = ?',
        sale.saleId,
      ),
    ).toEqual({
      status: 'PENDING',
      target_sync_version: 2,
    });
    expect(
      one('SELECT COUNT(*) n FROM google_sheet_export_jobs WHERE sale_id = ?', sale.saleId),
    ).toEqual({ n: 1 });

    // Sales History still lists it; the receipt still renders (now as VOIDED).
    const detail = createSalesHistoryService({ db: conn }).getById(sale.saleId);
    expect(detail).toMatchObject({ status: 'VOIDED', completedAt: T0, voidedAt: T1 });
    const receipt = createReceiptService({ db: conn }).getBySaleId(sale.saleId);
    expect(receipt).toMatchObject({ status: 'VOIDED', voidReason: 'offline void' });
    expect(receipt.totals.totalCents).toBe(sale.totalCents);

    conn.close();
  });

  it('TEST-VOID-005 (restart portion) — a valid reason survives restart unchanged', async () => {
    let conn = await freshFileDb();
    seedTaxRate(conn);
    seedBusiness(conn);
    const p = seedProduct(conn, { quantity: 5 });
    const sale = createSaleService({
      db: conn,
      appVersion: 'test',
      now: () => T0,
    }).completeCashSale(
      buildCashRequest(conn, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]),
    );
    createVoidService({ db: conn, appVersion: 'test', now: () => T1 }).voidSale({
      saleId: sale.saleId,
      reason: '  Customer cancelled within the hour  ',
    });
    conn.close();

    conn = openConfiguredConnection(file);
    expect(conn.prepare('SELECT void_reason FROM sales WHERE id = ?').get(sale.saleId)).toEqual({
      void_reason: 'Customer cancelled within the hour', // trimmed, unchanged
    });
    conn.close();
  });
});
