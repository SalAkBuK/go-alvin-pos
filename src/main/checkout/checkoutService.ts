import type Database from 'better-sqlite3';
import type { CheckoutReview } from '../../shared/checkout';
import { recalculateCheckout } from './checkoutRecalculation';
import { validateCheckoutReviewRequest } from './checkoutValidation';

/**
 * Trusted checkout review (`ARCHITECTURE.md §10-11`, `POS_WORKFLOWS.md §26-27`,
 * `DATA_MODEL.md §41`-`§43`, `§41B`; `REQ-SALE-007`, `REQ-SALE-012`,
 * `REQ-SALE-013`).
 *
 * `review()` takes a normalized renderer *intent*, reloads authoritative
 * product/customer/tax state from SQLite, recomputes every monetary value, and
 * returns the canonical review plus a deterministic fingerprint. It is a pure
 * read: it opens a transaction only for a consistent snapshot and never
 * inserts, updates, or deletes any row — no `sales`, `sale_items`, `payments`,
 * `inventory_movements`, `checkout_requests`, audit events, or export jobs, and
 * `products.quantity_on_hand` is never touched. Reviewing completes no sale.
 *
 * All of the recalculation lives in {@link recalculateCheckout}, the shared
 * primitive Phase 2E's Cash completion transaction also calls (inside its own
 * `BEGIN IMMEDIATE`). `review()` is deliberately a thin transactional wrapper so
 * its behaviour is unchanged from Phase 2D.
 */

export interface CheckoutServiceDeps {
  readonly db: Database.Database;
}

export interface CheckoutService {
  review(raw: unknown): CheckoutReview;
}

export function createCheckoutService(deps: CheckoutServiceDeps): CheckoutService {
  const { db } = deps;

  return {
    review(raw: unknown): CheckoutReview {
      // A deferred transaction gives every read in one review a single
      // consistent snapshot without taking a write lock.
      return db.transaction(() => {
        const request = validateCheckoutReviewRequest(raw);
        return recalculateCheckout(db, request).review;
      })();
    },
  };
}
