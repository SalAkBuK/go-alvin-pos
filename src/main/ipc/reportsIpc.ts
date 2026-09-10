import { IPC } from '../../shared/ipc';
import type { Logger } from '../app/logger';
import type { RendererEntry } from '../app/rendererEntry';
import type { ProductionDatabase } from '../database/database';
import { createDailyReportService } from '../reports/dailyReportService';
import { appErrors } from '../shared/appError';
import { registerTrustedInvoke } from './trustedInvoke';

/**
 * Registers the Daily Reports IPC channel (Phase 2K `REQ-REPORT-001`-
 * `REQ-REPORT-009`; `POS_WORKFLOWS.md §53`-`§55`; `ARCHITECTURE.md §36`).
 *
 *  - `reports:daily` — one read-only Daily Report recomputed live from local
 *    `sales` snapshots for a selected business day (or the current business day
 *    when none is given). Read-only: writes nothing, emits no audit event, makes
 *    no network / Google request.
 *
 * The handler is thin: resolve the authoritative connection, build the service,
 * call one method, return. Sender validation and typed-error mapping live in
 * `registerTrustedInvoke`. There is deliberately no generic query capability —
 * the renderer can only send `{}` or `{ businessDate: 'YYYY-MM-DD' }`, both
 * re-validated in the trusted layer.
 */

export interface ReportsIpcContext {
  readonly logger: Logger;
  readonly getDatabase: () => ProductionDatabase | null;
  readonly rendererEntry?: RendererEntry;
}

export function registerReportsIpcHandlers(context: ReportsIpcContext): void {
  const trusted = {
    logger: context.logger,
    ...(context.rendererEntry ? { rendererEntry: context.rendererEntry } : {}),
  };

  function connection() {
    const db = context.getDatabase();
    if (!db || db.closed) {
      throw appErrors.databaseUnavailable();
    }
    return db.connection;
  }

  registerTrustedInvoke(IPC.reportsDaily, trusted, (input) =>
    createDailyReportService({ db: connection() }).daily(input),
  );
}
