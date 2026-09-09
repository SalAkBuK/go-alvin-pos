import { useCallback, useEffect, useState } from 'react';
import type { IpcResult } from '../../../../shared/products';
import type { ReceiptRepresentation } from '../../../../shared/receipt';
import type { SaleDetail, SalesHistoryEntry } from '../../../../shared/salesHistory';
import { ReceiptPreview } from '../checkout/ReceiptPreview';
import {
  toHistorySearch,
  toSaleDetailView,
  toSalesHistoryRow,
  validateHistorySearchInput,
} from './salesHistory';

/**
 * Sales History area (`REQ-HIST-001`-`REQ-HIST-004`; `POS_WORKFLOWS.md §50`-`§52`;
 * `task §4`, `§32`-`§33`, `§36`).
 *
 * A read-only screen: the list with receipt / customer / business-date search, a
 * historical sale detail, and "View Receipt" which reuses the existing
 * `window.pos.receipts.getBySaleId` path and the shared {@link ReceiptPreview}.
 * All data comes from local SQLite through the narrow `window.pos.salesHistory.*`
 * surface — the renderer never sees SQL and this screen never mutates anything.
 * There is no void, no reprint, and no Retry Export here.
 */

type View =
  | { readonly kind: 'list' }
  | { readonly kind: 'detail'; readonly saleId: string }
  | { readonly kind: 'receipt'; readonly saleId: string; readonly receiptNumber: string };

function pos() {
  if (typeof window === 'undefined' || typeof window.pos === 'undefined') {
    return null;
  }
  return window.pos;
}

async function unwrap<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const result = await promise;
  if (result.ok) {
    return result.data;
  }
  throw new Error(result.error.message);
}

