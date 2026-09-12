import type { Logger } from '../app/logger';
import type { MaintenanceState } from '../maintenance/maintenanceCoordinator';
import type { UpdaterAdapter, UpdaterAdapterInfo, UpdaterAdapterProgress } from './updaterAdapter';
import { createElectronUpdaterAdapter } from './updaterAdapter';
import type {
  UpdaterFailureCode,
  UpdaterState,
  UpdateServiceSnapshot,
  UpdateInstallResult,
} from './types';

/**
 * The trusted main-process update engine — discovery, background download
 * (Phase 2N-B), and user-controlled install (Phase 2N-C) — built on the
 * Phase 2N-A foundation (`ARCHITECTURE.md §10, §42.3`;
 * `UPDATE_RELEASE_STRATEGY.md` Sections 2, 6, 11-17, 29, 40-41;
 * `PRODUCT_REQUIREMENTS.md` `REQ-UPDATE-001`..`010`).
 *
 * ## Canonical feed configuration
 *
 * There is exactly ONE source of truth for the update feed: the generic-HTTPS
 * URL resolved by `updateFeedConfig.ts` (injected value → build-embedded
 * `__UPDATE_FEED_URL__` → `GO_PHONES_UPDATE_FEED_URL` env var), applied via
 * `autoUpdater.setFeedURL({ provider: 'generic', url })` in
 * `updaterAdapter.ts`. `setFeedURL()` is documented by electron-updater as the
 * mechanism to "override configuration in app-update.yml" — it is
 * authoritative for which provider/URL a check actually uses regardless of
 * any on-disk yml. `electron-builder.js` generates `app-update.yml` (via the
 * `nsis` installer target, added in the Phase 2N-B follow-up fix) from the
 * SAME env var, purely so electron-updater's download path has the
 * `updaterCacheDirName` it unconditionally requires — never a second,
 * independently meaningful feed source.
 *
 * ## Scope
 *
 * Discovery + download (2N-B): a startup check (after a short, non-blocking
 * delay — never inside database/migration ownership) and a conservative
 * bounded periodic re-check, both driving the SAME `checkForUpdates()` call
 * also exposed as `checkNow()` for the manual "Check for Updates" UI (2N-C).
 * With `autoDownload = true` (`updaterAdapter.ts`), a discovered approved
 * update downloads automatically.
 *
 * Install (2N-C): `restartAndInstall()` is the one trusted operation that may
 * invoke the real `quitAndInstall()` primitive, and only after independently
 * (synchronously, race-safely) confirming `state === 'READY'` and the
 * injected `getMaintenanceState()` reports `SAFE`. The renderer never decides
 * whether it is safe to restart — it can only ask, and this function is the
 * sole place that decides.
 *
 * Failure isolation (`REQ-UPDATE-006`): construction NEVER throws. Neither
 * `start()`, `checkNow()`, `restartAndInstall()`, nor any adapter event
 * handler can throw past this module. This service still has no database
 * handle and cannot acquire any exclusive database-lifecycle claim itself —
 * `getMaintenanceState()` is a read-only status query, the same one
 * `maintenance:status` already exposes to the renderer, not a new authority.
 */

/** V1 conservative bounded interval — a phone-shop POS does not need aggressive polling. */
export const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Delay before the first (startup) check, so it never competes with window creation/login. */
export const DEFAULT_STARTUP_CHECK_DELAY_MS = 15 * 1000;

export interface UpdateServiceDeps {
  readonly logger: Logger;
  readonly currentVersion: string;
  /** `app.isPackaged` — real updater capability activates only when true. */
  readonly isPackaged: boolean;
  /** `null` when no generic-HTTPS feed is configured for this build/run. */
  readonly feedUrl: string | null;
  /** Test seam: replaces `createElectronUpdaterAdapter`. Never used in production. */
  readonly createAdapter?: (feedUrl: string) => UpdaterAdapter;
  readonly now?: () => Date;
  /** Bounded periodic re-check interval. Defaults to {@link DEFAULT_UPDATE_CHECK_INTERVAL_MS}. */
  readonly checkIntervalMs?: number;
  /** Delay before the first startup check. Defaults to {@link DEFAULT_STARTUP_CHECK_DELAY_MS}. */
  readonly startupCheckDelayMs?: number;
  /**
   * The one `MaintenanceCoordinator`'s current state (Phase 2N-C —
   * `ARCHITECTURE.md §42.3`). `restartAndInstall()` consults this
   * synchronously, immediately before invoking the real install primitive —
   * required, not optional: there is no safe default value for "is it safe
   * to restart right now," so every caller must wire the real coordinator.
   */
  readonly getMaintenanceState: () => MaintenanceState;
}

