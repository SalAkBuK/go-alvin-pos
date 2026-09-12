import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  AboutUpdatesSection,
  AboutUpdatesView,
} from '../../src/renderer/src/features/settings/AboutUpdatesSection';
import {
  createManualCheckAction,
  createRestartInstallAction,
  describeInstallResult,
  describeProgress,
  describeUpdateStatus,
  formatLastChecked,
} from '../../src/renderer/src/features/settings/aboutUpdates';
import { SettingsPage } from '../../src/renderer/src/features/settings/SettingsPage';
import type { UpdateInstallResultCode, UpdateServiceSnapshot } from '../../src/shared/update';

const base: UpdateServiceSnapshot = {
  state: 'UNKNOWN',
  currentVersion: '1.2.3',
  availableVersion: null,
  progressPercent: null,
  lastCheckedAt: null,
  failureCode: null,
};

describe('describeUpdateStatus — pure state → copy mapping', () => {
  it('UNKNOWN: unsupported/unconfigured build', () => {
    expect(describeUpdateStatus({ ...base, state: 'UNKNOWN' })).toBe(
      'Automatic updates are not configured for this build.',
    );
  });

  it('IDLE: up to date', () => {
    expect(describeUpdateStatus({ ...base, state: 'IDLE' })).toBe("You're up to date.");
  });

  it('CHECKING: checking for updates', () => {
    expect(describeUpdateStatus({ ...base, state: 'CHECKING' })).toBe('Checking for updates…');
  });

  it('AVAILABLE/DOWNLOADING: names the version downloading in the background', () => {
    expect(describeUpdateStatus({ ...base, state: 'AVAILABLE', availableVersion: '1.3.0' })).toBe(
      'Version 1.3.0 is downloading in the background.',
    );
    expect(describeUpdateStatus({ ...base, state: 'DOWNLOADING', availableVersion: '1.3.0' })).toBe(
      'Version 1.3.0 is downloading in the background.',
    );
  });

  it('READY: names the version ready to install', () => {
    expect(describeUpdateStatus({ ...base, state: 'READY', availableVersion: '1.3.0' })).toBe(
      'Go Phones POS 1.3.0 is ready to install.',
    );
  });

  it('FAILED (check): explicitly says the POS can continue normally', () => {
    const message = describeUpdateStatus({
      ...base,
      state: 'FAILED',
      failureCode: 'CHECK_FAILED',
    });
    expect(message).toBe(
      'Could not check for updates. You can continue using Go Phones POS normally.',
    );
    expect(message).not.toMatch(/unsafe|cannot sell|stop/i);
  });

  it('FAILED (download): explicitly says the current version keeps working', () => {
    const message = describeUpdateStatus({
      ...base,
      state: 'FAILED',
      failureCode: 'DOWNLOAD_FAILED',
    });
    expect(message).toBe(
      'The update could not be downloaded. You can continue using the current version.',
    );
  });
});

describe('describeProgress', () => {
  it('is null outside DOWNLOADING', () => {
    expect(describeProgress({ ...base, state: 'READY', progressPercent: 100 })).toBeNull();
  });

  it('shows the percent while downloading', () => {
    expect(describeProgress({ ...base, state: 'DOWNLOADING', progressPercent: 42 })).toBe(
      '42% downloaded',
    );
  });
});

describe('formatLastChecked', () => {
  it('Never for null', () => {
    expect(formatLastChecked(null)).toBe('Never');
  });

  it('formats a valid ISO timestamp', () => {
    expect(formatLastChecked('2026-09-13T08:30:00.000Z')).toBe('2026-09-13 08:30 UTC');
  });
});

describe('describeInstallResult — every maintenance-denial / outcome message', () => {
  it('INSTALL_ACCEPTED has nothing to show', () => {
    expect(describeInstallResult('INSTALL_ACCEPTED')).toBeNull();
  });

  const cases: ReadonlyArray<[UpdateInstallResultCode, string]> = [
    ['NOT_READY', 'The update is not ready to install yet.'],
    ['UNSUPPORTED', 'Updating is not available right now.'],
    ['CHECKOUT_ACTIVE', 'Finish or cancel the current sale before restarting to update.'],
    ['TRANSACTION_IN_FLIGHT', 'A sale is still being saved. Try again in a moment.'],
    [
      'MIGRATION_IN_PROGRESS',
      'Database maintenance is in progress. The update cannot restart yet.',
    ],
    ['RESTORE_IN_PROGRESS', 'A database restore is in progress. The update cannot restart yet.'],
    [
      'INSTALL_FAILED',
      'The update could not be started. You can continue using Go Phones POS normally.',
    ],
  ];
  for (const [code, expected] of cases) {
    it(`${code} → "${expected}"`, () => {
      expect(describeInstallResult(code)).toBe(expected);
    });
  }
});

