import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCardCheckoutService } from '../../src/main/checkout/cardCheckoutService';
import { createSaleService } from '../../src/main/checkout/saleService';
import { createProductService } from '../../src/main/products/productService';
import { createCustomerService } from '../../src/main/customers/customerService';
import { createSettingsService } from '../../src/main/settings/settingsService';
import { createSalesHistoryService } from '../../src/main/salesHistory/salesHistoryService';
import { isAppError } from '../../src/main/shared/appError';
import type { SaleExportStatus } from '../../src/shared/checkout';
import { createMigratedDb } from '../helpers/database';
import {
  auditCounter,
  buildCardRequest,
  buildCashRequest,
  countRows,
  seedBusiness,
  seedProduct,
  seedTaxRate,
} from '../helpers/checkout';

/**
 * Phase 2G — Sales History read model over committed local state
 * (`REQ-HIST-001`-`REQ-HIST-004`; `POS_WORKFLOWS.md §50`-`§52`; `DATA_MODEL.md
 * §4`, `§11`-`§16`, `§44-49`; `TEST_PLAN.md` TEST-HIST-001..006). Every fixture
 * is a genuine sale written through the real checkout services; there is no void
 * mutation in V1, so a `VOIDED` fixture flips the committed row's status by hand.
 */

let db: Database.Database;

function history() {
  return createSalesHistoryService({ db });
}
function sale(nowIso: string) {
  return createSaleService({ db, appVersion: 'test-2g', now: () => nowIso });
}
function card(nowIso: string) {
  return createCardCheckoutService({ db, appVersion: 'test-2g', now: () => nowIso });
}

/** Complete a real Cash sale at a chosen instant; returns the committed result. */
function cashSaleAt(
  nowIso: string,
  lines: Array<{ productId: string; quantity: number; soldPriceCents: number }>,
  customerId?: string,
) {
  return sale(nowIso).completeCashSale(
    buildCashRequest(db, lines, customerId ? { customerId } : {}),
  );
}

function setExportStatus(saleId: string, status: SaleExportStatus): void {
  db.prepare(
    `UPDATE google_sheet_export_jobs SET status = ?, updated_at = '2026-09-09T00:00:00.000Z' WHERE sale_id = ?`,
  ).run(status, saleId);
}

/** Flip a committed COMPLETED sale to VOIDED (no void workflow exists in Phase 2G). */
function forceVoid(saleId: string, voidedAt: string, reason: string): void {
  db.prepare(`UPDATE sales SET status = 'VOIDED', voided_at = ?, void_reason = ? WHERE id = ?`).run(
    voidedAt,
    reason,
    saleId,
  );
}

beforeEach(async () => {
  db = await createMigratedDb();
  seedTaxRate(db);
  seedBusiness(db);
});
afterEach(() => db.close());

