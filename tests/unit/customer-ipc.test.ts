import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const electron = vi.hoisted(() => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      register(channel, fn);
    },
  },
}));
function register(channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) {
  handlers.set(channel, fn);
}
vi.mock('electron', () => electron);

import { registerCustomerIpcHandlers } from '../../src/main/ipc/customerIpc';
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

function trustedEvent() {
  return { senderFrame: { url: 'http://localhost:5173/index.html', parent: null } };
}
function untrustedEvent() {
  return { senderFrame: { url: 'https://evil.example/', parent: null } };
}

const CUSTOMER_CHANNELS = [
  IPC.customersCreate,
  IPC.customersUpdate,
  IPC.customersList,
  IPC.customersSearch,
  IPC.customersGet,
  IPC.customersPurchaseHistory,
];

beforeEach(() => {
  handlers.clear();
  registerCustomerIpcHandlers({
    logger,
    getDatabase: () => null, // DB accessor irrelevant: sender check runs first
    rendererEntry: entry,
  });
});
afterEach(() => vi.clearAllMocks());

describe('customer IPC registration', () => {
  it('registers exactly the six explicit customer channels', () => {
    expect([...handlers.keys()].sort()).toEqual([...CUSTOMER_CHANNELS].sort());
  });

  it('every customer channel rejects a request from an untrusted sender', async () => {
    for (const channel of CUSTOMER_CHANNELS) {
      await expect(handlers.get(channel)!(untrustedEvent())).rejects.toThrow(/untrusted sender/i);
    }
  });

  it('a trusted request with an unavailable database returns a typed DATABASE_UNAVAILABLE result (no throw)', async () => {
    const result = (await handlers.get(IPC.customersList)!(trustedEvent())) as {
      ok: false;
      error: { code: string; message: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('DATABASE_UNAVAILABLE');
    expect(result.error.message).not.toMatch(/sqlite|C:\\|SELECT/i);
  });
});
