import type { GoogleConfig, GoogleQueueSummary } from '../../../../shared/google';
import {
  GOOGLE_SALES_SHEET_DEFAULT,
  GOOGLE_SALE_ITEMS_SHEET_DEFAULT,
  GOOGLE_SHEET_NAME_MAX_LENGTH,
} from '../../../../shared/google';

/**
 * Pure, React-free helpers for the Settings → Google Sheets section (`task §8`).
 * No jsdom in the renderer suites, so the display strings and the form gates are
 * unit-tested here directly. The trusted layer re-validates everything.
 */

const SPREADSHEET_ID = /^[A-Za-z0-9_-]{10,200}$/;
const FORBIDDEN_SHEET_NAME_CHARS = /[[\]*?/\\:]/;

export interface GoogleFormFields {
  readonly enabled: boolean;
  readonly spreadsheetId: string;
  readonly salesSheetName: string;
  readonly saleItemsSheetName: string;
}

export function fieldsFromConfig(config: GoogleConfig | null): GoogleFormFields {
  if (config === null) {
    return {
      enabled: false,
      spreadsheetId: '',
      salesSheetName: GOOGLE_SALES_SHEET_DEFAULT,
      saleItemsSheetName: GOOGLE_SALE_ITEMS_SHEET_DEFAULT,
    };
  }
  return {
    enabled: config.enabled,
    spreadsheetId: config.spreadsheetId ?? '',
    salesSheetName: config.salesSheetName,
    saleItemsSheetName: config.saleItemsSheetName,
  };
}

/** Deterministically pull a spreadsheet id out of a pasted Sheets URL, or return the trimmed input. */
export function extractSpreadsheetId(input: string): string {
  const trimmed = input.trim();
  const match = /\/d\/([A-Za-z0-9_-]+)/.exec(trimmed);
  return match ? match[1]! : trimmed;
}

export function describeConnection(config: GoogleConfig | null): string {
  if (config === null) {
    return 'Loading…';
  }
  if (!config.secureStorageAvailable) {
    return 'Secure storage unavailable on this device';
  }
  if (config.connected) {
    return config.serviceAccountEmail ? `Connected as ${config.serviceAccountEmail}` : 'Connected';
  }
  return 'Not connected';
}

export function describeExportState(config: GoogleConfig | null): string {
  if (config === null) {
    return '';
  }
  if (config.configured) {
    return 'Export is enabled — completed sales sync to Google Sheets in the background.';
  }
  if (config.enabled && !config.connected) {
    return 'Export is enabled but no Google account is connected. Connect one below.';
  }
  return 'Export is off. Completed sales are saved locally and can be exported later.';
}

export function describeQueue(queue: GoogleQueueSummary): string {
  return `${String(queue.pending)} pending · ${String(queue.exporting)} exporting · ${String(
    queue.exported,
  )} exported · ${String(queue.failed)} failed`;
}

export function describeLastSync(config: GoogleConfig | null): string {
  if (config === null || config.lastSuccessfulSyncAt === null) {
    return 'Never';
  }
  const instant = new Date(config.lastSuccessfulSyncAt);
  if (Number.isNaN(instant.getTime())) {
    return config.lastSuccessfulSyncAt;
  }
  return instant.toLocaleString();
}

export function validateSpreadsheetIdField(value: string): string | null {
  const id = extractSpreadsheetId(value);
  if (id === '') {
    return null; // blank is allowed while enabled is off
  }
  return SPREADSHEET_ID.test(id)
    ? null
    : 'Enter a valid Google spreadsheet ID (the part of the sheet URL after /d/).';
}

export function validateSheetNameField(value: string, label: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') {
    return `Enter the ${label}.`;
  }
  if (trimmed.length > GOOGLE_SHEET_NAME_MAX_LENGTH) {
    return `The ${label} must be ${GOOGLE_SHEET_NAME_MAX_LENGTH} characters or fewer.`;
  }
  if (FORBIDDEN_SHEET_NAME_CHARS.test(trimmed)) {
    return `The ${label} contains a character a worksheet tab cannot use.`;
  }
  return null;
}

export interface GoogleFormValidation {
  readonly errors: {
    spreadsheetId?: string;
    salesSheetName?: string;
    saleItemsSheetName?: string;
  };
  readonly payload: {
    enabled: boolean;
    spreadsheetId: string;
    salesSheetName: string;
    saleItemsSheetName: string;
  } | null;
}

export function validateGoogleForm(fields: GoogleFormFields): GoogleFormValidation {
  const errors: GoogleFormValidation['errors'] = {};
  const spreadsheetIdError = validateSpreadsheetIdField(fields.spreadsheetId);
  if (spreadsheetIdError) {
    errors.spreadsheetId = spreadsheetIdError;
  }
  const salesError = validateSheetNameField(fields.salesSheetName, 'Sales worksheet name');
  if (salesError) {
    errors.salesSheetName = salesError;
  }
  const itemsError = validateSheetNameField(fields.saleItemsSheetName, 'Sale Items worksheet name');
  if (itemsError) {
    errors.saleItemsSheetName = itemsError;
  }
  if (Object.keys(errors).length > 0) {
    return { errors, payload: null };
  }
  return {
    errors,
    payload: {
      enabled: fields.enabled,
      spreadsheetId: extractSpreadsheetId(fields.spreadsheetId),
      salesSheetName: fields.salesSheetName.trim(),
      saleItemsSheetName: fields.saleItemsSheetName.trim(),
    },
  };
}
