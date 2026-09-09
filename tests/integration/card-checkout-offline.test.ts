import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openConfiguredConnection } from '../../src/main/database/connection';
import { runMigrations } from '../../src/main/database/migrationRunner';
import { PRODUCTION_MIGRATIONS } from '../../src/main/database/migrations';
import { createCardCheckoutService } from '../../src/main/checkout/cardCheckoutService';
import { createReconciliationService } from '../../src/main/reconciliation/reconciliationService';
import { createReceiptService } from '../../src/main/checkout/receiptService';
import { backupGateUnreachable, createCapturingLogger, makeTempDir } from '../helpers/database';
import {
  buildCardRequest,
  seedBusiness,
  seedProduct,
  seedTaxRate,
  T0,
  T1,
  T2,
} from '../helpers/checkout';
import type { TempDir } from '../helpers/database';

/**
 * Phase 2F — restart durability of Card checkout state (`DATA_MODEL.md §56-57`;
 * `POS_WORKFLOWS.md §26`; task Phase 2F `§26`). A real file-backed WAL database
 * is closed and reopened between operations; no network is involved.
 */

let temp: TempDir;
let file: string;

beforeEach(() => {
  temp = makeTempDir('gpp-card-offline-');
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

describe('a completed Card sale survives close/reopen', () => {
  it('remains a normal completed sale; the receipt shows Payment: Card', async () => {
    let conn = await freshFileDb();
    seedTaxRate(conn);
    seedBusiness(conn);
    const p = seedProduct(conn, { quantity: 5, sellingPriceCents: 59900 });
    const req = buildCardRequest(conn, [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }]);
    let i = 0;
    const svc = createCardCheckoutService({
      db: conn,
      appVersion: 'test',
      now: () => [T0, T1, T1][Math.min(i++, 2)]!,
    });
    svc.beginCard(req);
    const result = svc.completeCard(req);
    conn.close();

    conn = openConfiguredConnection(file);
    expect(
      conn
        .prepare('SELECT status, payment_method_snapshot FROM sales WHERE id = ?')
        .get(result.saleId),
    ).toEqual({ status: 'COMPLETED', payment_method_snapshot: 'CARD' });
    expect(
      conn
        .prepare(
          'SELECT status, clover_approved_confirmed_at FROM checkout_requests WHERE request_id = ?',
        )
        .get(req.requestId),
    ).toEqual({ status: 'COMPLETED', clover_approved_confirmed_at: T1 });

    const receipt = createReceiptService({ db: conn }).getBySaleId(result.saleId);
    expect(receipt.payment.method).toBe('CARD');
    conn.close();
  });
});

describe('an approved Card attempt whose local commit failed stays in the queue after restart', () => {
  it('reappears as an unresolved COMMIT_FAILED incident', async () => {
    let conn = await freshFileDb();
    seedTaxRate(conn);
    seedBusiness(conn);
    const p = seedProduct(conn, { quantity: 5, sellingPriceCents: 59900 });
    const req = buildCardRequest(conn, [{ productId: p.id, quantity: 1, soldPriceCents: 55000 }]);
    let i = 0;
    const svc = createCardCheckoutService({
      db: conn,
      appVersion: 'test',
      now: () => [T0, T1, T1][Math.min(i++, 2)]!,
    });
    svc.beginCard(req);
    conn.exec('ALTER TABLE payments RENAME TO payments_x');
    try {
      expect(() => svc.completeCard(req)).toThrow();
    } finally {
      conn.exec('ALTER TABLE payments_x RENAME TO payments');
    }
    conn.close();

    conn = openConfiguredConnection(file);
    const queue = createReconciliationService({ db: conn, now: () => T2 }).list();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      requestId: req.requestId,
      status: 'COMMIT_FAILED',
      cloverApprovedConfirmedAt: T1,
      resolutionStatus: 'UNRESOLVED',
    });
    conn.close();
  });
});

describe('a stale PENDING_PAYMENT reappears; a CLOVER_DECLINED row never does', () => {
  it('after reopen, only the stale pending row is in the queue', async () => {
    let conn = await freshFileDb();
    seedTaxRate(conn);
    seedBusiness(conn);
    const p = seedProduct(conn, { quantity: 9, sellingPriceCents: 59900 });

    const staleReq = buildCardRequest(conn, [
      { productId: p.id, quantity: 1, soldPriceCents: 59900 },
    ]);
    createCardCheckoutService({ db: conn, appVersion: 't', now: () => T0 }).beginCard(staleReq);

    const declinedReq = buildCardRequest(conn, [
      { productId: p.id, quantity: 1, soldPriceCents: 59900 },
    ]);
    const declineSvc = createCardCheckoutService({ db: conn, appVersion: 't', now: () => T0 });
    declineSvc.beginCard(declinedReq);
    declineSvc.declineCard({
      requestId: declinedReq.requestId,
      reviewedFingerprint: declinedReq.reviewedFingerprint,
    });
    conn.close();

    conn = openConfiguredConnection(file);
    // T0 + 10 min → the pending row is stale.
    const queue = createReconciliationService({
      db: conn,
      now: () => '2026-09-08T12:10:00.000Z',
    }).list();
    expect(queue.map((e) => e.requestId)).toEqual([staleReq.requestId]);
    conn.close();
  });
});
