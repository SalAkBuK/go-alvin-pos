/**
 * Internal update-lifecycle state (Phase 2N-A — `UPDATE_RELEASE_STRATEGY.md`
 * Sections 11-17; `ARCHITECTURE.md §42.3`).
 *
 * This is a main-process-only, service-internal shape. It is deliberately
 * NOT the renderer/diagnostics-facing `UpdateState`/`UpdateDiagnostic` in
 * `src/shared/diagnostics.ts` (Phase 2M) — that DTO is the honest V1
 * "no real updater exists" surface, and stays as-is until 2N-B wires a real
 * `UpdateStateInspector` on top of this service. Nothing here crosses the
 * IPC boundary in this slice.
 */

export const UPDATER_STATES = [
  /** No real updater is active (unpackaged/development, or not yet initialized). */
  'UNKNOWN',
  /** Updater initialized; no check has found a pending update. */
  'IDLE',
  'CHECKING',
  'AVAILABLE',
  'DOWNLOADING',
  /** Downloaded and verified; ready for user-controlled restart (future 2N-C). */
  'READY',
  'FAILED',
] as const;
export type UpdaterState = (typeof UPDATER_STATES)[number];

/**
 * Stable, safe failure reasons only — never a raw error message/stack. Kept
 * intentionally coarse: enough to log/diagnose (`UPDATE_RELEASE_STRATEGY.md`
 * §35), never enough to leak transport/filesystem detail.
 */
export type UpdaterFailureCode =
  /** The adapter itself could not be constructed/configured. */
  'INIT_FAILED' | 'CHECK_FAILED' | 'DOWNLOAD_FAILED';

/**
 * The only shape exposed outside the service. Every field is a primitive or
 * `null` — no HTTP response, credential, signing material, or filesystem
 * path (`UPDATE_RELEASE_STRATEGY.md` update-security requirements).
 */
export interface UpdateServiceSnapshot {
  readonly state: UpdaterState;
  readonly currentVersion: string;
  readonly availableVersion: string | null;
  /** 0-100, integer. `null` outside `DOWNLOADING`/`READY`. */
  readonly progressPercent: number | null;
  /** Only meaningful when `state === 'FAILED'`. */
  readonly failureCode: UpdaterFailureCode | null;
}
