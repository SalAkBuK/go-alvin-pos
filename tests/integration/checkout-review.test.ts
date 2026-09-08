import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCheckoutService } from '../../src/main/checkout/checkoutService';
import { createCustomerService } from '../../src/main/customers/customerService';
import { createProductService } from '../../src/main/products/productService';
import { isAppError } from '../../src/main/shared/appError';
import type { CreateProductInput } from '../../src/shared/products';
import { createMigratedDb } from '../helpers/database';

/**
 * Trusted checkout-review integration tests against real SQLite
 * (`TEST_PLAN.md` TEST-CART-002..010, TEST-TAX-004, TEST-DISC-005 domain part;
 * task `§13`, `§19`). Proves the review reads authoritative state, cannot be
 * overridden by a manipulated payload, and writes nothing.
 */

const T = '2026-09-08T12:00:00.000Z';

function seedTaxRate(db: Database.Database, bps: number): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('tax_rate_bps', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(String(bps), T);
}

function product(db: Database.Database, overrides: Partial<CreateProductInput> = {}) {
  return createProductService({ db, now: () => T }).create({
    name: 'iPhone 15 128GB',
    brand: 'Apple',
    model: 'iPhone 15',
    condition: 'NEW',
    sellingPriceCents: 59900,
    quantity: 5,
    ...overrides,
  });
}

interface BusinessCounts {
  readonly sales: number;
  readonly sale_items: number;
  readonly payments: number;
  readonly inventory_movements: number;
  readonly checkout_requests: number;
  readonly google_sheet_export_jobs: number;
  readonly audit_events: number;
}

function businessSnapshotCounts(db: Database.Database): BusinessCounts {
  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  return {
    sales: count('SELECT COUNT(*) n FROM sales'),
    sale_items: count('SELECT COUNT(*) n FROM sale_items'),
    payments: count('SELECT COUNT(*) n FROM payments'),
    inventory_movements: count('SELECT COUNT(*) n FROM inventory_movements'),
    checkout_requests: count('SELECT COUNT(*) n FROM checkout_requests'),
    google_sheet_export_jobs: count('SELECT COUNT(*) n FROM google_sheet_export_jobs'),
    audit_events: count('SELECT COUNT(*) n FROM audit_events'),
  };
}

let db: Database.Database;

beforeEach(async () => {
  db = await createMigratedDb();
});
afterEach(() => {
  db.close();
});

describe('TEST-CART-002/003 — review a temporary cart', () => {
  it('computes canonical totals from authoritative state and returns a fingerprint', () => {
    seedTaxRate(db, 825);
    const p = product(db, { sellingPriceCents: 60000, quantity: 3 });
    const review = createCheckoutService({ db }).review({
      customerId: null,
      paymentMethod: 'CASH',
      lines: [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }],
    });
    expect(review.subtotalCents).toBe(60000);
    expect(review.discountCents).toBe(5000);
    expect(review.taxableAmountCents).toBe(55000);
    expect(review.taxRateBps).toBe(825);
    expect(review.taxCents).toBe(4538);
    expect(review.totalCents).toBe(59538);
    expect(review.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(review.lines[0]?.lineDiscountCents).toBe(5000);
  });

  it('writes no sale / payment / movement / checkout-request / export / audit row', () => {
    seedTaxRate(db, 825);
    const before = businessSnapshotCounts(db);
    const p = product(db);
    const stockBefore = p.quantityOnHand;
    createCheckoutService({ db }).review({
      customerId: null,
      paymentMethod: 'CARD',
      lines: [{ productId: p.id, quantity: 2, soldPriceCents: 40000 }],
    });
    const after = businessSnapshotCounts(db);
    // product() legitimately created one INITIAL_STOCK movement; the review added none.
    expect(after).toEqual({ ...before, inventory_movements: before.inventory_movements + 1 });
    const stockAfter = (
      db.prepare('SELECT quantity_on_hand n FROM products WHERE id = ?').get(p.id) as { n: number }
    ).n;
    expect(stockAfter).toBe(stockBefore);
  });
});

