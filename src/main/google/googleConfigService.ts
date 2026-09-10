import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { GoogleConfig, GoogleSetupState } from '../../shared/google';
import {
  GOOGLE_SALES_SHEET,
  GOOGLE_SALE_ITEMS_SHEET,
  GOOGLE_SPREADSHEET_NAME,
} from '../../shared/google';
import { appendAuditEvent } from '../audit/appendAuditEvent';
import {
  clearAuthFailureGeneration,
  clearSpreadsheetId,
  readGoogleSettings,
  writeAuthFailureGeneration,
  writeCredentialConnected,
  writeCredentialDisconnected,
  writeGoogleEnabled,
  writeProvisioningCreateAttempted,
  writeProvisioningToken,
  writeSetupIncompleteReason,
  writeSpreadsheetId,
} from '../settings/googleSettingsRepository';
import { readBusinessTimezone } from '../settings/settingsRepository';
import { appErrors } from '../shared/appError';
import { createDriveTransport } from './driveTransport';
import { manualRetry, queueSummary } from './exportJobRepository';
import type { ExportContext } from './exportWorker';
import { createOAuthAuthProvider } from './googleAuthProvider';
import type { GoogleAuthProvider } from './googleAuthProvider';
import type { OAuthClient } from './googleOAuthClient';
import type { GoogleCredentialStore, LoadedCredential } from './googleCredentialStore';
import { scrubExternalText } from './googleRedaction';
import { runOAuthFlow } from './oauthFlow';
import { createSheetsStructureTransport } from './sheetsStructureTransport';
import { provisionSpreadsheet } from './spreadsheetProvisioning';
import type { ProvisioningOutcome } from './spreadsheetProvisioning';

/**
 * User-facing Google configuration + credential lifecycle for the desktop OAuth
 * model (`ARCHITECTURE.md §27`; `POS_WORKFLOWS.md §71`-`§72`; `REQ-GSHEET-013`,
 * `REQ-GSHEET-016`-`REQ-GSHEET-019`).
 *
 * Crash consistency is unchanged from Phase 2J: the encrypted credential wrapper
 * is written with an atomic rename BEFORE the `BEGIN IMMEDIATE` that advances
 * `google_credential_generation` + marks it active + appends
 * `GOOGLE_CONFIGURATION_CHANGED`. A crash in between is repaired by
 * {@link reconcileAtStartup}. Disconnect flips SQLite authority off first, then
 * best-effort deletes the file and best-effort revokes remotely.
 *
 * Network access is NEVER part of a SQLite transaction. Refresh tokens,
 * authorization codes, PKCE verifiers, ID tokens, and raw OAuth responses never
 * leave this layer.
 */

const CONFIG_SUBJECT_ID = 'google_sheets';

type OAuthFlowRunner = typeof runOAuthFlow;
type SpreadsheetProvisioner = typeof provisionSpreadsheet;

/**
 * Machine-wide: at most one desktop OAuth authorization flow at a time, so a
 * `will-quit` cancel from any config-service instance aborts the in-flight one.
 */
let moduleActiveAuthAbort: AbortController | null = null;

export interface GoogleConfigServiceDeps {
  readonly db: Database.Database;
  readonly appVersion: string;
  readonly credentialStore: GoogleCredentialStore;
  /** `null` when this build has no developer OAuth client configuration. */
  readonly oauthClient: OAuthClient | null;
  /** Opens a URL in the external system browser (`shell.openExternal`). */
  readonly openExternal: (url: string) => Promise<void>;
  readonly now?: () => string;
  readonly logger?: {
    info: (event: string, fields?: Record<string, unknown>) => void;
    warn: (event: string, fields?: Record<string, unknown>) => void;
    error?: (event: string, fields?: Record<string, unknown>) => void;
  };
  // ── Injectable seams for tests ──────────────────────────────────────────
  readonly runOAuthFlow?: OAuthFlowRunner;
  readonly provisionSpreadsheet?: SpreadsheetProvisioner;
  readonly makeAuthProvider?: (refreshToken: string) => GoogleAuthProvider;
  readonly randomToken?: () => string;
  readonly oauthTimeoutMs?: number;
}

