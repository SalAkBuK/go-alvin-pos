import type { SecureCrypto } from '../../src/main/google/secureCrypto';
import type {
  GoogleCredentialStore,
  LoadedCredential,
  ServiceAccountCredential,
} from '../../src/main/google/googleCredentialStore';
import type { GoogleAuthProvider } from '../../src/main/google/googleAuth';
import type { SheetsTransport } from '../../src/main/google/sheetsTransport';

/**
 * In-memory fakes for the Phase 2J suites (`task §27`-`§29`). None of these touch
 * Electron, `google-auth-library`, the network, or the real filesystem — they
 * prove OUR state machine, not Google's live service.
 */

// ── Credential material ─────────────────────────────────────────────────────

export const FAKE_SERVICE_ACCOUNT: ServiceAccountCredential = {
  type: 'service_account',
  projectId: 'go-phones-pos-test',
  clientEmail: 'pos-export@go-phones-pos-test.iam.gserviceaccount.com',
  privateKey: '-----BEGIN PRIVATE KEY-----\nMIIBTESTKEYMATERIAL\n-----END PRIVATE KEY-----\n',
  privateKeyId: 'key-1',
  clientId: '1234567890',
};

export function fakeServiceAccountJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: FAKE_SERVICE_ACCOUNT.projectId,
    private_key_id: FAKE_SERVICE_ACCOUNT.privateKeyId,
    private_key: FAKE_SERVICE_ACCOUNT.privateKey,
    client_email: FAKE_SERVICE_ACCOUNT.clientEmail,
    client_id: FAKE_SERVICE_ACCOUNT.clientId,
    token_uri: 'https://oauth2.googleapis.com/token',
    ...overrides,
  });
}

// ── SecureCrypto: reversible, deterministic, NOT real encryption ─────────────

export interface FakeSecureCrypto extends SecureCrypto {
  available: boolean;
  shouldReEncrypt: boolean;
}

export function fakeSecureCrypto(available = true): FakeSecureCrypto {
  const state: FakeSecureCrypto = {
    available,
    shouldReEncrypt: false,
    isAvailable: () => Promise.resolve(state.available),
    encrypt: (plaintext: string) => Promise.resolve(Buffer.from(`enc:${plaintext}`, 'utf8')),
    decrypt: (ciphertext: Buffer) => {
      const text = ciphertext.toString('utf8');
      if (!text.startsWith('enc:')) {
        return Promise.reject(new Error('bad ciphertext'));
      }
      return Promise.resolve({ result: text.slice(4), shouldReEncrypt: state.shouldReEncrypt });
    },
  };
  return state;
}

// ── Auth provider ───────────────────────────────────────────────────────────

export function fakeAuthProvider(token = 'fake-access-token'): GoogleAuthProvider {
  return { getAccessToken: () => Promise.resolve(token) };
}

// ── Sheets transport backed by an in-memory two-worksheet spreadsheet ────────

export class FakeSpreadsheet {
  readonly sheets = new Map<string, string[][]>();

  private sheet(name: string): string[][] {
    let rows = this.sheets.get(name);
    if (!rows) {
      rows = [];
      this.sheets.set(name, rows);
    }
    return rows;
  }

  rowsOf(name: string): string[][] {
    return this.sheets.get(name) ?? [];
  }

  /** Every non-header row with the given value in column A (across all sheets). */
  findBySaleId(sheetName: string, saleId: string): string[][] {
    return this.rowsOf(sheetName).filter((row) => row[0] === saleId);
  }

  _get(name: string): string[][] {
    return this.sheet(name);
  }
}

function parseRange(range: string): { sheetName: string; a1: string } {
  const bang = range.indexOf('!');
  let sheetName = range.slice(0, bang);
  const a1 = range.slice(bang + 1);
  if (sheetName.startsWith("'") && sheetName.endsWith("'")) {
    sheetName = sheetName.slice(1, -1).replace(/''/g, "'");
  }
  return { sheetName, a1 };
}

