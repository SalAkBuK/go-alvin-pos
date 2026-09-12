import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createUpdateService,
  DEFAULT_STARTUP_CHECK_DELAY_MS,
  DEFAULT_UPDATE_CHECK_INTERVAL_MS,
} from '../../src/main/updater/updateService';
import type { UpdaterAdapter, UpdaterAdapterEvent } from '../../src/main/updater/updaterAdapter';
import { createCapturingLogger } from '../helpers/database';

type FakeAdapter = UpdaterAdapter & {
  emit: (event: UpdaterAdapterEvent, ...args: unknown[]) => void;
  checkForUpdates: ReturnType<typeof vi.fn>;
  quitAndInstall: ReturnType<typeof vi.fn>;
};

/** A controllable fake of the narrow `UpdaterAdapter` surface — never touches electron-updater. */
function createFakeAdapter(): FakeAdapter {
  const listeners = new Map<UpdaterAdapterEvent, Array<(...args: unknown[]) => void>>();
  return {
    on: (event: UpdaterAdapterEvent, listener: (...args: unknown[]) => void): void => {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
    },
    emit: (event: UpdaterAdapterEvent, ...args: unknown[]): void => {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
    },
    // Default: resolves to `undefined` and emits nothing on its own — tests
    // that care about the event sequence emit explicitly or override this.
    checkForUpdates: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(),
  } as unknown as FakeAdapter;
}

/** Bring a fresh service straight to a READY, install-eligible state. */
function makeReadyService(overrides?: {
  readonly getMaintenanceState?: () =>
    | 'SAFE'
    | 'CHECKOUT_ACTIVE'
    | 'TRANSACTION_IN_FLIGHT'
    | 'MIGRATION_IN_PROGRESS'
    | 'RESTORE_IN_PROGRESS';
}): { service: ReturnType<typeof createUpdateService>; fake: FakeAdapter } {
  const fake = createFakeAdapter();
  const service = createUpdateService({
    logger: createCapturingLogger().logger,
    currentVersion: '1.0.0',
    isPackaged: true,
    feedUrl: 'https://updates.example.com/feed/',
    createAdapter: () => fake,
    getMaintenanceState: overrides?.getMaintenanceState ?? (() => 'SAFE'),
  });
  fake.emit('update-available', { version: '1.1.0' });
  fake.emit('update-downloaded', { version: '1.1.0' });
  return { service, fake };
}

const emptySnapshot = {
  state: 'UNKNOWN',
  currentVersion: '1.0.0',
  availableVersion: null,
  progressPercent: null,
  lastCheckedAt: null,
  failureCode: null,
};

