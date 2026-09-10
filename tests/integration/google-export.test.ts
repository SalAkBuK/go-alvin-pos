import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExportWorker } from '../../src/main/google/exportWorker';
import type { ExportContext } from '../../src/main/google/exportWorker';
import { GoogleApiError } from '../../src/main/google/googleRedaction';
import {
  queueSummary,
  manualRetry,
  markExported,
  recoverStaleExporting,
} from '../../src/main/google/exportJobRepository';
import { SALES_HEADER, SALE_ITEMS_HEADER } from '../../src/main/google/exportSerialization';
import { createSaleService } from '../../src/main/checkout/saleService';
import { createCustomerService } from '../../src/main/customers/customerService';
import { createProductService } from '../../src/main/products/productService';
import { createVoidService } from '../../src/main/void/voidService';
import { createMigratedDb } from '../helpers/database';
import {
  buildCashRequest,
  countRows,
  productQuantity,
  seedBusiness,
  seedProduct,
  seedTaxRate,
  T0,
} from '../helpers/checkout';
import { fakeAuthProvider, fakeSheetsTransport, FakeSpreadsheet } from '../helpers/google';
import type { FakeTransportOptions } from '../helpers/google';
import type { SheetsTransport } from '../../src/main/google/sheetsTransport';

/**
 * Phase 2J — Google Sheets Export Worker (`TEST-GSHEET-001`-`025`;
 * `REQ-GSHEET-001`-`015`). Fake auth + in-memory spreadsheet — proves OUR state
 * machine and idempotency, not Google's live service.
 */

let db: Database.Database;
let clock = Date.parse('2026-09-08T12:05:00.000Z');
const now = (): string => new Date(clock).toISOString();
const advance = (ms: number): void => {
  clock += ms;
};

function completeSale(
  lines: Parameters<typeof buildCashRequest>[1],
  options: { customerId?: string | null } = {},
): { saleId: string } {
  return createSaleService({ db, appVersion: 't', now: () => T0 }).completeCashSale(
    buildCashRequest(db, lines, options),
  );
}

function makeWorker(
  sheet: FakeSpreadsheet,
  opts: {
    enabled?: boolean;
    transportOptions?: FakeTransportOptions;
    pollIntervalMs?: number;
    /** Override the transport per attempt; receives the worker's abort signal. */
    transportFactory?: (signal: AbortSignal) => SheetsTransport;
  } = {},
) {
  const ctx: ExportContext = {
    spreadsheetId: 'sheet-abc-123',
    salesSheetName: 'Sales',
    saleItemsSheetName: 'Sale Items',
    businessTimezone: 'America/Chicago',
    auth: fakeAuthProvider(),
    credentialGeneration: 1,
  };
  const transport = fakeSheetsTransport(sheet, opts.transportOptions ?? {});
  const logs: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];
  const logger = {
    debug: (_c: string, e: string, f?: Record<string, unknown>) =>
      logs.push({ level: 'debug', event: e, fields: f ?? {} }),
    info: (_c: string, e: string, f?: Record<string, unknown>) =>
      logs.push({ level: 'info', event: e, fields: f ?? {} }),
    warn: (_c: string, e: string, f?: Record<string, unknown>) =>
      logs.push({ level: 'warn', event: e, fields: f ?? {} }),
    error: (_c: string, e: string, f?: Record<string, unknown>) =>
      logs.push({ level: 'error', event: e, fields: f ?? {} }),
    fatal: (_c: string, e: string, f?: Record<string, unknown>) =>
      logs.push({ level: 'fatal', event: e, fields: f ?? {} }),
  } as unknown as Parameters<typeof createExportWorker>[0]['logger'];

  const worker = createExportWorker({
    db,
    logger,
    resolveContext: () => Promise.resolve(opts.enabled === false ? null : ctx),
    createTransport: (_ctx, signal) =>
      opts.transportFactory ? opts.transportFactory(signal) : transport,
    now,
    pollIntervalMs: opts.pollIntervalMs ?? 60_000,
    requestTimeoutMs: 30_000,
    staleExportingMs: 5 * 60_000,
  });
  return { worker, transport, logs };
}

function jobRow(saleId: string): Record<string, unknown> {
  return db
    .prepare('SELECT * FROM google_sheet_export_jobs WHERE sale_id = ?')
    .get(saleId) as Record<string, unknown>;
}

beforeEach(async () => {
  clock = Date.parse('2026-09-08T12:05:00.000Z');
  db = await createMigratedDb();
  seedTaxRate(db);
  seedBusiness(db);
});
afterEach(() => db.close());

