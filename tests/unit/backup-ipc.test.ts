import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const electron = vi.hoisted(() => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
}));
vi.mock('electron', () => electron);

import { registerBackupIpcHandlers } from '../../src/main/ipc/backupIpc';
import { IPC } from '../../src/shared/ipc';
import type { RendererEntry } from '../../src/main/app/rendererEntry';
import type { Logger } from '../../src/main/app/logger';
import type { BackupService } from '../../src/main/backup/backupService';
import type { RestoreService } from '../../src/main/backup/restoreService';
import type { BackupHealth } from '../../src/shared/backup';

const entry: RendererEntry = {
  devServerUrl: 'http://localhost:5173',
  fileEntryPath: 'C:\\app\\out\\renderer\\index.html',
  fileEntryUrl: 'file:///C:/app/out/renderer/index.html',
};
const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
} as unknown as Logger;

const trustedEvent = () => ({
  senderFrame: { url: 'http://localhost:5173/index.html', parent: null },
});
const untrustedEvent = () => ({ senderFrame: { url: 'https://evil.example/', parent: null } });

const HEALTH: BackupHealth = {
  lastAutomatic: { outcome: 'COMPLETED', at: '2026-09-10T08:00:00.000Z' },
  lastSuccessfulAutomaticAt: '2026-09-10T08:00:00.000Z',
  overdue: false,
  lastFailure: null,
  protection: 'LOCAL_DISK_ONLY',
  automaticEnabled: true,
  schedule: { cadence: 'DAILY', atLocalTime: '03:00' },
};

afterEach(() => vi.clearAllMocks());

