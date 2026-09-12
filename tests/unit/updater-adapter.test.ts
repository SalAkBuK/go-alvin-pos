import { describe, expect, it, vi } from 'vitest';
import { configureUpdaterAdapter } from '../../src/main/updater/updaterAdapter';
import type { ConfigurableAutoUpdater } from '../../src/main/updater/updaterAdapter';

describe('updaterAdapter (Phase 2N-A electron-updater boundary)', () => {
  it('importing the module never touches electron-updater (require is lazy, inside the function only)', async () => {
    // No mock of 'electron-updater' here on purpose: touching the real
    // library's lazy `autoUpdater` getter outside a real Electron process
    // throws (proven below). If this file's import touched the library
    // eagerly, this very import would already have thrown before any test
    // body ran.
    await expect(import('../../src/main/updater/updaterAdapter')).resolves.toBeDefined();
  });

  it('confirms the real electron-updater package cannot be constructed outside Electron (motivates the lazy-require + fail-open design)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('electron-updater') as { autoUpdater: unknown };
    // Requiring the module is inert; `.autoUpdater` is a lazy getter that
    // constructs the real updater, which needs a real Electron `app`.
    expect(() => mod.autoUpdater).toThrow();
  });

  it('configureUpdaterAdapter sets the generic feed, enables auto-download, and disables auto-install-on-quit', () => {
    const setFeedURL = vi.fn();
    const fake: ConfigurableAutoUpdater = {
      autoDownload: false,
      autoInstallOnAppQuit: true,
      setFeedURL,
      on: vi.fn() as unknown as ConfigurableAutoUpdater['on'],
      checkForUpdates: vi.fn() as unknown as ConfigurableAutoUpdater['checkForUpdates'],
      quitAndInstall: vi.fn(),
    };

    const result = configureUpdaterAdapter(fake, 'https://updates.example.com/feed/');

    expect(setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://updates.example.com/feed/',
    });
    // Phase 2N-B: automatic background download once an update is discovered.
    expect(fake.autoDownload).toBe(true);
    // Automatic install-on-quit stays off; install is only ever user-controlled
    // via `updateService.ts`'s `restartAndInstall()` (Phase 2N-C).
    expect(fake.autoInstallOnAppQuit).toBe(false);
    expect(result).toBe(fake);
  });
});
