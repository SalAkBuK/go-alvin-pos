import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGoogleConfigService } from '../../src/main/google/googleConfigService';
import type { GoogleConfigService } from '../../src/main/google/googleConfigService';
import { createExportWorker } from '../../src/main/google/exportWorker';
import { createOAuthAuthProvider } from '../../src/main/google/googleAuthProvider';
import { provisionSpreadsheet } from '../../src/main/google/spreadsheetProvisioning';
import { GoogleApiError } from '../../src/main/google/googleRedaction';
import { readGoogleSettings } from '../../src/main/settings/googleSettingsRepository';
import { createSaleService } from '../../src/main/checkout/saleService';
import { createMigratedDb } from '../helpers/database';
import { buildCashRequest, seedBusiness, seedProduct, seedTaxRate, T0 } from '../helpers/checkout';
import {
  fakeCredentialStore,
  fakeDrive,
  fakeOAuthClient,
  fakeSheetsStructure,
  fakeSheetsTransport,
  FakeSpreadsheet,
  FAKE_OAUTH_CREDENTIAL,
} from '../helpers/google';
import type { FakeCredentialStore, FakeDrive, FakeStructure } from '../helpers/google';
import type { SheetsTransport } from '../../src/main/google/sheetsTransport';

/**
 * Phase 2J.1 adversarial corrections — startup provisioning boundary
 * (`Correction B`, `TEST-GSHEET-050`, `-051`, `-052`), post-READY structural
 * spreadsheet-target failure (`Correction C` / `REQ-GSHEET-020`,
 * `TEST-GSHEET-053`..`-056`), and current-generation auth health
 * (`Correction A`, `TEST-GSHEET-057`). Fakes only — no network, no Electron.
 */

let db: Database.Database;
let clock = Date.parse('2026-09-10T12:00:00.000Z');
const now = (): string => new Date(clock).toISOString();

type TransportBehavior = (op: 'read' | 'write') => void;

interface Harness {
  service: GoogleConfigService;
  credentialStore: FakeCredentialStore;
  drive: FakeDrive;
  structures: Map<string, FakeStructure>;
  sheet: FakeSpreadsheet;
  /** Freshly-built service sharing the same db + credential store + drive (a "restart"). */
  restart(): Harness;
  /** Set the export transport's failure behaviour for the next worker run. */
  setTransportBehavior(fn: TransportBehavior | null): void;
  runWorkerOnce(): Promise<void>;
  connectResult(): number;
}

function makeHarness(
  shared: {
    credentialStore?: FakeCredentialStore;
    drive?: FakeDrive;
    structures?: Map<string, FakeStructure>;
    sheet?: FakeSpreadsheet;
    structureSeed?: Array<{ title: string; header?: string[] }>;
  } = {},
): Harness {
  const credentialStore = shared.credentialStore ?? fakeCredentialStore();
  const drive = shared.drive ?? fakeDrive();
  const structures = shared.structures ?? new Map<string, FakeStructure>();
  const sheet = shared.sheet ?? new FakeSpreadsheet();
  const oauthClient = fakeOAuthClient();
  let connectCount = 0;
  let transportBehavior: TransportBehavior | null = null;

  const service = createGoogleConfigService({
    db,
    appVersion: 'test',
    credentialStore,
    oauthClient,
    openExternal: () => Promise.resolve(),
    now,
    randomToken: () => 'provtoken-fixed',
    makeAuthProvider: (refreshToken: string) =>
      createOAuthAuthProvider({ oauthClient, refreshToken }),
    runOAuthFlow: () => {
      connectCount += 1;
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
            s = fakeSheetsStructure(shared.structureSeed ?? [{ title: 'Sheet1' }]);
            structures.set(id, s);
          }
          return s;
        },
      }),
  });

  const noopLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
  } as unknown as Parameters<typeof createExportWorker>[0]['logger'];

  const worker = createExportWorker({
    db,
    logger: noopLogger,
    resolveContext: () => service.resolveExportContext(),
    createTransport: (): SheetsTransport =>
      fakeSheetsTransport(sheet, {
        onRead: () => transportBehavior?.('read'),
        onWrite: () => transportBehavior?.('write'),
      }),
    reportAuthHealth: (result, generation) => service.noteExportAuthResult(generation, result),
    onStructuralTargetFailure: (spreadsheetId, kind) =>
      service.invalidateSpreadsheetTarget(spreadsheetId, kind),
    now,
  });

  const harness: Harness = {
    service,
    credentialStore,
    drive,
    structures,
    sheet,
    restart: () => makeHarness({ credentialStore, drive, structures, sheet }),
    setTransportBehavior: (fn) => {
      transportBehavior = fn;
    },
    runWorkerOnce: () => worker.runOnce(),
    connectResult: () => connectCount,
  };
  return harness;
}