describe('backup IPC registration', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('registers the backup + restore channels', () => {
    registerBackupIpcHandlers({
      logger,
      getBackupService: () => null,
      getRestoreService: () => null,
      rendererEntry: entry,
    });
    expect([...handlers.keys()].sort()).toEqual(
      [
        IPC.backupStatus,
        IPC.backupStatusVerified,
        IPC.backupCreateManual,
        IPC.backupListRestoreCandidates,
        IPC.backupInspectRestoreCandidate,
        IPC.backupRestore,
        IPC.backupBrowseRestoreCandidate,
        IPC.backupConfigureOffDevice,
        IPC.backupClearOffDevice,
        IPC.backupOffDeviceConfiguration,
      ].sort(),
    );
  });

  it('rejects an untrusted sender on every channel', async () => {
    registerBackupIpcHandlers({
      logger,
      getBackupService: () => null,
      getRestoreService: () => null,
      rendererEntry: entry,
    });
    for (const channel of handlers.keys()) {
      await expect(handlers.get(channel)!(untrustedEvent())).rejects.toThrow(/untrusted sender/i);
    }
  });

  it('returns DATABASE_UNAVAILABLE (typed, no leak) when the service is not ready', async () => {
    registerBackupIpcHandlers({
      logger,
      getBackupService: () => null,
      getRestoreService: () => null,
      rendererEntry: entry,
    });
    const result = (await handlers.get(IPC.backupStatus)!(trustedEvent())) as {
      ok: false;
      error: { code: string; message: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('DATABASE_UNAVAILABLE');
    expect(result.error.message).not.toMatch(/sqlite|C:\\|SELECT/i);
  });

  it('status forwards the service DTO; create-manual forwards a no-argument call', async () => {
    const service = {
      status: vi.fn(() => HEALTH),
      createManual: vi.fn(async () => ({
        status: 'COMPLETED' as const,
        fileName: 'gophones-manual-v1-x.sqlite',
        sizeBytes: 8192,
        completedAt: '2026-09-10T09:00:00.000Z',
        locationKind: 'LOCAL_DISK' as const,
      })),
      runAutomaticIfDue: vi.fn(),
      busy: false,
    } as unknown as BackupService;

    registerBackupIpcHandlers({
      logger,
      getBackupService: () => service,
      getRestoreService: () => null,
      rendererEntry: entry,
    });

    const status = (await handlers.get(IPC.backupStatus)!(trustedEvent())) as {
      ok: true;
      data: BackupHealth;
    };
    expect(status).toEqual({ ok: true, data: HEALTH });

    const manual = (await handlers.get(IPC.backupCreateManual)!(trustedEvent(), {
      path: 'C:\\evil',
    })) as { ok: true; data: { fileName: string } };
    expect(manual.ok).toBe(true);
    expect(manual.data.fileName).toBe('gophones-manual-v1-x.sqlite');
    // The handler ignores any renderer-provided argument entirely.
    expect((service.createManual as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([]);
  });

  it('maps a BACKUP_IN_PROGRESS AppError to a typed result', async () => {
    const { appErrors } = await import('../../src/main/shared/appError');
    const service = {
      status: vi.fn(() => HEALTH),
      createManual: vi.fn(async () => {
        throw appErrors.backupInProgress();
      }),
      runAutomaticIfDue: vi.fn(),
      busy: true,
    } as unknown as BackupService;
    registerBackupIpcHandlers({
      logger,
      getBackupService: () => service,
      getRestoreService: () => null,
      rendererEntry: entry,
    });
    const result = (await handlers.get(IPC.backupCreateManual)!(trustedEvent())) as {
      ok: false;
      error: { code: string };
    };
    expect(result).toEqual({
      ok: false,
      error: { code: 'BACKUP_IN_PROGRESS', message: expect.stringMatching(/already running/i) },
    });
  });

  describe('Phase 2L-C: OFF_DEVICE + unified discovery + Browse', () => {
    it('status-verified forwards to the live-reverified DTO', async () => {
      const verifiedHealth = { ...HEALTH, protection: 'OFF_DEVICE' as const };
      const service = {
        statusVerified: vi.fn(async () => verifiedHealth),
      } as unknown as BackupService;
      registerBackupIpcHandlers({
        logger,
        getBackupService: () => service,
        getRestoreService: () => null,
        rendererEntry: entry,
      });
      const result = (await handlers.get(IPC.backupStatusVerified)!(trustedEvent())) as {
        ok: true;
        data: BackupHealth;
      };
      expect(result).toEqual({ ok: true, data: verifiedHealth });
    });

    it('browse-restore-candidate resolves null on a cancelled dialog without touching the service', async () => {
      const restoreSvc = { browseCandidate: vi.fn() } as unknown as RestoreService;
      registerBackupIpcHandlers({
        logger,
        getBackupService: () => null,
        getRestoreService: () => restoreSvc,
        rendererEntry: entry,
        // no showBackupFileDialog — simulates no dialog available
      });
      const result = (await handlers.get(IPC.backupBrowseRestoreCandidate)!(trustedEvent())) as {
        ok: true;
        data: null;
      };
      expect(result).toEqual({ ok: true, data: null });
      expect(restoreSvc.browseCandidate).not.toHaveBeenCalled();
    });

    it('browse-restore-candidate forwards the dialog selection to the service', async () => {
      const candidate = {
        backupId: 'browsed-abc',
        backupType: 'MANUAL' as const,
        createdAt: '2026-09-11T10:00:00.000Z',
        sourceAppVersion: 'test',
        schemaVersion: 1,
        sizeBytes: 4096,
        locationKind: 'LOCAL_DISK' as const,
        sourceKind: 'BROWSED' as const,
        catalogued: false,
      };
      const restoreSvc = {
        browseCandidate: vi.fn(async () => candidate),
      } as unknown as RestoreService;
      registerBackupIpcHandlers({
        logger,
        getBackupService: () => null,
        getRestoreService: () => restoreSvc,
        rendererEntry: entry,
        showBackupFileDialog: async () => 'C:\\selected\\backup.sqlite',
      });
      const result = (await handlers.get(IPC.backupBrowseRestoreCandidate)!(trustedEvent())) as {
        ok: true;
        data: typeof candidate;
      };
      expect(result).toEqual({ ok: true, data: candidate });
      expect(restoreSvc.browseCandidate).toHaveBeenCalledWith('C:\\selected\\backup.sqlite');
    });

    it('browse-restore-candidate ignores any renderer-supplied argument — only the main-owned dialog selection is ever used', async () => {
      const candidate = {
        backupId: 'browsed-real',
        backupType: 'MANUAL' as const,
        createdAt: '2026-09-11T10:00:00.000Z',
        sourceAppVersion: 'test',
        schemaVersion: 1,
        sizeBytes: 2048,
        locationKind: 'LOCAL_DISK' as const,
        sourceKind: 'BROWSED' as const,
        catalogued: false,
      };
      const restoreSvc = {
        browseCandidate: vi.fn(async () => candidate),
      } as unknown as RestoreService;
      registerBackupIpcHandlers({
        logger,
        getBackupService: () => null,
        getRestoreService: () => restoreSvc,
        rendererEntry: entry,
        showBackupFileDialog: async () => 'C:\\dialog-owned\\backup.sqlite',
      });
      // A hostile/buggy renderer invoking with extra args — the handler takes
      // no renderer-supplied parameters at all, so this must have no effect.
      const result = (await handlers.get(IPC.backupBrowseRestoreCandidate)!(
        trustedEvent(),
        { backupId: '../../evil/path.sqlite' },
        'C:\\evil\\path.sqlite',
      )) as { ok: true; data: typeof candidate };
      expect(result).toEqual({ ok: true, data: candidate });
      expect(restoreSvc.browseCandidate).toHaveBeenCalledWith('C:\\dialog-owned\\backup.sqlite');
      expect(restoreSvc.browseCandidate).not.toHaveBeenCalledWith('C:\\evil\\path.sqlite');
      expect(restoreSvc.browseCandidate).not.toHaveBeenCalledWith('../../evil/path.sqlite');
    });

    it('configure-off-device returns the unchanged configuration on a cancelled dialog', async () => {
      const current = { configured: false as const };
      const service = {
        offDeviceConfiguration: vi.fn(async () => current),
        configureOffDevice: vi.fn(),
      } as unknown as BackupService;
      registerBackupIpcHandlers({
        logger,
        getBackupService: () => service,
        getRestoreService: () => null,
        rendererEntry: entry,
        // no showOffDeviceDirectoryDialog — simulates a cancelled/unavailable dialog
      });
      const result = (await handlers.get(IPC.backupConfigureOffDevice)!(trustedEvent())) as {
        ok: true;
        data: typeof current;
      };
      expect(result).toEqual({ ok: true, data: current });
      expect(service.configureOffDevice).not.toHaveBeenCalled();
    });

    it('configure-off-device forwards the dialog selection and never the renderer', async () => {
      const configured = {
        configured: true as const,
        destinationKind: 'USB' as const,
        displayName: 'External USB drive (E:)',
        updatedAt: '2026-09-11T10:00:00.000Z',
        verified: true,
      };
      const service = {
        configureOffDevice: vi.fn(async () => configured),
      } as unknown as BackupService;
      registerBackupIpcHandlers({
        logger,
        getBackupService: () => service,
        getRestoreService: () => null,
        rendererEntry: entry,
        showOffDeviceDirectoryDialog: async () => 'E:\\Picked Folder',
      });
      const result = (await handlers.get(IPC.backupConfigureOffDevice)!(trustedEvent(), {
        selectedDirectory: 'C:\\evil',
      })) as { ok: true; data: typeof configured };
      expect(result).toEqual({ ok: true, data: configured });
      expect(service.configureOffDevice).toHaveBeenCalledWith('E:\\Picked Folder');
    });

    it('clear-off-device and off-device-configuration forward to the service', async () => {
      const cleared = { configured: false as const };
      const service = {
        clearOffDevice: vi.fn(async () => cleared),
        offDeviceConfiguration: vi.fn(async () => cleared),
      } as unknown as BackupService;
      registerBackupIpcHandlers({
        logger,
        getBackupService: () => service,
        getRestoreService: () => null,
        rendererEntry: entry,
      });
      expect(await handlers.get(IPC.backupClearOffDevice)!(trustedEvent())).toEqual({
        ok: true,
        data: cleared,
      });
      expect(await handlers.get(IPC.backupOffDeviceConfiguration)!(trustedEvent())).toEqual({
        ok: true,
        data: cleared,
      });
    });
  });
});
