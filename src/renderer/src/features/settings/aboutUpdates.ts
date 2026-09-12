import type { UpdateInstallResultCode, UpdateServiceSnapshot } from '../../../../shared/update';

/**
 * Pure, directly-testable helpers for Settings → About & Updates
 * (Phase 2N-C). No IPC, no React — see `AboutUpdatesSection.tsx` for the
 * stateful component and `support-diagnostics.test.tsx` for the established
 * "pure helpers + a props-driven view" testing convention this follows.
 */

export const UPDATE_UNAVAILABLE_MESSAGE =
  'Update status is unavailable right now. You can continue using Go Phones POS normally.';

/** The one status line for the current `UpdateServiceSnapshot`. Never fabricates a release date/build id. */
export function describeUpdateStatus(snapshot: UpdateServiceSnapshot): string {
  switch (snapshot.state) {
    case 'UNKNOWN':
      return 'Automatic updates are not configured for this build.';
    case 'IDLE':
      return "You're up to date.";
    case 'CHECKING':
      return 'Checking for updates…';
    case 'AVAILABLE':
    case 'DOWNLOADING':
      return snapshot.availableVersion
        ? `Version ${snapshot.availableVersion} is downloading in the background.`
        : 'A newer version is downloading in the background.';
    case 'READY':
      return snapshot.availableVersion
        ? `Go Phones POS ${snapshot.availableVersion} is ready to install.`
        : 'An update is ready to install.';
    case 'FAILED':
      return snapshot.failureCode === 'DOWNLOAD_FAILED'
        ? 'The update could not be downloaded. You can continue using the current version.'
        : 'Could not check for updates. You can continue using Go Phones POS normally.';
  }
}

/** `null` when there is nothing to show (e.g. not currently downloading). */
export function describeProgress(snapshot: UpdateServiceSnapshot): string | null {
  if (snapshot.state !== 'DOWNLOADING' || snapshot.progressPercent === null) {
    return null;
  }
  return `${snapshot.progressPercent}% downloaded`;
}

export function formatLastChecked(value: string | null): string {
  if (value === null) return 'Never';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unavailable';
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * Friendly copy for a denied/failed `restartAndInstall()` outcome
 * (`UPDATE_RELEASE_STRATEGY.md` §17, §43). `null` for `INSTALL_ACCEPTED` —
 * there is nothing to show; the app is about to restart.
 */
export function describeInstallResult(code: UpdateInstallResultCode): string | null {
  switch (code) {
    case 'INSTALL_ACCEPTED':
      return null;
    case 'NOT_READY':
      return 'The update is not ready to install yet.';
    case 'UNSUPPORTED':
      return 'Updating is not available right now.';
    case 'CHECKOUT_ACTIVE':
      return 'Finish or cancel the current sale before restarting to update.';
    case 'TRANSACTION_IN_FLIGHT':
      return 'A sale is still being saved. Try again in a moment.';
    case 'MIGRATION_IN_PROGRESS':
      return 'Database maintenance is in progress. The update cannot restart yet.';
    case 'RESTORE_IN_PROGRESS':
      return 'A database restore is in progress. The update cannot restart yet.';
    case 'INSTALL_FAILED':
      return 'The update could not be started. You can continue using Go Phones POS normally.';
  }
}

export interface ManualCheckCallbacks {
  readonly onCheckingChange: (checking: boolean) => void;
  readonly onSnapshot: (snapshot: UpdateServiceSnapshot) => void;
  readonly onError: (message: string | null) => void;
}

/**
 * One guarded manual "Check for Updates" action (mirrors
 * `createManualDiagnosticsAction` in `SupportDiagnosticsSection.tsx`). The
 * fixed error text never echoes a rejected IPC payload — `checkNow()` itself
 * already never rejects/errors on a check failure, so this branch only
 * covers the IPC call itself being unavailable/rejected.
 */
export function createManualCheckAction(
  invoke: () => Promise<{ ok: boolean; data?: UpdateServiceSnapshot }>,
  callbacks: ManualCheckCallbacks,
): { run: () => Promise<void>; isChecking: () => boolean } {
  let checking = false;
  return {
    isChecking: () => checking,
    run: async () => {
      if (checking) return;
      checking = true;
      callbacks.onCheckingChange(true);
      callbacks.onError(null);
      try {
        const result = await invoke();
        if (result.ok && result.data) {
          callbacks.onSnapshot(result.data);
        } else {
          callbacks.onError(UPDATE_UNAVAILABLE_MESSAGE);
        }
      } catch {
        callbacks.onError(UPDATE_UNAVAILABLE_MESSAGE);
      } finally {
        checking = false;
        callbacks.onCheckingChange(false);
      }
    },
  };
}

export interface RestartInstallCallbacks {
  readonly onBusyChange: (busy: boolean) => void;
  readonly onResult: (code: UpdateInstallResultCode | null) => void;
}

/**
 * One guarded "Restart & Update" action. The main process alone decides
 * whether this is safe (`UpdateService.restartAndInstall()`) — this helper
 * only prevents a duplicate concurrent click; it never inspects or trusts
 * any locally-held maintenance state.
 */
export function createRestartInstallAction(
  invoke: () => Promise<{ ok: boolean; data?: { code: UpdateInstallResultCode } }>,
  callbacks: RestartInstallCallbacks,
): { run: () => Promise<void>; isBusy: () => boolean } {
  let busy = false;
  return {
    isBusy: () => busy,
    run: async () => {
      if (busy) return;
      busy = true;
      callbacks.onBusyChange(true);
      try {
        const result = await invoke();
        callbacks.onResult(result.ok && result.data ? result.data.code : 'INSTALL_FAILED');
      } catch {
        callbacks.onResult('INSTALL_FAILED');
      } finally {
        busy = false;
        callbacks.onBusyChange(false);
      }
    },
  };
}
