import type Database from 'better-sqlite3';
import type {
  BeginCardCheckoutResult,
  CompletedSaleResult,
  DeclineCardCheckoutResult,
} from '../../shared/checkout';
import { appendAuditEvent } from '../audit/appendAuditEvent';
import { readBusinessConfig } from '../settings/settingsService';
import { AppError, appErrors, isAppError } from '../shared/appError';
import { recalculateCheckout } from './checkoutRecalculation';
import {
  confirmCardCheckoutApproval,
  findCheckoutRequest,
  insertPendingCardRequest,
  markCardCheckoutDeclined,
  markCheckoutRequestCommitFailed,
} from './checkoutRequestRepository';
import type { CheckoutRequestRow } from './checkoutRequestRepository';
import { readCompletedSaleSummary } from './saleRepository';
import { RECORDABLE_PHASE2_FAILURE_CODES, runSalePhase2 } from './salePhase2';
import { validateCardCheckout, validateDeclineCard } from './cardCheckoutValidation';

/**
 * The manual Clover Card checkout workflow (`DATA_MODEL.md §31`-`§31B`, `§41B`;
 * `POS_WORKFLOWS.md §30`-`§35B`; `ARCHITECTURE.md §15A`; `REQ-PAY-002`-`005`,
 * `REQ-RECONCILE-001`-`006`; task Phase 2F).
 *
 * V1 has **no direct Clover integration** — no network request, SDK, OAuth,
 * terminal discovery, or charge verification. The POS only records what the
 * cashier explicitly confirms. Three narrow trusted capabilities:
 *
 *  - **`beginCard`** — Phase 1 Step A. For a brand-new request it first checks
 *    the checkout can plainly complete now (store identity, tax rate, product
 *    active state, stock) AND that the fingerprint recomputed from *current*
 *    authoritative state still equals the reviewed fingerprint — a mismatch is
 *    rejected as `CHECKOUT_DRIFT` before any row is written and before any Clover
 *    instruction, so the amount shown for Clover is always the amount that
 *    passed Checkout Review (`DATA_MODEL.md §31`, `§33`, `§41B`). It then durably
 *    commits a `PENDING_PAYMENT` `checkout_requests` row (payment method `CARD`,
 *    `intended_total_cents`, no Clover confirmation) **before** returning, so the
 *    renderer may only then instruct the cashier to process that exact amount on
 *    Clover. If the commit fails, the caller is told and NOT sent to Clover — no
 *    charge is risked without a durable local trace (`REQ-RECONCILE-001`;
 *    `TEST-CARD-005A`, `TEST-CARD-008`). This pre-payment check does not replace
 *    Phase 2's authoritative drift gate.
 *  - **`completeCard`** — the cashier confirmed Clover approved (or is retrying a
 *    local save). Phase 1 Step B (`confirm approval → SUBMITTED`) commits in its
 *    own transaction; only then is the authoritative Phase 2 sale transaction
 *    (shared with Cash: {@link runSalePhase2}) attempted. A failure of Step B or
 *    Phase 2 after approval is a Priority-0 reconciliation incident, never a
 *    fabricated sale and never a plain "try again" (`§31A`; `TEST-CARD-005`,
 *    `005B`, `006`).
 *  - **`declineCard`** — "Payment Declined / Cancel". Best-effort terminal update
 *    of the same row to `COMMIT_FAILED` / `CLOVER_DECLINED`. Not an incident; the
 *    cart stays for the next attempt under a NEW request id (`§31`; `TEST-CARD-002`).
 */

export interface CardCheckoutServiceDeps {
  readonly db: Database.Database;
  readonly appVersion: string;
  /** ISO-8601 UTC clock; injectable for deterministic tests. */
  readonly now?: () => string;
}

export interface CardCheckoutService {
  beginCard(raw: unknown): BeginCardCheckoutResult;
  completeCard(raw: unknown): CompletedSaleResult;
  declineCard(raw: unknown): DeclineCardCheckoutResult;
}

