import type { CompletedSaleResult } from '../../../../shared/checkout';
import { describePrintSuccess, IDLE_PRINT, PRINT_FAILURE_HEADLINE } from '../printing/printReceipt';
import type { PrintState } from '../printing/printReceipt';
import { describeSaleSuccess } from './checkoutCompletion';

/**
 * The post-commit success screen (`POS_WORKFLOWS.md §37`, `§40`; task `§13`).
 *
 * Phase 2I turns the previously-disabled `Print receipt` into a real action that
 * drives the trusted `window.pos.printing.printReceipt(saleId)` path. A print
 * failure never contradicts the success heading: it shows the reassurance line
 * plus `Retry print` / `Continue` (`ARCHITECTURE.md §19`). Retrying prints the
 * SAME sale — it never re-sends the checkout.
 */

export interface SaleSuccessProps {
  readonly result: CompletedSaleResult;
  readonly onViewReceipt: () => void;
  readonly onNewSale: () => void;
  readonly onPrint: () => void;
  readonly printState?: PrintState | undefined;
}

export function SaleSuccess({
  result,
  onViewReceipt,
  onNewSale,
  onPrint,
  printState = IDLE_PRINT,
}: SaleSuccessProps) {
  const success = describeSaleSuccess(result);
  const printing = printState.phase === 'printing';
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
        <p className="field-hint">The sale is saved.</p>

        {printState.phase === 'printed' && printState.result && (
          <p className="products-notice" role="status">
            {describePrintSuccess(printState.result)}
          </p>
        )}
        {printState.phase === 'failed' && (
          <p className="product-form-error" role="alert">
            {PRINT_FAILURE_HEADLINE}
            {printState.error ? ` ${printState.error}` : ''}
          </p>
        )}

        <div className="checkout-actions">
          <button type="button" onClick={onViewReceipt}>
            View receipt
          </button>
          <button type="button" onClick={onPrint} disabled={printing}>
            {printing
              ? 'Printing…'
              : printState.phase === 'failed'
                ? 'Retry print'
                : 'Print receipt'}
          </button>
          <button type="button" onClick={onNewSale}>
            {printState.phase === 'failed' ? 'Continue' : 'New Sale'}
          </button>
        </div>
      </section>
    </section>
  );
}
