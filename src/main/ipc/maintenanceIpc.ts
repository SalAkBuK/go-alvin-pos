import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { IPC } from '../../shared/ipc';
import type { CheckoutActivityInput, MaintenanceState } from '../../shared/maintenance';
import type { IpcResult } from '../../shared/products';
import type { Logger } from '../app/logger';
import { resolveRendererEntry } from '../app/rendererEntry';
import type { RendererEntry } from '../app/rendererEntry';
import type { MaintenanceCoordinator } from '../maintenance/maintenanceCoordinator';
import { appErrors } from '../shared/appError';
import { isTrustedSender, registerTrustedInvoke } from './trustedInvoke';

/**
 * Registers the two maintenance-coordinator IPC channels (Phase 2L-B Items 3, 6).
 *
 *  - `maintenance:checkout-activity` — the ONLY renderer-mutable maintenance
 *    input: draft-cart presence `{ active: boolean }`. It cannot set
 *    `TRANSACTION_IN_FLIGHT`, `MIGRATION_IN_PROGRESS`, or `RESTORE_IN_PROGRESS`.
 *    `{ active: false }` only clears the flag when it comes from the WebContents
 *    that currently owns the tracked draft cart. WebContents lifecycle events
 *    (`destroyed` / `render-process-gone` / `did-start-navigation`) clear it too
 *    — there is no periodic heartbeat.
 *  - `maintenance:status` — read-only current coordinator state, for the
 *    renderer's application-level "sales temporarily unavailable" banner. Served
 *    even while a RESTORE owns the lifecycle.
 */

export interface MaintenanceIpcContext {
  readonly logger: Logger;
  readonly coordinator: MaintenanceCoordinator;
  readonly rendererEntry?: RendererEntry;
}

const wiredContents = new WeakSet<WebContents>();

export function registerMaintenanceIpcHandlers(context: MaintenanceIpcContext): void {
  const entry = context.rendererEntry ?? resolveRendererEntry();
  const trusted = {
    logger: context.logger,
    ...(context.rendererEntry ? { rendererEntry: context.rendererEntry } : {}),
  };

  registerTrustedInvoke(
    IPC.maintenanceStatus,
    trusted,
    (): { state: MaintenanceState } => ({ state: context.coordinator.status() }),
    { allowDuringExclusiveMaintenance: true },
  );

  ipcMain.handle(
    IPC.maintenanceCheckoutActivity,
    (event: IpcMainInvokeEvent, raw: unknown): IpcResult<{ accepted: boolean }> => {
      if (!isTrustedSender(event, entry)) {
        context.logger.warn('diagnostics', 'ipc.untrusted-sender-rejected', {
          channel: IPC.maintenanceCheckoutActivity,
        });
        throw new Error('Request rejected: untrusted sender.');
      }

      const active = Boolean((raw as CheckoutActivityInput | null)?.active);
      const sender = event.sender;
      const result = context.coordinator.noteDraftCartActivity(active, sender.id);

      if (active && !result.accepted) {
        // A RESTORE / MIGRATION owner holds the exclusive lifecycle — the
        // cart was NOT recorded as active. A stable typed error so the
        // renderer abandons the attempted cart instead of continuing it past
        // maintenance (Item 3, 2L-B adversarial follow-up).
        return { ok: false, error: appErrors.maintenanceInProgress().toIpcError() };
      }

      // Attach lifecycle cleanup once per WebContents so a renderer crash /
      // reload / navigation can never leave the draft-cart flag stuck. A
      // main-frame navigation (reload included) tears down the renderer's cart
      // state; the fresh renderer re-sends `{ active: true }` if a cart is
      // rebuilt.
      if (active && !wiredContents.has(sender)) {
        wiredContents.add(sender);
        const clear = (): void => context.coordinator.clearDraftCartIfOwner(sender.id);
        sender.once('destroyed', clear);
        sender.on('render-process-gone', clear);
        sender.on('did-navigate', clear);
      }

      return { ok: true, data: { accepted: true } };
    },
  );
}
