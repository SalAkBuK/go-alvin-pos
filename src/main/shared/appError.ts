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
  checkoutDrift: (): AppError =>
    new AppError(
      'CHECKOUT_DRIFT',
      'Checkout details changed. Review the sale again before completing it.',
    ),
  idempotencyConflict: (): AppError =>
    new AppError(
      'IDEMPOTENCY_CONFLICT',
      'This checkout request was already used for a different sale. Review the cart again.',
    ),
  businessNotConfigured: (): AppError =>
    new AppError(
      'BUSINESS_NOT_CONFIGURED',
      'The store address and phone must be set in Settings before a sale can be completed.',
    ),
  saleCommitFailed: (): AppError =>
    new AppError(
      'SALE_COMMIT_FAILED',
      'Sale could not be completed because the local database could not be updated safely. No sale was recorded.',
    ),
  checkoutRequestInvalid: (): AppError =>
    new AppError(
      'CHECKOUT_REQUEST_INVALID',
      'This checkout can no longer be completed. Start a new sale.',
    ),
  cardLocalCommitFailure: (requestId: string): AppError =>
    new AppError(
      'CARD_LOCAL_COMMIT_FAILURE',
      [
        'Local sale could not be saved.',
        '',
        'If you already saw "Approved" on Clover, that charge may still exist.',
        'DO NOT RUN THE CARD AGAIN.',
        '',
        'Check this transaction in Clover directly. If it was charged and you',
        'cannot complete the local sale, void or refund it manually in Clover.',
        '',
        `This attempt was recorded for reconciliation: ${requestId}`,
      ].join('\n'),
    ),
  receiptNotFound: (): AppError =>
    new AppError('RECEIPT_NOT_FOUND', 'That sale could not be found.'),
  saleNotFound: (): AppError =>
    new AppError('SALE_NOT_FOUND', 'That sale could not be found in Sales History.'),
  saleAlreadyVoided: (): AppError =>
    new AppError(
      'SALE_ALREADY_VOIDED',
      'This sale has already been voided. Its original void reason and timestamp are unchanged.',
    ),
  voidCommitFailed: (): AppError =>
    new AppError(
      'VOID_COMMIT_FAILED',
      'The sale could not be voided because the local database could not be updated safely. Nothing was changed — the sale is still completed.',
    ),
  receiptDataInconsistent: (): AppError =>
    new AppError(
      'RECEIPT_DATA_INCONSISTENT',
      'The receipt for this sale could not be assembled from the stored transaction data.',
    ),
  printerNotConfigured: (): AppError =>
    new AppError(
      'PRINTER_NOT_CONFIGURED',
      'No receipt printer is selected. Choose a printer in Settings, then try printing again.',
    ),
  printerUnavailable: (): AppError =>
    new AppError(
      'PRINTER_UNAVAILABLE',
      'The selected receipt printer is not available. Check that it is connected and turned on, or choose another printer in Settings. The sale is saved and can be reprinted.',
    ),
  printFailed: (): AppError =>
    new AppError(
      'PRINT_FAILED',
      'The receipt could not be printed. The sale is saved — you can retry printing or reprint it later from Sales History.',
    ),
} as const;
