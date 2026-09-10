import { mkdir, open, rename, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SecureCrypto } from './secureCrypto';

/**
 * At-rest storage for the Google **OAuth refresh token** (`ARCHITECTURE.md
 * §27.4`; `DATA_MODEL.md §21`; `REQ-GSHEET-013`).
 *
 *  - Only the whitelisted OAuth identity/credential fields are ever kept:
 *    refresh token, OpenID `sub`, and the account email for display.
 *  - The plaintext wrapper embeds a monotonic `generation` mirrored in
 *    `settings.google_credential_generation`, so a crash between file
 *    replacement and DB commit is detectable and reconcilable.
 *  - The wrapper is encrypted with {@link SecureCrypto} (async `safeStorage` in
 *    production) and written with a temp-file + atomic rename.
 *  - No plaintext refresh token ever touches SQLite, the renderer, a log, or Git.
 *    There is NO plaintext fallback.
 */

export interface OAuthCredential {
  /** The long-lived Google OAuth refresh token. */
  readonly refreshToken: string;
  /** OpenID Connect subject — the durable Google account identifier. */
  readonly sub: string | null;
  /** Display-only account email. */
  readonly email: string | null;
}

export interface LoadedCredential {
  readonly generation: number;
  readonly credential: OAuthCredential;
}

interface CredentialWrapper {
  readonly generation: number;
  readonly credential: OAuthCredential;
}

export interface GoogleCredentialStoreDeps {
  /** `<userData>/secrets/google-oauth.enc`. */
  readonly filePath: string;
  readonly crypto: SecureCrypto;
}

export interface GoogleCredentialStore {
  isSecureStorageAvailable(): Promise<boolean>;
  /** Encrypt `{ generation, credential }` and write it atomically (temp file + rename + fsync). */
  writeCredential(credential: OAuthCredential, generation: number): Promise<void>;
  /** Decrypt + validate the stored wrapper. `null` if the file is absent, undecryptable, or malformed. */
  loadCredential(): Promise<LoadedCredential | null>;
  /** Best-effort removal of the credential file and any temp file. Never throws. */
  deleteCredential(): Promise<void>;
  fileExists(): boolean;
}

function isOptionalString(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || typeof value === 'string';
}

/** Re-validate a credential object read back from OUR own encrypted wrapper. */
function isStoredCredential(value: unknown): value is OAuthCredential {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['refreshToken'] === 'string' &&
    record['refreshToken'].trim() !== '' &&
    isOptionalString(record['sub']) &&
    isOptionalString(record['email'])
  );
}

export function createGoogleCredentialStore(
  deps: GoogleCredentialStoreDeps,
): GoogleCredentialStore {
  const { filePath, crypto } = deps;
  const tmpPath = `${filePath}.tmp`;

  return {
    isSecureStorageAvailable(): Promise<boolean> {
      return crypto.isAvailable();
    },

    async writeCredential(credential: OAuthCredential, generation: number): Promise<void> {
      const wrapper: CredentialWrapper = {
        generation,
        credential: {
          refreshToken: credential.refreshToken,
          sub: credential.sub ?? null,
          email: credential.email ?? null,
        },
      };
      const ciphertext = await crypto.encrypt(JSON.stringify(wrapper));
      await mkdir(dirname(filePath), { recursive: true });
      const handle = await open(tmpPath, 'w');
      try {
        await handle.writeFile(ciphertext);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmpPath, filePath);
    },

    async loadCredential(): Promise<LoadedCredential | null> {
      if (!existsSync(filePath)) {
        return null;
      }
      let plaintext: string;
      try {
        const ciphertext = readFileSync(filePath);
        const decrypted = await crypto.decrypt(ciphertext);
        plaintext = decrypted.result;
        if (decrypted.shouldReEncrypt) {
          // OS key rotation — re-encrypt the same wrapper in place (generation unchanged).
          try {
            const rotated = JSON.parse(plaintext) as CredentialWrapper;
            await this.writeCredential(rotated.credential, rotated.generation);
          } catch {
            /* fall through to normal parse/validate below */
          }
        }
      } catch {
        return null;
      }
      let wrapper: unknown;
      try {
        wrapper = JSON.parse(plaintext);
      } catch {
        return null;
      }
      if (typeof wrapper !== 'object' || wrapper === null) {
        return null;
      }
      const record = wrapper as Record<string, unknown>;
      if (typeof record['generation'] !== 'number' || !Number.isInteger(record['generation'])) {
        return null;
      }
      if (!isStoredCredential(record['credential'])) {
        return null;
      }
      return {
        generation: record['generation'],
        credential: {
          refreshToken: record['credential'].refreshToken,
          sub: record['credential'].sub ?? null,
          email: record['credential'].email ?? null,
        },
      };
    },

    async deleteCredential(): Promise<void> {
      await rm(filePath, { force: true }).catch(() => undefined);
      await rm(tmpPath, { force: true }).catch(() => undefined);
    },

    fileExists(): boolean {
      return existsSync(filePath);
    },
  };
}
