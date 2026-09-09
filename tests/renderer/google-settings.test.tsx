import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GoogleSheetsSection } from '../../src/renderer/src/features/settings/GoogleSheetsSection';
import { SettingsPage } from '../../src/renderer/src/features/settings/SettingsPage';
import {
  describeConnection,
  describeExportState,
  describeQueue,
  extractSpreadsheetId,
  fieldsFromConfig,
  validateGoogleForm,
  validateSheetNameField,
  validateSpreadsheetIdField,
} from '../../src/renderer/src/features/settings/googleConfig';
import type { GoogleConfig } from '../../src/shared/google';

/**
 * Phase 2J — Settings → Google Sheets renderer coverage (`task §8`, `§28`). No
 * jsdom: the pure helpers are the exact gates the section runs.
 */

function config(overrides: Partial<GoogleConfig> = {}): GoogleConfig {
  return {
    enabled: false,
    spreadsheetId: null,
    salesSheetName: 'Sales',
    saleItemsSheetName: 'Sale Items',
    lastSuccessfulSyncAt: null,
    connected: false,
    serviceAccountEmail: null,
    configured: false,
    secureStorageAvailable: true,
    queue: { pending: 0, exporting: 0, exported: 0, failed: 0 },
    ...overrides,
  };
}

describe('describeConnection', () => {
  it('reflects loading / secure-storage / connected / not-connected', () => {
    expect(describeConnection(null)).toBe('Loading…');
    expect(describeConnection(config({ secureStorageAvailable: false }))).toMatch(
      /secure storage unavailable/i,
    );
    expect(
      describeConnection(
        config({ connected: true, serviceAccountEmail: 'pos@x.iam.gserviceaccount.com' }),
      ),
    ).toBe('Connected as pos@x.iam.gserviceaccount.com');
    expect(describeConnection(config())).toBe('Not connected');
  });
});

describe('describeExportState / describeQueue', () => {
  it('states enabled+configured vs enabled-but-not-connected vs off', () => {
    expect(
      describeExportState(config({ enabled: true, connected: true, configured: true })),
    ).toMatch(/enabled/i);
    expect(describeExportState(config({ enabled: true, connected: false }))).toMatch(
      /no Google account is connected/i,
    );
    expect(describeExportState(config())).toMatch(/off/i);
  });

  it('describeQueue shows the four counts', () => {
    expect(describeQueue({ pending: 2, exporting: 1, exported: 5, failed: 3 })).toBe(
      '2 pending · 1 exporting · 5 exported · 3 failed',
    );
  });
});

describe('form validation', () => {
  it('spreadsheet id: blank allowed, URL extracted, malformed rejected', () => {
    expect(validateSpreadsheetIdField('')).toBeNull();
    expect(
      validateSpreadsheetIdField('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjK/edit'),
    ).toBeNull();
    expect(validateSpreadsheetIdField('too/short')).toMatch(/valid Google spreadsheet ID/i);
    expect(extractSpreadsheetId('https://docs.google.com/spreadsheets/d/XY_z-123/edit')).toBe(
      'XY_z-123',
    );
  });

  it('sheet name: required, bounded, no forbidden chars', () => {
    expect(validateSheetNameField('  ', 'Sales worksheet name')).toMatch(/enter the/i);
    expect(validateSheetNameField('Sales/2026', 'Sales worksheet name')).toMatch(/cannot use/i);
    expect(validateSheetNameField('Sales', 'Sales worksheet name')).toBeNull();
  });

  it('validateGoogleForm returns a payload only when every field is valid', () => {
    const good = validateGoogleForm({
      enabled: false,
      spreadsheetId: '1AbCdEfGhIjK',
      salesSheetName: ' Sales ',
      saleItemsSheetName: 'Sale Items',
    });
    expect(good.payload).toEqual({
      enabled: false,
      spreadsheetId: '1AbCdEfGhIjK',
      salesSheetName: 'Sales',
      saleItemsSheetName: 'Sale Items',
    });
    const bad = validateGoogleForm({
      enabled: true,
      spreadsheetId: 'x',
      salesSheetName: 'Sales',
      saleItemsSheetName: 'Sale Items',
    });
    expect(bad.payload).toBeNull();
    expect(bad.errors.spreadsheetId).toBeTruthy();
  });

  it('fieldsFromConfig prefills defaults before load', () => {
    expect(fieldsFromConfig(null)).toEqual({
      enabled: false,
      spreadsheetId: '',
      salesSheetName: 'Sales',
      saleItemsSheetName: 'Sale Items',
    });
  });
});

describe('first render', () => {
  it('GoogleSheetsSection shows the heading, connect action, and no secrets/noisy errors', () => {
    const html = renderToStaticMarkup(<GoogleSheetsSection />);
    expect(html).toContain('Google Sheets');
    expect(html).toContain('Connect service account');
    expect(html).toContain('Enable Google Sheets export');
    expect(html).toContain('Sales worksheet name');
    expect(html).not.toContain('aria-invalid');
    expect(html).not.toContain('PRIVATE KEY');
  });

  it('SettingsPage mounts the Google section alongside the others', () => {
    const html = renderToStaticMarkup(<SettingsPage />);
    expect(html).toContain('Tax Rate');
    expect(html).toContain('Receipt Printer');
    expect(html).toContain('Google Sheets');
  });
});
