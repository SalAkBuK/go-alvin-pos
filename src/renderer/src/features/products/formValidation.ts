import type {
  CreateProductInput,
  ProductCondition,
  UpdateProductInput,
} from '../../../../shared/products';
import { parseDollarsToCents } from './money';

/**
 * Renderer-only, field-level form validation (Phase 2B UX polish).
 *
 * This is a UX convenience: it gives the cashier immediate, actionable feedback
 * before an IPC round-trip. It is NOT authoritative — `productValidation.ts` in
 * the main process re-validates every payload, and SQLite constraints are the
 * final backstop. Keeping the rules in one pure module (no React, no DOM) means
 * the forms and their tests share exactly one code path.
 */

/** Canonical per-unit monetary ceiling in cents ($99,999.99) — mirrors `DATA_MODEL.md §41A`. */
export const PRICE_CENTS_MAX = 9_999_999;

export interface ProductFormFields {
  readonly name: string;
  readonly brand: string;
  readonly model: string;
  readonly condition: ProductCondition;
  readonly sellingPrice: string;
  readonly quantity: string;
  readonly sku: string;
  readonly barcode: string;
  readonly costPrice: string;
  readonly lowStockThreshold: string;
}

export type ProductFieldName =
  | 'name'
  | 'brand'
  | 'model'
  | 'sellingPrice'
  | 'quantity'
  | 'costPrice'
  | 'lowStockThreshold'
  | 'sku'
  | 'barcode';

export type ProductFormErrors = Partial<Record<ProductFieldName | 'form', string>>;

export interface AdjustmentFormFields {
  readonly mode: 'delta' | 'target';
  readonly value: string;
  readonly reason: string;
}

export type AdjustmentFieldName = 'value' | 'reason';
export type AdjustmentFormErrors = Partial<Record<AdjustmentFieldName | 'form', string>>;

// ── shared primitives ───────────────────────────────────────────────────────

function requiredText(label: string, value: string): string | null {
  return value.trim() === '' ? `${label} is required.` : null;
}

/**
 * Validate a typed dollar amount. `required: false` treats blank as valid
 * (optional field). Never coerces: an invalid non-blank value is always an error.
 */
function currencyError(
  label: string,
  value: string,
  options: { readonly required: boolean },
): string | null {
  const trimmed = value.trim();
  if (trimmed === '') {
    return options.required ? `${label} is required.` : null;
  }
  if (trimmed.startsWith('-')) {
    return `${label} cannot be negative.`;
  }
  if (/^\d*\.\d{3,}$/.test(trimmed)) {
    return `${label} can have at most 2 decimal places.`;
  }
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return `Enter ${label.toLowerCase()} as a dollar amount, e.g. 599 or 599.99.`;
  }
  let cents: number | null;
  try {
    cents = parseDollarsToCents(trimmed);
  } catch {
    return `Enter ${label.toLowerCase()} as a dollar amount, e.g. 599 or 599.99.`;
  }
  if (cents !== null && cents > PRICE_CENTS_MAX) {
    return `${label} cannot exceed $99,999.99.`;
  }
  return null;
}

/** Validate a non-negative whole number. `required: false` treats blank as valid. */
function wholeNumberError(
  label: string,
  value: string,
  options: { readonly required: boolean },
): string | null {
  const trimmed = value.trim();
  if (trimmed === '') {
    return options.required ? `${label} is required.` : null;
  }
  if (trimmed.startsWith('-')) {
    return `${label} cannot be negative.`;
  }
  if (!/^\d+$/.test(trimmed)) {
    return `${label} must be a whole number.`;
  }
  if (!Number.isSafeInteger(Number(trimmed))) {
    return `${label} is too large.`;
  }
  return null;
}

// ── product form ────────────────────────────────────────────────────────────

export function validateProductField(
  field: ProductFieldName,
  fields: ProductFormFields,
  mode: 'create' | 'edit',
): string | null {
  switch (field) {
    case 'name':
      return requiredText('Product name', fields.name);
    case 'brand':
      return requiredText('Brand', fields.brand);
    case 'model':
      return requiredText('Model', fields.model);
    case 'sellingPrice':
      return currencyError('Selling price', fields.sellingPrice, { required: true });
    case 'quantity':
      return mode === 'create'
        ? wholeNumberError('Starting quantity', fields.quantity, { required: true })
        : null;
    case 'costPrice':
      return currencyError('Cost price', fields.costPrice, { required: false });
    case 'lowStockThreshold':
      return wholeNumberError('Low-stock threshold', fields.lowStockThreshold, { required: false });
    case 'sku':
    case 'barcode':
      // No renderer business rule beyond trim + blank→null, applied at build time.
      return null;
  }
}

const PRODUCT_FIELDS: readonly ProductFieldName[] = [
  'name',
  'brand',
  'model',
  'sellingPrice',
  'quantity',
  'costPrice',
  'lowStockThreshold',
  'sku',
  'barcode',
];

