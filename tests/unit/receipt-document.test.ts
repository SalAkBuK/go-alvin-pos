import { describe, expect, it } from 'vitest';
import { escapeHtml, renderReceiptDocument } from '../../src/main/printing/receiptDocument';
import type { ReceiptItem, ReceiptRepresentation } from '../../src/shared/receipt';

/**
 * Phase 2I — the controlled printable receipt document (`task §7`-`§9`, `§19`).
 * Pure string output; no Electron, no DOM.
 */

function item(overrides: Partial<ReceiptItem> = {}): ReceiptItem {
  return {
    productName: 'iPhone 15',
    brand: 'Apple',
    model: 'iPhone 15',
    condition: 'NEW',
    sku: null,
    barcode: null,
    quantity: 1,
    listedPriceCents: 59900,
    soldPriceCents: 59900,
    discountCents: 0,
    lineSubtotalCents: 59900,
    lineTotalCents: 59900,
    ...overrides,
  };
}

function representation(overrides: Partial<ReceiptRepresentation> = {}): ReceiptRepresentation {
  return {
    saleId: 's1',
    receiptNumber: 'GP-000123',
    status: 'COMPLETED',
    completedAt: '2026-09-08T17:42:00.000Z',
    voidedAt: null,
    voidReason: null,
    businessTimezone: 'America/Chicago',
    business: {
      name: 'Go Phones - Alvin',
      address: '123 Main St, Alvin, TX 77511',
      phone: '(281) 555-0100',
    },
    customer: { name: 'Sam Buyer', phone: '(555) 123-4567' },
    items: [item()],
    totals: {
      subtotalCents: 59900,
      discountCents: 4900,
      taxableAmountCents: 55000,
      taxRateBps: 825,
      taxCents: 4538,
      totalCents: 59538,
    },
    payment: { method: 'CASH', amountCents: 59538 },
    disclaimer: 'All sales final.',
    footer: 'Thank you!',
    ...overrides,
  };
}

describe('escapeHtml', () => {
  it('neutralizes every HTML-significant character', () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">& more`)).toBe(
      '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp; more',
    );
  });
});

describe('renderReceiptDocument — structure & offline safety', () => {
  const html = renderReceiptDocument(representation());

  it('is a self-contained document with a strict CSP and no remote resources', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain("default-src 'none'");
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain('<link');
    expect(html).not.toContain('<img');
  });

  it('carries every REQ-REC-002 field', () => {
    for (const fragment of [
      'Go Phones - Alvin',
      '123 Main St, Alvin, TX 77511',
      '(281) 555-0100',
      'GP-000123',
      'Sep 8, 2026, 12:42 PM',
      'Sam Buyer',
      '(555) 123-4567',
      'iPhone 15',
      'Subtotal',
      'Tax (8.25%)',
      'Total',
      'Payment: Cash',
      'All sales final.',
      'Thank you!',
    ]) {
      expect(html).toContain(fragment);
    }
  });

  it('omits the customer block when there is no customer', () => {
    expect(renderReceiptDocument(representation({ customer: null }))).not.toContain('Customer');
  });

  it('keeps a configured-blank disclaimer / footer blank — no substitute text', () => {
    const blank = renderReceiptDocument(representation({ disclaimer: '', footer: '' }));
    expect(blank).not.toContain('class="policy"');
    expect(blank).not.toContain('class="footer"');
  });
});

describe('renderReceiptDocument — user-controlled strings cannot inject markup', () => {
  it('escapes product, customer, business and policy text', () => {
    const html = renderReceiptDocument(
      representation({
        business: {
          name: '<b>Store</b>',
          address: '<script>alert(1)</script>',
          phone: '"><img src=x onerror=alert(1)>',
        },
        customer: { name: '<i>Mallory</i>', phone: "' OR 1=1--" },
        items: [
          item({ productName: '<img src=x onerror=alert(1)>', brand: '<Apple>', model: '15' }),
        ],
        disclaimer: '<style>@import url(evil)</style>',
        footer: '</div><script>steal()</script>',
      }),
    );
    // No unescaped injected tags survive.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<style>@import url(evil)</style>');
    expect(html).not.toContain('<script>steal()</script>');
    // The literal text is present, escaped.
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // The only <script>/<style> in the doc is our own inline <style> block.
    expect(html.match(/<script/g)).toBeNull();
    expect(html.match(/<style/g)).toHaveLength(1);
  });
});

describe('renderReceiptDocument — VOIDED sale', () => {
  it('shows a clear VOIDED banner with the void date and reason (task §8)', () => {
    const html = renderReceiptDocument(
      representation({
        status: 'VOIDED',
        voidedAt: '2026-09-10T14:00:00.000Z',
        voidReason: 'Rang up in error',
      }),
    );
    expect(html).toContain('VOIDED');
    expect(html).toContain('Rang up in error');
    expect(html).toContain('Sep 10, 2026');
  });

  it('escapes a hostile void reason', () => {
    const html = renderReceiptDocument(
      representation({
        status: 'VOIDED',
        voidedAt: '2026-09-10T14:00:00.000Z',
        voidReason: '<script>alert(1)</script>',
      }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
