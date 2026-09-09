import type { ReceiptRepresentation } from '../../../../shared/receipt';
import { BrandLogo } from '../../components/BrandLogo';
import { describePrintSuccess, IDLE_PRINT, PRINT_FAILURE_HEADLINE } from '../printing/printReceipt';
import type { PrintState } from '../printing/printReceipt';
import { toReceiptView } from './receiptView';

/**
 * Receipt preview (`REQ-REC-001`-`REQ-REC-005`; `POS_WORKFLOWS.md §37`-`§41`;
 * `ARCHITECTURE.md §18`-`§19`; task `§8`, `§13`-`§14`).
 *
 * Renders the committed transaction — never the temporary checkout cart — on a
 * constrained receipt-paper surface. It consumes the trusted
 * {@link ReceiptRepresentation} only; it holds no receipt truth of its own.
 *
 * Phase 2I enables physical printing: when `onPrint` is supplied, `Print
 * receipt` (or `Reprint receipt` from Sales History) drives the trusted
 * `window.pos.printing.printReceipt(saleId)` path. A print failure always keeps
 * saying the sale succeeded (`REQ-REC-005`) and offers Retry. A `VOIDED` sale
 * shows a clear VOIDED banner both here and on the printed copy (`task §8`).
 *
 * Reused verbatim by Sales History → Sale Detail → View / Reprint Receipt.
 */

export interface ReceiptPreviewProps {
  readonly representation: ReceiptRepresentation | null;
  readonly loading: boolean;
  readonly error: string | null;
  /** From the committed sale result — shown in the failure state for reassurance. */
  readonly saleReceiptNumber: string;
  readonly onBack: () => void;
  /** Omitted when there is no new-sale flow to return to (e.g. Sales History). */
  readonly onNewSale?: (() => void) | undefined;
  /** Enables the print action. Omitted → the button is not shown. */
  readonly onPrint?: (() => void) | undefined;
  /** Current print attempt state; defaults to idle. */
  readonly printState?: PrintState | undefined;
  /** `Print receipt` (default) or `Reprint receipt` (Sales History). */
  readonly printActionLabel?: string | undefined;
}

function PrintControls({
  onPrint,
  printState,
  printActionLabel,
}: {
  onPrint?: (() => void) | undefined;
  printState: PrintState;
  printActionLabel: string;
}) {
  if (!onPrint) {
    return null;
  }
  const busy = printState.phase === 'printing';
  return (
    <>
      <button type="button" onClick={onPrint} disabled={busy}>
        {busy ? 'Printing…' : printState.phase === 'failed' ? `Retry print` : printActionLabel}
      </button>
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
    </>
  );
}

function Actions({
  onBack,
  onNewSale,
  onPrint,
  printState,
  printActionLabel,
}: {
  onBack: () => void;
  onNewSale?: (() => void) | undefined;
  onPrint?: (() => void) | undefined;
  printState: PrintState;
  printActionLabel: string;
}) {
  return (
    <div className="checkout-actions">
      <button type="button" onClick={onBack}>
        Back
      </button>
      <PrintControls
        onPrint={onPrint}
        printState={printState}
        printActionLabel={printActionLabel}
      />
      {onNewSale && (
        <button type="button" onClick={onNewSale}>
          New Sale
        </button>
      )}
    </div>
  );
}

export function ReceiptPreview({
  representation,
  loading,
  error,
  saleReceiptNumber,
  onBack,
  onNewSale,
  onPrint,
  printState = IDLE_PRINT,
  printActionLabel = 'Print receipt',
}: ReceiptPreviewProps) {
  const actionProps = { onBack, onNewSale, onPrint, printState, printActionLabel };

  if (loading) {
    return (
      <section className="checkout-page">
        <p role="status">Loading receipt…</p>
        <Actions {...actionProps} onPrint={undefined} />
      </section>
    );
  }

  if (error !== null || representation === null) {
    return (
      <section className="checkout-page">
        <section className="receipt-load-error" role="alert">
          <p>
            <strong>Sale completed successfully.</strong> Receipt {saleReceiptNumber} is saved.
          </p>
          <p>The receipt preview could not be loaded.</p>
          {error !== null && <p className="field-hint">{error}</p>}
        </section>
        <Actions {...actionProps} onPrint={undefined} />
      </section>
    );
  }

  const view = toReceiptView(representation);

  return (
    <section className="checkout-page">
      <article className="receipt-paper" aria-label={`Receipt ${view.meta[0]?.value ?? ''}`}>
        <header className="receipt-head">
          <BrandLogo className="receipt-logo" decorative />
          <h3>{view.title}</h3>
          {view.businessLines
            .filter((l) => l.trim() !== '')
            .map((line) => (
              <p key={line}>{line}</p>
            ))}
        </header>

        {view.voided && (
          <section className="receipt-void-banner" role="alert">
            <p className="receipt-void-label">{view.voided.bannerLabel}</p>
            <p>This sale was voided on {view.voided.voidedAt}.</p>
            <p>Reason: {view.voided.reason}</p>
          </section>
        )}

        <dl className="receipt-meta">
          {view.meta.map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>

        {view.customer && (
          <div className="receipt-customer">
            <p className="receipt-section-label">Customer</p>
            <p>{view.customer.name}</p>
            {view.customer.phone && <p>{view.customer.phone}</p>}
          </div>
        )}

        <hr />

        <ul className="receipt-items">
          {view.items.map((item, index) => (
            <li key={`${item.name}-${String(index)}`}>
              <div className="receipt-item-row">
                <span className="receipt-item-name">{item.name}</span>
                <span className="receipt-item-amount">{item.amount}</span>
              </div>
              <div className="receipt-item-line">{item.line}</div>
              {item.detail && <div className="receipt-item-detail">{item.detail}</div>}
              {item.listNote && <div className="receipt-item-note">{item.listNote}</div>}
              {item.discountNote && <div className="receipt-item-note">{item.discountNote}</div>}
            </li>
          ))}
        </ul>

        <hr />

        <dl className="receipt-totals">
          {view.totalRows.map((row) => (
            <div key={row.label} className={row.emphasis ? 'receipt-total-emphasis' : undefined}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>

        <p className="receipt-payment">Payment: {view.paymentLabel}</p>

        {(view.disclaimer.trim() !== '' || view.footer.trim() !== '') && <hr />}
        {view.disclaimer.trim() !== '' && <p className="receipt-disclaimer">{view.disclaimer}</p>}
        {view.footer.trim() !== '' && <p className="receipt-footer">{view.footer}</p>}
      </article>

      <Actions {...actionProps} />
    </section>
  );
}
