import { IPC } from '../../shared/ipc';
import type { DiagnosticSnapshot } from '../../shared/diagnostics';
import type { Logger } from '../app/logger';
import type { BackupService } from '../backup/backupService';
import type { ProductionDatabase } from '../database/database';
import type { DatabaseStatus } from '../../shared/ipc';
import { createDiagnosticsService } from '../diagnostics/diagnosticsService';
import type { ConnectivityInspector } from '../diagnostics/diagnosticsService';
import type { DiskSpaceInspector } from '../diagnostics/diskSpace';
import type { GoogleConfigService } from '../google/googleConfigService';
import { createElectronPrintAdapter } from '../printing/electronPrintAdapter';
import type { PrintAdapter } from '../printing/printingService';
import { readSelectedPrinter } from '../settings/printerSettingsRepository';
import type { RendererEntry } from '../app/rendererEntry';
import { registerTrustedInvoke } from './trustedInvoke';

export interface DiagnosticsIpcContext {
  readonly logger: Logger;
  readonly appVersion: string;
  readonly installationId: string;
  readonly storagePath: string;
  readonly getDatabase: () => ProductionDatabase | null;
  readonly getDatabaseStatus: () => DatabaseStatus;
  readonly getBackupService: () => BackupService | null;
  readonly getGoogleConfigService: () => GoogleConfigService | null;
  readonly rendererEntry?: RendererEntry;
  readonly printerAdapter?: PrintAdapter;
  readonly diskInspector?: DiskSpaceInspector;
  readonly connectivityInspector?: ConnectivityInspector;
}

/** Two narrow, pathless, read-only diagnostic capabilities for the next UI slice. */
export function createIpcDiagnosticsService(context: DiagnosticsIpcContext) {
  const printerAdapter = context.printerAdapter ?? createElectronPrintAdapter();
  return createDiagnosticsService({
    appVersion: context.appVersion,
    installationId: context.installationId,
    storagePath: context.storagePath,
    logger: context.logger,
    getDatabase: context.getDatabase,
    getDatabaseStatus: context.getDatabaseStatus,
    getBackupService: context.getBackupService,
    getGoogleConfig: async () => {
      const google = context.getGoogleConfigService();
      if (!google) throw new Error('Google diagnostics unavailable.');
      return google.getConfig();
    },
    getPrinterConfig: async (db) => {
      const selectedDeviceName = readSelectedPrinter(db);
      if (selectedDeviceName === null) {
        return {
          selectedDeviceName: null,
          selectedDisplayName: null,
          selectedIsAvailable: false,
        };
      }
      // Do not use PrintingService's intentionally forgiving enumeration here:
      // diagnostics must distinguish "not found" from "could not inspect".
      const printers = await printerAdapter.listPrinters();
      const selected = printers.find((printer) => printer.deviceName === selectedDeviceName);
      return {
        selectedDeviceName,
        selectedDisplayName: selected?.displayName ?? null,
        selectedIsAvailable: selected !== undefined,
      };
    },
    ...(context.diskInspector ? { diskInspector: context.diskInspector } : {}),
    ...(context.connectivityInspector
      ? { connectivityInspector: context.connectivityInspector }
      : {}),
  });
}

export function registerDiagnosticsIpcHandlers(context: DiagnosticsIpcContext): void {
  const service = createIpcDiagnosticsService(context);
  const trusted = {
    logger: context.logger,
    ...(context.rendererEntry ? { rendererEntry: context.rendererEntry } : {}),
  };

  registerTrustedInvoke(IPC.diagnosticsGetSummary, trusted, (): Promise<DiagnosticSnapshot> =>
    service.getSummary(),
  );
  registerTrustedInvoke(IPC.diagnosticsRun, trusted, (): Promise<DiagnosticSnapshot> =>
    service.runDiagnostics(),
  );
}
