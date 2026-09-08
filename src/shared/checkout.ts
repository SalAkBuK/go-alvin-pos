/**
 * Shared Checkout / Cart-review contract (Phase 2D).
 *
 * Pure TypeScript types + string constants, dependency-free, so the same
 * definitions bundle into the main process, the sandboxed preload, and the
 * renderer. These are the ONLY checkout shapes that cross the IPC boundary.
 *
 * SCOPE: the temporary checkout cart and its *authoritative review* only. This
 * phase completes no sale — there is deliberately no `checkout:complete`
 * channel, no payment persistence, and no `sales` / `sale_items` / `payments` /
 * `checkout_requests` shape here. The reviewed values and the deterministic
 * `fingerprint` are the primitives a later phase's durable checkout flow will
 * re-validate at commit (`DATA_MODEL.md §41B`, `REQ-SALE-014`).
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
