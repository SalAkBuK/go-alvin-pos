/**
 * Generic HTTPS/static update-feed configuration (Phase 2N-A —
 * `UPDATE_RELEASE_STRATEGY.md` Sections 6, 41; `PRODUCT_REQUIREMENTS.md`
 * `REQ-UPDATE-010`).
 *
 * A feed URL is configuration, not authentication: it is never a GitHub API
 * endpoint, never carries a token, and is rejected if it embeds credentials
 * (`user:pass@host`). It must resolve over plain generic HTTPS so the client
 * never depends on a particular paid hosting vendor or on source-repository
 * access.
 *
 * Source of the configuration, in order, mirroring
 * `google/oauthClientConfig.ts`'s precedent for non-secret build config:
 *   1. an injected value (tests);
 *   2. a build-embedded value (`electron.vite.config.ts` inlines
 *      `GO_PHONES_UPDATE_FEED_URL` from the build machine's environment);
 *   3. the `GO_PHONES_UPDATE_FEED_URL` runtime environment variable.
 *
 * Absent/invalid configuration returns `null` (never throws): the updater
 * foundation stays `UNKNOWN`/unsupported rather than blocking startup
 * (`REQ-UPDATE-006`).
 */

export const UPDATE_FEED_URL_ENV = 'GO_PHONES_UPDATE_FEED_URL';

export interface UpdateFeedConfig {
  readonly url: string;
}

/** Validate a candidate feed URL. Returns the trimmed URL, or throws with a safe, non-echoing message. */
export function parseUpdateFeedUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new Error('The update feed URL is empty.');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('The update feed URL is not a valid URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('The update feed URL must use https:.');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('The update feed URL must not embed credentials.');
  }
  return trimmed;
}

/**
 * Load the update-feed configuration for this build/run. Never throws;
 * invalid or absent configuration surfaces via `onWarn` (no URL echoed back
 * on failure, since a malformed value could itself be sensitive) and the
 * function returns `null`.
 */
export function loadUpdateFeedConfig(deps?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly onWarn?: (message: string) => void;
  readonly embedded?: string | null;
}): UpdateFeedConfig | null {
  const env = deps?.env ?? process.env;

  const embedded = deps && 'embedded' in deps ? deps.embedded : readBuildEmbedded();
  const raw = embedded ?? env[UPDATE_FEED_URL_ENV];
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }
  try {
    return { url: parseUpdateFeedUrl(raw) };
  } catch (error) {
    deps?.onWarn?.(
      `${UPDATE_FEED_URL_ENV} is set but invalid (${
        error instanceof Error ? error.message : 'unknown error'
      }); update checking is unavailable for this build.`,
    );
    return null;
  }
}

/**
 * Build-time embedded value (`electron.vite.config.ts` replaces
 * `__UPDATE_FEED_URL__` with the build machine's `GO_PHONES_UPDATE_FEED_URL`,
 * or an empty string). A feed URL is not a secret, so — unlike the OAuth
 * client config — the whole value may be embedded directly.
 */
declare const __UPDATE_FEED_URL__: string | undefined;

function readBuildEmbedded(): string | null {
  const raw = typeof __UPDATE_FEED_URL__ === 'string' ? __UPDATE_FEED_URL__ : '';
  return raw.trim() === '' ? null : raw;
}