describe('TEST-TAX-004 — renderer cannot override authoritative values', () => {
  it('rejects a payload that tries to smuggle listed price / tax / total fields', () => {
    seedTaxRate(db, 825);
    const p = product(db, { sellingPriceCents: 55000, quantity: 2 });
    try {
      createCheckoutService({ db }).review({
        customerId: null,
        paymentMethod: 'CASH',
        lines: [{ productId: p.id, quantity: 1, soldPriceCents: 55000, listedPriceCents: 1 }],
        taxCents: 0,
        totalCents: 1,
      });
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('VALIDATION');
    }
  });

  it('uses the current product selling price as the listed price, not a submitted one', () => {
    seedTaxRate(db, 825);
    const p = product(db, { sellingPriceCents: 55000, quantity: 2 });
    const review = createCheckoutService({ db }).review({
      customerId: null,
      paymentMethod: 'CASH',
      lines: [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }],
    });
    expect(review.lines[0]?.listedPriceCents).toBe(55000);
    expect(review.taxableAmountCents).toBe(55000);
    expect(review.taxCents).toBe(4538);
    expect(review.totalCents).toBe(59538);
  });
});

describe('TEST-CART-005/006 — stock and duplicate-line aggregation', () => {
  it('rejects a single line above current stock', () => {
    seedTaxRate(db, 825);
    const p = product(db, { quantity: 2 });
    try {
      createCheckoutService({ db }).review({
        customerId: null,
        paymentMethod: 'CASH',
        lines: [{ productId: p.id, quantity: 3, soldPriceCents: 100 }],
      });
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('INSUFFICIENT_STOCK');
      expect(isAppError(error) && error.message).toMatch(/only 2/i);
    }
  });

  it('aggregates two distinct-price lines for the same product before the stock check', () => {
    seedTaxRate(db, 825);
    const p = product(db, { quantity: 2 });
    try {
      createCheckoutService({ db }).review({
        customerId: null,
        paymentMethod: 'CASH',
        lines: [
          { productId: p.id, quantity: 1, soldPriceCents: 59900 },
          { productId: p.id, quantity: 2, soldPriceCents: 55000 },
        ],
      });
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('INSUFFICIENT_STOCK');
    }
  });

  it('keeps the same product on two distinct lines when combined stock is available', () => {
    seedTaxRate(db, 825);
    const p = product(db, { sellingPriceCents: 59900, quantity: 5 });
    const review = createCheckoutService({ db }).review({
      customerId: null,
      paymentMethod: 'CASH',
      lines: [
        { productId: p.id, quantity: 1, soldPriceCents: 59900 },
        { productId: p.id, quantity: 2, soldPriceCents: 55000 },
      ],
    });
    expect(review.lines).toHaveLength(2);
    expect(review.lines.map((l) => l.soldPriceCents)).toEqual([55000, 59900]); // canonical order
    expect(review.taxableAmountCents).toBe(59900 + 55000 * 2);
  });
});

describe('TEST-CART-010 (domain) — negotiated price above listed', () => {
  it('accepts an above-list sold price and reports zero discount for that line', () => {
    seedTaxRate(db, 825);
    const p = product(db, { sellingPriceCents: 59900, quantity: 3 });
    const review = createCheckoutService({ db }).review({
      customerId: null,
      paymentMethod: 'CASH',
      lines: [{ productId: p.id, quantity: 1, soldPriceCents: 65000 }],
    });
    expect(review.lines[0]?.lineDiscountCents).toBe(0);
    expect(review.discountCents).toBe(0);
    expect(review.taxableAmountCents).toBe(65000);
  });
});

describe('missing / archived product', () => {
  it('rejects a line for a product that does not exist', () => {
    seedTaxRate(db, 825);
    try {
      createCheckoutService({ db }).review({
        customerId: null,
        paymentMethod: 'CASH',
        lines: [{ productId: 'missing', quantity: 1, soldPriceCents: 100 }],
      });
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('PRODUCT_NOT_FOUND');
    }
  });

  it('rejects a line for an archived product', () => {
    seedTaxRate(db, 825);
    const p = product(db);
    createProductService({ db, now: () => T }).archive(p.id);
    try {
      createCheckoutService({ db }).review({
        customerId: null,
        paymentMethod: 'CASH',
        lines: [{ productId: p.id, quantity: 1, soldPriceCents: 100 }],
      });
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('PRODUCT_ARCHIVED');
    }
  });
});

