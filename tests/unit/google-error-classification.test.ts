import { describe, expect, it } from 'vitest';
import { classifyGoogleErrorResponse } from '../../src/main/google/googleRedaction';
import type { GoogleApiError } from '../../src/main/google/googleRedaction';
import { googleApiRequest } from '../../src/main/google/googleApiRequest';
import { fakeAuthProvider } from '../helpers/google';

/**
 * Phase 2J.1 — Correction C critical error-classification requirement
 * (`ARCHITECTURE.md §27.5.2`, `REQ-GSHEET-020`, `TEST-GSHEET-053`, `-054`,
 * `-055`). HTTP 403 is NOT an always-structural PERMISSION failure: Google
 * returns 403 for real file-permission loss, for rate limits, and for daily
 * quota limits. Only a definite, machine-readable not-found / file-permission
 * result may clear the configured spreadsheet target.
 */

describe('classifyGoogleErrorResponse — transient / non-structural (config preserved)', () => {
  it.each([
    [
      '403 rateLimitExceeded',
      { httpStatus: 403, reasons: ['rateLimitExceeded'], domains: ['usageLimits'] },
    ],
    [
      '403 userRateLimitExceeded',
      { httpStatus: 403, reasons: ['userRateLimitExceeded'], domains: ['usageLimits'] },
    ],
    [
      '403 dailyLimitExceeded',
      { httpStatus: 403, reasons: ['dailyLimitExceeded'], domains: ['usageLimits'] },
    ],
    [
      '403 quotaExceeded',
      { httpStatus: 403, status: 'RESOURCE_EXHAUSTED', reasons: ['quotaExceeded'] },
    ],
    [
      '429 RESOURCE_EXHAUSTED',
      { httpStatus: 429, status: 'RESOURCE_EXHAUSTED', reasons: ['rateLimitExceeded'] },
    ],
  ])('%s → RATE_LIMIT, not structural, definite outcome', (_label, args) => {
    const c = classifyGoogleErrorResponse(args);
    expect(c.category).toBe('RATE_LIMIT');
    expect(c.structuralTarget).toBe(false);
    expect(c.unknownOutcome).toBe(false);
  });

  it.each([500, 502, 503])('HTTP %i → UNKNOWN, unknownOutcome, not structural', (httpStatus) => {
    const c = classifyGoogleErrorResponse({ httpStatus });
    expect(c.category).toBe('UNKNOWN');
    expect(c.unknownOutcome).toBe(true);
    expect(c.structuralTarget).toBe(false);
  });

  it('a bare 403 with no machine-readable reason is NOT structural (ambiguous → preserve)', () => {
    const c = classifyGoogleErrorResponse({ httpStatus: 403 });
    expect(c.category).toBe('PERMISSION');
    expect(c.structuralTarget).toBe(false);
  });

  it('a bare 404 with no reason/status is NOT structural (ambiguous → preserve)', () => {
    const c = classifyGoogleErrorResponse({ httpStatus: 404 });
    expect(c.category).toBe('NOT_FOUND');
    expect(c.structuralTarget).toBe(false);
  });
});

describe('classifyGoogleErrorResponse — structural spreadsheet-target failure', () => {
  it('definite file permission reason → PERMISSION + structuralTarget', () => {
    const c = classifyGoogleErrorResponse({
      httpStatus: 403,
      status: 'PERMISSION_DENIED',
      reasons: ['insufficientFilePermissions'],
    });
    expect(c.category).toBe('PERMISSION');
    expect(c.structuralTarget).toBe(true);
  });

  it('definite not-found target → NOT_FOUND + structuralTarget', () => {
    const c = classifyGoogleErrorResponse({
      httpStatus: 404,
      status: 'NOT_FOUND',
      reasons: ['notFound'],
    });
    expect(c.category).toBe('NOT_FOUND');
    expect(c.structuralTarget).toBe(true);
  });
});

describe('classifyGoogleErrorResponse — credential AUTH failure', () => {
  it('401 / UNAUTHENTICATED → AUTH, never a spreadsheet-target invalidation', () => {
    const c = classifyGoogleErrorResponse({ httpStatus: 401, status: 'UNAUTHENTICATED' });
    expect(c.category).toBe('AUTH');
    expect(c.structuralTarget).toBe(false);
    expect(c.unknownOutcome).toBe(false);
  });
});

describe('googleApiRequest — realistic structured Google error payloads', () => {
  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async function requestWith(status: number, body: unknown): Promise<GoogleApiError> {
    try {
      await googleApiRequest({
        auth: fakeAuthProvider(),
        method: 'GET',
        url: 'https://sheets.googleapis.com/v4/spreadsheets/x/values/Sales!A:A',
        fetchImpl: (() => Promise.resolve(jsonResponse(status, body))) as typeof fetch,
      });
    } catch (error) {
      return error as GoogleApiError;
    }
    throw new Error('expected googleApiRequest to throw');
  }

  it('403 rateLimitExceeded payload → RATE_LIMIT, not structural, raw body not leaked', async () => {
    const err = await requestWith(403, {
      error: {
        code: 403,
        message: 'Rate Limit Exceeded',
        errors: [
          { message: 'Rate Limit Exceeded', domain: 'usageLimits', reason: 'rateLimitExceeded' },
        ],
      },
    });
    expect(err.category).toBe('RATE_LIMIT');
    expect(err.structuralTarget).toBe(false);
    expect(err.message).not.toContain('errors');
  });

  it('403 userRateLimitExceeded payload → RATE_LIMIT, not structural', async () => {
    const err = await requestWith(403, {
      error: {
        code: 403,
        message: 'User Rate Limit Exceeded',
        errors: [{ domain: 'usageLimits', reason: 'userRateLimitExceeded' }],
      },
    });
    expect(err.category).toBe('RATE_LIMIT');
    expect(err.structuralTarget).toBe(false);
  });

  it('429 payload → RATE_LIMIT, not structural', async () => {
    const err = await requestWith(429, {
      error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' },
    });
    expect(err.category).toBe('RATE_LIMIT');
    expect(err.structuralTarget).toBe(false);
  });

  it('500 payload → UNKNOWN unknownOutcome, not structural', async () => {
    const err = await requestWith(500, { error: { code: 500, message: 'Internal error' } });
    expect(err.unknownOutcome).toBe(true);
    expect(err.structuralTarget).toBe(false);
  });

  it('definite 403 PERMISSION_DENIED payload → PERMISSION + structuralTarget', async () => {
    const err = await requestWith(403, {
      error: {
        code: 403,
        message: 'The caller does not have permission',
        status: 'PERMISSION_DENIED',
        errors: [{ domain: 'global', reason: 'forbidden' }],
      },
    });
    expect(err.category).toBe('PERMISSION');
    expect(err.structuralTarget).toBe(true);
  });

  it('definite 404 NOT_FOUND payload → NOT_FOUND + structuralTarget', async () => {
    const err = await requestWith(404, {
      error: {
        code: 404,
        message: 'Requested entity was not found.',
        status: 'NOT_FOUND',
        errors: [{ domain: 'global', reason: 'notFound' }],
      },
    });
    expect(err.category).toBe('NOT_FOUND');
    expect(err.structuralTarget).toBe(true);
  });

  it('401 payload → AUTH, not structural', async () => {
    const err = await requestWith(401, {
      error: { code: 401, status: 'UNAUTHENTICATED', message: 'Invalid Credentials' },
    });
    expect(err.category).toBe('AUTH');
    expect(err.structuralTarget).toBe(false);
  });
});
