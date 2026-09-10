import type { GoogleAuthProvider } from './googleAuthProvider';
import { googleApiRequest } from './googleApiRequest';

/**
 * The minimum Google Drive v3 REST surface provisioning needs
 * (`ARCHITECTURE.md §27.5.1`): find app-created spreadsheets by app-private
 * `appProperties`, and create one in a single tagged request.
 *
 * Runs under the SAME `drive.file` OAuth scope as the Sheets calls — the Drive
 * API is enabled, not a scope widening. `files.list` under `drive.file` only
 * ever returns files this application created.
 */

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
export const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet';

/** Stable marker identifying a Go Phones POS sales spreadsheet, alongside the provisioning token. */
export const INTEGRATION_MARKER_KEY = 'goPhonesPosIntegration';
export const INTEGRATION_MARKER_VALUE = 'salesSpreadsheet';
export const PROVISIONING_TOKEN_KEY = 'goPhonesPosProvisioningToken';

export interface DriveTransport {
  /**
   * Drive `files.list` for a Google-Sheets-MIME, non-trashed file carrying BOTH
   * the integration marker and this provisioning token. Returns the matching
   * file IDs (minimal fields only).
   */
  findProvisionedSpreadsheets(provisioningToken: string): Promise<string[]>;
  /**
   * ONE Drive `files.create` request carrying name + Sheets MIME type +
   * app-private `appProperties` (marker + token) together. Returns the new file
   * ID. (Never Sheets `spreadsheets.create`; never a separate `files.update`.)
   */
  createProvisionedSpreadsheet(args: {
    readonly name: string;
    readonly provisioningToken: string;
  }): Promise<string>;
}

export interface DriveTransportDeps {
  readonly auth: GoogleAuthProvider;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}

/** Escape a value for the Drive `q` string literal syntax. */
function q(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function createDriveTransport(deps: DriveTransportDeps): DriveTransport {
  const { auth, signal, fetchImpl } = deps;

  return {
    async findProvisionedSpreadsheets(provisioningToken: string): Promise<string[]> {
      const query = [
        `mimeType='${SPREADSHEET_MIME}'`,
        'trashed=false',
        `appProperties has { key='${INTEGRATION_MARKER_KEY}' and value='${q(INTEGRATION_MARKER_VALUE)}' }`,
        `appProperties has { key='${PROVISIONING_TOKEN_KEY}' and value='${q(provisioningToken)}' }`,
      ].join(' and ');
      const url = `${DRIVE_FILES}?q=${encodeURIComponent(query)}&spaces=drive&fields=${encodeURIComponent(
        'files(id)',
      )}&pageSize=10&corpora=user`;
      const result = (await googleApiRequest({ auth, method: 'GET', url, signal, fetchImpl })) as {
        files?: Array<{ id?: unknown }>;
      };
      if (!Array.isArray(result.files)) {
        return [];
      }
      return result.files
        .map((f) => f.id)
        .filter((idValue): idValue is string => typeof idValue === 'string' && idValue !== '');
    },

    async createProvisionedSpreadsheet(args): Promise<string> {
      const url = `${DRIVE_FILES}?fields=id`;
      const result = (await googleApiRequest({
        auth,
        method: 'POST',
        url,
        signal,
        fetchImpl,
        body: {
          name: args.name,
          mimeType: SPREADSHEET_MIME,
          appProperties: {
            [INTEGRATION_MARKER_KEY]: INTEGRATION_MARKER_VALUE,
            [PROVISIONING_TOKEN_KEY]: args.provisioningToken,
          },
        },
      })) as { id?: unknown };
      if (typeof result?.id !== 'string' || result.id === '') {
        throw new Error('Drive files.create did not return a file id.');
      }
      return result.id;
    },
  };
}
