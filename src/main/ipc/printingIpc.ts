import { IPC } from '../../shared/ipc';
import type { Logger } from '../app/logger';
import type { RendererEntry } from '../app/rendererEntry';
import type { ProductionDatabase } from '../database/database';
import { createElectronPrintAdapter } from '../printing/electronPrintAdapter';
import { createPrintingService } from '../printing/printingService';
import type { PrintAdapter } from '../printing/printingService';
import { appErrors, isAppError } from '../shared/appError';
import { registerTrustedInvoke } from './trustedInvoke';

/**
 * Registers the Phase 2I printing IPC channels (`ARCHITECTURE.md §9`, `§18`;
 * `REQ-PRINT-001`-`REQ-PRINT-005`, `REQ-REC-004`-`REQ-REC-005`).
 *
 *  - `printing:list-printers` — enumerate Windows printers (read-only).
 *  - `printing:get-config`    — the persisted selection + its availability (read-only).
 *  - `printing:select-printer`— persist ONLY `settings.selected_printer`.
 *  - `printing:print-receipt` — rebuild one sale's receipt from stored snapshots
 *    and submit it to the selected printer. Read-only w.r.t. all business data.
 *
 * There is deliberately no generic settings/query/mutation capability. Handlers
 * stay thin; sender validation + typed-error mapping live in
 * `registerTrustedInvoke`. The Electron print adapter is created once and shared;
 * tests inject a fake via `context.adapter`.
 */

export interface PrintingIpcContext {
  readonly logger: Logger;
  readonly getDatabase: () => ProductionDatabase | null;
  readonly rendererEntry?: RendererEntry;
  /** Overridable for tests; defaults to the real Electron/Windows adapter. */
  readonly adapter?: PrintAdapter;
}

export function registerPrintingIpcHandlers(context: PrintingIpcContext): void {
  const trusted = {
    logger: context.logger,
    ...(context.rendererEntry ? { rendererEntry: context.rendererEntry } : {}),
  };

  const adapter = context.adapter ?? createElectronPrintAdapter();

  function service() {
    const db = context.getDatabase();
    if (!db || db.closed) {
      throw appErrors.databaseUnavailable();
    }
    return createPrintingService({ db: db.connection, adapter });
  }

  registerTrustedInvoke(IPC.printingListPrinters, trusted, () => service().listPrinters());
  registerTrustedInvoke(IPC.printingGetConfig, trusted, () => service().getConfig());
  registerTrustedInvoke(IPC.printingSelectPrinter, trusted, (input) =>
    service().selectPrinter(input),
  );
  registerTrustedInvoke(IPC.printingPrintReceipt, trusted, async (saleId) => {
    try {
      const result = await service().printReceipt(saleId);
      context.logger.info('printing', 'printing.completed', {
        saleId: result.saleId,
        receiptNumber: result.receiptNumber,
        voided: result.voided,
      });
      return result;
    } catch (error) {
      context.logger.error('printing', 'printing.failed', {
        ...(typeof saleId === 'string' ? { saleId } : {}),
        errorCode: isAppError(error) ? error.code : 'PRINT_FAILED',
      });
      throw error;
    }
  });
}
