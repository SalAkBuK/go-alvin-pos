import type { OAuthClient } from './googleOAuthClient';

/**
 * Access-token supply for the export transport (`ARCHITECTURE.md §27.4`).
 * Replaces the Phase 2J service-account JWT provider with user-OAuth
 * refresh-token authentication.
 *
 * Token refresh happens ONLY here — never spread across the worker, upsert, or
 * serialization code. Access tokens are short-lived runtime values held in
 * memory and never persisted. A refresh failure propagates as a plain error;
 * the transport classifies it as `AUTH` and the export-job state machine
 * records it exactly like any other definite failure (`REQ-GSHEET-006`,
 * `TEST-GSHEET-009`) — local sale state never changes.
 */

export interface GoogleAuthProvider {
  /** A valid bearer access token for the Google APIs. Throws on refresh failure. */
  getAccessToken(): Promise<string>;
}

const EXPIRY_SKEW_MS = 60_000;

export function createOAuthAuthProvider(deps: {
  readonly oauthClient: OAuthClient;
  readonly refreshToken: string;
  readonly now?: () => number;
}): GoogleAuthProvider {
  const now = deps.now ?? Date.now;
  let cached: { token: string; expiresAt: number } | null = null;

  return {
    async getAccessToken(): Promise<string> {
      if (cached && cached.expiresAt - EXPIRY_SKEW_MS > now()) {
        return cached.token;
      }
      const result = await deps.oauthClient.getAccessToken(deps.refreshToken);
      cached = {
        token: result.accessToken,
        expiresAt: result.expiryDate ?? now() + 30 * 60_000,
      };
      return cached.token;
    },
  };
}
