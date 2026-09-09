import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: class {} }));

import { createElectronPrintAdapter } from '../../src/main/printing/electronPrintAdapter';
import type { PrintWindowLike } from '../../src/main/printing/electronPrintAdapter';

/**
 * Phase 2I — the Electron print adapter's window lifecycle (`task §7`): every
 * operation runs in a short-lived hidden window that is always destroyed, and
 * repeated print attempts never leak windows. The real `BrowserWindow` is
 * replaced by a fake through the injectable `createWindow` seam.
 */

interface FakeWindow extends PrintWindowLike {
  destroyed: boolean;
  loaded: string[];
}

function makeFactory(options: {
  printers?: Array<{ name: string; displayName: string; options?: unknown }>;
  printResult?: { success: boolean; reason?: string };
  printThrows?: boolean;
}) {
  const created: FakeWindow[] = [];
  const factory = (): FakeWindow => {
    const win: FakeWindow = {
      destroyed: false,
      loaded: [],
      webContents: {
        getPrintersAsync: () => Promise.resolve(options.printers ?? []),
        print: (_opts, cb) => {
          if (options.printThrows) {
            throw new Error('print threw synchronously');
          }
          const r = options.printResult ?? { success: true };
          cb(r.success, r.reason ?? '');
        },
      },
      loadURL: (url: string) => {
        win.loaded.push(url);
        return Promise.resolve();
      },
      isDestroyed: () => win.destroyed,
      destroy: () => {
        win.destroyed = true;
      },
    };
    created.push(win);
    return win;
  };
  return { factory, created };
}

describe('createElectronPrintAdapter — listPrinters', () => {
  it('maps to narrow PrinterDevice metadata and destroys the window', async () => {
    const { factory, created } = makeFactory({
      printers: [
        {
          name: 'Brother_QL_820NWB',
          displayName: 'Brother QL-820NWB',
          options: { 'printer-is-default': 'true' },
        },
        { name: 'OneNote', displayName: 'OneNote' },
      ],
    });
    const adapter = createElectronPrintAdapter({ createWindow: factory });

    const devices = await adapter.listPrinters();
    expect(devices).toEqual([
      {
        deviceName: 'Brother_QL_820NWB',
        displayName: 'Brother QL-820NWB',
        isDefault: true,
        status: null,
      },
      { deviceName: 'OneNote', displayName: 'OneNote', isDefault: false, status: null },
    ]);
    expect(created).toHaveLength(1);
    expect(created[0]!.destroyed).toBe(true);
  });
});

describe('createElectronPrintAdapter — printDocument', () => {
  it('loads a self-contained data: URL and resolves on spooler accept', async () => {
    const { factory, created } = makeFactory({ printResult: { success: true } });
    const adapter = createElectronPrintAdapter({ createWindow: factory });

    await adapter.printDocument('<!doctype html><p>hi</p>', { deviceName: 'Brother_QL_820NWB' });

    expect(created[0]!.loaded[0]!.startsWith('data:text/html;charset=utf-8,')).toBe(true);
    expect(created[0]!.loaded[0]).not.toMatch(/https?:\/\//);
    expect(created[0]!.destroyed).toBe(true);
  });

  it('rejects — and still destroys the window — when the job is not accepted', async () => {
    const { factory, created } = makeFactory({
      printResult: { success: false, reason: 'Invalid deviceName provided' },
    });
    const adapter = createElectronPrintAdapter({ createWindow: factory });

    await expect(adapter.printDocument('<p>x</p>', { deviceName: 'Missing' })).rejects.toThrow(
      /not accepted|Invalid deviceName/,
    );
    expect(created[0]!.destroyed).toBe(true);
  });

  it('rejects — and still destroys the window — when print() throws synchronously', async () => {
    const { factory, created } = makeFactory({ printThrows: true });
    const adapter = createElectronPrintAdapter({ createWindow: factory });

    await expect(adapter.printDocument('<p>x</p>', { deviceName: 'X' })).rejects.toThrow(
      /threw synchronously/,
    );
    expect(created[0]!.destroyed).toBe(true);
  });

  it('never leaks windows across repeated attempts — one created and destroyed per call', async () => {
    const { factory, created } = makeFactory({ printResult: { success: true } });
    const adapter = createElectronPrintAdapter({ createWindow: factory });

    for (let i = 0; i < 5; i += 1) {
      await adapter.printDocument('<p>x</p>', { deviceName: 'Brother_QL_820NWB' });
    }
    expect(created).toHaveLength(5);
    expect(created.every((w) => w.destroyed)).toBe(true);
  });
});
