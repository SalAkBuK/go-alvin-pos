import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiagnosticSnapshot } from '../../src/shared/diagnostics';

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
import { registerSupportIpcHandlers } from '../../src/main/ipc/supportIpc';
import { IPC } from '../../src/shared/ipc';
import { makeTempDir } from '../helpers/database';

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
const snapshot = {
  generatedAt: '2026-09-12T00:00:00.000Z',
  mode: 'SUMMARY',
  application: { version: '1.2.3', buildIdentifier: null, installationId: 'INST-TEST' },
  runtime: {
    platform: 'win32',
    osRelease: '11',
    arch: 'x64',
    electron: '44',
    node: '24',
  },
  overallStatus: 'CRITICAL',
  components: {
    database: {
      status: 'CRITICAL',
      open: false,
      schemaVersion: null,
      expectedSchemaVersion: 1,
      migrationStateValid: false,
      foreignKeysEnabled: false,
      criticalTablesAvailable: false,
      quickCheck: 'NOT_RUN',
      issueCodes: ['DB_OPEN_FAILED'],
    },
    disk: {
      status: 'HEALTHY',
      inspectionAvailable: true,
      availableBytes: 1,
      warningBelowBytes: 1,
      criticalBelowBytes: 1,
      issueCode: null,
    },
    backup: {
      status: 'WARNING',
      lastSuccessfulLocalAt: null,
      lastLocalFailure: null,
      localOverdue: true,
      offDevice: { state: 'NOT_CONFIGURED' },
      issueCode: 'BACKUP_OVERDUE',
    },
    google: {
      status: 'WARNING',
      enabled: false,
      setupState: 'DISCONNECTED',
      needsReauthorization: false,
      setupNeedsAttention: false,
      pendingExports: 0,
      exportingExports: 0,
      failedExports: 0,
      lastSuccessfulExportAt: null,
      issueCode: 'GOOGLE_DISCONNECTED',
    },
    cardReconciliation: { status: 'HEALTHY', unresolvedCount: 0, issueCode: null },
    printer: {
      status: 'WARNING',
      state: 'NOT_CONFIGURED',
      configuredName: null,
      availabilitySupported: true,
      printHistorySupported: false,
      lastSuccessfulPrintAt: null,
      lastFailedPrintAt: null,
      issueCode: 'PRINTER_NOT_CONFIGURED',
    },
    connectivity: {
      status: 'WARNING',
      supported: true,
      state: 'OFFLINE',
      issueCode: 'INTERNET_OFFLINE',
    },
  },
} satisfies DiagnosticSnapshot;

const trustedEvent = () => ({ senderFrame: { url: 'http://localhost:5173/', parent: null } });
const untrustedEvent = () => ({ senderFrame: { url: 'https://evil.example/', parent: null } });
let temp: ReturnType<typeof makeTempDir>;
let showSaveDialog: ReturnType<typeof vi.fn<(suggestedFileName: string) => Promise<string | null>>>;

beforeEach(() => {
  handlers.clear();
  temp = makeTempDir('gpp-support-ipc-');
  showSaveDialog = vi.fn((_suggestedFileName: string) => Promise.resolve(null));
  registerSupportIpcHandlers({
    logger,
    appVersion: '1.2.3',
    installationId: 'INST-TEST',
    reportsRoot: `${temp.path}\\reports`,
    logsRoot: `${temp.path}\\logs`,
    getDatabase: () => null,
    getDiagnostics: () => Promise.resolve(snapshot),
    showSaveDialog,
    rendererEntry: entry,
  });
});

afterEach(() => {
  temp.cleanup();
  vi.clearAllMocks();
});

describe('support IPC', () => {
  it('registers only report creation and bundle export capabilities', () => {
    expect([...handlers.keys()].sort()).toEqual(
      [IPC.supportCreateReport, IPC.supportExportBundle].sort(),
    );
  });

  it('creates a local report and returns no filesystem path', async () => {
    const result = await handlers.get(IPC.supportCreateReport)!(trustedEvent(), {
      description: 'Printer stopped responding.',
      category: 'PRINTING',
      receiptNumber: 'GP-000123',
    });
    expect(result).toMatchObject({
      ok: true,
      data: { category: 'PRINTING', receiptNumber: 'GP-000123', installationId: 'INST-TEST' },
    });
    expect(JSON.stringify(result)).not.toContain(temp.path);
  });

  it('owns the Save dialog and rejects renderer filesystem/source fields', async () => {
    const cancelled = await handlers.get(IPC.supportExportBundle)!(trustedEvent());
    expect(cancelled).toEqual({ ok: true, data: { status: 'CANCELLED' } });
    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.stringMatching(/^GoPhonesPOS-Support-[A-Za-z0-9.-]+\.zip$/),
    );

    showSaveDialog.mockClear();
    const rejected = await handlers.get(IPC.supportExportBundle)!(trustedEvent(), {
      destinationPath: 'C:\\evil\\bundle.zip',
      sourceFiles: ['C:\\private\\gophones.sqlite'],
    });
    expect(rejected).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it('rejects untrusted renderer senders', async () => {
    for (const handler of handlers.values()) {
      await expect(handler(untrustedEvent())).rejects.toThrow(/untrusted sender/i);
    }
  });
});