describe('TEST-HIST-001 — View Completed Sale', () => {
  it('a multi-item sale with a customer, a price override, a discount and tax exposes every canonical field from snapshots', () => {
    const a = seedProduct(db, { name: 'iPhone 15', sellingPriceCents: 59900, quantity: 9 });
    const b = seedProduct(db, { name: 'Pixel 9', sellingPriceCents: 50000, quantity: 9 });
    const customer = createCustomerService({ db, now: () => '2026-09-09T00:00:00.000Z' }).create({
      name: 'Jane Doe',
      phone: '(281) 824-0001',
    });
    const result = cashSaleAt(
      '2026-09-09T15:00:00.000Z',
      [
        { productId: a.id, quantity: 1, soldPriceCents: 55000 },
        { productId: b.id, quantity: 2, soldPriceCents: 52500 },
      ],
      customer.id,
    );

    const list = history().list({});
    expect(list.map((e) => e.receiptNumber)).toContain(result.receiptNumber);

    const detail = history().getById(result.saleId);
    expect(detail).toMatchObject({
      saleId: result.saleId,
      receiptNumber: result.receiptNumber,
      status: 'COMPLETED',
      completedAt: '2026-09-09T15:00:00.000Z',
      voidedAt: null,
      voidReason: null,
      businessTimezone: 'America/Chicago',
      customerName: 'Jane Doe',
      customerPhone: '(281) 824-0001',
      taxRateBps: 825,
      paymentMethod: 'CASH',
      exportStatus: 'PENDING',
    });

    // Historical line values come from sale_items snapshots.
    const iphone = detail.items.find((i) => i.productName === 'iPhone 15')!;
    expect(iphone).toMatchObject({
      brand: 'Apple',
      condition: 'NEW',
      quantity: 1,
      listedPriceCents: 59900,
      soldPriceCents: 55000,
      discountCents: 4900,
      lineSubtotalCents: 59900,
      lineTotalCents: 55000,
    });
    const pixel = detail.items.find((i) => i.productName === 'Pixel 9')!;
    expect(pixel).toMatchObject({ discountCents: 0, quantity: 2, lineTotalCents: 105000 });

    // Financial totals are the sales snapshot, never recalculated.
    const row = db
      .prepare(
        'SELECT subtotal_cents s, discount_cents d, taxable_amount_cents t, tax_cents x, total_cents g FROM sales WHERE id = ?',
      )
      .get(result.saleId) as Record<string, number>;
    expect(detail).toMatchObject({
      subtotalCents: row['s'],
      discountCents: row['d'],
      taxableAmountCents: row['t'],
      taxCents: row['x'],
      totalCents: row['g'],
    });
  });

  it('a customerless sale renders with a null customer — no fabricated "Walk-in"', () => {
    const p = seedProduct(db);
    const result = cashSaleAt('2026-09-09T15:00:00.000Z', [
      { productId: p.id, quantity: 1, soldPriceCents: 59900 },
    ]);
    expect(history().getById(result.saleId).customerName).toBeNull();
    expect(
      history()
        .list({})
        .find((e) => e.saleId === result.saleId)!.customerName,
    ).toBeNull();
  });

  it('a Card sale lists and details with the CARD payment method', () => {
    const p = seedProduct(db);
    const req = buildCardRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    card('2026-09-09T16:00:00.000Z').beginCard(req);
    const result = card('2026-09-09T16:01:00.000Z').completeCard(req);
    expect(history().getById(result.saleId).paymentMethod).toBe('CARD');
    expect(
      history()
        .list({})
        .find((e) => e.saleId === result.saleId)!.paymentMethod,
    ).toBe('CARD');
  });
});

describe('ordering (task §7)', () => {
  it('newest completed sale first, receipt_number as the deterministic tie-break', () => {
    const p = seedProduct(db, { quantity: 20 });
    const first = cashSaleAt('2026-09-09T09:00:00.000Z', [
      { productId: p.id, quantity: 1, soldPriceCents: 59900 },
    ]);
    const second = cashSaleAt('2026-09-09T12:00:00.000Z', [
      { productId: p.id, quantity: 1, soldPriceCents: 59900 },
    ]);
    // Same completed_at as `second` — tie broken by receipt_number DESC.
    const third = cashSaleAt('2026-09-09T12:00:00.000Z', [
      { productId: p.id, quantity: 1, soldPriceCents: 59900 },
    ]);
    expect(
      history()
        .list({})
        .map((e) => e.receiptNumber),
    ).toEqual([third.receiptNumber, second.receiptNumber, first.receiptNumber]);
  });
});