export interface GoogleConfigService {
  getConfig(): Promise<GoogleConfig>;
  connect(): Promise<GoogleConfig>;
  retrySetup(): Promise<GoogleConfig>;
  setEnabled(raw: unknown): Promise<GoogleConfig>;
  disconnect(): Promise<GoogleConfig>;
  openSpreadsheet(): Promise<void>;
  retryExport(raw: unknown): Promise<GoogleConfig>;
  reconcileAtStartup(): Promise<void>;
  /**
   * Bounded automatic startup recovery for a `Connected / setup incomplete`
   * account (`ARCHITECTURE.md §27.5.1`): runs a Drive `files.list` LOOKUP ONLY,
   * and only when a `files.create` was already attempted for this installation.
   * An ordinary setup-incomplete state (no create ever attempted) performs zero
   * Drive/Sheets work here.
   */
  ensureProvisionedIfNeeded(): Promise<void>;
  /** For the worker: the resolved export context, or `null` when not ready-and-enabled. */
  resolveExportContext(): Promise<ExportContext | null>;
  /**
   * Worker callback: record the current active credential generation's Google
   * auth-health after a definite export outcome. `'auth-failure'` marks the
   * generation as needing re-authorization; `'ok'` clears a stale marker for the
   * same generation. A report for a superseded generation is ignored.
   */
  noteExportAuthResult(credentialGeneration: number, result: 'auth-failure' | 'ok'): void;
  /**
   * Worker callback (`REQ-GSHEET-020`): a definite structural failure of the
   * configured spreadsheet target was established during export. Clears
   * `google_spreadsheet_id`, transitions `READY → SETUP_INCOMPLETE` with a
   * sanitized reason, keeps the OAuth connection, and audits as a SYSTEM action.
   * No-op if the configured id already changed (a concurrent `Retry Setup`).
   */
  invalidateSpreadsheetTarget(
    expectedSpreadsheetId: string,
    kind: 'NOT_FOUND' | 'PERMISSION',
  ): void;
  /** Abort a pending `connect()` (app shutdown / cancel). Synchronous, safe in `will-quit`. */
  cancelPendingAuthorization(): void;
}

function validateSaleId(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw appErrors.validation('The retry request must be an object.');
  }
  const value = (raw as Record<string, unknown>)['saleId'];
  const extra = Object.keys(raw as Record<string, unknown>).filter((k) => k !== 'saleId');
  if (extra.length > 0) {
    throw appErrors.validation(`Unexpected field(s): ${extra.join(', ')}.`);
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw appErrors.validation('A sale must be selected to retry its export.');
  }
  return value.trim();
}

function validateEnabled(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw appErrors.validation('The request must be an object.');
  }
  const record = raw as Record<string, unknown>;
  const extra = Object.keys(record).filter((k) => k !== 'enabled');
  if (extra.length > 0) {
    throw appErrors.validation(`Unexpected field(s): ${extra.join(', ')}.`);
  }
  if (typeof record['enabled'] !== 'boolean') {
    throw appErrors.validation('The enabled flag must be true or false.');
  }
  return record['enabled'];
}

