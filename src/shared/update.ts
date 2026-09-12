/**
 * Shared update-lifecycle types (Phase 2N-A/B/C — `UPDATE_RELEASE_STRATEGY.md`
 * Sections 11-17; `ARCHITECTURE.md §42.3`; `PRODUCT_REQUIREMENTS.md`
 * `REQ-UPDATE-003`-`REQ-UPDATE-005`).
 *
 * This is the ONE canonical definition of `UpdaterState`/`UpdateServiceSnapshot`
 * — `src/main/updater/types.ts` re-exports it rather than redefining it, now
 * that Phase 2N-C's `updates:get-status` IPC channel sends this shape to the
 * renderer. It is deliberately NOT the same vocabulary as the
 * Phase 2M-diagnostics-facing `UpdateState`/`UpdateDiagnostic` in
 * `diagnostics.ts` (that DTO is coarser by design; `updateDiagnosticsBridge.ts`
 * maps between the two — see that file's docstring). Every field here is a
 * primitive or `null`: no HTTP response, credential, signing material, or
 * filesystem path ever belongs in this shape.
 */

export const UPDATER_STATES = [
  /** No real updater is active (unpackaged/development, or not yet initialized). */
  'UNKNOWN',
  /** Updater initialized; no check has found a pending update. */
  'IDLE',
  'CHECKING',
  'AVAILABLE',
  'DOWNLOADING',
  /** Downloaded and verified; ready for user-controlled restart. */
  'READY',
  'FAILED',
] as const;
export type UpdaterState = (typeof UPDATER_STATES)[number];

/**
 * Stable, safe failure reasons only — never a raw error message/stack. Kept
 * intentionally coarse: enough to log/diagnose (`UPDATE_RELEASE_STRATEGY.md`
 * §35), never enough to leak transport/filesystem detail.
 */
export type UpdaterFailureCode = 'INIT_FAILED' | 'CHECK_FAILED' | 'DOWNLOAD_FAILED';

/**
 * The only shape exposed outside the service (both to `updateDiagnosticsBridge.ts`
 * and, since Phase 2N-C, over `updates:get-status`/`updates:check-now`).
 */
export interface UpdateServiceSnapshot {
  readonly state: UpdaterState;
  readonly currentVersion: string;
  readonly availableVersion: string | null;
  /** 0-100, integer. `null` outside `DOWNLOADING`/`READY`. */
  readonly progressPercent: number | null;
  /** ISO timestamp of the last check that completed without error (found or not found an update). `null` before any check has completed. */
  readonly lastCheckedAt: string | null;
  /** Only meaningful when `state === 'FAILED'`. */
  readonly failureCode: UpdaterFailureCode | null;
}

/**
 * Phase 2N-C `updates:restart-and-install` result. A narrow, exhaustive,
 * always-safe outcome — never a raw exception, installer path, or feed URL.
 * `INSTALL_ACCEPTED` means the real updater install/restart primitive was
 * invoked; the renderer must not expect a further response after that, since
 * the process may quit before one could arrive (`updateService.ts`).
 */
export const UPDATE_INSTALL_RESULT_CODES = [
  'INSTALL_ACCEPTED',
  'NOT_READY',
  'UNSUPPORTED',
  'CHECKOUT_ACTIVE',
  'TRANSACTION_IN_FLIGHT',
  'MIGRATION_IN_PROGRESS',
  'RESTORE_IN_PROGRESS',
  'INSTALL_FAILED',
] as const;
export type UpdateInstallResultCode = (typeof UPDATE_INSTALL_RESULT_CODES)[number];

export interface UpdateInstallResult {
  readonly code: UpdateInstallResultCode;
}
