import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackupService } from '../../src/main/backup/backupService';
import type { BackupService } from '../../src/main/backup/backupService';
import { createRestoreService } from '../../src/main/backup/restoreService';
import type { RestoreService } from '../../src/main/backup/restoreService';
import { insertCompletedBackupRecord } from '../../src/main/backup/backupRecordsRepository';
import { createGoogleConfigService } from '../../src/main/google/googleConfigService';
import type { GoogleConfigService } from '../../src/main/google/googleConfigService';
import { createOAuthAuthProvider } from '../../src/main/google/googleAuthProvider';
import { provisionSpreadsheet } from '../../src/main/google/spreadsheetProvisioning';
import { readGoogleSettings } from '../../src/main/settings/googleSettingsRepository';
import { ProductionDatabase } from '../../src/main/database/database';
import { createMaintenanceCoordinator } from '../../src/main/maintenance/maintenanceCoordinator';
import type { MaintenanceCoordinator } from '../../src/main/maintenance/maintenanceCoordinator';
import { setExclusiveMaintenance } from '../../src/main/maintenance/maintenanceStatus';
import { createCapturingLogger, makeTempDir } from '../helpers/database';
import { seedBusiness, seedTaxRate } from '../helpers/checkout';
import {
  fakeCredentialStore,
  fakeDrive,
  fakeOAuthClient,
  fakeSheetsStructure,
} from '../helpers/google';
import type {
  FakeCredentialStore,
  FakeDrive,
  FakeOAuthClient,
  FakeStructure,
} from '../helpers/google';
import type { RestoreOutcome } from '../../src/shared/restore';

/**
 * 2L-B final corrections — restore-specific Google credential quarantine
 * (`ARCHITECTURE.md §27.4`; Phase 2L-B Item 4 design pass; task §1-§8).
 *
 * Wires the real restore lifecycle (`ProductionDatabase`, `restoreService`)
 * together with a real `GoogleConfigService` against fake OAuth/Drive/
 * credential-store boundaries, mirroring `index.ts`'s
 * `wireDatabaseBackedServices` + `activateDatabase({ restored: true })`
 * ordering exactly: rebuild the config service against the restored
 * connection → `prepareRestoredCredentialState()` → only then would ordinary
 * background work resume.
 */

let temp: ReturnType<typeof makeTempDir>;
let dbFile: string;
let backupsRoot: string;
let userDataDir: string;
let clock: Date;
let capture: ReturnType<typeof createCapturingLogger>;
let pdb: ProductionDatabase;
let coordinator: MaintenanceCoordinator;
let backupService: BackupService;
let restoreService: RestoreService;
let googleConfigService: GoogleConfigService;
let pendingPrepare: Promise<void>;

// Outside SQLite, persists across every "restore" / "restart" in this suite —
// exactly like the real encrypted credential file and the owner's live Drive.
let credentialStore: FakeCredentialStore;
let drive: FakeDrive;
let oauthClient: FakeOAuthClient;
let structures: Map<string, FakeStructure>;
/** The identity `runOAuthFlow` hands back for the NEXT `connect()` call. */
let currentIdentity: { refreshToken: string; sub: string; email: string };

function buildGoogleConfigService(db: Database.Database): GoogleConfigService {
  return createGoogleConfigService({
    db,
    appVersion: 'test',
    credentialStore,
    oauthClient,
    openExternal: () => Promise.resolve(),
    now: () => clock.toISOString(),
    randomToken: () => 'provtoken-fixed',
    makeAuthProvider: (refreshToken: string) =>
      createOAuthAuthProvider({ oauthClient, refreshToken }),
    runOAuthFlow: () => Promise.resolve({ ...currentIdentity }),
    provisionSpreadsheet: (pDeps) =>
      provisionSpreadsheet({
        ...pDeps,
        drive,
        makeStructureTransport: (id: string) => {
          let s = structures.get(id);
          if (!s) {
            s = fakeSheetsStructure();
            structures.set(id, s);
          }
          return s;
        },
      }),
  });
}

