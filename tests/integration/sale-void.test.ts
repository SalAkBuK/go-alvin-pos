import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCardCheckoutService } from '../../src/main/checkout/cardCheckoutService';
import { createReceiptService } from '../../src/main/checkout/receiptService';
import { createSaleService } from '../../src/main/checkout/saleService';
import { createInventoryService } from '../../src/main/inventory/inventoryService';
import { createCustomerService } from '../../src/main/customers/customerService';
import { createSalesHistoryService } from '../../src/main/salesHistory/salesHistoryService';
import { createVoidService } from '../../src/main/void/voidService';
import { isAppError } from '../../src/main/shared/appError';
import { createMigratedDb } from '../helpers/database';
import {
  auditCounter,
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
} from '../helpers/checkout';

/**
 * Phase 2H — the one-time completed-sale void (`REQ-VOID-001`-`REQ-VOID-008`;
 * `POS_WORKFLOWS.md §88`-`§91`; `ARCHITECTURE.md §42.1`; `DATA_MODEL.md §12`,
 * `§18`, `§23`, `§63`; `TEST_PLAN.md` TEST-VOID-001..010). Every fixture is a
 * genuine sale written through the real checkout services.
 */

let db: Database.Database;

const VOID_AT = T1;
function voidSvc(now: () => string = () => VOID_AT) {
  return createVoidService({ db, appVersion: 'test-2h', now });
}
function cashSale(
  lines: Array<{ productId: string; quantity: number; soldPriceCents: number }>,
  opts: { customerId?: string } = {},
) {
  return createSaleService({ db, appVersion: 't', now: () => T0 }).completeCashSale(
    buildCashRequest(db, lines, opts),
  );
}
function cardSale(lines: Array<{ productId: string; quantity: number; soldPriceCents: number }>) {
  const req = buildCardRequest(db, lines);
  const svc = createCardCheckoutService({ db, appVersion: 't', now: () => T0 });
  svc.beginCard(req);
  return svc.completeCard(req);
}
function saleRow(id: string) {
  return db.prepare('SELECT * FROM sales WHERE id = ?').get(id) as Record<string, unknown>;
}
function exportJob(saleId: string) {
  return db
    .prepare('SELECT * FROM google_sheet_export_jobs WHERE sale_id = ?')
    .get(saleId) as Record<string, unknown>;
}
function movements(saleId: string, type: string) {
  return db
    .prepare(
      'SELECT * FROM inventory_movements WHERE sale_id = ? AND movement_type = ? ORDER BY id',
    )
    .all(saleId, type) as Array<Record<string, unknown>>;
}
function setJob(saleId: string, patch: Record<string, unknown>): void {
  const keys = Object.keys(patch);
  db.prepare(
    `UPDATE google_sheet_export_jobs SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE sale_id = @saleId`,
  ).run({ ...patch, saleId });
}

beforeEach(async () => {
  db = await createMigratedDb();
  seedTaxRate(db);
  seedBusiness(db);
});
afterEach(() => db.close());

