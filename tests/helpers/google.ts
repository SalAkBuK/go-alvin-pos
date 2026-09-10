import type { SecureCrypto } from '../../src/main/google/secureCrypto';
import type {
  GoogleCredentialStore,
  LoadedCredential,
  OAuthCredential,
} from '../../src/main/google/googleCredentialStore';
import type { GoogleAuthProvider } from '../../src/main/google/googleAuthProvider';
import type {
  OAuthClient,
  OAuthPkcePair,
  OAuthTokenExchangeResult,
} from '../../src/main/google/googleOAuthClient';
import type { LoopbackListener } from '../../src/main/google/loopbackListener';
import type { DriveTransport } from '../../src/main/google/driveTransport';
import {
  INTEGRATION_MARKER_KEY,
  INTEGRATION_MARKER_VALUE,
  PROVISIONING_TOKEN_KEY,
} from '../../src/main/google/driveTransport';
import type { SheetsStructureTransport } from '../../src/main/google/sheetsStructureTransport';
import type { SheetsTransport } from '../../src/main/google/sheetsTransport';

/**
 * In-memory fakes for the Phase 2J / 2J.1 suites. None touch Electron,
 * `google-auth-library`, the network, a real OAuth client JSON, or the real
 * filesystem — they prove OUR state machine, not Google's live service.
 */

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

// ── Export auth provider (for the export-engine suites) ─────────────────────

export function fakeAuthProvider(token = 'fake-access-token'): GoogleAuthProvider {
  return { getAccessToken: () => Promise.resolve(token) };
}

// ── OAuth credential wrapper ────────────────────────────────────────────────

export const FAKE_OAUTH_CREDENTIAL: OAuthCredential = {
  refreshToken: '1//fake-refresh-token',
  sub: '1234567890-google-subject',
  email: 'owner@example.com',
};

export interface FakeCredentialStore extends GoogleCredentialStore {
  stored: LoadedCredential | null;
  crypto: FakeSecureCrypto;
  deleteCount: number;
  writeCount: number;
}

