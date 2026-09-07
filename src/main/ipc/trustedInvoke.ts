import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import type { IpcResult } from '../../shared/products';
import type { Logger } from '../app/logger';
import { isAllowedRendererNavigation, resolveRendererEntry } from '../app/rendererEntry';
import type { RendererEntry } from '../app/rendererEntry';
import { isAppError } from '../shared/appError';

/**
 * Privileged-IPC plumbing for Phase 2B business channels (task `§14`, `§16`;
 * `ARCHITECTURE.md §9`, `§29`).
 *
 * Two guarantees for every channel registered through here:
 *
 *  1. **Sender validation.** The request must come from the top-level frame of
 *     the one legitimate renderer destination (`rendererEntry.ts`, the same
 *     allow-list `security.ts` uses for navigation). A request from a subframe,
 *     an unexpected origin, or a frame whose URL is not the renderer entry is
 *     rejected before the handler runs. This never weakens `contextIsolation`,
 *     `sandbox`, `nodeIntegration: false`, or the navigation boundary — it adds
 *     a check on top of them.
 *
 *  2. **Typed result mapping.** The handler returns plain data or throws an
 *     `AppError`; callers always receive an `IpcResult<T>` envelope. A non-
 *     `AppError` throw is logged with detail and replaced by a generic
 *     `INTERNAL` error so no SQLite message, stack, SQL, or path reaches the
 *     renderer.
 */

export function isTrustedSender(event: IpcMainInvokeEvent, entry: RendererEntry): boolean {
  const frame = event.senderFrame;
  if (!frame) {
    return false;
  }
  // Only the top-level document may call privileged channels.
  if (frame.parent !== null) {
    return false;
  }
  return isAllowedRendererNavigation(frame.url, entry);
}

export interface TrustedInvokeContext {
  readonly logger: Logger;
  /** Overridable for tests; defaults to the resolved renderer entry. */
  readonly rendererEntry?: RendererEntry;
}

type Handler<T> = (...args: readonly unknown[]) => T | Promise<T>;

export function registerTrustedInvoke<T>(
  channel: string,
  context: TrustedInvokeContext,
  handler: Handler<T>,
): void {
  const entry = context.rendererEntry ?? resolveRendererEntry();

  ipcMain.handle(channel, async (event, ...args): Promise<IpcResult<T>> => {
    if (!isTrustedSender(event, entry)) {
      context.logger.warn('diagnostics', 'ipc.untrusted-sender-rejected', {
        channel,
        frameUrl: event.senderFrame?.url ?? null,
      });
      // Reject the invoke outright — a compromised/unexpected frame gets no envelope.
      throw new Error('Request rejected: untrusted sender.');
    }

    try {
      const data = await handler(...args);
      return { ok: true, data };
    } catch (error) {
      if (isAppError(error)) {
        return { ok: false, error: error.toIpcError() };
      }
      context.logger.error('database', 'ipc.handler-failed', {
        channel,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' },
      };
    }
  });
}
