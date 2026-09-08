import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/src/App';
import { BrandLogo } from '../../src/renderer/src/components/BrandLogo';
import { ReceiptPreview } from '../../src/renderer/src/features/checkout/ReceiptPreview';
import { GO_PHONES_LOGO_URL } from '../../src/renderer/src/assets/logo';
import type { ReceiptRepresentation } from '../../src/shared/receipt';

/**
 * Phase 2E.2 — store branding / logo (task `§2`, `§6`-`§8`). No jsdom: static
 * markup only. The logo is a bundled static asset; these tests assert it is
 * referenced and that receipt data rendering does not depend on it.
 */

const noop = () => {};

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
      address: '1710 S Gordon St, Alvin, TX 77511',
      phone: '281-824-0001',
    },
    customer: null,
    items: [
      {
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
      },
    ],
    totals: {
      subtotalCents: 59900,
      discountCents: 0,
      taxableAmountCents: 59900,
      taxRateBps: 825,
      taxCents: 4942,
      totalCents: 64842,
    },
    payment: { method: 'CASH', amountCents: 64842 },
    disclaimer: 'All sales final.',
    footer: 'Thank you!',
    ...overrides,
  };
}

describe('the logo asset', () => {
  it('resolves to a bundled jpeg URL', () => {
    expect(typeof GO_PHONES_LOGO_URL).toBe('string');
    expect(GO_PHONES_LOGO_URL).toMatch(/go-alvin-logo.*\.jpe?g$/i);
  });
});

describe('BrandLogo', () => {
  it('names the business when not decorative', () => {
    const html = renderToStaticMarkup(<BrandLogo className="x" />);
    expect(html).toContain(`src="${GO_PHONES_LOGO_URL}"`);
    expect(html).toContain('alt="Go Phones - Alvin"');
    expect(html).toContain('class="x"');
  });

  it('is silent to screen readers when decorative', () => {
    const html = renderToStaticMarkup(<BrandLogo className="y" decorative />);
    expect(html).toContain('alt=""');
    expect(html).not.toContain('Go Phones - Alvin');
  });
});

describe('application shell', () => {
  const html = renderToStaticMarkup(<App />);

  it('shows the store logo in the header', () => {
    expect(html).toContain(`src="${GO_PHONES_LOGO_URL}"`);
    expect(html).toContain('class="app-logo"');
    expect(html).toContain('alt="Go Phones - Alvin"');
  });

  it('still shows the app title and navigation', () => {
    expect(html).toContain('Go Phones POS');
    expect(html).toContain('Products &amp; Inventory');
    expect(html).toContain('Customers');
    expect(html).toContain('Settings');
  });
});

describe('receipt preview', () => {
  const html = renderToStaticMarkup(
    <ReceiptPreview
      representation={representation()}
      loading={false}
      error={null}
      saleReceiptNumber="GP-000123"
      onBack={noop}
      onNewSale={noop}
    />,
  );

  it('shows the logo centered at the top, before the business name', () => {
    expect(html).toContain(`src="${GO_PHONES_LOGO_URL}"`);
    expect(html).toContain('class="receipt-logo"');
    const logoAt = html.indexOf('receipt-logo');
    const nameAt = html.indexOf('Go Phones - Alvin');
    expect(logoAt).toBeGreaterThanOrEqual(0);
    expect(logoAt).toBeLessThan(nameAt);
  });

  it('renders the logo decoratively (business name is the accessible header)', () => {
    // The receipt <img> carries alt="" — the <h3> business name is the a11y header.
    expect(html).toMatch(/class="receipt-logo"[^>]*alt=""/);
  });

  it('renders every business-snapshot value regardless of the logo', () => {
    expect(html).toContain('Go Phones - Alvin');
    expect(html).toContain('1710 S Gordon St, Alvin, TX 77511');
    expect(html).toContain('281-824-0001');
    expect(html).toContain('GP-000123');
    expect(html).toContain('$648.42');
    expect(html).toContain('Payment: Cash');
  });

  it('does not send business identity from anywhere but the representation snapshot', () => {
    const custom = renderToStaticMarkup(
      <ReceiptPreview
        representation={representation({
          business: { name: 'Different Store', address: 'Elsewhere Rd', phone: '000-0000' },
        })}
        loading={false}
        error={null}
        saleReceiptNumber="GP-000999"
        onBack={noop}
        onNewSale={noop}
      />,
    );
    expect(custom).toContain('Different Store');
    expect(custom).toContain('Elsewhere Rd');
    expect(custom).not.toContain('Go Phones - Alvin');
  });
});
