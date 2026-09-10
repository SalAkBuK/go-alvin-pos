import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DailyReportPage } from '../../src/renderer/src/features/reports/DailyReportPage';
import {
  toDailyReportView,
  validateReportDateInput,
} from '../../src/renderer/src/features/reports/dailyReport';
import { formatBusinessDate } from '../../src/renderer/src/features/history/salesHistory';
import type { DailyReport } from '../../src/shared/reports';

/**
 * Phase 2K renderer coverage — the Daily Report shaping + the date-input gate,
 * and the page's first-render (loading) markup. No jsdom in the renderer suites,
 * so the display strings are unit-tested here directly.
 */

const base: DailyReport = {
  businessDate: '2026-09-07',
  businessTimezone: 'America/Chicago',
  isToday: false,
  completedTransactionCount: 3,
  voidedTransactionCount: 1,
  grossSalesCents: 300_000,
  discountCents: 2_500,
  taxCents: 24_750,
  totalSalesCents: 321_250,
  cashTotalCents: 121_250,
  cardTotalCents: 200_000,
};

describe('toDailyReportView', () => {
  it('formats counts, timezone, and every money row in canonical order', () => {
    const v = toDailyReportView(base);
    expect(v.dateLabel).toBe('Sep 7, 2026');
    expect(v.businessDate).toBe('2026-09-07');
    expect(v.timezoneLabel).toBe('America/Chicago');
    expect(v.isToday).toBe(false);
    expect(v.completedCountLabel).toBe('3 completed transactions');
    expect(v.voidedCountLabel).toBe('1 voided transaction');
    expect(v.voidedExclusionNote).toMatch(/excluded from every total/i);
    expect(v.metricRows.map((r) => [r.key, r.label, r.amount])).toEqual([
      ['grossSales', 'Gross sales', '$3,000.00'],
      ['discounts', 'Discounts', '$25.00'],
      ['tax', 'Tax collected', '$247.50'],
      ['finalSales', 'Final sales', '$3,212.50'],
      ['cash', 'Cash', '$1,212.50'],
      ['card', 'Card', '$2,000.00'],
    ]);
  });

  it('an empty day renders concrete $0.00 values and pluralized zero counts', () => {
    const v = toDailyReportView({
      ...base,
      completedTransactionCount: 0,
      voidedTransactionCount: 0,
      grossSalesCents: 0,
      discountCents: 0,
      taxCents: 0,
      totalSalesCents: 0,
      cashTotalCents: 0,
      cardTotalCents: 0,
    });
    expect(v.completedCountLabel).toBe('0 completed transactions');
    expect(v.voidedCountLabel).toBe('0 voided transactions');
    for (const row of v.metricRows) {
      expect(row.amount).toBe('$0.00');
    }
  });

  it('marks the current business day', () => {
    expect(toDailyReportView({ ...base, isToday: true }).isToday).toBe(true);
  });
});

describe('validateReportDateInput', () => {
  it('accepts an empty value (current business day) and a real date', () => {
    expect(validateReportDateInput('')).toBeNull();
    expect(validateReportDateInput('  ')).toBeNull();
    expect(validateReportDateInput('2026-09-07')).toBeNull();
    expect(validateReportDateInput('2028-02-29')).toBeNull();
  });

  it('rejects malformed and impossible dates', () => {
    expect(validateReportDateInput('nope')).toMatch(/YYYY-MM-DD/);
    expect(validateReportDateInput('2026/09/07')).toMatch(/YYYY-MM-DD/);
    expect(validateReportDateInput('2026-02-30')).toMatch(/real calendar date/i);
    expect(validateReportDateInput('2027-02-29')).toMatch(/real calendar date/i);
    expect(validateReportDateInput('2026-13-01')).toMatch(/real calendar date/i);
  });
});

describe('business-date display is a calendar date, not a machine-timezone instant', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // `formatBusinessDate` parses with an explicit `T00:00:00.000Z` and formats
  // with `timeZone: 'UTC'`, so the displayed day never shifts with the OS /
  // runtime timezone. Node re-reads `process.env.TZ` per `Date` / `Intl`, so
  // stubbing it exercises the real risk.
  it.each([
    ['Pacific/Honolulu', 'far west of UTC (UTC-10)'],
    ['America/Anchorage', 'west of UTC (UTC-9/-8)'],
    ['America/Chicago', 'the configured store zone'],
    ['UTC', 'UTC'],
    ['Pacific/Kiritimati', 'far east of UTC (UTC+14)'],
  ])('stays "Sep 7, 2026" when the machine timezone is %s (%s)', (tz) => {
    vi.stubEnv('TZ', tz);
    expect(formatBusinessDate('2026-09-07')).toBe('Sep 7, 2026');
    expect(toDailyReportView({ ...base, businessDate: '2026-09-07' }).dateLabel).toBe(
      'Sep 7, 2026',
    );
    // A day that would roll backward under a naive local parse in a western zone.
    expect(formatBusinessDate('2026-01-01')).toBe('Jan 1, 2026');
    // ...and forward under an eastern zone.
    expect(formatBusinessDate('2026-12-31')).toBe('Dec 31, 2026');
  });
});

describe('<DailyReportPage /> first render', () => {
  it('renders the heading, a date control, and a loading state without a window.pos', () => {
    const html = renderToStaticMarkup(<DailyReportPage />);
    expect(html).toContain('Daily Report');
    expect(html).toContain('Business date');
    expect(html).toContain('type="date"');
    expect(html).toContain('Loading the daily report');
    // No fabricated numbers before data arrives.
    expect(html).not.toContain('$0.00');
    expect(html).not.toContain('NaN');
  });
});
