import type Database from 'better-sqlite3';
import type { ContextLogger } from '../app/logger';
import type { MaintenanceState } from '../maintenance/maintenanceCoordinator';
import { inspectDatabaseHealth } from './databaseHealth';

/**
 * Windows sleep/resume lifecycle diagnostics (`SUPPORT_DIAGNOSTICS.md §35`;
 * `ARCHITECTURE.md` Decision 30/32).
 *
 * A minimal subset of Electron's `powerMonitor` — kept structural (not
 * imported from `electron`) so this module is testable with a plain fake
 * emitter, the same pattern `singleInstance.ts` uses for `FocusableWindow`.
 */
export interface PowerMonitorLike {
  on(event: 'suspend' | 'resume', listener: () => void): void;
}

export interface ResumeSafetyCheck {
  readonly databaseOpen: boolean;
  readonly schemaValid: boolean;
  readonly maintenanceState: MaintenanceState;
}

/**
 * Confirm, using only existing trusted seams, that the database remains open
 * and its schema valid (`inspectDatabaseHealth` — the same shallow, no-`quick_check`
 * read used elsewhere for lightweight health reads, never a heavy synchronous
 * scan) and read the current maintenance state (`maintenanceCoordinator.status()`).
 * This performs no writes and claims nothing — it is purely informational,
 * exactly like every other read-only diagnostic surface in this codebase.
 */
export function evaluateResumeSafety(
  db: Database.Database | null,
  maintenanceState: MaintenanceState,
): ResumeSafetyCheck {
  let schemaValid = false;
  const databaseOpen = db !== null && db.open;
  if (databaseOpen) {
    try {
      schemaValid = inspectDatabaseHealth(db, { deep: false }).migrationStateValid;
    } catch {
      schemaValid = false;
    }
  }
  return { databaseOpen, schemaValid, maintenanceState };
}

export interface PowerLifecycleDeps {
  readonly logger: ContextLogger;
  readonly getDatabase: () => Database.Database | null;
  readonly getMaintenanceState: () => MaintenanceState;
  /** Reported to the caller so it can reuse ITS OWN existing critical-safe surface (e.g. `setDatabaseStatus`) — this module never mutates global status itself. */
  readonly onResumeSafetyCheck?: (safety: ResumeSafetyCheck) => void;
  /** Reuse-only hook, e.g. the existing `exportWorker.recoverStale()` — never a new worker/mechanism. */
  readonly onResumeExportRecovery?: () => void;
  /** Re-synchronizes the clock watcher's baseline so elapsed sleep is not reported as a clock jump. */
  readonly onResumeClockRebaseline?: () => void;
}

/** Wire `suspend`/`resume` to safe structured logging and a read-only post-resume confirmation. */
export function installPowerLifecycleHandlers(
  powerMonitor: PowerMonitorLike,
  deps: PowerLifecycleDeps,
): void {
  powerMonitor.on('suspend', () => {
    // No heavy work here — the process is about to lose CPU time regardless.
    deps.logger.info('application', 'system.suspend');
  });

  powerMonitor.on('resume', () => {
    deps.logger.info('application', 'system.resume');
    deps.onResumeClockRebaseline?.();

    const safety = evaluateResumeSafety(deps.getDatabase(), deps.getMaintenanceState());
    deps.logger.info('diagnostics', 'system.resume-safety-check', {
      databaseOpen: safety.databaseOpen,
      schemaValid: safety.schemaValid,
      maintenanceState: safety.maintenanceState,
    });
    deps.onResumeSafetyCheck?.(safety);

    // Network/Google/printer/update state is deliberately not touched here —
    // it stays secondary per SUPPORT_DIAGNOSTICS.md §35 and is not re-evaluated
    // as part of lifecycle diagnostics.
    deps.onResumeExportRecovery?.();
  });
}
