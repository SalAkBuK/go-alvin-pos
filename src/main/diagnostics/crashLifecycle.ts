import type { App } from 'electron';
import type { CrashEvidenceService } from './crashEvidence';

interface ProcessGoneDetails {
  readonly reason: string;
  readonly exitCode: number;
}

interface ChildProcessGoneDetails extends ProcessGoneDetails {
  readonly type: string;
  readonly serviceName?: string;
  readonly name?: string;
}

/** Record a main-process fatal surface without changing Node's default termination behavior. */
export function recordMainProcessFailure(
  crashEvidence: CrashEvidenceService,
  error: Error,
  origin: NodeJS.UncaughtExceptionOrigin,
): void {
  crashEvidence.record({
    processType: 'MAIN',
    eventType:
      origin === 'unhandledRejection'
        ? 'main_process_unhandled_rejection'
        : 'main_process_uncaught_exception',
    errorCode:
      origin === 'unhandledRejection'
        ? 'MAIN_PROCESS_UNHANDLED_REJECTION'
        : 'MAIN_PROCESS_UNCAUGHT_EXCEPTION',
    exception: error,
  });
}

export function recordRendererProcessGone(
  crashEvidence: CrashEvidenceService,
  webContentsId: number,
  details: ProcessGoneDetails,
): void {
  if (details.reason === 'clean-exit') return;
  crashEvidence.record({
    processType: 'RENDERER',
    eventType: 'renderer_process_gone',
    errorCode: 'RENDERER_PROCESS_GONE',
    termination: details,
    correlationIds: { webContentsId: String(webContentsId) },
  });
}

export function recordChildProcessGone(
  crashEvidence: CrashEvidenceService,
  details: ChildProcessGoneDetails,
): void {
  if (details.reason === 'clean-exit') return;
  crashEvidence.record({
    processType: 'CHILD',
    eventType: 'child_process_gone',
    errorCode: 'CHILD_PROCESS_GONE',
    termination: details,
    details: {
      childType: details.type,
      ...(details.name ? { name: details.name } : {}),
      ...(details.serviceName ? { serviceName: details.serviceName } : {}),
    },
  });
}

/** Install only reliable main-process-owned Node/Electron failure surfaces. */
export function installCrashEvidenceHandlers(
  electronApp: App,
  nodeProcess: NodeJS.Process,
  crashEvidence: CrashEvidenceService,
): void {
  nodeProcess.on('uncaughtExceptionMonitor', (error, origin) => {
    recordMainProcessFailure(crashEvidence, error, origin);
  });
  electronApp.on('render-process-gone', (_event, webContents, details) => {
    recordRendererProcessGone(crashEvidence, webContents.id, details);
  });
  electronApp.on('child-process-gone', (_event, details) => {
    recordChildProcessGone(crashEvidence, details);
  });
}