function completeSale(): string {
  const product = seedProduct(db, { quantity: 20 });
  return createSaleService({ db, appVersion: 't', now: () => T0 }).completeCashSale(
    buildCashRequest(db, [{ productId: product.id, quantity: 1, soldPriceCents: 59900 }]),
  ).saleId;
}

function jobRow(saleId: string): Record<string, unknown> {
  return db
    .prepare('SELECT * FROM google_sheet_export_jobs WHERE sale_id = ?')
    .get(saleId) as Record<string, unknown>;
}

function clearBackoff(saleId: string): void {
  db.prepare('UPDATE google_sheet_export_jobs SET next_attempt_at = ? WHERE sale_id = ?').run(
    now(),
    saleId,
  );
}

function auditActors(): Array<{ action: string; actor: string }> {
  return (
    db
      .prepare(
        "SELECT actor_type, details_json FROM audit_events WHERE event_type='GOOGLE_CONFIGURATION_CHANGED' ORDER BY sequence",
      )
      .all() as Array<{ actor_type: string; details_json: string }>
  ).map((r) => ({
    action: (JSON.parse(r.details_json) as { action: string }).action,
    actor: r.actor_type,
  }));
}

beforeEach(async () => {
  clock = Date.parse('2026-09-10T12:00:00.000Z');
  db = await createMigratedDb();
  seedTaxRate(db);
  seedBusiness(db);
});
afterEach(() => db.close());

// ── Correction B — startup provisioning boundary ──────────────────────────────

describe('TEST-GSHEET-050 — ordinary setup-incomplete startup does no Google work', () => {
  it('no files.list / files.create / worksheet mutation at startup; state persists', async () => {
    // Provisioning fails at the Drive lookup ⇒ no files.create is ever issued.
    const drive = fakeDrive({
      onList: () => {
        throw new GoogleApiError('NETWORK', 'unreachable');
      },
    });
    const h = makeHarness({ drive });
    const cfg = await h.service.connect();
    expect(cfg.setupState).toBe('SETUP_INCOMPLETE');
    expect(readGoogleSettings(db).provisioningCreateAttempted).toBe(false);

    delete drive.onList;
    const listBefore = drive.calls.list;
    const createBefore = drive.calls.create;

    // "Restart": a fresh service, then startup recovery — must touch nothing.
    const restarted = h.restart();
    await restarted.service.ensureProvisionedIfNeeded();

    expect(drive.calls.list).toBe(listBefore);
    expect(drive.calls.create).toBe(createBefore);
    const after = await restarted.service.getConfig();
    expect(after.setupState).toBe('SETUP_INCOMPLETE');
    expect(after.setupIncompleteReason).toBeTruthy();
    expect(after.connected).toBe(true);
  });
});

