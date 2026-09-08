import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/src/App';
import {
  SettingsPage,
  describeCurrent,
} from '../../src/renderer/src/features/settings/SettingsPage';
import {
  formatBpsAsPercent,
  parsePercentToBps,
  PercentParseError,
  validateTaxRatePercent,
} from '../../src/renderer/src/features/settings/taxRate';

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

describe('renders on the shell', () => {
  it('App shows a Settings nav entry', () => {
    expect(renderToStaticMarkup(<App />)).toContain('Settings');
  });

  it('SettingsPage first render: labelled field, hint, no noisy error / aria-invalid', () => {
    const html = renderToStaticMarkup(<SettingsPage />);
    expect(html).toContain('Tax Rate');
    expect(html).toContain('Sales-tax rate (%)');
    expect(html).toContain('8.25'); // placeholder / hint example
    expect(html).toContain('Current');
    expect(html).not.toContain('aria-invalid');
    expect(html).not.toContain('field-error');
  });
});
