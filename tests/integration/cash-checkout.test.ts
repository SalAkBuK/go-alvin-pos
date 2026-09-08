import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSaleService } from '../../src/main/checkout/saleService';
import { createCheckoutService } from '../../src/main/checkout/checkoutService';
import { createCustomerService } from '../../src/main/customers/customerService';
import { createProductService } from '../../src/main/products/productService';
import { createSettingsService } from '../../src/main/settings/settingsService';
import { listPurchaseHistory } from '../../src/main/customers/customerRepository';
import { isAppError } from '../../src/main/shared/appError';
import { createMigratedDb } from '../helpers/database';
import {
  auditCounter,
  auditRows,
  buildCashRequest,
  countRows,
  productQuantity,
  receiptCounter,
  seedBusiness,
  seedProduct,
  seedTaxRate,
  T0,
  T1,
  T2,
} from '../helpers/checkout';

/**
 * Phase 2E — authoritative Cash sale (`POS_WORKFLOWS.md §28`, `§33`-`§37`;
 * `DATA_MODEL.md §31`, `§44-49`, `§60-61`; `TEST_PLAN.md` TEST-CASH-001,
 * TEST-ATOMIC-001..006, TEST-INV-001..004, TEST-CUST-004/005/006/008,
 * TEST-DISC-005, TEST-GSHEET-018;
 * `REQ-SALE-008/009`, `REQ-INV-002/003/005`, `REQ-GSHEET-001/002`,
 * `REQ-AUDIT-002/004`).
 *
 * TEST-TAX-002 and TEST-PROD-006 are covered here only for their
 * persistence/immutability half — a completed sale's tax rate, tax amount, and
 * product snapshots are frozen and never rewritten by a later configuration or
 * product edit. Their historical-sale *retrieval/view* half (reload the old
 * sale, view it on a receipt/reprint) needs the sales-history surface, which is
 * not in Phase 2E.
 */

let db: Database.Database;

function sale(now: () => string = () => T0) {
  return createSaleService({ db, appVersion: 'test-2e', now });
}

beforeEach(async () => {
  db = await createMigratedDb();
  seedTaxRate(db);
  seedBusiness(db);
});
afterEach(() => db.close());

describe('TEST-CASH-001 / TEST-ATOMIC-001 — a successful Cash sale writes everything together', () => {
  it('commits the sale, item, payment, inventory, movement, export job, audit, and request completion', () => {
    const p = seedProduct(db, { sellingPriceCents: 59900, quantity: 5 });
    const req = buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }]);

    const result = sale().completeCashSale(req);

    expect(result).toEqual({
      saleId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      receiptNumber: 'GP-000001',
      totalCents: 59538, // 55000 taxable + 4538 tax @ 8.25%
      paymentMethod: 'CASH',
      exportStatus: 'PENDING',
      alreadyCompleted: false,
    });

    const saleRow = db.prepare('SELECT * FROM sales WHERE id = ?').get(result.saleId) as Record<
      string,
      unknown
    >;
    expect(saleRow).toMatchObject({
      receipt_number: 'GP-000001',
      customer_id: null,
      business_name_snapshot: 'Go Phones - Alvin',
      business_address_snapshot: '123 Main St, Alvin, TX 77511',
      business_phone_snapshot: '(281) 555-0100',
      status: 'COMPLETED',
      sync_version: 1,
      subtotal_cents: 59900,
      discount_cents: 4900,
      taxable_amount_cents: 55000,
      tax_rate_bps: 825,
      tax_cents: 4538,
      total_cents: 59538,
      payment_method_snapshot: 'CASH',
      created_at: T0,
      completed_at: T0,
      voided_at: null,
      void_reason: null,
    });

    const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(result.saleId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      product_id: p.id,
      product_name_snapshot: 'iPhone 15 128GB',
      brand_snapshot: 'Apple',
      condition_snapshot: 'NEW',
      listed_price_cents: 59900,
      sold_price_cents: 55000,
      discount_cents: 4900,
      quantity: 1,
      line_subtotal_cents: 59900,
      line_total_cents: 55000,
    });

    const payments = db.prepare('SELECT * FROM payments WHERE sale_id = ?').all(result.saleId);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      method: 'CASH',
      amount_cents: 59538,
      status: 'COMPLETED',
      created_at: T0,
    });

    expect(productQuantity(db, p.id)).toBe(4);

    const movements = db
      .prepare("SELECT * FROM inventory_movements WHERE movement_type = 'SALE'")
      .all() as Array<Record<string, unknown>>;
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      product_id: p.id,
      sale_id: result.saleId,
      movement_type: 'SALE',
      reverses_movement_id: null,
      quantity_change: -1,
      quantity_before: 5,
      quantity_after: 4,
      reason: null,
    });

    const jobs = db.prepare('SELECT * FROM google_sheet_export_jobs').all() as Array<
      Record<string, unknown>
    >;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      sale_id: result.saleId,
      status: 'PENDING',
      target_sync_version: 1,
      exported_sync_version: null,
      attempt_count: 0,
      exported_at: null,
      last_error: null,
    });

    const completed = auditRows(db, 'SALE_COMPLETED');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      subject_type: 'SALE',
      subject_id: result.saleId,
      correlation_id: req.requestId,
      outcome: 'SUCCESS',
      actor_type: 'USER',
      app_version: 'test-2e',
    });

    const request = db
      .prepare('SELECT * FROM checkout_requests WHERE request_id = ?')
      .get(req.requestId) as Record<string, unknown>;
    expect(request).toMatchObject({
      payment_method_snapshot: 'CASH',
      intended_total_cents: 59538,
      status: 'COMPLETED',
      sale_id: result.saleId,
      completed_at: T0,
      failure_code: null,
      failed_at: null,
      clover_approved_confirmed_at: null,
    });
  });
});

