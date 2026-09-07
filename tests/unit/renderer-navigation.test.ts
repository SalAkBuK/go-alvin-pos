import { afterEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ app: { isPackaged: false } }));
vi.mock('electron', () => electron);

import {
  isAllowedRendererNavigation,
  resolveRendererEntry,
} from '../../src/main/app/rendererEntry';
import type { RendererEntry } from '../../src/main/app/rendererEntry';

const devEntry: RendererEntry = {
  devServerUrl: 'http://localhost:5173',
  fileEntryPath: 'C:\\app\\out\\renderer\\index.html',
  fileEntryUrl: 'file:///C:/app/out/renderer/index.html',
};

const packagedEntry: RendererEntry = {
  devServerUrl: null,
  fileEntryPath: 'C:\\app\\out\\renderer\\index.html',
  fileEntryUrl: 'file:///C:/app/out/renderer/index.html',
};

describe('isAllowedRendererNavigation — development', () => {
  it('allows the exact dev-server origin (root and reload paths)', () => {
    expect(isAllowedRendererNavigation('http://localhost:5173/', devEntry)).toBe(true);
    expect(isAllowedRendererNavigation('http://localhost:5173/index.html', devEntry)).toBe(true);
    expect(isAllowedRendererNavigation('http://localhost:5173/@vite/client', devEntry)).toBe(true);
  });

  it('denies other localhost ports and 127.0.0.1', () => {
    expect(isAllowedRendererNavigation('http://localhost:5174/', devEntry)).toBe(false);
    expect(isAllowedRendererNavigation('http://localhost:9229/', devEntry)).toBe(false);
    expect(isAllowedRendererNavigation('http://127.0.0.1:5173/', devEntry)).toBe(false);
  });

  it('denies remote origins and arbitrary file URLs even in dev', () => {
    expect(isAllowedRendererNavigation('https://evil.example/', devEntry)).toBe(false);
    expect(isAllowedRendererNavigation('http://evil.example/', devEntry)).toBe(false);
    expect(isAllowedRendererNavigation('file:///C:/Windows/System32/calc.html', devEntry)).toBe(
      false,
    );
  });
});

describe('isAllowedRendererNavigation — packaged', () => {
  it('allows exactly the packaged entry file, incl. case and hash routing', () => {
    expect(
      isAllowedRendererNavigation('file:///C:/app/out/renderer/index.html', packagedEntry),
    ).toBe(true);
    expect(
      isAllowedRendererNavigation('file:///C:/APP/OUT/renderer/index.html', packagedEntry),
    ).toBe(true);
    expect(
      isAllowedRendererNavigation('file:///C:/app/out/renderer/index.html#/sales', packagedEntry),
    ).toBe(true);
  });

  it('denies any other file path', () => {
    expect(
      isAllowedRendererNavigation('file:///C:/app/out/renderer/evil.html', packagedEntry),
    ).toBe(false);
    expect(isAllowedRendererNavigation('file:///C:/Users/Public/x.html', packagedEntry)).toBe(
      false,
    );
    expect(isAllowedRendererNavigation('file:///etc/passwd', packagedEntry)).toBe(false);
  });

  it('denies all http(s) navigation when packaged (no dev-server allowance)', () => {
    expect(isAllowedRendererNavigation('http://localhost:5173/', packagedEntry)).toBe(false);
    expect(isAllowedRendererNavigation('https://example.com/', packagedEntry)).toBe(false);
  });

  it('denies unparseable / empty targets', () => {
    expect(isAllowedRendererNavigation('not a url', packagedEntry)).toBe(false);
    expect(isAllowedRendererNavigation('', packagedEntry)).toBe(false);
    expect(isAllowedRendererNavigation('javascript:alert(1)', packagedEntry)).toBe(false);
  });
});

describe('resolveRendererEntry', () => {
  const original = process.env['ELECTRON_RENDERER_URL'];

  afterEach(() => {
    electron.app.isPackaged = false;
    if (original === undefined) delete process.env['ELECTRON_RENDERER_URL'];
    else process.env['ELECTRON_RENDERER_URL'] = original;
  });

  it('uses the injected dev-server URL in development', () => {
    electron.app.isPackaged = false;
    process.env['ELECTRON_RENDERER_URL'] = 'http://localhost:5199';
    const entry = resolveRendererEntry();
    expect(entry.devServerUrl).toBe('http://localhost:5199');
    expect(entry.fileEntryUrl.startsWith('file://')).toBe(true);
  });

  it('has no dev-server URL when none was injected', () => {
    electron.app.isPackaged = false;
    delete process.env['ELECTRON_RENDERER_URL'];
    expect(resolveRendererEntry().devServerUrl).toBeNull();
  });

  it('ignores any injected dev-server URL when packaged', () => {
    electron.app.isPackaged = true;
    process.env['ELECTRON_RENDERER_URL'] = 'http://localhost:5199';
    expect(resolveRendererEntry().devServerUrl).toBeNull();
  });
});
