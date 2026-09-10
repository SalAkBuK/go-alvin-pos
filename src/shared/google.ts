/**
 * Shared Google integration contract (Phase 2J.1 — OAuth onboarding).
 *
 * Pure TypeScript types + string constants, dependency-free, so the same
 * definitions bundle into the main process, the sandboxed preload, and the
 * renderer. These are the ONLY Google shapes that cross the IPC boundary.
 *
 * V1 authenticates with a desktop OAuth flow (`ARCHITECTURE.md §27`): the store
 * owner connects their own Google account, and the application creates/adopts
 * its own spreadsheet. NO OAuth token, authorization code, PKCE verifier, ID
 * token, refresh token, or developer OAuth client configuration ever appears in
 * any type here — those live only in the trusted main process
 * (`REQ-GSHEET-013`, `DATA_MODEL.md §21`). The renderer supplies at most an
 * enabled flag or an immutable Sale ID and receives sanitized status.
 */

/** Canonical worksheet tab names (`DATA_MODEL.md §26`). Fixed — not client-configurable. */
export const GOOGLE_SALES_SHEET = 'Sales';
export const GOOGLE_SALE_ITEMS_SHEET = 'Sale Items';

/** Working display name for the app-created spreadsheet (`ARCHITECTURE.md §27.5`). */
export const GOOGLE_SPREADSHEET_NAME = 'Go Phones POS Sales';

/**
 * The EXACT OAuth scopes V1 requests (`ARCHITECTURE.md §27.3`). `drive.file` is
 * the only business-data scope (per-file access to files this app creates);
 * `openid`/`email` are identity-for-display only. The broad `drive` and
 * `spreadsheets` scopes and `profile` are never requested.
 */
export const GOOGLE_OAUTH_SCOPES: readonly string[] = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/drive.file',
];

/** The three canonical Google setup states (`REQ-GSHEET-018`, `PRODUCT_SCOPE.md §22.8.2`). */
export type GoogleSetupState = 'DISCONNECTED' | 'SETUP_INCOMPLETE' | 'READY';

/**
 * Current Google integration state as shown in Settings. Never carries a secret.
 *
 * `connected` is DERIVED: an encrypted OAuth credential exists, decrypts,
 * structurally validates, holds a usable refresh token, and its wrapper
 * generation equals the locally active `google_credential_generation`.
 *
 * `setupState === 'READY'` requires `connected` AND a provisioned spreadsheet
 * whose canonical worksheets were verified.
 */
export interface GoogleConfig {
  readonly setupState: GoogleSetupState;
  /** A usable OAuth credential is present (derived). */
  readonly connected: boolean;
  /** The owner has turned export on. Network delivery also needs `setupState === 'READY'`. */
  readonly enabled: boolean;
  /** Convenience: `setupState === 'READY'`. The worker sends nothing unless this and `enabled`. */
  readonly ready: boolean;
  /** The connected account email — DISPLAY METADATA ONLY, never an identifier. `null` otherwise. */
  readonly accountEmail: string | null;
  /** The app-created/adopted spreadsheet's display name, once provisioned. */
  readonly spreadsheetName: string | null;
  /** True when a provisioned spreadsheet ID is stored and can be opened. */
  readonly canOpenSpreadsheet: boolean;
  /** ISO-8601 UTC of the last job the worker confirmed `EXPORTED`, else `null`. */
  readonly lastSuccessfulSyncAt: string | null;
  /** `false` when the OS secure-storage API is unavailable — the UI offers no plaintext path. */
  readonly secureStorageAvailable: boolean;
  /** `false` when this build has no developer OAuth client configuration — connection is unavailable. */
  readonly oauthClientConfigured: boolean;
  /** True when a connected credential keeps being rejected by Google and re-authorization is needed. */
  readonly needsReauthorization: boolean;
  /** A sanitized, human-readable reason provisioning has not completed, when `setupState === 'SETUP_INCOMPLETE'`. */
  readonly setupIncompleteReason: string | null;
  readonly queue: GoogleQueueSummary;
}

/** Local export-queue counts for the Settings summary (`SUPPORT_DIAGNOSTICS.md §30`). */
export interface GoogleQueueSummary {
  readonly pending: number;
  readonly exporting: number;
  readonly exported: number;
  readonly failed: number;
}

/** `google:set-enabled` payload — the only client-settable Google field. */
export interface GoogleSetEnabledInput {
  readonly enabled: boolean;
}

/** `google:retry-export` payload — the immutable Sale ID only. */
export interface RetryExportInput {
  readonly saleId: string;
}

/** Coarse, credential-free classification of a Google/network failure. */
export type GoogleErrorCategory =
  'AUTH' | 'PERMISSION' | 'NOT_FOUND' | 'RATE_LIMIT' | 'NETWORK' | 'TIMEOUT' | 'UNKNOWN';
