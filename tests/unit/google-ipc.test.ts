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

import { registerGoogleIpcHandlers } from '../../src/main/ipc/googleIpc';
import { IPC } from '../../src/shared/ipc';
import type { Logger } from '../../src/main/app/logger';
import type { RendererEntry } from '../../src/main/app/rendererEntry';

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

const CHANNELS = [
  IPC.googleGetConfig,
  IPC.googleConnect,
  IPC.googleRetrySetup,
  IPC.googleSetEnabled,
  IPC.googleOpenSpreadsheet,
  IPC.googleDisconnect,
  IPC.googleRetryExport,
];

beforeEach(() => {
  handlers.clear();
  registerGoogleIpcHandlers({
    logger,
    getDatabase: () => null,
    appVersion: 'test',
    rendererEntry: entry,
    createService: () => {
      throw new Error('createService should not be reached without a database');
    },
  });
});
afterEach(() => vi.clearAllMocks());

describe('google IPC registration', () => {
  it('registers exactly the seven narrow channels — no credential/spreadsheet/HTTP surface', () => {
    expect([...handlers.keys()].sort()).toEqual([...CHANNELS].sort());
    for (const channel of handlers.keys()) {
      expect(channel).toMatch(
        /^google:(get-config|connect|retry-setup|set-enabled|open-spreadsheet|disconnect|retry-export)$/,
      );
      expect(channel).not.toMatch(
        /credential|json|picker|spreadsheet-id|worksheet|query|exec|sql|http|fetch/,
      );
    }
  });

  it('every channel rejects an untrusted sender', async () => {
    for (const channel of CHANNELS) {
      await expect(handlers.get(channel)!(untrustedEvent())).rejects.toThrow(/untrusted sender/i);
    }
  });

  it.each(CHANNELS)(
    'a trusted request to %s with no database returns a typed DATABASE_UNAVAILABLE result',
    async (channel) => {
      const result = (await handlers.get(channel)!(trustedEvent(), {
        saleId: 's1',
        enabled: true,
      })) as {
        ok: false;
        error: { code: string; message: string };
      };
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('DATABASE_UNAVAILABLE');
      expect(result.error.message).not.toMatch(/sqlite|C:\\|SELECT|refresh_token|ya29/i);
    },
  );
});
