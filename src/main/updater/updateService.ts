import type { Logger } from '../app/logger';
import type { UpdaterAdapter, UpdaterAdapterInfo, UpdaterAdapterProgress } from './updaterAdapter';
import { createElectronUpdaterAdapter } from './updaterAdapter';
import type { UpdaterFailureCode, UpdaterState, UpdateServiceSnapshot } from './types';

/**
 * The trusted main-process update-service foundation (Phase 2N-A —
 * `ARCHITECTURE.md §10, §42.3`; `UPDATE_RELEASE_STRATEGY.md` Sections 2, 6,
 * 11-17, 29, 40-41; `PRODUCT_REQUIREMENTS.md` `REQ-UPDATE-001`..`010`).
 *
 * Scope of this slice: construct the updater abstraction (if a packaged
 * build has a configured generic-HTTPS feed), normalize its events into the
 * safe `UpdateServiceSnapshot` shape, and do absolutely nothing else — no
 * scheduled/periodic/startup checking, no download orchestration, no IPC.
 * Later slices (2N-B/2N-C) add checking, download, and user-controlled
 * install on top of this normalizer without changing its shape again.
 *
 * Failure isolation (`REQ-UPDATE-006`): construction NEVER throws. An
 * unpackaged/development run, a missing feed configuration, or an adapter
 * construction failure all resolve to a safe, inert snapshot — never an
 * exception that could interrupt application startup, login, or checkout.
 * This service has no database handle and no checkout/maintenance
 * dependency; it cannot hold a lock and nothing here can block a sale.
 */

export interface UpdateServiceDeps {
  readonly logger: Logger;
  readonly currentVersion: string;
  /** `app.isPackaged` — real updater capability activates only when true. */
  readonly isPackaged: boolean;
  /** `null` when no generic-HTTPS feed is configured for this build/run. */
  readonly feedUrl: string | null;
  /** Test seam: replaces `createElectronUpdaterAdapter`. Never used in production. */
  readonly createAdapter?: (feedUrl: string) => UpdaterAdapter;
}

export interface UpdateService {
  getSnapshot(): UpdateServiceSnapshot;
}

interface MutableSnapshot {
  state: UpdaterState;
  availableVersion: string | null;
  progressPercent: number | null;
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
  const snapshot: MutableSnapshot = {
    state: 'UNKNOWN',
    availableVersion: null,
    progressPercent: null,
    failureCode: null,
  };

  function log(event: string, fields?: Record<string, unknown>): void {
    deps.logger.info('application', event, fields);
  }

  function attach(adapter: UpdaterAdapter): void {
    adapter.on('checking-for-update', () => {
      snapshot.state = 'CHECKING';
      snapshot.failureCode = null;
      log('update.check.started');
    });
    adapter.on('update-not-available', () => {
      snapshot.state = 'IDLE';
      snapshot.availableVersion = null;
      snapshot.failureCode = null;
      log('update.check.no_update');
    });
    adapter.on('update-available', (info) => {
      snapshot.state = 'AVAILABLE';
      snapshot.availableVersion = safeVersion(info);
      snapshot.failureCode = null;
      log('update.available', { availableVersion: snapshot.availableVersion });
    });
    adapter.on('download-progress', (progress) => {
      snapshot.state = 'DOWNLOADING';
      snapshot.progressPercent = safePercent(progress);
    });
    adapter.on('update-downloaded', (info) => {
      snapshot.state = 'READY';
      snapshot.availableVersion = safeVersion(info) ?? snapshot.availableVersion;
      snapshot.progressPercent = 100;
      log('update.download.completed', { availableVersion: snapshot.availableVersion });
    });
    adapter.on('error', () => {
      // Never log/store the raw error (message/stack may carry transport or
      // filesystem detail) — only a stable, safe failure code, and only ever
      // WARNING-worthy, never a startup/checkout-blocking failure.
      const wasDownloading = snapshot.state === 'DOWNLOADING';
      snapshot.state = 'FAILED';
      snapshot.progressPercent = null;
      snapshot.failureCode = wasDownloading ? 'DOWNLOAD_FAILED' : 'CHECK_FAILED';
      deps.logger.warn('application', 'update.error', { failureCode: snapshot.failureCode });
    });
  }

  if (deps.isPackaged && deps.feedUrl) {
    try {
      const adapter = (deps.createAdapter ?? createElectronUpdaterAdapter)(deps.feedUrl);
      attach(adapter);
      snapshot.state = 'IDLE';
      log('update.service.initialized');
    } catch {
      // Adapter construction failed (module load, malformed feed config,
      // ...). Fail open: the service stays inert and honestly `FAILED`
      // rather than throwing out of this factory and interrupting startup.
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

  return {
    getSnapshot(): UpdateServiceSnapshot {
      return {
        state: snapshot.state,
        currentVersion: deps.currentVersion,
        availableVersion: snapshot.availableVersion,
        progressPercent: snapshot.progressPercent,
        failureCode: snapshot.failureCode,
      };
    },
  };
}