function buildBackupService(): BackupService {
  return createBackupService({
    db: pdb.connection,
    backupsRoot,
    appVersion: 'test',
    logger: capture.logger,
    now: () => clock,
    isExclusiveMaintenanceActive: () => coordinator.isExclusiveActive(),
  });
}

function buildRestoreService(): RestoreService {
  return createRestoreService({
    logger: capture.logger,
    databaseFile: dbFile,
    backupsRoot,
    userDataDir,
    targetSchemaVersion: 1,
    coordinator,
    now: () => clock,
    getCurrentDatabase: () => pdb,
    quiesceBackgroundWork: async () => {},
    openDatabase: () =>
      ProductionDatabase.open({
        filename: dbFile,
        backupDir: backupsRoot,
        logger: capture.logger,
        appVersion: 'test',
      }),
    // Mirrors `index.ts`'s `wireDatabaseBackedServices` + the
    // `context.restored` branch of its `activateDatabase` callback exactly.
    activateDatabase: (db, context) => {
      pdb = db as ProductionDatabase;
      backupService = buildBackupService();
      googleConfigService = buildGoogleConfigService(pdb.connection);
      pendingPrepare = context?.restored
        ? googleConfigService.prepareRestoredCredentialState()
        : Promise.resolve();
    },
  });
}

async function manualBackupId(): Promise<string> {
  await backupService.createManual();
  const candidates = await restoreService.listCandidates();
  return candidates[0]!.backupId;
}

/** Policy 1: every restore needs the two-step confirm dance. No sale-loss is expected in this suite. */
async function confirmAndRestore(backupId: string): Promise<void> {
  const first = await restoreService.restore(backupId);
  if (first.outcome !== 'CONFIRMATION_REQUIRED') {
    throw new Error('expected CONFIRMATION_REQUIRED on the first attempt');
  }
  await pendingPrepare;
  const second: RestoreOutcome = await restoreService.restore(backupId, first.confirmationToken);
  if (second.outcome !== 'COMPLETED') {
    throw new Error(`expected COMPLETED, got ${second.outcome}`);
  }
  await pendingPrepare;
}

function networkCalls(): number {
  return drive.calls.list + drive.calls.create;
}

// ── Full-table-set restore-fidelity comparison (TEST-BACKUP-017 / -022) ──────

const CANONICAL_TABLES = [
  'products',
  'customers',
  'sales',
  'sale_items',
  'payments',
  'inventory_movements',
  'settings',
  'google_sheet_export_jobs',
  'checkout_requests',
  'counters',
  'audit_events',
  'backup_records',
  'schema_migrations',
] as const;

/**
 * SQLite does not guarantee row order for `SELECT *` without an explicit
 * `ORDER BY` — an unordered scan happened to match in practice (both sides
 * read an untouched, identically-laid-out table), but that is a query-planner
 * implementation detail, not a guarantee. Each table's own stable primary /
 * business key, from `001_initial_schema.ts`, makes the comparison
 * deterministic regardless of scan order. Every table here has a single-
 * column key; none needs (or got) a fabricated composite ordering.
 */
const TABLE_ORDER_BY: Record<(typeof CANONICAL_TABLES)[number], string> = {
  products: 'id',
  customers: 'id',
  sales: 'id',
  sale_items: 'id',
  payments: 'id',
  inventory_movements: 'id',
  settings: 'key',
  google_sheet_export_jobs: 'id',
  checkout_requests: 'request_id',
  counters: 'key',
  // `sequence` (not `id`) — the append-only, monotonic audit-history order,
  // unique per `001_initial_schema.ts` (`sequence INTEGER NOT NULL UNIQUE`).
  audit_events: 'sequence',
  backup_records: 'id',
  schema_migrations: 'version',
};

function snapshotTables(db: Database.Database): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const table of CANONICAL_TABLES) {
    out[table] = db
      .prepare(`SELECT * FROM ${table} ORDER BY ${TABLE_ORDER_BY[table]}`)
      .all() as unknown[];
  }
  return out;
}

