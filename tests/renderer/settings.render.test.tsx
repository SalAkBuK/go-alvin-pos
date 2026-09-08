import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/src/App';
import {
  SettingsPage,
  describeCurrent,
} from '../../src/renderer/src/features/settings/SettingsPage';
import {
  BusinessConfigSection,
  describeBusinessStatus,
} from '../../src/renderer/src/features/settings/BusinessConfigSection';
import {
  RECEIPT_DISCLAIMER_MAX_LENGTH,
  describeMissing,
  fieldsFromConfig,
  validateBusinessField,
  validateBusinessForm,
} from '../../src/renderer/src/features/settings/businessConfig';
import type { BusinessFormFields } from '../../src/renderer/src/features/settings/businessConfig';
import type { BusinessConfig } from '../../src/shared/settings';
import {
  formatBpsAsPercent,
  parsePercentToBps,
  PercentParseError,
  validateTaxRatePercent,
} from '../../src/renderer/src/features/settings/taxRate';

function businessFields(overrides: Partial<BusinessFormFields> = {}): BusinessFormFields {
  return {
    businessAddress: '123 Main St',
    businessPhone: '555-0100',
    receiptDisclaimer: '',
    receiptFooter: '',
    ...overrides,
  };
}

/**
 * Settings → Tax Rate renderer coverage (task `§12`, `§17`).
 *
 * No jsdom in this suite (repo convention). The percent<->bps module is the
 * exact gate `SettingsPage.onSubmit` runs before it ever calls
 * `window.pos.settings.tax.update`, so exercising it exercises that path;
 * `describeCurrent` is the "Current:" line; static markup covers first-render
 * accessibility.
 */

describe('percent <-> basis-point conversion (deterministic, no float drift)', () => {
  it.each([
    ['8.25', 825],
    ['8', 800],
    ['8.2', 820],
    ['0', 0],
    ['0.00', 0],
    ['7.5', 750],
    ['10', 1000],
    ['100', 10000],
    ['  6.00  ', 600],
  ])('parses %j -> %d bps', (input, bps) => {
    expect(parsePercentToBps(input)).toBe(bps);
  });

  it.each([
    '',
    '   ',
    '-1',
    '-0.5',
    '8.253',
    '8.2.5',
    '8%',
    '$8',
    'abc',
    '8e2',
    'NaN',
    'Infinity',
    '.5',
    '8.',
  ])('rejects %j', (input) => {
    expect(() => parsePercentToBps(input)).toThrow(PercentParseError);
  });

  it('formats bps back to a two-decimal percentage', () => {
    expect(formatBpsAsPercent(825)).toBe('8.25%');
    expect(formatBpsAsPercent(800)).toBe('8.00%');
    expect(formatBpsAsPercent(0)).toBe('0.00%');
    expect(formatBpsAsPercent(10000)).toBe('100.00%');
  });
});

describe('validateTaxRatePercent — field-level gate', () => {
  it('accepts a well-formed rate within the canonical bound', () => {
    expect(validateTaxRatePercent('8.25')).toBeNull();
    expect(validateTaxRatePercent('0')).toBeNull();
    expect(validateTaxRatePercent('100')).toBeNull();
    expect(validateTaxRatePercent('1000')).toBeNull(); // 100000 bps — the ceiling
  });

  it('returns an actionable message for each malformed / out-of-range case', () => {
    expect(validateTaxRatePercent('')).toMatch(/enter a tax rate/i);
    expect(validateTaxRatePercent('-1')).toMatch(/negative/i);
    expect(validateTaxRatePercent('8.253')).toMatch(/two decimal places/i);
    expect(validateTaxRatePercent('abc')).toMatch(/percentage/i);
    expect(validateTaxRatePercent('1001')).toMatch(/maximum/i); // 100100 bps — above the ceiling
  });

  it('a corrected value clears the error (null after a prior message)', () => {
    expect(validateTaxRatePercent('abc')).not.toBeNull();
    expect(validateTaxRatePercent('8.25')).toBeNull();
  });
});

describe('describeCurrent — the "Current:" line', () => {
  it('shows Loading before the rate is fetched', () => {
    expect(describeCurrent(null)).toBe('Loading…');
  });
  it('shows "Not configured" when no rate is set', () => {
    expect(describeCurrent({ configured: false })).toBe('Not configured');
  });
  it('shows the configured rate as a percentage', () => {
    expect(describeCurrent({ configured: true, taxRateBps: 825, updatedAt: 'x' })).toBe('8.25%');
    expect(describeCurrent({ configured: true, taxRateBps: 600, updatedAt: 'x' })).toBe('6.00%');
  });
});

