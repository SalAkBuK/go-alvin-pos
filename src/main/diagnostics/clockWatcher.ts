import { performance } from 'node:perf_hooks';
import type { ContextLogger } from '../app/logger';

/**
 * Significant wall-clock-change detection (`SUPPORT_DIAGNOSTICS.md §33`;
 * `ARCHITECTURE.md §49A` — "a system clock change exceeding 5 minutes relative
 * to expected elapsed time" is the V1 significant-jump threshold).
 *
 * The check compares the wall clock (`Date.now()`, which a user or the OS can
 * change) against a monotonic clock (`performance.now()`, which cannot be set
 * backward/forward and is unaffected by NTP/manual clock edits) advanced by
 * the same real interval. `expectedWall = previousWall + monotonicElapsed`;
 * a large gap between that and the newly observed wall clock is a suspicious
 * jump, not ordinary elapsed time.
 *
 * This module never touches the audit trail: the durable, monotonically
 * increasing `sequence` column (`DATA_MODEL.md §36A`) already makes audit
 * ordering independent of the wall clock, so a detected clock change is
 * diagnostic-only — it logs and returns, never rewrites or reorders anything.
 *
 * Sleep is not double-counted as a false clock jump: `resetBaseline()` is
 * called by the power-lifecycle resume handler so the elapsed-sleep gap is
 * absorbed into the new baseline rather than compared against it.
 */

export const SIGNIFICANT_CLOCK_JUMP_THRESHOLD_MS = 5 * 60 * 1000;
export const DEFAULT_CLOCK_CHECK_INTERVAL_MS = 60 * 1000;

export type ClockJumpDirection = 'FORWARD' | 'BACKWARD';

export interface ClockChangeEvent {
  readonly previousObservedTime: string;
  readonly currentObservedTime: string;
  readonly differenceMs: number;
  readonly direction: ClockJumpDirection;
}

export interface ClockWatcherDeps {
  readonly logger: ContextLogger;
  readonly now?: () => number;
  readonly monotonicNow?: () => number;
  readonly thresholdMs?: number;
  readonly intervalMs?: number;
}

export interface ClockWatcher {
  start(): void;
  stopSync(): void;
  readonly running: boolean;
  /** Run one comparison immediately (used by tests and available for manual triggers). */
  checkNow(): ClockChangeEvent | null;
  /** Re-synchronize the baseline without comparing — used after a suspend/resume cycle. */
  resetBaseline(): void;
}

export function createClockWatcher(deps: ClockWatcherDeps): ClockWatcher {
  const now = deps.now ?? Date.now;
  const monotonicNow = deps.monotonicNow ?? (() => performance.now());
  const thresholdMs = deps.thresholdMs ?? SIGNIFICANT_CLOCK_JUMP_THRESHOLD_MS;
  const intervalMs = deps.intervalMs ?? DEFAULT_CLOCK_CHECK_INTERVAL_MS;

  let lastWall = now();
  let lastMonotonic = monotonicNow();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopping = false;

  function resetBaseline(): void {
    lastWall = now();
    lastMonotonic = monotonicNow();
  }

  function checkNow(): ClockChangeEvent | null {
    const wall = now();
    const monotonic = monotonicNow();
    const expectedWall = lastWall + (monotonic - lastMonotonic);
    const differenceMs = Math.round(wall - expectedWall);
    const previousObservedTime = new Date(lastWall).toISOString();
    const currentObservedTime = new Date(wall).toISOString();
    lastWall = wall;
    lastMonotonic = monotonic;

    if (Math.abs(differenceMs) <= thresholdMs) {
      return null;
    }

    const event: ClockChangeEvent = {
      previousObservedTime,
      currentObservedTime,
      differenceMs,
      direction: differenceMs > 0 ? 'FORWARD' : 'BACKWARD',
    };
    deps.logger.warn('application', 'clock.change.detected', {
      previousObservedTime: event.previousObservedTime,
      currentObservedTime: event.currentObservedTime,
      differenceMs: event.differenceMs,
      direction: event.direction,
    });
    return event;
  }

  function tick(): void {
    if (stopping) return;
    checkNow();
    if (!stopping) {
      timer = setTimeout(tick, intervalMs);
    }
  }

  return {
    get running(): boolean {
      return timer !== null && !stopping;
    },
    start(): void {
      if (timer !== null || stopping) return;
      timer = setTimeout(tick, intervalMs);
    },
    stopSync(): void {
      stopping = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    checkNow,
    resetBaseline,
  };
}
