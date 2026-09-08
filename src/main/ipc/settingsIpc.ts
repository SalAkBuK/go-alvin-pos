import { IPC } from '../../shared/ipc';
import type { Logger } from '../app/logger';
import type { RendererEntry } from '../app/rendererEntry';
import type { ProductionDatabase } from '../database/database';
import { createSettingsService } from '../settings/settingsService';
import { appErrors } from '../shared/appError';
import { registerTrustedInvoke } from './trustedInvoke';

/**
 * Registers the settings IPC channels — Phase 2D.1 tax configuration and Phase
 * 2D.2 business & receipt configuration.
 *
 * Four channels, each narrow and purpose-specific: `settings:tax-get` /
 * `settings:tax-update` (payload is only a basis-point rate) and
 * `settings:business-get` / `settings:business-update` (payload is only the four
 * business/receipt fields). There is deliberately no generic `settings:set` /
 * arbitrary key/value surface. Sender validation and typed-error mapping live in
 * `registerTrustedInvoke`.
 */

export interface SettingsIpcContext {
  readonly logger: Logger;
  readonly getDatabase: () => ProductionDatabase | null;
  readonly appVersion: string;
  readonly rendererEntry?: RendererEntry;
}

export function registerSettingsIpcHandlers(context: SettingsIpcContext): void {
  const trusted = {
    logger: context.logger,
    ...(context.rendererEntry ? { rendererEntry: context.rendererEntry } : {}),
  };

  function settings() {
    const database = context.getDatabase();
    if (!database || database.closed) {
      throw appErrors.databaseUnavailable();
    }
    return createSettingsService({ db: database.connection, appVersion: context.appVersion });
  }

  registerTrustedInvoke(IPC.settingsTaxGet, trusted, () => settings().getTaxRate());

  registerTrustedInvoke(IPC.settingsTaxUpdate, trusted, (input) => settings().updateTaxRate(input));

  registerTrustedInvoke(IPC.settingsBusinessGet, trusted, () => settings().getBusinessConfig());

  registerTrustedInvoke(IPC.settingsBusinessUpdate, trusted, (input) =>
    settings().updateBusinessConfig(input),
  );
}
