import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CompletedSaleResult } from '../../shared/checkout';
import type { AppErrorCode } from '../../shared/products';
import { appendAuditEvent } from '../audit/appendAuditEvent';
import { readCurrentQuantity, setProductQuantity } from '../products/productRepository';
import { insertMovement } from '../inventory/inventoryRepository';
import { readBusinessConfig } from '../settings/settingsService';
import { AppError, appErrors, isAppError } from '../shared/appError';
import { aggregateQuantityByProduct, recalculateCheckout } from './checkoutRecalculation';
import {
  findCheckoutRequest,
  insertSubmittedCashRequest,
  markCheckoutRequestCommitFailed,
  markCheckoutRequestCompleted,
} from './checkoutRequestRepository';
import {
  allocateReceiptNumber,
  insertExportJob,
  insertPayment,
  insertSale,
  insertSaleItem,
  readCompletedSaleSummary,
} from './saleRepository';
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
 *  - **Phase 2** — the authoritative `BEGIN IMMEDIATE` sale transaction: the
 *    single authoritative drift gate (`§41B`), plus the receipt number, sale,
 *    sale items, payment, inventory deduction, SALE movements, the durable
 *    `PENDING` Google export job, the `SALE_COMPLETED` (and any `PRICE_OVERRIDE`)
 *    audit events, and the `checkout_requests` → `COMPLETED` transition, all
 *    together or not at all.
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
 * case (that stays Card-specific: `DATA_MODEL.md §31A`-`§31B`). Card,
 * `PENDING_PAYMENT`, the reconciliation queue, receipt printing, and the export
 * worker are NOT here.
 */

/**
 * Typed Phase 2 rejections that mean "the authoritative sale transaction began
 * from an eligible request and rolled back with nothing written". Each is
 * recorded on the `checkout_requests` row as `COMMIT_FAILED` with itself as the
 * stable `failure_code` (`DATA_MODEL.md §31`, `§33`; `SUPPORT_DIAGNOSTICS.md
 * §42`), then re-thrown unchanged. `CHECKOUT_REQUEST_INVALID` and
 * `IDEMPOTENCY_CONFLICT` are deliberately excluded: they mean the request was
 * not in an eligible state, so its status must not be rewritten.
 */
const RECORDABLE_PHASE2_FAILURE_CODES: ReadonlySet<AppErrorCode> = new Set<AppErrorCode>([
  'CHECKOUT_DRIFT',
  'INSUFFICIENT_STOCK',
  'PRODUCT_ARCHIVED',
  'PRODUCT_NOT_FOUND',
  'CUSTOMER_NOT_FOUND',
  'TAX_RATE_NOT_CONFIGURED',
  'BUSINESS_NOT_CONFIGURED',
  'CHECKOUT_TOTAL_EXCEEDED',
  'VALIDATION',
]);

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

type Phase2Result = { readonly saleId: string; readonly alreadyCompleted: boolean };

