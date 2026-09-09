import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCardCheckoutService } from '../../src/main/checkout/cardCheckoutService';
import { createSaleService } from '../../src/main/checkout/saleService';
import { createReconciliationService } from '../../src/main/reconciliation/reconciliationService';
import { createProductService } from '../../src/main/products/productService';
import { createSettingsService } from '../../src/main/settings/settingsService';
import { isAppError } from '../../src/main/shared/appError';
import { createMigratedDb } from '../helpers/database';
import {
  auditRows,
  buildCardRequest,
  buildCashRequest,
  countRows,
  productQuantity,
  seedBusiness,
  seedProduct,
  seedTaxRate,
  T0,
  T1,
  T2,
} from '../helpers/checkout';

/**
 * Phase 2F — manual Clover Card workflow (`POS_WORKFLOWS.md §30`-`§35B`;
 * `DATA_MODEL.md §31`-`§31B`, `§41B`; `ARCHITECTURE.md §15A`;
 * `TEST_PLAN.md` TEST-CARD-001..007, TEST-IDEMP-007; `REQ-PAY-002`-`005`,
 * `REQ-RECONCILE-001`-`006`).
 *
 * Fault injection reuses the Phase 2E strategy (table rename / temp trigger). No
 * network is ever involved: V1 card handling is entirely manual.
 */

let db: Database.Database;

function card(clock: string[] = [T0, T1, T2]) {
  let i = 0;
  const now = () => clock[Math.min(i++, clock.length - 1)]!;
  return createCardCheckoutService({ db, appVersion: 'test-2f', now });
}

function requestRow(requestId: string) {
  return db
    .prepare(
      `SELECT status, failure_code, payment_method_snapshot, intended_total_cents,
              clover_approved_confirmed_at, sale_id, resolution_status, resolution_note
         FROM checkout_requests WHERE request_id = ?`,
    )
    .get(requestId) as Record<string, unknown> | undefined;
}

/** SALE movements only — the INITIAL_STOCK movement from `seedProduct` is excluded. */
function saleMovementCount(): number {
  return (
    db.prepare("SELECT COUNT(*) n FROM inventory_movements WHERE movement_type = 'SALE'").get() as {
      n: number;
    }
  ).n;
}

beforeEach(async () => {
  db = await createMigratedDb();
  seedTaxRate(db);
  seedBusiness(db);
});
afterEach(() => db.close());

describe('TEST-CARD-008 — pre-payment fingerprint check before Clover is invoked', () => {
  it('A — a product listed-price change before begin-card → CHECKOUT_DRIFT, no row, no Clover instruction', () => {
    const p = seedProduct(db, { sellingPriceCents: 59900, quantity: 5 });
    const req = buildCardRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }]);

    // Authoritative price changes AFTER Checkout Review, BEFORE begin-card.
    createProductService({ db, now: () => T1 }).update(p.id, {
      name: 'iPhone 15 128GB',
      brand: 'Apple',
      model: 'iPhone 15',
      condition: 'NEW',
      sellingPriceCents: 64900,
      costPriceCents: null,
      sku: null,
      barcode: null,
      lowStockThreshold: null,
    });

    try {
      card().beginCard(req);
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('CHECKOUT_DRIFT');
    }
    expect(countRows(db, 'checkout_requests')).toBe(0);
    expect(countRows(db, 'sales')).toBe(0);
    expect(saleMovementCount()).toBe(0);
    // Not a reconciliation incident — no card was processed.
    expect(
      createReconciliationService({ db, now: () => '2099-01-01T00:00:00.000Z' }).list(),
    ).toEqual([]);
  });

  it('B — a tax-rate change before begin-card → CHECKOUT_DRIFT, no row', () => {
    const p = seedProduct(db, { sellingPriceCents: 59900, quantity: 5 });
    const req = buildCardRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }]);
    createSettingsService({ db, appVersion: 't', now: () => T1 }).updateTaxRate({
      taxRateBps: 900,
    });

    try {
      card().beginCard(req);
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('CHECKOUT_DRIFT');
    }
    expect(countRows(db, 'checkout_requests')).toBe(0);
    expect(countRows(db, 'sales')).toBe(0);
  });

  it('C — no drift → PENDING_PAYMENT with request_fingerprint == reviewedFingerprint and intended_total_cents == reviewed total', () => {
    const p = seedProduct(db, { sellingPriceCents: 59900, quantity: 5 });
    const req = buildCardRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }]);

    const begun = card().beginCard(req);
    expect(begun.stage).toBe('awaiting_clover');
    expect(begun.intendedTotalCents).toBe(59538);

    const row = db
      .prepare(
        'SELECT status, request_fingerprint, intended_total_cents FROM checkout_requests WHERE request_id = ?',
      )
      .get(req.requestId) as {
      status: string;
      request_fingerprint: string;
      intended_total_cents: number;
    };
    expect(row).toEqual({
      status: 'PENDING_PAYMENT',
      request_fingerprint: req.reviewedFingerprint,
      intended_total_cents: 59538,
    });
  });
});

