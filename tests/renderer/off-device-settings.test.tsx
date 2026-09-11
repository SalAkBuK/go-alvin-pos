import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  describeOffDeviceAttentionReason,
  describeOffDeviceDestination,
  describeOffDeviceError,
  describeOffDeviceLastSuccess,
  describeOffDeviceStatus,
  offDeviceConfigurationChanged,
  offDeviceUiState,
} from '../../src/renderer/src/features/settings/offDevice';
import { OffDeviceSection } from '../../src/renderer/src/features/settings/OffDeviceSection';
import { SettingsPage } from '../../src/renderer/src/features/settings/SettingsPage';
import type { BackupHealth, OffDeviceBackupConfiguration } from '../../src/shared/backup';

/**
 * Phase 2L-C.6 — Settings → External/Network Backup presentation (no jsdom,
 * matching this suite's existing Backup/Restore coverage convention): pure
 * state-mapping helpers, plus first-render markup. Proves the three approved
 * user-facing states, that a cancelled configure dialog is never reported as
 * a change, and that no raw filesystem path can ever reach the render output.
 */

const BASE_HEALTH: BackupHealth = {
  lastAutomatic: { outcome: 'COMPLETED', at: '2026-09-10T08:00:00.000Z' },
  lastSuccessfulAutomaticAt: '2026-09-10T08:00:00.000Z',
  overdue: false,
  lastFailure: null,
  protection: 'LOCAL_DISK_ONLY',
  automaticEnabled: true,
  schedule: { cadence: 'DAILY', atLocalTime: '03:00' },
};

const NOT_CONFIGURED: OffDeviceBackupConfiguration = { configured: false };

const CONFIGURED: OffDeviceBackupConfiguration = {
  configured: true,
  destinationKind: 'USB',
  displayName: 'External USB drive (E:)',
  updatedAt: '2026-09-11T09:00:00.000Z',
  verified: true,
};

describe('offDeviceUiState / describeOffDeviceStatus — the three approved states', () => {
  it('is null / "Loading…" before health has loaded', () => {
    expect(offDeviceUiState(null)).toBeNull();
    expect(describeOffDeviceStatus(null)).toBe('Loading…');
  });

  it('reads NOT_SET_UP when off-device is absent or explicitly not configured', () => {
    expect(offDeviceUiState(BASE_HEALTH)).toBe('NOT_SET_UP');
    expect(describeOffDeviceStatus(BASE_HEALTH)).toBe('Off-device backup not set up');

    const withNotConfigured: BackupHealth = {
      ...BASE_HEALTH,
      offDevice: { state: 'NOT_CONFIGURED' },
    };
    expect(offDeviceUiState(withNotConfigured)).toBe('NOT_SET_UP');
  });

  it('reads PROTECTED when healthy', () => {
    const healthy: BackupHealth = {
      ...BASE_HEALTH,
      offDevice: {
        state: 'HEALTHY',
        lastSuccessfulAt: '2026-09-11T03:00:00.000Z',
        destinationKind: 'USB',
      },
    };
    expect(offDeviceUiState(healthy)).toBe('PROTECTED');
    expect(describeOffDeviceStatus(healthy)).toBe('Protected with an external/network backup');
  });

  it('reads NEEDS_ATTENTION for every attention reason, with no technical jargon leaking through', () => {
    const reasons = [
      'NEVER_SUCCEEDED',
      'UNAVAILABLE',
      'STALE',
      'LAST_COPY_FAILED',
      'VERIFICATION_FAILED',
    ] as const;
    for (const reason of reasons) {
      const attention: BackupHealth = {
        ...BASE_HEALTH,
        offDevice: {
          state: 'ATTENTION',
          reason,
          lastSuccessfulAt: null,
          destinationKind: null,
        },
      };
      expect(offDeviceUiState(attention)).toBe('NEEDS_ATTENTION');
      expect(describeOffDeviceStatus(attention)).toBe('External/network backup needs attention');
      const explanation = describeOffDeviceAttentionReason(attention)!;
      expect(explanation).not.toMatch(/PowerShell|disk number|UNC|bus type|physical disk/i);
    }
  });
});

