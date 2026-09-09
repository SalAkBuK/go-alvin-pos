import type { UpdateGoogleConfigInput } from '../../shared/google';
import {
  GOOGLE_SHEET_NAME_MAX_LENGTH,
  GOOGLE_SPREADSHEET_ID_MAX_LENGTH,
} from '../../shared/google';
import { appErrors } from '../shared/appError';

/**
 * Trusted validation for `google:update-config` (`ARCHITECTURE.md §30`;
 * `DATA_MODEL.md §20`; `task §5`). The renderer's checks are UX only; this is
 * the authoritative gate. Unknown keys, wrong types, malformed ids / sheet
 * names are rejected outright — never coerced.
 */

const ALLOWED_KEYS = ['enabled', 'spreadsheetId', 'salesSheetName', 'saleItemsSheetName'] as const;

/** A bare Google spreadsheet id: the `/d/<id>/` segment of a Sheets URL. */
const SPREADSHEET_ID = /^[A-Za-z0-9_-]{10,200}$/;

/** Google worksheet-tab names cannot contain these, and cannot be blank. */
const FORBIDDEN_SHEET_NAME_CHARS = /[[\]*?/\\:]/;

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw appErrors.validation('The Google Sheets configuration must be an object.');
  }
  return value as Record<string, unknown>;
}

/**
 * Extract a spreadsheet id from a value that may be a bare id or a pasted
 * Google Sheets URL. Deterministic: a URL must contain a `/d/<id>` segment; an
 * unrecognised string is returned trimmed and validated as-is.
 */
export function extractSpreadsheetId(input: string): string {
  const trimmed = input.trim();
  const urlMatch = /\/d\/([A-Za-z0-9_-]+)/.exec(trimmed);
  if (urlMatch) {
    return urlMatch[1]!;
  }
  return trimmed;
}

function validateSheetName(raw: unknown, label: string): string {
  if (typeof raw !== 'string') {
    throw appErrors.validation(`${label} must be text.`);
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw appErrors.validation(`Enter the ${label.toLowerCase()}.`);
  }
  if (trimmed.length > GOOGLE_SHEET_NAME_MAX_LENGTH) {
    throw appErrors.validation(
      `${label} must be ${GOOGLE_SHEET_NAME_MAX_LENGTH} characters or fewer.`,
    );
  }
  if (FORBIDDEN_SHEET_NAME_CHARS.test(trimmed)) {
    throw appErrors.validation(`${label} contains a character a worksheet tab cannot use.`);
  }
  return trimmed;
}

export function validateGoogleConfigUpdate(raw: unknown): UpdateGoogleConfigInput {
  const record = asRecord(raw);
  const unexpected = Object.keys(record).filter(
    (key) => !(ALLOWED_KEYS as readonly string[]).includes(key),
  );
  if (unexpected.length > 0) {
    throw appErrors.validation(
      `The Google Sheets configuration contains unexpected field(s): ${unexpected.join(', ')}.`,
    );
  }

  if (typeof record['enabled'] !== 'boolean') {
    throw appErrors.validation('The enabled flag must be true or false.');
  }
  const enabled = record['enabled'];

  const rawId = record['spreadsheetId'];
  if (typeof rawId !== 'string') {
    throw appErrors.validation('The spreadsheet ID must be text.');
  }
  const spreadsheetId = extractSpreadsheetId(rawId);
  if (spreadsheetId !== '') {
    if (spreadsheetId.length > GOOGLE_SPREADSHEET_ID_MAX_LENGTH) {
      throw appErrors.validation('That spreadsheet ID is too long.');
    }
    if (!SPREADSHEET_ID.test(spreadsheetId)) {
      throw appErrors.validation(
        'Enter a valid Google spreadsheet ID (the part of the sheet URL after /d/).',
      );
    }
  }

  const salesSheetName = validateSheetName(record['salesSheetName'], 'Sales worksheet name');
  const saleItemsSheetName = validateSheetName(
    record['saleItemsSheetName'],
    'Sale Items worksheet name',
  );

  return { enabled, spreadsheetId, salesSheetName, saleItemsSheetName };
}
