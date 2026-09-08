import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSaleService } from '../../src/main/checkout/saleService';
import { createCheckoutService } from '../../src/main/checkout/checkoutService';
import { createProductService } from '../../src/main/products/productService';
import { createSettingsService } from '../../src/main/settings/settingsService';
import { isAppError } from '../../src/main/shared/appError';
import { createMigratedDb } from '../helpers/database';
import {
  buildCashRequest,
  countRows,
  productQuantity,
  receiptCounter,
  seedBusiness,
  seedProduct,
  seedTaxRate,
  T0,
  T1,
} from '../helpers/checkout';

/**
 * Phase 2E — checkout idempotency, drift rejection, and receipt numbering
 * (`DATA_MODEL.md §31`-`§34`, `§41B`; `TEST_PLAN.md` TEST-IDEMP-001..006/008,
 * TEST-RECNO-001..004; `REQ-SALE-010`, `REQ-SALE-014`, `REQ-RECNO-*`).
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

describe('TEST-IDEMP-001/002/003 — a repeated request returns the same sale, never a new one', () => {
  it('the same requestId + fingerprint submitted twice yields one sale', () => {
    const p = seedProduct(db, { quantity: 5 });
    const req = buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }]);

    const first = sale().completeCashSale(req);
    const second = sale().completeCashSale(req);
    const third = sale().completeCashSale(req);

    expect(first.alreadyCompleted).toBe(false);
    expect(second).toEqual({ ...first, alreadyCompleted: true });
    expect(third.alreadyCompleted).toBe(true);
    expect(second.saleId).toBe(first.saleId);
    expect(second.receiptNumber).toBe(first.receiptNumber);

    expect(countRows(db, 'sales')).toBe(1);
    expect(countRows(db, 'sale_items')).toBe(1);
    expect(countRows(db, 'payments')).toBe(1);
    expect(countRows(db, 'google_sheet_export_jobs')).toBe(1);
    expect(
      db.prepare("SELECT COUNT(*) n FROM audit_events WHERE event_type = 'SALE_COMPLETED'").get(),
    ).toEqual({ n: 1 });
    expect(productQuantity(db, p.id)).toBe(4);
    expect(receiptCounter(db)).toBe(1);
  });
});

// TEST-IDEMP-004 (crash-after-commit replay) and TEST-RECNO-002 (restart
// persistence) run against a file-backed database in cash-checkout-offline.test.ts.

describe('TEST-IDEMP-005 — reused requestId with a different fingerprint is a conflict', () => {
  it('rejects the second submission and never creates a second sale or applies cart B', () => {
    const p = seedProduct(db, { sellingPriceCents: 59900, quantity: 9 });
    const cartA = buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    const first = sale().completeCashSale(cartA);

    const cartB = buildCashRequest(db, [{ productId: p.id, quantity: 3, soldPriceCents: 40000 }]);
    const collision = { ...cartB, requestId: cartA.requestId };

    try {
      sale().completeCashSale(collision);
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('IDEMPOTENCY_CONFLICT');
    }

    expect(countRows(db, 'sales')).toBe(1);
    const items = db.prepare('SELECT sold_price_cents, quantity FROM sale_items').all();
    expect(items).toEqual([{ sold_price_cents: 59900, quantity: 1 }]);
    expect(productQuantity(db, p.id)).toBe(8); // only cart A's 1 unit
    expect(first.receiptNumber).toBe('GP-000001');
  });
});

describe('TEST-IDEMP-006 — commit-time drift is rejected for re-review and recorded', () => {
  function requestRow(requestId: string) {
    return db
      .prepare('SELECT status, failure_code FROM checkout_requests WHERE request_id = ?')
      .get(requestId);
  }

  it('a fresh request whose reviewed fingerprint does not match current authoritative state → CHECKOUT_DRIFT, recorded as COMMIT_FAILED', () => {
    // Not a reused-id conflict (no prior row exists) — this is authoritative
    // drift: the claimed reviewed fingerprint disagrees with the trusted
    // recalculation, so Phase 2 rejects and the Phase 1 row records the outcome
    // (`DATA_MODEL.md §31`, `§33`, `§41B`).
    const p = seedProduct(db, { quantity: 5 });
    const req = buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    const tampered = { ...req, reviewedFingerprint: 'f'.repeat(64) };
    try {
      sale().completeCashSale(tampered);
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('CHECKOUT_DRIFT');
    }
    expect(countRows(db, 'sales')).toBe(0);
    expect(requestRow(req.requestId)).toEqual({
      status: 'COMMIT_FAILED',
      failure_code: 'CHECKOUT_DRIFT',
    });
  });

  it('a tax-rate change between review and Phase 2 → CHECKOUT_DRIFT; the request is COMMIT_FAILED, no sale', () => {
    const p = seedProduct(db, { sellingPriceCents: 59900, quantity: 5 });
    const req = buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }]);
    createSettingsService({ db, appVersion: 't', now: () => T1 }).updateTaxRate({
      taxRateBps: 900,
    });

    try {
      sale().completeCashSale(req);
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('CHECKOUT_DRIFT');
    }
    expect(countRows(db, 'sales')).toBe(0);
    expect(productQuantity(db, p.id)).toBe(5);
    // The Phase 1 row records the outcome — it is not left misleadingly SUBMITTED.
    expect(requestRow(req.requestId)).toEqual({
      status: 'COMMIT_FAILED',
      failure_code: 'CHECKOUT_DRIFT',
    });
  });

  it('a re-review after drift uses a NEW request id and completes; the drifted request stays COMMIT_FAILED', () => {
    const p = seedProduct(db, { sellingPriceCents: 59900, quantity: 5 });
    const drifted = buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }]);
    createSettingsService({ db, appVersion: 't', now: () => T1 }).updateTaxRate({
      taxRateBps: 900,
    });
    expect(() => sale().completeCashSale(drifted)).toThrow();

    // Fresh Review against current state → new request id + new fingerprint.
    const reviewed = buildCashRequest(db, [
      { productId: p.id, quantity: 1, soldPriceCents: 55000 },
    ]);
    expect(reviewed.requestId).not.toBe(drifted.requestId);
    expect(reviewed.reviewedFingerprint).not.toBe(drifted.reviewedFingerprint);

    const result = sale(() => T1).completeCashSale(reviewed);
    expect(result.alreadyCompleted).toBe(false);
    expect(countRows(db, 'sales')).toBe(1);
    expect(requestRow(drifted.requestId)).toEqual({
      status: 'COMMIT_FAILED',
      failure_code: 'CHECKOUT_DRIFT',
    });
    expect(requestRow(reviewed.requestId)).toEqual({ status: 'COMPLETED', failure_code: null });
  });

  it('a product archived before completion is rejected before any request row exists', () => {
    const p = seedProduct(db, { quantity: 5 });
    const req = buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    createProductService({ db, now: () => T1 }).archive(p.id);
    try {
      sale().completeCashSale(req);
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('PRODUCT_ARCHIVED');
    }
    expect(countRows(db, 'sales')).toBe(0);
    expect(countRows(db, 'checkout_requests')).toBe(0);
  });

  it('stock reduced below the cart quantity before completion is rejected before any request row exists', () => {
    const p = seedProduct(db, { quantity: 5 });
    const req = buildCashRequest(db, [{ productId: p.id, quantity: 3, soldPriceCents: 59900 }]);
    db.prepare('UPDATE products SET quantity_on_hand = 1 WHERE id = ?').run(p.id);
    try {
      sale().completeCashSale(req);
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('INSUFFICIENT_STOCK');
    }
    expect(countRows(db, 'sales')).toBe(0);
    expect(countRows(db, 'checkout_requests')).toBe(0);
    expect(productQuantity(db, p.id)).toBe(1);
  });

  // Once a durable request row exists, a condition that first appears at Phase 2
  // (drift, or a stock / archive race) rolls the sale back and records the
  // specific reason on that row. The retry path is the reachable proxy for
  // "state changed after Phase 1" without a production test hook.
  it('drift on a retry after a prior COMMIT_FAILED re-records the row as COMMIT_FAILED / CHECKOUT_DRIFT', () => {
    const p = seedProduct(db, { quantity: 5, sellingPriceCents: 59900 });
    const req = buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }]);
    db.exec('ALTER TABLE payments RENAME TO payments_x');
    try {
      expect(() => sale().completeCashSale(req)).toThrow();
    } finally {
      db.exec('ALTER TABLE payments_x RENAME TO payments');
    }
    expect(requestRow(req.requestId)).toEqual({
      status: 'COMMIT_FAILED',
      failure_code: 'SALE_COMMIT_FAILED',
    });

    createSettingsService({ db, appVersion: 't', now: () => T1 }).updateTaxRate({
      taxRateBps: 700,
    });
    try {
      sale(() => T1).completeCashSale(req);
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('CHECKOUT_DRIFT');
    }
    expect(countRows(db, 'sales')).toBe(0);
    expect(requestRow(req.requestId)).toEqual({
      status: 'COMMIT_FAILED',
      failure_code: 'CHECKOUT_DRIFT',
    });
  });

  it('a stock race on a retry records COMMIT_FAILED / INSUFFICIENT_STOCK', () => {
    const p = seedProduct(db, { quantity: 5, sellingPriceCents: 59900 });
    const req = buildCashRequest(db, [{ productId: p.id, quantity: 3, soldPriceCents: 55000 }]);
    db.exec('ALTER TABLE payments RENAME TO payments_x');
    try {
      expect(() => sale().completeCashSale(req)).toThrow();
    } finally {
      db.exec('ALTER TABLE payments_x RENAME TO payments');
    }
    db.prepare('UPDATE products SET quantity_on_hand = 1 WHERE id = ?').run(p.id);
    try {
      sale(() => T1).completeCashSale(req);
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('INSUFFICIENT_STOCK');
    }
    expect(countRows(db, 'sales')).toBe(0);
    expect(productQuantity(db, p.id)).toBe(1);
    expect(requestRow(req.requestId)).toEqual({
      status: 'COMMIT_FAILED',
      failure_code: 'INSUFFICIENT_STOCK',
    });
  });

  it('an archive race on a retry records COMMIT_FAILED / PRODUCT_ARCHIVED', () => {
    const p = seedProduct(db, { quantity: 5, sellingPriceCents: 59900 });
    const req = buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }]);
    db.exec('ALTER TABLE payments RENAME TO payments_x');
    try {
      expect(() => sale().completeCashSale(req)).toThrow();
    } finally {
      db.exec('ALTER TABLE payments_x RENAME TO payments');
    }
    createProductService({ db, now: () => T1 }).archive(p.id);
    try {
      sale(() => T1).completeCashSale(req);
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('PRODUCT_ARCHIVED');
    }
    expect(countRows(db, 'sales')).toBe(0);
    expect(requestRow(req.requestId)).toEqual({
      status: 'COMMIT_FAILED',
      failure_code: 'PRODUCT_ARCHIVED',
    });
  });
});

describe('TEST-IDEMP-008 — deterministic fingerprint ordering with duplicate product lines', () => {
  it('reversed input order → identical fingerprint → same request completes idempotently', () => {
    const a = seedProduct(db, { name: 'A', sellingPriceCents: 10000, quantity: 9 });
    const b = seedProduct(db, { name: 'B', sellingPriceCents: 20000, quantity: 9 });
    const svc = createCheckoutService({ db });

    const forward = svc.review({
      customerId: null,
      paymentMethod: 'CASH',
      lines: [
        { productId: a.id, quantity: 1, soldPriceCents: 10000 },
        { productId: a.id, quantity: 1, soldPriceCents: 9000 },
        { productId: b.id, quantity: 1, soldPriceCents: 20000 },
      ],
    });
    const reversed = svc.review({
      customerId: null,
      paymentMethod: 'CASH',
      lines: [
        { productId: b.id, quantity: 1, soldPriceCents: 20000 },
        { productId: a.id, quantity: 1, soldPriceCents: 9000 },
        { productId: a.id, quantity: 1, soldPriceCents: 10000 },
      ],
    });
    expect(forward.fingerprint).toBe(reversed.fingerprint);

    const requestId = randomUUID();
    const first = sale().completeCashSale({
      requestId,
      reviewedFingerprint: forward.fingerprint,
      checkout: {
        customerId: null,
        paymentMethod: 'CASH',
        lines: [
          { productId: a.id, quantity: 1, soldPriceCents: 10000 },
          { productId: a.id, quantity: 1, soldPriceCents: 9000 },
          { productId: b.id, quantity: 1, soldPriceCents: 20000 },
        ],
      },
    });
    // Retrying with the reversed order + same fingerprint + same id: idempotent.
    const replay = sale().completeCashSale({
      requestId,
      reviewedFingerprint: reversed.fingerprint,
      checkout: {
        customerId: null,
        paymentMethod: 'CASH',
        lines: [
          { productId: b.id, quantity: 1, soldPriceCents: 20000 },
          { productId: a.id, quantity: 1, soldPriceCents: 9000 },
          { productId: a.id, quantity: 1, soldPriceCents: 10000 },
        ],
      },
    });
    expect(replay.saleId).toBe(first.saleId);
    expect(replay.alreadyCompleted).toBe(true);

    expect(countRows(db, 'sale_items')).toBe(3); // two A lines stay distinct
    expect(productQuantity(db, a.id)).toBe(7); // 9 - (1 + 1)
    expect(productQuantity(db, b.id)).toBe(8);
  });
});

describe('TEST-RECNO-001..004 — receipt numbering', () => {
  it('TEST-RECNO-001 — consecutive sales get consecutive unique numbers', () => {
    const p = seedProduct(db, { quantity: 9 });
    const r1 = sale().completeCashSale(
      buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]),
    );
    const r2 = sale().completeCashSale(
      buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]),
    );
    const r3 = sale().completeCashSale(
      buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]),
    );
    expect([r1.receiptNumber, r2.receiptNumber, r3.receiptNumber]).toEqual([
      'GP-000001',
      'GP-000002',
      'GP-000003',
    ]);
  });

  it('TEST-RECNO-003 — a failed sale rolls the counter back; the next sale uses the next number', () => {
    const p = seedProduct(db, { quantity: 9 });
    sale().completeCashSale(
      buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]),
    ); // GP-000001

    const failing = buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    db.exec('ALTER TABLE payments RENAME TO payments_x');
    try {
      expect(() => sale().completeCashSale(failing)).toThrow();
    } finally {
      db.exec('ALTER TABLE payments_x RENAME TO payments');
    }
    expect(receiptCounter(db)).toBe(1);

    const next = sale().completeCashSale(
      buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]),
    );
    expect(next.receiptNumber).toBe('GP-000002');
  });

  it('TEST-RECNO-004 — the sales.receipt_number UNIQUE constraint rejects a duplicate', () => {
    const p = seedProduct(db);
    const r1 = sale().completeCashSale(
      buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]),
    );
    expect(() =>
      db
        .prepare(
          `INSERT INTO sales (id, receipt_number, business_name_snapshot, business_address_snapshot,
             business_phone_snapshot, receipt_disclaimer_snapshot, receipt_footer_snapshot, status,
             subtotal_cents, discount_cents, taxable_amount_cents, tax_rate_bps, tax_cents, total_cents,
             payment_method_snapshot, created_at, completed_at)
           VALUES ('dup', @rn, 'x','x','x','','', 'COMPLETED', 0,0,0,0,0,0,'CASH', @t, @t)`,
        )
        .run({ rn: r1.receiptNumber, t: T0 }),
    ).toThrow(/UNIQUE/i);
  });
});
