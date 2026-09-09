/**
 * Shared Checkout contract (Phase 2D cart review + Phase 2E Cash completion).
 *
 * Pure TypeScript types + string constants, dependency-free, so the same
 * definitions bundle into the main process, the sandboxed preload, and the
 * renderer. These are the ONLY checkout shapes that cross the IPC boundary.
 *
 * SCOPE: the temporary checkout cart, its *authoritative review* (Phase 2D),
 * and *Cash* sale completion (Phase 2E). Card/Clover completion, `PENDING_PAYMENT`,
 * the reconciliation queue, receipt printing, sales history, and voids are NOT
 * defined here. The reviewed values and the deterministic `fingerprint` are the
 * primitives the Cash completion flow re-validates at commit (`DATA_MODEL.md
 * §41B`, `REQ-SALE-014`).
 *
 * The typed result envelope (`IpcResult` / `IpcError`) and error codes are
 * reused from `./products` — the shared cross-slice contract.
 */

import type { CustomerRecord } from './customers';
import type { ProductCondition } from './products';

/** V1 payment methods (`DATA_MODEL.md §16`). In Phase 2D this is review state only. */
export const PAYMENT_METHODS = ['CASH', 'CARD'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Per-line quantity bounds (`DATA_MODEL.md §41A`). */
export const CART_LINE_QUANTITY_MIN = 1;
export const CART_LINE_QUANTITY_MAX = 999;

/** Guard against a pathologically large payload; ordinary phone retail is far below this. */
export const CART_MAX_LINES = 200;

/**
 * The user *intent* the renderer submits for one cart line. It carries no
 * listed price and no derived totals: the trusted layer loads the authoritative
 * listed price from SQLite and derives every monetary value itself
 * (`DATA_MODEL.md §43`, `§41B`).
 */
export interface CheckoutLineIntent {
  readonly productId: string;
  readonly quantity: number;
  readonly soldPriceCents: number;
}

/** `checkout:review` payload — normalized checkout intent. */
export interface CheckoutReviewRequest {
  readonly customerId: string | null;
  readonly paymentMethod: PaymentMethod;
  readonly lines: readonly CheckoutLineIntent[];
}

/** One reviewed cart line, every value recomputed by the trusted layer. */
export interface CheckoutReviewLine {
  readonly productId: string;
  readonly name: string;
  readonly brand: string;
  readonly model: string;
  readonly condition: ProductCondition;
  readonly sku: string | null;
  readonly barcode: string | null;
  /** Authoritative current product `selling_price_cents`, never renderer-supplied. */
  readonly listedPriceCents: number;
  readonly soldPriceCents: number;
  readonly quantity: number;
  /** `listed_price_cents × quantity`. */
  readonly lineListedSubtotalCents: number;
  /** `max(0, listed − sold) × quantity` — clamped at zero, never negative (`§41`). */
  readonly lineDiscountCents: number;
  /** `sold_price_cents × quantity`. */
  readonly lineTotalCents: number;
}

/**
 * The authoritative checkout review. Lines are returned in the canonical order
 * defined by `DATA_MODEL.md §41B` — `(product_id, listed_price_cents,
 * sold_price_cents, quantity)` ascending — the same order the `fingerprint` is
 * computed over.
 */
export interface CheckoutReview {
  readonly customerId: string | null;
  readonly customer: CustomerRecord | null;
  readonly paymentMethod: PaymentMethod;
  readonly lines: readonly CheckoutReviewLine[];
  /** Σ(listed_price_cents × quantity). */
  readonly subtotalCents: number;
  /** Σ(max(0, listed − sold) × quantity). */
  readonly discountCents: number;
  /** Σ(sold_price_cents × quantity) — the tax basis (`§42`). */
  readonly taxableAmountCents: number;
  readonly taxRateBps: number;
  /** floor((taxable × bps + 5000) / 10000) — round-half-up (`§42`). */
  readonly taxCents: number;
  /** taxable_amount_cents + tax_cents. */
  readonly totalCents: number;
  /** Deterministic digest of the normalized intent (`§41B`). */
  readonly fingerprint: string;
}

// ── Phase 2E: Cash sale completion ──────────────────────────────────────────

/**
 * `checkout:complete-cash` payload.
 *
 * The renderer submits the checkout *intent* it reviewed (`checkout`), the
 * deterministic `reviewedFingerprint` the trusted layer returned from
 * `checkout:review`, and a stable `requestId` it generated for this completion
 * attempt (`POS_WORKFLOWS.md §33`, `DATA_MODEL.md §31`, `§32`). It never sends
 * authoritative money, a receipt number, a Sale ID, or product snapshots — the
 * trusted layer recomputes all of that from current SQLite state and rejects the
 * attempt if anything drifted from `reviewedFingerprint` (`REQ-SALE-014`).
 *
 * The same `requestId` retried with the same `reviewedFingerprint` is idempotent
 * (returns the existing sale, or re-attempts Phase 2 after a commit failure);
 * the same `requestId` with a different fingerprint is an `IDEMPOTENCY_CONFLICT`.
 */
export interface CompleteCashSaleRequest {
  readonly requestId: string;
  readonly reviewedFingerprint: string;
  readonly checkout: CheckoutReviewRequest;
}

/** Whether the sale's single durable Google Sheets export job is still queued. */
export type SaleExportStatus = 'PENDING' | 'EXPORTING' | 'EXPORTED' | 'FAILED';

/**
 * The result of a successful (or idempotently replayed) Cash completion —
 * exactly what the success screen needs (`POS_WORKFLOWS.md §37`). No customer
 * PII, no payment detail beyond method + amount.
 */
export interface CompletedSaleResult {
  readonly saleId: string;
  readonly receiptNumber: string;
  readonly totalCents: number;
  readonly paymentMethod: PaymentMethod;
  readonly exportStatus: SaleExportStatus;
  /**
   * `true` when this call did not create the sale — it returned an existing one
   * for a repeated/retried `requestId` (double-click, IPC retry, restart replay).
   */
  readonly alreadyCompleted: boolean;
}

// ── Phase 2F: Manual Clover Card workflow ───────────────────────────────────

/**
 * `checkout:begin-card` payload — Phase 1 Step A for a reviewed Card checkout
 * (`DATA_MODEL.md §31`, `§31A`; `POS_WORKFLOWS.md §30`; `REQ-RECONCILE-001`).
 *
 * Identical shape to {@link CompleteCashSaleRequest} but `checkout.paymentMethod`
 * MUST be `CARD`. The trusted layer durably commits a `PENDING_PAYMENT`
 * `checkout_requests` row **before** returning — only then may the renderer show
 * the Clover instruction. It never sends an amount; `intendedTotalCents` comes
 * back from the trusted recalculation.
 */
export interface BeginCardCheckoutRequest {
  readonly requestId: string;
  readonly reviewedFingerprint: string;
  readonly checkout: CheckoutReviewRequest;
}

/**
 * Result of a committed Phase 1 Step A (or an idempotent replay of one). The
 * renderer shows "Process $<intendedTotalCents> on Clover" using ONLY this
 * trusted amount.
 *
 *  - `stage = 'awaiting_clover'` — a fresh `PENDING_PAYMENT` row is on record
 *    (or a still-pending one was replayed); ask the cashier for the Clover result.
 *  - `stage = 'approved'` — Step B already committed for this request
 *    (`SUBMITTED`); the renderer should proceed straight to `complete-card`.
 *  - `stage = 'completed'` — the sale already exists for this request; treat it
 *    as an idempotent success.
 */
export interface BeginCardCheckoutResult {
  readonly requestId: string;
  readonly intendedTotalCents: number;
  readonly stage: 'awaiting_clover' | 'approved' | 'completed';
  /** Present only when `stage = 'completed'`. */
  readonly completed: CompletedSaleResult | null;
}

/**
 * `checkout:complete-card` payload — the cashier confirmed Clover approved (or
 * is retrying a local save after a commit failure). The trusted layer commits
 * Phase 1 Step B (only if the row is still `PENDING_PAYMENT`) in its own
 * transaction, then attempts the authoritative Phase 2 sale transaction. Same
 * `requestId` from `begin-card`; never a new one.
 */
export interface CompleteCardCheckoutRequest {
  readonly requestId: string;
  readonly reviewedFingerprint: string;
  readonly checkout: CheckoutReviewRequest;
}

/**
 * `checkout:decline-card` payload — the cashier chose "Payment Declined /
 * Cancel". The trusted layer best-effort marks the same `PENDING_PAYMENT` row
 * `COMMIT_FAILED` / `CLOVER_DECLINED` (`POS_WORKFLOWS.md §31`). Not a
 * reconciliation incident.
 */
export interface DeclineCardCheckoutRequest {
  readonly requestId: string;
  readonly reviewedFingerprint: string;
}

export interface DeclineCardCheckoutResult {
  readonly requestId: string;
  readonly declined: true;
}
