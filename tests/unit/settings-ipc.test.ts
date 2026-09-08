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

import { registerSettingsIpcHandlers } from '../../src/main/ipc/settingsIpc';
import { IPC } from '../../src/shared/ipc';
import type { RendererEntry } from '../../src/main/app/rendererEntry';
import type { Logger } from '../../src/main/app/logger';

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

const CHANNELS = [IPC.settingsTaxGet, IPC.settingsTaxUpdate];

beforeEach(() => {
  handlers.clear();
  registerSettingsIpcHandlers({
    logger,
    getDatabase: () => null,
    appVersion: 'test',
    rendererEntry: entry,
  });
});
afterEach(() => vi.clearAllMocks());

describe('settings IPC registration', () => {
  it('registers exactly the two tax channels — no generic settings setter', () => {
    expect([...handlers.keys()].sort()).toEqual([...CHANNELS].sort());
    for (const channel of handlers.keys()) {
      expect(channel).not.toMatch(/^settings:set$/);
      expect(channel).toMatch(/^settings:tax-(get|update)$/);
    }
  });

  it('every channel rejects an untrusted sender', async () => {
    for (const channel of CHANNELS) {
      await expect(handlers.get(channel)!(untrustedEvent())).rejects.toThrow(/untrusted sender/i);
    }
  });

  it('a trusted request with no database returns a typed DATABASE_UNAVAILABLE result (no throw)', async () => {
    const result = (await handlers.get(IPC.settingsTaxGet)!(trustedEvent())) as {
      ok: false;
      error: { code: string; message: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('DATABASE_UNAVAILABLE');
    expect(result.error.message).not.toMatch(/sqlite|C:\\|SELECT/i);
  });
});
