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

import { registerPrintingIpcHandlers } from '../../src/main/ipc/printingIpc';
import type { PrintAdapter } from '../../src/main/printing/printingService';
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
  IPC.printingListPrinters,
  IPC.printingGetConfig,
  IPC.printingSelectPrinter,
  IPC.printingPrintReceipt,
];

const adapter: PrintAdapter = {
  listPrinters: () => Promise.resolve([]),
  printDocument: () => Promise.resolve(),
};

beforeEach(() => {
  handlers.clear();
  registerPrintingIpcHandlers({
    logger,
    getDatabase: () => null,
    rendererEntry: entry,
    adapter,
  });
});
afterEach(() => vi.clearAllMocks());

describe('printing IPC registration', () => {
  it('registers exactly the four narrow printing channels — no generic setter/query', () => {
    expect([...handlers.keys()].sort()).toEqual([...CHANNELS].sort());
    for (const channel of handlers.keys()) {
      expect(channel).toMatch(/^printing:(list-printers|get-config|select-printer|print-receipt)$/);
      expect(channel).not.toMatch(/set|query|exec|sql/);
    }
  });

  it('every channel rejects an untrusted sender', async () => {
    for (const channel of CHANNELS) {
      await expect(handlers.get(channel)!(untrustedEvent())).rejects.toThrow(/untrusted sender/i);
    }
  });

  it.each(CHANNELS)(
    'a trusted request to %s with no database returns a typed DATABASE_UNAVAILABLE result (no throw)',
    async (channel) => {
      const result = (await handlers.get(channel)!(trustedEvent(), 'sale-1')) as {
        ok: false;
        error: { code: string; message: string };
      };
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('DATABASE_UNAVAILABLE');
      expect(result.error.message).not.toMatch(/sqlite|C:\\|SELECT/i);
    },
  );

  it('records a stable, correlated diagnostic event for a print failure', async () => {
    await handlers.get(IPC.printingPrintReceipt)!(trustedEvent(), 'sale-1');

    expect(logger.error).toHaveBeenCalledWith('printing', 'printing.failed', {
      saleId: 'sale-1',
      errorCode: 'DATABASE_UNAVAILABLE',
    });
  });
});
