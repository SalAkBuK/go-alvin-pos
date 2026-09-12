/**
 * Internal update-lifecycle state — re-exported from the canonical shared
 * definition (Phase 2N-C — `src/shared/update.ts`). Kept as a separate module
 * path so every existing main-process import (`updateService.ts`,
 * `updaterAdapter.ts`, `updateDiagnosticsBridge.ts`) is unaffected by the
 * move; see `src/shared/update.ts`'s docstring for why this now lives there
 * (it crosses the IPC boundary via `updates:get-status`/`updates:check-now`
 * as of Phase 2N-C, so a single shared definition replaces what was
 * previously a main-only shape).
 */

export type {
  UpdaterState,
  UpdaterFailureCode,
  UpdateServiceSnapshot,
  UpdateInstallResultCode,
  UpdateInstallResult,
} from '../../shared/update';
export { UPDATER_STATES, UPDATE_INSTALL_RESULT_CODES } from '../../shared/update';
