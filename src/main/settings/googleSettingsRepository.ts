import type Database from 'better-sqlite3';
import { getSettingValue } from './settingsRepository';

/**
 * The non-secret `google_*` settings rows — a DEDICATED path, separate from the
 * tax / business / printer repositories so the trusted settings surface is
 * never broadened into a generic key/value writer.
 *
 * Canon names these keys in `DATA_MODEL.md §19`-`§20`; the `settings` table
 * (migration `001`) already persists them. **No migration.**
 *
 * The OAuth refresh token is NEVER stored here (`DATA_MODEL.md §21`) — only
 * `google_credential_generation` / `google_credential_active` (crash-consistency
 * bookkeeping), `google_spreadsheet_id` (app-managed, written only after full
 * provisioning + worksheet verification), and `google_provisioning_token`
 * (a durable, non-secret idempotency token — `ARCHITECTURE.md §27.5.1`).
 */

const KEY_ENABLED = 'google_sheets_enabled';
const KEY_SPREADSHEET_ID = 'google_spreadsheet_id';
const KEY_LAST_SYNC = 'google_last_successful_sync_at';
const KEY_CREDENTIAL_GENERATION = 'google_credential_generation';
const KEY_CREDENTIAL_ACTIVE = 'google_credential_active';
const KEY_PROVISIONING_TOKEN = 'google_provisioning_token';
const KEY_SETUP_REASON = 'google_setup_incomplete_reason';
/**
 * Non-secret "a `files.create` request has been issued for this installation"
 * marker (`ARCHITECTURE.md §27.5.1` "Startup recovery boundary",
 * `DATA_MODEL.md §19`). Set durably BEFORE the Drive `files.create` is sent so a
 * crash immediately afterward still leaves enough evidence for bounded
 * lookup-only startup recovery. Absent ⇒ an ordinary `Connected / setup
 * incomplete` where startup performs NO Drive/Sheets work.
 */
const KEY_CREATE_ATTEMPTED = 'google_provisioning_create_attempted';
/**
 * Non-secret current-generation auth-health marker (`REQ-GSHEET-018`,
 * `SUPPORT_DIAGNOSTICS.md §30`, `POS_WORKFLOWS.md §46`). Holds the
 * `google_credential_generation` value for which a Google authentication failure
 * was last observed and not yet cleared by a later successful authenticated
 * operation. `needsReauthorization` is true only when this equals the active
 * generation — a historical AUTH failure under a superseded generation never
 * marks a newer, successfully-authorized credential.
 */
const KEY_AUTH_FAILURE_GENERATION = 'google_auth_failure_generation';

export interface GoogleSettingsRow {
  readonly enabled: boolean;
  /** Written only when provisioning fully completed (worksheets verified); `null` otherwise. */
  readonly spreadsheetId: string | null;
  /** ISO-8601 UTC, worker-written; `null` until the first successful export. */
  readonly lastSuccessfulSyncAt: string | null;
  /** Monotonic; `0` before the first connect. Never lowered by a disconnect. */
  readonly credentialGeneration: number;
  /** Whether the credential at `credentialGeneration` is currently active. */
  readonly credentialActive: boolean;
  /** Durable non-secret provisioning/idempotency token; `null` before the first setup attempt. */
  readonly provisioningToken: string | null;
  /** Sanitized reason provisioning has not completed; `null` when ready or disconnected. */
  readonly setupIncompleteReason: string | null;
  /** `true` once a Drive `files.create` has been issued for this installation (persists across restarts). */
  readonly provisioningCreateAttempted: boolean;
  /** Credential generation of the last unresolved Google auth failure, or `null`. */
  readonly authFailureGeneration: number | null;
}

function nonEmpty(value: string | null): string | null {
  return value !== null && value.trim() !== '' ? value.trim() : null;
}

export function readGoogleSettings(db: Database.Database): GoogleSettingsRow {
  const genRaw = getSettingValue(db, KEY_CREDENTIAL_GENERATION);
  const gen = genRaw !== null && /^\d+$/.test(genRaw.trim()) ? Number(genRaw.trim()) : 0;
  const authFailRaw = getSettingValue(db, KEY_AUTH_FAILURE_GENERATION);
  const authFailureGeneration =
    authFailRaw !== null && /^\d+$/.test(authFailRaw.trim()) ? Number(authFailRaw.trim()) : null;
  return {
    enabled: getSettingValue(db, KEY_ENABLED) === 'true',
    spreadsheetId: nonEmpty(getSettingValue(db, KEY_SPREADSHEET_ID)),
    lastSuccessfulSyncAt: nonEmpty(getSettingValue(db, KEY_LAST_SYNC)),
    credentialGeneration: gen,
    credentialActive: getSettingValue(db, KEY_CREDENTIAL_ACTIVE) === 'true' && gen > 0,
    provisioningToken: nonEmpty(getSettingValue(db, KEY_PROVISIONING_TOKEN)),
    setupIncompleteReason: nonEmpty(getSettingValue(db, KEY_SETUP_REASON)),
    provisioningCreateAttempted: getSettingValue(db, KEY_CREATE_ATTEMPTED) === 'true',
    authFailureGeneration:
      authFailureGeneration !== null && authFailureGeneration > 0 ? authFailureGeneration : null,
  };
}