export interface UpdateService {
  getSnapshot(): UpdateServiceSnapshot;
  /**
   * Install scheduled update behavior: one startup check after a short
   * delay, then a bounded periodic re-check. A no-op (logged, not thrown)
   * when no real adapter is active (unpackaged/no feed/init failed), when
   * already started, or after `stopSync()`.
   */
  start(): void;
  /** Stop any pending/scheduled timer. Never cancels an in-flight check/download, and never touches an already-`READY` update. */
  stopSync(): void;
  readonly running: boolean;
  /**
   * Ask the feed for an update right now (used by scheduling, and exposed
   * for a future manual "Check for Updates" UI — Phase 2N-C). Concurrent
   * calls share the one in-flight check rather than starting another.
   * Never rejects; always resolves to the current normalized snapshot.
   */
  checkNow(): Promise<UpdateServiceSnapshot>;
  /**
   * Phase 2N-C: accept or refuse a user-requested "Restart & Update".
   * Synchronous and race-safe — the maintenance-state check and the install
   * invocation happen in the same synchronous turn, so nothing can change
   * maintenance state between "decided safe" and "installing" (there is no
   * `await` in between). Never throws; a failed install invocation is
   * normalized to `INSTALL_FAILED`. The renderer must not expect a response
   * after `INSTALL_ACCEPTED` — the process may quit before one could arrive.
   */
  restartAndInstall(): UpdateInstallResult;
}

interface MutableSnapshot {
  state: UpdaterState;
  availableVersion: string | null;
  progressPercent: number | null;
  lastCheckedAt: string | null;
  failureCode: UpdaterFailureCode | null;
}

/** Extract only a safe, well-typed version string — never any other field of an untrusted info object. */
function safeVersion(info: UpdaterAdapterInfo | undefined): string | null {
  return info && typeof info.version === 'string' && info.version.trim() !== ''
    ? info.version.trim()
    : null;
}

/** Clamp/round a percent value from an untrusted progress object into a safe 0-100 integer, or `null`. */
function safePercent(progress: UpdaterAdapterProgress | undefined): number | null {
  const raw = progress?.percent;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(raw)));
}

