import type Database from 'better-sqlite3';
import type { Logger } from '../app/logger';
import { appErrors } from '../shared/appError';
import { setExclusiveMaintenance } from './maintenanceStatus';
import type { ExclusiveMaintenanceKind } from './maintenanceStatus';

/**
 * The one main-process maintenance coordinator (`ARCHITECTURE.md §42.3`;
 * `UPDATE_RELEASE_STRATEGY.md §15`-`§16`; `POS_WORKFLOWS.md §102`;
 * `DATA_MODEL.md §52A`; `AGENTS.md` invariant 11).
 *
 * It owns the exclusive database-lifecycle claim used by database restore
 * (Phase 2L-B) and, later, update-driven migration (Phase 2O — the `MIGRATION`
 * arm is reserved but not yet called).
 *
 * ## Authority
 *
 * The renderer's ONLY input is draft-cart presence via
 * `noteDraftCartActivity(active, ownerId)`. It cannot set
 * `TRANSACTION_IN_FLIGHT`, `MIGRATION_IN_PROGRESS`, or `RESTORE_IN_PROGRESS` —
 * those are computed / claimed here in the main process. `TRANSACTION_IN_FLIGHT`
 * is claimed only by `runGuardedTransaction`; the exclusive states only by
 * `tryAcquireExclusive`.
 *
 * ## No check-then-await-then-claim race
 *
 * `tryAcquireExclusive` and `runGuardedTransaction` inspect state and claim in
 * the SAME synchronous turn — Node is single-threaded, so nothing runs between
 * the check and the claim. A checkout IPC arriving concurrently either ran
 * before the claim (and is then visible as `CHECKOUT_ACTIVE` /
 * `TRANSACTION_IN_FLIGHT`, so the claim is denied) or after it (and its own
 * first-line `assertNormalDbAccessAllowed()` rejects it).
 */

export type MaintenanceState =
  | 'SAFE'
  | 'CHECKOUT_ACTIVE'
  | 'TRANSACTION_IN_FLIGHT'
  | 'MIGRATION_IN_PROGRESS'
  | 'RESTORE_IN_PROGRESS';

export interface ExclusiveClaim {
  readonly ok: true;
  release(): void;
}
export interface ExclusiveDenied {
  readonly ok: false;
  readonly reason: MaintenanceState;
  /** Set when the block is specifically an unresolved card payment/reconciliation (Item 5). */
  readonly cardReconciliationPending?: boolean;
}

export interface MaintenanceCoordinatorDeps {
  readonly logger: Logger;
  /** The live operational connection, or `null` while none is open (mid-swap). */
  readonly getDb: () => Database.Database | null;
  readonly now?: () => Date;
}

export interface MaintenanceCoordinator {
  /** The current derived maintenance state. */
  status(): MaintenanceState;
  /** `true` while a RESTORE / MIGRATION exclusive owner holds the DB lifecycle. */
  isExclusiveActive(): boolean;
  /** Throw `MAINTENANCE_IN_PROGRESS` when a normal DB-backed request must be refused. */
  assertNormalDbAccessAllowed(): void;
  /** Synchronous compare-and-set of the exclusive DB-lifecycle owner. */
  tryAcquireExclusive(kind: ExclusiveMaintenanceKind): ExclusiveClaim | ExclusiveDenied;
  /**
   * Run a synchronous SQLite mutation as a counted, guarded transaction:
   * refuses if an exclusive owner holds the lifecycle, then claims
   * `transactionInFlight` and decrements in `finally` — no `await` between the
   * check and the claim. This is the ONLY sanctioned transaction-entry
   * primitive; callers must not hand-roll "check status … then later increment".
   */
  runGuardedTransaction<T>(fn: () => T): T;
  /**
   * Renderer draft-cart presence (the only renderer-mutable maintenance
   * input). `{ accepted: false }` for `active: true` means a RESTORE /
   * MIGRATION owner already holds the exclusive lifecycle — the cart was NOT
   * recorded as active and the caller must not let it proceed (Item 3, 2L-B
   * adversarial follow-up). `active: false` (cleanup) always succeeds.
   */
  noteDraftCartActivity(active: boolean, ownerId: number): { readonly accepted: boolean };
  /** A WebContents was destroyed / crashed / navigated — clear its draft cart, if it owns the tracked one. */
  clearDraftCartIfOwner(ownerId: number): void;
}

