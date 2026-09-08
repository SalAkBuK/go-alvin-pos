import type { ReceiptRepresentation } from '../../../../shared/receipt';
import { toReceiptView } from './receiptView';

/**
 * Receipt preview (`REQ-REC-001`-`REQ-REC-003`; `POS_WORKFLOWS.md §37`-`§38`;
 * `ARCHITECTURE.md §18`; task `§14`-`§15`).
 *
 * Renders the committed transaction — never the temporary checkout cart — on a
 * constrained receipt-paper surface so 80 mm / 58 mm thermal rendering can be
 * added later without a redesign (`REQ-PRINT-003`). It consumes the trusted
 * {@link ReceiptRepresentation} only; it holds no receipt truth of its own.
 *
 * `Back` returns to the success screen without recreating an editable cart —
 * once committed, this is historical data. `Print receipt` stays unavailable.
 * A failed load still states the sale succeeded (`REQ-REC-005`,
 * `ARCHITECTURE.md §19`): a receipt-view failure never means the sale failed.
 */

export interface ReceiptPreviewProps {
  readonly representation: ReceiptRepresentation | null;
  readonly loading: boolean;
  readonly error: string | null;
  /** From the committed sale result — shown in the failure state for reassurance. */
  readonly saleReceiptNumber: string;
  readonly onBack: () => void;
  readonly onNewSale: () => void;
}

function Actions({ onBack, onNewSale }: { onBack: () => void; onNewSale: () => void }) {
  return (
    <div className="checkout-actions">
      <button type="button" onClick={onBack}>
        Back
      </button>
      <button type="button" disabled title="Receipt printing arrives in a later version">
        Print receipt (not available yet)
      </button>
      <button type="button" onClick={onNewSale}>
        New Sale
      </button>
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
}: ReceiptPreviewProps) {
  if (loading) {
    return (
      <section className="checkout-page">
        <p role="status">Loading receipt…</p>
        <Actions onBack={onBack} onNewSale={onNewSale} />
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
        <Actions onBack={onBack} onNewSale={onNewSale} />
      </section>
    );
  }

  const view = toReceiptView(representation);

  return (
    <section className="checkout-page">
      <article className="receipt-paper" aria-label={`Receipt ${view.meta[0]?.value ?? ''}`}>
        <header className="receipt-head">
          <h3>{view.title}</h3>
          {view.businessLines
            .filter((l) => l.trim() !== '')
            .map((line) => (
              <p key={line}>{line}</p>
            ))}
        </header>

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

      <Actions onBack={onBack} onNewSale={onNewSale} />
    </section>
  );
}
