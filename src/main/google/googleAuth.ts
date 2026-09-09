import { JWT } from 'google-auth-library';
import { GOOGLE_SHEETS_SCOPE } from '../../shared/google';
import type { ServiceAccountCredential } from './googleCredentialStore';

/**
 * Service-account authentication (`task §20`). The ONLY consumer of
 * `google-auth-library`, and only in the trusted main process.
 *
 * The JWT client is constructed from our already-decrypted, already-validated
 * credential object — `{ email, key, scopes }` — never a `keyFilename`, an
 * `external_account` config, a credential URL, environment auto-discovery, or
 * the metadata server. Scope is fixed to a single spreadsheets scope; no
 * domain-wide delegation.
 *
 * The `JWT` client caches and refreshes the access token internally.
 */
export interface GoogleAuthProvider {
  /** A valid bearer access token for the Sheets API. Throws on auth failure. */
  getAccessToken(): Promise<string>;
}

export function createServiceAccountAuthProvider(
  credential: ServiceAccountCredential,
): GoogleAuthProvider {
  const client = new JWT({
    email: credential.clientEmail,
    key: credential.privateKey,
    scopes: [GOOGLE_SHEETS_SCOPE],
  });
  return {
    async getAccessToken(): Promise<string> {
      const response = await client.getAccessToken();
      if (!response.token) {
        throw new Error('Google did not return an access token.');
      }
      return response.token;
    },
  };
}
