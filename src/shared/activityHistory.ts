/**
 * Friendly activity/error history (`REQ-DIAG-002`; `PRODUCT_SCOPE.md §33`;
 * `POS_WORKFLOWS.md §94` step 1).
 *
 * Every field here is plain-language and pre-sanitized by the trusted main
 * process — never raw log context, a stack trace, a filesystem path, or an
 * arbitrary diagnostic object. The renderer displays these fields directly.
 */

export const ACTIVITY_HISTORY_SEVERITIES = ['INFO', 'WARNING', 'ERROR'] as const;
export type ActivityHistorySeverity = (typeof ACTIVITY_HISTORY_SEVERITIES)[number];

export interface ActivityHistoryEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly severity: ActivityHistorySeverity;
  /** Short plain-language heading, e.g. "Receipt could not be printed." */
  readonly title: string;
  /** One or two plain-language sentences explaining what happened and, where relevant, that saved sales remain safe. */
  readonly detail: string;
  /** A stable, already-public error code — shown only where canon already treats it as safe/supportable. */
  readonly errorCode?: string | null;
  /** A safe reference such as a receipt number, where one is available and relevant. */
  readonly receiptNumber?: string | null;
}

export interface ActivityHistory {
  readonly generatedAt: string;
  readonly entries: readonly ActivityHistoryEntry[];
}
