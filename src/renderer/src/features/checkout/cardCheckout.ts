import type { BeginCardCheckoutResult, CompletedSaleResult } from '../../../../shared/checkout';
import type { AppErrorCode } from '../../../../shared/products';
import { formatCents } from '../../../../shared/money';

/**
 * Pure, React-free state machine + display shaping for the manual Clover Card
 * checkout (`POS_WORKFLOWS.md §30`-`§35B`; `DATA_MODEL.md §31`-`§31B`; task
 * Phase 2F `§6`, `§9`, `§10`, `§17`, `§23`, `§39`). Kept DOM-free so it is
 * unit-testable without jsdom (repo convention).
 *
 * The cashier progresses through explicit UI states. No Clover instruction is
 * ever shown before Phase 1 Step A has committed (`begin-card` resolved `ok`):
 *
 *   REVIEWED
 *      ↓  begin-card commits PENDING_PAYMENT
 *   AWAITING_CLOVER_RESULT ──[Payment Declined / Cancel]──▶ back to editable cart
 *      ↓  [Payment Approved]
 *   RECORDING (Step B + Phase 2)
 *      ├─ ok ─────────────▶ SUCCESS (normal Sale Success screen)
 *      └─ CARD_LOCAL_COMMIT_FAILURE ▶ LOCAL_FAILURE (critical Clover-review
 *                                     warning; [Retry local save], never
 *                                     "process card again")
 */

export type CardAttempt =
  | { readonly phase: 'idle' }
  | { readonly phase: 'beginning' }
  | {
      readonly phase: 'awaiting_clover';
      readonly requestId: string;
      readonly intendedTotalCents: number;
    }
  | {
      readonly phase: 'recording';
      readonly requestId: string;
      readonly intendedTotalCents: number;
      /** `true` when re-entering the local save after a commit failure (`§23`). */
      readonly retry: boolean;
    }
  | {
      readonly phase: 'declining';
      readonly requestId: string;
      readonly intendedTotalCents: number;
    }
  | {
      readonly phase: 'local_failure';
      readonly requestId: string;
      readonly intendedTotalCents: number;
      /** The trusted layer's critical Clover-review warning, shown verbatim. */
      readonly message: string;
    };

export const IDLE_CARD_ATTEMPT: CardAttempt = { phase: 'idle' };

/**
 * While a Card attempt is on record the reviewed cart is frozen — no quantity,
 * price, customer, or payment-method edit may silently rewrite the request
 * behind it (`§10`). The Card panel takes over the whole checkout view in these
 * phases, so cart controls are also physically unreachable.
 */
export function isCardCheckoutLocked(attempt: CardAttempt): boolean {
  return attempt.phase !== 'idle';
}

/** Map a committed Phase 1 Step A result to the next UI state / action. */
export type BeginCardOutcome =
  | { readonly kind: 'awaiting'; readonly attempt: CardAttempt }
  | { readonly kind: 'approved'; readonly requestId: string; readonly intendedTotalCents: number }
  | { readonly kind: 'completed'; readonly result: CompletedSaleResult };

export function interpretBeginResult(result: BeginCardCheckoutResult): BeginCardOutcome {
  if (result.stage === 'completed' && result.completed) {
    return { kind: 'completed', result: result.completed };
  }
  if (result.stage === 'approved') {
    return {
      kind: 'approved',
      requestId: result.requestId,
      intendedTotalCents: result.intendedTotalCents,
    };
  }
  return {
    kind: 'awaiting',
    attempt: {
      phase: 'awaiting_clover',
      requestId: result.requestId,
      intendedTotalCents: result.intendedTotalCents,
    },
  };
}

/**
 * A `complete-card` failure carrying this code means a possible real Clover
 * charge with no local sale — the cashier must be shown the critical
 * Clover-review warning, never a plain "try again" (`§17`, `§24`).
 */
export function isCardLocalCommitFailure(code: AppErrorCode): boolean {
  return code === 'CARD_LOCAL_COMMIT_FAILURE';
}

// ── Display shaping ─────────────────────────────────────────────────────────

export interface CloverInstruction {
  readonly heading: string;
  readonly amountLine: string;
  readonly terminalLine: string;
  readonly prompt: string;
  readonly approveLabel: string;
  readonly declineLabel: string;
}

/** The Clover instruction screen (`POS_WORKFLOWS.md §30` step 8; task `§9`). */
export function describeCloverInstruction(intendedTotalCents: number): CloverInstruction {
  return {
    heading: 'CARD PAYMENT',
    amountLine: `Process ${formatCents(intendedTotalCents)} on Clover.`,
    terminalLine: 'Use the existing card terminal.',
    prompt: 'Was payment approved?',
    approveLabel: 'Payment Approved',
    declineLabel: 'Payment Declined / Cancel',
  };
}

export interface CardLocalFailureView {
  readonly heading: string;
  /** The verbatim trusted warning (possible charge, do not re-run, check Clover). */
  readonly body: string;
  /** Re-enters ONLY the local save — never re-instructs Clover (`§23`). */
  readonly retryLabel: string;
  readonly abandonLabel: string;
}

export function describeCardLocalFailure(message: string): CardLocalFailureView {
  return {
    heading: 'CARD SALE NOT SAVED LOCALLY',
    body: message,
    retryLabel: 'Retry local save',
    abandonLabel: 'Leave for reconciliation',
  };
}
