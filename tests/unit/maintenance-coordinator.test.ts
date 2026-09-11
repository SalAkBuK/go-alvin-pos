import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMaintenanceCoordinator } from '../../src/main/maintenance/maintenanceCoordinator';
import {
  getExclusiveMaintenance,
  setExclusiveMaintenance,
} from '../../src/main/maintenance/maintenanceStatus';
import { isAppError } from '../../src/main/shared/appError';
import { createCapturingLogger } from '../helpers/database';

/**
 * Phase 2L-B — maintenance coordinator (Items 3, 4, 5).
 */

let db: Database.Database;

function makeCheckoutRequests(): void {
  db.exec(`
    CREATE TABLE checkout_requests (
      request_id TEXT PRIMARY KEY,
      payment_method_snapshot TEXT NOT NULL,
      status TEXT NOT NULL,
      failure_code TEXT,
      resolution_status TEXT
    );
  `);
}

beforeEach(() => {
  db = new Database(':memory:');
  makeCheckoutRequests();
  setExclusiveMaintenance(null);
});
afterEach(() => {
  db.close();
  setExclusiveMaintenance(null);
});

function coordinator(getDb: () => Database.Database | null = () => db) {
  return createMaintenanceCoordinator({ logger: createCapturingLogger().logger, getDb });
}

describe('status derivation', () => {
  it('is SAFE with nothing going on', () => {
    expect(coordinator().status()).toBe('SAFE');
  });

  it('is CHECKOUT_ACTIVE when a draft cart is open', () => {
    const c = coordinator();
    c.noteDraftCartActivity(true, 1);
    expect(c.status()).toBe('CHECKOUT_ACTIVE');
  });

  it('is CHECKOUT_ACTIVE when a card request is PENDING_PAYMENT (durable, renderer-independent)', () => {
    db.prepare(
      "INSERT INTO checkout_requests VALUES ('r1', 'CARD', 'PENDING_PAYMENT', NULL, NULL)",
    ).run();
    expect(coordinator().status()).toBe('CHECKOUT_ACTIVE');
  });

  it('is TRANSACTION_IN_FLIGHT during a guarded transaction', () => {
    const c = coordinator();
    let observed = '';
    c.runGuardedTransaction(() => {
      observed = c.status();
    });
    expect(observed).toBe('TRANSACTION_IN_FLIGHT');
    expect(c.status()).toBe('SAFE');
  });

  it('is RESTORE_IN_PROGRESS while the exclusive owner is held', () => {
    const c = coordinator();
    const claim = c.tryAcquireExclusive('RESTORE');
    expect(claim.ok).toBe(true);
    expect(c.status()).toBe('RESTORE_IN_PROGRESS');
    expect(getExclusiveMaintenance()).toBe('RESTORE');
    if (claim.ok) claim.release();
    expect(c.status()).toBe('SAFE');
    expect(getExclusiveMaintenance()).toBeNull();
  });
});

describe('tryAcquireExclusive — synchronous CAS (Item 4)', () => {
  it('denies when a draft cart is active', () => {
    const c = coordinator();
    c.noteDraftCartActivity(true, 7);
    const claim = c.tryAcquireExclusive('RESTORE');
    expect(claim).toEqual({ ok: false, reason: 'CHECKOUT_ACTIVE' });
  });

  it('denies while a guarded transaction is running (no interleave)', () => {
    const c = coordinator();
    let deniedReason: string | undefined;
    c.runGuardedTransaction(() => {
      const claim = c.tryAcquireExclusive('RESTORE');
      deniedReason = claim.ok ? undefined : claim.reason;
    });
    expect(deniedReason).toBe('TRANSACTION_IN_FLIGHT');
  });

  it('denies a second exclusive claim while one is held', () => {
    const c = coordinator();
    const first = c.tryAcquireExclusive('RESTORE');
    const second = c.tryAcquireExclusive('RESTORE');
    expect(second).toEqual({ ok: false, reason: 'RESTORE_IN_PROGRESS' });
    if (first.ok) first.release();
  });

  it('runGuardedTransaction refuses once an exclusive owner exists', () => {
    const c = coordinator();
    const claim = c.tryAcquireExclusive('RESTORE');
    expect(() => c.runGuardedTransaction(() => 1)).toThrow(/restored/i);
    if (claim.ok) claim.release();
  });
});

