import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import type { GoogleOAuthClientConfig } from './oauthClientConfig';

/**
 * Narrow desktop-OAuth surface the flow / auth-provider need (`ARCHITECTURE.md
 * §27`). The ONLY module that imports `google-auth-library`, and only in the
 * trusted main process (added to the renderer-isolation deny-list).
 *
 * Everything here is injectable so the flow and the export auth-provider are
 * unit-testable without `google-auth-library`, a real OAuth client JSON, or the
 * network.
 */

export interface OAuthPkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

export interface OAuthTokenExchangeResult {
  /** Present only when Google issued a refresh token (offline access + consent). */
  readonly refreshToken: string | null;
  readonly accessToken: string | null;
  /** Raw ID token — verified immediately, never persisted. */
  readonly idToken: string | null;
  /** Epoch ms when the access token expires, if known. */
  readonly expiryDate: number | null;
}

export interface OAuthAccessToken {
  readonly accessToken: string;
  readonly expiryDate: number | null;
}

export interface VerifiedIdentity {
  /** OpenID Connect subject — the durable Google account identifier. */
  readonly sub: string;
  /** Display-only. May be absent if `email` scope was not honored. */
  readonly email: string | null;
}

export interface OAuthClient {
  /** A fresh PKCE verifier + S256 challenge per authorization attempt. */
  createPkce(): Promise<OAuthPkcePair>;
  /** The Google authorization URL to open in the system browser. */
  buildAuthUrl(params: {
    readonly scopes: readonly string[];
    readonly redirectUri: string;
    readonly state: string;
    readonly codeChallenge: string;
  }): string;
  /** Exchange the authorization code (with the original PKCE verifier + exact redirect URI). */
  exchangeCode(params: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
  }): Promise<OAuthTokenExchangeResult>;
  /** Obtain a fresh access token from a stored refresh token. */
  getAccessToken(refreshToken: string): Promise<OAuthAccessToken>;
  /** Verify an ID token for this OAuth client and return the minimum identity. */
  verifyIdToken(idToken: string): Promise<VerifiedIdentity>;
  /** Best-effort remote revocation of a refresh (or access) token. */
  revoke(token: string): Promise<void>;
}

export function createGoogleOAuthClient(config: GoogleOAuthClientConfig): OAuthClient {
  const newClient = (redirectUri?: string): OAuth2Client =>
    new OAuth2Client({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      ...(redirectUri ? { redirectUri } : {}),
    });

  return {
    async createPkce(): Promise<OAuthPkcePair> {
      const { codeVerifier, codeChallenge } = await newClient().generateCodeVerifierAsync();
      if (!codeVerifier || !codeChallenge) {
        throw new Error('The OAuth client did not produce a PKCE pair.');
      }
      return { verifier: codeVerifier, challenge: codeChallenge };
    },

    buildAuthUrl(params): string {
      return newClient(params.redirectUri).generateAuthUrl({
        access_type: 'offline',
        scope: [...params.scopes],
        state: params.state,
        code_challenge_method: CodeChallengeMethod.S256,
        code_challenge: params.codeChallenge,
        prompt: 'consent',
        include_granted_scopes: false,
      });
    },

    async exchangeCode(params): Promise<OAuthTokenExchangeResult> {
      const client = newClient(params.redirectUri);
      const { tokens } = await client.getToken({
        code: params.code,
        codeVerifier: params.codeVerifier,
        redirect_uri: params.redirectUri,
      });
      return {
        refreshToken: tokens.refresh_token ?? null,
        accessToken: tokens.access_token ?? null,
        idToken: tokens.id_token ?? null,
        expiryDate: tokens.expiry_date ?? null,
      };
    },

    async getAccessToken(refreshToken: string): Promise<OAuthAccessToken> {
      const client = newClient();
      client.setCredentials({ refresh_token: refreshToken });
      const response = await client.getAccessToken();
      const token = typeof response === 'string' ? response : response.token;
      if (!token) {
        throw new Error('Google did not return an access token.');
      }
      const expiryDate = client.credentials.expiry_date ?? null;
      return { accessToken: token, expiryDate };
    },

    async verifyIdToken(idToken: string): Promise<VerifiedIdentity> {
      const ticket = await newClient().verifyIdToken({
        idToken,
        audience: config.clientId,
      });
      const payload = ticket.getPayload();
      if (!payload || typeof payload.sub !== 'string' || payload.sub === '') {
        throw new Error('The Google ID token did not contain a usable subject.');
      }
      return {
        sub: payload.sub,
        email: typeof payload.email === 'string' && payload.email !== '' ? payload.email : null,
      };
    },

    async revoke(token: string): Promise<void> {
      await newClient().revokeToken(token);
    },
  };
}
