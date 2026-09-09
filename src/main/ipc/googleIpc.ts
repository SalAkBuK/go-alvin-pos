import { IPC } from '../../shared/ipc';
import type { Logger } from '../app/logger';
import type { RendererEntry } from '../app/rendererEntry';
import type { ProductionDatabase } from '../database/database';
import { createGoogleConfigService } from '../google/googleConfigService';
import type {
  GoogleCredentialStore,
  ServiceAccountCredential,
} from '../google/googleCredentialStore';
import type { GoogleAuthProvider } from '../google/googleAuth';
import { appErrors } from '../shared/appError';
import { registerTrustedInvoke } from './trustedInvoke';

/**
 * Registers the Phase 2J Google Sheets IPC channels (`ARCHITECTURE.md §9`,
 * `§27`; `REQ-GSHEET-011`-`REQ-GSHEET-013`; `POS_WORKFLOWS.md §71`-`§72`).
 *
 *  - `google:get-config`    — read-only config + derived state + queue counts.
 *  - `google:update-config` — persist the four non-secret fields + audit.
 *  - `google:connect`       — file-picker → validate → encrypt → persist + audit.
 *  - `google:disconnect`    — authority off in SQLite, then delete the file.
 *  - `google:retry-export`  — one `FAILED` job → `PENDING`.
 *
 * This module is Electron- and `google-auth-library`-free: the credential store,
 * the file picker, and the JWT provider are injected by the caller
 * (`register.ts`), so unit tests exercise it with fakes and only mock `electron`
 * for `ipcMain`.
 */

export interface GoogleIpcContext {
  readonly logger: Logger;
  readonly getDatabase: () => ProductionDatabase | null;
  readonly appVersion: string;
  readonly rendererEntry?: RendererEntry;
  readonly credentialStore: GoogleCredentialStore;
  /** Opens a main-process file picker; resolves the chosen JSON path or `null`. */
  readonly pickCredentialFile: () => Promise<string | null>;
  readonly createAuthProvider: (credential: ServiceAccountCredential) => GoogleAuthProvider;
}

export function registerGoogleIpcHandlers(context: GoogleIpcContext): void {
  const trusted = {
    logger: context.logger,
    ...(context.rendererEntry ? { rendererEntry: context.rendererEntry } : {}),
  };

  function service() {
    const db = context.getDatabase();
    if (!db || db.closed) {
      throw appErrors.databaseUnavailable();
    }
    return createGoogleConfigService({
      db: db.connection,
      appVersion: context.appVersion,
      credentialStore: context.credentialStore,
      pickCredentialFile: context.pickCredentialFile,
      createAuthProvider: context.createAuthProvider,
    });
  }

  registerTrustedInvoke(IPC.googleGetConfig, trusted, () => service().getConfig());
  registerTrustedInvoke(IPC.googleUpdateConfig, trusted, (input) => service().updateConfig(input));
  registerTrustedInvoke(IPC.googleConnect, trusted, () => service().connect());
  registerTrustedInvoke(IPC.googleDisconnect, trusted, () => service().disconnect());
  registerTrustedInvoke(IPC.googleRetryExport, trusted, (input) => service().retryExport(input));
}
