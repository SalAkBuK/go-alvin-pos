import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createReconciliationService,
  staleCutoff,
} from '../../src/main/reconciliation/reconciliationService';
import { isAppError } from '../../src/main/shared/appError';
import { createMigratedDb } from '../helpers/database';

/**
 * Phase 2F — Reconciliation Queue query rules and manual resolution
 * (`DATA_MODEL.md §31B`; `POS_WORKFLOWS.md §35B`; `TEST_PLAN.md` TEST-CARD-005C,
 * TEST-CARD-007; `REQ-RECONCILE-004`). Rows are inserted directly so each queue
 * rule is exercised in isolation with an injected clock.
 */

let db: Database.Database;
const NOW = '2026-09-08T12:00:00.000Z';

function insertRequest(row: {
  id: string;
  method?: 'CASH' | 'CARD';
  status: 'PENDING_PAYMENT' | 'SUBMITTED' | 'COMPLETED' | 'COMMIT_FAILED';
  failureCode?: string | null;
  createdAt: string;
  cloverAt?: string | null;
  resolution?: 'UNRESOLVED' | 'RESOLVED' | null;
  resolutionNote?: string | null;
  resolvedAt?: string | null;
  saleId?: string | null;
  completedAt?: string | null;
  failedAt?: string | null;
}) {
  db.prepare(
    `INSERT INTO checkout_requests
       (request_id, request_fingerprint, payment_method_snapshot, intended_total_cents,
        clover_approved_confirmed_at, sale_id, status, failure_code,
        resolution_status, resolution_note, created_at, completed_at, failed_at, resolved_at)
     VALUES (@id, @fp, @method, 10000, @cloverAt, @saleId, @status, @failureCode,
             @resolution, @resolutionNote, @createdAt, @completedAt, @failedAt, @resolvedAt)`,
  ).run({
    id: row.id,
    fp: `fp-${row.id}`,
    method: row.method ?? 'CARD',
    cloverAt: row.cloverAt ?? null,
    saleId: row.saleId ?? null,
    status: row.status,
    failureCode: row.failureCode ?? (row.status === 'COMMIT_FAILED' ? 'SALE_COMMIT_FAILED' : null),
    resolution: row.resolution ?? null,
    resolutionNote: row.resolutionNote ?? null,
    createdAt: row.createdAt,
    completedAt: row.completedAt ?? null,
    failedAt: row.failedAt ?? (row.status === 'COMMIT_FAILED' ? row.createdAt : null),
    resolvedAt: row.resolvedAt ?? null,
  });
}

beforeEach(async () => {
  db = await createMigratedDb();
});
afterEach(() => db.close());

describe('staleCutoff', () => {
  it('is exactly 5 minutes before now by default', () => {
    expect(staleCutoff('2026-09-08T12:06:00.000Z')).toBe('2026-09-08T12:01:00.000Z');
  });
});

