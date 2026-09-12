import { IPC } from '../../shared/ipc';
import type { UpdateInstallResult, UpdateServiceSnapshot } from '../../shared/update';
import type { Logger } from '../app/logger';
import type { RendererEntry } from '../app/rendererEntry';
import type { UpdateService } from '../updater/updateService';
import { registerTrustedInvoke } from './trustedInvoke';

/**
 * Registers the three Phase 2N-C update IPC channels.
 *
 * All three are read-only or self-gating from the renderer's perspective:
 * `get-status` and `check-now` never take an argument and never expose
 * anything beyond the normalized `UpdateServiceSnapshot`; `restart-and-install`
 * takes no argument either and returns only a narrow `UpdateInstallResult`
 * code — never a raw updater object, installer path, or feed URL
 * (`UpdateService.restartAndInstall()` already enforces this at the source).
 *
 * All three are served during exclusive maintenance too
 * (`allowDuringExclusiveMaintenance: true`, matching `maintenance:status`):
 * they have no database dependency, and `restart-and-install` specifically
 * NEEDS to reach `UpdateService.restartAndInstall()` even while a
 * RESTORE/MIGRATION owns the database lifecycle, so it can return the
 * specific `MIGRATION_IN_PROGRESS`/`RESTORE_IN_PROGRESS` denial code rather
 * than the generic `MAINTENANCE_IN_PROGRESS` the trusted-invoke layer would
 * otherwise substitute.
 */
export interface UpdatesIpcContext {
  readonly logger: Logger;
  readonly updateService: UpdateService;
  readonly rendererEntry?: RendererEntry;
}

export function registerUpdatesIpcHandlers(context: UpdatesIpcContext): void {
  const trusted = {
    logger: context.logger,
    ...(context.rendererEntry ? { rendererEntry: context.rendererEntry } : {}),
  };

  registerTrustedInvoke(
    IPC.updatesGetStatus,
    trusted,
    (): UpdateServiceSnapshot => context.updateService.getSnapshot(),
    { allowDuringExclusiveMaintenance: true },
  );

  registerTrustedInvoke(
    IPC.updatesCheckNow,
    trusted,
    (): Promise<UpdateServiceSnapshot> => {
      context.logger.info('application', 'update.manual-check.requested', {});
      return context.updateService.checkNow();
    },
    { allowDuringExclusiveMaintenance: true },
  );

  registerTrustedInvoke(
    IPC.updatesRestartAndInstall,
    trusted,
    (): UpdateInstallResult => context.updateService.restartAndInstall(),
    { allowDuringExclusiveMaintenance: true },
  );
}