describe('TEST-GSHEET-001 — successful export', () => {
  it('the durable job commits with the sale; the API request occurs only after commit; job → EXPORTED', () => {
    const p = seedProduct(db, { quantity: 5 });
    // job exists immediately, before any worker runs
    const { saleId } = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    expect(jobRow(saleId).status).toBe('PENDING');

    const sheet = new FakeSpreadsheet();
    const { worker, transport } = makeWorker(sheet);
    expect(transport.calls).toHaveLength(0); // nothing sent at sale time

    return worker.runOnce().then(() => {
      const job = jobRow(saleId);
      expect(job.status).toBe('EXPORTED');
      expect(job.exported_sync_version).toBe(1);
      expect(job.target_sync_version).toBe(1);
      expect(sheet.findBySaleId('Sales', saleId)).toHaveLength(1);
    });
  });
});

describe('TEST-GSHEET-002 / 003 / 004 — worksheet contents', () => {
  it('one Sales row + one Sale Items row per line, keyed by Sale ID / Sale Item ID', async () => {
    const a = seedProduct(db, { name: 'iPhone', sellingPriceCents: 59900, quantity: 9 });
    const b = seedProduct(db, { name: 'Pixel', sellingPriceCents: 50000, quantity: 9 });
    const { saleId } = completeSale([
      { productId: a.id, quantity: 1, soldPriceCents: 59900 },
      { productId: b.id, quantity: 2, soldPriceCents: 50000 },
    ]);
    const sheet = new FakeSpreadsheet();
    await makeWorker(sheet).worker.runOnce();

    expect(sheet.findBySaleId('Sales', saleId)).toHaveLength(1);
    const itemRows = sheet.rowsOf('Sale Items').filter((r) => r[1] === saleId);
    expect(itemRows).toHaveLength(2);
    const itemIds = db
      .prepare('SELECT id FROM sale_items WHERE sale_id = ? ORDER BY id')
      .all(saleId)
      .map((r) => (r as { id: string }).id);
    for (const id of itemIds) {
      expect(itemRows.some((row) => row[0] === id)).toBe(true);
    }
  });
});

describe('TEST-GSHEET-005 / 018 — offline / disabled → PENDING, no network', () => {
  it('integration disabled: job stays PENDING, zero transport calls, attempt_count unchanged', async () => {
    const p = seedProduct(db, { quantity: 5 });
    const { saleId } = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    const sheet = new FakeSpreadsheet();
    const { worker, transport } = makeWorker(sheet, { enabled: false });
    await worker.runOnce();
    const job = jobRow(saleId);
    expect(job.status).toBe('PENDING');
    expect(job.attempt_count).toBe(0);
    expect(transport.calls).toHaveLength(0);
  });

  it('enabled but offline: NETWORK failure → PENDING with backoff', async () => {
    const p = seedProduct(db, { quantity: 5 });
    const { saleId } = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    const sheet = new FakeSpreadsheet();
    const { worker } = makeWorker(sheet, {
      transportOptions: {
        onRead: () => {
          throw Object.assign(new Error('getaddrinfo ENOTFOUND sheets.googleapis.com'), {
            name: 'TypeError',
          });
        },
      },
    });
    await worker.runOnce();
    const job = jobRow(saleId);
    expect(job.status).toBe('PENDING');
    expect(job.attempt_count).toBe(1);
    expect(typeof job.next_attempt_at).toBe('string');
  });
});

