import { BrowserWindow } from 'electron';
import type { PrinterDevice } from '../../shared/printing';
import type { PrintAdapter } from './printingService';

/**
 * The production {@link PrintAdapter}: Electron's built-in Windows printing
 * (`webContents.getPrintersAsync` + `webContents.print`) — NO new native
 * dependency (`task §5`; `docs/NATIVE_DEPENDENCIES.md`).
 *
 * Every operation runs inside a short-lived, tightly-locked hidden
 * `BrowserWindow` that is destroyed in a `finally` block, so windows never leak
 * across repeated print attempts (`task §7`). The window:
 *
 *  - `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`;
 *  - has NO preload and NO `window.pos` bridge;
 *  - runs no page JavaScript (`javascript: false`) and loads no images;
 *  - only ever loads a `data:` URL built from our own escaped receipt HTML —
 *    never renderer HTML, never a URL, never a remote resource;
 *  - is covered by the app-wide navigation / window-open / permission hardening
 *    installed in `security.ts` (it does not bypass or weaken it — `task §7`).
 *
 * Printing to the selected device uses `silent: true` with an explicit
 * `deviceName`: this is a deliberate, user-initiated "Print Receipt" /
 * "Reprint Receipt" action against the persisted selection (`REQ-PRINT-004`,
 * `POS_WORKFLOWS.md §70`, `TEST-PRINT-004`), NOT prohibited automatic /
 * print-on-every-sale behaviour (`task §22`).
 */

/** The subset of `BrowserWindow` this adapter uses — the seam tests substitute. */
export interface PrintWindowLike {
  readonly webContents: {
    getPrintersAsync(): Promise<
      ReadonlyArray<{ name: string; displayName: string; description?: string }>
    >;
    print(
      options: {
        silent: boolean;
        deviceName: string;
        printBackground: boolean;
        color: boolean;
      },
      callback: (success: boolean, failureReason: string) => void,
    ): void;
  };
  loadURL(url: string): Promise<void>;
  isDestroyed(): boolean;
  destroy(): void;
}

export interface ElectronPrintAdapterDeps {
  /** Overridable for tests; defaults to a real hardened hidden `BrowserWindow`. */
  readonly createWindow?: () => PrintWindowLike;
}

function createHiddenWindow(): PrintWindowLike {
  return new BrowserWindow({
    show: false,
    width: 480,
    height: 640,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      javascript: false,
      images: false,
      spellcheck: false,
    },
  }) as unknown as PrintWindowLike;
}

/** Windows default printer flag lives in the platform `options` bag when present. */
function isWindowsDefault(options: unknown): boolean {
  if (typeof options !== 'object' || options === null) {
    return false;
  }
  const value = (options as Record<string, unknown>)['printer-is-default'];
  return value === 'true' || value === true;
}

export function createElectronPrintAdapter(deps: ElectronPrintAdapterDeps = {}): PrintAdapter {
  const createWindow = deps.createWindow ?? createHiddenWindow;

  async function withWindow<T>(fn: (win: PrintWindowLike) => Promise<T>): Promise<T> {
    const win = createWindow();
    try {
      return await fn(win);
    } finally {
      if (!win.isDestroyed()) {
        win.destroy();
      }
    }
  }

  return {
    async listPrinters(): Promise<readonly PrinterDevice[]> {
      return withWindow(async (win) => {
        const raw = await win.webContents.getPrintersAsync();
        return raw.map((p) => ({
          deviceName: p.name,
          displayName: p.displayName || p.name,
          isDefault: isWindowsDefault((p as { options?: unknown }).options),
          status: null,
        }));
      });
    },

    async printDocument(html: string, options: { deviceName: string }): Promise<void> {
      await withWindow(async (win) => {
        await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        await new Promise<void>((resolve, reject) => {
          try {
            win.webContents.print(
              {
                silent: true,
                deviceName: options.deviceName,
                printBackground: false,
                color: false,
              },
              (success, failureReason) => {
                if (success) {
                  resolve();
                } else {
                  reject(new Error(failureReason || 'The print job was not accepted.'));
                }
              },
            );
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });
    },
  };
}
