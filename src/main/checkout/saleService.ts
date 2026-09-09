import type Database from 'better-sqlite3';
import type { CompletedSaleResult } from '../../shared/checkout';
import { readBusinessConfig } from '../settings/settingsService';
import { AppError, appErrors, isAppError } from '../shared/appError';
import { recalculateCheckout } from './checkoutRecalculation';
import {
  findCheckoutRequest,
  insertSubmittedCashRequest,
  markCheckoutRequestCommitFailed,
} from './checkoutRequestRepository';
import { readCompletedSaleSummary } from './saleRepository';
import { RECORDABLE_PHASE2_FAILURE_CODES, runSalePhase2 } from './salePhase2';
import { validateCompleteCashSale } from './saleValidation';
import type { ValidatedCompleteCashSale } from './saleValidation';

/**
 * The first slice that writes an authoritative completed sale — Cash only
 * (`POS_WORKFLOWS.md §28`, `§33`-`§37`; `DATA_MODEL.md §31`-`§34`, `§41B`,
 * `§44-49`, `§60-61`; `ARCHITECTURE.md §15`, `§15A`; `REQ-SALE-008`,
 * `REQ-SALE-010`, `REQ-SALE-014`, `REQ-INV-002/003/005`, `REQ-RECNO-*`,
 * `REQ-GSHEET-001/002`, `REQ-AUDIT-002/004`).
 *
 * Completion is two phases, each its own independently committed transaction:
 *
 *  - **Phase 1 (Step A)** — a tiny `BEGIN IMMEDIATE` that verifies the store's
 *    business identity is configured (before any row is created — a store that
 *    cannot complete a sale never leaves a stranded `SUBMITTED`), resolves the
 *    idempotency key, rejects a request whose preconditions are already broken
 *    at submission, and durably records the `checkout_requests` row as
 *    `SUBMITTED`. Cash has no Step B (no external payment confirmation).
 *  - **Phase 2** — the authoritative `BEGIN IMMEDIATE` sale transaction, now
 *    shared with Card completion in {@link runSalePhase2}: the single
 *    authoritative drift gate (`§41B`), plus the receipt number, sale, sale
 *    items, payment, inventory deduction, SALE movements, the durable `PENDING`
 *    Google export job, the `SALE_COMPLETED` (and any `PRICE_OVERRIDE`) audit
 *    events, and the `checkout_requests` → `COMPLETED` transition, all together
 *    or not at all.
 *
 * Any Phase 2 attempt that begins from an eligible request and rolls back — an
 * unexpected/storage failure OR a trusted revalidation rejection (drift, stock,
 * archived, tax/business not configured) — is followed by a separate best-effort
 * update of that same Phase 1 row to `COMMIT_FAILED` with a stable `failure_code`:
 * `SALE_COMMIT_FAILED` for a storage failure, the specific typed code otherwise
 * (`DATA_MODEL.md §31` "Phase 2 failure", `§33`; `POS_WORKFLOWS.md §33`;
 * `SUPPORT_DIAGNOSTICS.md §42`). A typed rejection is still re-thrown unchanged
 * so the renderer knows whether re-review, a Settings fix, or a same-attempt
 * retry is next. `SUBMITTED` means "currently eligible for Phase 2"; a request
 * rejected in Phase 2 does not linger there. For Cash a `COMMIT_FAILED` row is
 * terminal/retry evidence only — it is not an external-payment reconciliation
 * case (that stays Card-specific: `DATA_MODEL.md §31A`-`§31B`). Card Phase 1
 * (`PENDING_PAYMENT`, Step B), `checkout:complete-card`, the reconciliation
 * queue, receipt printing, and the export worker are NOT here — this service
 * remains the Cash entrypoint only.
 */

export interface SaleServiceDeps {
  readonly db: Database.Database;
  readonly appVersion: string;
  /** ISO-8601 UTC clock; injectable for deterministic tests. */
  readonly now?: () => string;
}

export interface SaleService {
  completeCashSale(raw: unknown): CompletedSaleResult;
}

type Phase1Result =
  { readonly kind: 'ready' } | { readonly kind: 'completed'; readonly saleId: string };

