import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createReceiptService } from '../../src/main/checkout/receiptService';
import { createSaleService } from '../../src/main/checkout/saleService';
import { createCustomerService } from '../../src/main/customers/customerService';
import { createProductService } from '../../src/main/products/productService';
import { createSettingsService } from '../../src/main/settings/settingsService';
import { isAppError } from '../../src/main/shared/appError';
import type { ReceiptRepresentation } from '../../src/shared/receipt';
import { createMigratedDb } from '../helpers/database';
import {
  auditCounter,
  buildCashRequest,
  countRows,
  seedBusiness,
  seedProduct,
  seedTaxRate,
  T0,
  T1,
} from '../helpers/checkout';

/**
 * Phase 2E.1 — receipt representation assembled purely from committed snapshots
 * (`REQ-REC-001`-`REQ-REC-003`; `POS_WORKFLOWS.md §38`; `DATA_MODEL.md §4`,
 * `§44-49`; `TEST_PLAN.md` TEST-PRINT-005/007 receipt-generation portion,
 * TEST-TAX-002 / TEST-PROD-006 historical-view portion).
 */

let db: Database.Database;

function sale(now: () => string = () => T0) {
  return createSaleService({ db, appVersion: 'test-2e1', now });
}
function receiptFor(saleId: string): ReceiptRepresentation {
  return createReceiptService({ db }).getBySaleId(saleId);
}

beforeEach(async () => {
  db = await createMigratedDb();
  seedTaxRate(db);
  seedBusiness(db);
});
afterEach(() => db.close());

describe('a completed Cash sale loads as a receipt from its snapshots', () => {
  it('carries every REQ-REC-002 field from sales / sale_items / payments', () => {
    const p = seedProduct(db, { sellingPriceCents: 59900, quantity: 5 });
    const customer = createCustomerService({ db, now: () => T0 }).create({
      name: 'Sam Buyer',
      phone: '(281) 824-0001',
    });
    const result = sale().completeCashSale(
      buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }], {
        customerId: customer.id,
      }),
    );

    const receipt = receiptFor(result.saleId);

    expect(receipt).toEqual({
      saleId: result.saleId,
      receiptNumber: 'GP-000001',
      status: 'COMPLETED',
      completedAt: T0,
      voidedAt: null,
      voidReason: null,
      businessTimezone: 'America/Chicago',
      business: {
        name: 'Go Phones - Alvin',
        address: '123 Main St, Alvin, TX 77511',
        phone: '(281) 555-0100',
      },
      customer: { name: 'Sam Buyer', phone: '(281) 824-0001' },
      items: [
        {
          productName: 'iPhone 15 128GB',
          brand: 'Apple',
          model: 'iPhone 15',
          condition: 'NEW',
          sku: null,
          barcode: null,
          quantity: 1,
          listedPriceCents: 59900,
          soldPriceCents: 55000,
          discountCents: 4900,
          lineSubtotalCents: 59900,
          lineTotalCents: 55000,
        },
      ],
      totals: {
        subtotalCents: 59900,
        discountCents: 4900,
        taxableAmountCents: 55000,
        taxRateBps: 825,
        taxCents: 4538,
        totalCents: 59538,
      },
      payment: { method: 'CASH', amountCents: 59538 },
      disclaimer: 'All sales final. 30-day warranty on refurbished devices.',
      footer: 'Thank you for shopping with Go Phones!',
    });
  });

  it('TEST-PRINT-007 — a multi-item sale with a customer, a price override, and a discount has every field', () => {
    const a = seedProduct(db, { name: 'iPhone 15', sellingPriceCents: 59900, quantity: 9 });
    const b = seedProduct(db, { name: 'Pixel 9', sellingPriceCents: 50000, quantity: 9 });
    const customer = createCustomerService({ db, now: () => T0 }).create({
      name: 'Pat Customer',
      phone: '555-9000',
    });
    const result = sale().completeCashSale(
      buildCashRequest(
        db,
        [
          { productId: a.id, quantity: 1, soldPriceCents: 55000 }, // below list → discount
          { productId: b.id, quantity: 2, soldPriceCents: 52500 }, // above list → 0 discount
        ],
        { customerId: customer.id },
      ),
    );

    const receipt = receiptFor(result.saleId);

    expect(receipt.customer).toEqual({ name: 'Pat Customer', phone: '555-9000' });
    expect(receipt.items).toHaveLength(2);

    const iphone = receipt.items.find((i) => i.productName === 'iPhone 15')!;
    expect(iphone).toMatchObject({
      listedPriceCents: 59900,
      soldPriceCents: 55000,
      discountCents: 4900,
      quantity: 1,
      lineTotalCents: 55000,
    });
    const pixel = receipt.items.find((i) => i.productName === 'Pixel 9')!;
    expect(pixel).toMatchObject({
      listedPriceCents: 50000,
      soldPriceCents: 52500,
      discountCents: 0, // above-list override never becomes a negative discount
      quantity: 2,
      lineTotalCents: 105000,
    });

    // Totals + payment are the sale snapshot, not recalculated here.
    const saleRow = db
      .prepare(
        'SELECT subtotal_cents, discount_cents, tax_cents, total_cents FROM sales WHERE id = ?',
      )
      .get(result.saleId) as Record<string, number>;
    expect(receipt.totals).toMatchObject({
      subtotalCents: saleRow['subtotal_cents'],
      discountCents: saleRow['discount_cents'],
      taxCents: saleRow['tax_cents'],
      totalCents: saleRow['total_cents'],
      taxRateBps: 825,
    });
    expect(receipt.payment).toEqual({ method: 'CASH', amountCents: saleRow['total_cents'] });
    expect(receipt.business.name).toBe('Go Phones - Alvin');
    expect(receipt.disclaimer.length).toBeGreaterThan(0);
    expect(receipt.footer.length).toBeGreaterThan(0);
  });
});