export function fakeCredentialStore(
  seed: { generation: number; credential?: OAuthCredential } | null = null,
): FakeCredentialStore {
  const crypto = fakeSecureCrypto(true);
  const store: FakeCredentialStore = {
    crypto,
    stored: seed
      ? { generation: seed.generation, credential: seed.credential ?? FAKE_OAUTH_CREDENTIAL }
      : null,
    deleteCount: 0,
    writeCount: 0,
    isSecureStorageAvailable: () => crypto.isAvailable(),
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

// ── Fake desktop OAuth client ──────────────────────────────────────────────

export interface FakeOAuthClientOptions {
  /** Force a specific outcome for the code exchange. */
  readonly exchange?: Partial<OAuthTokenExchangeResult> | (() => never);
  readonly verifyIdToken?: { sub: string; email: string | null } | (() => never);
  readonly revokeThrows?: boolean;
}

export interface FakeOAuthClient extends OAuthClient {
  readonly calls: {
    pkce: number;
    authUrls: string[];
    exchanges: Array<{ code: string; codeVerifier: string; redirectUri: string }>;
    revokes: string[];
    accessTokens: number;
  };
  lastPkce: OAuthPkcePair | null;
  lastState: string | null;
}

export function fakeOAuthClient(options: FakeOAuthClientOptions = {}): FakeOAuthClient {
  const client: FakeOAuthClient = {
    calls: { pkce: 0, authUrls: [], exchanges: [], revokes: [], accessTokens: 0 },
    lastPkce: null,
    lastState: null,
    createPkce: () => {
      client.calls.pkce += 1;
      const pair: OAuthPkcePair = {
        verifier: `verifier-${String(client.calls.pkce)}`,
        challenge: `S256-challenge-${String(client.calls.pkce)}`,
      };
      client.lastPkce = pair;
      return Promise.resolve(pair);
    },
    buildAuthUrl: ({ scopes, redirectUri, state, codeChallenge }) => {
      client.lastState = state;
      const url = `https://accounts.google.com/o/oauth2/auth?scope=${encodeURIComponent(
        scopes.join(' '),
      )}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256&access_type=offline&prompt=consent`;
      client.calls.authUrls.push(url);
      return url;
    },
    exchangeCode: (params) => {
      client.calls.exchanges.push(params);
      if (typeof options.exchange === 'function') {
        options.exchange();
      }
      const ex = (
        typeof options.exchange === 'object' ? options.exchange : {}
      ) as Partial<OAuthTokenExchangeResult>;
      return Promise.resolve({
        refreshToken:
          'refreshToken' in ex ? (ex.refreshToken ?? null) : FAKE_OAUTH_CREDENTIAL.refreshToken,
        accessToken: 'accessToken' in ex ? (ex.accessToken ?? null) : 'ya29.fake-access',
        idToken: 'idToken' in ex ? (ex.idToken ?? null) : 'fake.id.token',
        expiryDate: ex.expiryDate ?? null,
      });
    },
    getAccessToken: () => {
      client.calls.accessTokens += 1;
      return Promise.resolve({ accessToken: 'ya29.fake-access', expiryDate: null });
    },
    verifyIdToken: () => {
      if (typeof options.verifyIdToken === 'function') {
        options.verifyIdToken();
      }
      const identity =
        typeof options.verifyIdToken === 'object'
          ? options.verifyIdToken
          : { sub: FAKE_OAUTH_CREDENTIAL.sub!, email: FAKE_OAUTH_CREDENTIAL.email };
      return Promise.resolve(identity);
    },
    revoke: (token: string) => {
      client.calls.revokes.push(token);
      return options.revokeThrows ? Promise.reject(new Error('revoke failed')) : Promise.resolve();
    },
  };
  return client;
}

// ── Fake loopback listener + a driver for the flow ─────────────────────────

export interface FakeLoopbackController {
  readonly listener: LoopbackListener;
  /** Deliver a browser callback to the flow. */
  deliver(query: Record<string, string>): void;
  respondedWith: Array<'success' | 'failure'>;
  closed: boolean;
  failToStart: boolean;
}

export function fakeLoopbackListener(port = 54321): FakeLoopbackController {
  let resolveCb!: (q: Record<string, string>) => void;
  let rejectCb!: (e: Error) => void;
  const callback = new Promise<Record<string, string>>((res, rej) => {
    resolveCb = res;
    rejectCb = rej;
  });
  const controller: FakeLoopbackController = {
    respondedWith: [],
    closed: false,
    failToStart: false,
    deliver: (query) => resolveCb(query),
    listener: {
      port,
      redirectUri: `http://127.0.0.1:${String(port)}/oauth2callback`,
      callback,
      respond: (kind) => controller.respondedWith.push(kind),
      close: () => {
        controller.closed = true;
        rejectCb(new Error('listener closed'));
      },
    },
  };
  return controller;
}

// ── Sheets transport backed by an in-memory two-worksheet spreadsheet ──────

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
  onRead?: (range: string) => void | Promise<void>;
  onWrite?: (op: 'batchUpdate' | 'append', range: string) => void | Promise<void>;
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

// ── In-memory Google Drive + Sheets structure for provisioning ─────────────

export interface FakeDriveFile {
  readonly id: string;
  readonly appProperties: Record<string, string>;
  trashed: boolean;
}

export interface FakeDriveOptions {
  /** Called before every create; throw a GoogleApiError to simulate an outcome. Reassignable. */
  onCreate?: (attempt: number) => void;
  /** Called before every list. Reassignable. */
  onList?: (attempt: number) => void;
}

export interface FakeDrive extends DriveTransport {
  files: FakeDriveFile[];
  calls: { list: number; create: number };
  onCreate?: ((attempt: number) => void) | undefined;
  onList?: ((attempt: number) => void) | undefined;
  /** Simulate a spreadsheet that Google created even though our request "failed". */
  seedProvisioned(token: string, id?: string): string;
}

export function fakeDrive(options: FakeDriveOptions = {}): FakeDrive {
  const drive: FakeDrive = {
    files: [],
    calls: { list: 0, create: 0 },
    onCreate: options.onCreate,
    onList: options.onList,
    seedProvisioned(
      token: string,
      id = `spreadsheet-${String(Math.random()).slice(2, 8)}`,
    ): string {
      drive.files.push({
        id,
        appProperties: {
          [INTEGRATION_MARKER_KEY]: INTEGRATION_MARKER_VALUE,
          [PROVISIONING_TOKEN_KEY]: token,
        },
        trashed: false,
      });
      return id;
    },
    findProvisionedSpreadsheets(provisioningToken: string): Promise<string[]> {
      drive.calls.list += 1;
      drive.onList?.(drive.calls.list);
      return Promise.resolve(
        drive.files
          .filter(
            (f) =>
              !f.trashed &&
              f.appProperties[INTEGRATION_MARKER_KEY] === INTEGRATION_MARKER_VALUE &&
              f.appProperties[PROVISIONING_TOKEN_KEY] === provisioningToken,
          )
          .map((f) => f.id),
      );
    },
    createProvisionedSpreadsheet({ provisioningToken }): Promise<string> {
      drive.calls.create += 1;
      drive.onCreate?.(drive.calls.create);
      const id = `spreadsheet-${String(drive.calls.create)}-${String(Math.random()).slice(2, 8)}`;
      drive.files.push({
        id,
        appProperties: {
          [INTEGRATION_MARKER_KEY]: INTEGRATION_MARKER_VALUE,
          [PROVISIONING_TOKEN_KEY]: provisioningToken,
        },
        trashed: false,
      });
      return Promise.resolve(id);
    },
  };
  return drive;
}

interface MutableWorksheet {
  sheetId: number;
  title: string;
  header: string[];
}

export interface FakeStructure extends SheetsStructureTransport {
  readonly worksheets: MutableWorksheet[];
  readonly calls: {
    list: number;
    add: number;
    rename: number;
    readHeader: number;
    writeHeader: number;
  };
}

export function fakeSheetsStructure(
  seed: Array<{ title: string; header?: string[] }> = [{ title: 'Sheet1' }],
): FakeStructure {
  let nextId = 0;
  const structure: FakeStructure = {
    worksheets: seed.map((s) => ({ sheetId: nextId++, title: s.title, header: s.header ?? [] })),
    calls: { list: 0, add: 0, rename: 0, readHeader: 0, writeHeader: 0 },
    listWorksheets: () => {
      structure.calls.list += 1;
      return Promise.resolve(
        structure.worksheets.map((w) => ({ sheetId: w.sheetId, title: w.title })),
      );
    },
    addWorksheet: (title: string) => {
      structure.calls.add += 1;
      const sheetId = nextId++;
      structure.worksheets.push({ sheetId, title, header: [] });
      return Promise.resolve(sheetId);
    },
    renameWorksheet: (sheetId: number, title: string) => {
      structure.calls.rename += 1;
      const target = structure.worksheets.find((w) => w.sheetId === sheetId);
      if (target) {
        target.title = title;
      }
      return Promise.resolve();
    },
    readHeaderRow: (title: string) => {
      structure.calls.readHeader += 1;
      return Promise.resolve([
        ...(structure.worksheets.find((w) => w.title === title)?.header ?? []),
      ]);
    },
    writeHeaderRow: (title: string, header: readonly string[]) => {
      structure.calls.writeHeader += 1;
      const target = structure.worksheets.find((w) => w.title === title);
      if (target) {
        target.header = [...header];
      }
      return Promise.resolve();
    },
  };
  return structure;
}
