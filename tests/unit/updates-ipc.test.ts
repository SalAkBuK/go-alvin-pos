import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const electron = vi.hoisted(() => ({
  app: { isPackaged: false },
  BrowserWindow: class {},
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
}));
vi.mock('electron', () => electron);

import type { Logger } from '../../src/main/app/logger';
import type { RendererEntry } from '../../src/main/app/rendererEntry';
import { registerUpdatesIpcHandlers } from '../../src/main/ipc/updatesIpc';
import type { UpdateService } from '../../src/main/updater/updateService';
import type { UpdateServiceSnapshot } from '../../src/shared/update';
import { IPC } from '../../src/shared/ipc';

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

const baseSnapshot: UpdateServiceSnapshot = {
  state: 'IDLE',
  currentVersion: '1.0.0',
  availableVersion: null,
  progressPercent: null,
  lastCheckedAt: null,
  failureCode: null,
};

function fakeUpdateService(overrides?: Partial<UpdateService>): UpdateService {
  return {
    getSnapshot: () => baseSnapshot,
    start: () => undefined,
    stopSync: () => undefined,
    running: false,
    checkNow: () => Promise.resolve(baseSnapshot),
    restartAndInstall: () => ({ code: 'UNSUPPORTED' }),
    ...overrides,
  };
}

afterEach(() => vi.clearAllMocks());

describe('updates IPC', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('registers exactly get-status, check-now, and restart-and-install', () => {
    registerUpdatesIpcHandlers({
      logger,
      updateService: fakeUpdateService(),
      rendererEntry: entry,
    });
    expect([...handlers.keys()].sort()).toEqual(
      [IPC.updatesGetStatus, IPC.updatesCheckNow, IPC.updatesRestartAndInstall].sort(),
    );
  });

  it('rejects untrusted senders on all three channels', async () => {
    registerUpdatesIpcHandlers({
      logger,
      updateService: fakeUpdateService(),
      rendererEntry: entry,
    });
    for (const handler of handlers.values()) {
      await expect(handler(untrustedEvent())).rejects.toThrow(/untrusted sender/i);
    }
  });

  it('get-status returns exactly the normalized snapshot — no raw updater object', async () => {
    const service = fakeUpdateService({
      getSnapshot: () => ({ ...baseSnapshot, state: 'AVAILABLE', availableVersion: '1.2.0' }),
    });
    registerUpdatesIpcHandlers({ logger, updateService: service, rendererEntry: entry });

    const result = (await handlers.get(IPC.updatesGetStatus)!(trustedEvent())) as {
      ok: true;
      data: UpdateServiceSnapshot;
    };
    expect(result).toEqual({
      ok: true,
      data: { ...baseSnapshot, state: 'AVAILABLE', availableVersion: '1.2.0' },
    });
  });

  it('check-now calls the existing service and ignores any renderer-supplied argument', async () => {
    const checkNow = vi.fn(() => Promise.resolve({ ...baseSnapshot, state: 'IDLE' as const }));
    const service = fakeUpdateService({ checkNow });
    registerUpdatesIpcHandlers({ logger, updateService: service, rendererEntry: entry });

    const result = (await handlers.get(IPC.updatesCheckNow)!(trustedEvent(), {
      url: 'https://evil.example/feed/',
      version: '99.0.0',
    })) as { ok: true; data: UpdateServiceSnapshot };

    // Called with no meaningful args — the renderer-supplied object above is
    // never forwarded to the service.
    expect(checkNow).toHaveBeenCalledTimes(1);
    expect(checkNow.mock.calls[0]).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('restart-and-install returns exactly the service result and accepts no renderer argument', async () => {
    const restartAndInstall = vi.fn(() => ({ code: 'INSTALL_ACCEPTED' as const }));
    const service = fakeUpdateService({ restartAndInstall });
    registerUpdatesIpcHandlers({ logger, updateService: service, rendererEntry: entry });

    const result = (await handlers.get(IPC.updatesRestartAndInstall)!(trustedEvent(), {
      path: 'C:\\evil\\installer.exe',
      force: true,
    })) as { ok: true; data: { code: string } };

    expect(restartAndInstall).toHaveBeenCalledTimes(1);
    expect(restartAndInstall.mock.calls[0]).toEqual([]);
    expect(result).toEqual({ ok: true, data: { code: 'INSTALL_ACCEPTED' } });
    expect(JSON.stringify(result)).not.toContain('installer.exe');
  });

  it('every maintenance-denial code from restartAndInstall crosses the IPC boundary unchanged', async () => {
    for (const code of [
      'NOT_READY',
      'UNSUPPORTED',
      'CHECKOUT_ACTIVE',
      'TRANSACTION_IN_FLIGHT',
      'MIGRATION_IN_PROGRESS',
      'RESTORE_IN_PROGRESS',
      'INSTALL_FAILED',
    ] as const) {
      handlers.clear();
      const service = fakeUpdateService({ restartAndInstall: () => ({ code }) });
      registerUpdatesIpcHandlers({ logger, updateService: service, rendererEntry: entry });
      const result = (await handlers.get(IPC.updatesRestartAndInstall)!(trustedEvent())) as {
        ok: true;
        data: { code: string };
      };
      expect(result).toEqual({ ok: true, data: { code } });
    }
  });

  it('all three channels are served during exclusive maintenance (no database dependency)', async () => {
    const { setExclusiveMaintenance } =
      await import('../../src/main/maintenance/maintenanceStatus');
    setExclusiveMaintenance('RESTORE');
    try {
      const service = fakeUpdateService({
        restartAndInstall: () => ({ code: 'RESTORE_IN_PROGRESS' as const }),
      });
      registerUpdatesIpcHandlers({ logger, updateService: service, rendererEntry: entry });

      const status = (await handlers.get(IPC.updatesGetStatus)!(trustedEvent())) as { ok: boolean };
      const check = (await handlers.get(IPC.updatesCheckNow)!(trustedEvent())) as { ok: boolean };
      const install = (await handlers.get(IPC.updatesRestartAndInstall)!(trustedEvent())) as {
        ok: true;
        data: { code: string };
      };
      expect(status.ok).toBe(true);
      expect(check.ok).toBe(true);
      // Reaches the handler (not blanket-refused with generic MAINTENANCE_IN_PROGRESS)
      // and returns the specific reason instead.
      expect(install).toEqual({ ok: true, data: { code: 'RESTORE_IN_PROGRESS' } });
    } finally {
      setExclusiveMaintenance(null);
    }
  });
});
