import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  describePrinterList,
  describeSelectedPrinter,
  PrinterSettingsSection,
} from '../../src/renderer/src/features/settings/PrinterSettingsSection';
import { SettingsPage } from '../../src/renderer/src/features/settings/SettingsPage';
import type { PrinterConfig, PrinterDevice } from '../../src/shared/printing';

/**
 * Phase 2I — Settings → Receipt Printer (`task §20`). No jsdom: the "Current"
 * line and the list-status line are the two pure functions the section renders,
 * plus first-render markup.
 */

const dev = (deviceName: string, displayName = deviceName, isDefault = false): PrinterDevice => ({
  deviceName,
  displayName,
  isDefault,
  status: 0,
});

describe('describeSelectedPrinter — the "Current" line', () => {
  it('shows Loading before config arrives', () => {
    expect(describeSelectedPrinter(null)).toBe('Loading…');
  });

  it('shows a clear no-printer-selected state', () => {
    const cfg: PrinterConfig = {
      selectedDeviceName: null,
      selectedDisplayName: null,
      selectedIsAvailable: false,
    };
    expect(describeSelectedPrinter(cfg)).toMatch(/no receipt printer selected/i);
  });

  it('shows the friendly name + availability when the selected printer is present', () => {
    const cfg: PrinterConfig = {
      selectedDeviceName: 'Brother_QL_820NWB',
      selectedDisplayName: 'Brother QL-820NWB',
      selectedIsAvailable: true,
    };
    expect(describeSelectedPrinter(cfg)).toBe('Brother QL-820NWB — available');
  });

  it('flags a selected-but-missing printer without discarding the selection', () => {
    const cfg: PrinterConfig = {
      selectedDeviceName: 'Gone_Printer',
      selectedDisplayName: null,
      selectedIsAvailable: false,
    };
    expect(describeSelectedPrinter(cfg)).toBe(
      'Gone_Printer — selected, but not detected right now',
    );
  });
});

describe('describePrinterList — the picker status line', () => {
  it('loading state', () => {
    expect(describePrinterList(null, null)).toMatch(/loading printers/i);
  });

  it('zero-printer state', () => {
    expect(describePrinterList([], null)).toMatch(/no windows printers were found/i);
  });

  it('a count when printers are found', () => {
    expect(describePrinterList([dev('A'), dev('B')], null)).toBe('2 printers found.');
    expect(describePrinterList([dev('A')], null)).toBe('1 printer found.');
  });

  it('a list failure is non-fatal and says so', () => {
    const line = describePrinterList(null, 'driver error');
    expect(line).toMatch(/could not be listed/i);
    expect(line).toMatch(/still complete and save sales/i);
  });
});

describe('first render', () => {
  it('PrinterSettingsSection shows the heading and a Refresh action, no noisy errors', () => {
    const html = renderToStaticMarkup(<PrinterSettingsSection />);
    expect(html).toContain('Receipt Printer');
    expect(html).toContain('Refresh printers');
    expect(html).not.toContain('aria-invalid');
    expect(html).not.toContain('field-error');
  });

  it('SettingsPage mounts the printer section alongside tax and business', () => {
    const html = renderToStaticMarkup(<SettingsPage />);
    expect(html).toContain('Tax Rate');
    expect(html).toContain('Business &amp; Receipt');
    expect(html).toContain('Receipt Printer');
  });
});