describe('createManualCheckAction — guarded manual check', () => {
  it('de-duplicates a concurrent call while one is already running', async () => {
    let resolveInvoke: ((value: { ok: true; data: UpdateServiceSnapshot }) => void) | undefined;
    const invoke = vi.fn(
      () =>
        new Promise<{ ok: true; data: UpdateServiceSnapshot }>((resolve) => {
          resolveInvoke = resolve;
        }),
    );
    const onCheckingChange = vi.fn();
    const onSnapshot = vi.fn();
    const onError = vi.fn();
    const action = createManualCheckAction(invoke, { onCheckingChange, onSnapshot, onError });

    const first = action.run();
    const second = action.run();
    expect(invoke).toHaveBeenCalledTimes(1);

    resolveInvoke?.({ ok: true, data: { ...base, state: 'IDLE' } });
    await Promise.all([first, second]);
    expect(onSnapshot).toHaveBeenCalledTimes(1);
  });

  it('maps a failed invoke to the fixed unavailable message, never the raw error', async () => {
    const invoke = vi.fn(() => Promise.reject(new Error('secret-internal-detail')));
    const onError = vi.fn();
    const action = createManualCheckAction(invoke, {
      onCheckingChange: vi.fn(),
      onSnapshot: vi.fn(),
      onError,
    });

    await action.run();
    expect(onError).toHaveBeenCalledWith(
      'Update status is unavailable right now. You can continue using Go Phones POS normally.',
    );
    // onError(null) also fires first (clearing any prior error) — check every call, not just the first.
    for (const call of onError.mock.calls) {
      expect(call[0] ?? '').not.toContain('secret-internal-detail');
    }
  });
});

describe('createRestartInstallAction — guarded restart & install', () => {
  it('de-duplicates a concurrent click', async () => {
    let resolveInvoke:
      ((value: { ok: true; data: { code: UpdateInstallResultCode } }) => void) | undefined;
    const invoke = vi.fn(
      () =>
        new Promise<{ ok: true; data: { code: UpdateInstallResultCode } }>((resolve) => {
          resolveInvoke = resolve;
        }),
    );
    const onBusyChange = vi.fn();
    const onResult = vi.fn();
    const action = createRestartInstallAction(invoke, { onBusyChange, onResult });

    const first = action.run();
    const second = action.run();
    expect(invoke).toHaveBeenCalledTimes(1);

    resolveInvoke?.({ ok: true, data: { code: 'INSTALL_ACCEPTED' } });
    await Promise.all([first, second]);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith('INSTALL_ACCEPTED');
  });

  it('maps a failed invoke to INSTALL_FAILED', async () => {
    const invoke = vi.fn(() => Promise.reject(new Error('boom')));
    const onResult = vi.fn();
    const action = createRestartInstallAction(invoke, { onBusyChange: vi.fn(), onResult });

    await action.run();
    expect(onResult).toHaveBeenCalledWith('INSTALL_FAILED');
  });
});