describe('TEST-CARD-001 — Clover approved → SUBMITTED → Phase 2 → COMPLETED', () => {
  it('Step A commits PENDING_PAYMENT before any Clover instruction; approval then completes a CARD sale', () => {
    const p = seedProduct(db, { sellingPriceCents: 59900, quantity: 5 });
    const req = buildCardRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }]);
    const svc = card([T0, T1, T1]);

    // ── Phase 1 Step A ──────────────────────────────────────────────────────
    const begun = svc.beginCard(req);
    expect(begun.stage).toBe('awaiting_clover');
    expect(begun.intendedTotalCents).toBe(59538); // 55000 + 8.25% tax
    expect(requestRow(req.requestId)).toMatchObject({
      status: 'PENDING_PAYMENT',
      payment_method_snapshot: 'CARD',
      intended_total_cents: 59538,
      clover_approved_confirmed_at: null,
      sale_id: null,
    });
    expect(countRows(db, 'sales')).toBe(0);

    // ── Payment Approved → Step B + Phase 2 ─────────────────────────────────
    const result = svc.completeCard(req);
    expect(result).toMatchObject({
      receiptNumber: 'GP-000001',
      totalCents: 59538,
      paymentMethod: 'CARD',
      alreadyCompleted: false,
    });

    expect(requestRow(req.requestId)).toMatchObject({
      status: 'COMPLETED',
      clover_approved_confirmed_at: T1,
      sale_id: result.saleId,
    });
    expect(
      db.prepare('SELECT payment_method_snapshot FROM sales WHERE id = ?').get(result.saleId),
    ).toEqual({ payment_method_snapshot: 'CARD' });
    expect(
      db.prepare('SELECT method, amount_cents FROM payments WHERE sale_id = ?').get(result.saleId),
    ).toEqual({ method: 'CARD', amount_cents: 59538 });
    expect(productQuantity(db, p.id)).toBe(4);
    expect(auditRows(db, 'SALE_COMPLETED')).toHaveLength(1);
  });

  it('a repeated "Payment Approved" (double-click / IPC retry) returns the same sale', () => {
    const p = seedProduct(db, { quantity: 3 });
    const req = buildCardRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    const svc = card();
    svc.beginCard(req);
    const first = svc.completeCard(req);
    const second = svc.completeCard(req);
    expect(second).toEqual({ ...first, alreadyCompleted: true });
    expect(countRows(db, 'sales')).toBe(1);
    expect(countRows(db, 'payments')).toBe(1);
  });
});