describe('createUpdateService — construction and normalization (Phase 2N-A/2N-B)', () => {
  it('stays UNKNOWN and never constructs an adapter when unpackaged (development)', () => {
    const capture = createCapturingLogger();
    const createAdapter = vi.fn();

    const service = createUpdateService({
      logger: capture.logger,
      currentVersion: '1.0.0',
      isPackaged: false,
      getMaintenanceState: () => 'SAFE' as const,
      feedUrl: 'https://updates.example.com/feed/',
      createAdapter,
    });

    expect(service.getSnapshot()).toEqual(emptySnapshot);
    expect(createAdapter).not.toHaveBeenCalled();
  });

  it('stays UNKNOWN when packaged but no feed is configured', () => {
    const createAdapter = vi.fn();
    const service = createUpdateService({
      logger: createCapturingLogger().logger,
      currentVersion: '1.0.0',
      isPackaged: true,
      getMaintenanceState: () => 'SAFE' as const,
      feedUrl: null,
      createAdapter,
    });

    expect(service.getSnapshot().state).toBe('UNKNOWN');
    expect(createAdapter).not.toHaveBeenCalled();
  });

  it('has no database or checkout dependency — constructs from logger/version/packaging/feed alone', () => {
    // Deliberately no `getDb`, no maintenance coordinator, no repository — if
    // this compiled and constructed, the service has no such dependency.
    const service = createUpdateService({
      logger: createCapturingLogger().logger,
      currentVersion: '2.3.4',
      isPackaged: false,
      getMaintenanceState: () => 'SAFE' as const,
      feedUrl: null,
    });
    expect(service.getSnapshot().currentVersion).toBe('2.3.4');
  });

  it('fails open (FAILED/INIT_FAILED) when adapter construction throws, never propagating the exception', () => {
    const capture = createCapturingLogger();
    let service: ReturnType<typeof createUpdateService> | undefined;

    expect(() => {
      service = createUpdateService({
        logger: capture.logger,
        currentVersion: '1.0.0',
        isPackaged: true,
        getMaintenanceState: () => 'SAFE' as const,
        feedUrl: 'https://updates.example.com/feed/',
        createAdapter: () => {
          throw new Error('simulated: electron-updater module failed to load');
        },
      });
    }).not.toThrow();

    expect(service?.getSnapshot()).toEqual({
      ...emptySnapshot,
      state: 'FAILED',
      failureCode: 'INIT_FAILED',
    });
    // The raw error/message must never appear in a log field.
    for (const record of capture.records) {
      expect(JSON.stringify(record.fields ?? {})).not.toContain('electron-updater module failed');
    }
  });

  it('normalizes checking/available/no-update/downloading/ready into safe states', () => {
    const fake = createFakeAdapter();
    const service = createUpdateService({
      logger: createCapturingLogger().logger,
      currentVersion: '1.0.0',
      isPackaged: true,
      getMaintenanceState: () => 'SAFE' as const,
      feedUrl: 'https://updates.example.com/feed/',
      createAdapter: () => fake,
    });

    expect(service.getSnapshot().state).toBe('IDLE');

    fake.emit('checking-for-update');
    expect(service.getSnapshot().state).toBe('CHECKING');

    fake.emit('update-available', { version: '1.1.0', releaseNotes: '<script>evil</script>' });
    const afterAvailable = service.getSnapshot();
    expect(afterAvailable.state).toBe('AVAILABLE');
    expect(afterAvailable.availableVersion).toBe('1.1.0');
    // Only the known keys — `releaseNotes` (or any other library field) must never leak through.
    expect(Object.keys(afterAvailable).sort()).toEqual(Object.keys(emptySnapshot).sort());

    fake.emit('download-progress', {
      percent: 42.6,
      bytesPerSecond: 999,
      transferred: 1,
      total: 2,
    });
    const downloading = service.getSnapshot();
    expect(downloading.state).toBe('DOWNLOADING');
    expect(downloading.progressPercent).toBe(43);

    fake.emit('update-downloaded', { version: '1.1.0' });
    const ready = service.getSnapshot();
    expect(ready.state).toBe('READY');
    expect(ready.progressPercent).toBe(100);

    fake.emit('update-not-available', { version: '1.0.0' });
    const idle = service.getSnapshot();
    expect(idle.state).toBe('IDLE');
    expect(idle.availableVersion).toBeNull();
  });

  it('classifies an error during download as DOWNLOAD_FAILED and otherwise as CHECK_FAILED, without leaking the raw error', () => {
    const fake = createFakeAdapter();
    const service = createUpdateService({
      logger: createCapturingLogger().logger,
      currentVersion: '1.0.0',
      isPackaged: true,
      getMaintenanceState: () => 'SAFE' as const,
      feedUrl: 'https://updates.example.com/feed/',
      createAdapter: () => fake,
    });

    fake.emit('checking-for-update');
    fake.emit(
      'error',
      Object.assign(new Error('ENOTFOUND updates.example.com'), {
        stack: 'sensitive stack trace',
      }),
    );
    const afterCheckError = service.getSnapshot();
    expect(afterCheckError.state).toBe('FAILED');
    expect(afterCheckError.failureCode).toBe('CHECK_FAILED');

    fake.emit('checking-for-update');
    fake.emit('update-available', { version: '2.0.0' });
    fake.emit('download-progress', { percent: 10 });
    fake.emit('error', new Error('disk full'));
    const afterDownloadError = service.getSnapshot();
    expect(afterDownloadError.state).toBe('FAILED');
    expect(afterDownloadError.failureCode).toBe('DOWNLOAD_FAILED');

    expect(JSON.stringify(afterDownloadError)).not.toContain('disk full');
    expect(JSON.stringify(afterDownloadError)).not.toContain('sensitive stack trace');
  });

  it('never exposes anything beyond the plain-data snapshot shape (no functions, no nested objects)', () => {
    const fake = createFakeAdapter();
    const service = createUpdateService({
      logger: createCapturingLogger().logger,
      currentVersion: '1.0.0',
      isPackaged: true,
      getMaintenanceState: () => 'SAFE' as const,
      feedUrl: 'https://updates.example.com/feed/',
      createAdapter: () => fake,
    });

    fake.emit('update-available', { version: '1.1.0' });
    const snapshot = service.getSnapshot();

    expect(() => JSON.stringify(snapshot)).not.toThrow();
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    for (const value of Object.values(snapshot)) {
      expect(typeof value === 'function').toBe(false);
      expect(typeof value === 'object' && value !== null).toBe(false);
    }
  });

  it('tracks lastCheckedAt only on a completed check, never on an error', () => {
    const fake = createFakeAdapter();
    const dates = ['2026-09-13T10:00:00.000Z', '2026-09-13T11:00:00.000Z'];
    let i = 0;
    const service = createUpdateService({
      logger: createCapturingLogger().logger,
      currentVersion: '1.0.0',
      isPackaged: true,
      getMaintenanceState: () => 'SAFE' as const,
      feedUrl: 'https://updates.example.com/feed/',
      createAdapter: () => fake,
      now: () => new Date(dates[i++] ?? dates[dates.length - 1] ?? '2026-01-01T00:00:00.000Z'),
    });

    expect(service.getSnapshot().lastCheckedAt).toBeNull();

    fake.emit('error', new Error('network down'));
    expect(service.getSnapshot().lastCheckedAt).toBeNull();

    fake.emit('update-not-available', {});
    expect(service.getSnapshot().lastCheckedAt).toBe(dates[0]);

    fake.emit('update-available', { version: '2.0.0' });
    expect(service.getSnapshot().lastCheckedAt).toBe(dates[1]);
  });
});

