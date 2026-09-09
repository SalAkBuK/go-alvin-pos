import { mkdir, open, rename, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { appErrors } from '../shared/appError';
import type { SecureCrypto } from './secureCrypto';

/**
 * At-rest storage for the Google service-account credential (`task §3`, `§4`;
 * `DATA_MODEL.md §21`; `REQ-GSHEET-013`).
 *
 *  - Only the whitelisted service-account identity/key fields are ever kept.
 *  - The plaintext wrapper embeds a monotonic `generation` that is mirrored in
 *    `settings.google_credential_generation`, so a crash between file
 *    replacement and DB commit is detectable and reconcilable (`task §4`).
 *  - The wrapper is encrypted with {@link SecureCrypto} (async `safeStorage` in
 *    production) and written with a temp-file + atomic rename.
 *  - No plaintext credential ever touches SQLite, the renderer, a log, or Git.
 *
 * Externally supplied token / auth endpoint URLs are rejected — the JWT client
 * is always constructed against a hard-coded Google token endpoint (`task §3`,
 * `§20`).
 */

export interface ServiceAccountCredential {
  readonly type: 'service_account';
  readonly projectId: string;
  readonly clientEmail: string;
  readonly privateKey: string;
  readonly privateKeyId: string;
  readonly clientId: string;
}

export interface LoadedCredential {
  readonly generation: number;
  readonly credential: ServiceAccountCredential;
}

interface CredentialWrapper {
  readonly generation: number;
  readonly credential: ServiceAccountCredential;
}

export interface GoogleCredentialStoreDeps {
  /** `<userData>/secrets/google-service-account.enc`. */
  readonly filePath: string;
  readonly crypto: SecureCrypto;
}

export interface GoogleCredentialStore {
  isSecureStorageAvailable(): Promise<boolean>;
  /** Parse + structurally validate a raw JSON string. Throws `GOOGLE_CREDENTIAL_INVALID` on any problem. */
  parseAndValidate(rawJson: string): ServiceAccountCredential;
  /** Encrypt `{ generation, credential }` and write it atomically (temp file + rename + fsync). */
  writeCredential(credential: ServiceAccountCredential, generation: number): Promise<void>;
  /** Decrypt + validate the stored wrapper. `null` if the file is absent, undecryptable, or malformed. */
  loadCredential(): Promise<LoadedCredential | null>;
  /** Best-effort removal of the credential file and any temp file. Never throws. */
  deleteCredential(): Promise<void>;
  fileExists(): boolean;
}

const TOKEN_URI_ALLOWED = 'https://oauth2.googleapis.com/token';
const SERVICE_ACCOUNT_EMAIL = /@[^@]+\.iam\.gserviceaccount\.com$/i;

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw appErrors.googleCredentialInvalid(`missing "${key}"`);
  }
  return value;
}

function validateCredentialShape(rawJson: string): ServiceAccountCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw appErrors.googleCredentialInvalid('the file is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw appErrors.googleCredentialInvalid('the file is not a JSON object');
  }
  const record = parsed as Record<string, unknown>;

  if (record['type'] !== 'service_account') {
    throw appErrors.googleCredentialInvalid('"type" must be "service_account"');
  }
  // Reject any externally supplied token/auth endpoint that would redirect secrets.
  for (const urlKey of ['token_uri', 'auth_uri', 'auth_provider_x509_cert_url']) {
    const value = record[urlKey];
    if (typeof value === 'string' && value.trim() !== '') {
      if (urlKey === 'token_uri' && value !== TOKEN_URI_ALLOWED) {
        throw appErrors.googleCredentialInvalid('"token_uri" is not the Google token endpoint');
      }
      if (
        urlKey !== 'token_uri' &&
        !/^https:\/\/[a-z0-9.-]*\.?googleapis\.com\//i.test(value) &&
        !/^https:\/\/accounts\.google\.com\//i.test(value)
      ) {
        throw appErrors.googleCredentialInvalid(`"${urlKey}" points outside google.com`);
      }
    }
  }
  const universe = record['universe_domain'];
  if (typeof universe === 'string' && universe.trim() !== '' && universe !== 'googleapis.com') {
    throw appErrors.googleCredentialInvalid('"universe_domain" must be googleapis.com');
  }

  const clientEmail = requireString(record, 'client_email');
  if (!SERVICE_ACCOUNT_EMAIL.test(clientEmail)) {
    throw appErrors.googleCredentialInvalid('"client_email" is not a service-account address');
  }
  const privateKey = requireString(record, 'private_key');
  if (!privateKey.includes('-----BEGIN') || !privateKey.includes('PRIVATE KEY-----')) {
    throw appErrors.googleCredentialInvalid('"private_key" is not a PEM private key');
  }

  return {
    type: 'service_account',
    projectId: requireString(record, 'project_id'),
    clientEmail,
    privateKey,
    privateKeyId: requireString(record, 'private_key_id'),
    clientId: requireString(record, 'client_id'),
  };
}

/** Re-validate a credential object read back from OUR own encrypted wrapper (camelCase shape). */
function isStoredCredential(value: unknown): value is ServiceAccountCredential {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record['type'] === 'service_account' &&
    typeof record['projectId'] === 'string' &&
    typeof record['clientEmail'] === 'string' &&
    /@[^@]+\.iam\.gserviceaccount\.com$/i.test(record['clientEmail']) &&
    typeof record['privateKey'] === 'string' &&
    record['privateKey'].includes('PRIVATE KEY-----') &&
    typeof record['privateKeyId'] === 'string' &&
    typeof record['clientId'] === 'string'
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

    parseAndValidate(rawJson: string): ServiceAccountCredential {
      return validateCredentialShape(rawJson);
    },

    async writeCredential(credential: ServiceAccountCredential, generation: number): Promise<void> {
      const wrapper: CredentialWrapper = { generation, credential };
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
          // Key rotation — re-encrypt the same wrapper in place (generation unchanged).
          try {
            const wrapper = JSON.parse(plaintext) as CredentialWrapper;
            await this.writeCredential(wrapper.credential, wrapper.generation);
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
      return { generation: record['generation'], credential: record['credential'] };
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
