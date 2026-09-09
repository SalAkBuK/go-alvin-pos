import { describe, expect, it } from 'vitest';
import {
  classifyHttpStatus,
  classifyThrown,
  GoogleApiError,
  scrubExternalText,
  toLastError,
} from '../../src/main/google/googleRedaction';
import { backoffDelayMs } from '../../src/main/google/exportJobRepository';

/**
 * Phase 2J — value-level scrubbing, error classification, backoff math
 * (`task §11`, `§22`, `§23`; `SUPPORT_DIAGNOSTICS.md §14`-`§16`).
 */

describe('scrubExternalText', () => {
  it('removes bearer tokens, ya29 tokens, and PEM private keys', () => {
    expect(scrubExternalText('Authorization: Bearer ya29.aBcDeF-1234')).not.toMatch(/ya29|aBcDeF/);
    expect(scrubExternalText('token ya29.SECRET_STUFF here')).not.toContain('SECRET_STUFF');
    const pem =
      'oops -----BEGIN PRIVATE KEY-----\nMIIBVERYSECRET\n-----END PRIVATE KEY-----\n done';
    expect(scrubExternalText(pem)).not.toContain('MIIBVERYSECRET');
    expect(scrubExternalText(pem)).toContain('[redacted-key]');
  });

  it('leaves an ordinary Google error message intact', () => {
    expect(scrubExternalText('The caller does not have permission')).toBe(
      'The caller does not have permission',
    );
  });
});

describe('toLastError', () => {
  it('prefixes the category, scrubs, and bounds the length', () => {
    expect(toLastError('PERMISSION', 'nope')).toBe('PERMISSION: nope');
    expect(toLastError('AUTH', 'Bearer ya29.X').startsWith('AUTH: ')).toBe(true);
    expect(toLastError('AUTH', 'Bearer ya29.X')).not.toContain('ya29');
    expect(toLastError('UNKNOWN', 'x'.repeat(2000)).length).toBeLessThanOrEqual(500);
  });
});

describe('classifyHttpStatus', () => {
  it.each([
    [401, 'AUTH'],
    [403, 'PERMISSION'],
    [404, 'NOT_FOUND'],
    [429, 'RATE_LIMIT'],
    [400, 'UNKNOWN'],
    [500, 'UNKNOWN'],
  ])('%i → %s', (status, category) => {
    expect(classifyHttpStatus(status)).toBe(category);
  });
});

describe('classifyThrown', () => {
  it('AbortError → TIMEOUT with unknownOutcome=true', () => {
    const e = classifyThrown(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    expect(e.category).toBe('TIMEOUT');
    expect(e.unknownOutcome).toBe(true);
  });

  it('a connection error → NETWORK, definite (not unknown)', () => {
    const e = classifyThrown(new TypeError('fetch failed: ECONNREFUSED'));
    expect(e.category).toBe('NETWORK');
    expect(e.unknownOutcome).toBe(false);
  });

  it('passes a GoogleApiError through unchanged', () => {
    const original = new GoogleApiError('PERMISSION', 'x', { httpStatus: 403 });
    expect(classifyThrown(original)).toBe(original);
  });
});

describe('backoffDelayMs — exact sequence, capped at 30 min', () => {
  it('30s, 60s, 120s … 30min', () => {
    expect(backoffDelayMs(1)).toBe(30_000);
    expect(backoffDelayMs(2)).toBe(60_000);
    expect(backoffDelayMs(3)).toBe(120_000);
    expect(backoffDelayMs(6)).toBe(960_000);
    expect(backoffDelayMs(7)).toBe(30 * 60_000);
    expect(backoffDelayMs(20)).toBe(30 * 60_000);
  });
});
