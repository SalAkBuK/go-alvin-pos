import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGoogleConfigService } from '../../src/main/google/googleConfigService';
import type { GoogleConfigService } from '../../src/main/google/googleConfigService';
import { createOAuthAuthProvider } from '../../src/main/google/googleAuthProvider';
import { provisionSpreadsheet } from '../../src/main/google/spreadsheetProvisioning';
import { GoogleApiError } from '../../src/main/google/googleRedaction';
import { PROVISIONING_TOKEN_KEY } from '../../src/main/google/driveTransport';
import { readGoogleSettings } from '../../src/main/settings/googleSettingsRepository';
import { createSaleService } from '../../src/main/checkout/saleService';
import { createMigratedDb } from '../helpers/database';
import { buildCashRequest, seedBusiness, seedProduct, seedTaxRate, T0 } from '../helpers/checkout';
import {
  fakeCredentialStore,
  fakeDrive,
  fakeOAuthClient,
  fakeSheetsStructure,
  FAKE_OAUTH_CREDENTIAL,
} from '../helpers/google';
import type { FakeCredentialStore, FakeDrive, FakeOAuthClient } from '../helpers/google';

/**
 * Phase 2J.1 — desktop OAuth onboarding through the config service
 * (`ARCHITECTURE.md §27`; `REQ-GSHEET-016`-`REQ-GSHEET-019`; `TEST-GSHEET-032`,
 * `-033`, `-036`, `-037`, `-038`, `-039`, `-040`, `-043`, `-044`, `-045`,
 * `-047`, `-048`, `-049`). Fakes for the OAuth client, the loopback flow,
 * Drive, Sheets structure, and safeStorage — no network.
 */

let db: Database.Database;
let clock = Date.parse('2026-09-10T12:00:00.000Z');
const now = (): string => new Date(clock).toISOString();

interface Harness {
  service: GoogleConfigService;
  credentialStore: FakeCredentialStore;
  oauthClient: FakeOAuthClient;
  drive: FakeDrive;
  openedUrls: string[];
  flowCalls: () => number;
}

function makeService(
  opts: {
    oauthClient?: FakeOAuthClient | null;
    credentialStore?: FakeCredentialStore;
    drive?: FakeDrive;
    structureSeed?: Array<{ title: string; header?: string[] }>;
  } = {},
): Harness {
  const oauthClient = opts.oauthClient === null ? null : (opts.oauthClient ?? fakeOAuthClient());
  const credentialStore = opts.credentialStore ?? fakeCredentialStore();
  const drive = opts.drive ?? fakeDrive();
  const openedUrls: string[] = [];
  const structures = new Map<string, ReturnType<typeof fakeSheetsStructure>>();
  let flowCalls = 0;

  const service = createGoogleConfigService({
    db,
    appVersion: 'test',
    credentialStore,
    oauthClient,
    openExternal: (url: string) => {
      openedUrls.push(url);
      return Promise.resolve();
    },
    now,
    randomToken: () => 'provtoken-fixed',
    makeAuthProvider: (refreshToken: string) =>
      createOAuthAuthProvider({ oauthClient: oauthClient ?? fakeOAuthClient(), refreshToken }),
    runOAuthFlow: () => {
      flowCalls += 1;
      return Promise.resolve({
        refreshToken: FAKE_OAUTH_CREDENTIAL.refreshToken,
        sub: FAKE_OAUTH_CREDENTIAL.sub!,
        email: FAKE_OAUTH_CREDENTIAL.email,
      });
    },
    provisionSpreadsheet: (pDeps) =>
      provisionSpreadsheet({
        ...pDeps,
        drive,
        makeStructureTransport: (id: string) => {
          let s = structures.get(id);
          if (!s) {
            s = fakeSheetsStructure(opts.structureSeed ?? [{ title: 'Sheet1' }]);
            structures.set(id, s);
          }
          return s;
        },
      }),
  });

  return {
    service,
    credentialStore,
    oauthClient: oauthClient ?? fakeOAuthClient(),
    drive,
    openedUrls,
    flowCalls: () => flowCalls,
  };
}

beforeEach(async () => {
  clock = Date.parse('2026-09-10T12:00:00.000Z');
  db = await createMigratedDb();
  seedTaxRate(db);
  seedBusiness(db);
});
afterEach(() => db.close());

function auditActions(): string[] {
  return (
    db
      .prepare(
        "SELECT details_json FROM audit_events WHERE event_type='GOOGLE_CONFIGURATION_CHANGED' ORDER BY sequence",
      )
      .all() as Array<{ details_json: string }>
  ).map((r) => (JSON.parse(r.details_json) as { action: string }).action);
}

