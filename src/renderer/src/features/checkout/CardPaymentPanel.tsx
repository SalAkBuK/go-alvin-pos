import type { CardAttempt } from './cardCheckout';
import { describeCardLocalFailure, describeCloverInstruction } from './cardCheckout';

/**
 * The Card checkout takeover view (`POS_WORKFLOWS.md §30`, `§35A`; task Phase 2F
 * `§9`, `§17`, `§39`). It replaces the cart while a Card attempt is on record so
 * the reviewed cart cannot be edited underneath it (`§10`).
 *
 * It NEVER shows a card-number field, an authorization-code field, a terminal
 * transaction id, CVV, a Clover login, or an API-connection status — V1 card
 * processing is entirely manual and the POS knows nothing about Clover's result
 * until the cashier says so.
 */

export interface CardPaymentPanelProps {
  readonly attempt: CardAttempt;
  readonly onApproved: () => void;
  readonly onDeclined: () => void;
  readonly onRetryLocalSave: () => void;
  readonly onAbandon: () => void;
}

export function CardPaymentPanel({
  attempt,
  onApproved,
  onDeclined,
  onRetryLocalSave,
  onAbandon,
}: CardPaymentPanelProps) {
  if (attempt.phase === 'beginning') {
    return (
      <section className="checkout-page">
        <section className="card-payment card-payment-beginning" role="status">
          <h3>CARD PAYMENT</h3>
          <p>Preparing the card payment…</p>
          <p className="field-hint">
            Do not process anything on Clover yet — wait for the amount to appear here.
          </p>
        </section>
      </section>
    );
  }

  if (attempt.phase === 'awaiting_clover' || attempt.phase === 'declining') {
    const instruction = describeCloverInstruction(attempt.intendedTotalCents);
    const busy = attempt.phase === 'declining';
    return (
      <section className="checkout-page">
        <section className="card-payment card-payment-awaiting" role="status">
          <h3>{instruction.heading}</h3>
          <p className="card-payment-amount">{instruction.amountLine}</p>
          <p>{instruction.terminalLine}</p>
          <p className="card-payment-prompt">{instruction.prompt}</p>
          <div className="checkout-actions">
            <button type="button" onClick={onApproved} disabled={busy}>
              {instruction.approveLabel}
            </button>
            <button type="button" onClick={onDeclined} disabled={busy}>
              {busy ? 'Cancelling…' : instruction.declineLabel}
            </button>
          </div>
        </section>
      </section>
    );
  }

  if (attempt.phase !== 'recording' && attempt.phase !== 'local_failure') {
    return null; // 'idle' — the CheckoutPage renders the cart instead.
  }

  if (attempt.phase === 'recording') {
    return (
      <section className="checkout-page">
        <section className="card-payment card-payment-recording" role="status">
          <h3>SAVING CARD SALE</h3>
          <p>{attempt.retry ? 'Retrying the local save…' : 'Recording the approved card sale…'}</p>
          <p className="field-hint">Do not run the card again.</p>
        </section>
      </section>
    );
  }

  // local_failure
  const view = describeCardLocalFailure(attempt.message);
  return (
    <section className="checkout-page">
      <section className="card-payment card-payment-failure" role="alert">
        <h3>{view.heading}</h3>
        <pre className="card-payment-warning">{view.body}</pre>
        <div className="checkout-actions">
          <button type="button" onClick={onRetryLocalSave}>
            {view.retryLabel}
          </button>
          <button type="button" onClick={onAbandon}>
            {view.abandonLabel}
          </button>
        </div>
        <p className="field-hint">
          “{view.retryLabel}” saves the sale locally using the approval already on record. It does
          not charge the card again.
        </p>
      </section>
    </section>
  );
}