describe('timestamp semantics — sales.created_at vs completed_at (`DATA_MODEL.md §4`)', () => {
  it('created_at is the Phase 1 request instant; completed_at is the Phase 2 commit instant', () => {
    const clock = [T0, T1, T2];
    let i = 0;
    const now = () => clock[Math.min(i++, clock.length - 1)]!;
    const p = seedProduct(db);
    const req = buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);

    const result = createSaleService({ db, appVersion: 'test', now }).completeCashSale(req);

    const saleRow = db
      .prepare('SELECT created_at, completed_at FROM sales WHERE id = ?')
      .get(result.saleId) as { created_at: string; completed_at: string };
    const reqRow = db
      .prepare('SELECT created_at FROM checkout_requests WHERE request_id = ?')
      .get(req.requestId) as { created_at: string };
    expect(saleRow.created_at).toBe(reqRow.created_at);
    expect(saleRow.created_at).toBe(T0);
    expect(saleRow.completed_at).toBe(T1);
    expect(saleRow.created_at < saleRow.completed_at).toBe(true);
  });
});

describe('customer snapshots (`DATA_MODEL.md §44-49`; TEST-CUST-004/005/006/008)', () => {
  it('TEST-CUST-004 — a customerless sale completes with null customer snapshots', () => {
    const p = seedProduct(db);
    const req = buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    const result = sale().completeCashSale(req);
    expect(
      db
        .prepare(
          'SELECT customer_id, customer_name_snapshot, customer_phone_snapshot FROM sales WHERE id = ?',
        )
        .get(result.saleId),
    ).toEqual({
      customer_id: null,
      customer_name_snapshot: null,
      customer_phone_snapshot: null,
    });
  });

  it('TEST-CUST-005 — an attached customer keeps its relationship + transaction-time snapshots', () => {
    const p = seedProduct(db);
    const customer = createCustomerService({ db, now: () => T0 }).create({
      name: 'Sam Buyer',
      phone: '(281) 824-0001',
    });
    const req = buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }], {
      customerId: customer.id,
    });
    const result = sale().completeCashSale(req);

    expect(
      db
        .prepare(
          'SELECT customer_id, customer_name_snapshot, customer_phone_snapshot FROM sales WHERE id = ?',
        )
        .get(result.saleId),
    ).toEqual({
      customer_id: customer.id,
      customer_name_snapshot: 'Sam Buyer',
      customer_phone_snapshot: '(281) 824-0001',
    });

    const history = listPurchaseHistory(db, customer.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ receiptNumber: 'GP-000001', totalCents: result.totalCents });
  });

  it('TEST-CUST-008 — a customer with no phone can be sold to; phone snapshot is null', () => {
    const p = seedProduct(db);
    const customer = createCustomerService({ db, now: () => T0 }).create({ name: 'No Phone' });
    const req = buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }], {
      customerId: customer.id,
    });
    const result = sale().completeCashSale(req);
    expect(
      db.prepare('SELECT customer_phone_snapshot FROM sales WHERE id = ?').get(result.saleId),
    ).toEqual({ customer_phone_snapshot: null });
  });

  it('TEST-CUST-006 — editing the customer later never rewrites the sale snapshot', () => {
    const p = seedProduct(db);
    const customer = createCustomerService({ db, now: () => T0 }).create({
      name: 'Original Name',
      phone: '111-1111',
    });
    const req = buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }], {
      customerId: customer.id,
    });
    const result = sale().completeCashSale(req);

    createCustomerService({ db, now: () => T1 }).update(customer.id, {
      name: 'Changed Name',
      phone: '999-9999',
    });

    expect(
      db
        .prepare('SELECT customer_name_snapshot, customer_phone_snapshot FROM sales WHERE id = ?')
        .get(result.saleId),
    ).toEqual({ customer_name_snapshot: 'Original Name', customer_phone_snapshot: '111-1111' });
  });
});

