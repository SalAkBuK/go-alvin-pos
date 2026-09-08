import { IPC } from '../../shared/ipc';
import type { Logger } from '../app/logger';
import type { RendererEntry } from '../app/rendererEntry';
import type { ProductionDatabase } from '../database/database';
import { createSettingsService } from '../settings/settingsService';
import { appErrors } from '../shared/appError';
import { registerTrustedInvoke } from './trustedInvoke';

/**
 * Registers the Phase 2D.1 tax-configuration IPC channels (task `§5`).
 *
 * Exactly two channels, both tax-specific: `settings:tax-get` (read) and
 * `settings:tax-update` (write, whose payload is only a basis-point rate).
 * There is deliberately no generic `settings:set` / arbitrary key/value
 * surface. Sender validation and typed-error mapping live in
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
}
