import { IPC } from '../../shared/ipc';
import type {
  BackupHealth,
  ManualBackupResult,
  OffDeviceBackupConfiguration,
} from '../../shared/backup';
import type {
  RestoreCandidate,
  RestoreCandidateInspection,
  RestoreOutcome,
  RestoreRequest,
} from '../../shared/restore';
import type { Logger } from '../app/logger';
import type { RendererEntry } from '../app/rendererEntry';
import type { BackupService } from '../backup/backupService';
import type { RestoreService } from '../backup/restoreService';
import { appErrors } from '../shared/appError';
import { registerTrustedInvoke } from './trustedInvoke';

/**
 * Registers the Backup & Restore IPC channels
 * (`REQ-BACKUP-001`, `REQ-BACKUP-007`, `REQ-BACKUP-010`, `REQ-BACKUP-011`;
 * `POS_WORKFLOWS.md §65`, `§67`, `§67A`, `§67B`, `§96`; Phase 2L / 2L-B / 2L-C).
 *
 *  - `backup:status` — read-only, NOT live-reverified backup-health DTO.
 *  - `backup:status-verified` — the same DTO, but OFF_DEVICE protection is
 *    freshly reverified first. For a Settings-page load/refresh, not a poll.
 *  - `backup:create-manual` — owner `Back Up Now` (no arguments).
 *  - `backup:list-restore-candidates` — the unified read-only restore view:
 *    live catalogued backups, preserved uncatalogued managed files, and
 *    configured OFF_DEVICE backups, as opaque `{ backupId }` + safe metadata.
 *    No path, filename, or SQL. Never includes a Browse selection.
 *  - `backup:inspect-restore-candidate` — read-only preview of one candidate
 *    (metadata, compatibility, newer-data loss). No lock, no copy.
 *  - `backup:restore` — the guarded whole-database restore. Bypasses the
 *    exclusive-maintenance gate (it is the operation that acquires it); a second
 *    concurrent call is refused with `RESTORE_ALREADY_RUNNING`.
 *  - `backup:browse-restore-candidate` — shows the native "Browse for a
 *    backup file…" dialog; a cancelled dialog resolves `data: null`.
 *  - `backup:configure-off-device` / `backup:clear-off-device` /
 *    `backup:off-device-configuration` — owner-initiated OFF_DEVICE setup.
 *    `configure`/`clear` take no renderer-supplied path; the main process owns
 *    the native directory dialog. A cancelled directory dialog resolves the
 *    unchanged current configuration.
 *
 * The renderer never supplies a filesystem path or raw `storage_path` — it
 * names only an opaque `backupId`/token and (past a newer-data warning) an
 * opaque `confirmationToken`.
 */

export interface BackupIpcContext {
  readonly logger: Logger;
  readonly getBackupService: () => BackupService | null;
  readonly getRestoreService: () => RestoreService | null;
  readonly rendererEntry?: RendererEntry;
  /** Native directory-selection dialog; `null` resolves a cancelled selection. */
  readonly showOffDeviceDirectoryDialog?: () => Promise<string | null>;
  /** Native file-open dialog for "Browse for a backup file…"; `null` = cancelled. */
  readonly showBackupFileDialog?: () => Promise<string | null>;
}

export function registerBackupIpcHandlers(context: BackupIpcContext): void {
  const trusted = {
    logger: context.logger,
    ...(context.rendererEntry ? { rendererEntry: context.rendererEntry } : {}),
  };

  function backup(): BackupService {
    const svc = context.getBackupService();
    if (!svc) {
      throw appErrors.databaseUnavailable();
    }
    return svc;
  }

  function restore(): RestoreService {
    const svc = context.getRestoreService();
    if (!svc) {
      throw appErrors.databaseUnavailable();
    }
    return svc;
  }

  registerTrustedInvoke(IPC.backupStatus, trusted, (): BackupHealth => backup().status());

  registerTrustedInvoke(IPC.backupStatusVerified, trusted, (): Promise<BackupHealth> =>
    backup().statusVerified(),
  );

  registerTrustedInvoke(IPC.backupCreateManual, trusted, (): Promise<ManualBackupResult> =>
    backup().createManual(),
  );

  registerTrustedInvoke(
    IPC.backupListRestoreCandidates,
    trusted,
    (): Promise<readonly RestoreCandidate[]> => restore().listCandidates(),
  );

  registerTrustedInvoke(
    IPC.backupBrowseRestoreCandidate,
    trusted,
    async (): Promise<RestoreCandidate | null> => {
      const selected = await context.showBackupFileDialog?.();
      if (selected === null || selected === undefined) {
        return null;
      }
      return restore().browseCandidate(selected);
    },
  );

  registerTrustedInvoke(
    IPC.backupConfigureOffDevice,
    trusted,
    async (): Promise<OffDeviceBackupConfiguration> => {
      const selected = await context.showOffDeviceDirectoryDialog?.();
      if (selected === null || selected === undefined) {
        return backup().offDeviceConfiguration();
      }
      return backup().configureOffDevice(selected);
    },
  );

  registerTrustedInvoke(
    IPC.backupClearOffDevice,
    trusted,
    (): Promise<OffDeviceBackupConfiguration> => backup().clearOffDevice(),
  );

  registerTrustedInvoke(
    IPC.backupOffDeviceConfiguration,
    trusted,
    (): Promise<OffDeviceBackupConfiguration> => backup().offDeviceConfiguration(),
  );

  registerTrustedInvoke(
    IPC.backupInspectRestoreCandidate,
    trusted,
    (raw): Promise<RestoreCandidateInspection> =>
      restore().inspect(String((raw as { backupId?: unknown } | null)?.backupId ?? '')),
  );

  registerTrustedInvoke(
    IPC.backupRestore,
    trusted,
    (raw): Promise<RestoreOutcome> => {
      const input = (raw ?? {}) as RestoreRequest;
      return restore().restore(
        String(input.backupId ?? ''),
        typeof input.confirmationToken === 'string' ? input.confirmationToken : undefined,
      );
    },
    { allowDuringExclusiveMaintenance: true },
  );
}