describe('customer presence', () => {
  it('a customerless sale has a null customer — no placeholder is invented', () => {
    const p = seedProduct(db);
    const result = sale().completeCashSale(
      buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]),
    );
    expect(receiptFor(result.saleId).customer).toBeNull();
  });

  it('a customer with no phone shows the name and a null phone', () => {
    const p = seedProduct(db);
    const customer = createCustomerService({ db, now: () => T0 }).create({ name: 'No Phone' });
    const result = sale().completeCashSale(
      buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }], {
        customerId: customer.id,
      }),
    );
    expect(receiptFor(result.saleId).customer).toEqual({ name: 'No Phone', phone: null });
  });
});

describe('blank receipt policy — blank means blank', () => {
  it('a configured-blank disclaimer and footer stay blank in the representation', async () => {
    const fresh = await createMigratedDb();
    try {
      seedTaxRate(fresh);
      createSettingsService({ db: fresh, appVersion: 't', now: () => T0 }).updateBusinessConfig({
        businessAddress: '9 Blank Rd',
        businessPhone: '555-0000',
        receiptDisclaimer: '',
        receiptFooter: '',
      });
      const p = seedProduct(fresh);
      const result = createSaleService({
        db: fresh,
        appVersion: 't',
        now: () => T0,
      }).completeCashSale(
        buildCashRequest(fresh, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]),
      );
      const receipt = createReceiptService({ db: fresh }).getBySaleId(result.saleId);
      expect(receipt.disclaimer).toBe('');
      expect(receipt.footer).toBe('');
    } finally {
      fresh.close();
    }
  });
});

describe('item shape', () => {
  it('keeps two identical lines as two distinct receipt items', () => {
    const p = seedProduct(db, { sellingPriceCents: 10000, quantity: 5 });
    const result = sale().completeCashSale(
      buildCashRequest(db, [
        { productId: p.id, quantity: 1, soldPriceCents: 10000 },
        { productId: p.id, quantity: 1, soldPriceCents: 10000 },
      ]),
    );
    expect(receiptFor(result.saleId).items).toHaveLength(2);
  });

  it('orders items deterministically by the canonical §41B line tuple', () => {
    const a = seedProduct(db, { name: 'A', sellingPriceCents: 10000, quantity: 9 });
    const b = seedProduct(db, { name: 'B', sellingPriceCents: 20000, quantity: 9 });
    const result = sale().completeCashSale(
      buildCashRequest(db, [
        { productId: b.id, quantity: 1, soldPriceCents: 20000 },
        { productId: a.id, quantity: 1, soldPriceCents: 9000 },
        { productId: a.id, quantity: 1, soldPriceCents: 10000 },
      ]),
    );
    const items = receiptFor(result.saleId).items;
    // a.id < b.id (seedProduct uUIDs are random, so assert by content ordering rules):
    // same product_id groups together, then ascending sold price.
    const names = items.map((i) => `${i.productName}:${String(i.soldPriceCents)}`);
    const aFirst = a.id < b.id;
    expect(names).toEqual(
      aFirst ? ['A:9000', 'A:10000', 'B:20000'] : ['B:20000', 'A:9000', 'A:10000'],
    );
    // Re-reading yields the identical order.
    expect(receiptFor(result.saleId).items.map((i) => i.soldPriceCents)).toEqual(
      items.map((i) => i.soldPriceCents),
    );
  });
});