describe('TEST-GSHEET-051 — startup recovery after an attempted create: lookup + adopt', () => {
  it('one files.list with the same token, adopt, converge, READY — no new files.create', async () => {
    const drive = fakeDrive();
    drive.onCreate = () => {
      // The create response was lost; the spreadsheet is not yet discoverable.
      throw new GoogleApiError('TIMEOUT', 'aborted', { unknownOutcome: true });
    };
    const h = makeHarness({ drive });
    const cfg = await h.service.connect();
    expect(cfg.setupState).toBe('SETUP_INCOMPLETE');
    expect(readGoogleSettings(db).provisioningCreateAttempted).toBe(true);
    expect(drive.calls.create).toBe(1);

    // Google had in fact created it under the durable token — now discoverable.
    delete drive.onCreate;
    drive.seedProvisioned('provtoken-fixed', 'ambiguous-1');
    const createsBefore = drive.calls.create;
    const listsBefore = drive.calls.list;

    const restarted = h.restart();
    await restarted.service.ensureProvisionedIfNeeded();

    expect(drive.calls.create).toBe(createsBefore); // never creates at startup
    expect(drive.calls.list).toBe(listsBefore + 1); // exactly one lookup
    const after = await restarted.service.getConfig();
    expect(after.setupState).toBe('READY');
    expect(readGoogleSettings(db).spreadsheetId).toBe('ambiguous-1');
    expect(auditActors()).toContainEqual({ action: 'SPREADSHEET_CONFIGURED', actor: 'SYSTEM' });
  });
});

describe('TEST-GSHEET-052 — startup recovery with zero matches does not create', () => {
  it('startup: no files.create, stays SETUP_INCOMPLETE; a later Retry Setup completes it', async () => {
    const drive = fakeDrive();
    drive.onCreate = () => {
      throw new GoogleApiError('TIMEOUT', 'aborted', { unknownOutcome: true });
    };
    const h = makeHarness({ drive });
    await h.service.connect();
    expect(readGoogleSettings(db).provisioningCreateAttempted).toBe(true);
    expect(drive.calls.create).toBe(1);

    delete drive.onCreate;
    const restarted = h.restart();
    await restarted.service.ensureProvisionedIfNeeded();

    expect(drive.calls.create).toBe(1); // startup did NOT create
    expect((await restarted.service.getConfig()).setupState).toBe('SETUP_INCOMPLETE');

    // Explicit owner Retry Setup: lookup first, then the single tagged create.
    const after = await restarted.service.retrySetup();
    expect(after.setupState).toBe('READY');
    expect(drive.calls.create).toBe(2);
    expect(
      auditActors().some((a) => a.action === 'SPREADSHEET_CONFIGURED' && a.actor === 'USER'),
    ).toBe(true);
  });

  it('startup with >1 token match stays SETUP_INCOMPLETE and never selects one', async () => {
    const drive = fakeDrive();
    drive.onCreate = () => {
      throw new GoogleApiError('TIMEOUT', 'aborted', { unknownOutcome: true });
    };
    const h = makeHarness({ drive });
    await h.service.connect();

    delete drive.onCreate;
    drive.seedProvisioned('provtoken-fixed', 'dup-a');
    drive.seedProvisioned('provtoken-fixed', 'dup-b');
    const restarted = h.restart();
    await restarted.service.ensureProvisionedIfNeeded();

    expect(drive.calls.create).toBe(1);
    expect(readGoogleSettings(db).spreadsheetId).toBeNull();
    expect((await restarted.service.getConfig()).setupState).toBe('SETUP_INCOMPLETE');
  });
});

// ── Correction C — post-READY structural spreadsheet-target failure ───────────

describe('TEST-GSHEET-053 — transient Google failure while READY preserves setup', () => {
  it.each([
    ['network error', () => new GoogleApiError('NETWORK', 'unreachable')],
    ['timeout', () => new GoogleApiError('TIMEOUT', 'aborted', { unknownOutcome: true })],
    [
      'HTTP 5xx',
      () => new GoogleApiError('UNKNOWN', 'server', { httpStatus: 503, unknownOutcome: true }),
    ],
    ['HTTP 429', () => new GoogleApiError('RATE_LIMIT', 'quota', { httpStatus: 429 })],
  ])('%s → spreadsheet remains READY, id unchanged', async (_label, makeError) => {
    const h = makeHarness();
    await h.service.connect();
    const spreadsheetId = readGoogleSettings(db).spreadsheetId;
    expect(spreadsheetId).not.toBeNull();
    const saleId = completeSale();

    h.setTransportBehavior(() => {
      throw makeError();
    });
    await h.runWorkerOnce();
    clearBackoff(saleId);
    await h.runWorkerOnce();

    expect(readGoogleSettings(db).spreadsheetId).toBe(spreadsheetId);
    expect((await h.service.getConfig()).setupState).toBe('READY');
  });
});

