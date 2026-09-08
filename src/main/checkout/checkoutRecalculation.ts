import type Database from 'better-sqlite3';
import type { CheckoutReview, CheckoutReviewLine } from '../../shared/checkout';
import { CART_LINE_QUANTITY_MAX } from '../../shared/checkout';
import type { CustomerRecord } from '../../shared/customers';
import type { ProductRecord } from '../../shared/products';
import { findCustomerById } from '../customers/customerRepository';
import { findProductById } from '../products/productRepository';
import { readConfiguredTaxRateBps } from '../settings/settingsRepository';
import { appErrors } from '../shared/appError';
import {
  calculateReviewTotals,
  lineDiscountCents,
  lineListedSubtotalCents,
  lineTotalCents,
} from './checkoutCalculation';
import type { CanonicalLine, ReviewTotals } from './checkoutCalculation';
import { computeCheckoutFingerprint } from './checkoutFingerprint';
import type { ValidatedCheckoutRequest } from './checkoutValidation';

/**
 * The smallest reusable trusted checkout-recalculation primitive
 * (`DATA_MODEL.md §41`-`§43`, `§41B`; `REQ-SALE-007`, `REQ-SALE-012`,
 * `REQ-SALE-014`).
 *
 * Given a validated checkout *intent*, it reloads authoritative product /
 * customer / tax state from SQLite, recomputes every monetary value in integer
 * cents, orders the lines canonically, and derives the deterministic
 * fingerprint. It is a pure read — it opens NO transaction of its own, inserts
 * nothing, updates nothing — so both callers use it identically:
 *
 *  - `checkoutService.review()` wraps it in a deferred snapshot transaction
 *    (Phase 2D behaviour, unchanged);
 *  - `saleService` calls it inside its own `BEGIN IMMEDIATE` Phase 1 and Phase 2
 *    transactions (Phase 2E), where opening another transaction here would be a
 *    nested-transaction bug.
 *
 * A manipulated renderer payload cannot override listed price, stock, active
 * state, tax rate, discount, tax, or total: the caller supplies only
 * `product_id`, `quantity`, `sold_price_cents`, `customer_id`, and
 * `payment_method`; everything else is derived here from current state.
 */

/** One cart line resolved against its current authoritative product row. */
export interface ResolvedLine {
  readonly product: ProductRecord;
  readonly canonical: CanonicalLine;
}

export interface RecalculatedCheckout {
  readonly request: ValidatedCheckoutRequest;
  /**
   * Lines in canonical `(product_id, listed_price_cents, sold_price_cents,
   * quantity)` order (`DATA_MODEL.md §41B`). Exact-duplicate tuples are kept as
   * separate entries — never merged — so each becomes its own `sale_items` row.
   */
  readonly orderedLines: readonly ResolvedLine[];
  readonly customer: CustomerRecord | null;
  readonly taxRateBps: number;
  readonly totals: ReviewTotals;
  readonly fingerprint: string;
  readonly review: CheckoutReview;
}

/**
 * Order resolved lines by the canonical tuple ascending (`DATA_MODEL.md §41B`).
 * Sorts the resolved objects themselves so each keeps its product; exact
 * duplicates stay as separate entries.
 */
function canonicalResolvedOrder(lines: readonly ResolvedLine[]): ResolvedLine[] {
  return [...lines].sort((x, y) => {
    const a = x.canonical;
    const b = y.canonical;
    if (a.productId !== b.productId) return a.productId < b.productId ? -1 : 1;
    if (a.listedPriceCents !== b.listedPriceCents) return a.listedPriceCents - b.listedPriceCents;
    if (a.soldPriceCents !== b.soldPriceCents) return a.soldPriceCents - b.soldPriceCents;
    return a.quantity - b.quantity;
  });
}

function loadProduct(db: Database.Database, productId: string): ProductRecord {
  const product = findProductById(db, productId);
  if (!product) {
    throw appErrors.productNotFound();
  }
  if (!product.isActive) {
    throw appErrors.productArchived(product.name);
  }
  return product;
}

function loadCustomer(db: Database.Database, customerId: string | null): CustomerRecord | null {
  if (customerId === null) {
    return null;
  }
  const customer = findCustomerById(db, customerId);
  if (!customer) {
    throw appErrors.customerNotFound();
  }
  return customer;
}

