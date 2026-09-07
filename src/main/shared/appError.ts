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
} as const;
