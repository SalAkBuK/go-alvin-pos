import type { PrintAdapter } from '../../src/main/printing/printingService';
import type { PrinterDevice } from '../../src/shared/printing';

/**
 * A fully in-memory {@link PrintAdapter} for the Phase 2I suites — no real
 * printer, no print dialog, no Electron window (`TEST_PLAN.md` TEST-PRINT-*,
 * `task §6`). It records every submitted document so tests can assert the
 * correct receipt representation reached the print boundary, and can be told to
 * fail enumeration or the print call to simulate a disconnected / unavailable
 * printer.
 */

export function printerDevice(
  deviceName: string,
  displayName: string = deviceName,
  isDefault = false,
): PrinterDevice {
  return { deviceName, displayName, isDefault, status: 0 };
}

export const DEFAULT_PRINTER = printerDevice('Brother_QL_820NWB', 'Brother QL-820NWB', true);

export interface FakePrintAdapter extends PrintAdapter {
  /** Every `printDocument` call, in order. */
  readonly jobs: Array<{ html: string; deviceName: string }>;
  /** Mutable enumeration returned by `listPrinters`. */
  printers: PrinterDevice[];
  /** When set, `listPrinters` rejects with this. */
  listError: Error | null;
  /** When > 0, the next N `printDocument` calls reject (then decrement). */
  failPrintTimes: number;
  /** Reason used when a print call is forced to fail. */
  failReason: string;
}

export function fakePrintAdapter(printers: PrinterDevice[] = [DEFAULT_PRINTER]): FakePrintAdapter {
  const adapter: FakePrintAdapter = {
    jobs: [],
    printers: [...printers],
    listError: null,
    failPrintTimes: 0,
    failReason: 'Simulated printer failure.',
    listPrinters(): Promise<readonly PrinterDevice[]> {
      if (adapter.listError) {
        return Promise.reject(adapter.listError);
      }
      return Promise.resolve([...adapter.printers]);
    },
    printDocument(html: string, options: { deviceName: string }): Promise<void> {
      if (adapter.failPrintTimes > 0) {
        adapter.failPrintTimes -= 1;
        return Promise.reject(new Error(adapter.failReason));
      }
      adapter.jobs.push({ html, deviceName: options.deviceName });
      return Promise.resolve();
    },
  };
  return adapter;
}
