import type { GoogleErrorCategory } from '../../shared/google';

/**
 * Value-level scrubbing + error classification for the export path (`task §22`,
 * `§23`; `SUPPORT_DIAGNOSTICS.md §14`-`§16`, `§54`).
 *
 * The structured logger already redacts credential-like *keys*; this adds
 * *value* scrubbing for external strings (Google error messages, `last_error`)
 * that could embed a bearer token or a PEM block, and maps a raw failure onto a
 * stable, credential-free category. A Google error must never change local sale
 * state, and its raw form must never be persisted or logged.
 */

const SCRUB_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-key]'],
  [/\bya29\.[A-Za-z0-9._-]+/g, '[redacted-token]'],
  // OAuth refresh tokens (`1//…`) and authorization codes (`4/…`).
  [/\b1\/\/[A-Za-z0-9._-]+/g, '[redacted-token]'],
  [/\b4\/[A-Za-z0-9._-]{10,}/g, '[redacted-code]'],
  [/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]'],
  [/"private_key"\s*:\s*"(?:[^"\\]|\\.)*"/g, '"private_key":"[redacted]"'],
  [
    /\b(access_token|refresh_token|id_token|code_verifier|code_challenge|authorization_code|client_secret)"?\s*[:=]\s*"?[A-Za-z0-9._~+/=-]+/gi,
    '$1=[redacted]',
  ],
];

