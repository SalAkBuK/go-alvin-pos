import type { CompletedSaleResult } from '../../../../shared/checkout';
import { describeSaleSuccess } from './checkoutCompletion';

/**
 * The post-commit Cash success screen (`POS_WORKFLOWS.md §37`; task `§13`).
 *
 * Extracted from `CheckoutPage` so it can render on its own in tests. Adds an
 * enabled `View receipt` action (Phase 2E.1) alongside the existing `New Sale`;
 * `Print receipt` stays visibly unavailable — physical printing is a later
 * slice and this screen must never imply it works.
 */

export interface SaleSuccessProps {
  readonly result: CompletedSaleResult;
  readonly onViewReceipt: () => void;
  readonly onNewSale: () => void;
}

export function SaleSuccess({ result, onViewReceipt, onNewSale }: SaleSuccessProps) {
  const success = describeSaleSuccess(result);
  return (
    <section className="checkout-page">
      <section className="checkout-success" role="status">
        <h3>{success.heading}</h3>
        <dl className="checkout-totals">
          {success.lines.map((line) => (
            <div key={line.label}>
              <dt>{line.label}</dt>
              <dd>{line.value}</dd>
            </div>
          ))}
        </dl>
        <p className="field-hint">
          The sale is saved. Receipt printing arrives in a later version.
        </p>
        <div className="checkout-actions">
          <button type="button" onClick={onViewReceipt}>
            View receipt
          </button>
          <button type="button" disabled title="Receipt printing arrives in a later version">
            Print receipt (not available yet)
          </button>
          <button type="button" onClick={onNewSale}>
            New Sale
          </button>
        </div>
      </section>
    </section>
  );
}