describe('missing / inconsistent data', () => {
  it('rejects an unknown Sale ID with RECEIPT_NOT_FOUND', () => {
    try {
      receiptFor('does-not-exist');
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('RECEIPT_NOT_FOUND');
    }
  });

  it('rejects a blank Sale ID as a validation error', () => {
    try {
      createReceiptService({ db }).getBySaleId('   ');
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('VALIDATION');
    }
  });
});

describe('historical integrity — TEST-PRINT-005 / TEST-TAX-002 / TEST-PROD-006 (view portion)', () => {
  it('changing current product, customer, tax, and business data never changes the receipt', () => {
    const p = seedProduct(db, { sellingPriceCents: 59900, quantity: 5 });
    const customer = createCustomerService({ db, now: () => T0 }).create({
      name: 'Original Name',
      phone: '111-1111',
    });
    const result = sale().completeCashSale(
      buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }], {
        customerId: customer.id,
      }),
    );

    const before = receiptFor(result.saleId);

    createProductService({ db, now: () => T1 }).update(p.id, {
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
    createCustomerService({ db, now: () => T1 }).update(customer.id, {
      name: 'Changed Name',
      phone: '999-9999',
    });
    createSettingsService({ db, appVersion: 't', now: () => T1 }).updateTaxRate({
      taxRateBps: 600,
    });
    createSettingsService({ db, appVersion: 't', now: () => T1 }).updateBusinessConfig({
      businessAddress: 'NEW ADDRESS 456',
      businessPhone: '(555) 999-0000',
      receiptDisclaimer: 'NEW DISCLAIMER',
      receiptFooter: 'NEW FOOTER',
    });

    expect(receiptFor(result.saleId)).toEqual(before);
    // Spot-check the transaction-time values specifically.
    const after = receiptFor(result.saleId);
    expect(after.items[0]?.productName).toBe('iPhone 15 128GB');
    expect(after.items[0]?.condition).toBe('NEW');
    expect(after.totals.taxRateBps).toBe(825);
    expect(after.totals.taxCents).toBe(4538);
    expect(after.customer).toEqual({ name: 'Original Name', phone: '111-1111' });
    expect(after.business.address).toBe('123 Main St, Alvin, TX 77511');
    expect(after.disclaimer).toBe('All sales final. 30-day warranty on refurbished devices.');
  });
});

describe('side-effect free', () => {
  it('generating a receipt writes no row and consumes no audit sequence', () => {
    const p = seedProduct(db);
    const result = sale().completeCashSale(
      buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]),
    );

    const counts = {
      sales: countRows(db, 'sales'),
      sale_items: countRows(db, 'sale_items'),
      payments: countRows(db, 'payments'),
      inventory_movements: countRows(db, 'inventory_movements'),
      google_sheet_export_jobs: countRows(db, 'google_sheet_export_jobs'),
      audit_events: countRows(db, 'audit_events'),
      checkout_requests: countRows(db, 'checkout_requests'),
      settings: countRows(db, 'settings'),
      counters_audit: auditCounter(db),
    };

    receiptFor(result.saleId);
    receiptFor(result.saleId);
    receiptFor(result.saleId);

    expect({
      sales: countRows(db, 'sales'),
      sale_items: countRows(db, 'sale_items'),
      payments: countRows(db, 'payments'),
      inventory_movements: countRows(db, 'inventory_movements'),
      google_sheet_export_jobs: countRows(db, 'google_sheet_export_jobs'),
      audit_events: countRows(db, 'audit_events'),
      checkout_requests: countRows(db, 'checkout_requests'),
      settings: countRows(db, 'settings'),
      counters_audit: auditCounter(db),
    }).toEqual(counts);
  });
});