describe('queue query rules (`DATA_MODEL.md §31B`)', () => {
  it('includes only Card incidents: COMMIT_FAILED (not declined) and stale PENDING_PAYMENT', () => {
    insertRequest({
      id: 'card-fail',
      status: 'COMMIT_FAILED',
      createdAt: '2026-09-08T11:00:00.000Z',
      cloverAt: '2026-09-08T11:00:00.000Z',
    });
    insertRequest({
      id: 'card-stale-pending',
      status: 'PENDING_PAYMENT',
      createdAt: '2026-09-08T11:50:00.000Z',
    });

    // Excluded:
    insertRequest({
      id: 'card-declined',
      status: 'COMMIT_FAILED',
      failureCode: 'CLOVER_DECLINED',
      createdAt: '2026-09-08T11:00:00.000Z',
    });
    insertRequest({
      id: 'card-fresh-pending',
      status: 'PENDING_PAYMENT',
      createdAt: '2026-09-08T11:58:00.000Z',
    });
    insertRequest({
      id: 'card-resolved',
      status: 'COMMIT_FAILED',
      createdAt: '2026-09-08T10:00:00.000Z',
      resolution: 'RESOLVED',
      resolutionNote: 'done',
      resolvedAt: '2026-09-08T10:30:00.000Z',
    });
    insertRequest({
      id: 'card-submitted',
      status: 'SUBMITTED',
      createdAt: '2026-09-08T11:00:00.000Z',
    });
    insertRequest({
      id: 'cash-fail',
      method: 'CASH',
      status: 'COMMIT_FAILED',
      createdAt: '2026-09-08T11:00:00.000Z',
    });

    const entries = createReconciliationService({ db, now: () => NOW }).list();
    expect(entries.map((e) => e.requestId)).toEqual(['card-fail', 'card-stale-pending']);
  });

  it('orders by created_at ascending', () => {
    insertRequest({ id: 'b', status: 'COMMIT_FAILED', createdAt: '2026-09-08T11:30:00.000Z' });
    insertRequest({ id: 'a', status: 'COMMIT_FAILED', createdAt: '2026-09-08T10:30:00.000Z' });
    insertRequest({ id: 'c', status: 'COMMIT_FAILED', createdAt: '2026-09-08T11:45:00.000Z' });
    const entries = createReconciliationService({ db, now: () => NOW }).list();
    expect(entries.map((e) => e.requestId)).toEqual(['a', 'b', 'c']);
  });

  it('a PENDING_PAYMENT row exactly at the 5-minute boundary is stale (<=)', () => {
    insertRequest({ id: 'edge', status: 'PENDING_PAYMENT', createdAt: '2026-09-08T11:55:00.000Z' });
    expect(createReconciliationService({ db, now: () => NOW }).list()).toHaveLength(1);
  });
});

describe('resolve (`DATA_MODEL.md §31B`; TEST-CARD-007)', () => {
  it('rejects a blank note and an unknown / non-incident entry', () => {
    insertRequest({ id: 'inc', status: 'COMMIT_FAILED', createdAt: '2026-09-08T11:00:00.000Z' });
    const recon = createReconciliationService({ db, now: () => NOW });
    try {
      recon.resolve({ requestId: 'inc', note: '   ' });
      throw new Error('expected');
    } catch (e) {
      expect(isAppError(e) && e.code).toBe('VALIDATION');
    }
    try {
      recon.resolve({ requestId: 'missing', note: 'x' });
      throw new Error('expected');
    } catch (e) {
      expect(isAppError(e) && e.code).toBe('CHECKOUT_REQUEST_INVALID');
    }
  });

  it('records RESOLVED + trimmed note + resolved_at, and no audit event is invented', () => {
    insertRequest({ id: 'inc', status: 'COMMIT_FAILED', createdAt: '2026-09-08T11:00:00.000Z' });
    const auditBefore = (db.prepare('SELECT COUNT(*) n FROM audit_events').get() as { n: number })
      .n;

    const entry = createReconciliationService({ db, now: () => NOW }).resolve({
      requestId: 'inc',
      note: '  Checked Clover; refunded.  ',
    });
    expect(entry.resolutionStatus).toBe('RESOLVED');

    const row = db
      .prepare(
        'SELECT resolution_status, resolution_note, resolved_at FROM checkout_requests WHERE request_id = ?',
      )
      .get('inc');
    expect(row).toEqual({
      resolution_status: 'RESOLVED',
      resolution_note: 'Checked Clover; refunded.',
      resolved_at: NOW,
    });
    expect((db.prepare('SELECT COUNT(*) n FROM audit_events').get() as { n: number }).n).toBe(
      auditBefore,
    );
  });

  it('resolving a stale PENDING_PAYMENT row is allowed and drops it from the queue', () => {
    insertRequest({ id: 'pend', status: 'PENDING_PAYMENT', createdAt: '2026-09-08T11:00:00.000Z' });
    const recon = createReconciliationService({ db, now: () => NOW });
    recon.resolve({ requestId: 'pend', note: 'Never charged; abandoned.' });
    expect(recon.list()).toEqual([]);
  });
});
