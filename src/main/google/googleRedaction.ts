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
  [/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]'],
  [/"private_key"\s*:\s*"(?:[^"\\]|\\.)*"/g, '"private_key":"[redacted]"'],
  [/\baccess_token"?\s*[:=]\s*"?[A-Za-z0-9._-]+/gi, 'access_token=[redacted]'],
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

  constructor(
    category: GoogleErrorCategory,
    message: string,
    options: { httpStatus?: number | null; unknownOutcome?: boolean } = {},
  ) {
    super(scrubExternalText(message));
    this.category = category;
    this.httpStatus = options.httpStatus ?? null;
    this.unknownOutcome = options.unknownOutcome ?? false;
  }
}

/** Map an HTTP status from the Sheets API onto a stable category. */
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
