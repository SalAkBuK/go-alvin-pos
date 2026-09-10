import { useCallback, useEffect, useState } from 'react';
import type { IpcResult } from '../../../../shared/products';
import type { DailyReport } from '../../../../shared/reports';
import { toDailyReportView, validateReportDateInput } from './dailyReport';

/**
 * Reports → Daily (Phase 2K `REQ-REPORT-001`-`REQ-REPORT-009`; `POS_WORKFLOWS.md
 * §53`-`§55`; `PRODUCT_SCOPE.md §19`; `ARCHITECTURE.md §36`).
 *
 * A single read-only screen: it opens on the current business day, lets the
 * owner/cashier pick another calendar date, and shows the totals recomputed
 * from local SQLite for that day — completed transaction count, voided count
 * (separately, clearly excluded from revenue), gross sales, discounts, tax,
 * final sales, and the Cash / Card split. All access is through
 * `window.pos.reports.daily`; the renderer never sees SQL, a DB handle, or a
 * raw row, computes no business day itself, and makes no network request. This
 * is not the dedicated UI/UX refinement pass — functional and uncluttered.
 */

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

export function DailyReportPage() {
  const [report, setReport] = useState<DailyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** The date currently selected in the picker; `''` = the current business day. */
  const [selectedDate, setSelectedDate] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);

  const load = useCallback(async (businessDate: string | null): Promise<void> => {
    const api = pos();
    if (!api) {
      setLoading(false);
      setError('The report is unavailable right now.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await unwrap(api.reports.daily(businessDate === null ? {} : { businessDate }));
      setReport(next);
      // Keep the picker in sync with the day actually shown.
      setSelectedDate(next.isToday ? '' : next.businessDate);
    } catch (err) {
      setReport(null);
      setError(err instanceof Error ? err.message : 'The report could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  const onDateChange = (value: string): void => {
    setSelectedDate(value);
    const message = validateReportDateInput(value);
    setInputError(message);
    if (message === null) {
      void load(value.trim() === '' ? null : value.trim());
    }
  };

  const view = report ? toDailyReportView(report) : null;

  return (
    <section className="daily-report" aria-label="Daily report">
      <h3>Daily Report</h3>

      <div className="daily-report-controls">
        <label>
          Business date
          <input
            type="date"
            value={selectedDate}
            onChange={(event) => onDateChange(event.target.value)}
          />
        </label>
        {view && !view.isToday && (
          <button type="button" onClick={() => void load(null)}>
            Today
          </button>
        )}
      </div>
      {inputError && <p role="alert">{inputError}</p>}

      {loading && <p>Loading the daily report…</p>}
      {!loading && error && <p role="alert">{error}</p>}

      {!loading && !error && view && (
        <div className="daily-report-body">
          <p className="daily-report-heading">
            {view.isToday ? 'Today' : view.dateLabel}
            {' · '}
            <span className="daily-report-timezone">{view.timezoneLabel}</span>
          </p>

          <dl className="daily-report-counts">
            <div>
              <dt>Completed transactions</dt>
              <dd>{String(report!.completedTransactionCount)}</dd>
            </div>
            <div>
              <dt>Voided transactions</dt>
              <dd>{String(report!.voidedTransactionCount)}</dd>
            </div>
          </dl>
          <p className="daily-report-void-note">{view.voidedExclusionNote}</p>

          <dl className="daily-report-metrics">
            {view.metricRows.map((row) => (
              <div key={row.key}>
                <dt>{row.label}</dt>
                <dd>{row.amount}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </section>
  );
}
