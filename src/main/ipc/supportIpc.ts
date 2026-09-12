import type { ActivityHistory } from '../../shared/activityHistory';
import type { DiagnosticSnapshot } from '../../shared/diagnostics';
import { IPC } from '../../shared/ipc';
import type { ExportSupportBundleResult, ProblemReport } from '../../shared/support';
import type { Logger } from '../app/logger';
import type { ProductionDatabase } from '../database/database';
import type { CrashEvidenceCollection } from '../diagnostics/crashEvidence';
import { createSupportBundleService } from '../support/supportBundleService';
import type { RendererEntry } from '../app/rendererEntry';
import { registerTrustedInvoke } from './trustedInvoke';

export interface SupportIpcContext {
  readonly logger: Logger;
  readonly appVersion: string;
  readonly buildIdentifier?: string | null;
  readonly installationId: string;
  readonly reportsRoot: string;
  readonly logsRoot: string;
  readonly getDatabase: () => ProductionDatabase | null;
  readonly getDiagnostics: () => Promise<DiagnosticSnapshot>;
  readonly getCrashEvidence?: () => CrashEvidenceCollection;
  readonly getActivityHistory: () => Promise<ActivityHistory>;
  readonly showSaveDialog: (suggestedFileName: string) => Promise<string | null>;
  readonly rendererEntry?: RendererEntry;
}

/** Three narrow support capabilities. None accepts a path, source-file list, or query. */
export function registerSupportIpcHandlers(context: SupportIpcContext): void {
  const service = createSupportBundleService({
    appVersion: context.appVersion,
    buildIdentifier: context.buildIdentifier ?? null,
    installationId: context.installationId,
    reportsRoot: context.reportsRoot,
    logsRoot: context.logsRoot,
    logger: context.logger,
    getDatabase: context.getDatabase,
    getDiagnostics: context.getDiagnostics,
    ...(context.getCrashEvidence ? { getCrashEvidence: context.getCrashEvidence } : {}),
  });
  const trusted = {
    logger: context.logger,
    ...(context.rendererEntry ? { rendererEntry: context.rendererEntry } : {}),
  };

  registerTrustedInvoke(IPC.supportCreateReport, trusted, (raw): Promise<ProblemReport> =>
    service.createProblemReport(raw),
  );
  registerTrustedInvoke(
    IPC.supportExportBundle,
    trusted,
    async (raw): Promise<ExportSupportBundleResult> => {
      const prepared = await service.prepareBundle(raw);
      const destination = await context.showSaveDialog(prepared.suggestedFileName);
      if (destination === null) return { status: 'CANCELLED' };
      return service.writePreparedBundle(prepared, destination);
    },
  );
  registerTrustedInvoke(IPC.supportGetActivityHistory, trusted, (): Promise<ActivityHistory> =>
    context.getActivityHistory(),
  );
}