describe('TEST-HIST-002 — Receipt Search', () => {
  it('exact receipt number returns only that sale; a nonexistent one is an empty state', () => {
    const p = seedProduct(db, { quantity: 5 });
    const a = cashSaleAt('2026-09-09T09:00:00.000Z', [
      { productId: p.id, quantity: 1, soldPriceCents: 59900 },
    ]);
    cashSaleAt('2026-09-09T10:00:00.000Z', [
      { productId: p.id, quantity: 1, soldPriceCents: 59900 },
    ]);

    expect(
      history()
        .list({ query: a.receiptNumber })
        .map((e) => e.receiptNumber),
    ).toEqual([a.receiptNumber]);
    // Digits-only and lower-case variants also locate it.
    expect(
      history()
        .list({ query: '000001' })
        .map((e) => e.receiptNumber),
    ).toEqual(['GP-000001']);
    expect(
      history()
        .list({ query: 'gp-000001' })
        .map((e) => e.receiptNumber),
    ).toEqual(['GP-000001']);
    expect(history().list({ query: 'GP-999999' })).toEqual([]);
  });
});

describe('TEST-HIST-003 — Customer Search (historical snapshot)', () => {
  it('finds the sale by the stored customer name snapshot, and later customer edits do not change the result', () => {
    const p = seedProduct(db, { quantity: 9 });
    const alice = createCustomerService({ db, now: () => '2026-09-09T00:00:00.000Z' }).create({
      name: 'Alice Adams',
      phone: '281-100-0001',
    });
    const bob = createCustomerService({ db, now: () => '2026-09-09T00:00:00.000Z' }).create({
      name: 'Bob Barker',
    });
    const saleA = cashSaleAt(
      '2026-09-09T09:00:00.000Z',
      [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }],
      alice.id,
    );
    cashSaleAt(
      '2026-09-09T10:00:00.000Z',
      [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }],
      bob.id,
    );
    cashSaleAt('2026-09-09T11:00:00.000Z', [
      { productId: p.id, quantity: 1, soldPriceCents: 59900 },
    ]); // no customer

    expect(
      history()
        .list({ query: 'Alice' })
        .map((e) => e.saleId),
    ).toEqual([saleA.saleId]);
    // Historical phone snapshot is searchable too.
    expect(
      history()
        .list({ query: '2811000001' })
        .map((e) => e.saleId),
    ).toEqual([saleA.saleId]);

    // Rename Alice now — the historical sale still says "Alice Adams".
    createCustomerService({ db, now: () => '2026-09-10T00:00:00.000Z' }).update(alice.id, {
      name: 'Alice Zephyr',
      phone: '999-000-0000',
    });
    expect(
      history()
        .list({ query: 'Alice Adams' })
        .map((e) => e.saleId),
    ).toEqual([saleA.saleId]);
    expect(history().list({ query: 'Zephyr' })).toEqual([]);
    expect(history().getById(saleA.saleId).customerName).toBe('Alice Adams');
  });
});

describe('TEST-HIST-004 — Historical Snapshot', () => {
  it('changing current product, customer, tax, and business data never changes list or detail', () => {
    const p = seedProduct(db, { name: 'iPhone 15 128GB', sellingPriceCents: 59900, quantity: 5 });
    const customer = createCustomerService({ db, now: () => '2026-09-09T00:00:00.000Z' }).create({
      name: 'Original Name',
      phone: '111-1111',
    });
    const result = cashSaleAt(
      '2026-09-09T15:00:00.000Z',
      [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }],
      customer.id,
    );

    const listBefore = history().list({});
    const detailBefore = history().getById(result.saleId);

    createProductService({ db, now: () => '2026-09-10T00:00:00.000Z' }).update(p.id, {
      name: 'iPhone 15 Clearance',
      brand: 'Apple',
      model: 'iPhone 15',
      condition: 'USED',
      sellingPriceCents: 40000,
      costPriceCents: null,
      sku: null,
      barcode: null,
      lowStockThreshold: null,
    });
    createProductService({ db, now: () => '2026-09-10T00:00:00.000Z' }).archive(p.id);
    createCustomerService({ db, now: () => '2026-09-10T00:00:00.000Z' }).update(customer.id, {
      name: 'Changed Name',
      phone: '999-9999',
    });
    createSettingsService({
      db,
      appVersion: 't',
      now: () => '2026-09-10T00:00:00.000Z',
    }).updateTaxRate({ taxRateBps: 600 });
    createSettingsService({
      db,
      appVersion: 't',
      now: () => '2026-09-10T00:00:00.000Z',
    }).updateBusinessConfig({
      businessAddress: 'NEW ADDRESS 456',
      businessPhone: '(555) 999-0000',
      receiptDisclaimer: 'NEW DISCLAIMER',
      receiptFooter: 'NEW FOOTER',
    });

    expect(history().list({})).toEqual(listBefore);
    expect(history().getById(result.saleId)).toEqual(detailBefore);
    const after = history().getById(result.saleId);
    expect(after.items[0]).toMatchObject({
      productName: 'iPhone 15 128GB',
      condition: 'NEW',
      listedPriceCents: 59900,
      soldPriceCents: 55000,
    });
    expect(after.taxRateBps).toBe(825);
    expect(after.customerName).toBe('Original Name');
  });
});

