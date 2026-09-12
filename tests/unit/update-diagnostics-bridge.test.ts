import { describe, expect, it } from 'vitest';
import { createUpdaterStateInspector } from '../../src/main/updater/updateDiagnosticsBridge';
import { buildUpdateDiagnostic } from '../../src/main/diagnostics/updateHealth';
import type { UpdateService } from '../../src/main/updater/updateService';
import type { UpdateServiceSnapshot } from '../../src/main/updater/types';

function fakeService(snapshot: UpdateServiceSnapshot): UpdateService {
  return {
    getSnapshot: () => snapshot,
    start: () => undefined,
    stopSync: () => undefined,
    running: false,
    checkNow: () => Promise.resolve(snapshot),
    restartAndInstall: () => ({ code: 'UNSUPPORTED' }),
  };
}

const base: UpdateServiceSnapshot = {
  state: 'UNKNOWN',
  currentVersion: '1.0.0',
  availableVersion: null,
  progressPercent: null,
  lastCheckedAt: null,
  failureCode: null,
};

describe('createUpdaterStateInspector (Phase 2N-B Phase 2M diagnostics bridge)', () => {
  it('reports unsupported/UNKNOWN honestly when no real updater is active', async () => {
    const inspector = createUpdaterStateInspector(fakeService(base));
    await expect(inspector.inspect()).resolves.toEqual({
      supported: false,
      state: 'UNKNOWN',
      currentVersion: '1.0.0',
      availableVersion: null,
      lastCheckedAt: null,
      issueCode: null,
    });
  });

  it('maps IDLE/CHECKING to UP_TO_DATE, supported:true', async () => {
    for (const state of ['IDLE', 'CHECKING'] as const) {
      const inspector = createUpdaterStateInspector(fakeService({ ...base, state }));
      const result = await inspector.inspect();
      expect(result.supported).toBe(true);
      expect(result.state).toBe('UP_TO_DATE');
      expect(result.issueCode).toBeNull();
    }
  });

  it('maps AVAILABLE directly, carrying the available version', async () => {
    const inspector = createUpdaterStateInspector(
      fakeService({ ...base, state: 'AVAILABLE', availableVersion: '1.2.0' }),
    );
    const result = await inspector.inspect();
    expect(result.supported).toBe(true);
    expect(result.state).toBe('AVAILABLE');
    expect(result.availableVersion).toBe('1.2.0');
  });

  it('maps DOWNLOADING and READY to the existing PENDING vocabulary (no second update-health model)', async () => {
    for (const state of ['DOWNLOADING', 'READY'] as const) {
      const inspector = createUpdaterStateInspector(fakeService({ ...base, state }));
      const result = await inspector.inspect();
      expect(result.supported).toBe(true);
      expect(result.state).toBe('PENDING');
    }
  });

  it('maps FAILED to FAILED/UPDATE_CHECK_FAILED, supported:true (an attempt was made)', async () => {
    for (const failureCode of ['INIT_FAILED', 'CHECK_FAILED', 'DOWNLOAD_FAILED'] as const) {
      const inspector = createUpdaterStateInspector(
        fakeService({ ...base, state: 'FAILED', failureCode }),
      );
      const result = await inspector.inspect();
      expect(result.supported).toBe(true);
      expect(result.state).toBe('FAILED');
      expect(result.issueCode).toBe('UPDATE_CHECK_FAILED');
    }
  });

  it('passes lastCheckedAt through unchanged', async () => {
    const inspector = createUpdaterStateInspector(
      fakeService({ ...base, state: 'IDLE', lastCheckedAt: '2026-09-13T08:00:00.000Z' }),
    );
    const result = await inspector.inspect();
    expect(result.lastCheckedAt).toBe('2026-09-13T08:00:00.000Z');
  });

  it('end-to-end through buildUpdateDiagnostic: a real configured updater never produces CRITICAL, and FAILED is WARNING at most', async () => {
    for (const state of [
      'UNKNOWN',
      'IDLE',
      'CHECKING',
      'AVAILABLE',
      'DOWNLOADING',
      'READY',
      'FAILED',
    ] as const) {
      const inspector = createUpdaterStateInspector(fakeService({ ...base, state }));
      const diagnostic = buildUpdateDiagnostic(await inspector.inspect());
      expect(diagnostic.status).not.toBe('CRITICAL');
      if (state === 'FAILED') {
        expect(diagnostic.status).toBe('WARNING');
      } else {
        expect(diagnostic.status).toBe('HEALTHY');
      }
    }
  });
});