function openReadonly(path: string): Database.Database {
  return new Database(path, { readonly: true, fileMustExist: true });
}

/** The backup file's own content, read directly — independent of the live connection. */
function snapshotBackupFile(backupId: string): Record<string, unknown[]> {
  const row = pdb.connection
    .prepare('SELECT storage_path, file_name FROM backup_records WHERE id = ?')
    .get(backupId) as { storage_path: string; file_name: string };
  const source = openReadonly(join(row.storage_path, row.file_name));
  try {
    return snapshotTables(source);
  } finally {
    source.close();
  }
}

beforeEach(async () => {
  temp = makeTempDir('gpp-restore-google-');
  userDataDir = temp.path;
  dbFile = join(temp.path, 'gophones.sqlite');
  backupsRoot = join(temp.path, 'backups');
  clock = new Date('2026-09-10T12:00:00.000Z');
  capture = createCapturingLogger();
  setExclusiveMaintenance(null);

  credentialStore = fakeCredentialStore();
  drive = fakeDrive();
  oauthClient = fakeOAuthClient();
  structures = new Map();
  currentIdentity = { refreshToken: 'refresh-a', sub: 'sub-a', email: 'owner-a@example.com' };

  pdb = await ProductionDatabase.open({
    filename: dbFile,
    backupDir: backupsRoot,
    logger: capture.logger,
    appVersion: 'test',
  });
  seedTaxRate(pdb.connection);
  seedBusiness(pdb.connection);
  coordinator = createMaintenanceCoordinator({
    logger: capture.logger,
    getDb: () => pdb?.connection ?? null,
  });
  backupService = buildBackupService();
  restoreService = buildRestoreService();
  googleConfigService = buildGoogleConfigService(pdb.connection);
  pendingPrepare = Promise.resolve();
});

afterEach(() => {
  try {
    pdb.close();
  } catch {
    /* already closed by a restore */
  }
  setExclusiveMaintenance(null);
  temp.cleanup();
});

describe('A — Account A → connect Account B → restore A-era DB → quarantine', () => {
  it('quarantines, disconnects, and performs zero Google network', async () => {
    // Account A: gen1, spreadsheet A.
    await googleConfigService.connect();
    expect(readGoogleSettings(pdb.connection).credentialGeneration).toBe(1);
    const spreadsheetA = readGoogleSettings(pdb.connection).spreadsheetId;
    expect(spreadsheetA).not.toBeNull();

    // Backup taken while A is active.
    const backupId = await manualBackupId();

    // Connect Account B: gen2, spreadsheet B — the file now reflects B.
    currentIdentity = { refreshToken: 'refresh-b', sub: 'sub-b', email: 'owner-b@example.com' };
    drive.files.length = 0; // account B's own Drive view starts empty — never sees A's files
    await googleConfigService.connect();
    expect(readGoogleSettings(pdb.connection).credentialGeneration).toBe(2);
    const spreadsheetB = readGoogleSettings(pdb.connection).spreadsheetId;
    expect(spreadsheetB).not.toBe(spreadsheetA);

    const callsBefore = networkCalls();

    // Restore the A-era backup.
    await confirmAndRestore(backupId);

    // The restored SQLite is back to gen1/spreadsheet A, but the encrypted
    // credential file (untouched by restore) still holds gen2/B.
    expect(readGoogleSettings(pdb.connection).credentialGeneration).toBe(1);
    expect(readGoogleSettings(pdb.connection).spreadsheetId).toBe(spreadsheetA);
    expect(readGoogleSettings(pdb.connection).restoreReconnectRequired).toBe(true);

    const cfg = await googleConfigService.getConfig();
    expect(cfg.connected).toBe(false);
    expect(cfg.setupState).not.toBe('READY');
    expect(cfg.setupState).toBe('DISCONNECTED');
    expect(cfg.canOpenSpreadsheet).toBe(false);
    expect(cfg.restoreReconnectRequired).toBe(true);

    // Zero Google network from the restore/quarantine step itself.
    expect(networkCalls()).toBe(callsBefore);

    // Open Spreadsheet is unavailable while quarantined.
    await expect(googleConfigService.openSpreadsheet()).rejects.toMatchObject({
      code: 'GOOGLE_SPREADSHEET_NOT_READY',
    });
  });
});

