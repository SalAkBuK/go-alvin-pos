import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackupService } from '../../src/main/backup/backupService';
import type { BackupService } from '../../src/main/backup/backupService';
import { applyRetention } from '../../src/main/backup/backupRetention';
import { createRestoreService } from '../../src/main/backup/restoreService';
import type { RestoreService } from '../../src/main/backup/restoreService';
import { insertCompletedBackupRecord } from '../../src/main/backup/backupRecordsRepository';
import { recoverInterruptedRestore } from '../../src/main/app/startupRestoreRecovery';
import { createSaleService } from '../../src/main/checkout/saleService';
import { createVoidService } from '../../src/main/void/voidService';
import { createProductService } from '../../src/main/products/productService';
import { createCustomerService } from '../../src/main/customers/customerService';
import { createInventoryService } from '../../src/main/inventory/inventoryService';
import { createSettingsService } from '../../src/main/settings/settingsService';
import { ProductionDatabase } from '../../src/main/database/database';
import { createMaintenanceCoordinator } from '../../src/main/maintenance/maintenanceCoordinator';
import type { MaintenanceCoordinator } from '../../src/main/maintenance/maintenanceCoordinator';
import { setExclusiveMaintenance } from '../../src/main/maintenance/maintenanceStatus';
import { readRestoreMarker, writeRestoreMarker } from '../../src/main/maintenance/restoreMarker';
import { createCapturingLogger, makeTempDir } from '../helpers/database';
import { buildCashRequest, seedBusiness, seedProduct, seedTaxRate } from '../helpers/checkout';
import type { NewerDataLoss, RestoreOutcome } from '../../src/shared/restore';

/**
 * Phase 2L-B — safe whole-database restore
 * (`REQ-BACKUP-011`; `DATA_MODEL.md §52A`; `POS_WORKFLOWS.md §67`, `§67A`;
 * `TEST-BACKUP-003`, `-004`, `-005`, `-006`, `-014`, `-017`, `-018`, `-019`
 * + the deferred restore adversarial set).
 */

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
 * `ORDER BY` — an unordered scan happened to match in practice here, but that
 * is a query-planner implementation detail, not a guarantee. Each table's own
 * stable primary / business key, from `001_initial_schema.ts`, makes the
 * comparison deterministic regardless of scan order. Every table here has a
 * single-column key; none needs (or got) a fabricated composite ordering.
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
let quiesceCount: number;
let activateCount: number;
let openBehaviour: (call: number) => void;
let openCall: number;

function openPdb(): Promise<ProductionDatabase> {
  openCall += 1;
  openBehaviour(openCall);
  return ProductionDatabase.open({
    filename: dbFile,
    backupDir: backupsRoot,
    logger: capture.logger,
    appVersion: 'test',
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
    quiesceBackgroundWork: async () => {
      quiesceCount += 1;
    },
    openDatabase: openPdb,
    activateDatabase: (db) => {
      pdb = db as ProductionDatabase;
      backupService = buildBackupService();
      activateCount += 1;
    },
  });
}

function commitSale(soldPriceCents = 59900): string {
  const product = seedProduct(pdb.connection, { quantity: 10 });
  const req = buildCashRequest(pdb.connection, [
    { productId: product.id, quantity: 1, soldPriceCents },
  ]);
  return createSaleService({
    db: pdb.connection,
    appVersion: 'test',
    now: () => clock.toISOString(),
  }).completeCashSale(req).saleId;
}