describe('TEST-VOID-001 / TEST-VOID-009 — successful Cash void', () => {
  it('COMPLETED → VOIDED with reversal, audit, advanced export job — everything else untouched', () => {
    const p = seedProduct(db, { sellingPriceCents: 59900, quantity: 5 });
    const sale = cashSale([{ productId: p.id, quantity: 2, soldPriceCents: 55000 }]);
    expect(productQuantity(db, p.id)).toBe(3);

    const original = movements(sale.saleId, 'SALE');
    const paymentBefore = db
      .prepare('SELECT * FROM payments WHERE sale_id = ?')
      .get(sale.saleId) as Record<string, unknown>;
    const itemsBefore = db
      .prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id')
      .all(sale.saleId);

    const result = voidSvc().voidSale({ saleId: sale.saleId, reason: 'Rang up in error' });
    expect(result).toEqual({ saleId: sale.saleId });

    const row = saleRow(sale.saleId);
    expect(row).toMatchObject({
      status: 'VOIDED',
      voided_at: VOID_AT,
      void_reason: 'Rang up in error',
      sync_version: 2,
    });
    // Immutable transaction fields untouched.
    expect(row['completed_at']).toBe(T0);
    expect(row['receipt_number']).toBe(sale.receiptNumber);
    expect(row['total_cents']).toBe(sale.totalCents);

    // Inventory restored exactly once, against current stock.
    expect(productQuantity(db, p.id)).toBe(5);
    const reversals = movements(sale.saleId, 'VOID_REVERSAL');
    expect(reversals).toHaveLength(1);
    expect(reversals[0]).toMatchObject({
      product_id: p.id,
      reverses_movement_id: original[0]!['id'],
      quantity_change: 2,
      quantity_before: 3,
      quantity_after: 5,
      reason: null,
    });
    // Original SALE movement is unchanged.
    expect(movements(sale.saleId, 'SALE')).toEqual(original);

    // Payment + items unchanged.
    expect(db.prepare('SELECT * FROM payments WHERE sale_id = ?').get(sale.saleId)).toEqual(
      paymentBefore,
    );
    expect(
      db.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id').all(sale.saleId),
    ).toEqual(itemsBefore);

    // Durable SALE_VOIDED audit, one row, linked to the sale + reason.
    const audit = auditRows(db, 'SALE_VOIDED');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      subject_type: 'SALE',
      subject_id: sale.saleId,
      reason: 'Rang up in error',
      outcome: 'SUCCESS',
      actor_type: 'USER',
    });
    const details = JSON.parse(audit[0]!['details_json'] as string) as Record<string, unknown>;
    expect(details).toMatchObject({ newSyncVersion: 2, reversalMovementCount: 1 });
    expect(JSON.stringify(details)).not.toMatch(/phone|customer_name/i);

    // Exactly one export job, advanced to the new revision and PENDING.
    expect(countRows(db, 'google_sheet_export_jobs')).toBe(1);
    expect(exportJob(sale.saleId)).toMatchObject({
      status: 'PENDING',
      target_sync_version: 2,
      exported_sync_version: null,
      attempt_count: 0,
      last_error: null,
    });

    // Still visible in Sales History as VOIDED.
    const detail = createSalesHistoryService({ db }).getById(sale.saleId);
    expect(detail).toMatchObject({
      status: 'VOIDED',
      voidedAt: VOID_AT,
      voidReason: 'Rang up in error',
      completedAt: T0,
    });
  });
});

describe('TEST-VOID-003 — inventory restoration and reversing movement', () => {
  it('sell two units then void → inventory returns by exactly two, links to the original', () => {
    const p = seedProduct(db, { quantity: 9 });
    const sale = cashSale([{ productId: p.id, quantity: 2, soldPriceCents: 50000 }]);
    expect(productQuantity(db, p.id)).toBe(7);
    voidSvc().voidSale({ saleId: sale.saleId, reason: 'wrong device' });
    expect(productQuantity(db, p.id)).toBe(9);
    const [reversal] = movements(sale.saleId, 'VOID_REVERSAL');
    const [saleMove] = movements(sale.saleId, 'SALE');
    expect(reversal).toMatchObject({ quantity_change: 2, reverses_movement_id: saleMove!['id'] });
  });

  it('a multi-product sale creates one reversal per original SALE movement', () => {
    const a = seedProduct(db, { name: 'A', quantity: 6 });
    const b = seedProduct(db, { name: 'B', quantity: 6 });
    const sale = cashSale([
      { productId: a.id, quantity: 1, soldPriceCents: 50000 },
      { productId: b.id, quantity: 3, soldPriceCents: 50000 },
    ]);
    voidSvc().voidSale({ saleId: sale.saleId, reason: 'customer changed mind' });
    const reversals = movements(sale.saleId, 'VOID_REVERSAL');
    expect(reversals).toHaveLength(2);
    expect(reversals.map((r) => r['quantity_change']).sort()).toEqual([1, 3]);
    expect(productQuantity(db, a.id)).toBe(6);
    expect(productQuantity(db, b.id)).toBe(6);
  });
});

