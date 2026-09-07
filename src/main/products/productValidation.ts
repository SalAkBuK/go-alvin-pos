import { PRODUCT_CONDITIONS } from '../../shared/products';
import type { ProductCondition } from '../../shared/products';
import { appErrors } from '../shared/appError';

/**
 * Trusted application-layer validation (task `§3`, `ARCHITECTURE.md §30`,
 * `DATA_MODEL.md §41A`).
 *
 * The renderer's own checks are a UX convenience only; nothing here trusts
 * them. Every payload that crosses IPC is validated again, independently, before
 * a service touches SQLite. Malformed numeric input is rejected outright, never
 * coerced. Unexpected object keys are rejected where practical.
 */

/** Per-unit monetary ceiling in cents ($99,999.99) — `DATA_MODEL.md §41A`. */
export const PRICE_CENTS_MAX = 9_999_999;
/** Fat-finger guard for quantities / thresholds; keeps arithmetic in safe-integer range. */
export const QUANTITY_MAX = 9_999_999;
/** Reason free-text ceiling for movement rows / audit reasons. */
export const REASON_MAX_LENGTH = 500;

export interface ValidatedCreateProduct {
  readonly name: string;
  readonly brand: string;
  readonly model: string;
  readonly condition: ProductCondition;
  readonly sellingPriceCents: number;
  readonly quantity: number;
  readonly sku: string | null;
  readonly barcode: string | null;
  readonly costPriceCents: number | null;
  readonly lowStockThreshold: number | null;
}

export interface ValidatedUpdateProduct {
  readonly name: string;
  readonly brand: string;
  readonly model: string;
  readonly condition: ProductCondition;
  readonly sellingPriceCents: number;
  readonly costPriceCents: number | null;
  readonly sku: string | null;
  readonly barcode: string | null;
  readonly lowStockThreshold: number | null;
}

export type ValidatedAdjustment = {
  readonly productId: string;
  readonly reason: string;
} & (
  | { readonly mode: 'delta'; readonly delta: number }
  | { readonly mode: 'target'; readonly targetQuantity: number }
);

// ── primitive helpers ────────────────────────────────────────────────────────

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

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const raw = record[key];
  if (typeof raw !== 'string') {
    throw appErrors.validation(`${label} is required.`);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw appErrors.validation(`${label} is required.`);
  }
  return trimmed;
}

/** Optional trimmed string; blank / whitespace-only / missing / null all become `null`. */
function optionalStringOrNull(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string | null {
  const raw = record[key];
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw appErrors.validation(`${label} must be text.`);
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw appErrors.validation(`${label} must be a whole number.`);
  }
  if (!Number.isSafeInteger(value)) {
    throw appErrors.validation(`${label} is out of range.`);
  }
  return value;
}

function requirePriceCents(record: Record<string, unknown>, key: string, label: string): number {
  const cents = requireInteger(record[key], label);
  if (cents < 0) {
    throw appErrors.validation(`${label} cannot be negative.`);
  }
  if (cents > PRICE_CENTS_MAX) {
    throw appErrors.validation(`${label} is above the maximum of $99,999.99.`);
  }
  return cents;
}

