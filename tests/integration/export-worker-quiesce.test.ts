import type Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createExportWorker } from '../../src/main/google/exportWorker';
import type { ExportContext } from '../../src/main/google/exportWorker';
import type { SheetsTransport } from '../../src/main/google/sheetsTransport';
import { createSaleService } from '../../src/main/checkout/saleService';
import { createMigratedDb, createCapturingLogger } from '../helpers/database';
import { fakeAuthProvider } from '../helpers/google';
import { buildCashRequest, seedBusiness, seedProduct, seedTaxRate, T0 } from '../helpers/checkout';

/**
 * Phase 2L-B Item 7 — quiescing the Google export worker before a restore
 * closes / swaps the operational connection. `stop()` must not hang, must not
 * fabricate an `EXPORTED` outcome, and must leave nothing that would write to a
 * closed connection.
 */

let db: Database.Database;

const ctx: ExportContext = {
  spreadsheetId: 'sheet-1',
  salesSheetName: 'Sales',
  saleItemsSheetName: 'Sale Items',
  businessTimezone: 'America/Chicago',
  auth: fakeAuthProvider(),
  credentialGeneration: 1,
};

beforeEach(async () => {
  db = await createMigratedDb();
  seedTaxRate(db);
  seedBusiness(db);
  const product = seedProduct(db, { quantity: 5 });
  createSaleService({ db, appVersion: 't', now: () => T0 }).completeCashSale(
    buildCashRequest(db, [{ productId: product.id, quantity: 1, soldPriceCents: 59900 }]),
  );
});
afterEach(() => {
  if (db.open) db.close();
});

it('stop() aborts an in-flight request, does not hang, leaves the job recoverable, and is then safe to close', async () => {
  const worker = createExportWorker({
    db,
    logger: createCapturingLogger().logger,
    resolveContext: () => Promise.resolve(ctx),
    createTransport: (_c, signal): SheetsTransport => ({
      getValues: () =>
        new Promise((_resolve, reject) => {
          // A real network call rejects when aborted; our fake mimics that.
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
      batchUpdate: async () => {},
      append: async () => {},
    }),
    pollIntervalMs: 60_000,
  });

  worker.start();
  const jobStatus = (): string =>
    (db.prepare('SELECT status FROM google_sheet_export_jobs LIMIT 1').get() as { status: string })
      .status;
  for (let i = 0; i < 50 && jobStatus() !== 'EXPORTING'; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  // The job has been claimed and the worker is hanging on the request.
  expect(jobStatus()).toBe('EXPORTING');

  // Quiesce: bounded, no hang.
  await expect(
    Promise.race([
      worker.stop(),
      new Promise((_r, reject) => setTimeout(() => reject(new Error('stop() hung')), 2000)),
    ]),
  ).resolves.toBeUndefined();

  // The ambiguous in-flight job is left EXPORTING for the existing 5-minute
  // stale-recovery — NOT fabricated as EXPORTED.
  expect(jobStatus()).toBe('EXPORTING');

  // No further worker activity; safe to close the connection now.
  db.close();
  expect(worker.running).toBe(false);

  // A late timer callback (if any) must not throw against the closed DB.
  await new Promise((r) => setTimeout(r, 20));
  vi.useRealTimers();
});
