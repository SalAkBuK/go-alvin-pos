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

import { registerCheckoutIpcHandlers } from '../../src/main/ipc/checkoutIpc';
import { IPC } from '../../src/shared/ipc';
import type { RendererEntry } from '../../src/main/app/rendererEntry';
import type { Logger } from '../../src/main/app/logger';

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

beforeEach(() => {
  handlers.clear();
  registerCheckoutIpcHandlers({
    logger,
    getDatabase: () => null,
    appVersion: 'test',
    rendererEntry: entry,
  });
});
afterEach(() => vi.clearAllMocks());

describe('checkout IPC registration', () => {
  it('registers exactly review, complete-cash, begin/complete/decline-card, and receipts:get-by-sale-id', () => {
    expect([...handlers.keys()].sort()).toEqual(
      [
        IPC.checkoutReview,
        IPC.checkoutCompleteCash,
        IPC.checkoutBeginCard,
        IPC.checkoutCompleteCard,
        IPC.checkoutDeclineCard,
        IPC.receiptsGetBySaleId,
      ].sort(),
    );
  });

  it('defines the narrow Card capabilities but no generic complete channel', () => {
    for (const channel of handlers.keys()) {
      expect(channel).not.toBe('checkout:complete');
      expect(channel).not.toMatch(/clover|:complete$/i);
    }
    expect(handlers.has('checkout:begin-card')).toBe(true);
    expect(handlers.has('checkout:complete-card')).toBe(true);
    expect(handlers.has('checkout:decline-card')).toBe(true);
  });

  it('a trusted receipt request with no database returns a typed DATABASE_UNAVAILABLE result (no throw)', async () => {
    const result = (await handlers.get(IPC.receiptsGetBySaleId)!(trustedEvent(), 's1')) as {
      ok: false;
      error: { code: string; message: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('DATABASE_UNAVAILABLE');
    expect(result.error.message).not.toMatch(/sqlite|C:\\|SELECT/i);
  });

  it('rejects a request from an untrusted sender on every channel', async () => {
    for (const channel of handlers.keys()) {
      await expect(handlers.get(channel)!(untrustedEvent())).rejects.toThrow(/untrusted sender/i);
    }
  });

  it('a trusted review with no database returns a typed DATABASE_UNAVAILABLE result (no throw)', async () => {
    const result = (await handlers.get(IPC.checkoutReview)!(trustedEvent(), {
      customerId: null,
      paymentMethod: 'CASH',
      lines: [],
    })) as { ok: false; error: { code: string; message: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('DATABASE_UNAVAILABLE');
    expect(result.error.message).not.toMatch(/sqlite|C:\\|SELECT/i);
  });

  it('a trusted complete-cash with no database returns a typed DATABASE_UNAVAILABLE result (no throw)', async () => {
    const result = (await handlers.get(IPC.checkoutCompleteCash)!(trustedEvent(), {
      requestId: 'r1',
      reviewedFingerprint: 'a'.repeat(64),
      checkout: { customerId: null, paymentMethod: 'CASH', lines: [] },
    })) as { ok: false; error: { code: string; message: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('DATABASE_UNAVAILABLE');
  });

  it.each([IPC.checkoutBeginCard, IPC.checkoutCompleteCard] as const)(
    '%s with no database returns a typed DATABASE_UNAVAILABLE result (no throw)',
    async (channel) => {
      const result = (await handlers.get(channel)!(trustedEvent(), {
        requestId: 'r1',
        reviewedFingerprint: 'a'.repeat(64),
        checkout: { customerId: null, paymentMethod: 'CARD', lines: [] },
      })) as { ok: false; error: { code: string; message: string } };
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('DATABASE_UNAVAILABLE');
      expect(result.error.message).not.toMatch(/sqlite|C:\\|SELECT/i);
    },
  );

  it('decline-card with no database returns a typed DATABASE_UNAVAILABLE result (no throw)', async () => {
    const result = (await handlers.get(IPC.checkoutDeclineCard)!(trustedEvent(), {
      requestId: 'r1',
      reviewedFingerprint: 'a'.repeat(64),
    })) as { ok: false; error: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('DATABASE_UNAVAILABLE');
  });
});
