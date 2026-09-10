import type Database from 'better-sqlite3';
import { IPC } from '../../shared/ipc';
import type { Logger } from '../app/logger';
import type { RendererEntry } from '../app/rendererEntry';
import type { ProductionDatabase } from '../database/database';
import { createGoogleConfigService } from '../google/googleConfigService';
import type { GoogleConfigService } from '../google/googleConfigService';
import { appErrors } from '../shared/appError';
import { registerTrustedInvoke } from './trustedInvoke';

/**
 * Registers the Phase 2J.1 Google IPC channels (`ARCHITECTURE.md §9`, `§27`;
 * `REQ-GSHEET-011`-`REQ-GSHEET-019`; `POS_WORKFLOWS.md §71`-`§72`).
 *
 *  - `google:get-config`        — read-only config + derived state + queue counts.
 *  - `google:connect`           — run the desktop OAuth flow, then provisioning.
 *  - `google:retry-setup`       — re-run provisioning without re-authorizing.
 *  - `google:set-enabled`       — turn export on/off (the only client-settable field).
 *  - `google:open-spreadsheet`  — open the configured spreadsheet in the system browser.
 *  - `google:disconnect`        — local-first credential invalidation; works offline.
 *  - `google:retry-export`      — one `FAILED` job → `PENDING`.
 *
 * No credential material, token, or URL builder ever crosses back to the
 * renderer — the handlers return sanitized `GoogleConfig` / `void` only. This
 * module is Electron-free: the config-service factory dependencies (OAuth
 * client, `openExternal`) are injected by `register.ts`.
 */

export interface GoogleIpcContext {
  readonly logger: Logger;
  readonly getDatabase: () => ProductionDatabase | null;
  readonly appVersion: string;
  readonly rendererEntry?: RendererEntry;
  /** Builds the config service around the one production database connection. */
  readonly createService: (db: Database.Database, appVersion: string) => GoogleConfigService;
}

export function registerGoogleIpcHandlers(context: GoogleIpcContext): void {
  const trusted = {
    logger: context.logger,
    ...(context.rendererEntry ? { rendererEntry: context.rendererEntry } : {}),
  };

  function service(): GoogleConfigService {
    const db = context.getDatabase();
    if (!db || db.closed) {
      throw appErrors.databaseUnavailable();
    }
    return context.createService(db.connection, context.appVersion);
  }

  registerTrustedInvoke(IPC.googleGetConfig, trusted, () => service().getConfig());
  registerTrustedInvoke(IPC.googleConnect, trusted, () => service().connect());
  registerTrustedInvoke(IPC.googleRetrySetup, trusted, () => service().retrySetup());
  registerTrustedInvoke(IPC.googleSetEnabled, trusted, (input) => service().setEnabled(input));
  registerTrustedInvoke(IPC.googleOpenSpreadsheet, trusted, () => service().openSpreadsheet());
  registerTrustedInvoke(IPC.googleDisconnect, trusted, () => service().disconnect());
  registerTrustedInvoke(IPC.googleRetryExport, trusted, (input) => service().retryExport(input));
}

export { createGoogleConfigService };