export interface ProductFormValidation {
  readonly errors: ProductFormErrors;
  /** Non-null only when `errors` is empty. Ready to hand to the trusted layer. */
  readonly payload: CreateProductInput | UpdateProductInput | null;
}

export function validateProductForm(
  fields: ProductFormFields,
  mode: 'create' | 'edit',
): ProductFormValidation {
  const errors: ProductFormErrors = {};
  for (const field of PRODUCT_FIELDS) {
    const message = validateProductField(field, fields, mode);
    if (message) {
      errors[field] = message;
    }
  }
  if (Object.keys(errors).length > 0) {
    return { errors, payload: null };
  }

  const skuOrNull = fields.sku.trim() === '' ? null : fields.sku.trim();
  const barcodeOrNull = fields.barcode.trim() === '' ? null : fields.barcode.trim();
  // Safe: every numeric field already passed its validator above.
  const sellingPriceCents = parseDollarsToCents(fields.sellingPrice) ?? 0;
  const costPriceCents = parseDollarsToCents(fields.costPrice);
  const lowStockThreshold =
    fields.lowStockThreshold.trim() === '' ? null : Number(fields.lowStockThreshold.trim());

  if (mode === 'create') {
    const payload: CreateProductInput = {
      name: fields.name.trim(),
      brand: fields.brand.trim(),
      model: fields.model.trim(),
      condition: fields.condition,
      sellingPriceCents,
      quantity: Number(fields.quantity.trim()),
      sku: skuOrNull,
      barcode: barcodeOrNull,
      costPriceCents,
      lowStockThreshold,
    };
    return { errors, payload };
  }

  const payload: UpdateProductInput = {
    name: fields.name.trim(),
    brand: fields.brand.trim(),
    model: fields.model.trim(),
    condition: fields.condition,
    sellingPriceCents,
    costPriceCents,
    sku: skuOrNull,
    barcode: barcodeOrNull,
    lowStockThreshold,
  };
  return { errors, payload };
}

/**
 * Map a trusted-layer error message back to the field it belongs to, so a
 * duplicate SKU/barcode shows next to that input rather than only as a generic
 * form error. Anything else stays a general form-level error.
 */
export function mapProductServerError(message: string): {
  readonly field: ProductFieldName | 'form';
  readonly message: string;
} {
  if (message === 'This barcode is already assigned to another product.') {
    return { field: 'barcode', message };
  }
  if (message === 'This SKU is already assigned to another product.') {
    return { field: 'sku', message };
  }
  return { field: 'form', message };
}

// ── adjustment form ─────────────────────────────────────────────────────────

/** Resulting quantity for the preview, or `null` when the value is not yet a number. */
export function resultingQuantity(
  fields: Pick<AdjustmentFormFields, 'mode' | 'value'>,
  currentQuantity: number,
): number | null {
  const trimmed = fields.value.trim();
  if (fields.mode === 'delta') {
    if (!/^[+-]?\d+$/.test(trimmed)) {
      return null;
    }
    return currentQuantity + Number(trimmed);
  }
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  return Number(trimmed);
}

export function validateAdjustmentField(
  field: AdjustmentFieldName,
  fields: AdjustmentFormFields,
  currentQuantity: number,
): string | null {
  if (field === 'reason') {
    return requiredText('A reason', fields.reason);
  }

  const trimmed = fields.value.trim();
  if (trimmed === '') {
    return 'An adjustment amount is required.';
  }

  if (fields.mode === 'delta') {
    if (!/^[+-]?\d+$/.test(trimmed)) {
      return 'Enter a whole number, optionally with a leading + or -.';
    }
    if (!Number.isSafeInteger(Number(trimmed))) {
      return 'That number is too large.';
    }
    const delta = Number(trimmed);
    if (delta === 0) {
      return 'Enter a non-zero change, or switch to “Set to a new total”.';
    }
    if (currentQuantity + delta < 0) {
      return `This would leave stock at ${currentQuantity + delta}. Stock cannot go below zero.`;
    }
    return null;
  }

  if (trimmed.startsWith('-')) {
    return 'The new total cannot be negative.';
  }
  if (!/^\d+$/.test(trimmed)) {
    return 'The new total must be a whole number.';
  }
  if (!Number.isSafeInteger(Number(trimmed))) {
    return 'That number is too large.';
  }
  if (Number(trimmed) === currentQuantity) {
    return 'That is the same as the current quantity.';
  }
  return null;
}

export interface AdjustmentFormValidation {
  readonly errors: AdjustmentFormErrors;
  readonly ok: boolean;
}

export function validateAdjustmentForm(
  fields: AdjustmentFormFields,
  currentQuantity: number,
): AdjustmentFormValidation {
  const errors: AdjustmentFormErrors = {};
  const valueError = validateAdjustmentField('value', fields, currentQuantity);
  if (valueError) {
    errors.value = valueError;
  }
  const reasonError = validateAdjustmentField('reason', fields, currentQuantity);
  if (reasonError) {
    errors.reason = reasonError;
  }
  return { errors, ok: Object.keys(errors).length === 0 };
}
