import type { UpdateState } from '../../shared/diagnostics';
import type { UpdateStateInput, UpdateStateInspector } from '../diagnostics/updateHealth';
import type { UpdateService } from './updateService';
import type { UpdaterState } from './types';

/**
 * The real `UpdateStateInspector` for Phase 2M diagnostics (Phase 2N-B
 * Section 12), wired in `index.ts` alongside `createUpdateService`.
 * `diagnosticsService.ts`/`updateHealth.ts` are otherwise UNCHANGED —
 * `buildUpdateDiagnostic`'s mapping (`FAILED` → `WARNING`, everything else
 * → `HEALTHY`; never `CRITICAL`) already does the right thing once this
 * bridge supplies real, honest `UpdateStateInput` instead of the permanent
 * V1 `unsupportedUpdateDiagnostic()` fallback.
 *
 * `supported` is `true` exactly when a real updater is active — i.e.
 * whenever the internal state is not the permanent `UNKNOWN` "no real
 * updater" value (unpackaged, no feed configured, or construction never
 * attempted). `FAILED` (including a failed construction attempt,
 * `INIT_FAILED`) is still `supported: true`: an attempt WAS made, and the
 * failure is real and worth surfacing as `WARNING`, not the honest
 * "nothing exists" `UNKNOWN` case.
 *
 * The existing shared `UpdateState`/`issueCode` vocabulary is deliberately
 * NOT extended here (`Do not introduce a second update-health model`): both
 * `DOWNLOADING` and `READY` map to the existing `PENDING` value (an update
 * is in progress toward being installable — 2N-C distinguishes "downloading"
 * from "ready to install" once a UI needs to), and every internal failure
 * code (`INIT_FAILED`/`CHECK_FAILED`/`DOWNLOAD_FAILED`) maps to the existing
 * `UPDATE_CHECK_FAILED` — the only failure code that makes sense before
 * installation exists (`UPDATE_INSTALL_FAILED` is 2N-C's).
 */
function mapUpdaterState(state: UpdaterState): UpdateState {
  switch (state) {
    case 'UNKNOWN':
      return 'UNKNOWN';
    case 'IDLE':
    case 'CHECKING':
      return 'UP_TO_DATE';
    case 'AVAILABLE':
      return 'AVAILABLE';
    case 'DOWNLOADING':
    case 'READY':
      return 'PENDING';
    case 'FAILED':
      return 'FAILED';
  }
}

export function createUpdaterStateInspector(service: UpdateService): UpdateStateInspector {
  return {
    inspect(): Promise<UpdateStateInput> {
      const snapshot = service.getSnapshot();
      return Promise.resolve({
        supported: snapshot.state !== 'UNKNOWN',
        state: mapUpdaterState(snapshot.state),
        currentVersion: snapshot.currentVersion,
        availableVersion: snapshot.availableVersion,
        lastCheckedAt: snapshot.lastCheckedAt,
        issueCode: snapshot.failureCode ? 'UPDATE_CHECK_FAILED' : null,
      });
    },
  };
}
