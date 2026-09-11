import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type {
  NewerDataLoss,
  RestoreCandidate,
  RestoreCandidateInspection,
  RestoreOutcome,
} from '../../shared/restore';
import type { Logger } from '../app/logger';
import type { MaintenanceCoordinator } from '../maintenance/maintenanceCoordinator';
import { clearRestoreMarker, writeRestoreMarker } from '../maintenance/restoreMarker';
import { appErrors, isAppError } from '../shared/appError';
import { preRestoreDir, preRestoreFileName } from './backupNaming';
import { createSqliteSnapshot, sanitizedOsErrorCode, verifySqliteBackup } from './backupSnapshot';
import type { BrowseCandidateRegistry } from './browseCandidate';
import { createBrowseCandidateRegistry } from './browseCandidate';
import { readOffDeviceBackupDestination } from '../settings/offDeviceBackupSettingsRepository';
import type { UnifiedCandidateSources } from './restoreCandidate';
import {
  computeNewerSaleLoss,
  createConfirmationTokenizer,
  listRestoreCandidates,
  materialRestoreStateFingerprint,
  previewIncompatibleCandidate,
  resolveAndRevalidateCandidate,
  resolveBrowsedCandidate,
} from './restoreCandidate';
import { assertRestoredDatabaseUsable } from './restoreValidation';
import {
  discardPreviousMain,
  removeSqliteSidecars,
  restoreFromRecoveryCopy,
  stageAndActivate,
} from './databaseSwap';

/**
 * Safe whole-database restore (`REQ-BACKUP-011`; `DATA_MODEL.md §52A`;
 * `POS_WORKFLOWS.md §67`, `§67A`; Phase 2L-B).
 *
 * Two stages, so the exclusive lock is never held while a human reads a dialog:
 *  - {@link RestoreService.inspect} — read-only preview, no lock, no copy;
 *  - {@link RestoreService.restore} — the guarded attempt: acquire RESTORE →
 *    quiesce background DB work → revalidate candidate → fresh verified
 *    pre-restore recovery copy → recompute loss → (confirm) → marker → close →
 *    swap → reopen → validate → rewire → resume → release. Any post-swap
 *    failure rolls back to the pre-restore copy.
 */

interface ProductionDatabaseLike {
  readonly connection: Database.Database;
  readonly schemaVersion: number;
  readonly closed: boolean;
  close(): void;
}

class PreRestoreCopyError extends Error {
  constructor(readonly errorCode: string) {
    super(`pre-restore recovery copy could not be verified: ${errorCode}`);
  }
}

export interface RestoreServiceDeps {
  readonly logger: Logger;
  readonly databaseFile: string;
  readonly backupsRoot: string;
  readonly userDataDir: string;
  readonly targetSchemaVersion: number;
  readonly coordinator: MaintenanceCoordinator;
  readonly now?: () => Date;
  /** The current live production database, or `null` while none is open. */
  readonly getCurrentDatabase: () => ProductionDatabaseLike | null;
  /**
   * Stop the scheduler, await any in-flight backup, `await` the export worker
   * to a safe boundary, cancel pending OAuth — WITHOUT closing the connection
   * (Phase 2L-B Item 7).
   */
  readonly quiesceBackgroundWork: () => Promise<void>;
  /** Open a `ProductionDatabase` at `databaseFile` through the normal lifecycle. */
  readonly openDatabase: () => Promise<ProductionDatabaseLike>;
  /**
   * Adopt `db` as the current production database: rebuild every DB-backed
   * service/worker against its connection, publish status, and restart
   * background work (Item 15).
   *
   * `context.restored: true` is passed ONLY when this activation follows a
   * genuinely completed database swap (the success path below) — never for a
   * `CONFIRMATION_REQUIRED` rebuild-and-resume (nothing was swapped), and
   * never for a failed-restore rollback to the pre-restore recovery copy
   * (`recoverToOriginal` — the original, continuous-timeline database, not a
   * restore). The caller uses it to run one narrow, Google-specific
   * "inspect the restored credential relationship" step BEFORE ordinary
   * background startup resumes — this module deliberately carries no
   * knowledge of what that step does (2L-B final corrections, restore-
   * specific Google quarantine).
   */
  readonly activateDatabase: (
    db: ProductionDatabaseLike,
    context?: { readonly restored: boolean },
  ) => void;
  /**
   * In-memory registry for native-dialog "Browse for a backup file…"
   * selections. Defaults to a fresh registry when omitted — injectable only
   * so tests can control its clock/TTL.
   */
  readonly browseRegistry?: BrowseCandidateRegistry;
}