describe('createUpdateService — checkNow() (Phase 2N-B)', () => {
  it('checkNow() is a safe no-op resolving to the current snapshot when unsupported', async () => {
    const service = createUpdateService({
      logger: createCapturingLogger().logger,
      currentVersion: '1.0.0',
      isPackaged: false,
      getMaintenanceState: () => 'SAFE' as const,
      feedUrl: null,
    });

    await expect(service.checkNow()).resolves.toEqual(emptySnapshot);
  });

  it('checkNow() calls the adapter and resolves to the normalized snapshot', async () => {
    const fake = createFakeAdapter();
    fake.checkForUpdates.mockImplementation(async () => {
      fake.emit('checking-for-update');
      fake.emit('update-available', { version: '1.2.0' });
    });
    const service = createUpdateService({
      logger: createCapturingLogger().logger,
      currentVersion: '1.0.0',
      isPackaged: true,
      getMaintenanceState: () => 'SAFE' as const,
      feedUrl: 'https://updates.example.com/feed/',
      createAdapter: () => fake,
    });

    const result = await service.checkNow();
    expect(result.state).toBe('AVAILABLE');
    expect(result.availableVersion).toBe('1.2.0');
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('checkNow() never rejects, even when the adapter rejects, and never leaks the raw error', async () => {
    const fake = createFakeAdapter();
    fake.checkForUpdates.mockImplementation(() => {
      fake.emit('error', new Error('secret-internal-detail'));
      return Promise.reject(new Error('secret-internal-detail'));
    });
    const service = createUpdateService({
      logger: createCapturingLogger().logger,
      currentVersion: '1.0.0',
      isPackaged: true,
      getMaintenanceState: () => 'SAFE' as const,
      feedUrl: 'https://updates.example.com/feed/',
      createAdapter: () => fake,
    });

    await expect(service.checkNow()).resolves.toMatchObject({
      state: 'FAILED',
      failureCode: 'CHECK_FAILED',
    });
    const snapshot = await service.checkNow();
    expect(JSON.stringify(snapshot)).not.toContain('secret-internal-detail');
  });

  it('concurrent checkNow() calls share the one in-flight check (no overlapping checks)', async () => {
    const fake = createFakeAdapter();
    let resolveCheck: (() => void) | undefined;
    // `Once`: only the FIRST call is held open; a later, separate `checkNow()`
    // (after this one settles) falls back to the default auto-resolving fake.
    fake.checkForUpdates.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveCheck = resolve;
        }),
    );
    const service = createUpdateService({
      logger: createCapturingLogger().logger,
      currentVersion: '1.0.0',
      isPackaged: true,
      getMaintenanceState: () => 'SAFE' as const,
      feedUrl: 'https://updates.example.com/feed/',
      createAdapter: () => fake,
    });

    const first = service.checkNow();
    const second = service.checkNow();
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);

    resolveCheck?.();
    await Promise.all([first, second]);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);

    // A later call, after the first has settled, starts a NEW check.
    await service.checkNow();
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(2);
  });
});