interface PriceOverride {
  readonly productId: string;
  readonly productName: string;
  readonly listedPriceCents: number;
  readonly soldPriceCents: number;
  readonly quantity: number;
}

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

  /** Phase 2 — the authoritative sale transaction. */
  function runPhase2(payload: ValidatedCompleteCashSale, occurredAt: string): Phase2Result {
    const { requestId, checkout } = payload;
    return db
      .transaction((): Phase2Result => {
        const row = findCheckoutRequest(db, requestId);
        if (!row) {
          throw new Error('checkout_requests row missing at Phase 2');
        }
        if (row.status === 'COMPLETED') {
          return { saleId: row.sale_id as string, alreadyCompleted: true };
        }
        if (row.status !== 'SUBMITTED' && row.status !== 'COMMIT_FAILED') {
          throw appErrors.checkoutRequestInvalid();
        }

        const recalc = recalculateCheckout(db, checkout);
        if (recalc.fingerprint !== row.request_fingerprint) {
          throw appErrors.checkoutDrift();
        }

        const business = readBusinessConfig(db);
        if (!business.configured) {
          throw appErrors.businessNotConfigured();
        }

        const customer = recalc.customer;
        const saleId = randomUUID();
        const receipt = allocateReceiptNumber(db, occurredAt);

        insertSale(db, {
          id: saleId,
          receiptNumber: receipt.receiptNumber,
          customerId: customer ? customer.id : null,
          customerNameSnapshot: customer ? customer.name : null,
          customerPhoneSnapshot: customer ? customer.phone : null,
          businessNameSnapshot: business.businessName,
          businessAddressSnapshot: business.businessAddress,
          businessPhoneSnapshot: business.businessPhone,
          receiptDisclaimerSnapshot: business.receiptDisclaimer,
          receiptFooterSnapshot: business.receiptFooter,
          subtotalCents: recalc.totals.subtotalCents,
          discountCents: recalc.totals.discountCents,
          taxableAmountCents: recalc.totals.taxableAmountCents,
          taxRateBps: recalc.totals.taxRateBps,
          taxCents: recalc.totals.taxCents,
          totalCents: recalc.totals.totalCents,
          paymentMethodSnapshot: 'CASH',
          // `created_at` = when checkout began: the Phase 1 request row's own
          // commit-time timestamp — the earliest trusted, durable instant for
          // this checkout (the pre-submission draft cart is not persisted).
          // `completed_at` = this Phase 2 instant (`DATA_MODEL.md §4`).
          createdAt: row.created_at,
          completedAt: occurredAt,
        });

        const overrides: PriceOverride[] = [];
        for (const { product, canonical } of recalc.orderedLines) {
          const listed = canonical.listedPriceCents;
          const sold = canonical.soldPriceCents;
          const quantity = canonical.quantity;
          insertSaleItem(db, {
            id: randomUUID(),
            saleId,
            productId: product.id,
            productNameSnapshot: product.name,
            brandSnapshot: product.brand,
            modelSnapshot: product.model,
            conditionSnapshot: product.condition,
            skuSnapshot: product.sku,
            barcodeSnapshot: product.barcode,
            listedPriceCents: listed,
            soldPriceCents: sold,
            discountCents: Math.max(0, listed - sold) * quantity,
            quantity,
            lineSubtotalCents: listed * quantity,
            lineTotalCents: sold * quantity,
            createdAt: occurredAt,
          });
          if (sold !== listed) {
            overrides.push({
              productId: product.id,
              productName: product.name,
              listedPriceCents: listed,
              soldPriceCents: sold,
              quantity,
            });
          }
        }

        insertPayment(db, {
          id: randomUUID(),
          saleId,
          method: 'CASH',
          amountCents: recalc.totals.totalCents,
          createdAt: occurredAt,
        });

        // One quantity update + one SALE movement per product; duplicate cart
        // lines are aggregated for the deduction only (`§41A`).
        for (const { product, quantity } of aggregateQuantityByProduct(
          recalc.orderedLines,
        ).values()) {
          const before = readCurrentQuantity(db, product.id);
          if (before === null) {
            throw appErrors.productNotFound();
          }
          const after = before - quantity;
          if (after < 0) {
            throw appErrors.insufficientStock(product.name, before);
          }
          setProductQuantity(db, product.id, after, occurredAt);
          insertMovement(db, {
            id: randomUUID(),
            productId: product.id,
            saleId,
            movementType: 'SALE',
            reversesMovementId: null,
            quantityChange: -quantity,
            quantityBefore: before,
            quantityAfter: after,
            // The SALE movement_type + non-null sale_id are the reason it
            // changed; no free-text reason is synthesised (`§17`).
            reason: null,
            createdAt: occurredAt,
          });
        }

        insertExportJob(db, { id: randomUUID(), saleId, createdAt: occurredAt });

        appendAuditEvent(db, {
          eventType: 'SALE_COMPLETED',
          occurredAt,
          actorType: 'USER',
          outcome: 'SUCCESS',
          appVersion,
          subjectType: 'SALE',
          subjectId: saleId,
          correlationId: requestId,
          details: {
            receiptNumber: receipt.receiptNumber,
            totalCents: recalc.totals.totalCents,
            paymentMethod: 'CASH',
            lineCount: recalc.orderedLines.length,
            customerAttached: customer !== null,
            taxRateBps: recalc.totals.taxRateBps,
            taxCents: recalc.totals.taxCents,
          },
        });

        if (overrides.length > 0) {
          // One PRICE_OVERRIDE event per sale, listing every overridden line
          // unambiguously — canon fixes no cardinality, so the narrowest
          // representation that loses nothing is used. A line whose sold price
          // differs from listed *in either direction* is an override (`§21`,
          // `§41`); this is not the same as `discount_cents > 0`.
          appendAuditEvent(db, {
            eventType: 'PRICE_OVERRIDE',
            occurredAt,
            actorType: 'USER',
            outcome: 'SUCCESS',
            appVersion,
            subjectType: 'SALE',
            subjectId: saleId,
            correlationId: requestId,
            details: { receiptNumber: receipt.receiptNumber, overrides },
          });
        }

        markCheckoutRequestCompleted(db, { requestId, saleId, completedAt: occurredAt });
        return { saleId, alreadyCompleted: false };
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
      let result: Phase2Result;
      try {
        result = runPhase2(payload, occurredAt);
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