export function SalesHistoryPage() {
  const [view, setView] = useState<View>({ kind: 'list' });

  // List state
  const [entries, setEntries] = useState<readonly SalesHistoryEntry[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [date, setDate] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);

  // Detail state
  const [detail, setDetail] = useState<SaleDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Receipt state (reuses the Phase 2E.1 receipt path)
  const [receipt, setReceipt] = useState<ReceiptRepresentation | null>(null);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [receiptLoading, setReceiptLoading] = useState(false);

  const load = useCallback(async () => {
    const inputMessage = validateHistorySearchInput({ query, date });
    setInputError(inputMessage);
    if (inputMessage) {
      return;
    }
    const api = pos();
    if (!api) {
      setLoading(false);
      setListError('Sales History is unavailable in this context.');
      return;
    }
    setLoading(true);
    try {
      setEntries(await unwrap(api.salesHistory.list(toHistorySearch({ query, date }))));
      setListError(null);
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [query, date]);

  useEffect(() => {
    void load();
  }, [load]);

  const clearFilters = useCallback(() => {
    setQuery('');
    setDate('');
    setInputError(null);
  }, []);

  const openDetail = useCallback(async (saleId: string) => {
    setView({ kind: 'detail', saleId });
    setDetail(null);
    setDetailError(null);
    const api = pos();
    if (!api) {
      setDetailError('Sale details are unavailable in this context.');
      return;
    }
    setDetailLoading(true);
    try {
      setDetail(await unwrap(api.salesHistory.getById(saleId)));
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : String(error));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const openReceipt = useCallback(async (saleId: string, receiptNumber: string) => {
    setView({ kind: 'receipt', saleId, receiptNumber });
    setReceipt(null);
    setReceiptError(null);
    const api = pos();
    if (!api) {
      setReceiptError('Receipt preview is unavailable in this context.');
      return;
    }
    setReceiptLoading(true);
    try {
      setReceipt(await unwrap(api.receipts.getBySaleId(saleId)));
    } catch (error) {
      setReceiptError(error instanceof Error ? error.message : String(error));
    } finally {
      setReceiptLoading(false);
    }
  }, []);

  if (view.kind === 'receipt') {
    return (
      <ReceiptPreview
        representation={receipt}
        loading={receiptLoading}
        error={receiptError}
        saleReceiptNumber={view.receiptNumber}
        onBack={() => setView({ kind: 'detail', saleId: view.saleId })}
      />
    );
  }

  if (view.kind === 'detail') {
    return (
      <SaleDetailView
        detail={detail}
        loading={detailLoading}
        error={detailError}
        onBack={() => setView({ kind: 'list' })}
        onViewReceipt={() => {
          if (detail) {
            void openReceipt(detail.saleId, detail.receiptNumber);
          }
        }}
      />
    );
  }

  return (
    <section className="sales-history-page">
      <header className="products-toolbar">
        <input
          type="search"
          placeholder="Search receipt or customer…"
          aria-label="Search receipt or customer"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <input
          type="date"
          aria-label="Business date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <button type="button" onClick={clearFilters} disabled={query === '' && date === ''}>
          Clear filters
        </button>
      </header>

      {inputError && (
        <p className="product-form-error" role="alert">
          {inputError}
        </p>
      )}
      {listError && (
        <p className="product-form-error" role="alert">
          Unable to load sales history. {listError}
        </p>
      )}
      {loading && !listError && <p role="status">Loading sales…</p>}

      {!loading && !listError && entries !== null && (
        <table className="sales-history-table">
          <thead>
            <tr>
              <th>Receipt</th>
              <th>Date</th>
              <th>Customer</th>
              <th>Total</th>
              <th>Payment</th>
              <th>Google Sheets</th>
              <th>Status</th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const row = toSalesHistoryRow(entry);
              return (
                <tr key={row.saleId} className={row.voided ? 'sales-history-voided' : undefined}>
                  <td>{row.receiptNumber}</td>
                  <td>{row.date}</td>
                  <td>{row.customerLabel}</td>
                  <td>{row.total}</td>
                  <td>{row.paymentLabel}</td>
                  <td>{row.exportLabel}</td>
                  <td>{row.statusLabel}</td>
                  <td className="row-actions">
                    <button type="button" onClick={() => void openDetail(row.saleId)}>
                      View
                    </button>
                  </td>
                </tr>
              );
            })}
            {entries.length === 0 && (
              <tr>
                <td colSpan={8}>No sales found.</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}

interface SaleDetailViewProps {
  readonly detail: SaleDetail | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onBack: () => void;
  readonly onViewReceipt: () => void;
}

function SaleDetailView({ detail, loading, error, onBack, onViewReceipt }: SaleDetailViewProps) {
  return (
    <section className="sale-detail">
      <button type="button" onClick={onBack}>
        ← Back to Sales History
      </button>

      {loading && <p role="status">Loading sale…</p>}
      {error !== null && (
        <p className="product-form-error" role="alert">
          {error}
        </p>
      )}

      {!loading && error === null && detail !== null && (
        <SaleDetailBody detail={detail} onViewReceipt={onViewReceipt} />
      )}
    </section>
  );
}

function SaleDetailBody({
  detail,
  onViewReceipt,
}: {
  readonly detail: SaleDetail;
  readonly onViewReceipt: () => void;
}) {
  const view = toSaleDetailView(detail);
  return (
    <>
      <h3>
        {view.receiptNumber}
        {view.voided && <span className="sales-history-voided-badge"> · VOIDED</span>}
      </h3>

      <dl className="checkout-totals">
        <div>
          <dt>Sale ID</dt>
          <dd>
            <code>{view.saleId}</code>
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{view.statusLabel}</dd>
        </div>
        <div>
          <dt>Completed</dt>
          <dd>{view.completedAt}</dd>
        </div>
        {view.voided && (
          <>
            <div>
              <dt>Voided</dt>
              <dd>{view.voidedAt}</dd>
            </div>
            <div>
              <dt>Void reason</dt>
              <dd>{view.voidReason}</dd>
            </div>
          </>
        )}
        <div>
          <dt>Payment method</dt>
          <dd>{view.paymentLabel}</dd>
        </div>
        <div>
          <dt>Google Sheets export</dt>
          <dd>{view.exportLabel}</dd>
        </div>
        <div>
          <dt>Customer</dt>
          <dd>
            {view.customer
              ? `${view.customer.name}${view.customer.phone ? ` · ${view.customer.phone}` : ''}`
              : 'No customer'}
          </dd>
        </div>
      </dl>

      <table className="sale-detail-items">
        <thead>
          <tr>
            <th>Product</th>
            <th>Qty</th>
            <th>Listed</th>
            <th>Sold</th>
            <th>Discount</th>
            <th>Line total</th>
          </tr>
        </thead>
        <tbody>
          {view.items.map((item, index) => (
            <tr key={`${item.name}-${String(index)}`}>
              <td>
                {item.name}
                {item.detail && (
                  <>
                    <br />
                    <span className="muted">{item.detail}</span>
                  </>
                )}
              </td>
              <td>{item.quantity}</td>
              <td>{item.listed}</td>
              <td>{item.sold}</td>
              <td>{item.discount}</td>
              <td>{item.lineTotal}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="checkout-totals">
        {view.totalRows.map((row) => (
          <div key={row.label} className={row.emphasis ? 'receipt-total-emphasis' : undefined}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>

      <div className="checkout-actions">
        <button type="button" onClick={onViewReceipt}>
          View Receipt
        </button>
      </div>
    </>
  );
}