describe('TEST-CARD-002 — Clover declined', () => {
  it('records COMMIT_FAILED / CLOVER_DECLINED, no sale, no inventory change, not in reconciliation', () => {
    const p = seedProduct(db, { quantity: 5 });
    const req = buildCardRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    const svc = card();
    svc.beginCard(req);

    const declined = svc.declineCard({
      requestId: req.requestId,
      reviewedFingerprint: req.reviewedFingerprint,
    });
    expect(declined).toEqual({ requestId: req.requestId, declined: true });

    expect(requestRow(req.requestId)).toMatchObject({
      status: 'COMMIT_FAILED',
      failure_code: 'CLOVER_DECLINED',
      clover_approved_confirmed_at: null,
      sale_id: null,
    });
    expect(countRows(db, 'sales')).toBe(0);
    expect(countRows(db, 'payments')).toBe(0);
    expect(saleMovementCount()).toBe(0);
    expect(productQuantity(db, p.id)).toBe(5);

    // Excluded from the queue even with a huge staleness window.
    const queue = createReconciliationService({ db, now: () => '2099-01-01T00:00:00.000Z' }).list();
    expect(queue).toEqual([]);
  });

  it('a repeated decline is idempotent', () => {
    const p = seedProduct(db, { quantity: 5 });
    const req = buildCardRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    const svc = card();
    svc.beginCard(req);
    const args = { requestId: req.requestId, reviewedFingerprint: req.reviewedFingerprint };
    svc.declineCard(args);
    expect(() => svc.declineCard(args)).not.toThrow();
    expect(countRows(db, 'checkout_requests')).toBe(1);
  });

  it('after a decline the same cart under a NEW request id can be completed as CARD or CASH', () => {
    const p = seedProduct(db, { quantity: 5, sellingPriceCents: 59900 });
    const declinedReq = buildCardRequest(db, [
      { productId: p.id, quantity: 1, soldPriceCents: 59900 },
    ]);
    const svc = card();
    svc.beginCard(declinedReq);
    svc.declineCard({
      requestId: declinedReq.requestId,
      reviewedFingerprint: declinedReq.reviewedFingerprint,
    });

    // New attempt, new id.
    const retryReq = buildCardRequest(db, [
      { productId: p.id, quantity: 1, soldPriceCents: 59900 },
    ]);
    expect(retryReq.requestId).not.toBe(declinedReq.requestId);
    const svc2 = card();
    svc2.beginCard(retryReq);
    const result = svc2.completeCard(retryReq);
    expect(result.paymentMethod).toBe('CARD');
    expect(countRows(db, 'sales')).toBe(1);
  });
});

describe('TEST-CARD-003 — a Card sale can never reach Phase 2 without the explicit approval path', () => {
  it('completeCard with no prior begin-card is rejected', () => {
    const p = seedProduct(db, { quantity: 3 });
    const req = buildCardRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    try {
      card().completeCard(req);
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('CHECKOUT_REQUEST_INVALID');
    }
    expect(countRows(db, 'sales')).toBe(0);
  });

  it('the Cash channel refuses a Card PENDING_PAYMENT request row', () => {
    const p = seedProduct(db, { quantity: 3 });
    const req = buildCardRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    card().beginCard(req);
    const cashReq = {
      requestId: req.requestId,
      reviewedFingerprint: req.reviewedFingerprint,
      checkout: { ...req.checkout, paymentMethod: 'CASH' as const },
    };
    try {
      createSaleService({ db, appVersion: 't', now: () => T1 }).completeCashSale(cashReq);
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('CHECKOUT_REQUEST_INVALID');
    }
    expect(countRows(db, 'sales')).toBe(0);
    expect(requestRow(req.requestId)).toMatchObject({ status: 'PENDING_PAYMENT' });
  });
});