describe('AboutUpdatesView — presentational states', () => {
  it('unsupported/unconfigured (UNKNOWN): no Restart & Update button', () => {
    const html = renderToStaticMarkup(
      <AboutUpdatesView snapshot={{ ...base, state: 'UNKNOWN' }} schemaVersion={7} />,
    );
    expect(html).toContain('Automatic updates are not configured for this build.');
    expect(html).toContain('1.2.3');
    expect(html).toContain('Database schema');
    expect(html).toContain('7');
    expect(html).not.toContain('Restart &amp; Update');
    expect(html).toContain('Check for Updates');
  });

  it('up to date (IDLE)', () => {
    const html = renderToStaticMarkup(
      <AboutUpdatesView snapshot={{ ...base, state: 'IDLE' }} schemaVersion={7} />,
    );
    expect(html).toContain('You&#x27;re up to date.');
    expect(html).not.toContain('Restart &amp; Update');
  });

  it('checking: disables the Check for Updates button and shows "Checking…"', () => {
    const html = renderToStaticMarkup(
      <AboutUpdatesView snapshot={{ ...base, state: 'CHECKING' }} schemaVersion={7} checking />,
    );
    expect(html).toContain('Checking for updates…');
    expect(html).toContain('Checking…');
    expect(html).toMatch(/<button type="button"[^>]*disabled[^>]*>Checking…/);
  });

  it('available/downloading shows progress and no Restart & Update yet', () => {
    const html = renderToStaticMarkup(
      <AboutUpdatesView
        snapshot={{
          ...base,
          state: 'DOWNLOADING',
          availableVersion: '1.3.0',
          progressPercent: 42,
        }}
        schemaVersion={7}
      />,
    );
    expect(html).toContain('Version 1.3.0 is downloading in the background.');
    expect(html).toContain('42% downloaded');
    expect(html).not.toContain('Restart &amp; Update');
  });

  it('ready: shows both Restart & Update and Later', () => {
    const html = renderToStaticMarkup(
      <AboutUpdatesView
        snapshot={{ ...base, state: 'READY', availableVersion: '1.3.0' }}
        schemaVersion={7}
      />,
    );
    expect(html).toContain('Go Phones POS 1.3.0 is ready to install.');
    expect(html).toContain('Restart &amp; Update');
    expect(html).toContain('Later');
  });

  it('ready + dismissed (after Later): Restart & Update remains, Later is gone', () => {
    const html = renderToStaticMarkup(
      <AboutUpdatesView
        snapshot={{ ...base, state: 'READY', availableVersion: '1.3.0' }}
        schemaVersion={7}
        dismissed
      />,
    );
    expect(html).toContain('Restart &amp; Update');
    expect(html).not.toContain('>Later<');
  });

  it('failed: explicitly says the POS can continue', () => {
    const html = renderToStaticMarkup(
      <AboutUpdatesView
        snapshot={{ ...base, state: 'FAILED', failureCode: 'CHECK_FAILED' }}
        schemaVersion={7}
      />,
    );
    expect(html).toContain('You can continue using Go Phones POS normally.');
  });

  it('each maintenance-denial install result renders its specific friendly message', () => {
    const codes: readonly UpdateInstallResultCode[] = [
      'CHECKOUT_ACTIVE',
      'TRANSACTION_IN_FLIGHT',
      'MIGRATION_IN_PROGRESS',
      'RESTORE_IN_PROGRESS',
    ];
    for (const code of codes) {
      const html = renderToStaticMarkup(
        <AboutUpdatesView
          snapshot={{ ...base, state: 'READY', availableVersion: '1.3.0' }}
          schemaVersion={7}
          installResult={code}
        />,
      );
      expect(html).toContain(describeInstallResult(code));
    }
  });

  it('schema Unavailable when null, never fabricated', () => {
    const html = renderToStaticMarkup(
      <AboutUpdatesView snapshot={{ ...base, state: 'IDLE' }} schemaVersion={null} />,
    );
    expect(html).toContain('Unavailable');
  });

  it('shows safe bundled source/build identity without redesigning update controls', () => {
    const html = renderToStaticMarkup(
      <AboutUpdatesView
        snapshot={{ ...base, state: 'IDLE' }}
        schemaVersion={7}
        buildIdentity={{
          schemaVersion: 7,
          sourceRevision: 'cace83641e666bfaeb72647040eb589b206e1b85',
          buildTimestamp: '2026-09-12T12:00:00.000Z',
          buildIdentifier: '1.2.3+cace83641e66.schema7',
        }}
      />,
    );
    expect(html).toContain('Source revision');
    expect(html).toContain('cace83641e666bfaeb72647040eb589b206e1b85');
    expect(html).toContain('1.2.3+cace83641e66.schema7');
    expect(html).not.toMatch(/C:\\|github\.com|token/i);
  });
});

describe('AboutUpdatesSection / SettingsPage integration', () => {
  it('SettingsPage includes the About & Updates heading', () => {
    const html = renderToStaticMarkup(<SettingsPage />);
    expect(html).toContain('About &amp; Updates');
  });

  it('AboutUpdatesSection first render is an honest loading state, not a crash (no window.pos/no jsdom in this suite)', () => {
    const html = renderToStaticMarkup(<AboutUpdatesSection />);
    expect(html).toContain('About &amp; Updates');
    expect(html).toContain('Loading update status');
  });
});
