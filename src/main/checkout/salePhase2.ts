import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { PaymentMethod } from '../../shared/checkout';
import type { AppErrorCode } from '../../shared/products';
import { appendAuditEvent } from '../audit/appendAuditEvent';
import { insertMovement } from '../inventory/inventoryRepository';
import { readCurrentQuantity, setProductQuantity } from '../products/productRepository';
import { readBusinessConfig } from '../settings/settingsService';
import { appErrors } from '../shared/appError';
import { aggregateQuantityByProduct, recalculateCheckout } from './checkoutRecalculation';
import type { ValidatedCheckoutRequest } from './checkoutValidation';
import { findCheckoutRequest, markCheckoutRequestCompleted } from './checkoutRequestRepository';
import {
  allocateReceiptNumber,
  insertExportJob,
  insertPayment,
  insertSale,
  insertSaleItem,
} from './saleRepository';

/**
 * The single authoritative Phase 2 sale transaction, shared by Cash completion
 * (`saleService`) and Card completion (`cardCheckoutService`) so there is exactly
 * one place that writes a committed sale (`ARCHITECTURE.md §15`, `§15A`;
 * `DATA_MODEL.md §31`, `§41B`, `§44-49`, `§60-61`; `POS_WORKFLOWS.md §33`;
 * task Phase 2F `§14`).
 *
 * It runs inside its own `BEGIN IMMEDIATE`. It is entered ONLY from an eligible
 * (`SUBMITTED`, or `COMMIT_FAILED` for a same-request retry) `checkout_requests`
 * row — never from `PENDING_PAYMENT` (a Card row whose Clover approval has not
 * been confirmed via Phase 1 Step B is not eligible). It atomically creates the
 * receipt number, sale, sale items, payment, inventory deduction, SALE movements,
 * the `PENDING` Google export job, the `SALE_COMPLETED` (and any `PRICE_OVERRIDE`)
 * audit events, and the `checkout_requests → COMPLETED` transition — together or
 * not at all.
 *
 * Payment-method-specific behaviour:
 *  - `payments.method` / `payment_method_snapshot` / audit `paymentMethod` = the
 *    passed method.
 *  - For `CARD`, the authoritative recalculated total MUST equal the amount the
 *    cashier processed on Clover (`checkout_requests.intended_total_cents`) or the
 *    attempt is rejected as drift rather than committing a different amount
 *    (`DATA_MODEL.md §41B`; `REQ-SALE-014`; `TEST-IDEMP-007`).
 *  - For a `CARD` retry that started from a reconciliation incident
 *    (`COMMIT_FAILED`, not `CLOVER_DECLINED`), the same transaction also closes
 *    the reconciliation entry: `resolution_note = "Completed on retry"`
 *    (`DATA_MODEL.md §31B` step 4; `REQ-RECONCILE-006`; `TEST-CARD-006`).
 *
 * Typed `AppError`s thrown here are trusted revalidation rejections (the
 * transaction rolled back with nothing written); a non-`AppError` throw is an
 * unexpected/storage failure. The caller records the outcome on the Phase 1 row.
 */

export interface SalePhase2Args {
  readonly requestId: string;
  readonly checkout: ValidatedCheckoutRequest;
  readonly paymentMethod: PaymentMethod;
  readonly appVersion: string;
  /** The Phase 2 commit instant (ISO-8601 UTC). */
  readonly occurredAt: string;
}

export interface SalePhase2Result {
  readonly saleId: string;
  readonly alreadyCompleted: boolean;
}

interface PriceOverride {
  readonly productId: string;
  readonly productName: string;
  readonly listedPriceCents: number;
  readonly soldPriceCents: number;
  readonly quantity: number;
}

export const RESOLUTION_NOTE_COMPLETED_ON_RETRY = 'Completed on retry';

/**
 * Typed Phase 2 rejections that mean "the authoritative sale transaction began
 * from an eligible request and rolled back with nothing written". Each is
 * recorded on the `checkout_requests` row as `COMMIT_FAILED` with itself as the
 * stable `failure_code` (`DATA_MODEL.md §31`, `§33`; `SUPPORT_DIAGNOSTICS.md
 * §42`). `CHECKOUT_REQUEST_INVALID` and `IDEMPOTENCY_CONFLICT` are deliberately
 * excluded: they mean the request was not in an eligible state, so its status
 * must not be rewritten. Shared by Cash and Card completion.
 */
export const RECORDABLE_PHASE2_FAILURE_CODES: ReadonlySet<AppErrorCode> = new Set<AppErrorCode>([
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

export function runSalePhase2(db: Database.Database, args: SalePhase2Args): SalePhase2Result {
  const { requestId, checkout, paymentMethod, appVersion, occurredAt } = args;

  return db
    .transaction((): SalePhase2Result => {
      const row = findCheckoutRequest(db, requestId);
      if (!row) {
        throw new Error('checkout_requests row missing at Phase 2');
      }
      if (row.status === 'COMPLETED') {
        return { saleId: row.sale_id as string, alreadyCompleted: true };
      }
      if (row.status !== 'SUBMITTED' && row.status !== 'COMMIT_FAILED') {
        // PENDING_PAYMENT (Card, approval not confirmed) is not eligible — the
        // only path past it is Phase 1 Step B (`DATA_MODEL.md §31`, `§33`).
        throw appErrors.checkoutRequestInvalid();
      }
      if (row.payment_method_snapshot !== paymentMethod) {
        throw appErrors.checkoutRequestInvalid();
      }

      const recalc = recalculateCheckout(db, checkout);
      if (recalc.fingerprint !== row.request_fingerprint) {
        throw appErrors.checkoutDrift();
      }

      // Card strict amount invariant: the local sale must never commit for a
      // different total than the cashier processed on Clover (`DATA_MODEL.md
      // §41B`; `TEST-IDEMP-007`). The fingerprint check already covers this for
      // an honest client, but the stored intended total is the authoritative
      // record of what was charged, so it is compared explicitly.
      if (paymentMethod === 'CARD' && recalc.totals.totalCents !== row.intended_total_cents) {
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
        paymentMethodSnapshot: paymentMethod,
        // `created_at` = when checkout began: the Phase 1 request row's own
        // commit-time timestamp. `completed_at` = this Phase 2 instant
        // (`DATA_MODEL.md §4`).
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
        method: paymentMethod,
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
          paymentMethod,
          lineCount: recalc.orderedLines.length,
          customerAttached: customer !== null,
          taxRateBps: recalc.totals.taxRateBps,
          taxCents: recalc.totals.taxCents,
        },
      });

      if (overrides.length > 0) {
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

      // A Card retry that started from a reconciliation incident closes it in
      // the same authoritative transaction (`DATA_MODEL.md §31B` step 4).
      const closesIncident =
        paymentMethod === 'CARD' &&
        row.status === 'COMMIT_FAILED' &&
        row.failure_code !== 'CLOVER_DECLINED';

      markCheckoutRequestCompleted(db, {
        requestId,
        saleId,
        completedAt: occurredAt,
        ...(closesIncident
          ? { resolution: { note: RESOLUTION_NOTE_COMPLETED_ON_RETRY, resolvedAt: occurredAt } }
          : {}),
      });

      return { saleId, alreadyCompleted: false };
    })
    .immediate();
}
