import type {
  BackupHealth,
  OffDeviceAttentionReason,
  OffDeviceBackupConfiguration,
} from '../../../../shared/backup';
import { formatBackupTimestamp } from './backup';

/**
 * Pure presentation helpers for Settings → External/Network Backup
 * (Phase 2L-C.6). Exported for direct testing (this suite has no jsdom).
 *
 * Wording is deliberately simple and non-technical: no physical disk numbers,
 * PowerShell details, UNC internals, or verification jargon ever reach the
 * renderer — the trusted layer already reduces every off-device outcome to
 * `OffDeviceBackupHealth`'s three states before it gets here.
 */

export type OffDeviceUiState = 'NOT_SET_UP' | 'PROTECTED' | 'NEEDS_ATTENTION';

/** `null` while health has not loaded yet. */
export function offDeviceUiState(health: BackupHealth | null): OffDeviceUiState | null {
  if (health === null) {
    return null;
  }
  const offDevice = health.offDevice;
  if (offDevice === undefined || offDevice.state === 'NOT_CONFIGURED') {
    return 'NOT_SET_UP';
  }
  if (offDevice.state === 'HEALTHY') {
    return 'PROTECTED';
  }
  return 'NEEDS_ATTENTION';
}

/** The one-line status heading — exactly the three approved user-facing strings. */
export function describeOffDeviceStatus(health: BackupHealth | null): string {
  const state = offDeviceUiState(health);
  if (state === null) {
    return 'Loading…';
  }
  if (state === 'NOT_SET_UP') {
    return 'Off-device backup not set up';
  }
  if (state === 'PROTECTED') {
    return 'Protected with an external/network backup';
  }
  return 'External/network backup needs attention';
}

const ATTENTION_REASON_TEXT: Record<OffDeviceAttentionReason, string> = {
  NEVER_SUCCEEDED: 'No external/network backup has completed yet.',
  UNAVAILABLE: 'The external/network location is not reachable right now.',
  STALE: 'The last successful external/network backup was a while ago.',
  LAST_COPY_FAILED: 'The most recent external/network backup copy did not finish.',
  VERIFICATION_FAILED: 'The external/network location could no longer be verified.',
};

/** A short, calm explanation shown only in the `NEEDS_ATTENTION` state; `null` otherwise. */
export function describeOffDeviceAttentionReason(health: BackupHealth | null): string | null {
  const offDevice = health?.offDevice;
  if (!offDevice || offDevice.state !== 'ATTENTION') {
    return null;
  }
  return ATTENTION_REASON_TEXT[offDevice.reason];
}

/** The last verified-successful off-device copy time, or `null` when there is none to show. */
export function describeOffDeviceLastSuccess(health: BackupHealth | null): string | null {
  const offDevice = health?.offDevice;
  if (!offDevice) {
    return null;
  }
  if (offDevice.state === 'HEALTHY') {
    return formatBackupTimestamp(offDevice.lastSuccessfulAt);
  }
  if (offDevice.state === 'ATTENTION' && offDevice.lastSuccessfulAt !== null) {
    return formatBackupTimestamp(offDevice.lastSuccessfulAt);
  }
  return null;
}

/**
 * The configured destination's safe display label (e.g. "External USB drive
 * (E:)" or "Network backup (nas01)") — never a filesystem path. `null` when
 * nothing is configured.
 */
export function describeOffDeviceDestination(
  configuration: OffDeviceBackupConfiguration | null,
): string | null {
  if (configuration === null || !configuration.configured) {
    return null;
  }
  return configuration.displayName;
}

export function describeOffDeviceError(code: string, message: string): string {
  // The trusted layer already supplies a complete, sanitized sentence.
  return message || `The backup location could not be updated (${code}).`;
}

/**
 * `true` only when `configureOffDevice()` actually changed the persisted
 * configuration — a cancelled native dialog resolves the unchanged current
 * configuration, and the renderer must not report that as a success.
 */
export function offDeviceConfigurationChanged(
  before: OffDeviceBackupConfiguration | null,
  after: OffDeviceBackupConfiguration,
): boolean {
  if (before === null) {
    return after.configured;
  }
  if (before.configured !== after.configured) {
    return true;
  }
  if (before.configured && after.configured) {
    return before.updatedAt !== after.updatedAt;
  }
  return false;
}
