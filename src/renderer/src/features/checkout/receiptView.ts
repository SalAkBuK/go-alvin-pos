import type { ReceiptItem, ReceiptRepresentation } from '../../../../shared/receipt';
import { formatCents } from '../../../../shared/money';
import { formatReceiptDateTime, formatTaxRateBps } from '../../../../shared/receiptFormat';

/**
 * Pure presentation helpers that turn a {@link ReceiptRepresentation} (committed
 * snapshot data from the trusted layer) into display-ready strings for the
 * receipt preview (`REQ-REC-002`; `POS_WORKFLOWS.md §38`; task `§6`-`§9`,
 * `§14`).
 *
 * React-free so the shaping is unit-testable without a DOM (repo convention: no
 * jsdom). Nothing here recalculates money — every cent value comes straight from
 * the representation; `formatCents` / percentage formatting are display-only.
 *
 * `formatReceiptDateTime` / `formatTaxRateBps` now live in
 * `shared/receiptFormat.ts` (so the Phase 2I print document reuses the exact
 * same semantics); they are re-exported here for existing callers.
 */

export { formatReceiptDateTime, formatTaxRateBps };

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

/**
 * A `VOIDED` sale's void treatment, or `null` for a normal `COMPLETED` sale. The
 * on-screen preview and the physical print document both render this so a voided
 * receipt never hides that it is voided (`REQ-HIST-001`; task `§8`).
 */
export interface ReceiptVoidView {
  readonly bannerLabel: string;
  readonly voidedAt: string;
  readonly reason: string;
}

export interface ReceiptView {
  readonly title: string;
  readonly businessLines: readonly string[];
  readonly meta: readonly { readonly label: string; readonly value: string }[];
  readonly customer: { readonly name: string; readonly phone: string | null } | null;
  readonly items: readonly ReceiptViewItem[];
  readonly totalRows: readonly ReceiptViewTotalRow[];
  readonly paymentLabel: string;
  /** Non-null only when the sale is `VOIDED`. */
  readonly voided: ReceiptVoidView | null;
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
    voided:
      representation.status === 'VOIDED'
        ? {
            bannerLabel: 'VOIDED',
            voidedAt:
              representation.voidedAt !== null
                ? formatReceiptDateTime(representation.voidedAt, representation.businessTimezone)
                : 'Unknown',
            reason: representation.voidReason ?? '',
          }
        : null,
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