function optionalPriceCentsOrNull(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number | null {
  const raw = record[key];
  if (raw === undefined || raw === null) {
    return null;
  }
  return requirePriceCents(record, key, label);
}

function optionalNonNegativeIntOrNull(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number | null {
  const raw = record[key];
  if (raw === undefined || raw === null) {
    return null;
  }
  const value = requireInteger(raw, label);
  if (value < 0) {
    throw appErrors.validation(`${label} cannot be negative.`);
  }
  if (value > QUANTITY_MAX) {
    throw appErrors.validation(`${label} is above the maximum.`);
  }
  return value;
}

function requireCondition(record: Record<string, unknown>): ProductCondition {
  const raw = record['condition'];
  if (typeof raw !== 'string' || !(PRODUCT_CONDITIONS as readonly string[]).includes(raw)) {
    throw appErrors.validation(`Condition must be one of ${PRODUCT_CONDITIONS.join(', ')}.`);
  }
  return raw as ProductCondition;
}

function requireReason(record: Record<string, unknown>): string {
  const reason = requiredString(record, 'reason', 'A reason');
  if (reason.length > REASON_MAX_LENGTH) {
    throw appErrors.validation(`The reason must be ${REASON_MAX_LENGTH} characters or fewer.`);
  }
  return reason;
}

// ── payload validators ───────────────────────────────────────────────────────

const CREATE_KEYS = [
  'name',
  'brand',
  'model',
  'condition',
  'sellingPriceCents',
  'quantity',
  'sku',
  'barcode',
  'costPriceCents',
  'lowStockThreshold',
] as const;

export function validateCreateProduct(raw: unknown): ValidatedCreateProduct {
  const record = asRecord(raw, 'The product');
  rejectUnknownKeys(record, CREATE_KEYS, 'The product');

  const quantity = requireInteger(record['quantity'], 'Quantity');
  if (quantity < 0) {
    throw appErrors.validation('Quantity cannot be negative.');
  }
  if (quantity > QUANTITY_MAX) {
    throw appErrors.validation('Quantity is above the maximum.');
  }

  return {
    name: requiredString(record, 'name', 'Product name'),
    brand: requiredString(record, 'brand', 'Brand'),
    model: requiredString(record, 'model', 'Model'),
    condition: requireCondition(record),
    sellingPriceCents: requirePriceCents(record, 'sellingPriceCents', 'Selling price'),
    quantity,
    sku: optionalStringOrNull(record, 'sku', 'SKU'),
    barcode: optionalStringOrNull(record, 'barcode', 'Barcode'),
    costPriceCents: optionalPriceCentsOrNull(record, 'costPriceCents', 'Cost price'),
    lowStockThreshold: optionalNonNegativeIntOrNull(
      record,
      'lowStockThreshold',
      'Low-stock threshold',
    ),
  };
}

const UPDATE_KEYS = [
  'name',
  'brand',
  'model',
  'condition',
  'sellingPriceCents',
  'costPriceCents',
  'sku',
  'barcode',
  'lowStockThreshold',
] as const;

export function validateUpdateProduct(raw: unknown): ValidatedUpdateProduct {
  const record = asRecord(raw, 'The product');

  // Checked before the generic unknown-key guard so the message is actionable.
  if ('quantity' in record || 'quantityOnHand' in record) {
    throw appErrors.validation('Stock quantity cannot be changed here. Use Adjust Stock instead.');
  }

  rejectUnknownKeys(record, UPDATE_KEYS, 'The product');

  return {
    name: requiredString(record, 'name', 'Product name'),
    brand: requiredString(record, 'brand', 'Brand'),
    model: requiredString(record, 'model', 'Model'),
    condition: requireCondition(record),
    sellingPriceCents: requirePriceCents(record, 'sellingPriceCents', 'Selling price'),
    costPriceCents: optionalPriceCentsOrNull(record, 'costPriceCents', 'Cost price'),
    sku: optionalStringOrNull(record, 'sku', 'SKU'),
    barcode: optionalStringOrNull(record, 'barcode', 'Barcode'),
    lowStockThreshold: optionalNonNegativeIntOrNull(
      record,
      'lowStockThreshold',
      'Low-stock threshold',
    ),
  };
}

export function validateProductId(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw appErrors.validation('A product must be selected.');
  }
  return raw.trim();
}

/** Barcode lookup input: text, trimmed, leading zeroes preserved, case kept as-is. */
export function validateBarcodeQuery(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw appErrors.validation('A barcode value is required.');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw appErrors.validation('A barcode value is required.');
  }
  return trimmed;
}

export function validateSearchQuery(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw appErrors.validation('A search term is required.');
  }
  return raw.trim();
}

const ADJUST_KEYS = ['productId', 'reason', 'mode', 'delta', 'targetQuantity'] as const;

export function validateAdjustment(raw: unknown): ValidatedAdjustment {
  const record = asRecord(raw, 'The adjustment');
  rejectUnknownKeys(record, ADJUST_KEYS, 'The adjustment');

  const productId = validateProductId(record['productId']);
  const reason = requireReason(record);
  const mode = record['mode'];

  if (mode === 'delta') {
    const delta = requireInteger(record['delta'], 'The adjustment amount');
    if (delta === 0) {
      throw appErrors.adjustmentNoChange();
    }
    if (Math.abs(delta) > QUANTITY_MAX) {
      throw appErrors.validation('The adjustment amount is above the maximum.');
    }
    return { productId, reason, mode: 'delta', delta };
  }

  if (mode === 'target') {
    const targetQuantity = requireInteger(record['targetQuantity'], 'The target quantity');
    if (targetQuantity < 0) {
      throw appErrors.validation('The target quantity cannot be negative.');
    }
    if (targetQuantity > QUANTITY_MAX) {
      throw appErrors.validation('The target quantity is above the maximum.');
    }
    return { productId, reason, mode: 'target', targetQuantity };
  }

  throw appErrors.validation("The adjustment mode must be 'delta' or 'target'.");
}
