import type Database from 'better-sqlite3';
import type { PrinterConfig, PrinterDevice, PrintReceiptResult } from '../../shared/printing';
import { createReceiptService } from '../checkout/receiptService';
import {
  readSelectedPrinter,
  SELECTED_PRINTER_MAX_LENGTH,
  writeSelectedPrinter,
} from '../settings/printerSettingsRepository';
import { appErrors } from '../shared/appError';
import { renderReceiptDocument } from './receiptDocument';

/**
 * The focused main-process printing service (`ARCHITECTURE.md §18`-`§19`;
 * `REQ-PRINT-001`-`REQ-PRINT-005`; `REQ-REC-001`-`REQ-REC-005`; `task §6`).
 *
 * Printing is a SECONDARY, post-commit, read-only operation. `printReceipt`:
 *
 *  1. validates the Sale ID;
 *  2. reads the locally-selected printer (`PRINTER_NOT_CONFIGURED` when none);
 *  3. confirms that printer is present in the current enumeration
 *     (`PRINTER_UNAVAILABLE` otherwise) — the reliable "clearly unavailable
 *     configured device" check (`task §16`);
 *  4. rebuilds the receipt from stored snapshots via the EXISTING
 *     {@link createReceiptService} — never a renderer object, never live
 *     products/customers/settings (`task §3`);
 *  5. renders the controlled printable HTML document;
 *  6. submits it through the injected {@link PrintAdapter} (Electron/Windows in
 *     production; a fake in tests — `task §6`);
 *  7. returns a narrow success result or throws a stable typed `AppError`.
 *
 * It writes NOTHING to sales, sale items, payments, inventory, movements,
 * checkout requests, export jobs, or receipt numbers. `selectPrinter` is the
 * only write and it touches only `settings.selected_printer`.
 */

/**
 * The Electron-specific boundary. Kept tiny and injectable so the service is
 * fully testable without a real printer or print dialog (`task §6`).
 */
export interface PrintAdapter {
  /** Enumerate Windows printers. Rejects only on an unexpected platform error. */
  listPrinters(): Promise<readonly PrinterDevice[]>;
  /**
   * Print `html` on `deviceName`. Resolves when the OS spooler accepts the job;
   * rejects (any reason) when it does not. Must not leak windows/resources
   * across repeated calls.
   */
  printDocument(html: string, options: { readonly deviceName: string }): Promise<void>;
}

export interface PrintingServiceDeps {
  readonly db: Database.Database;
  readonly adapter: PrintAdapter;
  /** ISO-8601 UTC clock; injectable for deterministic tests. */
  readonly now?: () => string;
}

export interface PrintingService {
  listPrinters(): Promise<readonly PrinterDevice[]>;
  getConfig(): Promise<PrinterConfig>;
  selectPrinter(raw: unknown): Promise<PrinterConfig>;
  printReceipt(rawSaleId: unknown): Promise<PrintReceiptResult>;
}

function validateSaleId(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw appErrors.validation('A sale must be selected to print its receipt.');
  }
  return raw.trim();
}

function validateDeviceName(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw appErrors.validation('The printer selection must be an object.');
  }
  const record = raw as Record<string, unknown>;
  const unexpected = Object.keys(record).filter((key) => key !== 'deviceName');
  if (unexpected.length > 0) {
    throw appErrors.validation(
      `The printer selection contains unexpected field(s): ${unexpected.join(', ')}.`,
    );
  }
  const value = record['deviceName'];
  if (typeof value !== 'string') {
    throw appErrors.validation('The printer name must be text.');
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    throw appErrors.validation('Choose a printer.');
  }
  if (trimmed.length > SELECTED_PRINTER_MAX_LENGTH) {
    throw appErrors.validation('That printer name is too long.');
  }
  return trimmed;
}

async function enumerate(adapter: PrintAdapter): Promise<readonly PrinterDevice[]> {
  try {
    return await adapter.listPrinters();
  } catch {
    // Enumeration failure is non-fatal for the caller that only wants a list
    // (`task §20`); `printReceipt` treats "cannot enumerate" as the device not
    // being confirmable → PRINTER_UNAVAILABLE below.
    return [];
  }
}

export function createPrintingService(deps: PrintingServiceDeps): PrintingService {
  const { db, adapter } = deps;
  const now = deps.now ?? ((): string => new Date().toISOString());

  async function buildConfig(): Promise<PrinterConfig> {
    const selectedDeviceName = readSelectedPrinter(db);
    if (selectedDeviceName === null) {
      return { selectedDeviceName: null, selectedDisplayName: null, selectedIsAvailable: false };
    }
    const printers = await enumerate(adapter);
    const match = printers.find((p) => p.deviceName === selectedDeviceName) ?? null;
    return {
      selectedDeviceName,
      selectedDisplayName: match ? match.displayName : null,
      selectedIsAvailable: match !== null,
    };
  }

  return {
    async listPrinters(): Promise<readonly PrinterDevice[]> {
      return adapter.listPrinters();
    },

    getConfig(): Promise<PrinterConfig> {
      return buildConfig();
    },

    async selectPrinter(raw: unknown): Promise<PrinterConfig> {
      const deviceName = validateDeviceName(raw);
      // Persist whatever the user picked from the list they were shown. We do
      // not hard-fail when it is momentarily absent from a fresh enumeration —
      // the workflow is "save the selection locally" (`POS_WORKFLOWS.md §70`);
      // availability is surfaced by `getConfig`, and a later print reports
      // PRINTER_UNAVAILABLE if it is truly gone.
      writeSelectedPrinter(db, deviceName, now());
      return buildConfig();
    },

    async printReceipt(rawSaleId: unknown): Promise<PrintReceiptResult> {
      const saleId = validateSaleId(rawSaleId);

      const selectedDeviceName = readSelectedPrinter(db);
      if (selectedDeviceName === null) {
        throw appErrors.printerNotConfigured();
      }

      const printers = await enumerate(adapter);
      if (!printers.some((p) => p.deviceName === selectedDeviceName)) {
        throw appErrors.printerUnavailable();
      }

      // Existing trusted receipt assembly — snapshot-only, no network, no printer.
      const representation = createReceiptService({ db }).getBySaleId(saleId);
      const html = renderReceiptDocument(representation);

      try {
        await adapter.printDocument(html, { deviceName: selectedDeviceName });
      } catch {
        // Raw Electron/driver reason is deliberately swallowed here — the IPC
        // layer already logs non-AppError throws, and this path throws a stable
        // typed error with no driver internals (`task §15`-`§16`).
        throw appErrors.printFailed();
      }

      return {
        saleId: representation.saleId,
        receiptNumber: representation.receiptNumber,
        deviceName: selectedDeviceName,
        voided: representation.status === 'VOIDED',
        acceptedAt: now(),
      };
    },
  };
}
