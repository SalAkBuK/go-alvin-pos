import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const electron = vi.hoisted(() => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      // captured below via the module-level map
      capture(channel, fn);
    },
  },
}));
function capture(channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) {
  handlers.set(channel, fn);
}
vi.mock('electron', () => electron);

import { isTrustedSender, registerTrustedInvoke } from '../../src/main/ipc/trustedInvoke';
import { AppError } from '../../src/main/shared/appError';
import type { RendererEntry } from '../../src/main/app/rendererEntry';
import type { Logger } from '../../src/main/app/logger';

const entry: RendererEntry = {
  devServerUrl: 'http://localhost:5173',
  fileEntryPath: 'C:\\app\\out\\renderer\\index.html',
  fileEntryUrl: 'file:///C:/app/out/renderer/index.html',
};

function fakeEvent(url: string | undefined, parent: unknown = null) {
  return { senderFrame: url === undefined ? null : { url, parent } };
}

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
} as unknown as Logger;

beforeEach(() => handlers.clear());
afterEach(() => vi.clearAllMocks());

describe('isTrustedSender', () => {
  it('accepts the top-level frame at the exact renderer origin', () => {
    expect(isTrustedSender(fakeEvent('http://localhost:5173/index.html') as never, entry)).toBe(
      true,
    );
  });

  it('rejects a subframe', () => {
    expect(isTrustedSender(fakeEvent('http://localhost:5173/', { url: 'x' }) as never, entry)).toBe(
      false,
    );
  });

  it('rejects an unexpected origin and a missing frame', () => {
    expect(isTrustedSender(fakeEvent('https://evil.example/') as never, entry)).toBe(false);
    expect(isTrustedSender(fakeEvent('file:///C:/Windows/x.html') as never, entry)).toBe(false);
    expect(isTrustedSender(fakeEvent(undefined) as never, entry)).toBe(false);
  });
});

describe('registerTrustedInvoke', () => {
  it('wraps a success in { ok: true, data }', async () => {
    registerTrustedInvoke('t:ok', { logger, rendererEntry: entry }, () => ({ n: 1 }));
    const result = await handlers.get('t:ok')!(fakeEvent('http://localhost:5173/'), 'arg');
    expect(result).toEqual({ ok: true, data: { n: 1 } });
  });

  it('maps an AppError to a typed { ok: false, error } envelope', async () => {
    registerTrustedInvoke('t:apperr', { logger, rendererEntry: entry }, () => {
      throw new AppError('DUPLICATE_SKU', 'This SKU is already assigned to another product.');
    });
    const result = await handlers.get('t:apperr')!(fakeEvent('http://localhost:5173/'));
    expect(result).toEqual({
      ok: false,
      error: { code: 'DUPLICATE_SKU', message: 'This SKU is already assigned to another product.' },
    });
  });

  it('replaces a non-AppError throw with a generic INTERNAL error (no leak)', async () => {
    registerTrustedInvoke('t:boom', { logger, rendererEntry: entry }, () => {
      throw new Error('SQLITE_CONSTRAINT: near "SELECT": C:\\secret\\path');
    });
    const result = (await handlers.get('t:boom')!(fakeEvent('http://localhost:5173/'))) as {
      ok: false;
      error: { code: string; message: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INTERNAL');
    expect(result.error.message).not.toMatch(/SQLITE|secret|SELECT/);
  });

  it('rejects the invoke outright for an untrusted sender', async () => {
    const spy = vi.fn();
    registerTrustedInvoke('t:guard', { logger, rendererEntry: entry }, spy);
    await expect(handlers.get('t:guard')!(fakeEvent('https://evil.example/'))).rejects.toThrow(
      /untrusted sender/i,
    );
    expect(spy).not.toHaveBeenCalled();
  });
});