describe('business / receipt snapshots (`§44-49`, `§69`)', () => {
  it('snapshots the config at sale time and a later business-config change never rewrites it', () => {
    const p = seedProduct(db);
    const req = buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    const result = sale().completeCashSale(req);

    createSettingsService({ db, appVersion: 'test', now: () => T1 }).updateBusinessConfig({
      businessAddress: 'NEW ADDRESS 456',
      businessPhone: '(555) 999-0000',
      receiptDisclaimer: 'NEW DISCLAIMER',
      receiptFooter: 'NEW FOOTER',
    });

    expect(
      db
        .prepare(
          `SELECT business_address_snapshot, business_phone_snapshot,
                  receipt_disclaimer_snapshot, receipt_footer_snapshot FROM sales WHERE id = ?`,
        )
        .get(result.saleId),
    ).toEqual({
      business_address_snapshot: '123 Main St, Alvin, TX 77511',
      business_phone_snapshot: '(281) 555-0100',
      receipt_disclaimer_snapshot: 'All sales final. 30-day warranty on refurbished devices.',
      receipt_footer_snapshot: 'Thank you for shopping with Go Phones!',
    });
  });

  it('rejects completion with BUSINESS_NOT_CONFIGURED before any checkout request row is created', async () => {
    const freshDb = await createMigratedDb();
    try {
      seedTaxRate(freshDb);
      const p = seedProduct(freshDb, { sellingPriceCents: 10000, quantity: 2 });
      const req = buildCashRequest(freshDb, [
        { productId: p.id, quantity: 1, soldPriceCents: 10000 },
      ]);
      try {
        createSaleService({ db: freshDb, appVersion: 'test', now: () => T0 }).completeCashSale(req);
        throw new Error('expected rejection');
      } catch (error) {
        expect(isAppError(error) && error.code).toBe('BUSINESS_NOT_CONFIGURED');
      }
      expect(countRows(freshDb, 'sales')).toBe(0);
      // The store-identity gate runs before the Phase 1 row is inserted, so no
      // SUBMITTED row is ever stranded for a store that cannot check out.
      expect(countRows(freshDb, 'checkout_requests')).toBe(0);
    } finally {
      freshDb.close();
    }
  });
});

