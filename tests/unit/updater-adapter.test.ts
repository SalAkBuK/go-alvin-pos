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

  it('configureUpdaterAdapter sets the generic feed and disables auto-download/auto-install', () => {
    const setFeedURL = vi.fn();
    const fake: ConfigurableAutoUpdater = {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      setFeedURL,
      on: vi.fn() as unknown as ConfigurableAutoUpdater['on'],
    };

    const result = configureUpdaterAdapter(fake, 'https://updates.example.com/feed/');

    expect(setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://updates.example.com/feed/',
    });
    expect(fake.autoDownload).toBe(false);
    expect(fake.autoInstallOnAppQuit).toBe(false);
    expect(result).toBe(fake);
  });
});
