/**
 * Shared Google Sheets contract (Phase 2J — Export Worker).
 *
 * Pure TypeScript types + string constants, dependency-free, so the same
 * definitions bundle into the main process, the sandboxed preload, and the
 * renderer. These are the ONLY Google shapes that cross the IPC boundary.
 *
 * SCOPE: non-secret configuration for the one-way `POS → Google Sheets` export
 * (`PRODUCT_SCOPE.md §22`; `REQ-GSHEET-001`-`REQ-GSHEET-015`; `DATA_MODEL.md
 * §19`-`§26`). A service-account private key NEVER appears in any type here —
 * it is encrypted at rest and used only inside the trusted main process
 * (`REQ-GSHEET-013`). The renderer supplies at most a spreadsheet id / worksheet
 * names / an enabled flag / an immutable Sale ID.
 */

/** Default worksheet tab names (`DATA_MODEL.md §26`; task `§5`). */
export const GOOGLE_SALES_SHEET_DEFAULT = 'Sales';
export const GOOGLE_SALE_ITEMS_SHEET_DEFAULT = 'Sale Items';

/** Loose ceilings — fat-finger guards, not business figures. */
export const GOOGLE_SPREADSHEET_ID_MAX_LENGTH = 200;
export const GOOGLE_SHEET_NAME_MAX_LENGTH = 100;

/** The single OAuth scope V1 ever requests (`task §20`). */
export const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/**
 * Current Google Sheets configuration as shown in Settings. Never carries a
 * secret. `connected` is DERIVED (`task §4`): an encrypted credential file
 * exists, decrypts, structurally validates, and its wrapper generation equals
 * `settings.google_credential_generation`.
 */
export interface GoogleConfig {
  readonly enabled: boolean;
  readonly spreadsheetId: string | null;
  readonly salesSheetName: string;
  readonly saleItemsSheetName: string;
  /** ISO-8601 UTC of the last job the worker confirmed `EXPORTED`, else `null`. */
  readonly lastSuccessfulSyncAt: string | null;
  /** True when a usable service-account credential is present (derived). */
  readonly connected: boolean;
  /** The service account's `client_email` when connected — not a secret. `null` otherwise. */
  readonly serviceAccountEmail: string | null;
  /**
   * True only when every network precondition holds (`task §6`): enabled, a
   * valid spreadsheet id, valid sheet names, and `connected`. The worker makes
   * a network request ONLY when this is true.
   */
  readonly configured: boolean;
  /** `false` when the OS secure-storage API is unavailable — the UI must not offer plaintext (`task §8`). */
  readonly secureStorageAvailable: boolean;
  readonly queue: GoogleQueueSummary;
}

/** Local export-queue counts for the Settings summary (`SUPPORT_DIAGNOSTICS.md §30`). */
export interface GoogleQueueSummary {
  readonly pending: number;
  readonly exporting: number;
  readonly exported: number;
  readonly failed: number;
}

/**
 * `google:update-config` payload — the four non-secret fields only. The trusted
 * layer trims, extracts a spreadsheet id from a pasted URL, validates, and
 * rejects `enabled: true` unless a credential is connected and the spreadsheet
 * id is present.
 */
export interface UpdateGoogleConfigInput {
  readonly enabled: boolean;
  readonly spreadsheetId: string;
  readonly salesSheetName: string;
  readonly saleItemsSheetName: string;
}

/** Result of `google:connect` — the safe, non-secret identity only. */
export interface GoogleConnectResult {
  readonly connected: true;
  readonly serviceAccountEmail: string;
  readonly credentialGeneration: number;
}

/** `google:retry-export` payload — the immutable Sale ID only. */
export interface RetryExportInput {
  readonly saleId: string;
}

/** Coarse, credential-free classification of a Google/network failure (`task §22`). */
export type GoogleErrorCategory =
  'AUTH' | 'PERMISSION' | 'NOT_FOUND' | 'RATE_LIMIT' | 'NETWORK' | 'TIMEOUT' | 'UNKNOWN';