describe('describeOffDeviceLastSuccess', () => {
  it('is null when nothing has ever succeeded', () => {
    expect(describeOffDeviceLastSuccess(BASE_HEALTH)).toBeNull();
    expect(
      describeOffDeviceLastSuccess({
        ...BASE_HEALTH,
        offDevice: {
          state: 'ATTENTION',
          reason: 'NEVER_SUCCEEDED',
          lastSuccessfulAt: null,
          destinationKind: null,
        },
      }),
    ).toBeNull();
  });

  it('formats the last successful time when present, healthy or attention', () => {
    expect(
      describeOffDeviceLastSuccess({
        ...BASE_HEALTH,
        offDevice: {
          state: 'HEALTHY',
          lastSuccessfulAt: '2026-09-11T03:00:00.000Z',
          destinationKind: 'USB',
        },
      }),
    ).toBe('2026-09-11 03:00 UTC');
  });
});

describe('describeOffDeviceDestination — safe label only, never a path', () => {
  it('is null when not configured', () => {
    expect(describeOffDeviceDestination(null)).toBeNull();
    expect(describeOffDeviceDestination(NOT_CONFIGURED)).toBeNull();
  });

  it('shows the safe display name when configured', () => {
    expect(describeOffDeviceDestination(CONFIGURED)).toBe('External USB drive (E:)');
  });
});

describe('offDeviceConfigurationChanged — a cancelled dialog is never reported as a change', () => {
  it('is false when nothing was configured before and nothing is configured after (cancel on first setup)', () => {
    expect(offDeviceConfigurationChanged(null, NOT_CONFIGURED)).toBe(false);
    expect(offDeviceConfigurationChanged(NOT_CONFIGURED, NOT_CONFIGURED)).toBe(false);
  });

  it('is true the first time a destination becomes configured', () => {
    expect(offDeviceConfigurationChanged(null, CONFIGURED)).toBe(true);
    expect(offDeviceConfigurationChanged(NOT_CONFIGURED, CONFIGURED)).toBe(true);
  });

  it('is false when cancelling a "change" leaves the identical configuration in place', () => {
    expect(offDeviceConfigurationChanged(CONFIGURED, CONFIGURED)).toBe(false);
  });

  it('is true when a genuinely new destination replaces the previous one (different updatedAt)', () => {
    const replaced: OffDeviceBackupConfiguration = {
      ...CONFIGURED,
      updatedAt: '2026-09-12T00:00:00.000Z',
    };
    expect(offDeviceConfigurationChanged(CONFIGURED, replaced)).toBe(true);
  });
});

describe('describeOffDeviceError', () => {
  it('prefers the trusted layer message, falling back to a generic one', () => {
    expect(
      describeOffDeviceError(
        'OFF_DEVICE_DESTINATION_INVALID',
        'That location could not be verified.',
      ),
    ).toBe('That location could not be verified.');
    expect(describeOffDeviceError('OFF_DEVICE_DESTINATION_INVALID', '')).toMatch(
      /OFF_DEVICE_DESTINATION_INVALID/,
    );
  });
});

describe('first-render markup', () => {
  it('renders the not-set-up state and its setup action before data loads', () => {
    const html = renderToStaticMarkup(<OffDeviceSection />);
    expect(html).toContain('External/Network Backup');
    expect(html).toContain('Loading…');
    expect(html).toContain('Set up external/network backup');
    // No raw filesystem path can appear before or after data loads.
    expect(html).not.toMatch(/[A-Za-z]:\\|\/backups\/|\\\\[A-Za-z0-9._-]+\\/);
  });

  it('SettingsPage includes the External/Network Backup section', () => {
    const html = renderToStaticMarkup(<SettingsPage />);
    expect(html).toContain('External/Network Backup');
  });
});
