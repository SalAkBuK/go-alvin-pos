import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openConfiguredConnection } from '../../src/main/database/connection';
import { runMigrations } from '../../src/main/database/migrationRunner';
import { PRODUCTION_MIGRATIONS } from '../../src/main/database/migrations';
import { createReceiptService } from '../../src/main/checkout/receiptService';
import { createSaleService } from '../../src/main/checkout/saleService';
import { backupGateUnreachable, createCapturingLogger, makeTempDir } from '../helpers/database';
import { buildCashRequest, seedBusiness, seedProduct, seedTaxRate, T0 } from '../helpers/checkout';
import type { TempDir } from '../helpers/database';

/**
 * Phase 2E.1 — a receipt is regenerable from a file-backed database across a
 * full close/reopen, independent of any renderer cart state and with no network
 * involved (`REQ-OFF-007` receipt-generation portion; `TEST-PRINT-006`
 * generation-after-restart portion; task `§16`, `§21`).
 */

let temp: TempDir;
let file: string;

beforeEach(() => {
  temp = makeTempDir('gpp-receipt-offline-');
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

describe('receipt survives close/reopen of the same database file', () => {
  it('generates the identical representation before and after reopening', async () => {
    let conn = await freshFileDb();
    seedTaxRate(conn);
    seedBusiness(conn);
    const p = seedProduct(conn, { sellingPriceCents: 59900, quantity: 5 });
    const result = createSaleService({
      db: conn,
      appVersion: 'test',
      now: () => T0,
    }).completeCashSale(
      buildCashRequest(conn, [{ productId: p.id, quantity: 2, soldPriceCents: 55000 }]),
    );
    const before = createReceiptService({ db: conn }).getBySaleId(result.saleId);
    conn.close();

    conn = openConfiguredConnection(file);
    const after = createReceiptService({ db: conn }).getBySaleId(result.saleId);
    conn.close();

    expect(after).toEqual(before);
    expect(after.receiptNumber).toBe('GP-000001');
    expect(after.items[0]?.quantity).toBe(2);
    expect(after.totals.totalCents).toBe(result.totalCents);
  });
});