describe('connect — happy path (TEST-GSHEET-039, -040)', () => {
  it('runs the flow, stores the encrypted refresh token, provisions, reaches READY', async () => {
    const h = makeService();
    const config = await h.service.connect();

    expect(h.flowCalls()).toBe(1);
    expect(config.setupState).toBe('READY');
    expect(config.connected).toBe(true);
    expect(config.enabled).toBe(true);
    expect(config.accountEmail).toBe('owner@example.com');
    expect(config.spreadsheetName).toBe('Go Phones POS Sales');
    expect(config.canOpenSpreadsheet).toBe(true);

    expect(h.credentialStore.stored?.credential.refreshToken).toBe(
      FAKE_OAUTH_CREDENTIAL.refreshToken,
    );
    for (const row of db.prepare('SELECT value FROM settings').all() as Array<{ value: string }>) {
      expect(row.value).not.toContain(FAKE_OAUTH_CREDENTIAL.refreshToken);
    }
    expect(readGoogleSettings(db).credentialGeneration).toBe(1);
    expect(readGoogleSettings(db).spreadsheetId).not.toBeNull();
    expect(readGoogleSettings(db).provisioningToken).toBe('provtoken-fixed');

    expect(h.drive.calls.list).toBeGreaterThanOrEqual(1);
    expect(h.drive.calls.create).toBe(1);
    expect(auditActions()).toEqual([
      'ACCOUNT_CONNECTED',
      'SPREADSHEET_CONFIGURED',
      'EXPORT_ENABLED',
    ]);
  });

  it('worksheet convergence is idempotent — a retry adds no spreadsheet and no duplicate tabs', async () => {
    const h = makeService({ structureSeed: [{ title: 'Sheet1' }] });
    await h.service.connect();
    const createsBefore = h.drive.calls.create;
    const cfg = await h.service.retrySetup();
    expect(cfg.setupState).toBe('READY');
    expect(h.drive.calls.create).toBe(createsBefore);
  });
});

describe('connect — provisioning fails ⇒ SETUP_INCOMPLETE, account kept (TEST-GSHEET-038)', () => {
  it('keeps the OAuth connection and Retry Setup finishes without a new sign-in', async () => {
    const drive = fakeDrive({
      onCreate: () => {
        throw new GoogleApiError('PERMISSION', 'no permission', { httpStatus: 403 });
      },
    });
    const h = makeService({ drive });
    const config = await h.service.connect();

    expect(config.setupState).toBe('SETUP_INCOMPLETE');
    expect(config.connected).toBe(true);
    expect(config.enabled).toBe(false);
    expect(config.setupIncompleteReason).toBeTruthy();
    expect(readGoogleSettings(db).spreadsheetId).toBeNull();

    delete drive.onCreate; // Drive recovers
    const after = await h.service.retrySetup();
    expect(h.flowCalls()).toBe(1);
    expect(after.setupState).toBe('READY');
    expect(readGoogleSettings(db).spreadsheetId).not.toBeNull();
  });
});

describe('ambiguous spreadsheet creation (TEST-GSHEET-047, -048)', () => {
  it('a lost create response re-runs the lookup and adopts — never a second create', async () => {
    const drive = fakeDrive();
    drive.onCreate = () => {
      drive.seedProvisioned('provtoken-fixed', 'ambiguous-adopted'); // Google made it
      throw new GoogleApiError('TIMEOUT', 'aborted', { unknownOutcome: true }); // response lost
    };
    const h = makeService({ drive });
    const config = await h.service.connect();

    expect(drive.calls.create).toBe(1);
    expect(config.setupState).toBe('READY');
    expect(readGoogleSettings(db).spreadsheetId).toBe('ambiguous-adopted');
    expect(
      drive.files.filter((f) => f.appProperties[PROVISIONING_TOKEN_KEY] === 'provtoken-fixed'),
    ).toHaveLength(1);
  });

  it('an unconfirmed lost create leaves SETUP_INCOMPLETE; Retry Setup with the SAME token recovers', async () => {
    const drive = fakeDrive();
    drive.onCreate = () => {
      throw new GoogleApiError('TIMEOUT', 'aborted', { unknownOutcome: true });
    };
    const h = makeService({ drive });
    let config = await h.service.connect();
    expect(config.setupState).toBe('SETUP_INCOMPLETE');
    expect(drive.calls.create).toBe(1);

    drive.seedProvisioned('provtoken-fixed', 'late-adopted'); // becomes discoverable
    config = await h.service.retrySetup();
    expect(config.setupState).toBe('READY');
    expect(drive.calls.create).toBe(1); // still no second create
    expect(readGoogleSettings(db).spreadsheetId).toBe('late-adopted');
  });
});

