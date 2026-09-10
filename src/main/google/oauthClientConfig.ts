import { readFileSync } from 'node:fs';

/**
 * Developer OAuth "Desktop app" client configuration (`ARCHITECTURE.md §27.1`,
 * `§27.4`). This is a **developer/build artifact**, not a client setup artifact:
 * the store owner never sees, selects, or supplies it.
 *
 * An installed desktop OAuth app is a **public client** — the `clientSecret`
 * value cannot be assumed confidential and is NOT treated like a refresh token
 * or a private key. It is still never logged, never returned to the renderer,
 * and the raw downloaded JSON is never copied into tracked repository files or
 * the packaged renderer bundle.
 *
 * Source of the configuration, in order:
 *   1. an injected value (tests, and a future build-embedded value);
 *   2. `GO_PHONES_GOOGLE_OAUTH_CLIENT_JSON` → a path to the developer-owned
 *      Desktop-client JSON that lives OUTSIDE the repository.
 *
 * If neither is present the application still starts and local POS works;
 * Settings reports Google connection as unavailable for that build.
 */

export interface GoogleOAuthClientConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

export const OAUTH_CLIENT_JSON_ENV = 'GO_PHONES_GOOGLE_OAUTH_CLIENT_JSON';

const AUTH_URI = 'https://accounts.google.com/o/oauth2/auth';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';

/**
 * Validate the `installed` (Desktop-client) shape and extract ONLY the two
 * fields the installed-app OAuth flow needs. Rejects a web-client shape, a
 * foreign auth/token endpoint, or missing fields. Never includes either value
 * in the thrown message.
 */
export function parseOAuthClientConfig(rawJson: string): GoogleOAuthClientConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error('The Google OAuth client configuration is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('The Google OAuth client configuration is not a JSON object.');
  }
  const root = parsed as Record<string, unknown>;
  const installed = root['installed'];
  if (typeof installed !== 'object' || installed === null) {
    if ('web' in root) {
      throw new Error(
        'The Google OAuth client is a web client; a "Desktop app" client is required.',
      );
    }
    throw new Error('The Google OAuth client configuration has no "installed" section.');
  }
  const record = installed as Record<string, unknown>;

  const clientId = record['client_id'];
  const clientSecret = record['client_secret'];
  if (typeof clientId !== 'string' || clientId.trim() === '') {
    throw new Error('The Google OAuth client configuration is missing "client_id".');
  }
  if (typeof clientSecret !== 'string' || clientSecret.trim() === '') {
    throw new Error('The Google OAuth client configuration is missing "client_secret".');
  }
  // Reject a configuration that would redirect the flow to a non-Google endpoint.
  const authUri = record['auth_uri'];
  const tokenUri = record['token_uri'];
  if (typeof authUri === 'string' && authUri.trim() !== '' && authUri !== AUTH_URI) {
    throw new Error('The Google OAuth client "auth_uri" is not the Google authorization endpoint.');
  }
  if (typeof tokenUri === 'string' && tokenUri.trim() !== '' && tokenUri !== TOKEN_URI) {
    throw new Error('The Google OAuth client "token_uri" is not the Google token endpoint.');
  }

  return { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
}

/**
 * Build-time embedded configuration for a packaged build. `electron.vite.config.ts`
 * replaces `__GOOGLE_OAUTH_CLIENT_CONFIG__` with the extracted `{clientId,
 * clientSecret}` JSON when the build machine has `GO_PHONES_GOOGLE_OAUTH_CLIENT_JSON`
 * set, else the empty string. Only these two public-client fields — never the
 * raw downloaded JSON — enter the MAIN bundle, and never the renderer bundle.
 */
declare const __GOOGLE_OAUTH_CLIENT_CONFIG__: string | undefined;

function readBuildEmbedded(): GoogleOAuthClientConfig | null {
  const raw =
    typeof __GOOGLE_OAUTH_CLIENT_CONFIG__ === 'string' ? __GOOGLE_OAUTH_CLIENT_CONFIG__ : '';
  if (raw.trim() === '') {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed['clientId'] === 'string' && typeof parsed['clientSecret'] === 'string') {
      return { clientId: parsed['clientId'], clientSecret: parsed['clientSecret'] };
    }
  } catch {
    /* fall through to the env-var mechanism */
  }
  return null;
}

/**
 * Load the developer OAuth client configuration for this build/run. Returns
 * `null` (never throws) when it is absent or unreadable so startup and local
 * POS are unaffected; a malformed file surfaces via `onWarn` without printing
 * its contents. Order: an injected value → a build-embedded value → the
 * `GO_PHONES_GOOGLE_OAUTH_CLIENT_JSON` external file.
 */
export function loadOAuthClientConfig(deps?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly readFile?: (path: string) => string;
  readonly onWarn?: (message: string) => void;
  readonly embedded?: GoogleOAuthClientConfig | null;
}): GoogleOAuthClientConfig | null {
  const env = deps?.env ?? process.env;
  const read = deps?.readFile ?? ((p: string): string => readFileSync(p, 'utf8'));

  const embedded = deps && 'embedded' in deps ? deps.embedded : readBuildEmbedded();
  if (embedded) {
    return embedded;
  }

  const path = env[OAUTH_CLIENT_JSON_ENV];
  if (typeof path !== 'string' || path.trim() === '') {
    return null;
  }
  let rawJson: string;
  try {
    rawJson = read(path.trim());
  } catch {
    deps?.onWarn?.(
      `${OAUTH_CLIENT_JSON_ENV} is set but the file could not be read; Google connection is unavailable for this build.`,
    );
    return null;
  }
  try {
    return parseOAuthClientConfig(rawJson);
  } catch (error) {
    deps?.onWarn?.(
      `${OAUTH_CLIENT_JSON_ENV} is invalid (${
        error instanceof Error ? error.message : 'unknown error'
      }); Google connection is unavailable for this build.`,
    );
    return null;
  }
}