describe('optional customer attachment', () => {
  it('accepts no customer', () => {
    seedTaxRate(db, 825);
    const p = product(db);
    const review = createCheckoutService({ db }).review({
      customerId: null,
      paymentMethod: 'CASH',
      lines: [{ productId: p.id, quantity: 1, soldPriceCents: 100 }],
    });
    expect(review.customer).toBeNull();
    expect(review.customerId).toBeNull();
  });

  it('attaches an existing customer and includes it in the review + fingerprint', () => {
    seedTaxRate(db, 825);
    const p = product(db);
    const customer = createCustomerService({ db, now: () => T }).create({ name: 'Sam Buyer' });
    const svc = createCheckoutService({ db });
    const withCust = svc.review({
      customerId: customer.id,
      paymentMethod: 'CASH',
      lines: [{ productId: p.id, quantity: 1, soldPriceCents: 100 }],
    });
    const without = svc.review({
      customerId: null,
      paymentMethod: 'CASH',
      lines: [{ productId: p.id, quantity: 1, soldPriceCents: 100 }],
    });
    expect(withCust.customer?.name).toBe('Sam Buyer');
    expect(withCust.fingerprint).not.toBe(without.fingerprint);
  });

  it('rejects an unknown customer id', () => {
    seedTaxRate(db, 825);
    const p = product(db);
    try {
      createCheckoutService({ db }).review({
        customerId: 'nope',
        paymentMethod: 'CASH',
        lines: [{ productId: p.id, quantity: 1, soldPriceCents: 100 }],
      });
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('CUSTOMER_NOT_FOUND');
    }
  });
});

describe('tax-rate configuration', () => {
  it('returns a typed TAX_RATE_NOT_CONFIGURED error when no rate is seeded', () => {
    const p = product(db);
    try {
      createCheckoutService({ db }).review({
        customerId: null,
        paymentMethod: 'CASH',
        lines: [{ productId: p.id, quantity: 1, soldPriceCents: 100 }],
      });
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('TAX_RATE_NOT_CONFIGURED');
    }
  });

  it('reads the configured rate from trusted local settings', () => {
    seedTaxRate(db, 600);
    const p = product(db, { sellingPriceCents: 10000, quantity: 1 });
    const review = createCheckoutService({ db }).review({
      customerId: null,
      paymentMethod: 'CASH',
      lines: [{ productId: p.id, quantity: 1, soldPriceCents: 10000 }],
    });
    expect(review.taxRateBps).toBe(600);
    expect(review.taxCents).toBe(600); // floor((10000*600 + 5000)/10000) = 600
  });

  it('rejects a malformed configured rate', () => {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('tax_rate_bps', 'eight-percent', ?)`,
    ).run(T);
    const p = product(db);
    try {
      createCheckoutService({ db }).review({
        customerId: null,
        paymentMethod: 'CASH',
        lines: [{ productId: p.id, quantity: 1, soldPriceCents: 100 }],
      });
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('TAX_RATE_NOT_CONFIGURED');
    }
  });
});

describe('fingerprint determinism through the full review path', () => {
  it('same normalized review → same fingerprint; reordered lines → same fingerprint', () => {
    seedTaxRate(db, 825);
    const a = product(db, { name: 'A', sellingPriceCents: 10000, quantity: 9 });
    const b = product(db, { name: 'B', sellingPriceCents: 20000, quantity: 9 });
    const svc = createCheckoutService({ db });
    const forward = svc.review({
      customerId: null,
      paymentMethod: 'CASH',
      lines: [
        { productId: a.id, quantity: 1, soldPriceCents: 10000 },
        { productId: b.id, quantity: 2, soldPriceCents: 18000 },
      ],
    });
    const reversed = svc.review({
      customerId: null,
      paymentMethod: 'CASH',
      lines: [
        { productId: b.id, quantity: 2, soldPriceCents: 18000 },
        { productId: a.id, quantity: 1, soldPriceCents: 10000 },
      ],
    });
    expect(forward.fingerprint).toBe(reversed.fingerprint);

    const changed = svc.review({
      customerId: null,
      paymentMethod: 'CASH',
      lines: [
        { productId: a.id, quantity: 1, soldPriceCents: 10000 },
        { productId: b.id, quantity: 3, soldPriceCents: 18000 },
      ],
    });
    expect(changed.fingerprint).not.toBe(forward.fingerprint);
  });
});
