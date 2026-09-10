import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GoogleSheetsSection } from '../../src/renderer/src/features/settings/GoogleSheetsSection';
import { SettingsPage } from '../../src/renderer/src/features/settings/SettingsPage';
import {
  describeConnection,
  describeSync,
  describeUnavailable,
  googleView,
} from '../../src/renderer/src/features/settings/googleConfig';
import type { GoogleConfig } from '../../src/shared/google';

/**
 * Phase 2J.1 — Settings → Google Sheets renderer coverage (`REQ-GSHEET-016`,
 * `-017`, `-018`; `TEST-GSHEET-041`). No jsdom: the pure helpers are the exact
 * gates the section runs. No credential JSON picker, no spreadsheet-ID field, no
 * worksheet-name fields.
 */

function config(overrides: Partial<GoogleConfig> = {}): GoogleConfig {
  return {
    setupState: 'DISCONNECTED',
    connected: false,
    enabled: false,
    ready: false,
    accountEmail: null,
    spreadsheetName: null,
    canOpenSpreadsheet: false,
    lastSuccessfulSyncAt: null,
    secureStorageAvailable: true,
    oauthClientConfigured: true,
    needsReauthorization: false,
    setupIncompleteReason: null,
    queue: { pending: 0, exporting: 0, exported: 0, failed: 0 },
    ...overrides,
  };
}

describe('googleView', () => {
  it('maps config to the four rendered states', () => {
    expect(googleView(null)).toBe('loading');
    expect(googleView(config({ oauthClientConfigured: false }))).toBe('unavailable');
    expect(googleView(config({ secureStorageAvailable: false }))).toBe('unavailable');
    expect(googleView(config())).toBe('disconnected');
    expect(googleView(config({ connected: true, setupState: 'SETUP_INCOMPLETE' }))).toBe(
      'setup-incomplete',
    );
    expect(googleView(config({ connected: true, setupState: 'READY', ready: true }))).toBe('ready');
  });
});

describe('display strings', () => {
  it('describeConnection', () => {
    expect(describeConnection(null)).toBe('Loading…');
    expect(describeConnection(config({ connected: true, accountEmail: 'owner@example.com' }))).toBe(
      'Connected as owner@example.com',
    );
    expect(describeConnection(config())).toBe('Not connected');
  });

  it('describeSync reflects reauth / paused / backlog / up-to-date', () => {
    expect(describeSync(config({ needsReauthorization: true }))).toMatch(/sign in again/i);
    expect(describeSync(config({ enabled: false }))).toMatch(/paused/i);
    expect(
      describeSync(
        config({ enabled: true, queue: { pending: 3, exporting: 0, exported: 1, failed: 0 } }),
      ),
    ).toMatch(/3 sales waiting/i);
    expect(
      describeSync(
        config({ enabled: true, queue: { pending: 0, exporting: 0, exported: 9, failed: 0 } }),
      ),
    ).toBe('Up to date.');
  });

  it('describeUnavailable', () => {
    expect(describeUnavailable(config({ secureStorageAvailable: false }))).toMatch(/securely/i);
    expect(describeUnavailable(config({ oauthClientConfigured: false }))).toMatch(/not available/i);
  });
});

describe('first render', () => {
  it('shows the heading and Connect action, no service-account / ID / worksheet fields, no secrets', () => {
    const html = renderToStaticMarkup(<GoogleSheetsSection />);
    expect(html).toContain('Google Sheets');
    expect(html).toContain('Connect Google Account');
    expect(html).not.toMatch(/service account/i);
    expect(html).not.toMatch(/spreadsheet id/i);
    expect(html).not.toMatch(/worksheet name/i);
    expect(html).not.toMatch(/credential|\.json|refresh_token|ya29|PRIVATE KEY/i);
    expect(html).not.toContain('aria-invalid');
  });

  it('SettingsPage mounts the Google section alongside the others', () => {
    const html = renderToStaticMarkup(<SettingsPage />);
    expect(html).toContain('Tax Rate');
    expect(html).toContain('Receipt Printer');
    expect(html).toContain('Google Sheets');
  });
});
