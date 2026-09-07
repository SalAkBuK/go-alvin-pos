import { join, sep } from 'node:path';
import type * as NodeFs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => {
  const state = { userData: `X:${'\\'}seed${'\\'}userData` };
  return {
    state,
    getPath: vi.fn((name: string): string => {
      if (name === 'userData') return state.userData;
      if (name === 'home') return join('C:', 'Users', 'tester');
      if (name === 'appData') return join('C:', 'Users', 'tester', 'AppData', 'Roaming');
      return join('C:', 'fake', name);
    }),
    setPath: vi.fn((name: string, value: string): void => {
      if (name === 'userData') state.userData = value;
    }),
  };
});

vi.mock('electron', () => ({
  app: { getPath: electron.getPath, setPath: electron.setPath },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return { ...actual, mkdirSync: vi.fn() };
});

import {
  APP_DATA_DIRECTORY_NAME,
  pinUserDataPath,
  resolveAppPaths,
} from '../../src/main/app/paths';

const ORIGINAL_LOCALAPPDATA = process.env['LOCALAPPDATA'];

beforeEach(() => {
  electron.state.userData = `X:${sep}seed${sep}userData`;
  electron.getPath.mockClear();
  electron.setPath.mockClear();
  process.env['LOCALAPPDATA'] = join('C:', 'Users', 'tester', 'AppData', 'Local');
});

afterEach(() => {
  if (ORIGINAL_LOCALAPPDATA === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = ORIGINAL_LOCALAPPDATA;
});

describe('APP_DATA_DIRECTORY_NAME', () => {
  it('is the fixed canonical name and nothing derived from package metadata', () => {
    expect(APP_DATA_DIRECTORY_NAME).toBe('GoPhonesPOS');
  });
});

describe('pinUserDataPath', () => {
  it('pins userData to <local app data root>/GoPhonesPOS and calls app.setPath', () => {
    const pinned = pinUserDataPath();

    expect(pinned.endsWith(`${sep}${APP_DATA_DIRECTORY_NAME}`)).toBe(true);
    expect(electron.setPath).toHaveBeenCalledWith('userData', pinned);
    // resolveAppPaths must now see the pinned location.
    expect(resolveAppPaths().userData).toBe(pinned);
  });

  it('uses %LOCALAPPDATA% as the root on Windows', () => {
    if (process.platform !== 'win32') return;
    const pinned = pinUserDataPath();
    expect(pinned).toBe(join(process.env['LOCALAPPDATA'] as string, APP_DATA_DIRECTORY_NAME));
  });

  it('falls back to <home>/AppData/Local when %LOCALAPPDATA% is unset (Windows)', () => {
    if (process.platform !== 'win32') return;
    delete process.env['LOCALAPPDATA'];
    const pinned = pinUserDataPath();
    expect(pinned).toBe(join('C:', 'Users', 'tester', 'AppData', 'Local', APP_DATA_DIRECTORY_NAME));
  });

  it('leaf directory name stays "GoPhonesPOS" regardless of app naming metadata', () => {
    // getName / productName are never consulted.
    const pinned = pinUserDataPath();
    expect(pinned.split(sep).pop()).toBe('GoPhonesPOS');
    expect(electron.getPath).not.toHaveBeenCalledWith('exe');
  });
});

describe('resolveAppPaths', () => {
  it('derives every path from the pinned userData', () => {
    pinUserDataPath();
    const paths = resolveAppPaths();

    expect(paths.logs).toBe(join(paths.userData, 'logs'));
    expect(paths.diagnostics).toBe(join(paths.userData, 'diagnostics'));
    expect(paths.databaseFile).toBe(join(paths.userData, 'gophones.sqlite'));
    expect(paths.nativeCheckDbFile).toBe(
      join(paths.userData, 'diagnostics', 'native-module-check.sqlite'),
    );
  });
});