/**
 * Aggregate requested quantity per product ID and validate the combined total
 * against the `999` ceiling and current `quantity_on_hand` (`DATA_MODEL.md
 * §41A`, `REQ-SALE-012`). Distinct cart lines are never merged — only the stock
 * check is aggregated.
 */
export function aggregateQuantityByProduct(
  lines: readonly ResolvedLine[],
): Map<string, { product: ProductRecord; quantity: number }> {
  const totals = new Map<string, { product: ProductRecord; quantity: number }>();
  for (const { product, canonical } of lines) {
    const entry = totals.get(product.id);
    if (entry) {
      entry.quantity += canonical.quantity;
    } else {
      totals.set(product.id, { product, quantity: canonical.quantity });
    }
  }
  return totals;
}

function validateAggregatedStock(lines: readonly ResolvedLine[]): void {
  for (const { product, quantity } of aggregateQuantityByProduct(lines).values()) {
    if (quantity > CART_LINE_QUANTITY_MAX) {
      throw appErrors.validation(
        `The combined quantity for “${product.name}” must not exceed ${CART_LINE_QUANTITY_MAX}.`,
      );
    }
    if (quantity > product.quantityOnHand) {
      throw appErrors.insufficientStock(product.name, product.quantityOnHand);
    }
  }
}

function toReviewLine({ product, canonical }: ResolvedLine): CheckoutReviewLine {
  return {
    productId: product.id,
    name: product.name,
    brand: product.brand,
    model: product.model,
    condition: product.condition,
    sku: product.sku,
    barcode: product.barcode,
    listedPriceCents: canonical.listedPriceCents,
    soldPriceCents: canonical.soldPriceCents,
    quantity: canonical.quantity,
    lineListedSubtotalCents: lineListedSubtotalCents(canonical),
    lineDiscountCents: lineDiscountCents(canonical),
    lineTotalCents: lineTotalCents(canonical),
  };
}

/** Recompute the authoritative checkout from current SQLite state. Opens no transaction. */
export function recalculateCheckout(
  db: Database.Database,
  request: ValidatedCheckoutRequest,
): RecalculatedCheckout {
  // Each product's *current* selling price becomes the listed price; a
  // renderer-submitted listed price is never accepted.
  const resolved: ResolvedLine[] = request.lines.map((line) => {
    const product = loadProduct(db, line.productId);
    return {
      product,
      canonical: {
        productId: product.id,
        listedPriceCents: product.sellingPriceCents,
        soldPriceCents: line.soldPriceCents,
        quantity: line.quantity,
      },
    };
  });

  validateAggregatedStock(resolved);

  const customer = loadCustomer(db, request.customerId);

  const taxRateBps = readConfiguredTaxRateBps(db);
  if (taxRateBps === null) {
    throw appErrors.taxRateNotConfigured();
  }

  const orderedLines = canonicalResolvedOrder(resolved);
  const canonicalLines: CanonicalLine[] = orderedLines.map((line) => line.canonical);
  const totals = calculateReviewTotals(canonicalLines, taxRateBps);

  const fingerprint = computeCheckoutFingerprint({
    customerId: request.customerId,
    lines: canonicalLines,
    taxRateBps: totals.taxRateBps,
    subtotalCents: totals.subtotalCents,
    discountCents: totals.discountCents,
    taxableAmountCents: totals.taxableAmountCents,
    taxCents: totals.taxCents,
    totalCents: totals.totalCents,
    paymentMethod: request.paymentMethod,
  });

  const review: CheckoutReview = {
    customerId: request.customerId,
    customer,
    paymentMethod: request.paymentMethod,
    lines: orderedLines.map(toReviewLine),
    subtotalCents: totals.subtotalCents,
    discountCents: totals.discountCents,
    taxableAmountCents: totals.taxableAmountCents,
    taxRateBps: totals.taxRateBps,
    taxCents: totals.taxCents,
    totalCents: totals.totalCents,
    fingerprint,
  };

  return { request, orderedLines, customer, taxRateBps, totals, fingerprint, review };
}