describe('TEST-GSHEET-054 / -055 — definite structural failure: READY → SETUP_INCOMPLETE', () => {
  it.each([
    ['NOT_FOUND (deleted)', 'NOT_FOUND' as const, 404],
    ['PERMISSION (access lost)', 'PERMISSION' as const, 403],
  ])(
    '%s → target cleared, OAuth kept, job evidence retained, Retry Setup offered',
    async (_label, category, httpStatus) => {
      const h = makeHarness();
      await h.service.connect();
      const spreadsheetId = readGoogleSettings(db).spreadsheetId!;
      const saleId = completeSale();

      h.setTransportBehavior(() => {
        throw new GoogleApiError(category, 'structural', { httpStatus, structuralTarget: true });
      });

      // Attempt 1: a definite structural result, but not yet confirmed → backoff only.
      await h.runWorkerOnce();
      expect(readGoogleSettings(db).spreadsheetId).toBe(spreadsheetId);
      expect(jobRow(saleId).attempt_count).toBe(1);

      // Attempt 2: confirmed on the job's normal retry → the target is invalidated.
      clearBackoff(saleId);
      await h.runWorkerOnce();

      const cfg = await h.service.getConfig();
      expect(cfg.setupState).toBe('SETUP_INCOMPLETE');
      expect(cfg.connected).toBe(true);
      expect(cfg.needsReauthorization).toBe(false); // credential itself is valid
      expect(cfg.setupIncompleteReason).toBeTruthy();
      expect(cfg.canOpenSpreadsheet).toBe(false);
      expect(readGoogleSettings(db).spreadsheetId).toBeNull();

      const job = jobRow(saleId);
      expect(job.status).toBe('PENDING');
      expect(job.attempt_count).toBe(2); // not reset
      expect(String(job.last_error)).toContain(category);

      // Local sale is untouched.
      expect(
        (db.prepare('SELECT status FROM sales WHERE id=?').get(saleId) as { status: string })
          .status,
      ).toBe('COMPLETED');

      // The worker makes no further spreadsheet writes while setup is incomplete.
      let extraCalls = 0;
      h.setTransportBehavior(() => {
        extraCalls += 1;
      });
      clearBackoff(saleId);
      await h.runWorkerOnce();
      expect(extraCalls).toBe(0);
      expect(jobRow(saleId).attempt_count).toBe(2);

      expect(auditActors()).toContainEqual({
        action: 'SPREADSHEET_TARGET_INVALIDATED',
        actor: 'SYSTEM',
      });
    },
  );
});

describe('TEST-GSHEET-056 — Retry Setup after a deleted spreadsheet', () => {
  it('same OAuth + token, Drive lookup first, one replacement create, queued sale exports once', async () => {
    const h = makeHarness();
    await h.service.connect();
    const originalId = readGoogleSettings(db).spreadsheetId!;
    const saleId = completeSale();

    // The configured spreadsheet is deleted → establish the structural failure.
    h.setTransportBehavior(() => {
      throw new GoogleApiError('NOT_FOUND', 'not found', {
        httpStatus: 404,
        structuralTarget: true,
      });
    });
    await h.runWorkerOnce();
    clearBackoff(saleId);
    await h.runWorkerOnce();
    expect((await h.service.getConfig()).setupState).toBe('SETUP_INCOMPLETE');

    // The deleted/trashed spreadsheet no longer matches the Drive lookup.
    h.drive.files.length = 0;
    const createsBefore = h.drive.calls.create;
    const connectsBefore = h.connectResult();

    const after = await h.service.retrySetup();
    expect(h.connectResult()).toBe(connectsBefore); // no new sign-in
    expect(readGoogleSettings(db).provisioningToken).toBe('provtoken-fixed'); // same token
    expect(h.drive.calls.create).toBe(createsBefore + 1); // one owner-initiated replacement
    expect(after.setupState).toBe('READY');
    const newId = readGoogleSettings(db).spreadsheetId!;
    expect(newId).not.toBe(originalId);

    // The previously queued export delivers against the recovered spreadsheet.
    h.setTransportBehavior(null);
    clearBackoff(saleId);
    await h.runWorkerOnce();
    expect(jobRow(saleId).status).toBe('EXPORTED');
    expect(h.sheet.findBySaleId('Sales', saleId)).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sales WHERE id=?').get(saleId)).toEqual({ n: 1 });
  });
});

