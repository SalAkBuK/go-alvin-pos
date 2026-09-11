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
import { registerDiagnosticsIpcHandlers } from '../../src/main/ipc/diagnosticsIpc';
import type { PrintAdapter } from '../../src/main/printing/printingService';
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
const adapter: PrintAdapter = {
  listPrinters: () => Promise.resolve([]),
  printDocument: () => Promise.resolve(),
};
const trustedEvent = () => ({
  senderFrame: { url: 'http://localhost:5173/index.html', parent: null },
});
const untrustedEvent = () => ({ senderFrame: { url: 'https://evil.example/', parent: null } });

beforeEach(() => {
  handlers.clear();
  registerDiagnosticsIpcHandlers({
    logger,
    appVersion: '1.2.3',
    installationId: 'INST-00000000-0000-4000-8000-000000000001',
    storagePath: 'C:\\private\\GoPhonesPOS',
    getDatabase: () => null,
    getDatabaseStatus: () => ({
      state: 'unavailable',
      schemaVersion: null,
      failureCode: 'DB_OPEN_FAILED',
    }),
    getBackupService: () => null,
    getGoogleConfigService: () => null,
    rendererEntry: entry,
    printerAdapter: adapter,
    diskInspector: { availableBytes: () => Promise.resolve(10 * 1024 * 1024 * 1024) },
  });
});
afterEach(() => vi.clearAllMocks());

describe('diagnostics IPC', () => {
  it('registers only summary and manual-run capabilities', () => {
    expect([...handlers.keys()].sort()).toEqual(
      [IPC.diagnosticsGetSummary, IPC.diagnosticsRun].sort(),
    );
  });

  it('rejects untrusted senders', async () => {
    for (const handler of handlers.values()) {
      await expect(handler(untrustedEvent())).rejects.toThrow(/untrusted sender/i);
    }
  });

  it('returns sanitized critical state when the operational database is unavailable', async () => {
    const result = (await handlers.get(IPC.diagnosticsGetSummary)!(trustedEvent())) as {
      ok: true;
      data: { overallStatus: string; mode: string };
    };
    expect(result).toMatchObject({
      ok: true,
      data: { overallStatus: 'CRITICAL', mode: 'SUMMARY' },
    });
    expect(JSON.stringify(result)).not.toContain('C:\\private');
  });

  it('runs manually without accepting renderer arguments', async () => {
    const result = (await handlers.get(IPC.diagnosticsRun)!(trustedEvent(), {
      path: 'C:\\evil',
      sql: 'DROP TABLE sales',
    })) as { ok: true; data: { mode: string } };
    expect(result).toMatchObject({ ok: true, data: { mode: 'MANUAL' } });
    expect(JSON.stringify(result)).not.toContain('C:\\evil');
    expect(JSON.stringify(result)).not.toContain('DROP TABLE');
  });
});
