import { createHash } from 'node:crypto';
import type { PaymentMethod } from '../../shared/checkout';
import { canonicalLineOrder } from './checkoutCalculation';
import type { CanonicalLine } from './checkoutCalculation';

/**
 * Deterministic checkout fingerprint (`DATA_MODEL.md §41B`).
 *
 * ## Serialization
 *
 * The normalized intent is encoded as a single `JSON.stringify` of a
 * fixed-length, fixed-order array of primitives:
 *
 * ```text
 * [ "gpp.checkout.fingerprint.v1",
 *   customerId | null,
 *   [ [product_id, listed_price_cents, sold_price_cents, quantity], ... ],  // canonically ordered
 *   tax_rate_bps,
 *   subtotal_cents, discount_cents, taxable_amount_cents, tax_cents, total_cents,
 *   payment_method ]
 * ```
 *
 * A JSON array (not an object) is used precisely because array element order is
 * guaranteed by the serializer and there is no object-key-ordering ambiguity.
 * Every numeric field is a validated integer, so `JSON.stringify` emits a
 * canonical base-10 form with no floating-point formatting variance; strings are
 * JSON-escaped. The cart-line sub-array is produced by `canonicalLineOrder`, so
 * the same multiset of lines always serializes identically regardless of the
 * order the cashier added them, and exact-duplicate tuples are preserved as
 * separate elements.
 *
 * ## Digest
 *
 * SHA-256 over the UTF-8 serialization, hex-encoded, via Node's built-in
 * `node:crypto` — no new dependency and no native addon beyond what Electron
 * already ships. SHA-256 is stable across platforms and Node/Electron versions
 * and is collision-resistant, so the resulting hex string is safe to persist
 * later as `checkout_requests.request_fingerprint` and to compare byte-for-byte
 * during commit-time drift detection.
 */

export interface CheckoutFingerprintInput {
  readonly customerId: string | null;
  readonly lines: readonly CanonicalLine[];
  readonly taxRateBps: number;
  readonly subtotalCents: number;
  readonly discountCents: number;
  readonly taxableAmountCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly paymentMethod: PaymentMethod;
}

export const CHECKOUT_FINGERPRINT_VERSION = 'gpp.checkout.fingerprint.v1';

/** Canonical serialization of the normalized checkout intent (see module docs). */
export function serializeCheckoutIntent(input: CheckoutFingerprintInput): string {
  const orderedLines = canonicalLineOrder(input.lines).map((line) => [
    line.productId,
    line.listedPriceCents,
    line.soldPriceCents,
    line.quantity,
  ]);
  return JSON.stringify([
    CHECKOUT_FINGERPRINT_VERSION,
    input.customerId,
    orderedLines,
    input.taxRateBps,
    input.subtotalCents,
    input.discountCents,
    input.taxableAmountCents,
    input.taxCents,
    input.totalCents,
    input.paymentMethod,
  ]);
}

/** Deterministic SHA-256 hex digest of the normalized checkout intent. */
export function computeCheckoutFingerprint(input: CheckoutFingerprintInput): string {
  return createHash('sha256').update(serializeCheckoutIntent(input), 'utf8').digest('hex');
}
