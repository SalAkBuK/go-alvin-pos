import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../app/logger';
import type { MaintenanceCoordinator } from '../maintenance/maintenanceCoordinator';
import type { UpdateService } from './updateService';
import {
  UPDATE_INSTALL_E2E_PRODUCT_NAME,
  UPDATE_INSTALL_E2E_RUNTIME_ENV,
  updateInstallE2eRuntimeAllowed,
} from './updateInstallE2eConfig';

export const UPDATE_INSTALL_E2E_TRIGGER_FILE = 'update-install-e2e.trigger';
const TRIGGER_OWNER_ID = 2_147_483_647;
const POLL_INTERVAL_MS = 200;
const DEFERRAL_OBSERVATION_MS = 1_000;
const TRIGGER_TIMEOUT_MS = 5 * 60 * 1_000;

export interface UpdateInstallE2eTrigger {
  stopSync(): void;
}

export interface UpdateInstallE2eTriggerDeps {
  readonly buildEnabled: boolean;
  readonly isPackaged: boolean;
  readonly appName: string;
  readonly userData: string;
  readonly localAppData: string | undefined;
  readonly diagnosticsRoot: string;
  readonly logger: Logger;
  readonly maintenanceCoordinator: MaintenanceCoordinator;
  readonly updateService: UpdateService;
  readonly runtimeValue?: string;
  readonly now?: () => number;
}

/**
 * Compile-time E2E-only, one-shot install action. It accepts no arguments from
 * a renderer or marker file: the fixed empty marker merely arms the predefined
 * CHECKOUT_ACTIVE deferral -> clear -> trusted restartAndInstall sequence.
 */
export function installUpdateInstallE2eTrigger(
  deps: UpdateInstallE2eTriggerDeps,
): UpdateInstallE2eTrigger {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let triggered = false;
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const marker = join(deps.diagnosticsRoot, UPDATE_INSTALL_E2E_TRIGGER_FILE);

  const allowed = updateInstallE2eRuntimeAllowed({
    buildEnabled: deps.buildEnabled,
    isPackaged: deps.isPackaged,
    appName: deps.appName,
    runtimeValue: deps.runtimeValue ?? process.env[UPDATE_INSTALL_E2E_RUNTIME_ENV],
    userData: deps.userData,
    localAppData: deps.localAppData,
  });
  if (!allowed) {
    return { stopSync: () => {} };
  }

  function stopSync(): void {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function fail(failureCode: string): void {
    deps.logger.warn('application', 'update.install-e2e.failed', { failureCode });
    stopSync();
  }

  function performInstallSequence(): void {
    const draft = deps.maintenanceCoordinator.noteDraftCartActivity(true, TRIGGER_OWNER_ID);
    const maintenanceState = deps.maintenanceCoordinator.status();
    const deferred = deps.updateService.restartAndInstall();
    deps.logger.info('application', 'update.install-e2e.checkout-deferral', {
      draftAccepted: draft.accepted,
      maintenanceState,
      resultCode: deferred.code,
    });
    if (
      !draft.accepted ||
      maintenanceState !== 'CHECKOUT_ACTIVE' ||
      deferred.code !== 'CHECKOUT_ACTIVE'
    ) {
      fail('UPDATE_INSTALL_E2E_DEFERRAL_FAILED');
      return;
    }

    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      if (
        deps.maintenanceCoordinator.status() !== 'CHECKOUT_ACTIVE' ||
        deps.updateService.getSnapshot().state !== 'READY'
      ) {
        fail('UPDATE_INSTALL_E2E_READY_NOT_PRESERVED');
        return;
      }
      deps.logger.info('application', 'update.install-e2e.deferral-confirmed', {
        appName: UPDATE_INSTALL_E2E_PRODUCT_NAME,
      });
      deps.maintenanceCoordinator.noteDraftCartActivity(false, TRIGGER_OWNER_ID);
      if (deps.maintenanceCoordinator.status() !== 'SAFE') {
        fail('UPDATE_INSTALL_E2E_CHECKOUT_CLEAR_FAILED');
        return;
      }
      deps.logger.info('application', 'update.install-e2e.checkout-cleared', {});
      const result = deps.updateService.restartAndInstall();
      deps.logger.info('application', 'update.install-e2e.install-result', {
        resultCode: result.code,
      });
      if (result.code !== 'INSTALL_ACCEPTED') {
        fail('UPDATE_INSTALL_E2E_INSTALL_NOT_ACCEPTED');
        return;
      }
      stopSync();
    }, DEFERRAL_OBSERVATION_MS);
  }

  function poll(): void {
    timer = null;
    if (stopped) return;
    if (now() - startedAt >= TRIGGER_TIMEOUT_MS) {
      fail('UPDATE_INSTALL_E2E_TRIGGER_TIMEOUT');
      return;
    }
    try {
      if (!triggered && existsSync(marker)) {
        const info = statSync(marker);
        if (!info.isFile() || info.size !== 0) {
          fail('UPDATE_INSTALL_E2E_TRIGGER_INVALID');
          return;
        }
        if (deps.updateService.getSnapshot().state === 'READY') {
          rmSync(marker, { force: true });
          triggered = true;
          performInstallSequence();
          return;
        }
      }
    } catch {
      fail('UPDATE_INSTALL_E2E_TRIGGER_READ_FAILED');
      return;
    }
    timer = setTimeout(poll, POLL_INTERVAL_MS);
  }

  deps.logger.info('application', 'update.install-e2e.armed', {});
  timer = setTimeout(poll, POLL_INTERVAL_MS);
  return { stopSync };
}
