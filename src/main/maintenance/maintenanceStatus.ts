/**
 * Process-wide "an exclusive DB-lifecycle owner is active" flag
 * (`ARCHITECTURE.md §42.3`; `UPDATE_RELEASE_STRATEGY.md §16`).
 *
 * A tiny module singleton — the same pattern as `database/status.ts`. The
 * {@link MaintenanceCoordinator} is the authority and sets it; the trusted IPC
 * layer (`ipc/trustedInvoke.ts`) reads it to refuse normal DB-backed requests
 * while a RESTORE (or, later, an update MIGRATION) owns the database lifecycle.
 *
 * It carries no rows, SQL, paths, or business data — only which exclusive kind,
 * if any, currently owns the lifecycle.
 */

export type ExclusiveMaintenanceKind = 'MIGRATION' | 'RESTORE';

let exclusiveKind: ExclusiveMaintenanceKind | null = null;

/** Called only by the coordinator's `tryAcquireExclusive` / `release`. */
export function setExclusiveMaintenance(kind: ExclusiveMaintenanceKind | null): void {
  exclusiveKind = kind;
}

export function getExclusiveMaintenance(): ExclusiveMaintenanceKind | null {
  return exclusiveKind;
}

export function isExclusiveMaintenanceActive(): boolean {
  return exclusiveKind !== null;
}