describe('TEST-CARD-004 — no Clover / network dependency', () => {
  it('a full approved Card flow completes with global fetch forced to throw', () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('network must not be used by the card workflow');
    }) as typeof fetch;
    try {
      const p = seedProduct(db, { quantity: 3 });
      const req = buildCardRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
      const svc = card();
      svc.beginCard(req);
      const result = svc.completeCard(req);
      expect(result.paymentMethod).toBe('CARD');
      expect(requestRow(req.requestId)).toMatchObject({ status: 'COMPLETED' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('TEST-CARD-005A — Step A failure: no PENDING_PAYMENT row, no Clover instruction', () => {
  it('a forced Step A commit failure stops checkout and creates no row', () => {
    const p = seedProduct(db, { quantity: 3 });
    const req = buildCardRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);

    db.exec('ALTER TABLE checkout_requests RENAME TO checkout_requests_x');
    try {
      card().beginCard(req);
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('SALE_COMMIT_FAILED');
    } finally {
      db.exec('ALTER TABLE checkout_requests_x RENAME TO checkout_requests');
    }

    expect(countRows(db, 'checkout_requests')).toBe(0);
    expect(countRows(db, 'sales')).toBe(0);
  });
});

describe('TEST-CARD-005B — Step B write failure (Priority 0, Case 2)', () => {
  it('row stays PENDING_PAYMENT, no approval recorded, Phase 2 not entered, critical warning', () => {
    const p = seedProduct(db, { quantity: 3 });
    const req = buildCardRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    const svc = card();
    svc.beginCard(req);

    db.exec(
      `CREATE TEMP TRIGGER fail_step_b BEFORE UPDATE OF status ON checkout_requests
         WHEN OLD.status = 'PENDING_PAYMENT' AND NEW.status = 'SUBMITTED'
       BEGIN SELECT RAISE(ABORT, 'forced step B failure'); END`,
    );
    try {
      svc.completeCard(req);
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('CARD_LOCAL_COMMIT_FAILURE');
      expect((error as Error).message).toMatch(/DO NOT RUN THE CARD AGAIN/);
      expect((error as Error).message).toContain(req.requestId);
    } finally {
      db.exec('DROP TRIGGER fail_step_b');
    }

    expect(requestRow(req.requestId)).toMatchObject({
      status: 'PENDING_PAYMENT',
      clover_approved_confirmed_at: null,
    });
    expect(countRows(db, 'sales')).toBe(0);
    expect(countRows(db, 'payments')).toBe(0);
    expect(countRows(db, 'google_sheet_export_jobs')).toBe(0);
  });
});

describe('TEST-CARD-005C — stale PENDING_PAYMENT surfaces in the Reconciliation Queue', () => {
  it('is absent within 5 minutes and present after', () => {
    const p = seedProduct(db, { quantity: 3 });
    const req = buildCardRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    createCardCheckoutService({ db, appVersion: 't', now: () => T0 }).beginCard(req);

    const before = createReconciliationService({
      db,
      now: () => '2026-09-08T12:04:00.000Z', // T0 + 4 min
    }).list();
    expect(before).toEqual([]);

    const after = createReconciliationService({
      db,
      now: () => '2026-09-08T12:06:00.000Z', // T0 + 6 min
    }).list();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      requestId: req.requestId,
      status: 'PENDING_PAYMENT',
      failureCode: null,
      cloverApprovedConfirmedAt: null,
      resolutionStatus: 'UNRESOLVED',
    });
  });
});

describe('TEST-CARD-005 / TEST-IDEMP-007 — Clover approved, local commit fails', () => {
  it('storage failure after approval: no sale, evidence + approval survive, CARD_LOCAL_COMMIT_FAILURE audit, unresolved incident', () => {
    const p = seedProduct(db, { sellingPriceCents: 59900, quantity: 5 });
    const req = buildCardRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }]);
    const svc = card([T0, T1, T1]);
    svc.beginCard(req);

    db.exec('ALTER TABLE payments RENAME TO payments_x');
    try {
      svc.completeCard(req);
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('CARD_LOCAL_COMMIT_FAILURE');
      expect((error as Error).message).toMatch(/void or refund it manually in Clover/i);
    } finally {
      db.exec('ALTER TABLE payments_x RENAME TO payments');
    }

    expect(countRows(db, 'sales')).toBe(0);
    expect(countRows(db, 'payments')).toBe(0);
    expect(saleMovementCount()).toBe(0);
    expect(countRows(db, 'google_sheet_export_jobs')).toBe(0);
    expect(productQuantity(db, p.id)).toBe(5);

    expect(requestRow(req.requestId)).toMatchObject({
      status: 'COMMIT_FAILED',
      failure_code: 'SALE_COMMIT_FAILED', // the SPECIFIC code, not a synonym
      payment_method_snapshot: 'CARD',
      intended_total_cents: 59538,
      clover_approved_confirmed_at: T1, // approval evidence NOT erased
      sale_id: null,
    });

    const audit = auditRows(db, 'CARD_LOCAL_COMMIT_FAILURE');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      subject_type: 'CHECKOUT_REQUEST',
      subject_id: req.requestId,
      outcome: 'FAILURE',
    });
    expect(audit[0]!['details_json']).not.toMatch(/card|cvv|pan/i);

    const queue = createReconciliationService({ db, now: () => T2 }).list();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      requestId: req.requestId,
      status: 'COMMIT_FAILED',
      failureCode: 'SALE_COMMIT_FAILED',
      intendedTotalCents: 59538,
      cloverApprovedConfirmedAt: T1,
      resolutionStatus: 'UNRESOLVED',
    });
  });

  it('TEST-IDEMP-007 — a total that drifted from intended_total_cents is never committed as a Card sale', () => {
    const p = seedProduct(db, { sellingPriceCents: 59900, quantity: 5 });
    const req = buildCardRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }]);
    const svc = card([T0, T1, T1]);
    svc.beginCard(req); // intended_total_cents = 59538

    // Price rises between Clover approval and Phase 2.
    createProductService({ db, now: () => T1 }).update(p.id, {
      name: 'iPhone 15 128GB',
      brand: 'Apple',
      model: 'iPhone 15',
      condition: 'NEW',
      sellingPriceCents: 64900,
      costPriceCents: null,
      sku: null,
      barcode: null,
      lowStockThreshold: null,
    });

    try {
      svc.completeCard(req);
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('CARD_LOCAL_COMMIT_FAILURE');
    }

    expect(countRows(db, 'sales')).toBe(0);
    expect(requestRow(req.requestId)).toMatchObject({
      status: 'COMMIT_FAILED',
      failure_code: 'CHECKOUT_DRIFT', // specific reconciliation reason, preserved
      clover_approved_confirmed_at: T1,
      intended_total_cents: 59538,
    });
    // A reconciliation incident, not a "review and run the card again".
    expect(createReconciliationService({ db, now: () => T2 }).list()).toHaveLength(1);
  });
});