/** Remove obvious secret material from an externally-sourced string. */
export function scrubExternalText(value: string): string {
  let out = value;
  for (const [pattern, replacement] of SCRUB_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** A scrubbed, bounded diagnostic string safe for `last_error` and logs. */
export function toLastError(category: GoogleErrorCategory, detail: string): string {
  return `${category}: ${scrubExternalText(detail)}`.slice(0, 500);
}

/** A Google/network failure surfaced by the transport, already classified. */
export class GoogleApiError extends Error {
  override readonly name = 'GoogleApiError';
  readonly category: GoogleErrorCategory;
  /** HTTP status when the request reached Google, else `null`. */
  readonly httpStatus: number | null;
  /**
   * `true` only for outcomes where Google may have applied the write but we did
   * not see the response (timeout / abort). The worker must NOT record a
   * definite failure for these — it leaves the job `EXPORTING` for the
   * stale-recovery machinery (`task §12`).
   */
  readonly unknownOutcome: boolean;
  /**
   * `true` only when the structured Google error unambiguously identifies the
   * CONFIGURED spreadsheet target as not-found or not-permitted — a definite
   * structural-target failure that MAY invalidate `google_spreadsheet_id`
   * (`REQ-GSHEET-020`, `ARCHITECTURE.md §27.5.2`). A bare HTTP 403/404 with no
   * confident machine-readable reason, and every rate-limit / quota / transient
   * failure, leaves this `false` so the configuration is preserved.
   */
  readonly structuralTarget: boolean;

  constructor(
    category: GoogleErrorCategory,
    message: string,
    options: {
      httpStatus?: number | null;
      unknownOutcome?: boolean;
      structuralTarget?: boolean;
    } = {},
  ) {
    super(scrubExternalText(message));
    this.category = category;
    this.httpStatus = options.httpStatus ?? null;
    this.unknownOutcome = options.unknownOutcome ?? false;
    this.structuralTarget = options.structuralTarget ?? false;
  }
}

/** Map an HTTP status from the Sheets API onto a stable category (status alone). */
export function classifyHttpStatus(status: number): GoogleErrorCategory {
  if (status === 401) {
    return 'AUTH';
  }
  if (status === 403) {
    return 'PERMISSION';
  }
  if (status === 404) {
    return 'NOT_FOUND';
  }
  if (status === 429) {
    return 'RATE_LIMIT';
  }
  return 'UNKNOWN';
}

/**
 * Machine-readable `error.errors[].reason` values Google uses for rate-limit /
 * quota exhaustion. These are NON-structural: they must preserve the configured
 * spreadsheet and the `Ready to sync` state even when they arrive as HTTP 403
 * (`ARCHITECTURE.md §27.5.2`, `REQ-GSHEET-020`, the critical
 * error-classification requirement).
 */
const RATE_LIMIT_REASONS = new Set([
  'ratelimitexceeded',
  'userratelimitexceeded',
  'dailylimitexceeded',
  'quotaexceeded',
  'rateexceeded',
  'concurrentlimitexceeded',
  'servinglimitexceeded',
  'sharingratelimitexceeded',
]);

/** `error.errors[].reason` values that definitely identify a missing target file. */
const NOT_FOUND_REASONS = new Set(['notfound', 'filenotfound']);

/** `error.errors[].reason` values that definitely identify a per-file permission loss. */
const PERMISSION_REASONS = new Set([
  'insufficientfilepermissions',
  'insufficientpermissions',
  'appnotauthorizedtofile',
  'forbidden',
]);

export interface GoogleErrorClassification {
  readonly category: GoogleErrorCategory;
  readonly unknownOutcome: boolean;
  readonly structuralTarget: boolean;
}

/**
 * Classify a structured Google REST error using the machine-readable fields
 * (`error.status`, `error.errors[].reason`, `error.errors[].domain`) rather than
 * the HTTP status alone. HTTP 403 is deliberately NOT treated as an
 * always-structural PERMISSION failure: Google returns 403 for real file
 * permission loss, for user/project rate limits, and for daily quota limits, and
 * only the first is a structural-target failure. When a 403/404 cannot be
 * confidently distinguished as target-structural, `structuralTarget` stays
 * `false` and the safe backoff/retry behaviour is preserved.
 */
export function classifyGoogleErrorResponse(args: {
  readonly httpStatus: number;
  readonly status?: string | null;
  readonly reasons?: readonly string[];
  readonly domains?: readonly string[];
}): GoogleErrorClassification {
  const httpStatus = args.httpStatus;
  const status = (args.status ?? '').trim().toUpperCase();
  const reasons = (args.reasons ?? []).map((r) => r.trim().toLowerCase()).filter((r) => r !== '');
  const domains = (args.domains ?? []).map((d) => d.trim().toLowerCase()).filter((d) => d !== '');

  // Rate limit / quota — checked FIRST so a 403 carrying `usageLimits` /
  // `rateLimitExceeded` is never mistaken for a structural permission failure.
  const isRateOrQuota =
    httpStatus === 429 ||
    status === 'RESOURCE_EXHAUSTED' ||
    domains.includes('usagelimits') ||
    reasons.some(
      (r) => RATE_LIMIT_REASONS.has(r) || r.includes('ratelimit') || r.includes('quota'),
    );
  if (isRateOrQuota) {
    return { category: 'RATE_LIMIT', unknownOutcome: false, structuralTarget: false };
  }

  // Server-side / ambiguous — leave for the stale/unknown-outcome machinery.
  if (
    httpStatus >= 500 ||
    status === 'UNAVAILABLE' ||
    status === 'INTERNAL' ||
    status === 'DEADLINE_EXCEEDED'
  ) {
    return { category: 'UNKNOWN', unknownOutcome: true, structuralTarget: false };
  }

  // Credential itself — feeds current-generation auth health, never a
  // spreadsheet-target invalidation.
  if (httpStatus === 401 || status === 'UNAUTHENTICATED') {
    return { category: 'AUTH', unknownOutcome: false, structuralTarget: false };
  }

  if (httpStatus === 404) {
    const definite = status === 'NOT_FOUND' || reasons.some((r) => NOT_FOUND_REASONS.has(r));
    return { category: 'NOT_FOUND', unknownOutcome: false, structuralTarget: definite };
  }

  if (httpStatus === 403) {
    const definitePermission =
      status === 'PERMISSION_DENIED' || reasons.some((r) => PERMISSION_REASONS.has(r));
    return { category: 'PERMISSION', unknownOutcome: false, structuralTarget: definitePermission };
  }

  return {
    category: classifyHttpStatus(httpStatus),
    unknownOutcome: false,
    structuralTarget: false,
  };
}

/**
 * Map a thrown fetch/transport error onto a {@link GoogleApiError}. An
 * `AbortError` (our timeout fired) is an UNKNOWN outcome; a connection error is
 * a definite NETWORK failure (the request never reached Google).
 */
export function classifyThrown(error: unknown): GoogleApiError {
  if (error instanceof GoogleApiError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || name === 'TimeoutError' || /timeout|aborted/i.test(message)) {
    return new GoogleApiError('TIMEOUT', message, { unknownOutcome: true });
  }
  return new GoogleApiError('NETWORK', message, { unknownOutcome: false });
}