beforeEach(async () => {
  temp = makeTempDir('gpp-restore-');
  userDataDir = temp.path;
  dbFile = join(temp.path, 'gophones.sqlite');
  backupsRoot = join(temp.path, 'backups');
  clock = new Date('2026-09-10T12:00:00.000Z');
  capture = createCapturingLogger();
  quiesceCount = 0;
  activateCount = 0;
  openCall = 0;
  openBehaviour = () => {};
  setExclusiveMaintenance(null);

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

async function manualBackupId(): Promise<string> {
  await backupService.createManual();
  const candidates = await restoreService.listCandidates();
  return candidates[0]!.backupId;
}

/**
 * Policy 1 (2L-B final corrections): every restore needs one explicit
 * confirmation before the swap, whether or not a newer completed sale is
 * detected. Tests that only want the end state (not the confirmation step
 * itself) go through this helper.
 */
async function confirmAndRestore(backupId: string) {
  const first = await restoreService.restore(backupId);
  if (first.outcome !== 'CONFIRMATION_REQUIRED') {
    throw new Error('expected CONFIRMATION_REQUIRED on the first attempt');
  }
  return restoreService.restore(backupId, first.confirmationToken);
}

/** Narrow a `CONFIRMATION_REQUIRED` outcome's stronger-warning (Variant A) loss content. */
function requireLoss(outcome: RestoreOutcome): NewerDataLoss {
  if (outcome.outcome !== 'CONFIRMATION_REQUIRED') {
    throw new Error(`expected CONFIRMATION_REQUIRED, got ${outcome.outcome}`);
  }
  if (!outcome.newerData) {
    throw new Error('expected the stronger newer-sale-loss warning, got the generic confirmation');
  }
  return outcome.newerData;
}

describe('TEST-BACKUP-003 / 004 / 005 / 006 / 017 — full table-set restore', () => {
  it('every canonical table matches the backup exactly after restore', async () => {
    // Representative rows across every §52 table.
    const soldSale = commitSale();
    const voidedSale = commitSale();
    createVoidService({
      db: pdb.connection,
      appVersion: 'test',
      now: () => clock.toISOString(),
    }).voidSale({ saleId: voidedSale, reason: 'customer changed mind' });
    // A FAILED export job to prove queue state survives (TEST-BACKUP-006).
    pdb.connection
      .prepare(
        "UPDATE google_sheet_export_jobs SET status='FAILED', attempt_count=3, last_error='x' WHERE sale_id=?",
      )
      .run(soldSale);
    const receiptCounterBefore = pdb.connection
      .prepare("SELECT value FROM counters WHERE key='receipt_number'")
      .get() as { value: number };

    const backupId = await manualBackupId();
    expect((await restoreService.listCandidates())[0]!.backupId).toBeTruthy();
    const backupFile = join(backupsRoot, 'manual', readdirSync(join(backupsRoot, 'manual'))[0]!);
    const expected = (() => {
      const b = openReadonly(
        join(backupsRoot, 'manual', readdirSync(join(backupsRoot, 'manual'))[0]!),
      );
      try {
        return snapshotTables(b);
      } finally {
        b.close();
      }
    })();

    // A change with no newer sales still requires the generic Policy 1
    // confirmation (2L-B final corrections) — it is no longer a free pass.
    pdb.connection.prepare("UPDATE settings SET value='4242' WHERE key='tax_rate_bps'").run();

    const outcome = await confirmAndRestore(backupId);
    expect(outcome.outcome).toBe('COMPLETED');
    expect(activateCount).toBe(2); // one rebuild for CONFIRMATION_REQUIRED, one for the swap
    expect(quiesceCount).toBe(2); // one quiesce per restore() attempt

    const after = snapshotTables(pdb.connection);
    for (const table of CANONICAL_TABLES) {
      expect({ table, rows: after[table] }).toEqual({ table, rows: expected[table] });
    }

    // Receipt counter preserved (adversarial), voided sale + reversal preserved.
    expect(
      (
        pdb.connection.prepare("SELECT value FROM counters WHERE key='receipt_number'").get() as {
          value: number;
        }
      ).value,
    ).toBe(receiptCounterBefore.value);
    expect(pdb.connection.prepare('SELECT status FROM sales WHERE id=?').get(voidedSale)).toEqual({
      status: 'VOIDED',
    });
    expect(
      (
        pdb.connection
          .prepare("SELECT COUNT(*) c FROM inventory_movements WHERE movement_type='VOID_REVERSAL'")
          .get() as { c: number }
      ).c,
    ).toBeGreaterThan(0);
    expect(
      pdb.connection
        .prepare('SELECT status FROM google_sheet_export_jobs WHERE sale_id=?')
        .get(soldSale),
    ).toEqual({ status: 'FAILED' });
    expect(backupFile).toBeTruthy();
  });
});

describe('TEST-BACKUP-014 — restore maintenance safety', () => {
  it('an active draft cart blocks restore', async () => {
    const backupId = await manualBackupId();
    coordinator.noteDraftCartActivity(true, 1);
    await expect(restoreService.restore(backupId)).rejects.toMatchObject({
      code: 'RESTORE_BLOCKED_CHECKOUT_ACTIVE',
    });
    expect(existsSync(join(backupsRoot, 'pre-restore'))).toBe(false); // nothing destructive happened
  });

  it('an unresolved card request blocks restore with the card-pending code', async () => {
    const backupId = await manualBackupId();
    pdb.connection
      .prepare(
        `INSERT INTO checkout_requests
           (request_id, request_fingerprint, payment_method_snapshot, intended_total_cents, created_at, status)
         VALUES ('cr1', 'fp', 'CARD', 100, ?, 'PENDING_PAYMENT')`,
      )
      .run(clock.toISOString());
    await expect(restoreService.restore(backupId)).rejects.toMatchObject({
      code: 'RESTORE_BLOCKED_CARD_PENDING',
    });
  });

  it('idle restore takes exclusive ownership; a second concurrent restore is refused', async () => {
    const backupId = await manualBackupId();
    quiesceCount = 0;
    let sawExclusive = false;
    const svc = createRestoreService({
      logger: capture.logger,
      databaseFile: dbFile,
      backupsRoot,
      userDataDir,
      targetSchemaVersion: 1,
      coordinator,
      now: () => clock,
      getCurrentDatabase: () => pdb,
      quiesceBackgroundWork: async () => {
        sawExclusive = coordinator.isExclusiveActive();
        // A second restore attempt while the first owns the lock.
        await expect(restoreService.restore(backupId)).rejects.toMatchObject({
          code: 'RESTORE_ALREADY_RUNNING',
        });
      },
      openDatabase: openPdb,
      activateDatabase: (db) => {
        pdb = db as ProductionDatabase;
      },
    });
    pdb.connection.prepare("UPDATE settings SET value='1' WHERE key='tax_rate_bps'").run();
    await svc.restore(backupId);
    expect(sawExclusive).toBe(true);
    expect(coordinator.status()).toBe('SAFE'); // released
  });
});

describe('TEST-BACKUP-018 — newer local data detected', () => {
  it('warns with exact count/date range, keeps a pre-restore copy, and only replaces after confirmation', async () => {
    const backupId = await manualBackupId();

    clock = new Date('2026-09-11T15:00:00.000Z');
    const s1 = commitSale();
    clock = new Date('2026-09-12T16:00:00.000Z');
    const s2 = commitSale();
    const s3 = commitSale();

    // First attempt, no token → CONFIRMATION_REQUIRED with the loss DTO.
    const first = await restoreService.restore(backupId);
    const firstLoss = requireLoss(first);
    if (first.outcome !== 'CONFIRMATION_REQUIRED') return;
    expect(firstLoss.transactionCount).toBe(3);
    expect(firstLoss.earliestCompletedAt.slice(0, 10)).toBe('2026-09-11');
    expect(firstLoss.latestCompletedAt.slice(0, 10)).toBe('2026-09-12');

    // Pre-restore recovery copy preserved regardless of outcome.
    expect(readdirSync(join(backupsRoot, 'pre-restore')).length).toBe(1);
    // Current DB untouched (Cancel path).
    expect((pdb.connection.prepare('SELECT COUNT(*) c FROM sales').get() as { c: number }).c).toBe(
      3,
    );
    expect(
      [s1, s2, s3].every((id) => pdb.connection.prepare('SELECT 1 FROM sales WHERE id=?').get(id)),
    ).toBe(true);

    // A stale token (current DB changed since it was issued) → fresh warning.
    commitSale();
    const stale = await restoreService.restore(backupId, first.confirmationToken);
    const staleLoss = requireLoss(stale);
    if (stale.outcome !== 'CONFIRMATION_REQUIRED') return;
    expect(staleLoss.transactionCount).toBe(4);

    // Explicit confirmation with the fresh token → the older backup becomes authoritative.
    const done = await restoreService.restore(backupId, stale.confirmationToken);
    expect(done.outcome).toBe('COMPLETED');
    expect((pdb.connection.prepare('SELECT COUNT(*) c FROM sales').get() as { c: number }).c).toBe(
      0,
    );
  });
});

describe('confirmation fingerprint (Item 1 adversarial follow-up) — stale after non-sale state changes', () => {
  /**
   * Back-to-back restore attempts where a newer-sale warning fires, a
   * non-sale authoritative mutation happens, then the FIRST token is replayed.
   * The sale-loss count is identical both times — only the whole-database
   * fingerprint changed — so a stale confirmation is detected purely because
   * the old (sales-count/receipt-counter) fingerprint would have missed it.
   */
  async function warnThenReplayFirstToken(mutate: () => void): Promise<{
    first: Extract<
      Awaited<ReturnType<typeof restoreService.restore>>,
      { outcome: 'CONFIRMATION_REQUIRED' }
    >;
    second: Awaited<ReturnType<typeof restoreService.restore>>;
    backupId: string;
  }> {
    const backupId = await manualBackupId();
    commitSale(); // one newer completed sale → the confirmation gate activates
    const first = await restoreService.restore(backupId);
    if (first.outcome !== 'CONFIRMATION_REQUIRED') throw new Error('expected confirmation');
    mutate();
    const second = await restoreService.restore(backupId, first.confirmationToken);
    return { first, second, backupId };
  }

  it('a product edit invalidates an outstanding confirmation token', async () => {
    const product = seedProduct(pdb.connection);
    const { first, second } = await warnThenReplayFirstToken(() => {
      createProductService({ db: pdb.connection, now: () => clock.toISOString() }).update(
        product.id,
        {
          name: 'iPhone 15 128GB (Edited)',
          brand: product.brand,
          model: product.model,
          condition: product.condition,
          sellingPriceCents: product.sellingPriceCents,
          costPriceCents: product.costPriceCents,
          sku: product.sku,
          barcode: product.barcode,
          lowStockThreshold: product.lowStockThreshold,
        },
      );
    });
    expect(second.outcome).toBe('CONFIRMATION_REQUIRED');
    if (second.outcome !== 'CONFIRMATION_REQUIRED') return;
    expect(requireLoss(second).transactionCount).toBe(requireLoss(first).transactionCount);
    expect(second.confirmationToken).not.toBe(first.confirmationToken);
  });

  it('a customer edit invalidates an outstanding confirmation token', async () => {
    const customer = createCustomerService({
      db: pdb.connection,
      now: () => clock.toISOString(),
    }).create({ name: 'Jane Doe', phone: '(281) 555-0100' });
    const { first, second } = await warnThenReplayFirstToken(() => {
      createCustomerService({ db: pdb.connection, now: () => clock.toISOString() }).update(
        customer.id,
        { name: 'Jane Doe (Edited)', phone: customer.phone },
      );
    });
    expect(second.outcome).toBe('CONFIRMATION_REQUIRED');
    if (second.outcome !== 'CONFIRMATION_REQUIRED') return;
    expect(requireLoss(second).transactionCount).toBe(requireLoss(first).transactionCount);
    expect(second.confirmationToken).not.toBe(first.confirmationToken);
  });

  it('a manual inventory adjustment invalidates an outstanding confirmation token', async () => {
    const product = seedProduct(pdb.connection, { quantity: 5 });
    const { first, second } = await warnThenReplayFirstToken(() => {
      createInventoryService({
        db: pdb.connection,
        appVersion: 'test',
        now: () => clock.toISOString(),
      }).adjust({
        productId: product.id,
        mode: 'delta',
        delta: 2,
        reason: 'Physical stock recount',
      });
    });
    expect(second.outcome).toBe('CONFIRMATION_REQUIRED');
    if (second.outcome !== 'CONFIRMATION_REQUIRED') return;
    expect(requireLoss(second).transactionCount).toBe(requireLoss(first).transactionCount);
    expect(second.confirmationToken).not.toBe(first.confirmationToken);
  });

  it('a void invalidates an outstanding confirmation token', async () => {
    const voidableSale = commitSale();
    const { first, second } = await warnThenReplayFirstToken(() => {
      createVoidService({
        db: pdb.connection,
        appVersion: 'test',
        now: () => clock.toISOString(),
      }).voidSale({ saleId: voidableSale, reason: 'customer changed mind' });
    });
    expect(second.outcome).toBe('CONFIRMATION_REQUIRED');
    if (second.outcome !== 'CONFIRMATION_REQUIRED') return;
    expect(second.confirmationToken).not.toBe(first.confirmationToken);
  });

  it('an audited setting change invalidates an outstanding confirmation token', async () => {
    const { first, second } = await warnThenReplayFirstToken(() => {
      createSettingsService({
        db: pdb.connection,
        appVersion: 'test',
        now: () => clock.toISOString(),
      }).updateTaxRate({ taxRateBps: 999 });
    });
    expect(second.outcome).toBe('CONFIRMATION_REQUIRED');
    if (second.outcome !== 'CONFIRMATION_REQUIRED') return;
    expect(requireLoss(second).transactionCount).toBe(requireLoss(first).transactionCount);
    expect(second.confirmationToken).not.toBe(first.confirmationToken);
  });

  it('an unchanged database between two attempts accepts the original token (no false staleness)', async () => {
    const backupId = await manualBackupId();
    commitSale();
    const first = await restoreService.restore(backupId);
    if (first.outcome !== 'CONFIRMATION_REQUIRED') throw new Error('expected confirmation');
    // No mutation at all between the warning and the confirmed retry.
    const done = await restoreService.restore(backupId, first.confirmationToken);
    expect(done.outcome).toBe('COMPLETED');
  });
});

describe('newer-sale detection by Sale ID (Item 2 adversarial follow-up) — clock rollback cannot hide a sale', () => {
  it('a clock moved backward does not hide a sale committed after the backup', async () => {
    clock = new Date('2026-09-10T10:00:00.000Z');
    commitSale(); // sale A, IN the candidate
    const backupId = await manualBackupId();

    clock = new Date('2026-09-10T09:00:00.000Z'); // system clock moved backward
    const saleB = commitSale(); // committed AFTER the backup; NOT in the candidate

    const result = await restoreService.restore(backupId);
    const loss = requireLoss(result);
    expect(loss.transactionCount).toBe(1);
    expect(loss.earliestCompletedAt).toBe('2026-09-10T09:00:00.000Z');
    expect(loss.latestCompletedAt).toBe('2026-09-10T09:00:00.000Z');
    expect(pdb.connection.prepare('SELECT 1 FROM sales WHERE id=?').get(saleB)).toBeDefined();
  });

  it('a sale sharing the exact completed_at of the candidate latest sale is still detected', async () => {
    const sameInstant = '2026-09-10T10:00:00.000Z';
    clock = new Date(sameInstant);
    commitSale(); // sale A, IN the candidate, at sameInstant
    const backupId = await manualBackupId();

    // No clock movement at all — sale B shares sale A's exact completed_at,
    // so `completed_at > MAX(candidate.completed_at)` would find nothing.
    const saleB = commitSale();

    const result = await restoreService.restore(backupId);
    const loss = requireLoss(result);
    expect(loss.transactionCount).toBe(1);
    expect(loss.earliestCompletedAt).toBe(sameInstant);
    expect(loss.latestCompletedAt).toBe(sameInstant);
    expect(pdb.connection.prepare('SELECT 1 FROM sales WHERE id=?').get(saleB)).toBeDefined();
  });

  it('normal monotonic timestamps still give the expected count and range (TEST-BACKUP-018 baseline)', async () => {
    const backupId = await manualBackupId();
    clock = new Date('2026-09-11T15:00:00.000Z');
    commitSale();
    clock = new Date('2026-09-12T16:00:00.000Z');
    commitSale();
    commitSale();

    const result = await restoreService.restore(backupId);
    const loss = requireLoss(result);
    expect(loss.transactionCount).toBe(3);
    expect(loss.earliestCompletedAt.slice(0, 10)).toBe('2026-09-11');
    expect(loss.latestCompletedAt.slice(0, 10)).toBe('2026-09-12');
  });
});

describe('material fingerprint stability across secondary/background churn (2L-B final corrections)', () => {
  /**
   * `startBackgroundWork()` (export worker + backup scheduler + Google
   * reconciliation) restarts unconditionally every time `restoreService`
   * returns `CONFIRMATION_REQUIRED` — a live system can legitimately mutate
   * exactly the tables/settings the material fingerprint deliberately
   * excludes in the gap between a warning and the owner's confirmed retry.
   * None of the following may invalidate the token.
   */
  async function warnThenReplayWithChurn(
    mutate: () => void | Promise<void>,
  ): Promise<RestoreOutcome> {
    const backupId = await manualBackupId();
    const first = await restoreService.restore(backupId);
    if (first.outcome !== 'CONFIRMATION_REQUIRED') throw new Error('expected confirmation');
    await mutate();
    return restoreService.restore(backupId, first.confirmationToken);
  }

  it('Google export-job status/attempt-count churn does not invalidate an outstanding confirmation', async () => {
    const saleId = commitSale();
    const second = await warnThenReplayWithChurn(() => {
      pdb.connection
        .prepare(
          "UPDATE google_sheet_export_jobs SET status='FAILED', attempt_count=5, last_error='x' WHERE sale_id=?",
        )
        .run(saleId);
    });
    expect(second.outcome).toBe('COMPLETED');
  });

  it('stale EXPORTING recovery does not invalidate an outstanding confirmation', async () => {
    const saleId = commitSale();
    const second = await warnThenReplayWithChurn(() => {
      pdb.connection
        .prepare(
          "UPDATE google_sheet_export_jobs SET status='PENDING', attempt_count=attempt_count+1 WHERE sale_id=?",
        )
        .run(saleId);
    });
    expect(second.outcome).toBe('COMPLETED');
  });

  it('Google connectivity/auth-health/provisioning settings churn does not invalidate an outstanding confirmation', async () => {
    const second = await warnThenReplayWithChurn(() => {
      const at = clock.toISOString();
      const upsert = pdb.connection.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (@key, @value, @at)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      );
      upsert.run({ key: 'google_credential_generation', value: '7', at });
      upsert.run({ key: 'google_credential_active', value: 'true', at });
      upsert.run({ key: 'google_auth_failure_generation', value: '7', at });
      upsert.run({ key: 'google_provisioning_create_attempted', value: 'true', at });
    });
    expect(second.outcome).toBe('COMPLETED');
  });

  it('a due automatic backup firing between the warning and the retry does not invalidate the token', async () => {
    const second = await warnThenReplayWithChurn(async () => {
      const result = await backupService.runAutomaticIfDue();
      expect(result.ran).toBe(true); // a new backup_records COMPLETED row now exists
    });
    expect(second.outcome).toBe('COMPLETED');
  });

  it('a BACKUP_* audit event added between the warning and the retry does not invalidate the token', async () => {
    const second = await warnThenReplayWithChurn(async () => {
      await backupService.createManual(); // a second manual backup — its own backup_records + BACKUP_COMPLETED audit row
    });
    expect(second.outcome).toBe('COMPLETED');
  });
});

describe('generic whole-database restore confirmation (Policy 1, 2L-B final corrections)', () => {
  it('A — a void-only change still requires confirmation, with zero new completed Sale IDs', async () => {
    const saleId = commitSale();
    const backupId = await manualBackupId(); // the sale IS in the candidate, as COMPLETED
    createVoidService({
      db: pdb.connection,
      appVersion: 'test',
      now: () => clock.toISOString(),
    }).voidSale({ saleId, reason: 'customer changed mind' });

    const result = await restoreService.restore(backupId);
    expect(result.outcome).toBe('CONFIRMATION_REQUIRED');
    if (result.outcome !== 'CONFIRMATION_REQUIRED') return;
    expect(result.newerData).toBeNull(); // no newer COMPLETED sale — the generic warning, not Variant A
  });

  it('B — an inventory-adjustment-only change still requires confirmation', async () => {
    const backupId = await manualBackupId();
    const product = seedProduct(pdb.connection, { quantity: 5 });
    createInventoryService({
      db: pdb.connection,
      appVersion: 'test',
      now: () => clock.toISOString(),
    }).adjust({ productId: product.id, mode: 'delta', delta: 2, reason: 'Physical stock recount' });

    const result = await restoreService.restore(backupId);
    expect(result.outcome).toBe('CONFIRMATION_REQUIRED');
    if (result.outcome !== 'CONFIRMATION_REQUIRED') return;
    expect(result.newerData).toBeNull();
  });

  it('C — a product/customer-edit-only change still requires confirmation', async () => {
    const backupId = await manualBackupId();
    const customer = createCustomerService({
      db: pdb.connection,
      now: () => clock.toISOString(),
    }).create({ name: 'Jane Doe', phone: '(281) 555-0100' });
    createCustomerService({ db: pdb.connection, now: () => clock.toISOString() }).update(
      customer.id,
      { name: 'Jane Doe (Edited)', phone: customer.phone },
    );

    const result = await restoreService.restore(backupId);
    expect(result.outcome).toBe('CONFIRMATION_REQUIRED');
    if (result.outcome !== 'CONFIRMATION_REQUIRED') return;
    expect(result.newerData).toBeNull();
  });

  it('D — a tax/business-setting-change-only change still requires confirmation', async () => {
    const backupId = await manualBackupId();
    createSettingsService({
      db: pdb.connection,
      appVersion: 'test',
      now: () => clock.toISOString(),
    }).updateTaxRate({ taxRateBps: 999 });

    const result = await restoreService.restore(backupId);
    expect(result.outcome).toBe('CONFIRMATION_REQUIRED');
    if (result.outcome !== 'CONFIRMATION_REQUIRED') return;
    expect(result.newerData).toBeNull();
  });

  it('E — no material change at all still returns the generic confirmation on the first request', async () => {
    const backupId = await manualBackupId();
    const result = await restoreService.restore(backupId);
    expect(result.outcome).toBe('CONFIRMATION_REQUIRED');
    if (result.outcome !== 'CONFIRMATION_REQUIRED') return;
    expect(result.newerData).toBeNull();
  });

  it('F — a valid generic token with unchanged material state restores successfully on the second request', async () => {
    const backupId = await manualBackupId();
    const first = await restoreService.restore(backupId);
    if (first.outcome !== 'CONFIRMATION_REQUIRED') throw new Error('expected confirmation');
    const second = await restoreService.restore(backupId, first.confirmationToken);
    expect(second.outcome).toBe('COMPLETED');
  });

  it('G — a material state change before the second request makes the generic token stale', async () => {
    const backupId = await manualBackupId();
    const first = await restoreService.restore(backupId);
    if (first.outcome !== 'CONFIRMATION_REQUIRED') throw new Error('expected confirmation');
    createSettingsService({
      db: pdb.connection,
      appVersion: 'test',
      now: () => clock.toISOString(),
    }).updateTaxRate({ taxRateBps: 111 });

    const second = await restoreService.restore(backupId, first.confirmationToken);
    expect(second.outcome).toBe('CONFIRMATION_REQUIRED');
    if (second.outcome !== 'CONFIRMATION_REQUIRED') return;
    expect(second.confirmationToken).not.toBe(first.confirmationToken);
  });

  it('H — only Google/backup secondary-state changes between requests leave the generic token valid', async () => {
    const backupId = await manualBackupId();
    const first = await restoreService.restore(backupId);
    if (first.outcome !== 'CONFIRMATION_REQUIRED') throw new Error('expected confirmation');
    pdb.connection
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('google_credential_generation', '3', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(clock.toISOString());
    await backupService.runAutomaticIfDue();

    const second = await restoreService.restore(backupId, first.confirmationToken);
    expect(second.outcome).toBe('COMPLETED');
  });
});

describe('TEST-BACKUP-019 — restored-database validation failure rolls back', () => {
  it('puts the pre-restore recovery copy back and reports a stable code', async () => {
    const beforeSale = commitSale();
    const backupId = await manualBackupId();
    pdb.connection.prepare("UPDATE settings SET value='7' WHERE key='tax_rate_bps'").run();
    const preSwapState = snapshotTables(pdb.connection);

    // Fail the *restored* open. `openPdb` is only the restore hook: call 1 =
    // restored open, call 2 = recovery open.
    openBehaviour = (call) => {
      if (call === 1) {
        throw new Error('simulated restored-database open failure');
      }
    };

    // First attempt: the generic Policy 1 confirmation (no newer sale).
    const first = await restoreService.restore(backupId);
    if (first.outcome !== 'CONFIRMATION_REQUIRED') throw new Error('expected confirmation');
    await expect(restoreService.restore(backupId, first.confirmationToken)).rejects.toMatchObject({
      code: 'RESTORE_VALIDATION_FAILED',
    });

    // Back on the ORIGINAL data, marker cleared, coordinator released, checkout usable.
    expect(readRestoreMarker(userDataDir)).toEqual({ present: false });
    expect(coordinator.status()).toBe('SAFE');
    expect(snapshotTables(pdb.connection)).toEqual(preSwapState);
    expect(pdb.connection.prepare('SELECT 1 FROM sales WHERE id=?').get(beforeSale)).toBeDefined();
    expect(() => commitSale()).not.toThrow();
  });
});

describe('restore candidate safety (adversarial)', () => {
  it('rejects a corrupted / truncated candidate before any replacement', async () => {
    const backupId = await manualBackupId();
    const file = join(backupsRoot, 'manual', readdirSync(join(backupsRoot, 'manual'))[0]!);
    truncateSync(file, 32);
    const stateBefore = snapshotTables(pdb.connection);
    await expect(restoreService.restore(backupId)).rejects.toMatchObject({
      code: 'RESTORE_CANDIDATE_INVALID',
    });
    expect(snapshotTables(pdb.connection)).toEqual(stateBefore);
  });

  it('rejects an unknown backupId and a row that points outside the managed area', async () => {
    await expect(restoreService.restore('does-not-exist')).rejects.toMatchObject({
      code: 'RESTORE_CANDIDATE_NOT_FOUND',
    });
    insertCompletedBackupRecord(pdb.connection, {
      backupType: 'MANUAL',
      locationKind: 'LOCAL_DISK',
      fileName: 'evil.sqlite',
      storagePath: join(temp.path, 'outside'),
      sourceAppVersion: 'test',
      sourceSchemaVersion: 1,
      targetAppVersion: null,
      sizeBytes: 10,
      checksumSha256: 'a'.repeat(64),
      startedAt: clock.toISOString(),
      completedAt: clock.toISOString(),
    });
    const evilId = pdb.connection
      .prepare("SELECT id FROM backup_records WHERE file_name='evil.sqlite'")
      .get() as { id: string };
    expect((await restoreService.listCandidates()).some((c) => c.backupId === evilId.id)).toBe(
      false,
    );
    await expect(restoreService.restore(evilId.id)).rejects.toMatchObject({
      code: 'RESTORE_CANDIDATE_NOT_FOUND',
    });
  });

  it('rejects a candidate whose schema is not the exact target version', async () => {
    // Build a real, self-consistent SQLite file that is NOT schema v1, then
    // register a coherent backup_records row (matching checksum) for it.
    const dir = join(backupsRoot, 'manual');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    const fakePath = join(dir, 'gophones-manual-v9-2026-09-10T00-00-00-000Z-deadbeef.sqlite');
    const fake = new Database(fakePath);
    fake.exec(
      'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, checksum TEXT, applied_at TEXT);' +
        "INSERT INTO schema_migrations VALUES (1,'a','b','c'),(2,'a','b','c');",
    );
    fake.close();
    const checksum = createHash('sha256').update(readFileSync(fakePath)).digest('hex');
    insertCompletedBackupRecord(pdb.connection, {
      backupType: 'MANUAL',
      locationKind: 'LOCAL_DISK',
      fileName: 'gophones-manual-v9-2026-09-10T00-00-00-000Z-deadbeef.sqlite',
      storagePath: dir,
      sourceAppVersion: 'future',
      sourceSchemaVersion: 2,
      targetAppVersion: null,
      sizeBytes: readFileSync(fakePath).length,
      checksumSha256: checksum,
      startedAt: clock.toISOString(),
      completedAt: clock.toISOString(),
    });
    const id = (
      pdb.connection
        .prepare('SELECT id FROM backup_records WHERE source_schema_version=2')
        .get() as {
        id: string;
      }
    ).id;
    await expect(restoreService.restore(id)).rejects.toMatchObject({
      code: 'RESTORE_SCHEMA_INCOMPATIBLE',
    });
  });
});

describe('service reinitialisation + lifecycle (adversarial)', () => {
  it('after restore the old connection is closed and services run on a fresh handle', async () => {
    const backupId = await manualBackupId();
    pdb.connection.prepare("UPDATE settings SET value='3' WHERE key='tax_rate_bps'").run();
    const oldConnection = pdb.connection;

    await confirmAndRestore(backupId);

    expect(oldConnection.open).toBe(false);
    expect(pdb.connection).not.toBe(oldConnection);
    // The rebuilt backup service works on the new connection.
    expect(backupService.status().protection).toBe('LOCAL_DISK_ONLY');
  });

  it('a restart (fresh ProductionDatabase.open) opens the restored database', async () => {
    const backupId = await manualBackupId();
    pdb.connection.prepare("UPDATE settings SET value='55' WHERE key='tax_rate_bps'").run();
    await confirmAndRestore(backupId);
    pdb.close();

    const restarted = await ProductionDatabase.open({
      filename: dbFile,
      backupDir: backupsRoot,
      logger: capture.logger,
      appVersion: 'test',
    });
    try {
      expect(
        restarted.connection.prepare("SELECT value FROM settings WHERE key='tax_rate_bps'").get(),
      ).toEqual({ value: '825' }); // the seeded value from the backup, not '55'
    } finally {
      restarted.close();
      pdb = restarted;
    }
  });

  it('a backup scheduler cannot start a backup while a restore owns the lifecycle', async () => {
    const claim = coordinator.tryAcquireExclusive('RESTORE');
    expect(claim.ok).toBe(true);
    const result = await backupService.runAutomaticIfDue();
    expect(result.ran).toBe(false);
    await expect(backupService.createManual()).rejects.toBeTruthy();
    if (claim.ok) claim.release();
  });
});

describe('backup-catalogue rewind / orphan cleanup (Item 17)', () => {
  it('restoring an older backup does not let retention delete a newer legitimate backup file', async () => {
    const backupIdA = await manualBackupId();
    clock = new Date('2026-09-13T09:00:00.000Z');
    commitSale();
    await backupService.createManual(); // backup B — newer file
    const filesBefore = readdirSync(join(backupsRoot, 'manual')).filter((f) =>
      f.endsWith('.sqlite'),
    );
    expect(filesBefore.length).toBe(2);

    const inspect = await restoreService.inspect(backupIdA);
    expect(inspect.newerData?.transactionCount).toBe(1);
    const req1 = await restoreService.restore(backupIdA);
    if (req1.outcome !== 'CONFIRMATION_REQUIRED') throw new Error('expected confirmation');
    const done = await restoreService.restore(backupIdA, req1.confirmationToken);
    expect(done.outcome).toBe('COMPLETED');

    // The restored catalogue no longer lists backup B, but its file must survive.
    applyRetention(
      pdb.connection,
      backupsRoot,
      new Date('2026-09-13T12:00:00.000Z'),
      capture.logger,
    );
    const filesAfter = readdirSync(join(backupsRoot, 'manual')).filter((f) =>
      f.endsWith('.sqlite'),
    );
    expect(filesAfter.sort()).toEqual(filesBefore.sort());
    expect(
      capture.records.some((r) => r.event === 'backup.retention.unreferenced-backup-preserved'),
    ).toBe(true);

    // The orphaned file must still be a real, restorable candidate through the
    // ACTUAL unified discovery path (RestoreService.listCandidates(), not a
    // mocked substitute) — the whole point of preserving it. Discovery must
    // not recreate the `backup_records` row it lost, and the opaque id it
    // assigns must be stable across a second, independent discovery pass.
    const rowCountBeforeDiscovery = (
      pdb.connection.prepare('SELECT COUNT(*) AS c FROM backup_records').get() as { c: number }
    ).c;

    const candidatesAfterRewind = await restoreService.listCandidates();
    const rediscovered = candidatesAfterRewind.find((c) => c.backupId !== backupIdA);
    expect(rediscovered).toBeDefined();
    expect(rediscovered).toMatchObject({
      backupType: 'MANUAL',
      locationKind: 'LOCAL_DISK',
      sourceKind: 'MANAGED',
      catalogued: false, // its own backup_records row was rewound away
    });

    expect(
      (pdb.connection.prepare('SELECT COUNT(*) AS c FROM backup_records').get() as { c: number }).c,
    ).toBe(rowCountBeforeDiscovery); // discovery inserted nothing

    const candidatesAfterRewindAgain = await restoreService.listCandidates();
    const rediscoveredAgain = candidatesAfterRewindAgain.find((c) => c.backupId !== backupIdA);
    expect(rediscoveredAgain?.backupId).toBe(rediscovered!.backupId); // stable identity, not re-derived per call
  });
});

describe('crash-consistent interrupted-restore recovery (Item 13)', () => {
  it('startup restores the pre-restore copy when a marker is present after a swap', async () => {
    // Make a verified pre-restore copy the way restore would.
    const preDir = join(backupsRoot, 'pre-restore');
    const preName = 'gophones-pre-restore-v1-2026-09-10T12-00-00-000Z-abcd1234.sqlite';
    const knownSale = commitSale();
    pdb.close();
    // Snapshot the current file as the "pre-restore copy".
    const { mkdirSync } = await import('node:fs');
    mkdirSync(preDir, { recursive: true });
    copyFileSync(dbFile, join(preDir, preName));

    // Simulate a died-mid-swap state: dbFile is now garbage + a marker exists.
    writeFileSync(dbFile, 'not a database at all');
    writeRestoreMarker(userDataDir, {
      version: 1,
      preRestoreFileName: preName,
      startedAt: clock.toISOString(),
    });

    const result = recoverInterruptedRestore({
      userDataDir,
      backupsRoot,
      databaseFile: dbFile,
      targetSchemaVersion: 1,
      logger: capture.logger,
    });
    expect(result.kind).toBe('recovered');
    expect(readRestoreMarker(userDataDir)).toEqual({ present: false });

    pdb = await ProductionDatabase.open({
      filename: dbFile,
      backupDir: backupsRoot,
      logger: capture.logger,
      appVersion: 'test',
    });
    expect(pdb.connection.prepare('SELECT 1 FROM sales WHERE id=?').get(knownSale)).toBeDefined();
  });

  it('startup stops safely when the marker is corrupt', async () => {
    writeFileSync(join(userDataDir, 'restore-in-progress.json'), '{ broken');
    const result = recoverInterruptedRestore({
      userDataDir,
      backupsRoot,
      databaseFile: dbFile,
      targetSchemaVersion: 1,
      logger: capture.logger,
    });
    expect(result).toEqual({ kind: 'failed', failureCode: 'RESTORE_RECOVERY_FAILED' });
  });
});

describe('WAL/SHM hygiene (adversarial)', () => {
  it('a stale -wal/-shm from the previous generation is not carried into the restored DB', async () => {
    const backupId = await manualBackupId();
    pdb.connection.prepare("UPDATE settings SET value='2' WHERE key='tax_rate_bps'").run();
    await confirmAndRestore(backupId);
    // The restored open goes through openConfiguredConnection → fresh WAL; any
    // previous-generation -wal/-shm were removed during the swap.
    pdb.close();
    expect(existsSync(`${dbFile}-wal`)).toBe(false);
    expect(existsSync(`${dbFile}-shm`)).toBe(false);
    expect(existsSync(`${dbFile}.pre-restore-old`)).toBe(false);
    pdb = await ProductionDatabase.open({
      filename: dbFile,
      backupDir: backupsRoot,
      logger: capture.logger,
      appVersion: 'test',
    });
  });
});