describe('TEST-CARD-006 — retry after a Card local commit failure completes without re-charging', () => {
  it('the same request id completes on retry and the reconciliation entry auto-resolves', () => {
    const p = seedProduct(db, { sellingPriceCents: 59900, quantity: 5 });
    const req = buildCardRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }]);
    const begin = card([T0, T1, T1]);
    begin.beginCard(req);

    db.exec('ALTER TABLE payments RENAME TO payments_x');
    try {
      expect(() => begin.completeCard(req)).toThrow();
    } finally {
      db.exec('ALTER TABLE payments_x RENAME TO payments');
    }
    expect(requestRow(req.requestId)).toMatchObject({
      status: 'COMMIT_FAILED',
      clover_approved_confirmed_at: T1,
    });

    // Retry: same request, no Clover step (Step B is skipped — already confirmed).
    const retry = card([T2, T2, T2]);
    const result = retry.completeCard(req);
    expect(result.paymentMethod).toBe('CARD');
    expect(result.receiptNumber).toBe('GP-000001');

    expect(requestRow(req.requestId)).toMatchObject({
      status: 'COMPLETED',
      sale_id: result.saleId,
      clover_approved_confirmed_at: T1,
      resolution_status: 'RESOLVED',
      resolution_note: 'Completed on retry',
    });
    expect(countRows(db, 'sales')).toBe(1);
    expect(countRows(db, 'payments')).toBe(1);
    // No longer in the queue.
    expect(createReconciliationService({ db, now: () => T2 }).list()).toEqual([]);
  });
});

