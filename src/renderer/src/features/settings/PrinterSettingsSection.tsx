import { useCallback, useEffect, useState } from 'react';
import type { PrinterConfig, PrinterDevice } from '../../../../shared/printing';
import type { IpcResult } from '../../../../shared/products';

/**
 * Settings → Printer (`POS_WORKFLOWS.md §70` Change Printer Workflow;
 * `REQ-PRINT-004`; `DATA_MODEL.md §19`-`§20`; task `§10`, `§12`, `§20`).
 *
 * Lists Windows printers, lets the store user pick one, and persists the choice
 * to `settings.selected_printer` through the narrow `window.pos.printing.*`
 * surface (no generic settings setter). Changing the selection affects only
 * future print attempts — it never touches an existing sale or historical
 * receipt. A failure to enumerate printers is shown but is non-fatal: it never
 * blocks a sale, and a previously-saved selection still stands.
 *
 * This is NOT Support & Diagnostics printer-health monitoring (`task §20`).
 */

function pos() {
  if (typeof window === 'undefined' || typeof window.pos === 'undefined') {
    return null;
  }
  return window.pos;
}

async function unwrap<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const result = await promise;
  if (result.ok) {
    return result.data;
  }
  throw new Error(result.error.message);
}

/** The "Current:" line. Exported for direct testing (this suite has no jsdom). */
export function describeSelectedPrinter(config: PrinterConfig | null): string {
  if (config === null) {
    return 'Loading…';
  }
  if (config.selectedDeviceName === null) {
    return 'No receipt printer selected. Choose a printer below.';
  }
  const label = config.selectedDisplayName ?? config.selectedDeviceName;
  return config.selectedIsAvailable
    ? `${label} — available`
    : `${label} — selected, but not detected right now`;
}

/** Describes the printer-list load outcome for the picker area. */
export function describePrinterList(
  printers: readonly PrinterDevice[] | null,
  error: string | null,
): string {
  if (error !== null) {
    return `Printers could not be listed. ${error} You can still complete and save sales.`;
  }
  if (printers === null) {
    return 'Loading printers…';
  }
  if (printers.length === 0) {
    return 'No Windows printers were found. Add a printer in Windows, then Refresh.';
  }
  return `${String(printers.length)} printer${printers.length === 1 ? '' : 's'} found.`;
}

export function PrinterSettingsSection() {
  const [config, setConfig] = useState<PrinterConfig | null>(null);
  const [printers, setPrinters] = useState<readonly PrinterDevice[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const api = pos();
    if (!api) {
      setListError('Printer settings are unavailable in this context.');
      return;
    }
    try {
      setConfig(await unwrap(api.printing.getConfig()));
    } catch (error) {
      setConfig({
        selectedDeviceName: null,
        selectedDisplayName: null,
        selectedIsAvailable: false,
      });
      setSaveError(error instanceof Error ? error.message : String(error));
    }
    // Enumeration is independent and non-fatal.
    try {
      setPrinters(await unwrap(api.printing.listPrinters()));
      setListError(null);
    } catch (error) {
      setPrinters([]);
      setListError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onSelect = useCallback(async (deviceName: string) => {
    const api = pos();
    if (!api) {
      setSaveError('Printer settings are unavailable in this context.');
      return;
    }
    setBusy(true);
    setNotice(null);
    setSaveError(null);
    try {
      const updated = await unwrap(api.printing.selectPrinter({ deviceName }));
      setConfig(updated);
      const label = updated.selectedDisplayName ?? updated.selectedDeviceName ?? deviceName;
      setNotice(`Receipt printer set to ${label}. Future prints use this printer.`);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <section className="settings-page printer-settings">
      <h3>Receipt Printer</h3>
      <p className="field-hint">
        Choose the printer used for the <strong>Print Receipt</strong> button on Sale Complete and{' '}
        <strong>Reprint Receipt</strong> in Sales History. Changing the printer never changes any
        saved sale or receipt.
      </p>

      <dl className="settings-current">
        <div>
          <dt>Current</dt>
          <dd>{describeSelectedPrinter(config)}</dd>
        </div>
      </dl>

      {saveError && (
        <p className="product-form-error" role="alert">
          {saveError}
        </p>
      )}
      {notice && (
        <p className="products-notice" role="status">
          {notice}
        </p>
      )}

      <p className="field-hint" role="status">
        {describePrinterList(printers, listError)}
      </p>

      {printers !== null && printers.length > 0 && (
        <ul className="printer-list">
          {printers.map((printer) => {
            const selected = config?.selectedDeviceName === printer.deviceName;
            return (
              <li key={printer.deviceName}>
                <span>
                  {printer.displayName}
                  {printer.isDefault ? ' · Windows default' : ''}
                  {selected ? ' · selected' : ''}
                </span>
                <button
                  type="button"
                  disabled={busy || selected}
                  onClick={() => void onSelect(printer.deviceName)}
                >
                  {selected ? 'Selected' : 'Use this printer'}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="product-form-actions">
        <button type="button" onClick={() => void load()} disabled={busy}>
          Refresh printers
        </button>
      </div>
    </section>
  );
}
