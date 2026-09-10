import { formatCents } from '../../../../shared/money';
import type { DailyReport } from '../../../../shared/reports';
import { formatBusinessDate } from '../history/salesHistory';

/**
 * Pure, React-free shaping for the Daily Report screen (`POS_WORKFLOWS.md §53`-
 * `§55`; `PRODUCT_SCOPE.md §19`; `REQ-REPORT-001`-`REQ-REPORT-009`). The renderer
 * suites run without jsdom, so the display strings and the date-input gate are
 * unit-tested here directly.
 *
 * Nothing here recomputes money or re-derives a business day — every value comes
 * straight from the trusted {@link DailyReport} DTO. Amounts are formatted with
 * the shared `formatCents` helper so reports, receipts, and history render money
 * identically.
 */

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** One labelled money line in the report. */
export interface DailyReportMetricRow {
  readonly key: 'grossSales' | 'discounts' | 'tax' | 'finalSales' | 'cash' | 'card';
  readonly label: string;
  /** e.g. `"$1,234.56"` — always a concrete amount, never blank/NaN for an empty day. */
  readonly amount: string;
}

export interface DailyReportView {
  /** e.g. `"Sep 7, 2026"`. */
  readonly dateLabel: string;
  /** The raw `YYYY-MM-DD` (for the date input's value). */
  readonly businessDate: string;
  /** e.g. `"America/Chicago"` — shown unobtrusively for clarity. */
  readonly timezoneLabel: string;
  /** `true` when this report covers the current business day. */
  readonly isToday: boolean;
  readonly completedCountLabel: string;
  readonly voidedCountLabel: string;
  /** Always shown next to the voided count so exclusion from totals is unambiguous. */
  readonly voidedExclusionNote: string;
  /** Gross sales, Discounts, Tax collected, Final sales, Cash, Card — in that order. */
  readonly metricRows: readonly DailyReportMetricRow[];
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

export function toDailyReportView(report: DailyReport): DailyReportView {
  return {
    dateLabel: formatBusinessDate(report.businessDate),
    businessDate: report.businessDate,
    timezoneLabel: report.businessTimezone,
    isToday: report.isToday,
    completedCountLabel: plural(
      report.completedTransactionCount,
      'completed transaction',
      'completed transactions',
    ),
    voidedCountLabel: plural(
      report.voidedTransactionCount,
      'voided transaction',
      'voided transactions',
    ),
    voidedExclusionNote: 'Voided sales are excluded from every total below.',
    metricRows: [
      { key: 'grossSales', label: 'Gross sales', amount: formatCents(report.grossSalesCents) },
      { key: 'discounts', label: 'Discounts', amount: formatCents(report.discountCents) },
      { key: 'tax', label: 'Tax collected', amount: formatCents(report.taxCents) },
      { key: 'finalSales', label: 'Final sales', amount: formatCents(report.totalSalesCents) },
      { key: 'cash', label: 'Cash', amount: formatCents(report.cashTotalCents) },
      { key: 'card', label: 'Card', amount: formatCents(report.cardTotalCents) },
    ],
  };
}

/**
 * A renderer-side pre-check for the date the owner typed/picked. `''` means
 * "current business day" (valid). A non-empty value must be a real `YYYY-MM-DD`
 * calendar day. This is only UX guidance — the trusted layer re-validates every
 * request regardless.
 */
export function validateReportDateInput(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  if (!YMD.test(trimmed)) {
    return 'Enter a date as YYYY-MM-DD.';
  }
  const [y, m, d] = trimmed.split('-').map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > 31) {
    return 'Enter a real calendar date.';
  }
  const asDate = new Date(Date.UTC(y, m - 1, d));
  const real =
    asDate.getUTCFullYear() === y && asDate.getUTCMonth() === m - 1 && asDate.getUTCDate() === d;
  return real ? null : 'Enter a real calendar date.';
}
