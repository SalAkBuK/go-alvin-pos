import { formatCents } from '../../../../shared/money';
import type { PaymentMethod } from '../../../../shared/checkout';
import type { SaleDetail } from '../../../../shared/salesHistory';
import { CARD_VOID_CLOVER_WARNING, VOID_REASON_MAX_LENGTH } from '../../../../shared/salesHistory';
import { describePaymentMethod } from './salesHistory';

/**
 * Pure, React-free helpers + gates for the Void Sale panel (`REQ-VOID-002`,
 * `REQ-VOID-008`; `POS_WORKFLOWS.md §88`, `§90`; `task §9`-`§11`). No jsdom in
 * the renderer suites, so the reason gate, the submit gate, and the Clover
 * warning are unit-tested here directly. The trusted layer re-validates
 * everything — this only spares the cashier an obvious round-trip.
 */

export { CARD_VOID_CLOVER_WARNING, VOID_REASON_MAX_LENGTH };

/** `null` when the reason is acceptable to submit; otherwise the message to show. */
export function voidReasonError(reason: string): string | null {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    return 'Enter a reason for voiding this sale.';
  }
  if (trimmed.length > VOID_REASON_MAX_LENGTH) {
    return `The void reason must be ${VOID_REASON_MAX_LENGTH} characters or fewer.`;
  }
  return null;
}

/**
 * The Clover warning a Card void must show and the cashier must acknowledge
 * before submitting (`REQ-VOID-008`, `POS_WORKFLOWS.md §90`). `null` for Cash —
 * a Cash void must not imply an automated refund (`task §11`).
 */
export function cardVoidWarning(paymentMethod: PaymentMethod): string | null {
  return paymentMethod === 'CARD' ? CARD_VOID_CLOVER_WARNING : null;
}

export interface VoidSubmitState {
  readonly reason: string;
  readonly paymentMethod: PaymentMethod;
  /** Whether the cashier has ticked the Card Clover acknowledgement. Ignored for Cash. */
  readonly acknowledged: boolean;
  readonly submitting: boolean;
}

/**
 * Whether "Confirm void" may be pressed: a valid reason, not already in flight,
 * and — for a Card sale only — the Clover warning explicitly acknowledged
 * (`task §10`, `§11`). UI disabling is a convenience; the trusted transaction is
 * the real double-void / validation guard.
 */
export function canSubmitVoid(state: VoidSubmitState): boolean {
  if (state.submitting) {
    return false;
  }
  if (voidReasonError(state.reason) !== null) {
    return false;
  }
  if (state.paymentMethod === 'CARD' && !state.acknowledged) {
    return false;
  }
  return true;
}

export interface VoidTransactionContextRow {
  readonly label: string;
  readonly value: string;
}

/**
 * The immutable original-transaction context shown before confirming a void
 * (`POS_WORKFLOWS.md §88` step 1; `task §10`). Straight from the committed
 * detail — nothing recomputed.
 */
export function voidTransactionContext(detail: SaleDetail): readonly VoidTransactionContextRow[] {
  return [
    { label: 'Receipt', value: detail.receiptNumber },
    { label: 'Total', value: formatCents(detail.totalCents) },
    { label: 'Payment method', value: describePaymentMethod(detail.paymentMethod) },
  ];
}
