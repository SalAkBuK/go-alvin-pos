import type { GoogleAuthProvider } from './googleAuth';
import {
  classifyHttpStatus,
  classifyThrown,
  GoogleApiError,
  scrubExternalText,
} from './googleRedaction';

/**
 * The minimum Google Sheets v4 REST surface the worker needs (`task §21`): read
 * a column, batch-update ranges, append rows. Direct HTTPS via the trusted
 * main-process `fetch` — NOT the full `googleapis` SDK.
 *
 * All writes use `valueInputOption=RAW` so Google stores strings verbatim and
 * never parses a leading `=` as a formula (`REQ-GSHEET-014`; the apostrophe
 * neutralization in `exportSerialization` is the second layer).
 *
 * The spreadsheet id, sheet names, and ranges are all encoded here; no
 * renderer-built URLs ever reach this module.
 */

export interface SheetsTransport {
  /** Rows of the A1 `range` (e.g. `Sales!A:A`), unformatted. `[]` when empty. */
  getValues(range: string): Promise<string[][]>;
  /** Overwrite one or more A1 ranges, atomically per Google request. */
  batchUpdate(
    data: ReadonlyArray<{ readonly range: string; readonly values: string[][] }>,
  ): Promise<void>;
  /** Append rows to the table anchored at `range` (inserts new rows). */
  append(range: string, values: string[][]): Promise<void>;
}

export interface SheetsTransportDeps {
  readonly spreadsheetId: string;
  readonly auth: GoogleAuthProvider;
  /** Per-attempt cancellation (`task §12`). */
  readonly signal?: AbortSignal;
  /** Overridable for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

const API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

/** A1 sheet-name reference: quote when it is not a bare identifier. */
export function sheetRef(sheetName: string, a1: string): string {
  const bare = /^[A-Za-z0-9_]+$/.test(sheetName);
  const name = bare ? sheetName : `'${sheetName.replace(/'/g, "''")}'`;
  return `${name}!${a1}`;
}

export function createSheetsTransport(deps: SheetsTransportDeps): SheetsTransport {
  const { spreadsheetId, auth, signal } = deps;
  const doFetch = deps.fetchImpl ?? fetch;
  const id = encodeURIComponent(spreadsheetId);

  async function request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    let token: string;
    try {
      token = await auth.getAccessToken();
    } catch (error) {
      throw new GoogleApiError('AUTH', error instanceof Error ? error.message : String(error), {
        unknownOutcome: false,
      });
    }

    let response: Response;
    try {
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }
      if (signal) {
        init.signal = signal;
      }
      response = await doFetch(`${API_BASE}/${id}${path}`, init);
    } catch (error) {
      throw classifyThrown(error);
    }

    if (!response.ok) {
      let detail = `HTTP ${String(response.status)}`;
      try {
        const text = await response.text();
        const parsed = JSON.parse(text) as { error?: { message?: string } };
        if (parsed.error?.message) {
          detail = parsed.error.message;
        }
      } catch {
        /* keep the status-only detail */
      }
      throw new GoogleApiError(classifyHttpStatus(response.status), scrubExternalText(detail), {
        httpStatus: response.status,
        // A 5xx after the request was sent is ambiguous; treat as unknown so the
        // stale machinery governs the retry rather than a definite failure.
        unknownOutcome: response.status >= 500,
      });
    }

    if (method === 'GET') {
      return response.json();
    }
    return undefined;
  }

  return {
    async getValues(range: string): Promise<string[][]> {
      const encoded = encodeURIComponent(range);
      const result = (await request(
        'GET',
        `/values/${encoded}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`,
      )) as { values?: unknown[][] };
      if (!Array.isArray(result.values)) {
        return [];
      }
      return result.values.map((row) => row.map((cell) => (cell == null ? '' : String(cell))));
    },

    async batchUpdate(data): Promise<void> {
      if (data.length === 0) {
        return;
      }
      await request('POST', `/values:batchUpdate`, {
        valueInputOption: 'RAW',
        data: data.map((entry) => ({
          range: entry.range,
          majorDimension: 'ROWS',
          values: entry.values,
        })),
      });
    },

    async append(range: string, values: string[][]): Promise<void> {
      if (values.length === 0) {
        return;
      }
      const encoded = encodeURIComponent(range);
      await request(
        'POST',
        `/values/${encoded}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        { majorDimension: 'ROWS', values },
      );
    },
  };
}