export function createSaleService(deps: SaleServiceDeps): SaleService {
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

  /**
   * Best-effort transition of the Phase 1 row to `COMMIT_FAILED` after a Phase 2
   * attempt rolled back, written in its own tiny transaction so it survives
   * independently of the failed sale transaction (`DATA_MODEL.md §31` "Phase 2
   * failure — record the outcome", `§33`). The repository guard
   * (`WHERE status IN ('SUBMITTED', 'COMMIT_FAILED')`) means a `PENDING_PAYMENT`
   * Card row, a `COMPLETED` row, or a missing row is never mutated here. If
   * SQLite is unreachable, the Phase 1 `SUBMITTED` row remains as durable
   * evidence and diagnostics record the failure.
   */
  function recordCommitFailed(requestId: string, failureCode: string): void {
    try {
      db.transaction(() => {
        markCheckoutRequestCommitFailed(db, { requestId, failureCode, failedAt: now() });
      }).immediate();
    } catch {
      /* SQLite unreachable: the Phase 1 SUBMITTED row is the durable evidence */
    }
  }

  /** Phase 1, Step A — durable checkout request (its own committed transaction). */
  function runPhase1(payload: ValidatedCompleteCashSale): Phase1Result {
    const { requestId, reviewedFingerprint, checkout } = payload;
    return db
      .transaction((): Phase1Result => {
        const existing = findCheckoutRequest(db, requestId);

        if (existing) {
          if (existing.request_fingerprint !== reviewedFingerprint) {
            throw appErrors.idempotencyConflict();
          }
          if (existing.payment_method_snapshot !== 'CASH') {
            throw appErrors.checkoutRequestInvalid();
          }
          if (existing.status === 'COMPLETED') {
            // Idempotent replay: the sale already exists, so this must still
            // succeed even if store configuration has changed since.
            return { kind: 'completed', saleId: existing.sale_id as string };
          }
          if (existing.status === 'PENDING_PAYMENT') {
            throw appErrors.checkoutRequestInvalid();
          }
          // SUBMITTED or COMMIT_FAILED: eligible for a Phase 2 (re-)attempt.
          // Phase 2 is the sole authoritative gate for stock / archived / tax /
          // business-config / drift, so a rejection on retry is recorded as
          // `COMMIT_FAILED` (`DATA_MODEL.md §31` Phase 2 step 5, `§41B`).
          return { kind: 'ready' };
        }

        // A brand-new request. Store identity must be complete before the
        // `SUBMITTED` row is inserted — a Cash sale can never complete without
        // it (`DATA_MODEL.md §19`, `§31`; `POS_WORKFLOWS.md §33`, `§69`) —
        // so no `SUBMITTED` row is ever stranded for a store that structurally
        // cannot check out. Phase 2 re-checks this against a mid-flight change.
        if (!readBusinessConfig(db).configured) {
          throw appErrors.businessNotConfigured();
        }

        // Recalculate for the intended total and to reject a request whose
        // preconditions are already broken at submission (archived product,
        // insufficient stock, no tax rate) *before* a row exists — cleaner than
        // creating an immediately-ineligible `SUBMITTED` row.
        const recalc = recalculateCheckout(db, checkout);
        insertSubmittedCashRequest(db, {
          requestId,
          requestFingerprint: reviewedFingerprint,
          intendedTotalCents: recalc.totals.totalCents,
          createdAt: now(),
        });
        return { kind: 'ready' };
      })
      .immediate();
  }

  return {
    completeCashSale(raw: unknown): CompletedSaleResult {
      const payload = validateCompleteCashSale(raw);

      // ── Phase 1, Step A ──────────────────────────────────────────────────
      let phase1: Phase1Result;
      try {
        phase1 = runPhase1(payload);
      } catch (error) {
        // A rejection (business not configured, idempotency conflict, or a
        // precondition already broken at submission) is re-thrown as-is and
        // created no row; anything else means Phase 1 could not commit —
        // nothing was recorded, so checkout stops (`DATA_MODEL.md §31`).
        if (isAppError(error)) {
          throw error;
        }
        throw appErrors.saleCommitFailed();
      }
      if (phase1.kind === 'completed') {
        return summarize(phase1.saleId, true);
      }

      // ── Phase 2 — authoritative sale transaction ─────────────────────────
      // Phase 1 returned `ready`, so the row exists, is CASH, carries the
      // reviewed fingerprint, and is SUBMITTED or COMMIT_FAILED — i.e. it is
      // legitimately eligible for this Phase 2 attempt. Any rollback below is
      // therefore recorded on that same row, never on an unrelated one.
      const occurredAt = now();
      let result: { readonly saleId: string; readonly alreadyCompleted: boolean };
      try {
        result = runSalePhase2(db, {
          requestId: payload.requestId,
          checkout: payload.checkout,
          paymentMethod: 'CASH',
          appVersion,
          occurredAt,
        });
      } catch (error) {
        if (isAppError(error)) {
          // A trusted, typed Phase 2 rejection: the authoritative transaction
          // rolled back with nothing written. Record the outcome on the Phase 1
          // row so it does not linger as a misleading `SUBMITTED`
          // (`DATA_MODEL.md §31` "Phase 2 failure", `§33`), then re-throw the
          // typed error unchanged so the renderer still knows whether re-review,
          // a Settings fix, or a retry is the right next step.
          if (RECORDABLE_PHASE2_FAILURE_CODES.has(error.code)) {
            recordCommitFailed(payload.requestId, error.code);
          }
          throw error;
        }
        // An unexpected / storage failure: nothing from Phase 2 survived.
        recordCommitFailed(payload.requestId, 'SALE_COMMIT_FAILED');
        throw appErrors.saleCommitFailed();
      }

      return summarize(result.saleId, result.alreadyCompleted);
    },
  };
}
