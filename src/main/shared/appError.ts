import type { AppErrorCode, IpcError } from '../../shared/products';

/**
 * A structured, renderer-safe application error (task `§3`, `§19`).
 *
 * `message` is always a complete user-facing sentence and must never contain
 * SQL text, a raw SQLite error code, a stack frame, or a filesystem path. The
 * IPC layer maps an `AppError` straight onto `{ ok: false, error }`; anything
 * that is NOT an `AppError` is logged with detail and replaced by a generic
 * `INTERNAL` error before it reaches the renderer.
 */
export class AppError extends Error {
  override readonly name = 'AppError';
  readonly code: AppErrorCode;

  constructor(code: AppErrorCode, message: string) {
    super(message);
    this.code = code;
  }

  toIpcError(): IpcError {
    return { code: this.code, message: this.message };
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Convenience constructors for the common cases, so message text stays consistent. */
export const appErrors = {
  validation: (message: string): AppError => new AppError('VALIDATION', message),
  productNotFound: (): AppError =>
    new AppError('PRODUCT_NOT_FOUND', 'That product could not be found.'),
  duplicateBarcode: (): AppError =>
    new AppError('DUPLICATE_BARCODE', 'This barcode is already assigned to another product.'),
  duplicateSku: (): AppError =>
    new AppError('DUPLICATE_SKU', 'This SKU is already assigned to another product.'),
  inventoryNegative: (): AppError =>
    new AppError('INVENTORY_NEGATIVE', 'Stock cannot be reduced below zero.'),
  customerNotFound: (): AppError =>
    new AppError('CUSTOMER_NOT_FOUND', 'That customer could not be found.'),
  adjustmentNoChange: (): AppError =>
    new AppError(
      'ADJUSTMENT_NO_CHANGE',
      'The adjustment does not change the quantity. Enter a different amount.',
    ),
  databaseUnavailable: (): AppError =>
    new AppError(
      'DATABASE_UNAVAILABLE',
      'The local database is not available. Restart the application and try again.',
    ),
  productArchived: (name?: string): AppError =>
    new AppError(
      'PRODUCT_ARCHIVED',
      name
        ? `“${name}” is archived and can no longer be sold. Remove it from the cart.`
        : 'That product is archived and can no longer be sold. Remove it from the cart.',
    ),
  insufficientStock: (name: string, available: number): AppError =>
    new AppError(
      'INSUFFICIENT_STOCK',
      available === 1
        ? `Only 1 of “${name}” is available.`
        : `Only ${available} of “${name}” are available.`,
    ),
  taxRateNotConfigured: (): AppError =>
    new AppError(
      'TAX_RATE_NOT_CONFIGURED',
      'No tax rate is configured for this store. Ask the owner to set the tax rate before checking out.',
    ),
  checkoutTotalExceeded: (): AppError =>
    new AppError(
      'CHECKOUT_TOTAL_EXCEEDED',
      'This cart total is above the maximum a single sale can record. Split it into smaller sales.',
    ),
  taxRateUnchanged: (): AppError =>
    new AppError(
      'TAX_RATE_UNCHANGED',
      'That is already the configured tax rate. No change was made.',
    ),
  businessSettingsUnchanged: (): AppError =>
    new AppError(
      'BUSINESS_SETTINGS_UNCHANGED',
      'The business and receipt details are already saved as entered. No change was made.',
    ),
} as const;
