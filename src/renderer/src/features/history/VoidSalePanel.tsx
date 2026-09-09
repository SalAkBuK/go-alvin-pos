import { useState } from 'react';
import type { SaleDetail } from '../../../../shared/salesHistory';
import {
  canSubmitVoid,
  cardVoidWarning,
  voidReasonError,
  voidTransactionContext,
} from './voidSale';

/**
 * The Void Sale confirmation panel (`REQ-VOID-002`, `REQ-VOID-008`;
 * `POS_WORKFLOWS.md §88`, `§90`; `task §10`, `§11`).
 *
 * Shows the immutable original-transaction context, requires a non-blank reason
 * and — for a Card sale — an explicit acknowledgement of the Clover warning (a
 * real checkbox, not passive text). "Confirm void" is the explicit confirmation
 * step; it is disabled until the gate passes and while a request is in flight,
 * so a void cannot be submitted twice. It never mentions an automated refund for
 * Cash, and triggers no Clover / network call.
 */

export interface VoidSalePanelProps {
  readonly detail: SaleDetail;
  readonly submitting: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onConfirm: (reason: string) => void;
}

export function VoidSalePanel({
  detail,
  submitting,
  error,
  onCancel,
  onConfirm,
}: VoidSalePanelProps) {
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [touched, setTouched] = useState(false);

  const warning = cardVoidWarning(detail.paymentMethod);
  const reasonMessage = voidReasonError(reason);
  const canSubmit = canSubmitVoid({
    reason,
    paymentMethod: detail.paymentMethod,
    acknowledged,
    submitting,
  });

  return (
    <section className="void-sale-panel">
      <h3>Void sale {detail.receiptNumber}</h3>

      <dl className="checkout-totals">
        {voidTransactionContext(detail).map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>

      <p className="field-hint">
        Voiding keeps this sale in Sales History as <strong>VOIDED</strong> with your reason and a
        timestamp, restores the sold stock, and does not delete or change the original transaction.
      </p>

      {warning !== null && (
        <div className="void-clover-warning" role="alert">
          <p>{warning}</p>
          <label>
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            I understand the Clover payment is not refunded or reversed by this void.
          </label>
        </div>
      )}

      <label className="void-reason">
        Reason for voiding (required)
        <textarea
          value={reason}
          aria-label="Void reason"
          onChange={(e) => setReason(e.target.value)}
          onBlur={() => setTouched(true)}
        />
      </label>
      {touched && reasonMessage !== null && (
        <p className="product-form-error" role="alert">
          {reasonMessage}
        </p>
      )}

      {error !== null && (
        <p className="product-form-error" role="alert">
          {error}
        </p>
      )}

      {submitting && <p role="status">Voiding sale…</p>}

      <div className="checkout-actions">
        <button type="button" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            setTouched(true);
            if (canSubmit) {
              onConfirm(reason.trim());
            }
          }}
          disabled={!canSubmit}
        >
          {submitting ? 'Voiding…' : 'Confirm void'}
        </button>
      </div>
    </section>
  );
}
