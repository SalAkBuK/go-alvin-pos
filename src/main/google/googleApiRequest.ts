import type { GoogleAuthProvider } from './googleAuthProvider';
import {
  classifyGoogleErrorResponse,
  classifyThrown,
  GoogleApiError,
  scrubExternalText,
} from './googleRedaction';

/**
 * One place that turns a Google REST call into either parsed JSON or a
 * classified, credential-free {@link GoogleApiError}. Shared by the Sheets
 * export transport, the Drive provisioning transport, and the Sheets structure
 * transport so bearer-token handling and error scrubbing exist once.
 *
 * A 5xx after the request was sent is treated as an ambiguous (`unknownOutcome`)
 * result so the caller's stale/retry machinery governs it rather than a definite
 * failure. The raw Google response body is never returned or logged — only a
 * scrubbed `error.message` string.
 */

export interface GoogleApiRequestDeps {
  readonly auth: GoogleAuthProvider;
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

export async function googleApiRequest(deps: GoogleApiRequestDeps): Promise<unknown> {
  const doFetch = deps.fetchImpl ?? fetch;

  let token: string;
  try {
    token = await deps.auth.getAccessToken();
  } catch (error) {
    throw new GoogleApiError('AUTH', error instanceof Error ? error.message : String(error), {
      unknownOutcome: false,
    });
  }

  let response: Response;
  try {
    const init: RequestInit = {
      method: deps.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(deps.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
    };
    if (deps.body !== undefined) {
      init.body = JSON.stringify(deps.body);
    }
    if (deps.signal) {
      init.signal = deps.signal;
    }
    response = await doFetch(deps.url, init);
  } catch (error) {
    throw classifyThrown(error);
  }

  if (!response.ok) {
    let detail = `HTTP ${String(response.status)}`;
    let errorStatus: string | null = null;
    let reasons: string[] = [];
    let domains: string[] = [];
    try {
      const parsed = JSON.parse(await response.text()) as {
        error?: {
          message?: string;
          status?: string;
          errors?: Array<{ reason?: unknown; domain?: unknown }>;
        };
      };
      const err = parsed.error;
      if (err?.message) {
        detail = err.message;
      }
      if (typeof err?.status === 'string') {
        errorStatus = err.status;
      }
      if (Array.isArray(err?.errors)) {
        reasons = err.errors
          .map((e) => e?.reason)
          .filter((r): r is string => typeof r === 'string' && r !== '');
        domains = err.errors
          .map((e) => e?.domain)
          .filter((d): d is string => typeof d === 'string' && d !== '');
      }
    } catch {
      /* keep the status-only detail; classify from the HTTP status alone */
    }
    // Only the scrubbed `error.message` string is ever surfaced — the raw
    // response body is never returned, logged, or attached to the error.
    const classified = classifyGoogleErrorResponse({
      httpStatus: response.status,
      status: errorStatus,
      reasons,
      domains,
    });
    throw new GoogleApiError(classified.category, scrubExternalText(detail), {
      httpStatus: response.status,
      unknownOutcome: classified.unknownOutcome,
      structuralTarget: classified.structuralTarget,
    });
  }

  if (deps.method === 'GET') {
    return response.json();
  }
  const text = await response.text();
  if (text.trim() === '') {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