describe('multiple provisioning-token matches ⇒ safe not-ready (TEST-GSHEET-049)', () => {
  it('stops provisioning, deletes nothing, selects nothing', async () => {
    const drive = fakeDrive();
    drive.seedProvisioned('provtoken-fixed', 'dup-a');
    drive.seedProvisioned('provtoken-fixed', 'dup-b');
    const h = makeService({ drive });
    const config = await h.service.connect();

    expect(config.setupState).toBe('SETUP_INCOMPLETE');
    expect(config.setupIncompleteReason).toMatch(/more than one/i);
    expect(drive.calls.create).toBe(0);
    expect(drive.files).toHaveLength(2);
    expect(readGoogleSettings(db).spreadsheetId).toBeNull();
  });
});

describe('OAuth client / secure storage unavailable (TEST-GSHEET-033)', () => {
  it('connect rejects when this build has no OAuth client', async () => {
    const h = makeService({ oauthClient: null });
    await expect(h.service.connect()).rejects.toMatchObject({
      code: 'GOOGLE_OAUTH_NOT_CONFIGURED',
    });
    expect((await h.service.getConfig()).oauthClientConfigured).toBe(false);
  });

  it('connect rejects (no plaintext) when secure storage is unavailable', async () => {
    const credentialStore = fakeCredentialStore();
    credentialStore.crypto.available = false;
    const h = makeService({ credentialStore });
    await expect(h.service.connect()).rejects.toMatchObject({
      code: 'GOOGLE_SECURE_STORAGE_UNAVAILABLE',
    });
    expect(credentialStore.stored).toBeNull();
    expect(h.flowCalls()).toBe(0);
  });
});

describe('disconnect works offline (TEST-GSHEET-036)', () => {
  it('invalidates locally, clears the spreadsheet id, deletes the file, best-effort revokes', async () => {
    const oauthClient = fakeOAuthClient({ revokeThrows: true });
    const h = makeService({ oauthClient });
    await h.service.connect();

    const config = await h.service.disconnect();
    expect(config.setupState).toBe('DISCONNECTED');
    expect(config.connected).toBe(false);
    expect(config.enabled).toBe(false);
    expect(h.credentialStore.stored).toBeNull();
    expect(h.credentialStore.deleteCount).toBe(1);
    expect(oauthClient.calls.revokes).toHaveLength(1);
    expect(readGoogleSettings(db).spreadsheetId).toBeNull();
    expect(readGoogleSettings(db).credentialGeneration).toBe(1);
    expect(readGoogleSettings(db).credentialActive).toBe(false);
    expect(readGoogleSettings(db).provisioningToken).toBe('provtoken-fixed');
    expect(auditActions()).toContain('ACCOUNT_DISCONNECTED');
  });
});

describe('restart preserves a valid encrypted connection (TEST-GSHEET-044)', () => {
  it('a fresh service instance restores connected + ready', async () => {
    const credentialStore = fakeCredentialStore();
    const drive = fakeDrive();
    await makeService({ credentialStore, drive }).service.connect();

    const config = await makeService({ credentialStore, drive }).service.getConfig();
    expect(config.setupState).toBe('READY');
    expect(config.connected).toBe(true);
  });
});

describe('credential corruption / generation mismatch ⇒ not-ready (TEST-GSHEET-045)', () => {
  it('a wrapper generation disagreeing with the active marker resolves to DISCONNECTED', async () => {
    const credentialStore = fakeCredentialStore();
    const h = makeService({ credentialStore });
    await h.service.connect();

    credentialStore.stored = { generation: 99, credential: FAKE_OAUTH_CREDENTIAL };
    const config = await h.service.getConfig();
    expect(config.connected).toBe(false);
    expect(config.setupState).toBe('DISCONNECTED');
    expect(await h.service.resolveExportContext()).toBeNull();
  });
});

describe('reconcileAtStartup', () => {
  it('file generation ahead of settings (crash after file, before commit) → adopts + audits', async () => {
    const credentialStore = fakeCredentialStore({ generation: 5 });
    await makeService({ credentialStore }).service.reconcileAtStartup();
    expect(readGoogleSettings(db).credentialGeneration).toBe(5);
    expect(readGoogleSettings(db).credentialActive).toBe(true);
    expect(auditActions()).toContain('ACCOUNT_CONNECTED');
  });

  it('committed disconnect with a lingering equal-generation file (active=false) → file deleted', async () => {
    const credentialStore = fakeCredentialStore();
    const h = makeService({ credentialStore });
    await h.service.connect();
    db.prepare("UPDATE settings SET value='false' WHERE key='google_credential_active'").run();
    await h.service.reconcileAtStartup();
    expect(credentialStore.stored).toBeNull();
  });
});