describe('createUpdateService — scheduling (Phase 2N-B)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('start() is a no-op when unsupported (no adapter) — no timer, checkForUpdates never called', () => {
    vi.useFakeTimers();
    const createAdapter = vi.fn();
    const service = createUpdateService({
      logger: createCapturingLogger().logger,
      currentVersion: '1.0.0',
      isPackaged: false,
      getMaintenanceState: () => 'SAFE' as const,
      feedUrl: null,
      createAdapter,
    });

    service.start();
    expect(service.running).toBe(false);
    vi.advanceTimersByTime(DEFAULT_UPDATE_CHECK_INTERVAL_MS * 3);
    expect(createAdapter).not.toHaveBeenCalled();
  });

  it('performs the startup check only after the configured delay, never immediately', async () => {
    vi.useFakeTimers();
    const fake = createFakeAdapter();
    const service = createUpdateService({
      logger: createCapturingLogger().logger,
      currentVersion: '1.0.0',
      isPackaged: true,
      getMaintenanceState: () => 'SAFE' as const,
      feedUrl: 'https://updates.example.com/feed/',
      createAdapter: () => fake,
      startupCheckDelayMs: 5_000,
    });

    service.start();
    expect(service.running).toBe(true);
    expect(fake.checkForUpdates).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(fake.checkForUpdates).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('reschedules a bounded periodic check after each completed check', async () => {
    vi.useFakeTimers();
    const fake = createFakeAdapter();
    const service = createUpdateService({
      logger: createCapturingLogger().logger,
      currentVersion: '1.0.0',
      isPackaged: true,
      getMaintenanceState: () => 'SAFE' as const,
      feedUrl: 'https://updates.example.com/feed/',
      createAdapter: () => fake,
      startupCheckDelayMs: 1_000,
      checkIntervalMs: 10_000,
    });

    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('a failed check does not stop future periodic checks', async () => {
    vi.useFakeTimers();
    const fake = createFakeAdapter();
    fake.checkForUpdates
      .mockImplementationOnce(() => {
        fake.emit('error', new Error('temporary feed outage'));
        return Promise.reject(new Error('temporary feed outage'));
      })
      .mockImplementation(async () => {
        fake.emit('update-not-available', {});
      });
    const service = createUpdateService({
      logger: createCapturingLogger().logger,
      currentVersion: '1.0.0',
      isPackaged: true,
      getMaintenanceState: () => 'SAFE' as const,
      feedUrl: 'https://updates.example.com/feed/',
      createAdapter: () => fake,
      startupCheckDelayMs: 1_000,
      checkIntervalMs: 5_000,
    });

    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.getSnapshot().state).toBe('FAILED');

    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(service.getSnapshot().state).toBe('IDLE');
  });

  it('stopSync() stops the pending timer cleanly — no further checks fire', async () => {
    vi.useFakeTimers();
    const fake = createFakeAdapter();
    const service = createUpdateService({
      logger: createCapturingLogger().logger,
      currentVersion: '1.0.0',
      isPackaged: true,
      getMaintenanceState: () => 'SAFE' as const,
      feedUrl: 'https://updates.example.com/feed/',
      createAdapter: () => fake,
      startupCheckDelayMs: DEFAULT_STARTUP_CHECK_DELAY_MS,
    });

    service.start();
    service.stopSync();
    expect(service.running).toBe(false);

    await vi.advanceTimersByTimeAsync(DEFAULT_STARTUP_CHECK_DELAY_MS + 1);
    expect(fake.checkForUpdates).not.toHaveBeenCalled();
  });

  it('start() does not schedule twice when called again while already running', async () => {
    vi.useFakeTimers();
    const fake = createFakeAdapter();
    const service = createUpdateService({
      logger: createCapturingLogger().logger,
      currentVersion: '1.0.0',
      isPackaged: true,
      getMaintenanceState: () => 'SAFE' as const,
      feedUrl: 'https://updates.example.com/feed/',
      createAdapter: () => fake,
      startupCheckDelayMs: 1_000,
      checkIntervalMs: 10_000,
    });

    service.start();
    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
  });
});

describe('createUpdateService — restartAndInstall() (Phase 2N-C)', () => {
  it('rejects with UNSUPPORTED when no real adapter is active', () => {
    const service = createUpdateService({
      logger: createCapturingLogger().logger,
      currentVersion: '1.0.0',
      isPackaged: false,
      feedUrl: null,
      getMaintenanceState: () => 'SAFE',
    });

    expect(service.restartAndInstall()).toEqual({ code: 'UNSUPPORTED' });
  });

  it('rejects with NOT_READY when state is not READY (e.g. still IDLE)', () => {
    const fake = createFakeAdapter();
    const service = createUpdateService({
      logger: createCapturingLogger().logger,
      currentVersion: '1.0.0',
      isPackaged: true,
      feedUrl: 'https://updates.example.com/feed/',
      createAdapter: () => fake,
      getMaintenanceState: () => 'SAFE',
    });

    expect(service.restartAndInstall()).toEqual({ code: 'NOT_READY' });
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
  });

  it('rejects with NOT_READY when only DOWNLOADING, not yet READY', () => {
    const fake = createFakeAdapter();
    const service = createUpdateService({
      logger: createCapturingLogger().logger,
      currentVersion: '1.0.0',
      isPackaged: true,
      feedUrl: 'https://updates.example.com/feed/',
      createAdapter: () => fake,
      getMaintenanceState: () => 'SAFE',
    });
    fake.emit('update-available', { version: '1.1.0' });
    fake.emit('download-progress', { percent: 50 });

    expect(service.restartAndInstall()).toEqual({ code: 'NOT_READY' });
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
  });

  it('SAFE + READY invokes the real install primitive exactly once and returns INSTALL_ACCEPTED', () => {
    const { service, fake } = makeReadyService();

    expect(service.restartAndInstall()).toEqual({ code: 'INSTALL_ACCEPTED' });
    expect(fake.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['CHECKOUT_ACTIVE'],
    ['TRANSACTION_IN_FLIGHT'],
    ['MIGRATION_IN_PROGRESS'],
    ['RESTORE_IN_PROGRESS'],
  ] as const)(
    'denies install when maintenance state is %s, without calling quitAndInstall',
    (state) => {
      const { service, fake } = makeReadyService({ getMaintenanceState: () => state });

      expect(service.restartAndInstall()).toEqual({ code: state });
      expect(fake.quitAndInstall).not.toHaveBeenCalled();
    },
  );

  it('maps a synchronous quitAndInstall failure to INSTALL_FAILED without leaking the raw error', () => {
    const { service, fake } = makeReadyService();
    fake.quitAndInstall.mockImplementation(() => {
      throw new Error('secret-internal-detail');
    });

    const result = service.restartAndInstall();
    expect(result).toEqual({ code: 'INSTALL_FAILED' });
    expect(JSON.stringify(result)).not.toContain('secret-internal-detail');
  });

  it('race-safety: re-checks maintenance state fresh at call time, not at construction time', () => {
    let currentState: 'SAFE' | 'CHECKOUT_ACTIVE' = 'CHECKOUT_ACTIVE';
    const { service, fake } = makeReadyService({ getMaintenanceState: () => currentState });

    // Denied while unsafe.
    expect(service.restartAndInstall()).toEqual({ code: 'CHECKOUT_ACTIVE' });
    expect(fake.quitAndInstall).not.toHaveBeenCalled();

    // State becomes safe between calls (e.g. the sale completed) — the SAME
    // service, with no reconstruction, must now allow it. A stale renderer
    // snapshot cannot force a restart: only this fresh call matters.
    currentState = 'SAFE';
    expect(service.restartAndInstall()).toEqual({ code: 'INSTALL_ACCEPTED' });
    expect(fake.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('never throws, even when getMaintenanceState itself throws', () => {
    const { service } = makeReadyService({
      getMaintenanceState: () => {
        throw new Error('should not happen, but must not crash the service either');
      },
    });

    expect(() => service.restartAndInstall()).not.toThrow();
  });
});
