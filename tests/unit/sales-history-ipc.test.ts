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

import { registerSalesHistoryIpcHandlers } from '../../src/main/ipc/salesHistoryIpc';
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

beforeEach(() => {
  handlers.clear();
  registerSalesHistoryIpcHandlers({
    logger,
    getDatabase: () => null,
    appVersion: 'test',
    rendererEntry: entry,
  });
});
afterEach(() => vi.clearAllMocks());

describe('sales-history IPC registration', () => {
  it('registers exactly sales-history:list, :get-by-id and :void', () => {
    expect([...handlers.keys()].sort()).toEqual(
      [IPC.salesHistoryList, IPC.salesHistoryGetById, IPC.salesHistoryVoid].sort(),
    );
  });

  it('rejects an untrusted sender on every channel', async () => {
    for (const channel of handlers.keys()) {
      await expect(handlers.get(channel)!(untrustedEvent())).rejects.toThrow(/untrusted sender/i);
    }
  });

  it('list with no database returns a typed DATABASE_UNAVAILABLE result (no throw, no leak)', async () => {
    const result = (await handlers.get(IPC.salesHistoryList)!(trustedEvent())) as {
      ok: false;
      error: { code: string; message: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('DATABASE_UNAVAILABLE');
    expect(result.error.message).not.toMatch(/sqlite|C:\\|SELECT/i);
  });

  it('get-by-id with no database returns a typed DATABASE_UNAVAILABLE result', async () => {
    const result = (await handlers.get(IPC.salesHistoryGetById)!(trustedEvent(), 's1')) as {
      ok: false;
      error: { code: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('DATABASE_UNAVAILABLE');
  });

  it('void with no database returns a typed DATABASE_UNAVAILABLE result (no throw, no leak)', async () => {
    const result = (await handlers.get(IPC.salesHistoryVoid)!(trustedEvent(), {
      saleId: 's1',
      reason: 'test',
    })) as { ok: false; error: { code: string; message: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('DATABASE_UNAVAILABLE');
    expect(result.error.message).not.toMatch(/sqlite|C:\\|UPDATE|BEGIN/i);
  });
});
