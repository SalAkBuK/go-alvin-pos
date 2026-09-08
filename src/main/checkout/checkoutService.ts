import type Database from 'better-sqlite3';
import type { CheckoutReview, CheckoutReviewLine, PaymentMethod } from '../../shared/checkout';
import { CART_LINE_QUANTITY_MAX } from '../../shared/checkout';
import type { CustomerRecord } from '../../shared/customers';
import type { ProductRecord } from '../../shared/products';
import { findCustomerById } from '../customers/customerRepository';
import { findProductById } from '../products/productRepository';
import { appErrors } from '../shared/appError';
import { readConfiguredTaxRateBps } from '../settings/settingsRepository';
import {
  calculateReviewTotals,
  lineDiscountCents,
  lineListedSubtotalCents,
  lineTotalCents,
} from './checkoutCalculation';
import type { CanonicalLine } from './checkoutCalculation';
import { computeCheckoutFingerprint } from './checkoutFingerprint';
import { validateCheckoutReviewRequest } from './checkoutValidation';

/**
 * Trusted checkout review (`ARCHITECTURE.md §10-11`, `POS_WORKFLOWS.md §26-27`,
 * `DATA_MODEL.md §41`-`§43`, `§41B`; `REQ-SALE-007`, `REQ-SALE-012`,
 * `REQ-SALE-013`, `REQ-TAX-*`).
 *
 * `review()` takes a normalized renderer *intent*, reloads authoritative
 * product/customer/tax state from SQLite, recomputes every monetary value, and
 * returns the canonical review plus a deterministic fingerprint. It is a pure
 * read: it opens a transaction only for a consistent snapshot and never
 * inserts, updates, or deletes any row — no `sales`, `sale_items`, `payments`,
 * `inventory_movements`, `checkout_requests`, audit events, or export jobs, and
 * `products.quantity_on_hand` is never touched. Phase 2D completes no sale.
 *
 * A manipulated renderer payload cannot override the listed price, stock,
 * active state, tax rate, discount, tax, or total: the renderer supplies only
 * `product_id`, `quantity`, `sold_price_cents`, `customer_id`, and
 * `payment_method`; everything else is derived here from current state.
 */

export interface CheckoutServiceDeps {
  readonly db: Database.Database;
}

export interface CheckoutService {
  review(raw: unknown): CheckoutReview;
}

interface ResolvedLine {
  readonly product: ProductRecord;
  readonly canonical: CanonicalLine;
}

/**
 * Order resolved lines by the canonical tuple `(product_id, listed_price_cents,
 * sold_price_cents, quantity)` ascending (`DATA_MODEL.md §41B`). Sorts the
 * resolved objects themselves so each keeps its product; exact-duplicate tuples
 * stay as separate entries.
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

export function createCheckoutService(deps: CheckoutServiceDeps): CheckoutService {
  const { db } = deps;

  function loadProduct(productId: string): ProductRecord {
    const product = findProductById(db, productId);
    if (!product) {
      throw appErrors.productNotFound();
    }
    if (!product.isActive) {
      throw appErrors.productArchived(product.name);
    }
    return product;
  }

  function loadCustomer(customerId: string | null): CustomerRecord | null {
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
   * §41A`, `REQ-SALE-012`). The distinct cart lines are never merged — only the
   * stock check is aggregated.
   */
  function validateAggregatedStock(resolved: readonly ResolvedLine[]): void {
    const totals = new Map<string, { product: ProductRecord; quantity: number }>();
    for (const { product, canonical } of resolved) {
      const entry = totals.get(product.id);
      if (entry) {
        entry.quantity += canonical.quantity;
      } else {
        totals.set(product.id, { product, quantity: canonical.quantity });
      }
    }
    for (const { product, quantity } of totals.values()) {
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

  function runReview(raw: unknown): CheckoutReview {
    const request = validateCheckoutReviewRequest(raw);

    // Load each product; its *current* selling price becomes the listed price.
    // A renderer-submitted listed price is never accepted.
    const resolved: ResolvedLine[] = request.lines.map((line) => {
      const product = loadProduct(line.productId);
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

    const customer = loadCustomer(request.customerId);

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

    const paymentMethod: PaymentMethod = request.paymentMethod;

    return {
      customerId: request.customerId,
      customer,
      paymentMethod,
      lines: orderedLines.map(toReviewLine),
      subtotalCents: totals.subtotalCents,
      discountCents: totals.discountCents,
      taxableAmountCents: totals.taxableAmountCents,
      taxRateBps: totals.taxRateBps,
      taxCents: totals.taxCents,
      totalCents: totals.totalCents,
      fingerprint,
    };
  }

  return {
    review(raw: unknown): CheckoutReview {
      // A deferred transaction gives every read in one review a single
      // consistent snapshot without taking a write lock.
      return db.transaction(() => runReview(raw))();
    },
  };
}