describe('setEnabled', () => {
  it('rejects enabling before ready; allows pause/resume after', async () => {
    const drive = fakeDrive({
      onCreate: () => {
        throw new GoogleApiError('PERMISSION', 'nope', { httpStatus: 403 });
      },
    });
    await makeService({ drive }).service.connect();
    const incomplete = makeService({ drive });
    await expect(incomplete.service.setEnabled({ enabled: true })).rejects.toMatchObject({
      code: 'GOOGLE_NOT_CONNECTED',
    });

    const h = makeService();
    await h.service.connect();
    expect((await h.service.setEnabled({ enabled: false })).enabled).toBe(false);
    expect((await h.service.setEnabled({ enabled: true })).enabled).toBe(true);
  });

  it('rejects unknown fields', async () => {
    await expect(
      makeService().service.setEnabled({ enabled: true, extra: 1 }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('openSpreadsheet (TEST-GSHEET-042)', () => {
  it('opens the Sheets URL for the configured id in the system browser', async () => {
    const h = makeService();
    await h.service.connect();
    await h.service.openSpreadsheet();
    const id = readGoogleSettings(db).spreadsheetId!;
    expect(h.openedUrls).toContain(`https://docs.google.com/spreadsheets/d/${id}/edit`);
  });

  it('fails safely when no spreadsheet is ready', async () => {
    await expect(makeService().service.openSpreadsheet()).rejects.toMatchObject({
      code: 'GOOGLE_SPREADSHEET_NOT_READY',
    });
  });
});

describe('resolveExportContext (worker gate) — TEST-GSHEET-037', () => {
  it('null unless enabled + connected + spreadsheet ready; canonical sheet names', async () => {
    const h = makeService();
    expect(await h.service.resolveExportContext()).toBeNull();
    await h.service.connect();

    const ctx = await h.service.resolveExportContext();
    expect(ctx).not.toBeNull();
    expect(ctx!.salesSheetName).toBe('Sales');
    expect(ctx!.saleItemsSheetName).toBe('Sale Items');
    expect(ctx!.spreadsheetId).toBe(readGoogleSettings(db).spreadsheetId);

    await h.service.setEnabled({ enabled: false });
    expect(await h.service.resolveExportContext()).toBeNull();
  });
});

describe('needsReauthorization — current active credential generation (TEST-GSHEET-043, -057)', () => {
  it('a historical AUTH job error alone does NOT mark the current generation', async () => {
    const h = makeService();
    await h.service.connect();

    const product = seedProduct(db, { quantity: 5 });
    const { saleId } = createSaleService({ db, appVersion: 't', now: () => T0 }).completeCashSale(
      buildCashRequest(db, [{ productId: product.id, quantity: 1, soldPriceCents: 59900 }]),
    );
    db.prepare(
      "UPDATE google_sheet_export_jobs SET status='FAILED', attempt_count=10, last_error='AUTH: token refresh rejected' WHERE sale_id=?",
    ).run(saleId);

    // No current-generation marker ⇒ the banner does not fire off stale job evidence.
    expect((await h.service.getConfig()).needsReauthorization).toBe(false);
  });

  it('an AUTH failure observed for the active generation raises it; a fresh authorization clears it', async () => {
    const h = makeService();
    await h.service.connect();
    const gen = readGoogleSettings(db).credentialGeneration;

    h.service.noteExportAuthResult(gen, 'auth-failure');
    expect((await h.service.getConfig()).needsReauthorization).toBe(true);

    // A report tied to a superseded generation is ignored.
    h.service.noteExportAuthResult(gen - 1, 'auth-failure');

    await h.service.connect(); // re-authorize → generation gen+1
    expect(readGoogleSettings(db).credentialGeneration).toBe(gen + 1);
    expect((await h.service.getConfig()).needsReauthorization).toBe(false);
    // The historical AUTH failure marker for the old generation is not consulted.
    expect(readGoogleSettings(db).authFailureGeneration).toBeNull();

    // A later AUTH failure for the NEW generation raises the banner again.
    h.service.noteExportAuthResult(gen + 1, 'auth-failure');
    expect((await h.service.getConfig()).needsReauthorization).toBe(true);

    // A subsequent successful authenticated operation clears the stale flag.
    h.service.noteExportAuthResult(gen + 1, 'ok');
    expect((await h.service.getConfig()).needsReauthorization).toBe(false);
  });

  it('no queued Google work + an externally revoked token is not detected without a Google operation', async () => {
    const h = makeService();
    await h.service.connect();
    // Token revoked at Google, but nothing calls Google: no speculative probe.
    expect((await h.service.getConfig()).needsReauthorization).toBe(false);
    expect(readGoogleSettings(db).authFailureGeneration).toBeNull();
  });
});
