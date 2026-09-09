import { readFile } from 'node:fs/promises';
import type Database from 'better-sqlite3';
import type { GoogleConfig, GoogleConnectResult } from '../../shared/google';
import { GOOGLE_SALES_SHEET_DEFAULT, GOOGLE_SALE_ITEMS_SHEET_DEFAULT } from '../../shared/google';
import { appendAuditEvent } from '../audit/appendAuditEvent';
import {
  readGoogleSettings,
  writeCredentialConnected,
  writeCredentialInactive,
  writeGoogleConfigSettings,
  writeGoogleDisabled,
} from '../settings/googleSettingsRepository';
import { readBusinessTimezone } from '../settings/settingsRepository';
import { validateGoogleConfigUpdate } from '../settings/googleSettingsValidation';
import { appErrors } from '../shared/appError';
import { queueSummary, manualRetry } from './exportJobRepository';
import type { ExportContext } from './exportWorker';
import type { GoogleAuthProvider } from './googleAuth';
import type {
  GoogleCredentialStore,
  LoadedCredential,
  ServiceAccountCredential,
} from './googleCredentialStore';

/**
 * User-facing Google configuration + credential lifecycle (`task §3`-`§7`;
 * `POS_WORKFLOWS.md §71`-`§72`; `REQ-GSHEET-013`; `REQ-AUDIT-002`).
 *
 * Every credential/config change is failure-safe: the encrypted file is written
 * with an atomic rename BEFORE the `BEGIN IMMEDIATE` that advances the
 * `google_credential_generation` setting and appends `GOOGLE_CONFIGURATION_CHANGED`.
 * A crash between the file write and the commit is repaired by
 * {@link reconcileAtStartup}. Disconnect flips SQLite authority off first, then
 * deletes the (now inert) file.
 *
 * The private key never leaves this layer: it is decrypted only to build the
 * JWT client, and no method returns it.
 */

const SPREADSHEET_ID = /^[A-Za-z0-9_-]{10,200}$/;
const CONFIG_SUBJECT_ID = 'google_sheets';

export interface GoogleConfigServiceDeps {
  readonly db: Database.Database;
  readonly appVersion: string;
  readonly credentialStore: GoogleCredentialStore;
  /** Opens a main-process file picker; resolves the chosen path or `null` if cancelled. */
  readonly pickCredentialFile: () => Promise<string | null>;
  /** Builds the JWT auth provider from a decrypted credential (a fake in tests). */
  readonly createAuthProvider: (credential: ServiceAccountCredential) => GoogleAuthProvider;
  readonly now?: () => string;
}