describe('business field validation — the gate before window.pos.settings.business.update', () => {
  it('accepts a complete set of fields', () => {
    expect(validateBusinessForm(businessFields()).payload).toEqual({
      businessAddress: '123 Main St',
      businessPhone: '555-0100',
      receiptDisclaimer: '',
      receiptFooter: '',
    });
  });

  it('requires address and phone, allows blank disclaimer/footer', () => {
    expect(
      validateBusinessField('businessAddress', businessFields({ businessAddress: '  ' })),
    ).toMatch(/store address/i);
    expect(validateBusinessField('businessPhone', businessFields({ businessPhone: '' }))).toMatch(
      /phone number/i,
    );
    expect(
      validateBusinessField('businessPhone', businessFields({ businessPhone: 'call us' })),
    ).toMatch(/at least one digit/i);
    expect(
      validateBusinessField('receiptDisclaimer', businessFields({ receiptDisclaimer: '' })),
    ).toBeNull();
    expect(
      validateBusinessField('receiptFooter', businessFields({ receiptFooter: '' })),
    ).toBeNull();
  });

  it('flags an over-long disclaimer and clears once corrected', () => {
    const tooLong = businessFields({
      receiptDisclaimer: 'x'.repeat(RECEIPT_DISCLAIMER_MAX_LENGTH + 1),
    });
    expect(validateBusinessField('receiptDisclaimer', tooLong)).toMatch(/characters or fewer/i);
    expect(
      validateBusinessField('receiptDisclaimer', businessFields({ receiptDisclaimer: 'ok' })),
    ).toBeNull();
  });

  it('validateBusinessForm returns no payload when a required field is blank', () => {
    const result = validateBusinessForm(businessFields({ businessAddress: '' }));
    expect(result.payload).toBeNull();
    expect(result.errors.businessAddress).toBeTruthy();
  });
});

describe('describeBusinessStatus / describeMissing', () => {
  const incomplete: BusinessConfig = {
    configured: false,
    businessName: 'Go Phones - Alvin',
    businessAddress: null,
    businessPhone: null,
    receiptDisclaimer: null,
    receiptFooter: null,
    missing: ['businessAddress', 'businessPhone'],
  };
  const ready: BusinessConfig = {
    configured: true,
    businessName: 'Go Phones - Alvin',
    businessAddress: '123 Main St',
    businessPhone: '555-0100',
    receiptDisclaimer: '',
    receiptFooter: '',
    updatedAt: 'x',
  };

  it('status line reflects configured state', () => {
    expect(describeBusinessStatus(null)).toBe('Loading…');
    expect(describeBusinessStatus(incomplete)).toBe('Incomplete');
    expect(describeBusinessStatus(ready)).toBe('Configured');
  });

  it('describeMissing names the outstanding required fields, or null when ready', () => {
    expect(describeMissing(incomplete)).toMatch(/store address and store phone number/i);
    expect(describeMissing(ready)).toBeNull();
  });

  it('fieldsFromConfig prefills blanks for unset values', () => {
    expect(fieldsFromConfig(incomplete)).toEqual({
      businessAddress: '',
      businessPhone: '',
      receiptDisclaimer: '',
      receiptFooter: '',
    });
  });
});

describe('renders on the shell', () => {
  it('App shows a Settings nav entry', () => {
    expect(renderToStaticMarkup(<App />)).toContain('Settings');
  });

  it('SettingsPage first render: tax + business sections, no noisy error / aria-invalid', () => {
    const html = renderToStaticMarkup(<SettingsPage />);
    expect(html).toContain('Tax Rate');
    expect(html).toContain('Sales-tax rate (%)');
    expect(html).toContain('8.25'); // placeholder / hint example
    expect(html).toContain('Business &amp; Receipt');
    expect(html).toContain('Business address');
    expect(html).toContain('Business phone');
    expect(html).toContain('Receipt disclaimer (optional)');
    expect(html).toContain('Receipt footer / thank-you message (optional)');
    expect(html).not.toContain('aria-invalid');
    expect(html).not.toContain('field-error');
  });

  it('BusinessConfigSection first render shows the fixed business name and no noisy errors', () => {
    const html = renderToStaticMarkup(<BusinessConfigSection />);
    expect(html).toContain('Business name');
    expect(html).toContain('Status');
    expect(html).toContain('fixed for this store');
    expect(html).not.toContain('aria-invalid');
    expect(html).not.toContain('field-error');
  });
});