// ── Correction A — current-generation auth health, end-to-end (TEST-GSHEET-057)

describe('TEST-GSHEET-057 — needs-re-authorization reflects the current credential', () => {
  it('gen A AUTH failure → needs reauth; gen B reauthorization clears it; gen B failure raises it again', async () => {
    const h = makeHarness();
    await h.service.connect(); // generation A = 1
    expect(readGoogleSettings(db).credentialGeneration).toBe(1);
    const saleId = completeSale();

    // The token is revoked → the export job fails on AUTH and reaches FAILED.
    h.setTransportBehavior(() => {
      throw new GoogleApiError('AUTH', 'invalid_grant', { httpStatus: 401 });
    });
    for (let i = 0; i < 10; i += 1) {
      clearBackoff(saleId);
      await h.runWorkerOnce();
    }
    const failedJob = jobRow(saleId);
    expect(failedJob.status).toBe('FAILED');
    expect(String(failedJob.last_error)).toContain('AUTH');
    expect((await h.service.getConfig()).needsReauthorization).toBe(true);
    expect(readGoogleSettings(db).authFailureGeneration).toBe(1);

    // Owner re-authorizes → generation B = 2.
    await h.service.connect();
    expect(readGoogleSettings(db).credentialGeneration).toBe(2);

    // The historical FAILED job is unchanged...
    const stillFailed = jobRow(saleId);
    expect(stillFailed.status).toBe('FAILED');
    expect(stillFailed.last_error).toBe(failedJob.last_error);
    expect(stillFailed.attempt_count).toBe(failedJob.attempt_count);
    // ...and the banner reflects generation B, which never failed auth.
    expect((await h.service.getConfig()).needsReauthorization).toBe(false);
    expect(readGoogleSettings(db).authFailureGeneration).toBeNull();

    // A later auth failure for generation B raises the signal again.
    db.prepare(
      "UPDATE google_sheet_export_jobs SET status='PENDING', attempt_count=0, next_attempt_at=? WHERE sale_id=?",
    ).run(now(), saleId);
    h.setTransportBehavior(() => {
      throw new GoogleApiError('AUTH', 'invalid_grant', { httpStatus: 401 });
    });
    await h.runWorkerOnce();
    expect((await h.service.getConfig()).needsReauthorization).toBe(true);
    expect(readGoogleSettings(db).authFailureGeneration).toBe(2);
  });

  it('a successful authenticated export under the current generation clears a stale auth flag', async () => {
    const h = makeHarness();
    await h.service.connect();
    const saleId = completeSale();

    h.setTransportBehavior(() => {
      throw new GoogleApiError('AUTH', 'invalid_grant', { httpStatus: 401 });
    });
    await h.runWorkerOnce();
    expect((await h.service.getConfig()).needsReauthorization).toBe(true);

    // The same generation later proves usable.
    h.setTransportBehavior(null);
    db.prepare('UPDATE google_sheet_export_jobs SET next_attempt_at=? WHERE sale_id=?').run(
      now(),
      saleId,
    );
    await h.runWorkerOnce();
    expect(jobRow(saleId).status).toBe('EXPORTED');
    expect((await h.service.getConfig()).needsReauthorization).toBe(false);
    expect(readGoogleSettings(db).authFailureGeneration).toBeNull();
  });
});