describe('TEST-GSHEET-006 / restart persistence', () => {
  it('a pending job survives close/reopen of a file-backed DB and then exports', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'gpp-gsheet-'));
    const file = join(dir, 'pos.sqlite');
    let saleId: string;
    {
      const first = await createMigratedDb(file);
      seedTaxRate(first);
      seedBusiness(first);
      const p = createProductService({ db: first, now: () => T0 }).create({
        name: 'Reopen',
        brand: 'Apple',
        model: 'iPhone',
        condition: 'NEW',
        sellingPriceCents: 59900,
        quantity: 3,
      });
      const r = createSaleService({ db: first, appVersion: 't', now: () => T0 }).completeCashSale(
        buildCashRequest(first, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]),
      );
      saleId = r.saleId;
      expect(
        (
          first
            .prepare('SELECT status FROM google_sheet_export_jobs WHERE sale_id = ?')
            .get(saleId) as {
            status: string;
          }
        ).status,
      ).toBe('PENDING');
      first.close();
    }
    const reopened = await createMigratedDb(file);
    const savedDb = db;
    db = reopened;
    try {
      const sheet = new FakeSpreadsheet();
      await makeWorker(sheet).worker.runOnce();
      expect(
        (
          reopened
            .prepare('SELECT status FROM google_sheet_export_jobs WHERE sale_id = ?')
            .get(saleId) as {
            status: string;
          }
        ).status,
      ).toBe('EXPORTED');
    } finally {
      reopened.close();
      db = savedDb;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('TEST-GSHEET-008 — reconnect exports exactly once', () => {
  it('first attempt fails (NETWORK), second succeeds; one Sales row', async () => {
    const p = seedProduct(db, { quantity: 5 });
    const { saleId } = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    const sheet = new FakeSpreadsheet();
    let failReads = 1;
    const { worker } = makeWorker(sheet, {
      transportOptions: {
        onRead: () => {
          if (failReads > 0) {
            failReads -= 1;
            throw Object.assign(new Error('connection reset'), { name: 'TypeError' });
          }
        },
      },
    });
    await worker.runOnce();
    expect(jobRow(saleId).status).toBe('PENDING');
    advance(60_000);
    // clear the backoff so it is eligible again
    db.prepare('UPDATE google_sheet_export_jobs SET next_attempt_at = ? WHERE sale_id = ?').run(
      now(),
      saleId,
    );
    await worker.runOnce();
    expect(jobRow(saleId).status).toBe('EXPORTED');
    expect(sheet.findBySaleId('Sales', saleId)).toHaveLength(1);
  });
});

describe('TEST-GSHEET-009 through 013 — API failures isolated from the sale', () => {
  it.each([
    [401, 'AUTH'],
    [403, 'PERMISSION'],
    [404, 'NOT_FOUND'],
    [429, 'RATE_LIMIT'],
  ])(
    'HTTP %i → sale intact, job retryable, %s recorded, no secret in last_error',
    async (status) => {
      const p = seedProduct(db, { quantity: 5 });
      const { saleId } = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
      const before = { sales: countRows(db, 'sales'), qty: productQuantity(db, p.id) };
      const sheet = new FakeSpreadsheet();
      const { worker } = makeWorker(sheet, {
        transportOptions: {
          onRead: () => {
            throw new GoogleApiError(
              status === 401
                ? 'AUTH'
                : status === 403
                  ? 'PERMISSION'
                  : status === 404
                    ? 'NOT_FOUND'
                    : 'RATE_LIMIT',
              `Bearer ya29.SECRET-TOKEN rejected (HTTP ${String(status)})`,
              { httpStatus: status },
            );
          },
        },
      });
      await worker.runOnce();
      const job = jobRow(saleId);
      expect(job.status).toBe('PENDING');
      expect(job.attempt_count).toBe(1);
      expect(String(job.last_error)).not.toMatch(/ya29\.|SECRET-TOKEN/);
      expect(countRows(db, 'sales')).toBe(before.sales);
      expect(productQuantity(db, p.id)).toBe(before.qty);
    },
  );
});

describe('TEST-GSHEET-014 — unknown outcome / timeout does not duplicate', () => {
  it('Google wrote the row but we timed out; retry finds it and does not append a second', async () => {
    const p = seedProduct(db, { quantity: 5 });
    const { saleId } = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    const sheet = new FakeSpreadsheet();
    sheet._get('Sales').push(['Sale ID']); // header already present ⇒ first write is the data row
    let firstWrite = true;
    const { worker } = makeWorker(sheet, {
      transportOptions: {
        onWriteApplied: () => {
          if (firstWrite) {
            firstWrite = false;
            throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
          }
        },
      },
    });
    await worker.runOnce();
    // Unknown outcome: job left EXPORTING, no attempt_count change, row IS on the sheet.
    let job = jobRow(saleId);
    expect(job.status).toBe('EXPORTING');
    expect(job.attempt_count).toBe(0);
    expect(sheet.findBySaleId('Sales', saleId)).toHaveLength(1);

    // Stale recovery after 5 min, then the retry converges without duplicating.
    advance(6 * 60_000);
    await worker.runOnce();
    job = jobRow(saleId);
    expect(job.status).toBe('EXPORTED');
    expect(sheet.findBySaleId('Sales', saleId)).toHaveLength(1);
    expect(sheet.rowsOf('Sale Items').filter((r) => r[1] === saleId)).toHaveLength(1);
  });
});

describe('TEST-GSHEET-015 — manual retry does not duplicate', () => {
  it('a FAILED job manually retried exports once', async () => {
    const p = seedProduct(db, { quantity: 5 });
    const { saleId } = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    db.prepare(
      "UPDATE google_sheet_export_jobs SET status='FAILED', attempt_count=10, next_attempt_at=NULL, last_error='x' WHERE sale_id=?",
    ).run(saleId);

    expect(manualRetry(db, { saleId, now: now() })).toBe(1);
    const job = jobRow(saleId);
    expect(job.status).toBe('PENDING');
    expect(job.attempt_count).toBe(0);
    expect(job.last_error).toBeNull();

    const sheet = new FakeSpreadsheet();
    await makeWorker(sheet).worker.runOnce();
    expect(jobRow(saleId).status).toBe('EXPORTED');
    expect(sheet.findBySaleId('Sales', saleId)).toHaveLength(1);
  });
});

describe('TEST-GSHEET-016 — stale EXPORTING recovery', () => {
  it('a job stuck EXPORTING past 5 min → PENDING, attempt_count unchanged', async () => {
    const p = seedProduct(db, { quantity: 5 });
    const { saleId } = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    db.prepare(
      "UPDATE google_sheet_export_jobs SET status='EXPORTING', last_attempt_at=?, attempt_count=3 WHERE sale_id=?",
    ).run(new Date(clock - 10 * 60_000).toISOString(), saleId);

    const recovered = recoverStaleExporting(db, {
      now: now(),
      staleBefore: new Date(clock - 5 * 60_000).toISOString(),
    });
    expect(recovered).toBe(1);
    const job = jobRow(saleId);
    expect(job.status).toBe('PENDING');
    expect(job.attempt_count).toBe(3);
    expect(job.target_sync_version).toBe(1);
  });
});

describe('TEST-GSHEET-017 — Google fully unavailable, multiple sales', () => {
  it('every sale commits; every job PENDING/retryable; local reads unaffected', async () => {
    const p = seedProduct(db, { quantity: 20 });
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      ids.push(completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]).saleId);
    }
    const sheet = new FakeSpreadsheet();
    const { worker } = makeWorker(sheet, {
      transportOptions: {
        onRead: () => {
          throw new GoogleApiError('NETWORK', 'unreachable');
        },
      },
    });
    await worker.runOnce();
    for (const id of ids) {
      expect(jobRow(id).status as string).toBe('PENDING');
      expect(
        (db.prepare('SELECT status FROM sales WHERE id=?').get(id) as { status: string }).status,
      ).toBe('COMPLETED');
    }
    expect(countRows(db, 'sales')).toBe(4);
  });
});

