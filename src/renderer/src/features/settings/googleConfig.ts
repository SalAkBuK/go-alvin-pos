import type { GoogleConfig, GoogleQueueSummary } from '../../../../shared/google';

/**
 * Pure, React-free helpers for Settings → Google Sheets (Phase 2J.1). No jsdom
 * in the renderer suites, so the display strings and gates are unit-tested here
 * directly. The trusted main process re-derives everything.
 *
 * The renderer never sees a token, credential, spreadsheet ID, worksheet name,
 * provisioning token, or OAuth client configuration — only the sanitized
 * `GoogleConfig`.
 */

export type GoogleView = 'loading' | 'unavailable' | 'disconnected' | 'setup-incomplete' | 'ready';

export function googleView(config: GoogleConfig | null): GoogleView {
  if (config === null) {
    return 'loading';
  }
  if (!config.oauthClientConfigured || !config.secureStorageAvailable) {
    return 'unavailable';
  }
  switch (config.setupState) {
    case 'READY':
      return 'ready';
    case 'SETUP_INCOMPLETE':
      return 'setup-incomplete';
    default:
      return 'disconnected';
  }
}

export function describeUnavailable(config: GoogleConfig | null): string {
  if (config && !config.secureStorageAvailable) {
    return 'This device cannot store a Google connection securely, so Google Sheets export is unavailable here.';
  }
  return 'Google Sheets export is not available in this build of Go Phones POS.';
}

export function describeConnection(config: GoogleConfig | null): string {
  if (config === null) {
    return 'Loading…';
  }
  if (config.connected) {
    return config.accountEmail ? `Connected as ${config.accountEmail}` : 'Connected';
  }
  return 'Not connected';
}

export function describeSync(config: GoogleConfig | null): string {
  if (config === null) {
    return '';
  }
  if (config.needsReauthorization) {
    return 'Google needs you to sign in again. Sales are safe and will export once reconnected.';
  }
  if (!config.enabled) {
    return 'Export is paused. Completed sales are saved locally and will sync when you turn export on.';
  }
  const backlog = config.queue.pending + config.queue.exporting + config.queue.failed;
  if (config.queue.failed > 0) {
    return `${String(config.queue.failed)} export${config.queue.failed === 1 ? '' : 's'} need attention. Sales are safe.`;
  }
  if (backlog > 0) {
    return `${String(backlog)} sale${backlog === 1 ? '' : 's'} waiting to sync.`;
  }
  return 'Up to date.';
}

export function describeQueue(queue: GoogleQueueSummary): string {
  return `${String(queue.pending)} pending · ${String(queue.exporting)} exporting · ${String(
    queue.exported,
  )} exported · ${String(queue.failed)} failed`;
}

export function describeLastSync(config: GoogleConfig | null): string {
  if (config === null || config.lastSuccessfulSyncAt === null) {
    return 'Never';
  }
  const instant = new Date(config.lastSuccessfulSyncAt);
  if (Number.isNaN(instant.getTime())) {
    return config.lastSuccessfulSyncAt;
  }
  return instant.toLocaleString();
}

/** Whether the "Turn export on/off" toggle should be shown and its next value. */
export function canToggleEnabled(config: GoogleConfig | null): boolean {
  return config !== null && config.setupState === 'READY';
}
