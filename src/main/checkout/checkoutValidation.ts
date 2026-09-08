import {
  CART_LINE_QUANTITY_MAX,
  CART_LINE_QUANTITY_MIN,
  CART_MAX_LINES,
  PAYMENT_METHODS,
} from '../../shared/checkout';
import type { CheckoutLineIntent, PaymentMethod } from '../../shared/checkout';
import { PER_UNIT_PRICE_CENTS_MAX } from '../../shared/money';
import { appErrors } from '../shared/appError';

/**
 * Trusted application-layer validation of a `checkout:review` payload
 * (`ARCHITECTURE.md §30`, `DATA_MODEL.md §41A`, `§41B`).
 *
 * The renderer's own checks are a UX convenience only; every field that crosses
 * IPC is validated again here, independently, before the service touches
 * SQLite. Malformed numeric input (`NaN`, `Infinity`, fractions, non-numbers,
 * out-of-range) is rejected outright — never coerced or silently clamped. This
 * validates *structure and intent* only; authoritative listed price, stock,
 * archived state, tax rate, and derived totals are the service's job.
 */

export interface ValidatedCheckoutRequest {
  readonly customerId: string | null;
  readonly paymentMethod: PaymentMethod;
  readonly lines: readonly CheckoutLineIntent[];
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw appErrors.validation(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw appErrors.validation(`${label} contains unexpected field(s): ${unexpected.join(', ')}.`);
  }
}

/** A finite integer, rejecting `NaN`, `Infinity`, fractions, and non-numbers. */
function requireFiniteInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw appErrors.validation(`${label} must be a number.`);
  }
  if (!Number.isInteger(value)) {
    throw appErrors.validation(`${label} must be a whole number.`);
  }
  if (!Number.isSafeInteger(value)) {
    throw appErrors.validation(`${label} is out of range.`);
  }
  return value;
}

function requireCustomerId(record: Record<string, unknown>): string | null {
  const raw = record['customerId'];
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw appErrors.validation('The selected customer is not valid.');
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function requirePaymentMethod(record: Record<string, unknown>): PaymentMethod {
  const raw = record['paymentMethod'];
  if (typeof raw !== 'string' || !(PAYMENT_METHODS as readonly string[]).includes(raw)) {
    throw appErrors.validation(`Payment method must be one of ${PAYMENT_METHODS.join(', ')}.`);
  }
  return raw as PaymentMethod;
}

const LINE_KEYS = ['productId', 'quantity', 'soldPriceCents'] as const;

function validateLine(raw: unknown, index: number): CheckoutLineIntent {
  const label = `Cart line ${index + 1}`;
  const record = asRecord(raw, label);
  rejectUnknownKeys(record, LINE_KEYS, label);

  const productId = record['productId'];
  if (typeof productId !== 'string' || productId.trim().length === 0) {
    throw appErrors.validation(`${label} is missing its product.`);
  }

  const quantity = requireFiniteInteger(record['quantity'], `${label} quantity`);
  if (quantity < CART_LINE_QUANTITY_MIN || quantity > CART_LINE_QUANTITY_MAX) {
    throw appErrors.validation(
      `${label} quantity must be between ${CART_LINE_QUANTITY_MIN} and ${CART_LINE_QUANTITY_MAX}.`,
    );
  }

  const soldPriceCents = requireFiniteInteger(record['soldPriceCents'], `${label} price`);
  if (soldPriceCents < 0) {
    throw appErrors.validation(`${label} price cannot be negative.`);
  }
  if (soldPriceCents > PER_UNIT_PRICE_CENTS_MAX) {
    throw appErrors.validation(`${label} price is above the maximum of $99,999.99.`);
  }

  return { productId: productId.trim(), quantity, soldPriceCents };
}

const REQUEST_KEYS = ['customerId', 'paymentMethod', 'lines'] as const;

export function validateCheckoutReviewRequest(raw: unknown): ValidatedCheckoutRequest {
  const record = asRecord(raw, 'The checkout');
  rejectUnknownKeys(record, REQUEST_KEYS, 'The checkout');

  const linesRaw = record['lines'];
  if (!Array.isArray(linesRaw)) {
    throw appErrors.validation('The checkout must include a list of cart lines.');
  }
  if (linesRaw.length === 0) {
    throw appErrors.validation('Add at least one product before reviewing the checkout.');
  }
  if (linesRaw.length > CART_MAX_LINES) {
    throw appErrors.validation(`A checkout cannot have more than ${CART_MAX_LINES} lines.`);
  }

  const lines = linesRaw.map((line, index) => validateLine(line, index));

  return {
    customerId: requireCustomerId(record),
    paymentMethod: requirePaymentMethod(record),
    lines,
  };
}