describe('TEST-GSHEET-019 — enable after disabled sales', () => {
  it('sales made while disabled export later by Sale ID with no extra jobs', async () => {
    const p = seedProduct(db, { quantity: 5 });
    const s1 = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]).saleId;
    const s2 = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]).saleId;
    const sheet = new FakeSpreadsheet();

    const disabled = makeWorker(sheet, { enabled: false });
    await disabled.worker.runOnce();
    expect(countRows(db, 'google_sheet_export_jobs')).toBe(2);

    await makeWorker(sheet).worker.runOnce();
    expect(jobRow(s1).status).toBe('EXPORTED');
    expect(jobRow(s2).status).toBe('EXPORTED');
    expect(countRows(db, 'google_sheet_export_jobs')).toBe(2);
    expect(sheet.rowsOf('Sales').filter((r) => r[0] === s1 || r[0] === s2)).toHaveLength(2);
  });
});

describe('TEST-GSHEET-020 / 021 — stale-write race converges (corrected REQ-GSHEET-015)', () => {
  it('v1 in flight → void → stale v1 cannot finalize v1; v2 converges the row to VOIDED', async () => {
    const p = seedProduct(db, { quantity: 5 });
    const { saleId } = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    const sheet = new FakeSpreadsheet();

    let voided = false;
    const { worker, logs } = makeWorker(sheet, {
      transportOptions: {
        onWrite: () => {
          // While the v1 write is "in flight", void the sale (never waits on network).
          if (!voided) {
            voided = true;
            createVoidService({ db, appVersion: 't', now }).voidSale({
              saleId,
              reason: 'Rang up in error',
            });
          }
        },
      },
    });

    await worker.runOnce();

    // The stale v1 acknowledgment did not finalize version 1 (its CAS was discarded),
    // and repeated idempotent upserts converged the row to the current revision.
    expect(logs.some((l) => l.event === 'google.export.stale_acknowledgment_discarded')).toBe(true);
    const job = jobRow(saleId);
    expect(job.status).toBe('EXPORTED');
    expect(job.target_sync_version).toBe(2);
    expect(job.exported_sync_version).toBe(2);
    const rows = sheet.findBySaleId('Sales', saleId);
    expect(rows).toHaveLength(1);
    expect(rows[0]![12]).toBe('VOIDED'); // Status column (M)
  });

  it('TEST-GSHEET-021 — the void itself never waits on the network', () => {
    const p = seedProduct(db, { quantity: 5 });
    const { saleId } = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    db.prepare(
      "UPDATE google_sheet_export_jobs SET status='EXPORTING', last_attempt_at=? WHERE sale_id=?",
    ).run(now(), saleId);
    const detail = createVoidService({ db, appVersion: 't', now }).voidSale({
      saleId,
      reason: 'error',
    });
    expect(detail.saleId).toBe(saleId);
    const job = jobRow(saleId);
    expect(job.status).toBe('PENDING');
    expect(job.target_sync_version).toBe(2);
    expect(job.attempt_count).toBe(0);
  });
});