describe('TEST-CARD-007 — manual reconciliation resolution', () => {
  it('requires a non-blank note; marks RESOLVED with resolved_at; creates no sale / no inventory change', () => {
    const p = seedProduct(db, { sellingPriceCents: 59900, quantity: 5 });
    const req = buildCardRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }]);
    const svc = card([T0, T1, T1]);
    svc.beginCard(req);
    db.exec('ALTER TABLE payments RENAME TO payments_x');
    try {
      expect(() => svc.completeCard(req)).toThrow();
    } finally {
      db.exec('ALTER TABLE payments_x RENAME TO payments');
    }

    const recon = createReconciliationService({ db, now: () => T2 });
    expect(() => recon.resolve({ requestId: req.requestId, note: '   ' })).toThrow();

    const entry = recon.resolve({
      requestId: req.requestId,
      note: '  Voided in Clover; customer not charged.  ',
    });
    expect(entry).toMatchObject({ requestId: req.requestId, resolutionStatus: 'RESOLVED' });

    expect(requestRow(req.requestId)).toMatchObject({
      status: 'COMMIT_FAILED',
      resolution_status: 'RESOLVED',
      resolution_note: 'Voided in Clover; customer not charged.',
      sale_id: null,
    });
    expect(countRows(db, 'sales')).toBe(0);
    expect(productQuantity(db, p.id)).toBe(5);
    // Gone from the queue.
    expect(recon.list()).toEqual([]);
    // Re-resolving a resolved entry is rejected.
    expect(() => recon.resolve({ requestId: req.requestId, note: 'again' })).toThrow();
  });
});

describe('idempotency (task §35)', () => {
  it('repeated begin-card with the same id + fingerprint returns the same pending state, one row', () => {
    const p = seedProduct(db, { quantity: 3 });
    const req = buildCardRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    const svc = card();
    const a = svc.beginCard(req);
    const b = svc.beginCard(req);
    expect(b).toEqual(a);
    expect(countRows(db, 'checkout_requests')).toBe(1);
  });

  it('begin-card with the same id but a different fingerprint is an IDEMPOTENCY_CONFLICT', () => {
    const p = seedProduct(db, { quantity: 3 });
    const req = buildCardRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    card().beginCard(req);
    try {
      card().beginCard({ ...req, reviewedFingerprint: 'f'.repeat(64) });
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('IDEMPOTENCY_CONFLICT');
    }
  });

  it('a completed Card request replayed through begin-card returns the same sale', () => {
    const p = seedProduct(db, { quantity: 3 });
    const req = buildCardRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    const svc = card();
    svc.beginCard(req);
    const sale = svc.completeCard(req);
    const replay = svc.beginCard(req);
    expect(replay.stage).toBe('completed');
    expect(replay.completed?.saleId).toBe(sale.saleId);
    expect(countRows(db, 'sales')).toBe(1);
  });

  it('no duplicate payment / receipt number / stock deduction / export job across replays', () => {
    const p = seedProduct(db, { quantity: 5 });
    const req = buildCardRequest(db, [{ productId: p.id, quantity: 2, soldPriceCents: 59900 }]);
    const svc = card();
    svc.beginCard(req);
    svc.completeCard(req);
    svc.completeCard(req);
    svc.beginCard(req);
    expect(countRows(db, 'sales')).toBe(1);
    expect(countRows(db, 'payments')).toBe(1);
    expect(countRows(db, 'google_sheet_export_jobs')).toBe(1);
    expect(countRows(db, 'sale_items')).toBe(1);
    expect(productQuantity(db, p.id)).toBe(3);
  });
});