describe('B — restart after quarantine', () => {
  it('quarantine survives a restart; no file-ahead adoption; zero network', async () => {
    await googleConfigService.connect();
    const backupId = await manualBackupId();
    currentIdentity = { refreshToken: 'refresh-b', sub: 'sub-b', email: 'owner-b@example.com' };
    drive.files.length = 0; // account B's own Drive view starts empty — never sees A's files
    await googleConfigService.connect();
    await confirmAndRestore(backupId);
    expect(readGoogleSettings(pdb.connection).restoreReconnectRequired).toBe(true);

    // "Restart": close and reopen the database, rebuild the config service as
    // an ORDINARY (non-restored) activation would.
    pdb.close();
    pdb = await ProductionDatabase.open({
      filename: dbFile,
      backupDir: backupsRoot,
      logger: capture.logger,
      appVersion: 'test',
    });
    googleConfigService = buildGoogleConfigService(pdb.connection);

    const callsBefore = networkCalls();
    await googleConfigService.reconcileAtStartup();
    await googleConfigService.ensureProvisionedIfNeeded();

    expect(readGoogleSettings(pdb.connection).restoreReconnectRequired).toBe(true);
    expect(readGoogleSettings(pdb.connection).credentialGeneration).toBe(1); // not adopted to 2
    expect((await googleConfigService.getConfig()).connected).toBe(false);
    expect(networkCalls()).toBe(callsBefore);
  });
});

describe('C — explicit Connect after restore clears quarantine', () => {
  it('a fresh owner-authorized connect commits atomically and resumes normal provisioning', async () => {
    await googleConfigService.connect();
    const backupId = await manualBackupId();
    currentIdentity = { refreshToken: 'refresh-b', sub: 'sub-b', email: 'owner-b@example.com' };
    drive.files.length = 0; // account B's own Drive view starts empty — never sees A's files
    await googleConfigService.connect();
    await confirmAndRestore(backupId);
    expect(readGoogleSettings(pdb.connection).restoreReconnectRequired).toBe(true);

    // The owner explicitly reconnects (as account B again, for this test).
    const cfg = await googleConfigService.connect();

    expect(readGoogleSettings(pdb.connection).restoreReconnectRequired).toBe(false);
    expect(cfg.connected).toBe(true);
    expect(['READY', 'SETUP_INCOMPLETE']).toContain(cfg.setupState);
    // Provisioning ran for the newly authorized account — a fresh spreadsheet,
    // never the restored A-era one.
    expect(readGoogleSettings(pdb.connection).spreadsheetId).not.toBeNull();
  });
});

describe('D — crash after new credential file write, before the reconnect commit', () => {
  it('quarantine survives; no auto-adoption; disconnected; zero network', async () => {
    await googleConfigService.connect();
    const backupId = await manualBackupId();
    currentIdentity = { refreshToken: 'refresh-b', sub: 'sub-b', email: 'owner-b@example.com' };
    drive.files.length = 0; // account B's own Drive view starts empty — never sees A's files
    await googleConfigService.connect();
    await confirmAndRestore(backupId);
    expect(readGoogleSettings(pdb.connection).restoreReconnectRequired).toBe(true);

    // Simulate a crash mid-reconnect: the encrypted file landed at a NEW
    // generation, but the SQLite commit that would activate it and clear
    // quarantine never ran.
    credentialStore.stored = {
      generation: 99,
      credential: { ...credentialStore.stored!.credential },
    };

    const callsBefore = networkCalls();
    await googleConfigService.reconcileAtStartup();

    expect(readGoogleSettings(pdb.connection).restoreReconnectRequired).toBe(true);
    expect(readGoogleSettings(pdb.connection).credentialGeneration).not.toBe(99);
    expect((await googleConfigService.getConfig()).connected).toBe(false);
    expect(networkCalls()).toBe(callsBefore);
  });
});