describe('inventory (`REQ-INV-002/003/005`; TEST-INV-001..004)', () => {
  it('TEST-INV-001 — selling 1 of 5 leaves 4', () => {
    const p = seedProduct(db, { quantity: 5 });
    sale().completeCashSale(
      buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]),
    );
    expect(productQuantity(db, p.id)).toBe(4);
  });

  it('TEST-INV-002 — selling 2 of 5 leaves 3, with one aggregated movement', () => {
    const p = seedProduct(db, { quantity: 5 });
    const result = sale().completeCashSale(
      buildCashRequest(db, [{ productId: p.id, quantity: 2, soldPriceCents: 59900 }]),
    );
    expect(productQuantity(db, p.id)).toBe(3);
    const movements = db
      .prepare("SELECT quantity_change FROM inventory_movements WHERE movement_type = 'SALE'")
      .all() as Array<{ quantity_change: number }>;
    expect(movements).toEqual([{ quantity_change: -2 }]);
    expect(result.receiptNumber).toBe('GP-000001');
  });

  it('TEST-INV-003 — a cart above current stock is rejected and inventory is unchanged', () => {
    const p = seedProduct(db, { quantity: 1 });
    // review already rejects; the completion path also cannot be built past review
    expect(() =>
      buildCashRequest(db, [{ productId: p.id, quantity: 2, soldPriceCents: 59900 }]),
    ).toThrow();
    expect(productQuantity(db, p.id)).toBe(1);
    expect(countRows(db, 'sales')).toBe(0);
  });

  it('TEST-INV-004 — a zero-stock product cannot be reviewed or sold', () => {
    const p = seedProduct(db, { quantity: 0 });
    expect(() =>
      buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]),
    ).toThrow();
    expect(countRows(db, 'sales')).toBe(0);
  });
});

describe('duplicate cart lines (`§41A`, `§41B`; REQ-SALE-012, TEST-IDEMP-008 part 4)', () => {
  it('keeps two identical lines as two sale_items rows, one aggregated movement, stock -2', () => {
    const p = seedProduct(db, { sellingPriceCents: 10000, quantity: 5 });
    const result = sale().completeCashSale(
      buildCashRequest(db, [
        { productId: p.id, quantity: 1, soldPriceCents: 10000 },
        { productId: p.id, quantity: 1, soldPriceCents: 10000 },
      ]),
    );
    expect(countRows(db, 'sale_items')).toBe(2);
    expect(
      db.prepare("SELECT COUNT(*) n FROM inventory_movements WHERE movement_type = 'SALE'").get(),
    ).toEqual({ n: 1 });
    expect(productQuantity(db, p.id)).toBe(3);
    expect(result.totalCents).toBe(20000 + Math.floor((20000 * 825 + 5000) / 10000));
  });

  it('keeps two different-price lines for one product as two distinct sale_items rows', () => {
    const p = seedProduct(db, { sellingPriceCents: 59900, quantity: 5 });
    const result = sale().completeCashSale(
      buildCashRequest(db, [
        { productId: p.id, quantity: 1, soldPriceCents: 59900 },
        { productId: p.id, quantity: 2, soldPriceCents: 55000 },
      ]),
    );
    const items = db
      .prepare(
        'SELECT sold_price_cents, quantity FROM sale_items WHERE sale_id = ? ORDER BY sold_price_cents',
      )
      .all(result.saleId);
    expect(items).toEqual([
      { sold_price_cents: 55000, quantity: 2 },
      { sold_price_cents: 59900, quantity: 1 },
    ]);
    expect(productQuantity(db, p.id)).toBe(2); // 5 - (1 + 2)
  });
});

