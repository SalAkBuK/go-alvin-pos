import type { GoogleAuthProvider } from './googleAuthProvider';
import { googleApiRequest } from './googleApiRequest';

/**
 * The minimum Google Sheets v4 REST surface the export worker needs: read a
 * column, batch-update ranges, append rows. Direct HTTPS via the trusted
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
  /** Per-attempt cancellation. */
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
  const { spreadsheetId, auth, signal, fetchImpl } = deps;
  const id = encodeURIComponent(spreadsheetId);

  const request = (method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> =>
    googleApiRequest({ auth, method, url: `${API_BASE}/${id}${path}`, body, signal, fetchImpl });

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