export function createCardCheckoutService(deps: CardCheckoutServiceDeps): CardCheckoutService {
  const { db, appVersion } = deps;
  const now = deps.now ?? ((): string => new Date().toISOString());

  function summarize(saleId: string, alreadyCompleted: boolean): CompletedSaleResult {
    const summary = readCompletedSaleSummary(db, saleId);
    if (!summary) {
      throw new AppError('INTERNAL', 'The sale was saved but could not be read back.');
    }
    return {
      saleId: summary.saleId,
      receiptNumber: summary.receiptNumber,
      totalCents: summary.totalCents,
      paymentMethod: summary.paymentMethod,
      exportStatus: summary.exportStatus,
      alreadyCompleted,
    };
  }

  /** Common identity checks for an existing row on `complete-card` / `decline-card`. */
  function requireCardRow(requestId: string, reviewedFingerprint: string): CheckoutRequestRow {
    const row = findCheckoutRequest(db, requestId);
    if (!row || row.payment_method_snapshot !== 'CARD') {
      throw appErrors.checkoutRequestInvalid();
    }
    if (row.request_fingerprint !== reviewedFingerprint) {
      throw appErrors.idempotencyConflict();
    }
    return row;
  }

  /** Best-effort durable `CARD_LOCAL_COMMIT_FAILURE` audit (`DATA_MODEL.md §31A`, `§36A`, `§18`). */
  function recordCardCommitFailureAudit(requestId: string, failureCode: string): void {
    try {
      db.transaction(() => {
        appendAuditEvent(db, {
          eventType: 'CARD_LOCAL_COMMIT_FAILURE',
          occurredAt: now(),
          actorType: 'USER',
          outcome: 'FAILURE',
          appVersion,
          subjectType: 'CHECKOUT_REQUEST',
          subjectId: requestId,
          correlationId: requestId,
          // No card number / CVV / terminal credentials / customer PII.
          details: { failureCode },
        });
      }).immediate();
    } catch {
      /* SQLite too unhealthy for the follow-up evidence: the diagnostic log is
         the documented fallback. Never fabricate a successful sale. */
    }
  }

  function recordCardCommitFailed(requestId: string, failureCode: string): void {
    try {
      db.transaction(() => {
        markCheckoutRequestCommitFailed(db, { requestId, failureCode, failedAt: now() });
      }).immediate();
    } catch {
      /* SQLite unreachable: the Phase 1 Step A/B rows remain as durable evidence. */
    }
  }

  return {
    beginCard(raw: unknown): BeginCardCheckoutResult {
      const { requestId, reviewedFingerprint, checkout } = validateCardCheckout(raw);

      let outcome:
        | { readonly kind: 'awaiting'; readonly intendedTotalCents: number }
        | { readonly kind: 'approved'; readonly intendedTotalCents: number }
        | {
            readonly kind: 'completed';
            readonly saleId: string;
            readonly intendedTotalCents: number;
          };

      try {
        outcome = db
          .transaction(() => {
            const existing = findCheckoutRequest(db, requestId);
            if (existing) {
              if (existing.request_fingerprint !== reviewedFingerprint) {
                throw appErrors.idempotencyConflict();
              }
              if (existing.payment_method_snapshot !== 'CARD') {
                throw appErrors.checkoutRequestInvalid();
              }
              if (existing.status === 'COMPLETED') {
                return {
                  kind: 'completed' as const,
                  saleId: existing.sale_id as string,
                  intendedTotalCents: existing.intended_total_cents,
                };
              }
              if (existing.status === 'SUBMITTED') {
                // Step B already committed — a replayed begin-card; the renderer
                // should go straight to complete-card, not re-instruct Clover.
                return {
                  kind: 'approved' as const,
                  intendedTotalCents: existing.intended_total_cents,
                };
              }
              if (existing.status === 'PENDING_PAYMENT') {
                // A double-click / IPC retry of begin-card: the durable record
                // already exists; return the same intended amount.
                return {
                  kind: 'awaiting' as const,
                  intendedTotalCents: existing.intended_total_cents,
                };
              }
              // COMMIT_FAILED (declined or a reconciliation incident): this
              // request id is spent. A new attempt needs a new id; a retry of a
              // reconciliation incident goes through complete-card, not here.
              throw appErrors.checkoutRequestInvalid();
            }

            // Brand-new attempt. Refuse to create a row — and therefore refuse
            // to send the cashier to Clover — unless the checkout can plainly
            // complete now (`DATA_MODEL.md §31` Step A): store identity, tax
            // rate, product active state, and stock.
            if (!readBusinessConfig(db).configured) {
              throw appErrors.businessNotConfigured();
            }
            const recalc = recalculateCheckout(db, checkout);

            // Pre-payment fingerprint equality (Card only). The fingerprint
            // recomputed from *current* authoritative state must equal the
            // reviewed fingerprint, so `request_fingerprint` and
            // `intended_total_cents` describe the SAME reviewed transaction and
            // the Clover instruction amount is exactly the amount that passed
            // Checkout Review. A mismatch (a price or the tax rate changed since
            // review) is rejected as `CHECKOUT_DRIFT` BEFORE `PENDING_PAYMENT`
            // is written and before any Clover instruction — the cashier
            // re-reviews. This does NOT replace Phase 2's authoritative drift
            // gate, which still runs after Clover approval (`DATA_MODEL.md §31`,
            // `§41B`; `POS_WORKFLOWS.md §30`, `§33`).
            if (recalc.fingerprint !== reviewedFingerprint) {
              throw appErrors.checkoutDrift();
            }

            insertPendingCardRequest(db, {
              requestId,
              requestFingerprint: reviewedFingerprint,
              intendedTotalCents: recalc.totals.totalCents,
              createdAt: now(),
            });
            return {
              kind: 'awaiting' as const,
              intendedTotalCents: recalc.totals.totalCents,
            };
          })
          .immediate();
      } catch (error) {
        if (isAppError(error)) {
          // A precondition rejection / idempotency conflict created no new row.
          throw error;
        }
        // Step A could not commit — nothing durable exists, so checkout stops
        // and the cashier is NOT instructed to use Clover (`REQ-RECONCILE-001`;
        // `TEST-CARD-005A`).
        throw appErrors.saleCommitFailed();
      }

      if (outcome.kind === 'completed') {
        return {
          requestId,
          intendedTotalCents: outcome.intendedTotalCents,
          stage: 'completed',
          completed: summarize(outcome.saleId, true),
        };
      }
      return {
        requestId,
        intendedTotalCents: outcome.intendedTotalCents,
        stage: outcome.kind === 'approved' ? 'approved' : 'awaiting_clover',
        completed: null,
      };
    },

    completeCard(raw: unknown): CompletedSaleResult {
      const { requestId, reviewedFingerprint, checkout } = validateCardCheckout(raw);
      const row = requireCardRow(requestId, reviewedFingerprint);

      if (row.status === 'COMPLETED') {
        // Idempotent replay of "Payment Approved" / a retried IPC call.
        return summarize(row.sale_id as string, true);
      }
      if (row.status === 'COMMIT_FAILED' && row.failure_code === 'CLOVER_DECLINED') {
        // A declined attempt is terminal; a new sale needs a new request id.
        throw appErrors.checkoutRequestInvalid();
      }
      if (
        row.status !== 'PENDING_PAYMENT' &&
        row.status !== 'SUBMITTED' &&
        row.status !== 'COMMIT_FAILED'
      ) {
        throw appErrors.checkoutRequestInvalid();
      }

      // ── Phase 1, Step B — confirm Clover approval (only when still pending) ──
      if (row.status === 'PENDING_PAYMENT') {
        let confirmed: number;
        try {
          confirmed = db
            .transaction(() => confirmCardCheckoutApproval(db, { requestId, confirmedAt: now() }))
            .immediate();
        } catch {
          // Case 2: the confirmation write itself failed. The row stays
          // PENDING_PAYMENT with no approval recorded; Phase 2 is NOT attempted.
          // The cashier sees the same critical Clover-review warning because a
          // real charge may exist (`DATA_MODEL.md §31A` Case 2; `TEST-CARD-005B`).
          recordCardCommitFailureAudit(requestId, 'SALE_COMMIT_FAILED');
          throw appErrors.cardLocalCommitFailure(requestId);
        }
        if (confirmed !== 1) {
          throw appErrors.cardLocalCommitFailure(requestId);
        }
      }

      // ── Phase 2 — the authoritative sale transaction (shared with Cash) ─────
      try {
        const result = runSalePhase2(db, {
          requestId,
          checkout,
          paymentMethod: 'CARD',
          appVersion,
          occurredAt: now(),
        });
        return summarize(result.saleId, result.alreadyCompleted);
      } catch (error) {
        // Approval is already durably confirmed (or its write just failed):
        // ANY Phase 2 failure — storage OR a trusted revalidation rejection
        // (drift, stock, archived, …) — is a Card reconciliation incident, never
        // "review and run the card again" (`DATA_MODEL.md §31A`;
        // `POS_WORKFLOWS.md §35A`; task `§16`, `§17`, `§24`).
        const specificCode =
          isAppError(error) && RECORDABLE_PHASE2_FAILURE_CODES.has(error.code)
            ? error.code
            : 'SALE_COMMIT_FAILED';
        // Preserve the SPECIFIC failure reason on the row; the renderer-facing
        // category is CARD_LOCAL_COMMIT_FAILURE (`§16`). `clover_approved_confirmed_at`
        // is never cleared by this update.
        recordCardCommitFailed(requestId, specificCode);
        recordCardCommitFailureAudit(requestId, specificCode);
        throw appErrors.cardLocalCommitFailure(requestId);
      }
    },

    declineCard(raw: unknown): DeclineCardCheckoutResult {
      const { requestId, reviewedFingerprint } = validateDeclineCard(raw);
      const row = requireCardRow(requestId, reviewedFingerprint);

      if (row.status === 'COMMIT_FAILED' && row.failure_code === 'CLOVER_DECLINED') {
        return { requestId, declined: true }; // idempotent
      }
      if (row.status !== 'PENDING_PAYMENT') {
        // Cannot decline after approval / completion.
        throw appErrors.checkoutRequestInvalid();
      }

      try {
        const changed = db
          .transaction(() => markCardCheckoutDeclined(db, { requestId, failedAt: now() }))
          .immediate();
        if (changed !== 1) {
          throw appErrors.checkoutRequestInvalid();
        }
      } catch (error) {
        if (isAppError(error)) {
          throw error;
        }
        // Best-effort per `POS_WORKFLOWS.md §31`; the cart stays available.
        throw appErrors.saleCommitFailed();
      }
      return { requestId, declined: true };
    },
  };
}
