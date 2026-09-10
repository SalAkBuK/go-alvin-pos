import { randomBytes } from 'node:crypto';
import { GOOGLE_OAUTH_SCOPES } from '../../shared/google';
import { appErrors } from '../shared/appError';
import type { OAuthClient } from './googleOAuthClient';
import type { StartLoopbackListener } from './loopbackListener';
import { startLoopbackListener } from './loopbackListener';

/**
 * The desktop OAuth authorization flow (`ARCHITECTURE.md §27.1`–`§27.2`;
 * `POS_WORKFLOWS.md §71`). Runs entirely in the trusted main process: system
 * browser, PKCE, random verified `state`, `127.0.0.1` loopback, finite timeout,
 * guaranteed listener teardown.
 *
 * Every failure path (browser closed / denied, no callback, state mismatch,
 * token-exchange failure, listener failure, shutdown, cancellation) is a
 * Google-configuration failure: it throws a sanitized `GOOGLE_AUTHORIZATION_FAILED`
 * and never touches local sale state. Nothing here is logged with a secret.
 */

/** The user has this long to complete sign-in in the browser before the attempt is abandoned. */
export const OAUTH_FLOW_TIMEOUT_MS = 5 * 60_000;

export interface OAuthAuthorizationResult {
  readonly refreshToken: string;
  /** OpenID Connect subject — durable account identity. */
  readonly sub: string;
  /** Display-only email, when present. */
  readonly email: string | null;
}

export interface RunOAuthFlowDeps {
  readonly oauthClient: OAuthClient;
  /** Opens the authorization URL in the external system browser. */
  readonly openExternal: (url: string) => Promise<void>;
  readonly startListener?: StartLoopbackListener;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  /** Aborts a pending attempt (app shutdown / explicit cancel). */
  readonly signal?: AbortSignal;
  readonly logger?: {
    info: (event: string, fields?: Record<string, unknown>) => void;
    warn: (event: string, fields?: Record<string, unknown>) => void;
  };
}

function randomState(): string {
  return randomBytes(32).toString('base64url');
}

/** Reduce an OAuth `error` query value to a single safe token word. */
function safeErrorWord(raw: string): string {
  const word = /^[a-z_]{1,40}$/.test(raw) ? raw : 'error';
  return word;
}

export async function runOAuthFlow(deps: RunOAuthFlowDeps): Promise<OAuthAuthorizationResult> {
  const start = deps.startListener ?? startLoopbackListener;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? OAUTH_FLOW_TIMEOUT_MS;
  const log = deps.logger;

  const pkce = await deps.oauthClient.createPkce();
  const state = randomState();

  let listener: Awaited<ReturnType<StartLoopbackListener>>;
  try {
    listener = await start();
  } catch {
    throw appErrors.googleAuthorizationFailed('the local sign-in listener could not be started');
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const cleanup = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    listener.close();
  };

  try {
    const authUrl = deps.oauthClient.buildAuthUrl({
      scopes: GOOGLE_OAUTH_SCOPES,
      redirectUri: listener.redirectUri,
      state,
      codeChallenge: pkce.challenge,
    });
    log?.info('google.oauth.authorization_started', { redirectPort: listener.port });

    try {
      await deps.openExternal(authUrl);
    } catch {
      listener.respond('failure');
      throw appErrors.googleAuthorizationFailed('the system browser could not be opened');
    }

    const deadline = now() + timeoutMs;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(appErrors.googleAuthorizationFailed('sign-in was not completed in time')),
        Math.max(0, deadline - now()),
      );
    });
    const aborted = new Promise<never>((_resolve, reject) => {
      if (deps.signal) {
        if (deps.signal.aborted) {
          reject(appErrors.googleAuthorizationFailed('sign-in was cancelled'));
        }
        deps.signal.addEventListener(
          'abort',
          () => reject(appErrors.googleAuthorizationFailed('sign-in was cancelled')),
          { once: true },
        );
      }
    });

    let query: Record<string, string>;
    try {
      query = await Promise.race([listener.callback, timeout, aborted]);
    } catch (error) {
      listener.respond('failure');
      throw error;
    }

    if (typeof query['error'] === 'string' && query['error'] !== '') {
      listener.respond('failure');
      throw appErrors.googleAuthorizationFailed(
        `Google reported "${safeErrorWord(query['error'])}"`,
      );
    }
    if (query['state'] !== state) {
      listener.respond('failure');
      log?.warn('google.oauth.authorization_failed', { reason: 'state_mismatch' });
      throw appErrors.googleAuthorizationFailed('the sign-in response could not be verified');
    }
    const code = query['code'];
    if (typeof code !== 'string' || code === '') {
      listener.respond('failure');
      throw appErrors.googleAuthorizationFailed('no authorization code was returned');
    }

    let tokens;
    try {
      tokens = await deps.oauthClient.exchangeCode({
        code,
        codeVerifier: pkce.verifier,
        redirectUri: listener.redirectUri,
      });
    } catch {
      listener.respond('failure');
      throw appErrors.googleAuthorizationFailed('the sign-in could not be completed with Google');
    }

    if (!tokens.refreshToken) {
      listener.respond('failure');
      throw appErrors.googleAuthorizationFailed(
        'Google did not grant offline access — disconnect and reconnect, allowing all requested permissions',
      );
    }
    if (!tokens.idToken) {
      listener.respond('failure');
      throw appErrors.googleAuthorizationFailed('Google identity could not be established');
    }

    let identity;
    try {
      identity = await deps.oauthClient.verifyIdToken(tokens.idToken);
    } catch {
      listener.respond('failure');
      throw appErrors.googleAuthorizationFailed('Google identity could not be verified');
    }

    listener.respond('success');
    log?.info('google.oauth.authorization_succeeded');
    return { refreshToken: tokens.refreshToken, sub: identity.sub, email: identity.email };
  } finally {
    cleanup();
  }
}