const UPSERT = `INSERT INTO settings (key, value, updated_at)
   VALUES (@key, @value, @updatedAt)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;
const DELETE = `DELETE FROM settings WHERE key = @key`;

/** Turn `google_sheets_enabled` on/off. Opens no transaction — participates in the caller's. */
export function writeGoogleEnabled(
  db: Database.Database,
  enabled: boolean,
  updatedAt: string,
): void {
  db.prepare(UPSERT).run({ key: KEY_ENABLED, value: enabled ? 'true' : 'false', updatedAt });
}

/** Connect / re-authorize: advance the monotonic generation and mark it active. Opens no transaction. */
export function writeCredentialConnected(
  db: Database.Database,
  generation: number,
  updatedAt: string,
): void {
  const upsert = db.prepare(UPSERT);
  upsert.run({ key: KEY_CREDENTIAL_GENERATION, value: String(generation), updatedAt });
  upsert.run({ key: KEY_CREDENTIAL_ACTIVE, value: 'true', updatedAt });
}

/**
 * Disconnect: flip the active flag off (generation stays at its monotonic
 * value), turn export off, and clear the stored spreadsheet id — a reconnected
 * account must re-discover/re-verify its spreadsheet (`ARCHITECTURE.md §27.5`).
 * The provisioning token is deliberately RETAINED as installation-level
 * recovery metadata. Opens no transaction.
 */
export function writeCredentialDisconnected(db: Database.Database, updatedAt: string): void {
  const upsert = db.prepare(UPSERT);
  upsert.run({ key: KEY_CREDENTIAL_ACTIVE, value: 'false', updatedAt });
  upsert.run({ key: KEY_ENABLED, value: 'false', updatedAt });
  const del = db.prepare(DELETE);
  del.run({ key: KEY_SPREADSHEET_ID });
  del.run({ key: KEY_SETUP_REASON });
  // This connection's provisioning progress and any auth-health flag do not
  // carry to the next account. The durable provisioning token is retained (idempotency).
  del.run({ key: KEY_CREATE_ATTEMPTED });
  del.run({ key: KEY_AUTH_FAILURE_GENERATION });
}

/** Record / clear the sanitized "setup not finished" reason. Opens no transaction. */
export function writeSetupIncompleteReason(
  db: Database.Database,
  reason: string | null,
  updatedAt: string,
): void {
  if (reason === null || reason.trim() === '') {
    db.prepare(DELETE).run({ key: KEY_SETUP_REASON });
    return;
  }
  db.prepare(UPSERT).run({ key: KEY_SETUP_REASON, value: reason.trim().slice(0, 300), updatedAt });
}

/** Persist the durable provisioning token (generated once, reused on every retry). Opens no transaction. */
export function writeProvisioningToken(
  db: Database.Database,
  token: string,
  updatedAt: string,
): void {
  db.prepare(UPSERT).run({ key: KEY_PROVISIONING_TOKEN, value: token, updatedAt });
}

/** Persist the fully-provisioned spreadsheet id (only after worksheet verification). Opens no transaction. */
export function writeSpreadsheetId(db: Database.Database, id: string, updatedAt: string): void {
  db.prepare(UPSERT).run({ key: KEY_SPREADSHEET_ID, value: id, updatedAt });
}

/** Clear a stale/inaccessible spreadsheet id so provisioning recovery re-runs. Opens no transaction. */
export function clearSpreadsheetId(db: Database.Database): void {
  db.prepare(DELETE).run({ key: KEY_SPREADSHEET_ID });
}

/**
 * Record that a Drive `files.create` request has been (or is about to be) sent
 * for this installation. Called from the provisioning `onCreateAttempt` hook
 * BEFORE the network request, so a crash right afterward still allows bounded
 * lookup-only startup recovery (`ARCHITECTURE.md §27.5.1`). Opens no transaction.
 */
export function writeProvisioningCreateAttempted(db: Database.Database, updatedAt: string): void {
  db.prepare(UPSERT).run({ key: KEY_CREATE_ATTEMPTED, value: 'true', updatedAt });
}

/** Record the credential generation of an observed, unresolved Google auth failure. Opens no transaction. */
export function writeAuthFailureGeneration(
  db: Database.Database,
  generation: number,
  updatedAt: string,
): void {
  db.prepare(UPSERT).run({
    key: KEY_AUTH_FAILURE_GENERATION,
    value: String(generation),
    updatedAt,
  });
}

/** Clear the current-generation auth-failure marker after a successful authenticated operation. Opens no transaction. */
export function clearAuthFailureGeneration(db: Database.Database): void {
  db.prepare(DELETE).run({ key: KEY_AUTH_FAILURE_GENERATION });
}

/** Worker-only: record the instant of the most recent confirmed export. Opens its own write. */
export function writeLastSuccessfulSync(db: Database.Database, iso: string): void {
  db.prepare(UPSERT).run({ key: KEY_LAST_SYNC, value: iso, updatedAt: iso });
}
