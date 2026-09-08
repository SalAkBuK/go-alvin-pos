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

import { registerCheckoutIpcHandlers } from '../../src/main/ipc/checkoutIpc';
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
  registerCheckoutIpcHandlers({ logger, getDatabase: () => null, rendererEntry: entry });
});
afterEach(() => vi.clearAllMocks());

describe('checkout IPC registration', () => {
  it('registers exactly the one checkout:review channel', () => {
    expect([...handlers.keys()]).toEqual([IPC.checkoutReview]);
  });

  it('defines no checkout:complete (or any sale-completing) channel', () => {
    for (const channel of handlers.keys()) {
      expect(channel).not.toMatch(/complete|commit|pay|sale/i);
    }
  });

  it('rejects a request from an untrusted sender', async () => {
    await expect(handlers.get(IPC.checkoutReview)!(untrustedEvent())).rejects.toThrow(
      /untrusted sender/i,
    );
  });

  it('a trusted request with no database returns a typed DATABASE_UNAVAILABLE result (no throw)', async () => {
    const result = (await handlers.get(IPC.checkoutReview)!(trustedEvent(), {
      customerId: null,
      paymentMethod: 'CASH',
      lines: [],
    })) as { ok: false; error: { code: string; message: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('DATABASE_UNAVAILABLE');
    expect(result.error.message).not.toMatch(/sqlite|C:\\|SELECT/i);
  });
});