describe('price override (`§21`, `§41`; TEST-DISC-005)', () => {
  it('below-list: discount recorded, one PRICE_OVERRIDE audit event with the line', () => {
    const p = seedProduct(db, { sellingPriceCents: 59900, quantity: 3 });
    const result = sale().completeCashSale(
      buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }]),
    );
    expect(
      db.prepare('SELECT discount_cents FROM sale_items WHERE sale_id = ?').get(result.saleId),
    ).toEqual({ discount_cents: 4900 });
    const overrides = auditRows(db, 'PRICE_OVERRIDE');
    expect(overrides).toHaveLength(1);
    const details = JSON.parse(overrides[0]!['details_json'] as string) as {
      overrides: Array<Record<string, unknown>>;
    };
    expect(details.overrides).toEqual([
      {
        productId: p.id,
        productName: 'iPhone 15 128GB',
        listedPriceCents: 59900,
        soldPriceCents: 55000,
        quantity: 1,
      },
    ]);
  });

  it('TEST-DISC-005 — above-list: sale commits, sale_items.discount_cents = 0, still audited as an override', () => {
    const p = seedProduct(db, { sellingPriceCents: 59900, quantity: 3 });
    const result = sale().completeCashSale(
      buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 65000 }]),
    );
    expect(
      db.prepare('SELECT discount_cents FROM sale_items WHERE sale_id = ?').get(result.saleId),
    ).toEqual({ discount_cents: 0 });
    expect(auditRows(db, 'PRICE_OVERRIDE')).toHaveLength(1);
  });

  it('no override: no PRICE_OVERRIDE audit event', () => {
    const p = seedProduct(db, { sellingPriceCents: 59900, quantity: 3 });
    sale().completeCashSale(
      buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]),
    );
    expect(auditRows(db, 'PRICE_OVERRIDE')).toHaveLength(0);
  });
});

describe('historical immutability — persistence half of TEST-PROD-006 / TEST-TAX-002 (`REQ-SALE-009`, `REQ-TAX-003`; retrieval/view half deferred)', () => {
  it('changing the product, the tax rate, and the customer afterwards leaves the sale untouched', () => {
    const p = seedProduct(db, { sellingPriceCents: 59900, quantity: 5 });
    const customer = createCustomerService({ db, now: () => T0 }).create({ name: 'A', phone: '1' });
    const req = buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }], {
      customerId: customer.id,
    });
    const result = sale().completeCashSale(req);

    const before = db.prepare('SELECT * FROM sales WHERE id = ?').get(result.saleId);
    const itemsBefore = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(result.saleId);

    createProductService({ db, now: () => T1 }).update(p.id, {
      name: 'iPhone 15 Clearance',
      brand: 'Apple',
      model: 'iPhone 15',
      condition: 'USED',
      sellingPriceCents: 48000,
      costPriceCents: null,
      sku: null,
      barcode: null,
      lowStockThreshold: null,
    });
    createSettingsService({ db, appVersion: 'test', now: () => T1 }).updateTaxRate({
      taxRateBps: 900,
    });
    createCustomerService({ db, now: () => T1 }).update(customer.id, { name: 'B', phone: '2' });

    expect(db.prepare('SELECT * FROM sales WHERE id = ?').get(result.saleId)).toEqual(before);
    expect(db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(result.saleId)).toEqual(
      itemsBefore,
    );
  });
});

describe('audit privacy + sequencing (`REQ-AUDIT-003`, `§36A`)', () => {
  it('SALE_COMPLETED details carry no customer name/phone and the sequence is transactional', () => {
    const p = seedProduct(db);
    const customer = createCustomerService({ db, now: () => T0 }).create({
      name: 'Private Person',
      phone: '555-secret',
    });
    const before = auditCounter(db);
    const result = sale().completeCashSale(
      buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }], {
        customerId: customer.id,
      }),
    );
    const details = auditRows(db, 'SALE_COMPLETED')[0]!['details_json'] as string;
    expect(details).not.toMatch(/Private Person|555-secret|password|token/i);
    const parsed = JSON.parse(details) as Record<string, unknown>;
    expect(parsed).toMatchObject({ customerAttached: true, paymentMethod: 'CASH' });
    // SALE_COMPLETED + PRICE_OVERRIDE both allocated, in order, from the counter.
    expect(auditCounter(db)).toBe(before + 2);
    const seqs = db
      .prepare('SELECT sequence FROM audit_events WHERE subject_id = ? ORDER BY sequence')
      .all(result.saleId) as Array<{ sequence: number }>;
    expect(seqs.map((s) => s.sequence)).toEqual([before + 1, before + 2]);
  });
});