describe('TEST-HIST-005 — Google Export State', () => {
  it('displays the durable local job status exactly, including EXPORTING (never faked as EXPORTED)', () => {
    const p = seedProduct(db, { quantity: 20 });
    const mk = (h: number) =>
      cashSaleAt(`2026-09-09T${String(h).padStart(2, '0')}:00:00.000Z`, [
        { productId: p.id, quantity: 1, soldPriceCents: 59900 },
      ]);
    const pending = mk(8);
    const exporting = mk(9);
    const exported = mk(10);
    const failed = mk(11);

    setExportStatus(exporting.saleId, 'EXPORTING');
    setExportStatus(exported.saleId, 'EXPORTED');
    setExportStatus(failed.saleId, 'FAILED');

    const byId = new Map(
      history()
        .list({})
        .map((e) => [e.saleId, e.exportStatus]),
    );
    expect(byId.get(pending.saleId)).toBe('PENDING');
    expect(byId.get(exporting.saleId)).toBe('EXPORTING');
    expect(byId.get(exported.saleId)).toBe('EXPORTED');
    expect(byId.get(failed.saleId)).toBe('FAILED');
    expect(history().getById(exporting.saleId).exportStatus).toBe('EXPORTING');
  });
});

describe('TEST-HIST-006 — Sales History Date Search (business date, not UTC)', () => {
  it('filters by the derived business date in the configured timezone across a UTC boundary', () => {
    const p = seedProduct(db, { quantity: 20 });
    // America/Chicago (seeded). Three distinct business dates:
    const sep8 = cashSaleAt('2026-09-08T18:00:00.000Z', [
      { productId: p.id, quantity: 1, soldPriceCents: 59900 },
    ]); // 13:00 CDT Sep 8
    const sep9 = cashSaleAt('2026-09-10T01:30:00.000Z', [
      { productId: p.id, quantity: 1, soldPriceCents: 59900 },
    ]); // 20:30 CDT Sep 9 — NOT Sep 10
    const sep10 = cashSaleAt('2026-09-11T04:00:00.000Z', [
      { productId: p.id, quantity: 1, soldPriceCents: 59900 },
    ]); // 23:00 CDT Sep 10

    expect(
      history()
        .list({ businessDate: '2026-09-09' })
        .map((e) => e.saleId),
    ).toEqual([sep9.saleId]);
    // The naive UTC date of `sep9` would be 2026-09-10 — must return nothing there.
    expect(
      history()
        .list({ businessDate: '2026-09-10' })
        .map((e) => e.saleId),
    ).toEqual([sep10.saleId]);
    expect(
      history()
        .list({ businessDate: '2026-09-08' })
        .map((e) => e.saleId),
    ).toEqual([sep8.saleId]);
    expect(history().list({})[0]?.businessDate).toBe('2026-09-10');
  });

  it('combines a date filter with a receipt/customer query (AND)', () => {
    const p = seedProduct(db, { quantity: 20 });
    const alice = createCustomerService({ db, now: () => '2026-09-09T00:00:00.000Z' }).create({
      name: 'Alice',
    });
    const onDateWithAlice = cashSaleAt(
      '2026-09-10T01:30:00.000Z',
      [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }],
      alice.id,
    );
    cashSaleAt(
      '2026-09-08T18:00:00.000Z',
      [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }],
      alice.id,
    ); // Alice, wrong date
    cashSaleAt('2026-09-10T01:45:00.000Z', [
      { productId: p.id, quantity: 1, soldPriceCents: 59900 },
    ]); // right date, no Alice

    expect(
      history()
        .list({ query: 'Alice', businessDate: '2026-09-09' })
        .map((e) => e.saleId),
    ).toEqual([onDateWithAlice.saleId]);
  });
});