describe('E — ordinary (non-restore) credential-rotation crash recovery is unchanged', () => {
  it('file-ahead-generation adoption still works exactly as before', async () => {
    await googleConfigService.connect();
    expect(readGoogleSettings(pdb.connection).credentialGeneration).toBe(1);
    expect(readGoogleSettings(pdb.connection).restoreReconnectRequired).toBe(false);

    // Simulate the ordinary crash: the file landed at generation 2, but the
    // SQLite commit never ran. No restore occurred anywhere in this test.
    credentialStore.stored = {
      generation: 2,
      credential: { ...credentialStore.stored!.credential },
    };

    await googleConfigService.reconcileAtStartup();

    expect(readGoogleSettings(pdb.connection).credentialGeneration).toBe(2);
    expect(readGoogleSettings(pdb.connection).credentialActive).toBe(true);
    expect(readGoogleSettings(pdb.connection).restoreReconnectRequired).toBe(false); // never set
    expect((await googleConfigService.getConfig()).connected).toBe(true);
  });
});

describe('F — a failed restore rollback never spuriously quarantines', () => {
  it('the original Google relationship is restored unquarantined after rollback', async () => {
    await googleConfigService.connect();
    expect(readGoogleSettings(pdb.connection).credentialGeneration).toBe(1);
    const backupId = await manualBackupId();

    // Force the RESTORED open to fail, so restoreService rolls back to the
    // verified pre-restore recovery copy (the ORIGINAL, continuous-timeline
    // database) rather than completing a swap.
    let openCall = 0;
    restoreService = createRestoreService({
      logger: capture.logger,
      databaseFile: dbFile,
      backupsRoot,
      userDataDir,
      targetSchemaVersion: 1,
      coordinator,
      now: () => clock,
      getCurrentDatabase: () => pdb,
      quiesceBackgroundWork: async () => {},
      openDatabase: () => {
        openCall += 1;
        if (openCall === 1) {
          throw new Error('simulated restored-database open failure');
        }
        return ProductionDatabase.open({
          filename: dbFile,
          backupDir: backupsRoot,
          logger: capture.logger,
          appVersion: 'test',
        });
      },
      activateDatabase: (db, context) => {
        pdb = db as ProductionDatabase;
        backupService = buildBackupService();
        googleConfigService = buildGoogleConfigService(pdb.connection);
        pendingPrepare = context?.restored
          ? googleConfigService.prepareRestoredCredentialState()
          : Promise.resolve();
      },
    });

    const first = await restoreService.restore(backupId);
    if (first.outcome !== 'CONFIRMATION_REQUIRED') throw new Error('expected confirmation');
    await pendingPrepare;
    await expect(restoreService.restore(backupId, first.confirmationToken)).rejects.toMatchObject({
      code: 'RESTORE_VALIDATION_FAILED',
    });
    await pendingPrepare;

    // Back on the ORIGINAL (never-restored) database — no quarantine, still connected.
    expect(readGoogleSettings(pdb.connection).restoreReconnectRequired).toBe(false);
    expect(readGoogleSettings(pdb.connection).credentialGeneration).toBe(1);
    expect((await googleConfigService.getConfig()).connected).toBe(true);
  });
});