export interface RestoreService {
  /**
   * The unified, read-only restore-candidate view: live catalogued backups,
   * preserved uncatalogued managed files, and configured OFF_DEVICE backups —
   * newest first. Never includes a Browse selection (Phase 2L-C).
   */
  listCandidates(): Promise<readonly RestoreCandidate[]>;
  inspect(backupId: string): Promise<RestoreCandidateInspection>;
  restore(backupId: string, confirmationToken?: string): Promise<RestoreOutcome>;
  /**
   * Verify an owner-selected file from the native file dialog and register it
   * as a one-time restore candidate. Throws a typed `AppError` when the file
   * does not pass independent verification.
   */
  browseCandidate(selectedFilePath: string): Promise<RestoreCandidate>;
}

export function createRestoreService(deps: RestoreServiceDeps): RestoreService {
  const now = deps.now ?? ((): Date => new Date());
  const tokenizer = createConfirmationTokenizer();
  const browseRegistry = deps.browseRegistry ?? createBrowseCandidateRegistry({ now });
  const { logger } = deps;

  function currentDb(): Database.Database {
    const db = deps.getCurrentDatabase();
    if (!db || db.closed || !db.connection.open) {
      throw appErrors.databaseUnavailable();
    }
    return db.connection;
  }

  function candidateSources(db: Database.Database): UnifiedCandidateSources {
    return {
      localBackupsRoot: deps.backupsRoot,
      offDeviceBackupsRoot: readOffDeviceBackupDestination(db)?.destinationPath ?? null,
    };
  }

  function logDiag(event: string, fields: Record<string, unknown>): void {
    logger.info('backup', event, fields);
  }

  async function makeVerifiedPreRestoreCopy(
    source: Database.Database,
    schemaVersion: number,
  ): Promise<{ fileName: string; filePath: string }> {
    const dir = preRestoreDir(deps.backupsRoot);
    mkdirSync(dir, { recursive: true });
    const fileName = preRestoreFileName(schemaVersion, now());
    const filePath = join(dir, fileName);
    await createSqliteSnapshot(source, filePath); // SQLite Online Backup API — never a raw copy
    const verification = verifySqliteBackup(filePath, { expectedSchemaVersion: schemaVersion });
    if (!verification.ok) {
      throw new PreRestoreCopyError(verification.errorCode);
    }
    return { fileName, filePath };
  }

  /**
   * Put the verified pre-restore recovery copy back as the operational database
   * and re-open + validate it. Returns `true` when the app is safely back on the
   * original data.
   */
  async function recoverToOriginal(preRestoreFilePath: string): Promise<boolean> {
    try {
      if (!existsSync(preRestoreFilePath) || statSync(preRestoreFilePath).size === 0) {
        return false;
      }
      const check = verifySqliteBackup(preRestoreFilePath, {
        expectedSchemaVersion: deps.targetSchemaVersion,
      });
      if (!check.ok) {
        return false;
      }
      restoreFromRecoveryCopy(preRestoreFilePath, deps.databaseFile);
      removeSqliteSidecars(deps.databaseFile);
      const recovered = await deps.openDatabase();
      assertRestoredDatabaseUsable(recovered.connection, deps.targetSchemaVersion);
      deps.activateDatabase(recovered);
      logger.info('backup', 'restore.recovered-to-original', {});
      return true;
    } catch (error) {
      logger.fatal('backup', 'restore.recovery-failed', {
        osErrorCode: sanitizedOsErrorCode(error),
      });
      return false;
    }
  }

  return {
    async listCandidates(): Promise<readonly RestoreCandidate[]> {
      const db = currentDb();
      return listRestoreCandidates(db, candidateSources(db));
    },

    async browseCandidate(selectedFilePath): Promise<RestoreCandidate> {
      return resolveBrowsedCandidate(selectedFilePath, browseRegistry);
    },

    async inspect(backupId): Promise<RestoreCandidateInspection> {
      const db = currentDb();
      let resolved;
      try {
        resolved = await resolveAndRevalidateCandidate(
          db,
          candidateSources(db),
          browseRegistry,
          backupId,
          deps.targetSchemaVersion,
        );
      } catch (error) {
        if (isAppError(error) && error.code === 'RESTORE_SCHEMA_INCOMPATIBLE') {
          // Still return a preview so the UI can explain why it is disabled.
          const candidate = previewIncompatibleCandidate(db, backupId);
          if (candidate) {
            return {
              candidate,
              compatible: false,
              incompatibleReason:
                candidate.schemaVersion < deps.targetSchemaVersion
                  ? 'SCHEMA_OLDER'
                  : 'SCHEMA_NEWER',
              newerData: null,
            };
          }
        }
        throw error;
      }

      let newerData: NewerDataLoss | null = null;
      try {
        newerData = computeNewerSaleLoss(db, resolved.filePath);
      } catch {
        /* preview only — the authoritative check runs inside restore() */
      }

      return {
        candidate: resolved.candidate,
        compatible: true,
        incompatibleReason: null,
        newerData,
      };
    },

    async restore(backupId, confirmationToken): Promise<RestoreOutcome> {
      const claim = deps.coordinator.tryAcquireExclusive('RESTORE');
      if (!claim.ok) {
        if (claim.reason === 'RESTORE_IN_PROGRESS') {
          throw appErrors.restoreAlreadyRunning();
        }
        if (claim.reason === 'MIGRATION_IN_PROGRESS') {
          throw appErrors.maintenanceInProgress();
        }
        if (claim.cardReconciliationPending) {
          throw appErrors.restoreBlockedCardPending();
        }
        throw appErrors.restoreBlockedCheckoutActive();
      }

      let released = false;
      const release = (): void => {
        if (!released) {
          released = true;
          claim.release();
        }
      };
      let quiesced = false;

      try {
        const current = deps.getCurrentDatabase();
        if (!current || current.closed || !current.connection.open) {
          throw appErrors.databaseUnavailable();
        }

        // 2. Quiesce background DB work (does NOT close the connection).
        await deps.quiesceBackgroundWork();
        quiesced = true;

        // 3. Revalidate the candidate from scratch.
        const candidate = await resolveAndRevalidateCandidate(
          current.connection,
          candidateSources(current.connection),
          browseRegistry,
          backupId,
          deps.targetSchemaVersion,
        );

        // 4. Fresh, verified pre-restore recovery copy of the CURRENT DB while healthy.
        const preRestore = await makeVerifiedPreRestoreCopy(
          current.connection,
          current.schemaVersion,
        );
        logDiag('restore.pre-restore-copy.verified', { fileName: preRestore.fileName });

        // 5. Recompute the stronger-warning content (newer completed sales the
        // backup does not have, by Sale ID) and the material-business-state
        // fingerprint against the live DB. The fingerprint hashes explicit
        // canonical business tables/settings (`materialRestoreStateFingerprint`)
        // rather than the whole pre-restore snapshot file: a whole-file checksum
        // also reacts to secondary bookkeeping (Google export-job delivery
        // churn, Google connectivity/auth-health settings, a due automatic
        // backup's new `backup_records` row, its `BACKUP_*` audit event) that
        // restore's own post-`CONFIRMATION_REQUIRED` service restart can trigger
        // immediately — manufacturing a false stale confirmation with zero user
        // action (2L-B final corrections, replacing the Item 1 whole-snapshot
        // fingerprint).
        const loss = computeNewerSaleLoss(current.connection, candidate.filePath);
        const fingerprint = materialRestoreStateFingerprint(current.connection);

        // 6. Confirmation gate — ALWAYS required (Policy 1, 2L-B final
        // corrections): every whole-database restore needs one explicit
        // confirmation, whether or not a newer completed sale is detected, so a
        // void/inventory-adjustment/product-or-customer-edit/setting-change-only
        // restore can never silently proceed. `loss` is carried only as the
        // stronger warning's content when present; it no longer gates whether
        // confirmation exists at all. Never hold the lock for user input.
        const valid = tokenizer.verify(
          confirmationToken,
          candidate.checksum,
          fingerprint,
          now().getTime(),
        );
        if (!valid) {
          const fresh = tokenizer.mint(candidate.checksum, fingerprint, now().getTime());
          release();
          deps.activateDatabase(current); // rebuild + resume — we did not swap
          if (confirmationToken !== undefined) {
            logDiag('restore.confirmation.stale', {});
          } else {
            logDiag('restore.confirmation.required', {
              transactionCount: loss?.transactionCount ?? 0,
            });
          }
          return { outcome: 'CONFIRMATION_REQUIRED', newerData: loss, confirmationToken: fresh };
        }

        // 7. Crash-consistent marker BEFORE anything destructive.
        writeRestoreMarker(deps.userDataDir, {
          version: 1,
          preRestoreFileName: preRestore.fileName,
          startedAt: now().toISOString(),
        });

        // 8. Close the operational connection.
        current.close();

        // 9. Windows-safe swap: stage candidate → drop old sidecars → activate.
        try {
          stageAndActivate(candidate.filePath, deps.databaseFile);
        } catch (swapError) {
          logger.error('backup', 'restore.swap-failed', {
            osErrorCode: sanitizedOsErrorCode(swapError),
          });
          await recoverToOriginal(preRestore.filePath);
          clearRestoreMarker(deps.userDataDir);
          release();
          throw appErrors.restoreValidationFailed();
        }

        // 10-12. Reopen + validate the restored database.
        let reopened: ProductionDatabaseLike | null = null;
        try {
          reopened = await deps.openDatabase();
          assertRestoredDatabaseUsable(reopened.connection, deps.targetSchemaVersion);
        } catch (validationError) {
          logger.error('backup', 'restore.validation-failed', {
            osErrorCode: sanitizedOsErrorCode(validationError),
          });
          // A partially-usable reopen must not stay pointed-to.
          try {
            reopened?.close();
          } catch {
            /* ignore */
          }
          const recovered = await recoverToOriginal(preRestore.filePath);
          if (!recovered) {
            // Keep the marker so the next launch retries recovery.
            release();
            throw appErrors.restoreRecoveryFailed();
          }
          clearRestoreMarker(deps.userDataDir);
          release();
          throw appErrors.restoreValidationFailed();
        }

        // 13. Success — adopt the restored DB, rewire every service, resume work.
        deps.activateDatabase(reopened, { restored: true });
        discardPreviousMain(deps.databaseFile);
        clearRestoreMarker(deps.userDataDir);
        release();
        logger.info('backup', 'restore.completed', {
          restoredSchemaVersion: reopened.schemaVersion,
          candidateType: candidate.candidate.backupType,
        });
        return {
          outcome: 'COMPLETED',
          restoredSchemaVersion: reopened.schemaVersion,
          restoredFromCreatedAt: candidate.candidate.createdAt,
        };
      } catch (error) {
        // Any failure BEFORE the swap (candidate/pre-restore/validation of
        // inputs): the connection was never closed. Bring background work back
        // and release. Failures AFTER the swap are already handled inline.
        if (!released) {
          release();
          if (quiesced) {
            const stillCurrent = deps.getCurrentDatabase();
            if (stillCurrent && !stillCurrent.closed && stillCurrent.connection.open) {
              deps.activateDatabase(stillCurrent);
            }
          }
        }
        if (error instanceof PreRestoreCopyError) {
          logger.error('backup', 'restore.pre-restore-copy-failed', { errorCode: error.errorCode });
          throw appErrors.restoreValidationFailed();
        }
        throw error;
      }
    },
  };
}
