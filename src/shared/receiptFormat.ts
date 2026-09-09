/**
 * Pure, dependency-free receipt-string formatting shared by every receipt
 * consumer (`REQ-REC-002`; `POS_WORKFLOWS.md §38`).
 *
 * Extracted from the Phase 2E.1 renderer `receiptView.ts` so the Phase 2I
 * physical-print document (assembled in the trusted main process) formats money,
 * dates, and the tax rate with the *identical* semantics as the on-screen
 * Receipt Preview — there is one source of truth, not two. `receiptView.ts`
 * re-exports these names, so existing renderer imports are unchanged.
 *
 * Nothing here recalculates money: callers pass values straight from a
 * {@link ReceiptRepresentation}. No Node, no DOM, no React.
 */

/**
 * Render an immutable ISO-8601 UTC instant (`sales.completed_at` /
 * `sales.voided_at`) as a local date/time in `timeZone`. `DATA_MODEL.md §4`
 * requires converting the stored instant for local display; Phase 2E.1 passes
 * the *currently configured* `business_timezone` by convention (see
 * `shared/receipt.ts`). Example: `"Sep 8, 2026, 12:42 PM"`.
 *
 * A malformed timezone falls back to a UTC rendering with an explicit `UTC`
 * suffix; an unparseable timestamp is returned verbatim — a receipt must still
 * show *a* date rather than throw.
 */
export function formatReceiptDateTime(isoUtcInstant: string, timeZone: string): string {
  const instant = new Date(isoUtcInstant);
  if (Number.isNaN(instant.getTime())) {
    return isoUtcInstant;
  }
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(instant);
  } catch {
    return `${new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(instant)} UTC`;
  }
}

/** `825` bps → `"8.25%"` — matches the checkout review's tax label convention. */
export function formatTaxRateBps(taxRateBps: number): string {
  return `${(taxRateBps / 100).toFixed(2)}%`;
}