describe('H — generation collision: equal generation numbers are not account identity', () => {
  it('quarantines even when the file generation exactly matches the restored generation', async () => {
    // Account A connects (gen1, spreadsheet A), then reauthorizes (gen2,
    // same account, same spreadsheet via the same provisioning token).
    await googleConfigService.connect();
    const spreadsheetA = readGoogleSettings(pdb.connection).spreadsheetId;
    const gen1BackupId = await manualBackupId(); // SQLite gen1 / active=true / spreadsheet A

    // `manualBackupId()` picks the newest candidate by `createdAt` — advance
    // the clock so gen1's and gen2's backups never tie on that timestamp.
    clock = new Date(clock.getTime() + 60_000);

    await googleConfigService.connect(); // reauthorize as A again → gen2, same spreadsheet A
    expect(readGoogleSettings(pdb.connection).credentialGeneration).toBe(2);
    expect(readGoogleSettings(pdb.connection).spreadsheetId).toBe(spreadsheetA);
    const gen2BackupId = await manualBackupId(); // backup "A2": SQLite gen2 / active=true / spreadsheet A

    // Restoring the older gen1 backup rewinds `backup_records` to before A2's
    // row existed (the already-accepted catalogue-rewind limitation) — the
    // A2 `.sqlite` file itself survives physically. Capture its file identity
    // now, before that rewind, so it can be re-registered afterward.
    const gen2Row = pdb.connection
      .prepare('SELECT * FROM backup_records WHERE id = ?')
      .get(gen2BackupId) as {
      file_name: string;
      storage_path: string;
      source_app_version: string;
      source_schema_version: number;
      size_bytes: number;
      checksum_sha256: string;
    };

    // Restore the OLDER gen1 backup.
    await confirmAndRestore(gen1BackupId);
    expect(readGoogleSettings(pdb.connection).credentialGeneration).toBe(1);
    expect(readGoogleSettings(pdb.connection).restoreReconnectRequired).toBe(true); // Case A: always

    // Explicit Connect Account B. nextGeneration derives from the restored
    // gen1, so B's credential becomes gen2 — overwriting A's gen2 file.
    currentIdentity = { refreshToken: 'refresh-b', sub: 'sub-b', email: 'owner-b@example.com' };
    drive.files.length = 0; // account B's own Drive view starts empty
    await googleConfigService.connect();
    expect(readGoogleSettings(pdb.connection).credentialGeneration).toBe(2);
    const spreadsheetB = readGoogleSettings(pdb.connection).spreadsheetId;
    expect(spreadsheetB).not.toBe(spreadsheetA);

    const callsBefore = networkCalls();

    // Re-register the A2 backup's surviving file under the rewound catalogue
    // (2L-C will later cover this discovery gap generally; not what this
    // test is about) and restore it — SQLite gen2 / active=true / spreadsheet
    // A. The live encrypted file is ALSO gen2, but it is Account B's credential.
    const rediscoveredGen2Id = insertCompletedBackupRecord(pdb.connection, {
      backupType: 'MANUAL',
      locationKind: 'LOCAL_DISK',
      fileName: gen2Row.file_name,
      storagePath: gen2Row.storage_path,
      sourceAppVersion: gen2Row.source_app_version,
      sourceSchemaVersion: gen2Row.source_schema_version,
      targetAppVersion: null,
      sizeBytes: gen2Row.size_bytes,
      checksumSha256: gen2Row.checksum_sha256,
      startedAt: clock.toISOString(),
      completedAt: clock.toISOString(),
    });
    await confirmAndRestore(rediscoveredGen2Id);
    expect(readGoogleSettings(pdb.connection).credentialGeneration).toBe(2);
    expect(readGoogleSettings(pdb.connection).spreadsheetId).toBe(spreadsheetA);

    // Generation numbers are EQUAL (both 2) — proving this is NOT a
    // generation-ahead case. Quarantine must still be true because Case A
    // never trusts generation equality as account identity.
    expect(readGoogleSettings(pdb.connection).restoreReconnectRequired).toBe(true);

    const cfg = await googleConfigService.getConfig();
    expect(cfg.connected).toBe(false);
    expect(cfg.setupState).not.toBe('READY');
    expect(cfg.canOpenSpreadsheet).toBe(false);

    // No Account-B credential may be used with spreadsheet A: zero network,
    // no export context resolves.
    expect(networkCalls()).toBe(callsBefore);
    expect(await googleConfigService.resolveExportContext()).toBeNull();

    // Explicit Connect Google Account is required to resolve it.
    await expect(googleConfigService.retrySetup()).rejects.toMatchObject({
      code: 'GOOGLE_NOT_CONNECTED',
    });
  });
});