describe('TEST-GSHEET-018 — sale + export job commit atomically, no network', () => {
  it('produces exactly one PENDING job for the sale and nothing else', () => {
    const p = seedProduct(db);
    const result = sale().completeCashSale(
      buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]),
    );
    const jobs = db
      .prepare('SELECT sale_id, status, target_sync_version FROM google_sheet_export_jobs')
      .all();
    expect(jobs).toEqual([{ sale_id: result.saleId, status: 'PENDING', target_sync_version: 1 }]);
  });
});

describe('TEST-ATOMIC-002..006 — any Phase 2 failure rolls back the whole sale', () => {
  const cases: Array<[string, string]> = [
    ['TEST-ATOMIC-002 sale item insert', 'sale_items'],
    ['TEST-ATOMIC-003 payment insert', 'payments'],
    ['TEST-ATOMIC-004 inventory movement insert', 'inventory_movements'],
    ['TEST-ATOMIC-005 export job insert', 'google_sheet_export_jobs'],
    ['TEST-ATOMIC-006 required audit insert', 'audit_events'],
  ];

  it.each(cases)('%s failing → full rollback, request marked COMMIT_FAILED', (_label, table) => {
    const p = seedProduct(db, { quantity: 5 });
    const req = buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }]);
    const receiptBefore = receiptCounter(db);
    const auditBefore = auditCounter(db);

    db.exec(`ALTER TABLE ${table} RENAME TO ${table}_x`);
    try {
      expect(() => sale().completeCashSale(req)).toThrow();
    } finally {
      db.exec(`ALTER TABLE ${table}_x RENAME TO ${table}`);
    }

    expect(countRows(db, 'sales')).toBe(0);
    expect(countRows(db, 'sale_items')).toBe(0);
    expect(countRows(db, 'payments')).toBe(0);
    expect(
      db.prepare("SELECT COUNT(*) n FROM inventory_movements WHERE movement_type = 'SALE'").get(),
    ).toEqual({ n: 0 });
    expect(countRows(db, 'google_sheet_export_jobs')).toBe(0);
    expect(auditRows(db, 'SALE_COMPLETED')).toHaveLength(0);
    expect(productQuantity(db, p.id)).toBe(5);
    expect(receiptCounter(db)).toBe(receiptBefore);
    expect(auditCounter(db)).toBe(auditBefore);

    // Phase 1 evidence survives the rollback and records the outcome.
    const row = db
      .prepare('SELECT status, failure_code, sale_id FROM checkout_requests WHERE request_id = ?')
      .get(req.requestId) as {
      status: string;
      failure_code: string | null;
      sale_id: string | null;
    };
    expect(row).toEqual({
      status: 'COMMIT_FAILED',
      failure_code: 'SALE_COMMIT_FAILED',
      sale_id: null,
    });
  });

  it('a later successful sale still gets GP-000001 after a failed attempt rolled the counter back', () => {
    const p = seedProduct(db, { quantity: 5 });
    const failing = buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }]);
    db.exec('ALTER TABLE payments RENAME TO payments_x');
    try {
      expect(() => sale().completeCashSale(failing)).toThrow();
    } finally {
      db.exec('ALTER TABLE payments_x RENAME TO payments');
    }
    const ok = buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }]);
    const result = sale().completeCashSale(ok);
    expect(result.receiptNumber).toBe('GP-000001');
  });
});

describe('review path unchanged by the extraction', () => {
  it('checkout:review still returns the canonical review + fingerprint and writes nothing', () => {
    const p = seedProduct(db, { sellingPriceCents: 60000, quantity: 3 });
    const review = createCheckoutService({ db }).review({
      customerId: null,
      paymentMethod: 'CASH',
      lines: [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }],
    });
    expect(review.totalCents).toBe(59538);
    expect(review.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(countRows(db, 'sales')).toBe(0);
    expect(countRows(db, 'checkout_requests')).toBe(0);
  });
});
