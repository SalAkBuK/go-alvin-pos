import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from './logger';
import { preRestoreDir } from '../backup/backupNaming';
import { removeSqliteSidecars, restoreFromRecoveryCopy } from '../backup/databaseSwap';
import { sanitizedOsErrorCode, verifySqliteBackup } from '../backup/backupSnapshot';
import { clearRestoreMarker, readRestoreMarker } from '../maintenance/restoreMarker';

/**
 * Interrupted-restore recovery, run at startup BEFORE the normal database open
 * (`DATA_MODEL.md §52A` step 6; `POS_WORKFLOWS.md §67A` step 8;
 * `ARCHITECTURE.md §38`; Phase 2L-B Item 13).
 *
 * If a previous process died after the destructive swap but before the restored
 * database validated, the crash-consistent marker names the verified pre-restore
 * recovery copy. This puts it back as the operational database. If the marker is
 * corrupt/incoherent, or the recovery copy cannot be validated, startup stops
 * safely with a stable code — it never guesses.
 */

export type StartupRestoreRecoveryResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'recovered' }
  | { readonly kind: 'failed'; readonly failureCode: 'RESTORE_RECOVERY_FAILED' };

export interface StartupRestoreRecoveryOptions {
  readonly userDataDir: string;
  readonly backupsRoot: string;
  readonly databaseFile: string;
  readonly targetSchemaVersion: number;
  readonly logger: Logger;
}

export function recoverInterruptedRestore(
  options: StartupRestoreRecoveryOptions,
): StartupRestoreRecoveryResult {
  const read = readRestoreMarker(options.userDataDir);
  if (!read.present) {
    return { kind: 'none' };
  }
  if ('corrupt' in read) {
    options.logger.fatal('backup', 'restore.marker.corrupt', {});
    return { kind: 'failed', failureCode: 'RESTORE_RECOVERY_FAILED' };
  }

  const recoveryCopy = join(preRestoreDir(options.backupsRoot), read.marker.preRestoreFileName);
  options.logger.warn('backup', 'restore.interrupted.detected', {});

  try {
    if (!existsSync(recoveryCopy) || statSync(recoveryCopy).size === 0) {
      options.logger.fatal('backup', 'restore.recovery-copy.missing', {});
      return { kind: 'failed', failureCode: 'RESTORE_RECOVERY_FAILED' };
    }
    const check = verifySqliteBackup(recoveryCopy, {
      expectedSchemaVersion: options.targetSchemaVersion,
    });
    if (!check.ok) {
      options.logger.fatal('backup', 'restore.recovery-copy.invalid', {
        errorCode: check.errorCode,
      });
      return { kind: 'failed', failureCode: 'RESTORE_RECOVERY_FAILED' };
    }

    restoreFromRecoveryCopy(recoveryCopy, options.databaseFile);
    removeSqliteSidecars(options.databaseFile);
    clearRestoreMarker(options.userDataDir);
    options.logger.warn('backup', 'restore.interrupted.recovered', {});
    return { kind: 'recovered' };
  } catch (error) {
    options.logger.fatal('backup', 'restore.interrupted.recovery-failed', {
      osErrorCode: sanitizedOsErrorCode(error),
    });
    return { kind: 'failed', failureCode: 'RESTORE_RECOVERY_FAILED' };
  }
}