describe('I — backup taken while disconnected, then a later account connects ahead', () => {
  it('restoring the disconnected-era backup does not auto-adopt the file-ahead credential', async () => {
    // Google connected at gen1, then disconnected normally.
    await googleConfigService.connect();
    await googleConfigService.disconnect();
    expect(readGoogleSettings(pdb.connection).credentialGeneration).toBe(1);
    expect(readGoogleSettings(pdb.connection).credentialActive).toBe(false);

    // Backup A taken while disconnected.
    const backupId = await manualBackupId();

    // Later, the owner connects Account B: gen2 / active=true.
    currentIdentity = { refreshToken: 'refresh-b', sub: 'sub-b', email: 'owner-b@example.com' };
    await googleConfigService.connect();
    expect(readGoogleSettings(pdb.connection).credentialGeneration).toBe(2);
    expect(readGoogleSettings(pdb.connection).credentialActive).toBe(true);

    const callsBefore = networkCalls();

    // Restore the disconnected-era backup.
    await confirmAndRestore(backupId);

    // Restored SQLite is logically disconnected at gen1 — the file-ahead gen2
    // credential must NOT be auto-adopted, despite matching the exact shape
    // ordinary `reconcileAtStartup` treats as an interrupted Connect.
    expect(readGoogleSettings(pdb.connection).credentialGeneration).toBe(1);
    expect(readGoogleSettings(pdb.connection).credentialActive).toBe(false);
    expect(readGoogleSettings(pdb.connection).restoreReconnectRequired).toBe(true);

    const cfg = await googleConfigService.getConfig();
    expect(cfg.connected).toBe(false);
    expect(cfg.setupState).toBe('DISCONNECTED');
    expect(cfg.canOpenSpreadsheet).toBe(false);
    expect(networkCalls()).toBe(callsBefore);

    // Restart remains safe: quarantine survives, still no adoption.
    pdb.close();
    pdb = await ProductionDatabase.open({
      filename: dbFile,
      backupDir: backupsRoot,
      logger: capture.logger,
      appVersion: 'test',
    });
    googleConfigService = buildGoogleConfigService(pdb.connection);
    await googleConfigService.reconcileAtStartup();
    expect(readGoogleSettings(pdb.connection).credentialGeneration).toBe(1);
    expect(readGoogleSettings(pdb.connection).restoreReconnectRequired).toBe(true);
    expect(networkCalls()).toBe(callsBefore);

    // Explicit Disconnect resolves the quarantine per the existing approved rule.
    const disconnected = await googleConfigService.disconnect();
    expect(readGoogleSettings(pdb.connection).restoreReconnectRequired).toBe(false);
    expect(disconnected.connected).toBe(false);
  });
});

describe('G — disconnect while quarantined', () => {
  it('disconnect clears quarantine and performs no network beyond best-effort cleanup', async () => {
    await googleConfigService.connect();
    const backupId = await manualBackupId();
    currentIdentity = { refreshToken: 'refresh-b', sub: 'sub-b', email: 'owner-b@example.com' };
    drive.files.length = 0; // account B's own Drive view starts empty — never sees A's files
    await googleConfigService.connect();
    await confirmAndRestore(backupId);
    expect(readGoogleSettings(pdb.connection).restoreReconnectRequired).toBe(true);

    const callsBefore = networkCalls();
    const cfg = await googleConfigService.disconnect();

    expect(readGoogleSettings(pdb.connection).restoreReconnectRequired).toBe(false);
    expect(cfg.connected).toBe(false);
    expect(cfg.setupState).toBe('DISCONNECTED');
    expect(networkCalls()).toBe(callsBefore);
  });
});

