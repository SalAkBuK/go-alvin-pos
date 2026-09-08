import type {
  CheckoutReview,
  CheckoutReviewRequest,
  PaymentMethod,
} from '../../../../shared/checkout';
import { CART_LINE_QUANTITY_MAX, CART_LINE_QUANTITY_MIN } from '../../../../shared/checkout';
import { CHECKOUT_TOTAL_CENTS_MAX, PER_UNIT_PRICE_CENTS_MAX } from '../../../../shared/money';
import type { ProductRecord } from '../../../../shared/products';

/**
 * Temporary renderer checkout state — the draft cart (`ARCHITECTURE.md §41`,
 * `POS_WORKFLOWS.md §16-23`, task `§3`, `§17`, `§18`).
 *
 * This is deliberately a pure, React-free reducer module so the cart rules
 * (add / remove / quantity / price / duplicate handling / review invalidation)
 * are unit-testable on their own. Nothing here persists: there is no `sales`
 * row, no draft-cart table, and no IPC. The trusted `checkout:review` call is
 * the authority on every monetary value; the helpers here only drive an
 * immediate on-screen preview and shape the request.
 */

let lineCounter = 0;
function nextLineKey(): string {
  lineCounter += 1;
  return `line-${lineCounter}`;
}

export interface CartLine {
  /** Stable local identity for React lists and remove/edit — never sent to main. */
  readonly key: string;
  readonly productId: string;
  readonly name: string;
  readonly brand: string;
  readonly model: string;
  readonly condition: ProductRecord['condition'];
  /** Snapshot of `quantity_on_hand` at add-time, for the local preview check only. */
  readonly quantityOnHand: number;
  /** Snapshot of the product selling price at add-time (preview only). */
  readonly listedPriceCents: number;
  readonly soldPriceCents: number;
  readonly quantity: number;
}

export interface CartState {
  readonly lines: readonly CartLine[];
  readonly customerId: string | null;
  readonly paymentMethod: PaymentMethod | null;
  /**
   * The last successful trusted review, or `null` when there is none or a
   * material change has invalidated it (task `§18`). Never persisted.
   */
  readonly review: CheckoutReview | null;
}

export const EMPTY_CART: CartState = {
  lines: [],
  customerId: null,
  paymentMethod: null,
  review: null,
};

/** Any material change clears a prior review so a fresh Review is required. */
function invalidate(
  state: CartState,
  lines: readonly CartLine[],
  patch: Partial<CartState> = {},
): CartState {
  return { ...state, lines, review: null, ...patch };
}

/**
 * Add an active product. If an untouched, default-priced line for the same
 * product already exists, its quantity is incremented (the common re-scan
 * case); otherwise a new distinct line is created. Distinct negotiated-price
 * lines for the same product are always kept separate — the domain and
 * fingerprint support that case (`DATA_MODEL.md §41A`, `§41B`).
 */
export function addProduct(state: CartState, product: ProductRecord): CartState {
  const mergeable = state.lines.find(
    (line) =>
      line.productId === product.id &&
      line.soldPriceCents === line.listedPriceCents &&
      line.listedPriceCents === product.sellingPriceCents &&
      line.quantity < CART_LINE_QUANTITY_MAX,
  );
  if (mergeable) {
    return setQuantity(state, mergeable.key, mergeable.quantity + 1);
  }
  const line: CartLine = {
    key: nextLineKey(),
    productId: product.id,
    name: product.name,
    brand: product.brand,
    model: product.model,
    condition: product.condition,
    quantityOnHand: product.quantityOnHand,
    listedPriceCents: product.sellingPriceCents,
    soldPriceCents: product.sellingPriceCents,
    quantity: 1,
  };
  return invalidate(state, [...state.lines, line]);
}

export function removeLine(state: CartState, key: string): CartState {
  return invalidate(
    state,
    state.lines.filter((line) => line.key !== key),
  );
}

/** Set an already-parsed integer quantity for a line. Out-of-range values are
 * kept in state so the preview can flag them; the trusted layer rejects them. */
export function setQuantity(state: CartState, key: string, quantity: number): CartState {
  return invalidate(
    state,
    state.lines.map((line) => (line.key === key ? { ...line, quantity } : line)),
  );
}

/** Set an already-parsed integer sold price (in cents) for a line. */
export function setSoldPrice(state: CartState, key: string, soldPriceCents: number): CartState {
  return invalidate(
    state,
    state.lines.map((line) => (line.key === key ? { ...line, soldPriceCents } : line)),
  );
}