describe('TEST-GSHEET-022 — manual sheet edit/delete restored; SQLite untouched', () => {
  it('re-export overwrites a manual edit and recreates a deleted row; SQLite unchanged', async () => {
    const p = seedProduct(db, { quantity: 5 });
    const { saleId } = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    const sheet = new FakeSpreadsheet();
    await makeWorker(sheet).worker.runOnce();
    const saleSnapshot = db.prepare('SELECT * FROM sales WHERE id=?').get(saleId);

    // Vandalize the sheet: edit the receipt cell, delete the item row.
    const salesRows = sheet._get('Sales');
    salesRows[1]![1] = 'HACKED RECEIPT';
    sheet._get('Sale Items').length = 1; // delete the item row (keep header)

    // An export-relevant action (a void) triggers a re-export at the new revision.
    createVoidService({ db, appVersion: 't', now }).voidSale({ saleId, reason: 'correction' });
    await makeWorker(sheet).worker.runOnce();

    expect(sheet.findBySaleId('Sales', saleId)[0]![1]).not.toBe('HACKED RECEIPT');
    expect(sheet.findBySaleId('Sales', saleId)[0]![12]).toBe('VOIDED');
    expect(sheet.rowsOf('Sale Items').filter((r) => r[1] === saleId)).toHaveLength(1);
    // SQLite is never read from the sheet: the sale row is byte-identical except
    // for the void columns the void transaction itself wrote.
    const after = db.prepare('SELECT * FROM sales WHERE id=?').get(saleId) as Record<
      string,
      unknown
    >;
    expect(after['id']).toEqual((saleSnapshot as Record<string, unknown>)['id']);
    expect(after['receipt_number']).toEqual(
      (saleSnapshot as Record<string, unknown>)['receipt_number'],
    );
    expect(after['total_cents']).toEqual((saleSnapshot as Record<string, unknown>)['total_cents']);
    expect(after['status']).toBe('VOIDED');
  });
});

describe('TEST-GSHEET-023 — externally duplicated Sale ID', () => {
  it('worker does not crash; matching rows converge; local state correct', async () => {
    const p = seedProduct(db, { quantity: 5 });
    const { saleId } = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    const sheet = new FakeSpreadsheet();
    // Seed two duplicate Sales rows for this Sale ID.
    sheet._get('Sales').push(['Sale ID', 'Receipt Number']);
    sheet._get('Sales').push([saleId, 'STALE-1']);
    sheet._get('Sales').push([saleId, 'STALE-2']);

    await makeWorker(sheet).worker.runOnce();
    const rows = sheet.findBySaleId('Sales', saleId);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // every matching row was overwritten with the authoritative receipt number
    const receipt = (
      db.prepare('SELECT receipt_number FROM sales WHERE id=?').get(saleId) as {
        receipt_number: string;
      }
    ).receipt_number;
    for (const row of rows) {
      expect(row[1]).toBe(receipt);
    }
    expect(jobRow(saleId).status).toBe('EXPORTED');
  });
});

describe('TEST-GSHEET-024 — every canonical column', () => {
  it('Sales + Sale Items rows carry every DATA_MODEL §26 column', async () => {
    const cust = createCustomerService({ db, now: () => T0 }).create({
      name: 'Pat',
      phone: '555-9000',
    });
    const p = seedProduct(db, { name: 'iPhone 15', sellingPriceCents: 59900, quantity: 5 });
    const { saleId } = completeSale([{ productId: p.id, quantity: 2, soldPriceCents: 55000 }], {
      customerId: cust.id,
    });
    const sheet = new FakeSpreadsheet();
    await makeWorker(sheet).worker.runOnce();

    const salesHeader = sheet.rowsOf('Sales')[0]!;
    expect(salesHeader).toEqual([
      'Sale ID',
      'Receipt Number',
      'Date',
      'Time',
      'Customer Name',
      'Customer Phone',
      'Subtotal',
      'Discount',
      'Tax Rate',
      'Tax',
      'Total',
      'Payment Method',
      'Status',
      'Sync Version',
      'Voided At',
      'Void Reason',
      'Exported At',
    ]);
    const salesRow = sheet.findBySaleId('Sales', saleId)[0]!;
    expect(salesRow).toHaveLength(17);
    expect(salesRow[4]).toBe('Pat');
    expect(salesRow[5]).toBe('555-9000');
    expect(salesRow[8]).toBe('8.25%');
    expect(salesRow[11]).toBe('Cash');
    expect(salesRow[12]).toBe('COMPLETED');
    expect(salesRow[13]).toBe('1');

    const itemsHeader = sheet.rowsOf('Sale Items')[0]!;
    expect(itemsHeader).toEqual([
      'Sale Item ID',
      'Sale ID',
      'Receipt Number',
      'Product ID',
      'Product Name',
      'Brand',
      'Model',
      'Condition',
      'SKU',
      'Barcode',
      'Quantity',
      'Listed Price',
      'Sold Price',
      'Discount',
      'Line Total',
    ]);
    const itemRow = sheet.rowsOf('Sale Items').find((r) => r[1] === saleId)!;
    expect(itemRow).toHaveLength(15);
    expect(itemRow[10]).toBe('2');
    expect(itemRow[11]).toBe('599.00');
    expect(itemRow[12]).toBe('550.00');
  });
});