describe('J — TEST-BACKUP-022: full-table restore fidelity with the Google quarantine exception', () => {
  it('every table matches the backup exactly except the one permitted settings key', async () => {
    // Backup source with an active Google configuration.
    await googleConfigService.connect();
    const backupId = await manualBackupId();
    const expected = snapshotBackupFile(backupId);

    // The external credential state becomes incompatible.
    currentIdentity = { refreshToken: 'refresh-b', sub: 'sub-b', email: 'owner-b@example.com' };
    drive.files.length = 0; // account B's own Drive view starts empty
    await googleConfigService.connect();

    // Restore through the production restore lifecycle.
    await confirmAndRestore(backupId);
    expect(readGoogleSettings(pdb.connection).restoreReconnectRequired).toBe(true); // quarantine applied

    const actual = snapshotTables(pdb.connection);

    // Every table except `settings` matches the backup exactly — no row
    // appended, rewritten, or deleted.
    for (const table of CANONICAL_TABLES) {
      if (table === 'settings') continue;
      expect({ table, rows: actual[table] }).toEqual({ table, rows: expected[table] });
    }

    // `counters` is included in the loop above, but prove the two
    // material sub-values explicitly (Item 5).
    const counterValue = (rows: unknown[], key: string): unknown =>
      (rows as Array<{ key: string; value: unknown }>).find((r) => r.key === key)?.value;
    expect(counterValue(actual['counters']!, 'receipt_number')).toBe(
      counterValue(expected['counters']!, 'receipt_number'),
    );
    expect(counterValue(actual['counters']!, 'audit_sequence')).toBe(
      counterValue(expected['counters']!, 'audit_sequence'),
    );

    // `audit_events` equality, explicit (Item 5): no GOOGLE_CONFIGURATION_CHANGED
    // or any other durable audit event was appended merely for entering quarantine.
    expect(actual['audit_events']).toEqual(expected['audit_events']);
    expect(
      (actual['audit_events'] as Array<{ event_type: string; actor_type: string }>).filter(
        (e) => e.event_type === 'GOOGLE_CONFIGURATION_CHANGED' && e.actor_type === 'SYSTEM',
      ).length,
    ).toBe(
      (expected['audit_events'] as Array<{ event_type: string; actor_type: string }>).filter(
        (e) => e.event_type === 'GOOGLE_CONFIGURATION_CHANGED' && e.actor_type === 'SYSTEM',
      ).length,
    );

    // `settings`: matches exactly except `google_restore_reconnect_required`,
    // which is absent from the backup and `true` in the restored database.
    // No other Google setting (spreadsheet id, generation, credentialActive,
    // enabled/setup state) or non-Google setting may differ.
    const withoutQuarantineKey = (rows: unknown[]): unknown[] =>
      (rows as Array<{ key: string }>).filter((r) => r.key !== 'google_restore_reconnect_required');
    expect(withoutQuarantineKey(actual['settings']!)).toEqual(
      withoutQuarantineKey(expected['settings']!),
    );
    expect(
      (expected['settings'] as Array<{ key: string }>).some(
        (r) => r.key === 'google_restore_reconnect_required',
      ),
    ).toBe(false);
    const quarantineRow = (actual['settings'] as Array<{ key: string; value: string }>).find(
      (r) => r.key === 'google_restore_reconnect_required',
    );
    expect(quarantineRow?.value).toBe('true');

    // The restored Google settings themselves remain exactly what the backup
    // contained — not rewritten to reflect Account B.
    const settingValue = (rows: unknown[], key: string): unknown =>
      (rows as Array<{ key: string; value: unknown }>).find((r) => r.key === key)?.value;
    for (const key of [
      'google_spreadsheet_id',
      'google_credential_generation',
      'google_credential_active',
      'google_sheets_enabled',
    ]) {
      expect(settingValue(actual['settings']!, key)).toBe(settingValue(expected['settings']!, key));
    }
  });
});
