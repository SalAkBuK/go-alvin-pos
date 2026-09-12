import { describe, expect, it, vi } from 'vitest';
import { createUpdateService } from '../../src/main/updater/updateService';
import type { UpdaterAdapter, UpdaterAdapterEvent } from '../../src/main/updater/updaterAdapter';
import { createCapturingLogger } from '../helpers/database';

/** A controllable fake of the narrow `UpdaterAdapter` surface — never touches electron-updater. */
function createFakeAdapter(): UpdaterAdapter & {
  emit: (event: UpdaterAdapterEvent, ...args: unknown[]) => void;
} {
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
  } as UpdaterAdapter & { emit: (event: UpdaterAdapterEvent, ...args: unknown[]) => void };
}

describe('createUpdateService (Phase 2N-A updater foundation)', () => {
  it('stays UNKNOWN and never constructs an adapter when unpackaged (development)', () => {
    const capture = createCapturingLogger();
    const createAdapter = vi.fn();

    const service = createUpdateService({
      logger: capture.logger,
      currentVersion: '1.0.0',
      isPackaged: false,
      feedUrl: 'https://updates.example.com/feed/',
      createAdapter,
    });

    expect(service.getSnapshot()).toEqual({
      state: 'UNKNOWN',
      currentVersion: '1.0.0',
      availableVersion: null,
      progressPercent: null,
      failureCode: null,
    });
    expect(createAdapter).not.toHaveBeenCalled();
  });

  it('stays UNKNOWN when packaged but no feed is configured', () => {
    const createAdapter = vi.fn();
    const service = createUpdateService({
      logger: createCapturingLogger().logger,
      currentVersion: '1.0.0',
      isPackaged: true,
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
        feedUrl: 'https://updates.example.com/feed/',
        createAdapter: () => {
          throw new Error('simulated: electron-updater module failed to load');
        },
      });
    }).not.toThrow();

    expect(service?.getSnapshot()).toEqual({
      state: 'FAILED',
      currentVersion: '1.0.0',
      availableVersion: null,
      progressPercent: null,
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
    expect(Object.keys(afterAvailable).sort()).toEqual(
      ['availableVersion', 'currentVersion', 'failureCode', 'progressPercent', 'state'].sort(),
    );

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
});