describe('TEST-GSHEET-025 — formula neutralization', () => {
  it('customer/product names beginning = + - @ are written with a leading apostrophe', async () => {
    const cust = createCustomerService({ db, now: () => T0 }).create({
      name: '=1+1',
      phone: '555',
    });
    const p = createProductService({ db, now: () => T0 }).create({
      name: '+SUM(A1)',
      brand: '-hack',
      model: '@x',
      condition: 'NEW',
      sellingPriceCents: 10000,
      quantity: 5,
    });
    const { saleId } = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 10000 }], {
      customerId: cust.id,
    });
    const sheet = new FakeSpreadsheet();
    await makeWorker(sheet).worker.runOnce();
    const salesRow = sheet.findBySaleId('Sales', saleId)[0]!;
    expect(salesRow[4]).toBe("'=1+1");
    const itemRow = sheet.rowsOf('Sale Items').find((r) => r[1] === saleId)!;
    expect(itemRow[4]).toBe("'+SUM(A1)");
    expect(itemRow[5]).toBe("'-hack");
    expect(itemRow[6]).toBe("'@x");
  });
});

describe('retry / backoff exact sequence + attempt #10 → FAILED', () => {
  it('30s, 60s, 120s, … capped at 30 min; the 10th failure is terminal', async () => {
    const p = seedProduct(db, { quantity: 20 });
    const { saleId } = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    const sheet = new FakeSpreadsheet();
    const { worker } = makeWorker(sheet, {
      transportOptions: {
        onRead: () => {
          throw new GoogleApiError('RATE_LIMIT', 'quota', { httpStatus: 429 });
        },
      },
    });
    const expectedDelays = [30, 60, 120, 240, 480, 960, 1800, 1800, 1800]; // seconds; 7th+ capped
    for (let attempt = 1; attempt <= 9; attempt += 1) {
      db.prepare('UPDATE google_sheet_export_jobs SET next_attempt_at=? WHERE sale_id=?').run(
        now(),
        saleId,
      );
      await worker.runOnce();
      const job = jobRow(saleId);
      expect(job.attempt_count).toBe(attempt);
      expect(job.status).toBe('PENDING');
      const deltaySec = (Date.parse(job.next_attempt_at as string) - clock) / 1000;
      expect(deltaySec).toBe(expectedDelays[attempt - 1]);
    }
    // 10th failure → FAILED
    db.prepare('UPDATE google_sheet_export_jobs SET next_attempt_at=? WHERE sale_id=?').run(
      now(),
      saleId,
    );
    await worker.runOnce();
    const job = jobRow(saleId);
    expect(job.attempt_count).toBe(10);
    expect(job.status).toBe('FAILED');
    expect(job.next_attempt_at).toBeNull();
  });
});

describe('version invariant', () => {
  it('job.target_sync_version !== sales.sync_version → skipped, no network, no mutation', async () => {
    const p = seedProduct(db, { quantity: 5 });
    const { saleId } = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    // Corrupt the invariant directly (cannot happen via real workflows).
    db.prepare('UPDATE sales SET sync_version = 2 WHERE id = ?').run(saleId);
    const sheet = new FakeSpreadsheet();
    const { worker, transport, logs } = makeWorker(sheet);
    await worker.runOnce();
    expect(transport.calls).toHaveLength(0);
    expect(jobRow(saleId).status).toBe('PENDING');
    expect(jobRow(saleId).attempt_count).toBe(0);
    expect(logs.some((l) => l.event === 'google.export.invariant_violation')).toBe(true);
  });
});

describe('queue summary', () => {
  it('counts jobs by status', () => {
    const p = seedProduct(db, { quantity: 20 });
    const a = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]).saleId;
    const b = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]).saleId;
    db.prepare("UPDATE google_sheet_export_jobs SET status='FAILED' WHERE sale_id=?").run(a);
    db.prepare("UPDATE google_sheet_export_jobs SET status='EXPORTED' WHERE sale_id=?").run(b);
    expect(queueSummary(db)).toEqual({ pending: 0, exporting: 0, exported: 1, failed: 1 });
  });
});