describe('later inventory activity — restoration is against CURRENT stock (task §5, §16)', () => {
  it('a manual adjustment after the sale is preserved; the reversal adds the sold quantity to current stock', () => {
    const p = seedProduct(db, { quantity: 10 });
    const sale = cashSale([{ productId: p.id, quantity: 2, soldPriceCents: 50000 }]);
    expect(productQuantity(db, p.id)).toBe(8);

    // Legitimate later activity: +3 recount.
    createInventoryService({ db, appVersion: 't', now: () => '2026-09-08T14:00:00.000Z' }).adjust({
      productId: p.id,
      reason: 'physical recount',
      mode: 'delta',
      delta: 3,
    });
    expect(productQuantity(db, p.id)).toBe(11);

    voidSvc().voidSale({ saleId: sale.saleId, reason: 'returned to stock' });

    // 11 + 2, NOT reset to the pre-sale 10 or the post-sale 8.
    expect(productQuantity(db, p.id)).toBe(13);
    const [reversal] = movements(sale.saleId, 'VOID_REVERSAL');
    expect(reversal).toMatchObject({ quantity_before: 11, quantity_after: 13, quantity_change: 2 });
  });
});

describe('TEST-VOID-002 — original transaction retained / historical immutability', () => {
  it('void changes only lifecycle + reversal/audit/export state; every historical value is unchanged', () => {
    const p = seedProduct(db, { name: 'iPhone 15', sellingPriceCents: 59900, quantity: 5 });
    const customer = createCustomerService({ db, now: () => T0 }).create({
      name: 'Jane Doe',
      phone: '(281) 824-0001',
    });
    const sale = cashSale([{ productId: p.id, quantity: 1, soldPriceCents: 55000 }], {
      customerId: customer.id,
    });

    const receiptBefore = createReceiptService({ db }).getBySaleId(sale.saleId);
    const rowBefore = saleRow(sale.saleId);
    const itemsBefore = db
      .prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id')
      .all(sale.saleId);
    const paymentBefore = db.prepare('SELECT * FROM payments WHERE sale_id = ?').get(sale.saleId);

    voidSvc().voidSale({ saleId: sale.saleId, reason: 'duplicate charge' });

    const receiptAfter = createReceiptService({ db }).getBySaleId(sale.saleId);
    // Only the lifecycle fields differ.
    expect({ ...receiptAfter, status: 'COMPLETED', voidedAt: null, voidReason: null }).toEqual(
      receiptBefore,
    );
    expect(receiptAfter.status).toBe('VOIDED');
    expect(receiptAfter.voidedAt).toBe(VOID_AT);
    expect(receiptAfter.voidReason).toBe('duplicate charge');

    const rowAfter = saleRow(sale.saleId);
    for (const col of [
      'id',
      'receipt_number',
      'customer_id',
      'customer_name_snapshot',
      'customer_phone_snapshot',
      'business_name_snapshot',
      'business_address_snapshot',
      'business_phone_snapshot',
      'receipt_disclaimer_snapshot',
      'receipt_footer_snapshot',
      'subtotal_cents',
      'discount_cents',
      'taxable_amount_cents',
      'tax_rate_bps',
      'tax_cents',
      'total_cents',
      'payment_method_snapshot',
      'created_at',
      'completed_at',
    ]) {
      expect(rowAfter[col]).toEqual(rowBefore[col]);
    }
    expect(
      db.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id').all(sale.saleId),
    ).toEqual(itemsBefore);
    expect(db.prepare('SELECT * FROM payments WHERE sale_id = ?').get(sale.saleId)).toEqual(
      paymentBefore,
    );
  });
});

