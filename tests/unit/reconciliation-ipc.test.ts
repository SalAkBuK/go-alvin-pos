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

import { registerReconciliationIpcHandlers } from '../../src/main/ipc/reconciliationIpc';
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
  registerReconciliationIpcHandlers({ logger, getDatabase: () => null, rendererEntry: entry });
});
afterEach(() => vi.clearAllMocks());

describe('reconciliation IPC registration', () => {
  it('registers exactly reconciliation:list and reconciliation:resolve', () => {
    expect([...handlers.keys()].sort()).toEqual(
      [IPC.reconciliationList, IPC.reconciliationResolve].sort(),
    );
  });

  it('rejects an untrusted sender on every channel', async () => {
    for (const channel of handlers.keys()) {
      await expect(handlers.get(channel)!(untrustedEvent())).rejects.toThrow(/untrusted sender/i);
    }
  });

  it('list with no database returns a typed DATABASE_UNAVAILABLE result (no throw, no leak)', async () => {
    const result = (await handlers.get(IPC.reconciliationList)!(trustedEvent())) as {
      ok: false;
      error: { code: string; message: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('DATABASE_UNAVAILABLE');
    expect(result.error.message).not.toMatch(/sqlite|C:\\|SELECT/i);
  });

  it('resolve with no database returns a typed DATABASE_UNAVAILABLE result', async () => {
    const result = (await handlers.get(IPC.reconciliationResolve)!(trustedEvent(), {
      requestId: 'r1',
      note: 'x',
    })) as { ok: false; error: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('DATABASE_UNAVAILABLE');
  });
});
