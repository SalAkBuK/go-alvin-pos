import type Database from 'better-sqlite3';
import type { DailyReport } from '../../shared/reports';
import { readBusinessTimezone } from '../settings/settingsRepository';
import { deriveBusinessDate } from '../salesHistory/businessDate';
import { listSalesForDailyReport } from './dailyReportRepository';
import { validateDailyReportInput } from './dailyReportValidation';

/**
 * The Daily Report read model (`PRODUCT_SCOPE.md §19`; `REQ-REPORT-001`-
 * `REQ-REPORT-009`; `POS_WORKFLOWS.md §53`-`§55`; `ARCHITECTURE.md §36`;
 * `DATA_MODEL.md §4`; `TEST-REPORT-001`-`007`, `TEST-OFF-011`, `TEST-VOID-004`).
 *
 * Pure read, recomputed live. It:
 *
 *  - loads committed `sales` snapshot rows only — never current `products`,
 *    `customers`, tax/business settings, or `google_sheet_export_jobs`; report
 *    totals are transaction-time truth, not a recalculation, and the Google
 *    export state (`PENDING`/`EXPORTING`/`EXPORTED`/`FAILED`) has zero effect
 *    (`REQ-REPORT-007`, `POS_WORKFLOWS.md §56`);
 *  - derives each sale's *business date* from the immutable `completed_at` plus
 *    the *currently configured* `business_timezone`, reusing the exact Sales
 *    History helper (`salesHistory/businessDate.ts`, `TEST-HIST-006`) so the two
 *    features never disagree about which day a sale belongs to
 *    (`REQ-REPORT-008`, `DATA_MODEL.md §4`);
 *  - excludes every `VOIDED` sale from all revenue / count metrics and exposes
 *    them as a separate `voidedTransactionCount` for the same *original*
 *    business date, so a late void retroactively corrects that day with no
 *    revenue-adjustment line on the void date (`REQ-REPORT-009`);
 *  - aggregates entirely in integer cents;
 *  - writes nothing and emits no audit event — viewing a report is not an
 *    authoritative business event;
 *  - needs no network: all data is local SQLite (`REQ-REPORT-007`,
 *    `TEST-OFF-011`).
 *
 * "Current business day" is resolved here from the injected clock plus the
 * configured timezone — never the renderer / OS / browser local date.
 */

export interface DailyReportServiceDeps {
  readonly db: Database.Database;
  /** ISO-8601 UTC clock; injectable for deterministic tests. */
  readonly now?: () => string;
}

export interface DailyReportService {
  daily(rawInput: unknown): DailyReport;
}

export function createDailyReportService(deps: DailyReportServiceDeps): DailyReportService {
  const { db } = deps;
  const now = deps.now ?? ((): string => new Date().toISOString());

  return {
    daily(rawInput: unknown): DailyReport {
      const { businessDate: requested } = validateDailyReportInput(rawInput);

      // The timezone configured *now* governs both "today" and historical
      // bucketing — changing it re-buckets past sales on the next view
      // (`DATA_MODEL.md §4` "Timezone-change behavior").
      const businessTimezone = readBusinessTimezone(db);
      const currentBusinessDate = deriveBusinessDate(now(), businessTimezone);
      const businessDate = requested ?? currentBusinessDate;
      const isToday = businessDate === currentBusinessDate;

      let completedTransactionCount = 0;
      let voidedTransactionCount = 0;
      let grossSalesCents = 0;
      let discountCents = 0;
      let taxCents = 0;
      let totalSalesCents = 0;
      let cashTotalCents = 0;
      let cardTotalCents = 0;

      for (const row of listSalesForDailyReport(db)) {
        // Attribution is always by the immutable completion instant, never
        // `created_at` and never `voided_at` (`DATA_MODEL.md §4`).
        if (deriveBusinessDate(row.completed_at, businessTimezone) !== businessDate) {
          continue;
        }
        if (row.status === 'VOIDED') {
          // Visible, but contributes zero to every revenue / count metric.
          voidedTransactionCount += 1;
          continue;
        }
        // status === 'COMPLETED'
        completedTransactionCount += 1;
        grossSalesCents += row.subtotal_cents;
        discountCents += row.discount_cents;
        taxCents += row.tax_cents;
        totalSalesCents += row.total_cents;
        if (row.payment_method_snapshot === 'CASH') {
          cashTotalCents += row.total_cents;
        } else if (row.payment_method_snapshot === 'CARD') {
          cardTotalCents += row.total_cents;
        }
      }

      return {
        businessDate,
        businessTimezone,
        isToday,
        completedTransactionCount,
        voidedTransactionCount,
        grossSalesCents,
        discountCents,
        taxCents,
        totalSalesCents,
        cashTotalCents,
        cardTotalCents,
      };
    },
  };
}