describe('TEST-VOID-005 — reason required (blank rejected, no mutation)', () => {
  it('a blank / whitespace reason is rejected and nothing changes', () => {
    const p = seedProduct(db, { quantity: 4 });
    const sale = cashSale([{ productId: p.id, quantity: 1, soldPriceCents: 50000 }]);
    const before = {
      audit: auditCounter(db),
      qty: productQuantity(db, p.id),
      job: exportJob(sale.saleId),
    };

    for (const bad of ['', '   ', '\t\n']) {
      try {
        voidSvc().voidSale({ saleId: sale.saleId, reason: bad });
        throw new Error('expected rejection');
      } catch (error) {
        expect(isAppError(error) && error.code).toBe('VALIDATION');
      }
    }

    expect(saleRow(sale.saleId)).toMatchObject({
      status: 'COMPLETED',
      voided_at: null,
      void_reason: null,
      sync_version: 1,
    });
    expect(movements(sale.saleId, 'VOID_REVERSAL')).toHaveLength(0);
    expect(auditRows(db, 'SALE_VOIDED')).toHaveLength(0);
    expect(auditCounter(db)).toBe(before.audit);
    expect(productQuantity(db, p.id)).toBe(before.qty);
    expect(exportJob(sale.saleId)).toEqual(before.job);
  });
});

describe('TEST-VOID-006 — double-void rejection', () => {
  it('a second void is rejected and restores/records nothing a second time', () => {
    const p = seedProduct(db, { quantity: 5 });
    const sale = cashSale([{ productId: p.id, quantity: 2, soldPriceCents: 50000 }]);
    voidSvc(() => VOID_AT).voidSale({ saleId: sale.saleId, reason: 'first void' });

    const after1 = {
      row: saleRow(sale.saleId),
      job: exportJob(sale.saleId),
      qty: productQuantity(db, p.id),
      auditCount: auditRows(db, 'SALE_VOIDED').length,
      reversalCount: movements(sale.saleId, 'VOID_REVERSAL').length,
    };

    try {
      voidSvc(() => '2026-09-09T00:00:00.000Z').voidSale({
        saleId: sale.saleId,
        reason: 'second void attempt',
      });
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('SALE_ALREADY_VOIDED');
    }

    expect(saleRow(sale.saleId)).toEqual(after1.row); // voided_at / void_reason / sync_version unchanged
    expect(exportJob(sale.saleId)).toEqual(after1.job);
    expect(productQuantity(db, p.id)).toBe(after1.qty);
    expect(auditRows(db, 'SALE_VOIDED')).toHaveLength(after1.auditCount);
    expect(movements(sale.saleId, 'VOID_REVERSAL')).toHaveLength(after1.reversalCount);
  });
});

