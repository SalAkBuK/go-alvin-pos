import { describe, expect, it } from 'vitest';
import {
  buildUpdateDiagnostic,
  unsupportedUpdateDiagnostic,
} from '../../src/main/diagnostics/updateHealth';

describe('buildUpdateDiagnostic (pure update-health mapping)', () => {
  it('maps an up-to-date state to HEALTHY with no issue code', () => {
    expect(
      buildUpdateDiagnostic({ supported: true, state: 'UP_TO_DATE', currentVersion: '1.2.3' }),
    ).toEqual({
      status: 'HEALTHY',
      supported: true,
      state: 'UP_TO_DATE',
      currentVersion: '1.2.3',
      availableVersion: null,
      lastCheckedAt: null,
      issueCode: null,
    });
  });

  it('maps an available update to HEALTHY (informational), preserving the available version', () => {
    const diagnostic = buildUpdateDiagnostic({
      supported: true,
      state: 'AVAILABLE',
      currentVersion: '1.2.3',
      availableVersion: '1.3.0',
      lastCheckedAt: '2026-09-12T09:00:00.000Z',
    });
    expect(diagnostic.status).toBe('HEALTHY');
    expect(diagnostic.availableVersion).toBe('1.3.0');
    expect(diagnostic.lastCheckedAt).toBe('2026-09-12T09:00:00.000Z');
    expect(diagnostic.issueCode).toBeNull();
  });

  it('maps download/install pending and deferred to HEALTHY — normal lifecycle states, not problems', () => {
    for (const state of ['PENDING', 'DEFERRED'] as const) {
      const diagnostic = buildUpdateDiagnostic({ supported: true, state, currentVersion: '1.2.3' });
      expect(diagnostic.status).toBe('HEALTHY');
      expect(diagnostic.issueCode).toBeNull();
    }
  });

  it('maps a FAILED state to WARNING with the provided issue code, defaulting when omitted', () => {
    expect(
      buildUpdateDiagnostic({
        supported: true,
        state: 'FAILED',
        currentVersion: '1.2.3',
        issueCode: 'UPDATE_INSTALL_FAILED',
      }),
    ).toMatchObject({ status: 'WARNING', issueCode: 'UPDATE_INSTALL_FAILED' });

    expect(
      buildUpdateDiagnostic({ supported: true, state: 'FAILED', currentVersion: '1.2.3' }),
    ).toMatchObject({ status: 'WARNING', issueCode: 'UPDATE_CHECK_FAILED' });
  });

  it('never returns CRITICAL for any input — the type itself excludes it', () => {
    const states = ['UP_TO_DATE', 'AVAILABLE', 'PENDING', 'DEFERRED', 'FAILED', 'UNKNOWN'] as const;
    for (const state of states) {
      for (const supported of [true, false]) {
        const diagnostic = buildUpdateDiagnostic({ supported, state, currentVersion: '1.2.3' });
        expect(diagnostic.status).not.toBe('CRITICAL');
        expect(['HEALTHY', 'WARNING']).toContain(diagnostic.status);
      }
    }
  });

  it('ignores a FAILED state when supported is false — an unsupported check cannot also have "failed"', () => {
    const diagnostic = buildUpdateDiagnostic({
      supported: false,
      state: 'FAILED',
      currentVersion: '1.2.3',
    });
    expect(diagnostic.status).toBe('HEALTHY');
    expect(diagnostic.issueCode).toBeNull();
  });

  it('only ever produces the documented safe fields — no feed URL, path, or raw error possible by construction', () => {
    const diagnostic = buildUpdateDiagnostic({
      supported: true,
      state: 'AVAILABLE',
      currentVersion: '1.2.3',
      availableVersion: '1.3.0',
    });
    expect(Object.keys(diagnostic).sort()).toEqual(
      [
        'status',
        'supported',
        'state',
        'currentVersion',
        'availableVersion',
        'lastCheckedAt',
        'issueCode',
      ].sort(),
    );
  });
});

describe('unsupportedUpdateDiagnostic (the only value V1 ever actually produces)', () => {
  it('honestly reports UNKNOWN/unsupported rather than fabricating a version or check time', () => {
    expect(unsupportedUpdateDiagnostic('1.2.3')).toEqual({
      status: 'HEALTHY',
      supported: false,
      state: 'UNKNOWN',
      currentVersion: '1.2.3',
      availableVersion: null,
      lastCheckedAt: null,
      issueCode: null,
    });
  });

  it('carries through whatever real current app version it is given', () => {
    expect(unsupportedUpdateDiagnostic('9.9.9').currentVersion).toBe('9.9.9');
  });
});
