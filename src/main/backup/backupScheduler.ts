import type { Logger } from '../app/logger';
import type { BackupService } from './backupService';
import { sanitizedOsErrorCode } from './backupSnapshot';

/**
 * Recurring automatic-backup scheduler (`REQ-BACKUP-005`; `DATA_MODEL.md §36B`;
 * `POS_WORKFLOWS.md §65`).
 *
 * A single non-overlapping tick loop. Each tick just asks the service
 * "is today's automatic backup still owed?" — the due decision lives in
 * `backupSchedule.ts` and is timezone-aware, so the process does not have to be
 * alive at 03:00. The interval is a coarse poll (default 15 min), not an
 * aggressive retry loop: a failed backup is simply re-evaluated on the next
 * tick, and backup failure never blocks sales.
 *
 * `stopSync()` is called from `will-quit` before the database closes.
 */

const DEFAULT_TICK_MS = 15 * 60 * 1000;

export interface BackupScheduler {
  start(): void;
  stopSync(): void;
  readonly running: boolean;
}

export function createBackupScheduler(
  service: BackupService,
  logger: Logger,
  options?: { readonly tickMs?: number },
): BackupScheduler {
  const tickMs = options?.tickMs ?? DEFAULT_TICK_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopping = false;
  let ticking = false;

  async function tick(): Promise<void> {
    if (stopping || ticking) {
      return;
    }
    ticking = true;
    try {
      const result = await service.runAutomaticIfDue();
      if (result.ran) {
        logger.info('backup', 'backup.scheduler.tick', { ok: result.ok });
      }
    } catch (error) {
      // `runAutomaticIfDue` is contracted never to throw; this is pure defence.
      logger.warn('backup', 'backup.scheduler.tick-failed', {
        osErrorCode: sanitizedOsErrorCode(error),
      });
    } finally {
      ticking = false;
      if (!stopping) {
        timer = setTimeout(() => {
          void tick();
        }, tickMs);
      }
    }
  }

  return {
    get running(): boolean {
      return timer !== null && !stopping;
    },
    start(): void {
      if (timer !== null || stopping) {
        return;
      }
      logger.info('backup', 'backup.scheduler.started', { tickMs });
      timer = setTimeout(() => {
        void tick();
      }, tickMs);
    },
    stopSync(): void {
      stopping = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