describe('TEST-VOID-007 — Google Sheets void propagation (export-job states)', () => {
  const states: Array<{
    label: string;
    pre: Record<string, unknown>;
    expectExportedSyncVersion: number | null;
  }> = [
    { label: 'PENDING', pre: {}, expectExportedSyncVersion: null },
    {
      label: 'EXPORTED',
      pre: {
        status: 'EXPORTED',
        exported_sync_version: 1,
        exported_at: '2026-09-08T12:05:00.000Z',
        attempt_count: 1,
      },
      expectExportedSyncVersion: 1,
    },
    {
      label: 'FAILED',
      pre: {
        status: 'FAILED',
        attempt_count: 7,
        last_error: 'quota exceeded',
        last_attempt_at: '2026-09-08T12:30:00.000Z',
      },
      expectExportedSyncVersion: null,
    },
    {
      label: 'EXPORTING',
      pre: { status: 'EXPORTING', attempt_count: 1 },
      expectExportedSyncVersion: null,
    },
  ];

  it.each(states)(
    'a $label job → same one job, advanced to target=2 and PENDING; exported_sync_version preserved',
    ({ pre, expectExportedSyncVersion }) => {
      const p = seedProduct(db, { quantity: 5 });
      const sale = cashSale([{ productId: p.id, quantity: 1, soldPriceCents: 50000 }]);
      if (Object.keys(pre).length > 0) {
        setJob(sale.saleId, { ...pre, updated_at: '2026-09-08T12:30:00.000Z' });
      }

      voidSvc().voidSale({
        saleId: sale.saleId,
        reason: `void from ${String(pre['status'] ?? 'PENDING')}`,
      });

      expect(countRows(db, 'google_sheet_export_jobs')).toBe(1);
      const job = exportJob(sale.saleId);
      expect(job).toMatchObject({
        sale_id: sale.saleId,
        status: 'PENDING',
        target_sync_version: 2,
        attempt_count: 0,
        last_error: null,
        last_attempt_at: null,
        exported_at: null,
      });
      expect(job['exported_sync_version']).toBe(expectExportedSyncVersion);
      expect(saleRow(sale.saleId)['sync_version']).toBe(2);
    },
  );

  it('integration-disabled PENDING job: void succeeds locally with no network request; the one job stays PENDING, advanced to target=2 until enabled', () => {
    // "Google Sheets integration disabled" is the canonical `settings` key
    // (`DATA_MODEL.md §19`, `§23`; `TEST-VOID-007` third scenario). V1 has no
    // export worker at all, so a `PENDING` job is inherently "not being
    // processed"; the setting row is seeded to represent the scenario
    // explicitly. The void must be completely agnostic to it.
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('google_sheets_enabled', 'false', ?)",
    ).run(T0);

    const p = seedProduct(db, { quantity: 5 });
    const sale = cashSale([{ productId: p.id, quantity: 1, soldPriceCents: 50000 }]);
    expect(exportJob(sale.saleId)).toMatchObject({ status: 'PENDING', target_sync_version: 1 });

    // Any network use anywhere in the void path is a hard failure.
    const fetchSpy = vi.fn(() => {
      throw new Error('no network request may occur during a void');
    });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      voidSvc().voidSale({ saleId: sale.saleId, reason: 'wrong customer; sync is off' });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchSpy).not.toHaveBeenCalled();

    // The sale is voided purely locally.
    expect(saleRow(sale.saleId)).toMatchObject({ status: 'VOIDED', sync_version: 2 });

    // Still exactly one export job; advanced and retained as PENDING — nothing
    // has been (or could be) confirmed remotely, so it waits until enabled.
    expect(countRows(db, 'google_sheet_export_jobs')).toBe(1);
    expect(exportJob(sale.saleId)).toMatchObject({
      sale_id: sale.saleId,
      status: 'PENDING',
      target_sync_version: 2,
      exported_sync_version: null,
      exported_at: null,
      attempt_count: 0,
      last_error: null,
    });

    // No second logical sale, no second job, integration setting untouched.
    expect(countRows(db, 'sales')).toBe(1);
    expect(
      db.prepare("SELECT value FROM settings WHERE key = 'google_sheets_enabled'").get(),
    ).toEqual({ value: 'false' });
    expect(auditRows(db, 'GOOGLE_CONFIGURATION_CHANGED')).toHaveLength(0);
  });
});

describe('TEST-VOID-008 (local portion) / Card void behaves identically', () => {
  it('a Card sale void does the same local work, no Clover / payment mutation', () => {
    const p = seedProduct(db, { quantity: 4 });
    const sale = cardSale([{ productId: p.id, quantity: 1, soldPriceCents: 59900 }]);
    const paymentBefore = db.prepare('SELECT * FROM payments WHERE sale_id = ?').get(sale.saleId);

    voidSvc().voidSale({ saleId: sale.saleId, reason: 'card sale entered twice' });

    expect(saleRow(sale.saleId)).toMatchObject({ status: 'VOIDED', sync_version: 2 });
    expect(productQuantity(db, p.id)).toBe(4);
    expect(movements(sale.saleId, 'VOID_REVERSAL')).toHaveLength(1);
    // Payment untouched — no negative/refund payment, still exactly one COMPLETED CARD payment.
    expect(db.prepare('SELECT * FROM payments WHERE sale_id = ?').get(sale.saleId)).toEqual(
      paymentBefore,
    );
    expect(countRows(db, 'payments')).toBe(1);
    const audit = auditRows(db, 'SALE_VOIDED')[0]!;
    expect(JSON.parse(audit['details_json'] as string)).toMatchObject({ paymentMethod: 'CARD' });
  });
});