export function createMaintenanceCoordinator(
  deps: MaintenanceCoordinatorDeps,
): MaintenanceCoordinator {
  const now = deps.now ?? ((): Date => new Date());

  let exclusiveOwner: { kind: ExclusiveMaintenanceKind; since: string } | null = null;
  let transactionInFlight = 0;
  let draftCartOpen = false;
  let draftCartOwnerId: number | null = null;

  /**
   * Any checkout actively mid-authorization / mid-commit, or any unresolved card
   * commit incident. Deliberately stricter than the reconciliation-queue query:
   * a fresh (not-yet-stale) `PENDING_PAYMENT` also blocks — restore must never
   * run over a card sale that could already be charged (Item 5).
   */
  function checkoutWorkOutstanding(): { active: boolean; cardReconciliation: boolean } {
    const db = deps.getDb();
    if (!db || !db.open) {
      return { active: false, cardReconciliation: false };
    }
    try {
      // A card sale mid-authorization (`PENDING_PAYMENT` is CARD-only by the
      // `001` CHECK), a card sale awaiting Phase 2 (`SUBMITTED` + CARD), or an
      // unresolved card commit incident — any of these means restore must not
      // run over a possibly-charged card (Item 5).
      const cardOutstanding = db
        .prepare(
          `SELECT 1 FROM checkout_requests
             WHERE (
                     status = 'PENDING_PAYMENT'
                  OR (status = 'SUBMITTED' AND payment_method_snapshot = 'CARD')
                  OR (
                       payment_method_snapshot = 'CARD'
                       AND status = 'COMMIT_FAILED'
                       AND (failure_code IS NULL OR failure_code <> 'CLOVER_DECLINED')
                       AND (resolution_status IS NULL OR resolution_status <> 'RESOLVED')
                     )
                   )
             LIMIT 1`,
        )
        .get();
      if (cardOutstanding !== undefined) {
        return { active: true, cardReconciliation: true };
      }
      // A stuck non-card `SUBMITTED` request is a generic in-flight checkout.
      const cashSubmitted = db
        .prepare("SELECT 1 FROM checkout_requests WHERE status = 'SUBMITTED' LIMIT 1")
        .get();
      return { active: cashSubmitted !== undefined, cardReconciliation: false };
    } catch {
      // Cannot read the table → be conservative and treat as active.
      return { active: true, cardReconciliation: false };
    }
  }

  function status(): MaintenanceState {
    if (exclusiveOwner?.kind === 'RESTORE') {
      return 'RESTORE_IN_PROGRESS';
    }
    if (exclusiveOwner?.kind === 'MIGRATION') {
      return 'MIGRATION_IN_PROGRESS';
    }
    if (transactionInFlight > 0) {
      return 'TRANSACTION_IN_FLIGHT';
    }
    if (draftCartOpen || checkoutWorkOutstanding().active) {
      return 'CHECKOUT_ACTIVE';
    }
    return 'SAFE';
  }

  return {
    status,

    isExclusiveActive(): boolean {
      return exclusiveOwner !== null;
    },

    assertNormalDbAccessAllowed(): void {
      if (exclusiveOwner !== null) {
        throw appErrors.maintenanceInProgress();
      }
    },

    tryAcquireExclusive(kind): ExclusiveClaim | ExclusiveDenied {
      if (exclusiveOwner !== null) {
        return { ok: false, reason: status() };
      }
      if (transactionInFlight > 0) {
        return { ok: false, reason: 'TRANSACTION_IN_FLIGHT' };
      }
      if (draftCartOpen) {
        return { ok: false, reason: 'CHECKOUT_ACTIVE' };
      }
      const outstanding = checkoutWorkOutstanding();
      if (outstanding.active) {
        return {
          ok: false,
          reason: 'CHECKOUT_ACTIVE',
          cardReconciliationPending: outstanding.cardReconciliation,
        };
      }

      exclusiveOwner = { kind, since: now().toISOString() };
      setExclusiveMaintenance(kind);
      deps.logger.info('application', 'maintenance.exclusive.acquired', { kind });

      let releasedOnce = false;
      return {
        ok: true,
        release: (): void => {
          if (releasedOnce || exclusiveOwner?.kind !== kind) {
            return;
          }
          releasedOnce = true;
          exclusiveOwner = null;
          setExclusiveMaintenance(null);
          deps.logger.info('application', 'maintenance.exclusive.released', { kind });
        },
      };
    },

    runGuardedTransaction<T>(fn: () => T): T {
      if (exclusiveOwner !== null) {
        throw appErrors.maintenanceInProgress();
      }
      transactionInFlight += 1;
      try {
        return fn();
      } finally {
        transactionInFlight -= 1;
      }
    },

    noteDraftCartActivity(active, ownerId): { readonly accepted: boolean } {
      if (active) {
        // A RESTORE / MIGRATION owner already holds the exclusive lifecycle —
        // a new draft cart must not become active until it releases. Refuse
        // without mutating state, so a cart that starts DURING exclusive
        // maintenance can never survive past it (Item 3, 2L-B adversarial
        // follow-up: a stale draft cart must not continue against whatever
        // database is in place once maintenance finishes).
        if (exclusiveOwner !== null) {
          return { accepted: false };
        }
        draftCartOpen = true;
        draftCartOwnerId = ownerId;
        return { accepted: true };
      }
      // Only the currently tracked owner may clear the flag — a stale or
      // different sender must not clear another live renderer's cart (Item 3).
      // This cleanup direction is always honoured, even during exclusive
      // maintenance, so a renderer can always relinquish a cart it reported
      // before maintenance began.
      if (draftCartOwnerId === ownerId) {
        draftCartOpen = false;
        draftCartOwnerId = null;
      }
      return { accepted: true };
    },

    clearDraftCartIfOwner(ownerId): void {
      if (draftCartOwnerId === ownerId) {
        draftCartOpen = false;
        draftCartOwnerId = null;
        deps.logger.info('application', 'maintenance.draft-cart.cleared-by-lifecycle', {});
      }
    },
  };
}