export function createGoogleConfigService(deps: GoogleConfigServiceDeps): GoogleConfigService {
  const { db, appVersion, credentialStore, oauthClient, openExternal } = deps;
  const now = deps.now ?? ((): string => new Date().toISOString());
  const doRunOAuthFlow = deps.runOAuthFlow ?? runOAuthFlow;
  const doProvision = deps.provisionSpreadsheet ?? provisionSpreadsheet;
  const makeAuthProvider =
    deps.makeAuthProvider ??
    ((refreshToken: string): GoogleAuthProvider =>
      createOAuthAuthProvider({ oauthClient: mustOAuthClient(), refreshToken }));
  const randomToken = deps.randomToken ?? ((): string => `gpp-${randomBytes(24).toString('hex')}`);
  const log = deps.logger;

  let authCache: { generation: number; provider: GoogleAuthProvider } | null = null;

  function mustOAuthClient(): OAuthClient {
    if (!oauthClient) {
      throw appErrors.googleOAuthNotConfigured();
    }
    return oauthClient;
  }

  async function loadActiveCredential(): Promise<LoadedCredential | null> {
    const settings = readGoogleSettings(db);
    if (!settings.credentialActive || settings.credentialGeneration === 0) {
      return null;
    }
    const loaded = await credentialStore.loadCredential();
    if (
      !loaded ||
      loaded.generation !== settings.credentialGeneration ||
      loaded.credential.refreshToken.trim() === ''
    ) {
      return null;
    }
    return loaded;
  }

  function auditConfigChange(
    occurredAt: string,
    details: Record<string, unknown>,
    actorType: 'USER' | 'SYSTEM' = 'USER',
  ): void {
    appendAuditEvent(db, {
      eventType: 'GOOGLE_CONFIGURATION_CHANGED',
      occurredAt,
      actorType,
      outcome: 'SUCCESS',
      appVersion,
      subjectType: 'SETTING',
      subjectId: CONFIG_SUBJECT_ID,
      details,
    });
  }

  async function buildConfig(): Promise<GoogleConfig> {
    const settings = readGoogleSettings(db);
    const secureStorageAvailable = await credentialStore.isSecureStorageAvailable();
    const active = await loadActiveCredential();
    const connected = active !== null;
    const spreadsheetConfigured = settings.spreadsheetId !== null;
    const setupState: GoogleSetupState = !connected
      ? 'DISCONNECTED'
      : spreadsheetConfigured
        ? 'READY'
        : 'SETUP_INCOMPLETE';
    const ready = setupState === 'READY';
    return {
      setupState,
      connected,
      enabled: settings.enabled,
      ready,
      accountEmail: active ? active.credential.email : null,
      spreadsheetName: spreadsheetConfigured ? GOOGLE_SPREADSHEET_NAME : null,
      canOpenSpreadsheet: spreadsheetConfigured,
      lastSuccessfulSyncAt: settings.lastSuccessfulSyncAt,
      secureStorageAvailable,
      oauthClientConfigured: oauthClient !== null,
      // Current-active-credential-generation-aware (`REQ-GSHEET-018`,
      // `SUPPORT_DIAGNOSTICS.md §30`): the marker holds the generation of the last
      // unresolved auth failure; a historical export-job `AUTH:` error from a
      // superseded generation is NOT consulted.
      needsReauthorization:
        connected &&
        settings.authFailureGeneration !== null &&
        settings.authFailureGeneration === settings.credentialGeneration,
      setupIncompleteReason:
        setupState === 'SETUP_INCOMPLETE'
          ? (settings.setupIncompleteReason ?? 'Sales spreadsheet setup is not finished.')
          : null,
      queue: queueSummary(db),
    };
  }

  /** Generate (once) or load the durable provisioning token. */
  function provisioningToken(): string {
    const existing = readGoogleSettings(db).provisioningToken;
    if (existing) {
      return existing;
    }
    const token = randomToken();
    db.transaction(() => writeProvisioningToken(db, token, now())).immediate();
    return token;
  }

  /**
   * Run the locked provisioning mechanism and commit the outcome.
   *
   * `allowCreate` distinguishes an owner-initiated run (`Connect`, `Retry
   * Setup` — may issue one tagged `files.create`) from bounded automatic startup
   * recovery (`allowCreate: false` — lookup only, never creates or mutates a
   * worksheet). `actorType` keeps a background startup adoption from falsely
   * claiming a USER action (`ARCHITECTURE.md §27.5.1`).
   */
  async function ensureProvisioned(
    refreshToken: string,
    opts: { allowCreate: boolean; actorType: 'USER' | 'SYSTEM' },
  ): Promise<ProvisioningOutcome> {
    const token = provisioningToken();
    const auth = makeAuthProvider(refreshToken);
    const drive = createDriveTransport({ auth });
    const result = await doProvision({
      drive,
      makeStructureTransport: (spreadsheetId: string) =>
        createSheetsStructureTransport({ spreadsheetId, auth }),
      provisioningToken: token,
      spreadsheetName: GOOGLE_SPREADSHEET_NAME,
      allowCreate: opts.allowCreate,
      // Durable BEFORE the network request: a crash right after `files.create`
      // still leaves lookup-only startup-recovery evidence (`§27.5.1`).
      onCreateAttempt: () => {
        db.transaction(() => writeProvisioningCreateAttempted(db, now())).immediate();
      },
      ...(log ? { logger: log } : {}),
    });

    const occurredAt = now();
    if (result.outcome === 'ready') {
      const activeGeneration = readGoogleSettings(db).credentialGeneration;
      db.transaction(() => {
        writeSpreadsheetId(db, result.spreadsheetId, occurredAt);
        writeSetupIncompleteReason(db, null, occurredAt);
        // A completed provisioning is a successful authenticated Google
        // operation for the current generation — clear a stale auth-health flag.
        if (readGoogleSettings(db).authFailureGeneration === activeGeneration) {
          clearAuthFailureGeneration(db);
        }
        auditConfigChange(occurredAt, { action: 'SPREADSHEET_CONFIGURED' }, opts.actorType);
      }).immediate();
    } else {
      db.transaction(() => {
        clearSpreadsheetId(db);
        writeSetupIncompleteReason(db, scrubExternalText(result.reason).slice(0, 300), occurredAt);
      }).immediate();
      log?.warn('google.spreadsheet.setup_failed', {});
    }
    return result;
  }

  return {
    getConfig(): Promise<GoogleConfig> {
      return buildConfig();
    },

    async connect(): Promise<GoogleConfig> {
      mustOAuthClient();
      if (!(await credentialStore.isSecureStorageAvailable())) {
        throw appErrors.googleSecureStorageUnavailable();
      }
      if (moduleActiveAuthAbort) {
        throw appErrors.googleAuthorizationInProgress();
      }
      const abort = new AbortController();
      moduleActiveAuthAbort = abort;
      let authResult;
      try {
        authResult = await doRunOAuthFlow({
          oauthClient: mustOAuthClient(),
          openExternal,
          signal: abort.signal,
          ...(deps.oauthTimeoutMs !== undefined ? { timeoutMs: deps.oauthTimeoutMs } : {}),
          ...(log ? { logger: log } : {}),
        });
      } finally {
        moduleActiveAuthAbort = null;
      }

      const settings = readGoogleSettings(db);
      const nextGeneration = settings.credentialGeneration + 1;
      const isReauth = settings.credentialGeneration > 0;

      // (1) durable file replacement — BEFORE the DB commit point.
      await credentialStore.writeCredential(
        { refreshToken: authResult.refreshToken, sub: authResult.sub, email: authResult.email },
        nextGeneration,
      );

      // (2) the commit point: advance the generation + audit, atomically.
      const occurredAt = now();
      db.transaction(() => {
        writeCredentialConnected(db, nextGeneration, occurredAt);
        // A fresh authorization proves this new generation's credential works;
        // any prior auth-failure flag belonged to a superseded generation.
        clearAuthFailureGeneration(db);
        auditConfigChange(occurredAt, {
          action: isReauth ? 'ACCOUNT_REAUTHORIZED' : 'ACCOUNT_CONNECTED',
          credentialGeneration: nextGeneration,
        });
      }).immediate();
      authCache = null;

      // (3) provisioning — outside any transaction, best effort. A failure keeps
      // the account connected (SETUP_INCOMPLETE); the owner gets Retry Setup.
      // Owner-initiated ⇒ a zero-match lookup MAY issue the single tagged create.
      const provisioned = await ensureProvisioned(authResult.refreshToken, {
        allowCreate: true,
        actorType: 'USER',
      });
      if (provisioned.outcome === 'ready') {
        const enableAt = now();
        db.transaction(() => {
          writeGoogleEnabled(db, true, enableAt);
          auditConfigChange(enableAt, { action: 'EXPORT_ENABLED' });
        }).immediate();
      }

      return buildConfig();
    },

    async retrySetup(): Promise<GoogleConfig> {
      const active = await loadActiveCredential();
      if (!active) {
        throw appErrors.googleNotConnected();
      }
      // Explicit owner action: full canonical flow, lookup-before-create, and a
      // single tagged `files.create` allowed on a zero-match result.
      await ensureProvisioned(active.credential.refreshToken, {
        allowCreate: true,
        actorType: 'USER',
      });
      return buildConfig();
    },

    async ensureProvisionedIfNeeded(): Promise<void> {
      const settings = readGoogleSettings(db);
      if (settings.spreadsheetId !== null) {
        return;
      }
      // Ordinary `Connected / setup incomplete` — provisioning failed at/before
      // the Drive lookup and no `files.create` was ever issued: startup performs
      // ZERO Drive/Sheets work. Merely launching the POS must not mutate the
      // owner's Google account. Recovery is only through explicit Retry Setup.
      if (!settings.provisioningCreateAttempted) {
        return;
      }
      const active = await loadActiveCredential();
      if (!active) {
        return;
      }
      try {
        // A `files.create` was already attempted (a spreadsheet may exist
        // remotely) ⇒ bounded LOOKUP-ONLY recovery: one `files.list`; adopt an
        // exact single match, otherwise stay `Connected / setup incomplete`.
        // Never acts as if the owner pressed Retry Setup.
        await ensureProvisioned(active.credential.refreshToken, {
          allowCreate: false,
          actorType: 'SYSTEM',
        });
      } catch (error) {
        log?.warn('google.spreadsheet.setup_failed', {
          error: error instanceof Error ? scrubExternalText(error.message) : 'unknown',
        });
      }
    },

    async setEnabled(raw: unknown): Promise<GoogleConfig> {
      const enabled = validateEnabled(raw);
      const settings = readGoogleSettings(db);
      if (enabled) {
        const active = await loadActiveCredential();
        if (!active) {
          throw appErrors.googleNotConnected();
        }
        if (settings.spreadsheetId === null) {
          throw appErrors.googleSpreadsheetNotReady();
        }
      }
      if (settings.enabled === enabled) {
        return buildConfig();
      }
      const occurredAt = now();
      db.transaction(() => {
        writeGoogleEnabled(db, enabled, occurredAt);
        auditConfigChange(occurredAt, { action: enabled ? 'EXPORT_ENABLED' : 'EXPORT_DISABLED' });
      }).immediate();
      return buildConfig();
    },

    async disconnect(): Promise<GoogleConfig> {
      // Load the credential BEFORE invalidating it locally, so a best-effort
      // remote revoke can still run afterward.
      const loaded = await credentialStore.loadCredential().catch(() => null);

      // (1) commit point: SQLite authority off first — export disabled, active
      // flag off, stored spreadsheet id cleared (re-validate on reconnect). The
      // monotonic generation and the provisioning token are kept.
      const occurredAt = now();
      db.transaction(() => {
        writeCredentialDisconnected(db, occurredAt);
        auditConfigChange(occurredAt, { action: 'ACCOUNT_DISCONNECTED' });
      }).immediate();
      authCache = null;

      // (2) best-effort: remove the now-inert ciphertext file.
      await credentialStore.deleteCredential();

      // (3) optional/best-effort: remote token revocation. NEVER required.
      if (oauthClient && loaded?.credential.refreshToken) {
        try {
          await oauthClient.revoke(loaded.credential.refreshToken);
        } catch {
          /* a Google outage / revocation failure must not fail local disconnect */
        }
      }
      log?.info('google.account.disconnected', {});
      return buildConfig();
    },

    async openSpreadsheet(): Promise<void> {
      const settings = readGoogleSettings(db);
      if (settings.spreadsheetId === null) {
        throw appErrors.googleSpreadsheetNotReady();
      }
      const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(
        settings.spreadsheetId,
      )}/edit`;
      await openExternal(url);
    },

    async retryExport(raw: unknown): Promise<GoogleConfig> {
      const saleId = validateSaleId(raw);
      manualRetry(db, { saleId, now: now() });
      return buildConfig();
    },

    async reconcileAtStartup(): Promise<void> {
      const settings = readGoogleSettings(db);
      const loaded = credentialStore.fileExists() ? await credentialStore.loadCredential() : null;

      if (!loaded) {
        return;
      }
      if (loaded.generation > settings.credentialGeneration) {
        // A connect/re-auth whose file landed but whose commit did not.
        const occurredAt = now();
        db.transaction(() => {
          writeCredentialConnected(db, loaded.generation, occurredAt);
          auditConfigChange(occurredAt, {
            action: 'ACCOUNT_CONNECTED',
            credentialGeneration: loaded.generation,
            reconciledAtStartup: true,
          });
        }).immediate();
        return;
      }
      if (
        loaded.generation < settings.credentialGeneration ||
        (loaded.generation === settings.credentialGeneration && !settings.credentialActive)
      ) {
        // Stale file from an interrupted re-auth, or a committed disconnect whose
        // file cleanup did not finish. The committed SQLite state wins.
        await credentialStore.deleteCredential();
      }
    },

    async resolveExportContext(): Promise<ExportContext | null> {
      const settings = readGoogleSettings(db);
      if (!settings.enabled || settings.spreadsheetId === null) {
        return null;
      }
      const active = await loadActiveCredential();
      if (!active) {
        return null;
      }
      if (authCache === null || authCache.generation !== active.generation) {
        authCache = {
          generation: active.generation,
          provider: makeAuthProvider(active.credential.refreshToken),
        };
      }
      return {
        spreadsheetId: settings.spreadsheetId,
        salesSheetName: GOOGLE_SALES_SHEET,
        saleItemsSheetName: GOOGLE_SALE_ITEMS_SHEET,
        businessTimezone: readBusinessTimezone(db),
        auth: authCache.provider,
        credentialGeneration: active.generation,
      };
    },

    noteExportAuthResult(credentialGeneration: number, result: 'auth-failure' | 'ok'): void {
      const settings = readGoogleSettings(db);
      // Ignore a report tied to a superseded / inactive generation — it says
      // nothing about the current active credential.
      if (!settings.credentialActive || settings.credentialGeneration !== credentialGeneration) {
        return;
      }
      if (result === 'auth-failure') {
        if (settings.authFailureGeneration === credentialGeneration) {
          return;
        }
        db.transaction(() =>
          writeAuthFailureGeneration(db, credentialGeneration, now()),
        ).immediate();
        log?.warn('google.auth.needs_reauthorization', { credentialGeneration });
      } else {
        if (settings.authFailureGeneration !== credentialGeneration) {
          return;
        }
        db.transaction(() => clearAuthFailureGeneration(db)).immediate();
        log?.info('google.auth.recovered', { credentialGeneration });
      }
    },

    invalidateSpreadsheetTarget(
      expectedSpreadsheetId: string,
      kind: 'NOT_FOUND' | 'PERMISSION',
    ): void {
      const settings = readGoogleSettings(db);
      if (settings.spreadsheetId === null || settings.spreadsheetId !== expectedSpreadsheetId) {
        // Already cleared, or a concurrent Retry Setup adopted a new target.
        return;
      }
      const reason =
        kind === 'NOT_FOUND'
          ? 'The Google sales spreadsheet could not be found — it may have been deleted. Use Retry Setup to reconnect or recreate it.'
          : 'Go Phones POS no longer has access to the Google sales spreadsheet. Use Retry Setup to reconnect it.';
      const occurredAt = now();
      db.transaction(() => {
        clearSpreadsheetId(db);
        writeSetupIncompleteReason(db, reason, occurredAt);
        auditConfigChange(occurredAt, { action: 'SPREADSHEET_TARGET_INVALIDATED', kind }, 'SYSTEM');
      }).immediate();
      authCache = null;
      log?.warn('google.spreadsheet.target_invalidated', { kind });
    },

    cancelPendingAuthorization(): void {
      moduleActiveAuthAbort?.abort();
    },
  };
}