describe('not-found + read-only', () => {
  it('voiding an unknown Sale ID is a sanitized SALE_NOT_FOUND with no writes', () => {
    const before = auditCounter(db);
    try {
      voidSvc().voidSale({ saleId: 'nope', reason: 'x' });
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('SALE_NOT_FOUND');
    }
    expect(auditCounter(db)).toBe(before);
    expect(countRows(db, 'inventory_movements')).toBe(0);
  });
});

describe('TEST-VOID-010 — void atomic rollback', () => {
  const points: Array<{ label: string; trigger: string; name: string }> = [
    {
      label: 'reversing movement insertion',
      name: 'fail_reversal',
      trigger: `CREATE TEMP TRIGGER fail_reversal BEFORE INSERT ON inventory_movements
                  WHEN NEW.movement_type = 'VOID_REVERSAL'
                BEGIN SELECT RAISE(ABORT, 'forced reversal failure'); END`,
    },
    {
      label: 'export-job requeue',
      name: 'fail_requeue',
      trigger: `CREATE TEMP TRIGGER fail_requeue BEFORE UPDATE ON google_sheet_export_jobs
                BEGIN SELECT RAISE(ABORT, 'forced requeue failure'); END`,
    },
    {
      label: 'SALE_VOIDED audit insertion',
      name: 'fail_audit',
      trigger: `CREATE TEMP TRIGGER fail_audit BEFORE INSERT ON audit_events
                  WHEN NEW.event_type = 'SALE_VOIDED'
                BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END`,
    },
  ];

  it.each(points)(
    'failure at $label → whole void rolls back, sale stays COMPLETED',
    ({ trigger, name }) => {
      const p = seedProduct(db, { quantity: 5 });
      const sale = cashSale([{ productId: p.id, quantity: 2, soldPriceCents: 50000 }]);
      const before = {
        row: saleRow(sale.saleId),
        job: exportJob(sale.saleId),
        qty: productQuantity(db, p.id),
        auditSeq: auditCounter(db),
      };

      db.exec(trigger);
      try {
        voidSvc().voidSale({ saleId: sale.saleId, reason: 'attempted void' });
        throw new Error('expected rejection');
      } catch (error) {
        expect(isAppError(error) && error.code).toBe('VOID_COMMIT_FAILED');
      } finally {
        db.exec(`DROP TRIGGER ${name}`);
      }

      expect(saleRow(sale.saleId)).toEqual(before.row);
      expect(saleRow(sale.saleId)).toMatchObject({
        status: 'COMPLETED',
        voided_at: null,
        void_reason: null,
        sync_version: 1,
      });
      expect(productQuantity(db, p.id)).toBe(before.qty);
      expect(movements(sale.saleId, 'VOID_REVERSAL')).toHaveLength(0);
      expect(auditRows(db, 'SALE_VOIDED')).toHaveLength(0);
      expect(auditCounter(db)).toBe(before.auditSeq);
      expect(exportJob(sale.saleId)).toEqual(before.job);

      // And the sale can still be voided normally once the fault clears.
      voidSvc().voidSale({ saleId: sale.saleId, reason: 'retried void' });
      expect(saleRow(sale.saleId)).toMatchObject({ status: 'VOIDED', sync_version: 2 });
    },
  );
});
