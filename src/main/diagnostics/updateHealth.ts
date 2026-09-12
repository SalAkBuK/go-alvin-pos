import type { UpdateDiagnostic, UpdateState } from '../../shared/diagnostics';

/**
 * Update-health diagnostics (`PRODUCT_SCOPE.md §33`; `SUPPORT_DIAGNOSTICS.md §53`;
 * `UPDATE_RELEASE_STRATEGY.md`).
 *
 * There is no update-check/download/install mechanism implemented anywhere in
 * this codebase yet — `UPDATE_RELEASE_STRATEGY.md` documents the target
 * design (discovery, background download, `Restart & Update`, ...), none of
 * which exists in code. This module exposes what update state IS knowable —
 * honestly `UNKNOWN`/unsupported in V1 — without fabricating progress, a
 * fake available version, or a fake check timestamp, and without building any
 * part of the updater itself.
 *
 * `buildUpdateDiagnostic` is the pure mapping used by both the honest V1
 * fallback and any future real update-state provider, so a later updater can
 * populate this component (via `DiagnosticsServiceDeps.updateStateInspector`)
 * without changing this mapping or the shared DTO again.
 */

export interface UpdateStateInput {
  /** `false` in V1: no update-check mechanism exists to be unsupported/supported on top of. */
  readonly supported: boolean;
  readonly state: UpdateState;
  readonly currentVersion: string;
  readonly availableVersion?: string | null;
  readonly lastCheckedAt?: string | null;
  /** Only meaningful when `state === 'FAILED'`; ignored otherwise. */
  readonly issueCode?: 'UPDATE_CHECK_FAILED' | 'UPDATE_INSTALL_FAILED' | null;
}

/** A real, injectable future update-state source (mirrors `ConnectivityInspector`'s shape). Never wired in V1 — there is nothing to inspect. */
export interface UpdateStateInspector {
  inspect(): Promise<UpdateStateInput>;
}

/**
 * Update state alone can only ever contribute `HEALTHY`/`WARNING` — the
 * `Exclude<HealthStatus, 'CRITICAL'>` return type makes this a compile-time
 * guarantee, not just a convention. Only an actual reported `FAILED` state
 * (from a real, `supported: true` provider) becomes `WARNING`; every other
 * state — including the permanent V1 `UNKNOWN`/unsupported case — is
 * `HEALTHY`, matching the same "unsupported check = neutral, not alarming"
 * precedent already used for connectivity.
 */
export function buildUpdateDiagnostic(input: UpdateStateInput): UpdateDiagnostic {
  const failed = input.supported && input.state === 'FAILED';
  return {
    status: failed ? 'WARNING' : 'HEALTHY',
    supported: input.supported,
    state: input.state,
    currentVersion: input.currentVersion,
    availableVersion: input.availableVersion ?? null,
    lastCheckedAt: input.lastCheckedAt ?? null,
    issueCode: failed ? (input.issueCode ?? 'UPDATE_CHECK_FAILED') : null,
  };
}

/** The only value V1 ever actually produces: no updater exists, so the honest answer is `UNKNOWN`/unsupported, never a fabricated status. */
export function unsupportedUpdateDiagnostic(currentVersion: string): UpdateDiagnostic {
  return buildUpdateDiagnostic({ supported: false, state: 'UNKNOWN', currentVersion });
}
