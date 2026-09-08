import type { ReceiptItem, ReceiptRepresentation } from '../../../../shared/receipt';
import { formatCents } from '../../../../shared/money';

/**
 * Pure presentation helpers that turn a {@link ReceiptRepresentation} (committed
 * snapshot data from the trusted layer) into display-ready strings for the
 * receipt preview (`REQ-REC-002`; `POS_WORKFLOWS.md §38`; task `§6`-`§9`,
 * `§14`).
 *
 * React-free so the shaping is unit-testable without a DOM (repo convention: no
 * jsdom). Nothing here recalculates money — every cent value comes straight from
 * the representation; `formatCents` / percentage formatting are display-only.
 */

/**
 * Render `completedAt` (immutable ISO-8601 UTC — `sales.completed_at`) as a
 * local date/time in `timeZone`. `DATA_MODEL.md §4` requires converting
 * `completed_at` for local display; it does not specify current-vs-snapshotted
 * zone for a receipt (that rule is defined only for reporting), so Phase 2E.1
 * passes the *currently configured* `business_timezone` here by convention.
 * Example: `"Sep 8, 2026, 12:00 PM"`.
 *
 * A malformed timezone or timestamp falls back to a UTC rendering with an
 * explicit `UTC` suffix rather than throwing — a receipt must still show *a*
 * date.
 */
export function formatReceiptDateTime(completedAtIsoUtc: string, timeZone: string): string {
  const instant = new Date(completedAtIsoUtc);
  if (Number.isNaN(instant.getTime())) {
    return completedAtIsoUtc;
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

export interface ReceiptViewItem {
  readonly name: string;
  readonly detail: string;
  readonly line: string;
  readonly amount: string;
  /** Present only when the sale price differed from the listed price (either direction). */
  readonly listNote: string | null;
  /** Present only when a positive discount applies to the line. */
  readonly discountNote: string | null;
}

export interface ReceiptViewTotalRow {
  readonly label: string;
  readonly value: string;
  readonly emphasis?: boolean;
}

export interface ReceiptView {
  readonly title: string;
  readonly businessLines: readonly string[];
  readonly meta: readonly { readonly label: string; readonly value: string }[];
  readonly customer: { readonly name: string; readonly phone: string | null } | null;
  readonly items: readonly ReceiptViewItem[];
  readonly totalRows: readonly ReceiptViewTotalRow[];
  readonly paymentLabel: string;
  /** `''` when the sale's disclaimer snapshot is a configured blank — never a substitute. */
  readonly disclaimer: string;
  /** `''` when the sale's footer snapshot is a configured blank — never a substitute. */
  readonly footer: string;
}

function itemDetail(item: ReceiptItem): string {
  const parts = [`${item.brand} ${item.model}`.trim(), item.condition];
  if (item.sku) {
    parts.push(`SKU ${item.sku}`);
  }
  if (item.barcode) {
    parts.push(`Barcode ${item.barcode}`);
  }
  return parts.filter((p) => p.length > 0).join(' · ');
}

function toViewItem(item: ReceiptItem): ReceiptViewItem {
  const negotiated = item.soldPriceCents !== item.listedPriceCents;
  return {
    name: item.productName,
    detail: itemDetail(item),
    line: `Qty ${String(item.quantity)} × ${formatCents(item.soldPriceCents)}`,
    amount: formatCents(item.lineTotalCents),
    listNote: negotiated ? `List: ${formatCents(item.listedPriceCents)}` : null,
    discountNote: item.discountCents > 0 ? `Discount: ${formatCents(item.discountCents)}` : null,
  };
}

/** Shape every REQ-REC-002 field into display strings. Adds nothing not in the representation. */
export function toReceiptView(representation: ReceiptRepresentation): ReceiptView {
  const { business, totals, customer } = representation;
  return {
    title: business.name,
    businessLines: [business.address, business.phone],
    meta: [
      { label: 'Receipt', value: representation.receiptNumber },
      {
        label: 'Date',
        value: formatReceiptDateTime(representation.completedAt, representation.businessTimezone),
      },
    ],
    customer: customer ? { name: customer.name, phone: customer.phone } : null,
    items: representation.items.map(toViewItem),
    totalRows: [
      { label: 'Subtotal', value: formatCents(totals.subtotalCents) },
      { label: 'Discount', value: formatCents(totals.discountCents) },
      {
        label: `Tax (${formatTaxRateBps(totals.taxRateBps)})`,
        value: formatCents(totals.taxCents),
      },
      { label: 'Total', value: formatCents(totals.totalCents), emphasis: true },
    ],
    paymentLabel: representation.payment.method === 'CASH' ? 'Cash' : 'Card',
    disclaimer: representation.disclaimer,
    footer: representation.footer,
  };
}
