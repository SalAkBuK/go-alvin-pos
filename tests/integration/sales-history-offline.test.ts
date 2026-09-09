import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openConfiguredConnection } from '../../src/main/database/connection';
import { runMigrations } from '../../src/main/database/migrationRunner';
import { PRODUCTION_MIGRATIONS } from '../../src/main/database/migrations';
import { createCardCheckoutService } from '../../src/main/checkout/cardCheckoutService';
import { createReceiptService } from '../../src/main/checkout/receiptService';
import { createSaleService } from '../../src/main/checkout/saleService';
import { createSalesHistoryService } from '../../src/main/salesHistory/salesHistoryService';
import { backupGateUnreachable, createCapturingLogger, makeTempDir } from '../helpers/database';
import {
  buildCardRequest,
  buildCashRequest,
  seedBusiness,
  seedProduct,
  seedTaxRate,
} from '../helpers/checkout';
import type { TempDir } from '../helpers/database';

/**
 * Phase 2G — Sales History is entirely local (`REQ-OFF-006`, `REQ-OFF-008`,
 * `REQ-OFF-009`; `POS_WORKFLOWS.md §58`-`§59`, `§63`; `task §22`, `§23`).
 *
 * `globalThis.fetch` is removed for the whole file and a real file-backed WAL
 * database is closed and reopened between write and read — the list, the detail,
 * and "View Receipt" must all still work with no network available.
 */

let temp: TempDir;
let file: string;
const realFetch = globalThis.fetch;

beforeEach(() => {
  temp = makeTempDir('gpp-history-offline-');
  file = join(temp.path, 'db.sqlite');
  // Any accidental network use in the history/receipt read path is a hard failure.
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

describe('Cash + Card sales appear in Sales History offline and across restart', () => {
  it('lists both, opens detail, and View Receipt works from the persisted sale — no fetch', async () => {
    expect(globalThis.fetch).toBeUndefined();

    let conn = await freshFileDb();
    seedTaxRate(conn);
    seedBusiness(conn);
    const p = seedProduct(conn, { quantity: 10, sellingPriceCents: 59900 });

    const cash = createSaleService({
      db: conn,
      appVersion: 'test',
      now: () => '2026-09-09T14:00:00.000Z',
    }).completeCashSale(
      buildCashRequest(conn, [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }]),
    );

    const cardReq = buildCardRequest(conn, [
      { productId: p.id, quantity: 2, soldPriceCents: 59900 },
    ]);
    const cardSvc = createCardCheckoutService({
      db: conn,
      appVersion: 'test',
      now: () => '2026-09-09T15:00:00.000Z',
    });
    cardSvc.beginCard(cardReq);
    const cardResult = cardSvc.completeCard(cardReq);

    conn.close();

    // Reopen the same file — the renderer cart does not survive; the sales do.
    conn = openConfiguredConnection(file);
    const history = createSalesHistoryService({ db: conn });

    const list = history.list({});
    expect(list.map((e) => e.paymentMethod).sort()).toEqual(['CARD', 'CASH']);
    expect(list.map((e) => e.exportStatus)).toEqual(['PENDING', 'PENDING']);

    const cashDetail = history.getById(cash.saleId);
    expect(cashDetail).toMatchObject({ paymentMethod: 'CASH', status: 'COMPLETED' });
    const cardDetail = history.getById(cardResult.saleId);
    expect(cardDetail).toMatchObject({ paymentMethod: 'CARD', status: 'COMPLETED' });

    // View Receipt reuses the existing receipt path, also offline + post-restart.
    const receipt = createReceiptService({ db: conn }).getBySaleId(cardResult.saleId);
    expect(receipt.receiptNumber).toBe(cardDetail.receiptNumber);
    expect(receipt.items[0]?.quantity).toBe(2);
    expect(receipt.totals.totalCents).toBe(cardDetail.totalCents);

    conn.close();
  });

  it('a business-date filter resolves against the persisted timezone with no network', async () => {
    let conn = await freshFileDb();
    seedTaxRate(conn);
    seedBusiness(conn);
    const p = seedProduct(conn, { quantity: 10 });
    const onSep9 = createSaleService({
      db: conn,
      appVersion: 'test',
      now: () => '2026-09-10T01:30:00.000Z', // 20:30 CDT Sep 9
    }).completeCashSale(
      buildCashRequest(conn, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]),
    );
    conn.close();

    conn = openConfiguredConnection(file);
    const history = createSalesHistoryService({ db: conn });
    expect(history.list({ businessDate: '2026-09-09' }).map((e) => e.saleId)).toEqual([
      onSep9.saleId,
    ]);
    expect(history.list({ businessDate: '2026-09-10' })).toEqual([]);
    conn.close();
  });
});
