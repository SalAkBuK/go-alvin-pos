import { describe, expect, it } from 'vitest';
import {
  extractSpreadsheetId,
  validateGoogleConfigUpdate,
} from '../../src/main/settings/googleSettingsValidation';
import { sheetRef } from '../../src/main/google/sheetsTransport';

/**
 * Phase 2J — trusted config validation + A1 range encoding (`task §5`, `§21`).
 */

describe('extractSpreadsheetId', () => {
  it('pulls the id from a pasted Sheets URL, or returns the trimmed input', () => {
    expect(
      extractSpreadsheetId('https://docs.google.com/spreadsheets/d/1AbC-dEf_123/edit#gid=0'),
    ).toBe('1AbC-dEf_123');
    expect(extractSpreadsheetId('  1AbC-dEf_123  ')).toBe('1AbC-dEf_123');
  });
});

describe('validateGoogleConfigUpdate', () => {
  const ok = {
    enabled: false,
    spreadsheetId: '1AbCdEfGhIjK-_2345',
    salesSheetName: 'Sales',
    saleItemsSheetName: 'Sale Items',
  };

  it('accepts a well-formed payload and extracts a URL id', () => {
    expect(
      validateGoogleConfigUpdate({
        ...ok,
        spreadsheetId: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjK-_2345/edit',
      }),
    ).toEqual({
      enabled: false,
      spreadsheetId: '1AbCdEfGhIjK-_2345',
      salesSheetName: 'Sales',
      saleItemsSheetName: 'Sale Items',
    });
  });

  it('allows a blank spreadsheet id while enabled is off', () => {
    expect(validateGoogleConfigUpdate({ ...ok, spreadsheetId: '' }).spreadsheetId).toBe('');
  });

  it.each([
    ['unknown field', { ...ok, extra: 1 }],
    ['non-boolean enabled', { ...ok, enabled: 'yes' }],
    ['malformed id', { ...ok, spreadsheetId: 'too/short' }],
    ['blank sheet name', { ...ok, salesSheetName: '   ' }],
    ['forbidden char in sheet name', { ...ok, saleItemsSheetName: 'Items:2026' }],
    ['not an object', 'nope'],
  ])('rejects %s', (_label, input) => {
    expect(() => validateGoogleConfigUpdate(input)).toThrow();
  });
});

describe('sheetRef — A1 encoding', () => {
  it('leaves a bare identifier unquoted and quotes names with spaces', () => {
    expect(sheetRef('Sales', 'A:A')).toBe('Sales!A:A');
    expect(sheetRef('Sale Items', 'A5')).toBe("'Sale Items'!A5");
    expect(sheetRef("Bob's Sheet", 'A1')).toBe("'Bob''s Sheet'!A1");
  });
});
