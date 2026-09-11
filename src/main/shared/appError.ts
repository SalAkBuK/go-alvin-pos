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
  googleSecureStorageUnavailable: (): AppError =>
    new AppError(
      'GOOGLE_SECURE_STORAGE_UNAVAILABLE',
      'Your Google account cannot be connected because this device cannot store the connection securely.',
    ),
  googleOAuthNotConfigured: (): AppError =>
    new AppError(
      'GOOGLE_OAUTH_NOT_CONFIGURED',
      'Google connection is not available in this build of Go Phones POS.',
    ),
  googleAuthorizationFailed: (detail?: string): AppError =>
    new AppError(
      'GOOGLE_AUTHORIZATION_FAILED',
      detail
        ? `Your Google account could not be connected: ${detail}.`
        : 'Your Google account could not be connected.',
    ),
  googleCredentialInvalid: (): AppError =>
    new AppError(
      'GOOGLE_CREDENTIAL_INVALID',
      'The stored Google connection is no longer valid. Connect your Google account again.',
    ),
  googleNotConnected: (): AppError =>
    new AppError('GOOGLE_NOT_CONNECTED', 'Connect a Google account first.'),
  googleSpreadsheetNotReady: (): AppError =>
    new AppError('GOOGLE_SPREADSHEET_NOT_READY', 'The Google sales spreadsheet is not set up yet.'),
  googleAuthorizationInProgress: (): AppError =>
    new AppError(
      'GOOGLE_AUTHORIZATION_IN_PROGRESS',
      'A Google sign-in is already in progress. Finish or close it first.',
    ),
  backupInProgress: (): AppError =>
    new AppError(
      'BACKUP_IN_PROGRESS',
      'A backup is already running. Wait for it to finish, then try again.',
    ),
  backupFailed: (): AppError =>
    new AppError(
      'BACKUP_FAILED',
      'The backup could not be completed. Your sales data is safe and the app keeps working — check Backup & Restore for details, then try again.',
    ),
  offDeviceDestinationInvalid: (): AppError =>
    new AppError(
      'OFF_DEVICE_DESTINATION_INVALID',
      'That location could not be verified as an accessible external USB drive or network backup location.',
    ),
  maintenanceInProgress: (): AppError =>
    new AppError(
      'MAINTENANCE_IN_PROGRESS',
      'The database is being restored. This action is unavailable until the restore finishes.',
    ),
  restoreBlockedCheckoutActive: (): AppError =>
    new AppError(
      'RESTORE_BLOCKED_CHECKOUT_ACTIVE',
      'Finish or clear the current sale before restoring the database.',
    ),
  restoreBlockedCardPending: (): AppError =>
    new AppError(
      'RESTORE_BLOCKED_CARD_PENDING',
      'Resolve the pending card payment or reconciliation before restoring the database.',
    ),
  restoreAlreadyRunning: (): AppError =>
    new AppError('RESTORE_ALREADY_RUNNING', 'A database restore is already running.'),
  restoreCandidateNotFound: (): AppError =>
    new AppError(
      'RESTORE_CANDIDATE_NOT_FOUND',
      'That backup could not be found, or its file is missing. Choose another backup.',
    ),
  restoreCandidateInvalid: (): AppError =>
    new AppError(
      'RESTORE_CANDIDATE_INVALID',
      'This backup did not pass its safety check and cannot be restored. Choose another backup.',
    ),
  restoreSchemaIncompatible: (relation: 'older' | 'newer'): AppError =>
    new AppError(
      'RESTORE_SCHEMA_INCOMPATIBLE',
      relation === 'older'
        ? 'This backup is from an older version of Go Phones POS and cannot be restored by this version. Contact support for a matching version.'
        : 'This backup was made by a newer version of Go Phones POS. Update this computer to that version or newer before restoring it.',
    ),
  restoreValidationFailed: (): AppError =>
    new AppError(
      'RESTORE_VALIDATION_FAILED',
      'The restore did not pass validation, so your previous database has been put back. No data was lost.',
    ),
  restoreRecoveryFailed: (): AppError =>
    new AppError(
      'RESTORE_RECOVERY_FAILED',
      'The restore failed and automatic recovery could not complete. Restart the application; it will finish recovering your previous database. Contact support if this repeats.',
    ),
  restoreConfirmationStale: (): AppError =>
    new AppError(
      'RESTORE_CONFIRMATION_STALE',
      'Your data changed since the warning was shown. Review the updated warning before restoring.',
    ),
} as const;