export interface GoogleConfigService {
  getConfig(): Promise<GoogleConfig>;
  updateConfig(raw: unknown): Promise<GoogleConfig>;
  connect(): Promise<GoogleConnectResult>;
  disconnect(): Promise<GoogleConfig>;
  retryExport(raw: unknown): Promise<GoogleConfig>;
  reconcileAtStartup(): Promise<void>;
  /** For the worker: the resolved export context, or `null` when not enabled-and-configured. */
  resolveExportContext(): Promise<ExportContext | null>;
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

export function createGoogleConfigService(deps: GoogleConfigServiceDeps): GoogleConfigService {
  const { db, appVersion, credentialStore, pickCredentialFile, createAuthProvider } = deps;
  const now = deps.now ?? ((): string => new Date().toISOString());

  let authCache: { generation: number; provider: GoogleAuthProvider } | null = null;

  async function loadActiveCredential(): Promise<LoadedCredential | null> {
    const settings = readGoogleSettings(db);
    if (!settings.credentialActive || settings.credentialGeneration === 0) {
      return null;
    }
    const loaded = await credentialStore.loadCredential();
    if (!loaded || loaded.generation !== settings.credentialGeneration) {
      return null;
    }
    return loaded;
  }

  function isSpreadsheetIdValid(id: string | null): id is string {
    return id !== null && SPREADSHEET_ID.test(id);
  }

  async function buildConfig(): Promise<GoogleConfig> {
    const settings = readGoogleSettings(db);
    const secureStorageAvailable = await credentialStore.isSecureStorageAvailable();
    const active = await loadActiveCredential();
    const connected = active !== null;
    const configured =
      settings.enabled &&
      isSpreadsheetIdValid(settings.spreadsheetId) &&
      settings.salesSheetName.trim() !== '' &&
      settings.saleItemsSheetName.trim() !== '' &&
      connected;
    return {
      enabled: settings.enabled,
      spreadsheetId: settings.spreadsheetId,
      salesSheetName: settings.salesSheetName,
      saleItemsSheetName: settings.saleItemsSheetName,
      lastSuccessfulSyncAt: settings.lastSuccessfulSyncAt,
      connected,
      serviceAccountEmail: active ? active.credential.clientEmail : null,
      configured,
      secureStorageAvailable,
      queue: queueSummary(db),
    };
  }

  function auditConfigChange(occurredAt: string, details: Record<string, unknown>): void {
    appendAuditEvent(db, {
      eventType: 'GOOGLE_CONFIGURATION_CHANGED',
      occurredAt,
      actorType: 'USER',
      outcome: 'SUCCESS',
      appVersion,
      subjectType: 'SETTING',
      subjectId: CONFIG_SUBJECT_ID,
      details,
    });
  }

  return {
    getConfig(): Promise<GoogleConfig> {
      return buildConfig();
    },

    async updateConfig(raw: unknown): Promise<GoogleConfig> {
      const fields = validateGoogleConfigUpdate(raw);
      const settings = readGoogleSettings(db);

      if (fields.enabled) {
        const active = await loadActiveCredential();
        if (!active || !SPREADSHEET_ID.test(fields.spreadsheetId)) {
          throw appErrors.googleNotConnected();
        }
      }

      const changed =
        fields.enabled !== settings.enabled ||
        fields.spreadsheetId !== (settings.spreadsheetId ?? '') ||
        fields.salesSheetName !== settings.salesSheetName ||
        fields.saleItemsSheetName !== settings.saleItemsSheetName;

      if (!changed) {
        return buildConfig();
      }

      const occurredAt = now();
      db.transaction(() => {
        writeGoogleConfigSettings(db, fields, occurredAt);
        auditConfigChange(occurredAt, {
          action: 'CONFIG_UPDATED',
          enabled: fields.enabled,
          spreadsheetIdConfigured: fields.spreadsheetId !== '',
          salesSheetName: fields.salesSheetName,
          saleItemsSheetName: fields.saleItemsSheetName,
        });
      }).immediate();

      return buildConfig();
    },

    async connect(): Promise<GoogleConnectResult> {
      if (!(await credentialStore.isSecureStorageAvailable())) {
        throw appErrors.googleSecureStorageUnavailable();
      }
      const filePath = await pickCredentialFile();
      if (filePath === null) {
        throw appErrors.validation('No file was selected.');
      }
      let rawJson: string;
      try {
        rawJson = await readFile(filePath, 'utf8');
      } catch {
        throw appErrors.googleCredentialInvalid('the file could not be read');
      }
      const credential = credentialStore.parseAndValidate(rawJson);

      const settings = readGoogleSettings(db);
      const nextGeneration = settings.credentialGeneration + 1;
      const isRotation = settings.credentialGeneration > 0;

      // (1) durable file replacement — BEFORE the DB commit point.
      await credentialStore.writeCredential(credential, nextGeneration);

      // (2) the commit point: advance the generation + audit, atomically.
      const occurredAt = now();
      db.transaction(() => {
        writeCredentialConnected(db, nextGeneration, occurredAt);
        auditConfigChange(occurredAt, {
          action: isRotation ? 'CREDENTIAL_ROTATED' : 'CREDENTIAL_CONNECTED',
          credentialGeneration: nextGeneration,
          serviceAccountEmail: credential.clientEmail,
        });
      }).immediate();

      authCache = null;
      return {
        connected: true,
        serviceAccountEmail: credential.clientEmail,
        credentialGeneration: nextGeneration,
      };
    },

    async disconnect(): Promise<GoogleConfig> {
      const occurredAt = now();
      // (1) commit point: SQLite authority off first — `connected` is now false
      // regardless of whether the file lingers. The monotonic generation is
      // kept; only the active flag flips (`task §4`).
      db.transaction(() => {
        writeGoogleDisabled(db, occurredAt);
        writeCredentialInactive(db, occurredAt);
        auditConfigChange(occurredAt, { action: 'CREDENTIAL_DISCONNECTED' });
      }).immediate();
      // (2) best-effort: remove the now-inert ciphertext file.
      await credentialStore.deleteCredential();
      authCache = null;
      return buildConfig();
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
        // No usable file. Nothing to reconcile — `connected` derives false. (A
        // credential the user expected but that is missing is surfaced by the
        // derived state + queue UI, not auto-cleared here.)
        return;
      }
      if (loaded.generation > settings.credentialGeneration) {
        // A connect/rotate whose file landed but whose commit did not — record
        // the missing audit as soon as the DB is safely writable (`REQ-AUDIT-004`,
        // `SUPPORT_DIAGNOSTICS.md §41`).
        const occurredAt = now();
        db.transaction(() => {
          writeCredentialConnected(db, loaded.generation, occurredAt);
          auditConfigChange(occurredAt, {
            action: 'CREDENTIAL_CONNECTED',
            credentialGeneration: loaded.generation,
            serviceAccountEmail: loaded.credential.clientEmail,
            reconciledAtStartup: true,
          });
        }).immediate();
        return;
      }
      if (
        loaded.generation < settings.credentialGeneration ||
        (loaded.generation === settings.credentialGeneration && !settings.credentialActive)
      ) {
        // Either a stale file from an interrupted rotation, or a committed
        // disconnect whose file cleanup did not finish. The committed SQLite
        // state wins; the file is inert. Best-effort delete, no audit.
        await credentialStore.deleteCredential();
      }
    },

    async resolveExportContext(): Promise<ExportContext | null> {
      const settings = readGoogleSettings(db);
      if (
        !settings.enabled ||
        !isSpreadsheetIdValid(settings.spreadsheetId) ||
        settings.salesSheetName.trim() === '' ||
        settings.saleItemsSheetName.trim() === ''
      ) {
        return null;
      }
      const active = await loadActiveCredential();
      if (!active) {
        return null;
      }
      if (authCache === null || authCache.generation !== active.generation) {
        authCache = {
          generation: active.generation,
          provider: createAuthProvider(active.credential),
        };
      }
      return {
        spreadsheetId: settings.spreadsheetId,
        salesSheetName: settings.salesSheetName,
        saleItemsSheetName: settings.saleItemsSheetName,
        businessTimezone: readBusinessTimezone(db),
        auth: authCache.provider,
      };
    },
  };
}

/** The safe defaults the Settings UI shows before anything is configured. */
export const GOOGLE_CONFIG_DEFAULTS = {
  salesSheetName: GOOGLE_SALES_SHEET_DEFAULT,
  saleItemsSheetName: GOOGLE_SALE_ITEMS_SHEET_DEFAULT,
} as const;
