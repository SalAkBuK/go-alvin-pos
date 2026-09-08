import type { CompletedSaleResult, SaleExportStatus } from '../../../../shared/checkout';
import type { AppErrorCode } from '../../../../shared/products';
import { formatCents } from '../../../../shared/money';

/**
 * Pure helpers for the Cash completion lifecycle (`POS_WORKFLOWS.md §33`-`§37`,
 * `§87`). Kept React-free so the classification and success-screen shaping are
 * unit-testable without a DOM (repo convention: no jsdom).
 */

/**
 * Trusted-layer error codes that mean "the reviewed checkout is no longer valid
 * — fix the cart and Review again". The renderer drops the review (a fresh
 * review mints a new attempt id) but keeps the lines, customer, and payment.
 */
const RE_REVIEW_CODES: ReadonlySet<AppErrorCode> = new Set<AppErrorCode>([
  'CHECKOUT_DRIFT',
  'IDEMPOTENCY_CONFLICT',
  'CHECKOUT_REQUEST_INVALID',
  'INSUFFICIENT_STOCK',
  'PRODUCT_ARCHIVED',
  'PRODUCT_NOT_FOUND',
  'CUSTOMER_NOT_FOUND',
  'TAX_RATE_NOT_CONFIGURED',
  'CHECKOUT_TOTAL_EXCEEDED',
  'VALIDATION',
]);

export function requiresReReview(code: AppErrorCode): boolean {
  return RE_REVIEW_CODES.has(code);
}

/**
 * A storage commit failure: no sale was recorded, but the reviewed cart is
 * unchanged, so the cashier may retry the *same* attempt (same request id) once
 * the underlying problem clears — without rebuilding or re-reviewing.
 */
export function isRetryableCommitFailure(code: AppErrorCode): boolean {
  return code === 'SALE_COMMIT_FAILED';
}

export function describeExportStatus(status: SaleExportStatus): string {
  switch (status) {
    case 'PENDING':
    case 'EXPORTING':
      return 'Pending';
    case 'EXPORTED':
      return 'Sent';
    case 'FAILED':
      return 'Failed — will retry';
  }
}

export interface SaleSuccessLine {
  readonly label: string;
  readonly value: string;
}

/** The success-screen content (`POS_WORKFLOWS.md §37`). No customer PII. */
export function describeSaleSuccess(result: CompletedSaleResult): {
  readonly heading: string;
  readonly lines: readonly SaleSuccessLine[];
} {
  return {
    heading: result.alreadyCompleted ? 'SALE ALREADY COMPLETED' : 'SALE COMPLETE',
    lines: [
      { label: 'Receipt', value: result.receiptNumber },
      { label: 'Total', value: formatCents(result.totalCents) },
      { label: 'Payment', value: result.paymentMethod === 'CASH' ? 'Cash' : 'Card' },
      { label: 'Google Sheets', value: describeExportStatus(result.exportStatus) },
    ],
  };
}