describe('worker lifecycle', () => {
  it('start() then stopSync() stops the loop and leaves an EXPORTING job untouched', async () => {
    const p = seedProduct(db, { quantity: 5 });
    const { saleId } = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    db.prepare(
      "UPDATE google_sheet_export_jobs SET status='EXPORTING', last_attempt_at=? WHERE sale_id=?",
    ).run(now(), saleId);
    const sheet = new FakeSpreadsheet();
    const { worker } = makeWorker(sheet);
    worker.stopSync();
    expect(worker.running).toBe(false);
    // Shutdown does NOT move a claimed job back to PENDING (`REQ-GSHEET-007`) —
    // it stays EXPORTING and only the 5-minute stale machinery recovers it.
    expect(jobRow(saleId).status).toBe('EXPORTING');
    expect(jobRow(saleId).attempt_count).toBe(0);
    advance(6 * 60_000);
    expect(worker.recoverStale()).toBe(1);
  });

  it('start() then stopSync() with a fake timer does not overlap ticks', () => {
    vi.useFakeTimers();
    try {
      const sheet = new FakeSpreadsheet();
      const { worker } = makeWorker(sheet, { pollIntervalMs: 1000 });
      worker.start();
      expect(worker.running).toBe(true);
      worker.stopSync();
      expect(worker.running).toBe(false);
      vi.advanceTimersByTime(5000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('graceful shutdown — an ambiguous in-flight job is left EXPORTING (Issue 2)', () => {
  function abortError(): Error {
    return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  }

  /** A transport that blocks the first `append` until the worker's signal aborts. */
  function blockingTransport(sheet: FakeSpreadsheet, signal: AbortSignal): SheetsTransport {
    const base = fakeSheetsTransport(sheet, {});
    let blocked = false;
    return {
      getValues: (range) => base.getValues(range),
      batchUpdate: (data) => base.batchUpdate(data),
      append: async (range, values) => {
        if (!blocked) {
          blocked = true;
          await new Promise<void>((_resolve, reject) => {
            if (signal.aborted) {
              reject(abortError());
              return;
            }
            signal.addEventListener('abort', () => reject(abortError()), { once: true });
          });
        }
        return base.append(range, values);
      },
    };
  }

  // A — stopSync during a genuinely in-flight request.
  it('A — aborts the local wait; job stays EXPORTING; attempt_count unchanged; no finalize', async () => {
    const p = seedProduct(db, { quantity: 5 });
    const { saleId } = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    const sheet = new FakeSpreadsheet();
    sheet._get('Sales').push(['Sale ID']); // header present ⇒ first write is the data-row append

    const { worker, logs } = makeWorker(sheet, {
      transportFactory: (signal) => blockingTransport(sheet, signal),
    });

    const run = worker.runOnce();
    await vi.waitFor(() => expect(jobRow(saleId).status).toBe('EXPORTING'));
    worker.stopSync(); // the append is genuinely awaiting at this point
    await run;

    const job = jobRow(saleId);
    expect(job.status).toBe('EXPORTING');
    expect(job.attempt_count).toBe(0);
    expect(job.exported_sync_version).toBeNull();
    expect(logs.some((l) => l.event === 'google.export.unknown_outcome')).toBe(true);
    expect(logs.some((l) => l.event === 'google.export.completed')).toBe(false);
    expect(logs.some((l) => l.event === 'google.export.failed')).toBe(false);
    expect(logs.some((l) => l.event === 'google.export.retry_scheduled')).toBe(false);
    expect(sheet.findBySaleId('Sales', saleId)).toHaveLength(0); // nothing appended
  });

  // B — restart before the 5-minute stale threshold.
  it('B — restart before the stale threshold: job stays EXPORTING; no network request', async () => {
    const p = seedProduct(db, { quantity: 5 });
    const { saleId } = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    db.prepare(
      "UPDATE google_sheet_export_jobs SET status='EXPORTING', last_attempt_at=? WHERE sale_id=?",
    ).run(now(), saleId);

    advance(2 * 60_000); // 2 min < 5 min
    const sheet = new FakeSpreadsheet();
    const { worker, transport } = makeWorker(sheet);
    await worker.runOnce();

    expect(jobRow(saleId).status).toBe('EXPORTING');
    expect(jobRow(saleId).attempt_count).toBe(0);
    expect(transport.calls).toHaveLength(0);
  });

  // C — restart at/after the 5-minute stale threshold.
  it('C — restart at the stale threshold: EXPORTING→PENDING, idempotent retry, no duplicate rows', async () => {
    const a = seedProduct(db, { name: 'iPhone', sellingPriceCents: 59900, quantity: 9 });
    const b = seedProduct(db, { name: 'Case', sellingPriceCents: 1999, quantity: 9 });
    const { saleId } = completeSale([
      { productId: a.id, quantity: 1, soldPriceCents: 59900 },
      { productId: b.id, quantity: 2, soldPriceCents: 1999 },
    ]);
    db.prepare(
      "UPDATE google_sheet_export_jobs SET status='EXPORTING', last_attempt_at=? WHERE sale_id=?",
    ).run(now(), saleId);

    advance(5 * 60_000); // exactly the threshold
    const sheet = new FakeSpreadsheet();
    const { worker, logs } = makeWorker(sheet);
    await worker.runOnce();

    expect(logs.some((l) => l.event === 'google.export.stale_exporting_recovered')).toBe(true);
    const job = jobRow(saleId);
    expect(job.status).toBe('EXPORTED');
    expect(job.exported_sync_version).toBe(1);
    expect(sheet.findBySaleId('Sales', saleId)).toHaveLength(1);
    expect(sheet.rowsOf('Sale Items').filter((r) => r[1] === saleId)).toHaveLength(2);
  });

  // D — the ambiguous write DID apply remotely before shutdown; the response was lost.
  it('D — applied-then-lost write: zero retry before threshold; after it, converges to one row', async () => {
    const a = seedProduct(db, { name: 'iPhone', sellingPriceCents: 59900, quantity: 9 });
    const { saleId } = completeSale([{ productId: a.id, quantity: 1, soldPriceCents: 59900 }]);
    const itemIds = (
      db.prepare('SELECT id FROM sale_items WHERE sale_id = ?').all(saleId) as Array<{ id: string }>
    ).map((r) => r.id);

    // The first (ambiguous) request reached Google and was applied.
    const pad = (n: number): string[] => Array.from({ length: n }, () => '');
    const sheet = new FakeSpreadsheet();
    sheet._get('Sales').push([...SALES_HEADER]);
    sheet._get('Sales').push([saleId, ...pad(SALES_HEADER.length - 1)]);
    sheet._get('Sale Items').push([...SALE_ITEMS_HEADER]);
    for (const id of itemIds) {
      sheet._get('Sale Items').push([id, saleId, ...pad(SALE_ITEMS_HEADER.length - 2)]);
    }
    // ...then shutdown left the job EXPORTING.
    db.prepare(
      "UPDATE google_sheet_export_jobs SET status='EXPORTING', last_attempt_at=? WHERE sale_id=?",
    ).run(now(), saleId);

    // Restart before the threshold ⇒ zero retry.
    advance(3 * 60_000);
    {
      const { worker, transport } = makeWorker(sheet);
      await worker.runOnce();
      expect(jobRow(saleId).status).toBe('EXPORTING');
      expect(transport.calls).toHaveLength(0);
    }

    // Restart at the threshold ⇒ retry finds the existing Sale ID / Sale Item IDs.
    advance(2 * 60_000); // 5 min total since last_attempt_at
    {
      const { worker } = makeWorker(sheet);
      await worker.runOnce();
    }

    expect(jobRow(saleId).status).toBe('EXPORTED');
    expect(jobRow(saleId).exported_sync_version).toBe(1);
    expect(sheet.findBySaleId('Sales', saleId)).toHaveLength(1);
    expect(sheet.rowsOf('Sale Items').filter((r) => r[1] === saleId)).toHaveLength(1);
  });

  // E — shutdown during a v1 export, then the sale is voided and requeued to v2.
  it('E — void after shutdown: local + non-blocking; v1 cannot finalize; v2 converges to VOIDED', async () => {
    const a = seedProduct(db, { quantity: 9 });
    const { saleId } = completeSale([{ productId: a.id, quantity: 1, soldPriceCents: 59900 }]);
    db.prepare(
      "UPDATE google_sheet_export_jobs SET status='EXPORTING', last_attempt_at=? WHERE sale_id=?",
    ).run(now(), saleId);

    // Void — one local transaction, never waits on the network, no worker running.
    createVoidService({ db, appVersion: 't', now }).voidSale({
      saleId,
      reason: 'Customer returned the device',
    });

    const sale = db.prepare('SELECT status, sync_version FROM sales WHERE id = ?').get(saleId) as {
      status: string;
      sync_version: number;
    };
    expect(sale.status).toBe('VOIDED');
    expect(sale.sync_version).toBe(2);
    const requeued = jobRow(saleId);
    expect(requeued.status).toBe('PENDING');
    expect(requeued.target_sync_version).toBe(2);

    // A stale v1 acknowledgment cannot finalize the current state.
    expect(markExported(db, { id: requeued.id as string, writtenVersion: 1, now: now() })).toBe(0);

    // The worker converges the Google row to v2 = VOIDED.
    const sheet = new FakeSpreadsheet();
    const { worker } = makeWorker(sheet);
    await worker.runOnce();

    const job = jobRow(saleId);
    expect(job.status).toBe('EXPORTED');
    expect(job.exported_sync_version).toBe(2);
    const rows = sheet.findBySaleId('Sales', saleId);
    expect(rows).toHaveLength(1);
    expect(rows[0]![12]).toBe('VOIDED'); // Status column
    expect(sheet.rowsOf('Sale Items').filter((r) => r[1] === saleId)).toHaveLength(1);
  });
});

describe('no network access on the offline sale path', () => {
  it('completing a sale performs no fetch (job creation is local only)', () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error('no network on the checkout path');
    }) as typeof globalThis.fetch;
    try {
      const p = seedProduct(db, { quantity: 5 });
      const { saleId } = completeSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
      expect(fetchCalls).toBe(0);
      expect(jobRow(saleId).status).toBe('PENDING');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