export function setCustomer(state: CartState, customerId: string | null): CartState {
  return invalidate(state, state.lines, { customerId });
}

export function setPaymentMethod(state: CartState, paymentMethod: PaymentMethod | null): CartState {
  return invalidate(state, state.lines, { paymentMethod });
}

/** Clear the whole draft — lines, customer, payment, and review (task `§17`). */
export function clearCart(): CartState {
  return EMPTY_CART;
}

/** Record a successful trusted review. */
export function withReview(state: CartState, review: CheckoutReview): CartState {
  return { ...state, review };
}

export function isReviewCurrent(state: CartState): boolean {
  return state.review !== null;
}

// ── Derived preview values (not authoritative) ───────────────────────────────

export function lineListedSubtotalCents(line: CartLine): number {
  return line.listedPriceCents * line.quantity;
}
export function lineTotalCents(line: CartLine): number {
  return line.soldPriceCents * line.quantity;
}
export function lineDiscountCents(line: CartLine): number {
  return Math.max(0, line.listedPriceCents - line.soldPriceCents) * line.quantity;
}

export interface CartPreview {
  readonly subtotalCents: number;
  readonly discountCents: number;
  readonly taxableAmountCents: number;
  readonly totalExclTaxCents: number;
}

export function cartPreview(state: CartState): CartPreview {
  let subtotalCents = 0;
  let discountCents = 0;
  let taxableAmountCents = 0;
  for (const line of state.lines) {
    subtotalCents += lineListedSubtotalCents(line);
    discountCents += lineDiscountCents(line);
    taxableAmountCents += lineTotalCents(line);
  }
  return {
    subtotalCents,
    discountCents,
    taxableAmountCents,
    totalExclTaxCents: taxableAmountCents,
  };
}

/** Aggregate requested quantity per product ID (mirrors the trusted stock check). */
export function aggregateQuantityByProduct(state: CartState): Map<string, number> {
  const totals = new Map<string, number>();
  for (const line of state.lines) {
    totals.set(line.productId, (totals.get(line.productId) ?? 0) + line.quantity);
  }
  return totals;
}

/**
 * Quick local validation for immediate feedback. Not authoritative — the
 * trusted `checkout:review` re-validates everything.
 */
export function previewValidationErrors(state: CartState): string[] {
  const errors: string[] = [];
  if (state.lines.length === 0) {
    errors.push('Add at least one product.');
  }
  for (const line of state.lines) {
    if (
      !Number.isInteger(line.quantity) ||
      line.quantity < CART_LINE_QUANTITY_MIN ||
      line.quantity > CART_LINE_QUANTITY_MAX
    ) {
      errors.push(
        `“${line.name}”: quantity must be a whole number from 1 to ${CART_LINE_QUANTITY_MAX}.`,
      );
    }
    if (
      !Number.isInteger(line.soldPriceCents) ||
      line.soldPriceCents < 0 ||
      line.soldPriceCents > PER_UNIT_PRICE_CENTS_MAX
    ) {
      errors.push(`“${line.name}”: price must be between $0.00 and $99,999.99.`);
    }
  }
  const byProduct = aggregateQuantityByProduct(state);
  for (const line of state.lines) {
    const requested = byProduct.get(line.productId) ?? 0;
    if (requested > line.quantityOnHand) {
      errors.push(
        `“${line.name}”: only ${line.quantityOnHand} in stock, but ${requested} requested across the cart.`,
      );
    }
  }
  if (cartPreview(state).taxableAmountCents > CHECKOUT_TOTAL_CENTS_MAX) {
    errors.push('The cart total is above the maximum a single sale can record.');
  }
  if (state.paymentMethod === null) {
    errors.push('Select a payment method.');
  }
  // De-duplicate while preserving order.
  return [...new Set(errors)];
}

/** Shape the trusted-review request from the current draft (task `§13`). */
export function toReviewRequest(state: CartState): CheckoutReviewRequest {
  if (state.paymentMethod === null) {
    throw new Error('Select a payment method before reviewing.');
  }
  return {
    customerId: state.customerId,
    paymentMethod: state.paymentMethod,
    lines: state.lines.map((line) => ({
      productId: line.productId,
      quantity: line.quantity,
      soldPriceCents: line.soldPriceCents,
    })),
  };
}
