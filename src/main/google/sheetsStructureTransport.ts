import type { GoogleAuthProvider } from './googleAuthProvider';
import { googleApiRequest } from './googleApiRequest';
import { sheetRef } from './sheetsTransport';

/**
 * The Sheets v4 structure surface worksheet convergence needs
 * (`ARCHITECTURE.md §27.5.1` "Worksheet convergence (idempotent)"): list
 * worksheets, add / rename a worksheet, read + write a header row (RAW).
 * Separate from the export transport so the worker's dependency stays minimal.
 */

const API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

export interface Worksheet {
  readonly sheetId: number;
  readonly title: string;
}

export interface SheetsStructureTransport {
  listWorksheets(): Promise<Worksheet[]>;
  addWorksheet(title: string): Promise<number>;
  renameWorksheet(sheetId: number, title: string): Promise<void>;
  readHeaderRow(title: string): Promise<string[]>;
  writeHeaderRow(title: string, header: readonly string[]): Promise<void>;
}

export interface SheetsStructureTransportDeps {
  readonly spreadsheetId: string;
  readonly auth: GoogleAuthProvider;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}

export function createSheetsStructureTransport(
  deps: SheetsStructureTransportDeps,
): SheetsStructureTransport {
  const { auth, signal, fetchImpl } = deps;
  const id = encodeURIComponent(deps.spreadsheetId);
  const request = (method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> =>
    googleApiRequest({ auth, method, url: `${API_BASE}/${id}${path}`, body, signal, fetchImpl });

  return {
    async listWorksheets(): Promise<Worksheet[]> {
      const result = (await request(
        'GET',
        `?fields=${encodeURIComponent('sheets.properties(sheetId,title)')}`,
      )) as { sheets?: Array<{ properties?: { sheetId?: unknown; title?: unknown } }> };
      if (!Array.isArray(result.sheets)) {
        return [];
      }
      return result.sheets
        .map((s) => s.properties)
        .filter(
          (p): p is { sheetId: number; title: string } =>
            !!p && typeof p.sheetId === 'number' && typeof p.title === 'string',
        )
        .map((p) => ({ sheetId: p.sheetId, title: p.title }));
    },

    async addWorksheet(title: string): Promise<number> {
      const result = (await request('POST', ':batchUpdate', {
        requests: [{ addSheet: { properties: { title } } }],
      })) as { replies?: Array<{ addSheet?: { properties?: { sheetId?: unknown } } }> };
      const sheetId = result?.replies?.[0]?.addSheet?.properties?.sheetId;
      if (typeof sheetId !== 'number') {
        throw new Error('Sheets addSheet did not return a sheetId.');
      }
      return sheetId;
    },

    async renameWorksheet(sheetId: number, title: string): Promise<void> {
      await request('POST', ':batchUpdate', {
        requests: [
          {
            updateSheetProperties: {
              properties: { sheetId, title },
              fields: 'title',
            },
          },
        ],
      });
    },

    async readHeaderRow(title: string): Promise<string[]> {
      const range = encodeURIComponent(sheetRef(title, '1:1'));
      const result = (await request(
        'GET',
        `/values/${range}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`,
      )) as { values?: unknown[][] };
      const first = Array.isArray(result.values) ? result.values[0] : undefined;
      return Array.isArray(first) ? first.map((c) => (c == null ? '' : String(c))) : [];
    },

    async writeHeaderRow(title: string, header: readonly string[]): Promise<void> {
      await request('POST', `/values:batchUpdate`, {
        valueInputOption: 'RAW',
        data: [{ range: sheetRef(title, 'A1'), majorDimension: 'ROWS', values: [[...header]] }],
      });
    },
  };
}