describe('unresolved card work blocks restore (Item 5)', () => {
  it('a fresh PENDING_PAYMENT card request blocks — not just stale ones', () => {
    db.prepare(
      "INSERT INTO checkout_requests VALUES ('r1', 'CARD', 'PENDING_PAYMENT', NULL, NULL)",
    ).run();
    const claim = coordinator().tryAcquireExclusive('RESTORE');
    expect(claim.ok).toBe(false);
  });

  it('an unresolved COMMIT_FAILED card incident blocks with the card-reconciliation flag', () => {
    db.prepare(
      "INSERT INTO checkout_requests VALUES ('r1', 'CARD', 'COMMIT_FAILED', 'SALE_COMMIT_FAILED', 'UNRESOLVED')",
    ).run();
    const claim = coordinator().tryAcquireExclusive('RESTORE');
    expect(claim).toEqual({
      ok: false,
      reason: 'CHECKOUT_ACTIVE',
      cardReconciliationPending: true,
    });
  });

  it('a RESOLVED / CLOVER_DECLINED card row does not block', () => {
    db.prepare(
      "INSERT INTO checkout_requests VALUES ('r1', 'CARD', 'COMMIT_FAILED', 'CLOVER_DECLINED', NULL)",
    ).run();
    db.prepare(
      "INSERT INTO checkout_requests VALUES ('r2', 'CARD', 'COMMIT_FAILED', 'SALE_COMMIT_FAILED', 'RESOLVED')",
    ).run();
    expect(coordinator().tryAcquireExclusive('RESTORE').ok).toBe(true);
  });
});

describe('draft-cart WebContents ownership (Item 3)', () => {
  it('a different sender cannot clear the tracked owner’s active cart', () => {
    const c = coordinator();
    c.noteDraftCartActivity(true, 100); // owner 100
    c.noteDraftCartActivity(false, 999); // stale/other sender
    expect(c.status()).toBe('CHECKOUT_ACTIVE');
    c.noteDraftCartActivity(false, 100); // the real owner
    expect(c.status()).toBe('SAFE');
  });

  it('clearDraftCartIfOwner only clears its own owner', () => {
    const c = coordinator();
    c.noteDraftCartActivity(true, 5);
    c.clearDraftCartIfOwner(6);
    expect(c.status()).toBe('CHECKOUT_ACTIVE');
    c.clearDraftCartIfOwner(5);
    expect(c.status()).toBe('SAFE');
  });
});

describe('a draft cart cannot become active once exclusive maintenance owns the lifecycle (Item 3 adversarial follow-up)', () => {
  it('noteDraftCartActivity(true, ...) is refused — not accepted — while RESTORE is held, and does not set CHECKOUT_ACTIVE', () => {
    const c = coordinator();
    const claim = c.tryAcquireExclusive('RESTORE');
    expect(claim.ok).toBe(true);

    // The exact race from the task: a renderer that has not yet observed
    // RESTORE_IN_PROGRESS reports a freshly-opened draft cart.
    const result = c.noteDraftCartActivity(true, 42);
    expect(result).toEqual({ accepted: false });
    expect(c.status()).toBe('RESTORE_IN_PROGRESS'); // NOT flipped to CHECKOUT_ACTIVE

    if (claim.ok) claim.release();
    // The rejected attempt left no trace: status is SAFE, not CHECKOUT_ACTIVE,
    // once maintenance releases — a cart that started during RESTORE can never
    // survive past it.
    expect(c.status()).toBe('SAFE');
  });

  it('is refused while MIGRATION is held', () => {
    const c = coordinator();
    const claim = c.tryAcquireExclusive('MIGRATION');
    expect(claim.ok).toBe(true);
    expect(c.noteDraftCartActivity(true, 1)).toEqual({ accepted: false });
    expect(c.status()).toBe('MIGRATION_IN_PROGRESS');
    if (claim.ok) claim.release();
  });

  it('active: true is accepted once exclusive maintenance releases', () => {
    const c = coordinator();
    const claim = c.tryAcquireExclusive('RESTORE');
    expect(c.noteDraftCartActivity(true, 42)).toEqual({ accepted: false });
    if (claim.ok) claim.release();
    expect(c.noteDraftCartActivity(true, 42)).toEqual({ accepted: true });
    expect(c.status()).toBe('CHECKOUT_ACTIVE');
  });

  it('active: false (cleanup) is still accepted while exclusive maintenance is held', () => {
    const c = coordinator();
    c.noteDraftCartActivity(true, 7);
    c.noteDraftCartActivity(false, 7); // closed before maintenance claimed the lifecycle
    const claim = c.tryAcquireExclusive('MIGRATION'); // only possible because draftCartOpen is false
    expect(claim.ok).toBe(true);
    // A resend/late cleanup for the same (already-cleared) owner must not be refused.
    expect(c.noteDraftCartActivity(false, 7)).toEqual({ accepted: true });
    if (claim.ok) claim.release();
    expect(c.status()).toBe('SAFE');
  });
});

describe('assertNormalDbAccessAllowed', () => {
  it('throws MAINTENANCE_IN_PROGRESS only while an exclusive owner is held', () => {
    const c = coordinator();
    expect(() => c.assertNormalDbAccessAllowed()).not.toThrow();
    const claim = c.tryAcquireExclusive('RESTORE');
    try {
      c.assertNormalDbAccessAllowed();
      throw new Error('should have thrown');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('MAINTENANCE_IN_PROGRESS');
    }
    if (claim.ok) claim.release();
  });
});