export function createUpdateService(deps: UpdateServiceDeps): UpdateService {
  const now = deps.now ?? ((): Date => new Date());
  const checkIntervalMs = deps.checkIntervalMs ?? DEFAULT_UPDATE_CHECK_INTERVAL_MS;
  const startupCheckDelayMs = deps.startupCheckDelayMs ?? DEFAULT_STARTUP_CHECK_DELAY_MS;

  const snapshot: MutableSnapshot = {
    state: 'UNKNOWN',
    availableVersion: null,
    progressPercent: null,
    lastCheckedAt: null,
    failureCode: null,
  };

  /** The live adapter, or `null` when unsupported (dev/no feed) or construction failed. */
  let adapter: UpdaterAdapter | null = null;

  function log(event: string, fields?: Record<string, unknown>): void {
    deps.logger.info('application', event, fields);
  }

  function attach(realAdapter: UpdaterAdapter): void {
    realAdapter.on('checking-for-update', () => {
      snapshot.state = 'CHECKING';
      snapshot.failureCode = null;
      log('update.check.started');
    });
    realAdapter.on('update-not-available', () => {
      snapshot.state = 'IDLE';
      snapshot.availableVersion = null;
      snapshot.failureCode = null;
      snapshot.lastCheckedAt = now().toISOString();
      log('update.check.no_update');
    });
    realAdapter.on('update-available', (info) => {
      snapshot.state = 'AVAILABLE';
      snapshot.availableVersion = safeVersion(info);
      snapshot.failureCode = null;
      snapshot.lastCheckedAt = now().toISOString();
      log('update.available', { availableVersion: snapshot.availableVersion });
    });
    realAdapter.on('download-progress', (progress) => {
      snapshot.state = 'DOWNLOADING';
      snapshot.progressPercent = safePercent(progress);
      log('update.download.progress', { progressPercent: snapshot.progressPercent });
    });
    realAdapter.on('update-downloaded', (info) => {
      snapshot.state = 'READY';
      snapshot.availableVersion = safeVersion(info) ?? snapshot.availableVersion;
      snapshot.progressPercent = 100;
      log('update.download.completed', { availableVersion: snapshot.availableVersion });
    });
    realAdapter.on('error', () => {
      // Never log/store the raw error (message/stack may carry transport or
      // filesystem detail) — only a stable, safe failure code, and only ever
      // WARNING-worthy, never a startup/checkout-blocking failure. Temporary
      // feed/network failures are logged at `warn`, matching every other
      // secondary-failure convention in this codebase — never escalated,
      // never repeated at higher severity by the scheduler below.
      const wasDownloading = snapshot.state === 'DOWNLOADING';
      snapshot.state = 'FAILED';
      snapshot.progressPercent = null;
      snapshot.failureCode = wasDownloading ? 'DOWNLOAD_FAILED' : 'CHECK_FAILED';
      deps.logger.warn('application', 'update.failed', { failureCode: snapshot.failureCode });
    });
  }

  if (deps.isPackaged && deps.feedUrl) {
    try {
      adapter = (deps.createAdapter ?? createElectronUpdaterAdapter)(deps.feedUrl);
      attach(adapter);
      snapshot.state = 'IDLE';
      log('update.service.initialized');
    } catch {
      // Adapter construction failed (module load, malformed feed config,
      // ...). Fail open: the service stays inert and honestly `FAILED`
      // rather than throwing out of this factory and interrupting startup.
      adapter = null;
      snapshot.state = 'FAILED';
      snapshot.failureCode = 'INIT_FAILED';
      deps.logger.warn('application', 'update.service.init_failed', {});
    }
  } else {
    log('update.service.unsupported', {
      isPackaged: deps.isPackaged,
      feedConfigured: deps.feedUrl !== null,
    });
  }

  function getSnapshot(): UpdateServiceSnapshot {
    return {
      state: snapshot.state,
      currentVersion: deps.currentVersion,
      availableVersion: snapshot.availableVersion,
      progressPercent: snapshot.progressPercent,
      lastCheckedAt: snapshot.lastCheckedAt,
      failureCode: snapshot.failureCode,
    };
  }

  // Concurrent `checkNow()` callers (scheduler tick + a future manual
  // trigger) share this one in-flight check rather than starting another —
  // the adapter's own `checkForUpdates()`/`downloadUpdate()` already
  // de-duplicate internally, but the fake adapter used in tests does not,
  // so this guard is the service's OWN guarantee, not a reliance on it.
  let inFlightCheck: Promise<UpdateServiceSnapshot> | null = null;

  function checkNow(): Promise<UpdateServiceSnapshot> {
    if (!adapter) {
      return Promise.resolve(getSnapshot());
    }
    if (inFlightCheck) {
      return inFlightCheck;
    }
    const activeAdapter = adapter;
    inFlightCheck = activeAdapter
      .checkForUpdates()
      .catch(() => {
        // The adapter's own `'error'` listener already normalized/logged
        // this failure into `snapshot`. This catch exists only to prevent
        // an unhandled rejection — it must never re-derive or log anything
        // from the raw rejection value.
      })
      .then(() => getSnapshot())
      .finally(() => {
        inFlightCheck = null;
      });
    return inFlightCheck;
  }

  // Scheduling: one non-overlapping setTimeout chain (never `setInterval`,
  // matching `backupScheduler.ts`'s convention) — the next tick is scheduled
  // only after the current check settles, so a slow/hung check can never
  // stack up overlapping timers. `stopping` is a one-way latch: once
  // stopped, `start()` does not resume (matches `backupScheduler.ts` /
  // `clockWatcher.ts`).
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let stopping = false;

  function scheduleNext(delayMs: number): void {
    if (stopping) return;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, delayMs);
  }

  async function tick(): Promise<void> {
    if (stopping) return;
    await checkNow();
    if (!stopping) {
      scheduleNext(checkIntervalMs);
    }
  }

  function restartAndInstall(): UpdateInstallResult {
    // Wrapped end-to-end: this operation must NEVER throw, matching every
    // other entry point on this service (`REQ-UPDATE-006`) — including
    // against a `getMaintenanceState()` that unexpectedly throws.
    try {
      if (!adapter) {
        return { code: 'UNSUPPORTED' };
      }
      if (snapshot.state !== 'READY') {
        return { code: 'NOT_READY' };
      }

      // Authoritative, synchronous, immediately-before-install check — the
      // same synchronous turn as the `quitAndInstall()` call below, so
      // nothing can change maintenance state in between (Section 5
      // race-safety). The renderer's own view of maintenance state is never
      // trusted for this decision, only ever this fresh read.
      const maintenanceState = deps.getMaintenanceState();
      if (maintenanceState !== 'SAFE') {
        log('update.install.deferred', { maintenanceReason: maintenanceState });
        return { code: maintenanceState };
      }

      log('update.install.requested', { availableVersion: snapshot.availableVersion });
      adapter.quitAndInstall();
      log('update.install.started', {});
      return { code: 'INSTALL_ACCEPTED' };
    } catch {
      // electron-updater's own `quitAndInstall()`/`install()` already catch
      // their internal errors and report them via the normal `'error'` event
      // rather than throwing — this catch is pure defence (a fake/future
      // adapter, or an unexpected `getMaintenanceState()` failure), and must
      // never surface the raw error.
      deps.logger.warn('application', 'update.install.failed', {});
      return { code: 'INSTALL_FAILED' };
    }
  }

  return {
    getSnapshot,
    checkNow,
    restartAndInstall,
    start(): void {
      if (!adapter || started || stopping) {
        return;
      }
      started = true;
      log('update.scheduler.started', { checkIntervalMs, startupCheckDelayMs });
      scheduleNext(startupCheckDelayMs);
    },
    stopSync(): void {
      stopping = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    get running(): boolean {
      return started && !stopping;
    },
  };
}
