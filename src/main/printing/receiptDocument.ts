import { formatCents } from '../../shared/money';
import { formatReceiptDateTime, formatTaxRateBps } from '../../shared/receiptFormat';
import type { ReceiptItem, ReceiptRepresentation } from '../../shared/receipt';

/**
 * Turns a {@link ReceiptRepresentation} (rebuilt in the trusted process from
 * stored transaction-time snapshots) into a single self-contained HTML string
 * for physical printing (`ARCHITECTURE.md §18`; `REQ-REC-002`;
 * `POS_WORKFLOWS.md §38`; `task §7`-`§9`).
 *
 * Deterministic and fully offline — no `<script>`, no external stylesheet, no
 * font URL, no image, no remote resource of any kind (`REQ-OFF-007`,
 * `task §17`). It carries its own strict `Content-Security-Policy` so even if
 * the document were ever loaded somewhere unexpected it can fetch nothing.
 *
 * Every value that originates from user/business/customer/product text is passed
 * through {@link escapeHtml} before it enters the markup, so a product name like
 * `<img src=x onerror=alert(1)>` renders as literal text and can neither inject
 * markup nor run script (`task §7`, `§19`).
 *
 * This module never recalculates money and never reads live `products` /
 * `customers` / `settings` — it only formats what the representation already
 * holds. There is no second receipt business model (`task §3`).
 */

/** Escape the five HTML-significant characters. Applied to every dynamic string. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const DOCUMENT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

const STYLE = `
  @page { margin: 12mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: #fff;
    color: #000;
    font: 12px/1.45 "Segoe UI", Tahoma, Arial, sans-serif;
    -webkit-print-color-adjust: exact;
  }
  .receipt { width: 100%; max-width: 480px; margin: 0 auto; padding: 8px 4px; }
  .center { text-align: center; }
  .business-name { font-size: 15px; font-weight: 700; margin: 0 0 2px; }
  .business-line { margin: 0; }
  .void-banner {
    border: 2px solid #000;
    padding: 6px 8px;
    margin: 10px 0;
    text-align: center;
    font-weight: 700;
    letter-spacing: 3px;
  }
  .void-detail { margin: 2px 0; text-align: center; }
  .meta { margin: 10px 0; }
  .meta div { display: flex; justify-content: space-between; gap: 12px; }
  .section-label { font-weight: 700; margin: 10px 0 2px; }
  hr { border: 0; border-top: 1px dashed #000; margin: 10px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 2px 0; vertical-align: top; }
  .item-name { word-break: break-word; padding-right: 8px; }
  .amount { text-align: right; white-space: nowrap; }
  .item-sub { color: #000; font-size: 11px; word-break: break-word; }
  .totals td { padding: 2px 0; }
  .totals .label { }
  .totals .value { text-align: right; white-space: nowrap; }
  .grand td { font-weight: 700; font-size: 14px; border-top: 2px solid #000; padding-top: 4px; }
  .payment { margin: 10px 0 0; font-weight: 700; }
  .policy { font-size: 10px; white-space: pre-wrap; margin: 10px 0 0; }
  .footer { margin: 10px 0 0; text-align: center; }
`;

function itemDetailLine(item: ReceiptItem): string {
  const parts = [`${item.brand} ${item.model}`.trim(), item.condition];
  if (item.sku !== null && item.sku !== '') {
    parts.push(`SKU ${item.sku}`);
  }
  if (item.barcode !== null && item.barcode !== '') {
    parts.push(`Barcode ${item.barcode}`);
  }
  return parts.filter((p) => p.length > 0).join(' · ');
}

function renderItem(item: ReceiptItem): string {
  const negotiated = item.soldPriceCents !== item.listedPriceCents;
  const subLines: string[] = [
    escapeHtml(itemDetailLine(item)),
    `Qty ${String(item.quantity)} × ${formatCents(item.soldPriceCents)}`,
  ];
  if (negotiated) {
    subLines.push(`List: ${formatCents(item.listedPriceCents)}`);
  }
  if (item.discountCents > 0) {
    subLines.push(`Discount: ${formatCents(item.discountCents)}`);
  }
  return `
        <tr>
          <td class="item-name">${escapeHtml(item.productName)}</td>
          <td class="amount">${formatCents(item.lineTotalCents)}</td>
        </tr>
        <tr>
          <td class="item-sub" colspan="2">${subLines.filter((l) => l !== '').join('<br />')}</td>
        </tr>`;
}

/** Build the full printable HTML document for one receipt. */
export function renderReceiptDocument(representation: ReceiptRepresentation): string {
  const { business, customer, totals, payment } = representation;

  const businessLines = [business.address, business.phone]
    .filter((line) => line.trim() !== '')
    .map((line) => `<p class="business-line">${escapeHtml(line)}</p>`)
    .join('\n          ');

  const dateLabel = formatReceiptDateTime(
    representation.completedAt,
    representation.businessTimezone,
  );

  const voidBlock =
    representation.status === 'VOIDED'
      ? `
        <div class="void-banner">VOIDED</div>
        <p class="void-detail">This sale was voided on ${escapeHtml(
          representation.voidedAt !== null
            ? formatReceiptDateTime(representation.voidedAt, representation.businessTimezone)
            : 'an unknown date',
        )}.</p>
        <p class="void-detail">Reason: ${escapeHtml(representation.voidReason ?? '')}</p>`
      : '';

  const customerBlock = customer
    ? `
        <p class="section-label">Customer</p>
        <p class="business-line">${escapeHtml(customer.name)}</p>${
          customer.phone !== null && customer.phone.trim() !== ''
            ? `\n        <p class="business-line">${escapeHtml(customer.phone)}</p>`
            : ''
        }`
    : '';

  const itemsMarkup = representation.items.map(renderItem).join('\n');

  const disclaimer = representation.disclaimer.trim();
  const footer = representation.footer.trim();
  const policyBlock =
    disclaimer !== '' ? `\n        <p class="policy">${escapeHtml(disclaimer)}</p>` : '';
  const footerBlock = footer !== '' ? `\n        <p class="footer">${escapeHtml(footer)}</p>` : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${DOCUMENT_CSP}" />
    <title>Receipt ${escapeHtml(representation.receiptNumber)}</title>
    <style>${STYLE}</style>
  </head>
  <body>
    <div class="receipt">
      <header class="center">
        <p class="business-name">${escapeHtml(business.name)}</p>
        ${businessLines}
      </header>
${voidBlock}
      <div class="meta">
        <div><span>Receipt</span><span>${escapeHtml(representation.receiptNumber)}</span></div>
        <div><span>Date</span><span>${escapeHtml(dateLabel)}</span></div>
      </div>
${customerBlock}
      <hr />
      <table>
        <tbody>${itemsMarkup}
        </tbody>
      </table>
      <hr />
      <table class="totals">
        <tbody>
          <tr><td class="label">Subtotal</td><td class="value">${formatCents(
            totals.subtotalCents,
          )}</td></tr>
          <tr><td class="label">Discount</td><td class="value">${formatCents(
            totals.discountCents,
          )}</td></tr>
          <tr><td class="label">Tax (${formatTaxRateBps(
            totals.taxRateBps,
          )})</td><td class="value">${formatCents(totals.taxCents)}</td></tr>
          <tr class="grand"><td class="label">Total</td><td class="value">${formatCents(
            totals.totalCents,
          )}</td></tr>
        </tbody>
      </table>
      <p class="payment">Payment: ${payment.method === 'CASH' ? 'Cash' : 'Card'}</p>${policyBlock}${footerBlock}
    </div>
  </body>
</html>`;
}