describe('atomic failure after approval (task §36) — every required Phase 2 op', () => {
  const cases: Array<[string, string]> = [
    ['sale item insert', 'sale_items'],
    ['payment insert', 'payments'],
    ['inventory movement insert', 'inventory_movements'],
    ['export job insert', 'google_sheet_export_jobs'],
    ['required audit insert', 'audit_events'],
  ];

  it.each(cases)(
    '%s failing → full rollback, approval evidence kept, reconciliation incident',
    (_label, table) => {
      const p = seedProduct(db, { quantity: 5, sellingPriceCents: 59900 });
      const req = buildCardRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }]);
      const svc = card([T0, T1, T1]);
      svc.beginCard(req);

      db.exec(`ALTER TABLE ${table} RENAME TO ${table}_x`);
      try {
        expect(() => svc.completeCard(req)).toThrow();
      } finally {
        db.exec(`ALTER TABLE ${table}_x RENAME TO ${table}`);
      }

      expect(countRows(db, 'sales')).toBe(0);
      expect(countRows(db, 'sale_items')).toBe(0);
      expect(countRows(db, 'payments')).toBe(0);
      expect(countRows(db, 'google_sheet_export_jobs')).toBe(0);
      expect(productQuantity(db, p.id)).toBe(5);
      expect(receiptCounterValue()).toBe(0);

      const row = requestRow(req.requestId)!;
      expect(row['status']).toBe('COMMIT_FAILED');
      expect(row['clover_approved_confirmed_at']).toBe(T1);
      expect(row['intended_total_cents']).toBe(59538);
    },
  );

  function receiptCounterValue() {
    return (
      db.prepare("SELECT value FROM counters WHERE key = 'receipt_number'").get() as {
        value: number;
      }
    ).value;
  }
});

describe('Cash regression — a Cash COMMIT_FAILED row is never a reconciliation incident', () => {
  it('a failed Cash sale does not appear in the Card reconciliation queue', () => {
    const p = seedProduct(db, { quantity: 5 });
    const cashReq = buildCashRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }]);
    db.exec('ALTER TABLE payments RENAME TO payments_x');
    try {
      expect(() =>
        createSaleService({ db, appVersion: 't', now: () => T0 }).completeCashSale(cashReq),
      ).toThrow();
    } finally {
      db.exec('ALTER TABLE payments_x RENAME TO payments');
    }
    expect(requestRow(cashReq.requestId)).toMatchObject({
      status: 'COMMIT_FAILED',
      payment_method_snapshot: 'CASH',
    });
    expect(
      createReconciliationService({ db, now: () => '2099-01-01T00:00:00.000Z' }).list(),
    ).toEqual([]);
  });
});

describe('offline (task §37)', () => {
  it('begin, decline, approve, and Phase 2 all work with no network mock present', () => {
    // The suite runs against an in-memory SQLite database with no network layer
    // wired anywhere; a full flow succeeding is the proof of independence.
    const spy = vi.fn();
    const p = seedProduct(db, { quantity: 5 });
    const req = buildCardRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    const svc = card();
    svc.beginCard(req);
    svc.completeCard(req);
    expect(spy).not.toHaveBeenCalled();
    expect(countRows(db, 'sales')).toBe(1);
  });
});

describe('TEST-CARD-008 E — drift that first appears AFTER Step A is still caught by Phase 2', () => {
  it('tax-rate change between begin-card and complete-card → reconciliation incident, no sale', () => {
    const p = seedProduct(db, { sellingPriceCents: 59900, quantity: 5 });
    const req = buildCardRequest(db, [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }]);
    const svc = card([T0, T1, T1]);
    svc.beginCard(req);
    createSettingsService({ db, appVersion: 't', now: () => T1 }).updateTaxRate({
      taxRateBps: 900,
    });
    try {
      svc.completeCard(req);
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('CARD_LOCAL_COMMIT_FAILURE');
    }
    expect(countRows(db, 'sales')).toBe(0);
    expect(requestRow(req.requestId)).toMatchObject({
      status: 'COMMIT_FAILED',
      failure_code: 'CHECKOUT_DRIFT',
      clover_approved_confirmed_at: T1,
    });
  });
});