export interface FakeTransportOptions {
  /** Called before every read; throw to simulate a read failure. */
  onRead?: (range: string) => void | Promise<void>;
  /** Called before every write; may run the void, throw, etc. */
  onWrite?: (op: 'batchUpdate' | 'append', range: string) => void | Promise<void>;
  /** Called AFTER a write is applied to the backing store; throw ⇒ "Google wrote it but we lost the response". */
  onWriteApplied?: (op: 'batchUpdate' | 'append') => void | Promise<void>;
}

export interface FakeTransport extends SheetsTransport {
  readonly calls: string[];
}

export function fakeSheetsTransport(
  spreadsheet: FakeSpreadsheet,
  options: FakeTransportOptions = {},
): FakeTransport {
  const calls: string[] = [];

  function rowIndex(a1: string): number | null {
    const m = /^A(\d+)$/.exec(a1);
    return m ? Number(m[1]) - 1 : null;
  }

  return {
    calls,
    async getValues(range: string): Promise<string[][]> {
      calls.push(`getValues ${range}`);
      if (options.onRead) {
        await options.onRead(range);
      }
      const { sheetName } = parseRange(range);
      return spreadsheet.rowsOf(sheetName).map((row) => [row[0] ?? '']);
    },
    async batchUpdate(data): Promise<void> {
      calls.push(`batchUpdate ${data.map((d) => d.range).join(',')}`);
      if (options.onWrite) {
        await options.onWrite('batchUpdate', data.map((d) => d.range).join(','));
      }
      for (const entry of data) {
        const { sheetName, a1 } = parseRange(entry.range);
        const rows = spreadsheet._get(sheetName);
        const idx = rowIndex(a1);
        if (idx !== null && entry.values[0]) {
          rows[idx] = [...entry.values[0]];
        }
      }
      if (options.onWriteApplied) {
        await options.onWriteApplied('batchUpdate');
      }
    },
    async append(range: string, values: string[][]): Promise<void> {
      calls.push(`append ${range} (${String(values.length)})`);
      if (options.onWrite) {
        await options.onWrite('append', range);
      }
      const { sheetName } = parseRange(range);
      const rows = spreadsheet._get(sheetName);
      for (const row of values) {
        rows.push([...row]);
      }
      if (options.onWriteApplied) {
        await options.onWriteApplied('append');
      }
    },
  };
}

// ── Credential store (in-memory file) ───────────────────────────────────────

export interface FakeCredentialStore extends GoogleCredentialStore {
  stored: { generation: number; credential: ServiceAccountCredential } | null;
  crypto: FakeSecureCrypto;
  deleteCount: number;
  writeCount: number;
}

export function fakeCredentialStore(
  seed: { generation: number; credential?: ServiceAccountCredential } | null = null,
): FakeCredentialStore {
  const crypto = fakeSecureCrypto(true);
  const store: FakeCredentialStore = {
    crypto,
    stored: seed
      ? { generation: seed.generation, credential: seed.credential ?? FAKE_SERVICE_ACCOUNT }
      : null,
    deleteCount: 0,
    writeCount: 0,
    isSecureStorageAvailable: () => crypto.isAvailable(),
    parseAndValidate: (rawJson: string) => {
      const parsed = JSON.parse(rawJson) as Record<string, unknown>;
      if (parsed['type'] !== 'service_account') {
        throw new Error('GOOGLE_CREDENTIAL_INVALID');
      }
      return FAKE_SERVICE_ACCOUNT;
    },
    writeCredential: (credential, generation) => {
      if (!crypto.available) {
        return Promise.reject(new Error('secure storage unavailable'));
      }
      store.stored = { generation, credential };
      store.writeCount += 1;
      return Promise.resolve();
    },
    loadCredential: (): Promise<LoadedCredential | null> => Promise.resolve(store.stored),
    deleteCredential: () => {
      store.stored = null;
      store.deleteCount += 1;
      return Promise.resolve();
    },
    fileExists: () => store.stored !== null,
  };
  return store;
}