describe('VOIDED rendering (task §16 — future-compatible now)', () => {
  it('a voided sale stays visible, is clearly marked, and carries voided_at + reason in detail', () => {
    const p = seedProduct(db, { quantity: 5 });
    const result = cashSaleAt('2026-09-09T15:00:00.000Z', [
      { productId: p.id, quantity: 1, soldPriceCents: 59900 },
    ]);
    forceVoid(result.saleId, '2026-09-10T09:00:00.000Z', 'Rang up in error');

    const entry = history()
      .list({})
      .find((e) => e.saleId === result.saleId)!;
    expect(entry.status).toBe('VOIDED');
    expect(entry.voidedAt).toBe('2026-09-10T09:00:00.000Z');

    const detail = history().getById(result.saleId);
    expect(detail).toMatchObject({
      status: 'VOIDED',
      voidedAt: '2026-09-10T09:00:00.000Z',
      voidReason: 'Rang up in error',
    });
    expect(detail.items).toHaveLength(1); // items are NOT deleted
  });
});

describe('not-found + read-only guarantees', () => {
  it('an unknown / blank Sale ID is a sanitized SALE_NOT_FOUND / VALIDATION, never a raw error', () => {
    try {
      history().getById('does-not-exist');
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('SALE_NOT_FOUND');
    }
    try {
      history().getById('   ');
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('VALIDATION');
    }
  });

  it('reading history writes no row and consumes no audit sequence (task §34)', () => {
    const p = seedProduct(db, { quantity: 5 });
    const result = cashSaleAt('2026-09-09T15:00:00.000Z', [
      { productId: p.id, quantity: 1, soldPriceCents: 59900 },
    ]);
    const snapshot = {
      sales: countRows(db, 'sales'),
      sale_items: countRows(db, 'sale_items'),
      payments: countRows(db, 'payments'),
      inventory_movements: countRows(db, 'inventory_movements'),
      google_sheet_export_jobs: countRows(db, 'google_sheet_export_jobs'),
      audit_events: countRows(db, 'audit_events'),
      checkout_requests: countRows(db, 'checkout_requests'),
      audit_counter: auditCounter(db),
    };

    history().list({});
    history().list({ query: 'GP', businessDate: '2026-09-09' });
    history().getById(result.saleId);

    expect({
      sales: countRows(db, 'sales'),
      sale_items: countRows(db, 'sale_items'),
      payments: countRows(db, 'payments'),
      inventory_movements: countRows(db, 'inventory_movements'),
      google_sheet_export_jobs: countRows(db, 'google_sheet_export_jobs'),
      audit_events: countRows(db, 'audit_events'),
      checkout_requests: countRows(db, 'checkout_requests'),
      audit_counter: auditCounter(db),
    }).toEqual(snapshot);
  });

  it('an empty database is a normal empty list, not an error', () => {
    expect(history().list({})).toEqual([]);
    expect(history().list({ query: 'anything' })).toEqual([]);
  });
});
