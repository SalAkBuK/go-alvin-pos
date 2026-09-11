import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSaleService } from '../../src/main/checkout/saleService';
import { createBackupService } from '../../src/main/backup/backupService';
import type { BackupService } from '../../src/main/backup/backupService';
import {
  insertCompletedBackupRecord,
  listBackupRecords,
} from '../../src/main/backup/backupRecordsRepository';
import { applyRetention } from '../../src/main/backup/backupRetention';
import { createMigratedDb, createCapturingLogger, makeTempDir } from '../helpers/database';
import {
  buildCashRequest,
  countRows,
  seedBusiness,
  seedProduct,
  seedTaxRate,
  T0,
} from '../helpers/checkout';

/**
 * Phase 2L — Backup creation, verification, scheduling, retention, health
 * (`REQ-BACKUP-001`, `-002`, `-005`, `-006`, `-007`, `-009`;
 * `DATA_MODEL.md §36B`, `§52`, `§54`; `POS_WORKFLOWS.md §65`, `§66`;
 * `TEST-BACKUP-001`, `-002`, `-002A`, `-006`, `-007`, `-008`, `-009`, `-010`,
 * `-011`, `-015`, `-016` + adversarial 1, 3, 4, 5, 6, 7, 16-21, 24).
 *
 * Whole-database restore and its maintenance coordinator are a later slice and
 * are not exercised here.
 */

let db: Database.Database;
let temp: ReturnType<typeof makeTempDir>;
let backupsRoot: string;
let clock: Date;
let capture: ReturnType<typeof createCapturingLogger>;

function service(): BackupService {
  return createBackupService({
    db,
    backupsRoot,
    appVersion: '0.1.0-test',
    logger: capture.logger,
    now: () => clock,
  });
}

function commitSale(soldPriceCents = 59900): string {
  const product = seedProduct(db, { quantity: 10 }, T0);
  const req = buildCashRequest(db, [{ productId: product.id, quantity: 1, soldPriceCents }]);
  const result = createSaleService({
    db,
    appVersion: 'test',
    now: () => clock.toISOString(),
  }).completeCashSale(req);
  return result.saleId;
}

/** Bulk filler so a backup spans several online-backup transfer steps. */
function padDatabase(rows: number): void {
  const insert = db.prepare(
    `INSERT INTO products (id, name, brand, model, condition, selling_price_cents, quantity_on_hand, created_at, updated_at)
     VALUES (?, ?, 'Filler', 'F', 'NEW', 100, 0, ?, ?)`,
  );
  db.transaction(() => {
    for (let i = 0; i < rows; i += 1) {
      insert.run(`PAD-${i}`, `Filler product ${i} ${'x'.repeat(80)}`, T0, T0);
    }
  })();
}

function openBackup(name: string, dir = join(backupsRoot, 'manual')): Database.Database {
  return new Database(join(dir, name), { readonly: true, fileMustExist: true });
}

beforeEach(async () => {
  temp = makeTempDir('gpp-backup-');
  backupsRoot = join(temp.path, 'backups');
  db = await createMigratedDb(join(temp.path, 'gophones.sqlite'));
  seedTaxRate(db);
  seedBusiness(db);
  clock = new Date('2026-09-10T09:00:00.000Z');
  capture = createCapturingLogger();
});

afterEach(() => {
  db.close();
  temp.cleanup();
  vi.restoreAllMocks();
});

describe('TEST-BACKUP-001 / adversarial 1, 24 — create a manual backup', () => {
  it('creates a verified snapshot file and a COMPLETED record with a correct checksum', async () => {
    const saleId = commitSale(); // committed immediately BEFORE the backup starts

    const result = await service().createManual();

    expect(result.status).toBe('COMPLETED');
    expect(result.locationKind).toBe('LOCAL_DISK');
    const filePath = join(backupsRoot, 'manual', result.fileName);
    expect(existsSync(filePath)).toBe(true);

    // adversarial 24 — recorded checksum is the deterministic SHA-256 of the artifact
    const onDiskChecksum = createHash('sha256').update(readFileSync(filePath)).digest('hex');
    const row = listBackupRecords(db)[0]!;
    expect(row.status).toBe('COMPLETED');
    expect(row.backupType).toBe('MANUAL');
    expect(row.checksumSha256).toBe(onDiskChecksum);
    expect(row.sizeBytes).toBe(result.sizeBytes);
    expect(row.sourceAppVersion).toBe('0.1.0-test');
    expect(row.sourceSchemaVersion).toBe(1);
    expect(row.completedAt).not.toBeNull();

    // adversarial 1 — the sale committed just before the backup is inside it
    const backup = openBackup(result.fileName);
    try {
      expect(backup.prepare('SELECT COUNT(*) c FROM sales WHERE id = ?').get(saleId)).toEqual({
        c: 1,
      });
    } finally {
      backup.close();
    }

    // durable BACKUP_COMPLETED audit evidence (§36B)
    const audit = db
      .prepare("SELECT * FROM audit_events WHERE event_type = 'BACKUP_COMPLETED'")
      .all() as Array<Record<string, unknown>>;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_type).toBe('USER');
    expect(audit[0]!.outcome).toBe('SUCCESS');
  });
});

describe('TEST-BACKUP-002 / 002A — backup while the database is active + concurrent commit', () => {
  it('uses the SQLite Online Backup API (never a raw file copy) and produces a consistent snapshot', async () => {
    const backupSpy = vi.spyOn(Database.prototype, 'backup');
    padDatabase(4000); // several MB → the snapshot spans multiple transfer steps
    commitSale();

    // Kick the backup off and commit more sales between its transfer steps.
    const pending = service().createManual();
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      commitSale(50000 + i);
    }
    const result = await pending;

    // Mechanism: better-sqlite3's Database.prototype.backup(dest) — the online
    // backup API — was called; no fs.copyFile of the live .sqlite.
    expect(backupSpy).toHaveBeenCalled();
    expect(backupSpy.mock.calls[0]![0]).toContain(join(backupsRoot, 'manual'));

    // Operational DB unaffected.
    expect(String(db.pragma('quick_check', { simple: true })).toLowerCase()).toBe('ok');

    // The backup is internally consistent — every sale it contains has its
    // matching items + payment (never a torn half-written sale).
    const backup = openBackup(result.fileName);
    try {
      expect(String(backup.pragma('quick_check', { simple: true })).toLowerCase()).toBe('ok');
      expect((backup.pragma('foreign_key_check') as unknown[]).length).toBe(0);
      const sales = backup.prepare('SELECT id, total_cents FROM sales').all() as Array<{
        id: string;
        total_cents: number;
      }>;
      for (const s of sales) {
        const items = backup
          .prepare('SELECT COUNT(*) c FROM sale_items WHERE sale_id = ?')
          .get(s.id) as { c: number };
        const payment = backup
          .prepare('SELECT amount_cents FROM payments WHERE sale_id = ?')
          .get(s.id) as { amount_cents: number } | undefined;
        expect(items.c).toBeGreaterThan(0);
        expect(payment?.amount_cents).toBe(s.total_cents);
      }
    } finally {
      backup.close();
    }
  });
});

describe('TEST-BACKUP-006 / 016 / adversarial 16-19 — Google state is inside the SQLite backup, Google is never a backup', () => {
  it('preserves the export queue in the backup and needs no Google connectivity', async () => {
    commitSale(); // completing a sale enqueues a google_sheet_export_jobs row

    const result = await service().createManual();

    const backup = openBackup(result.fileName);
    try {
      expect(countRows(backup, 'google_sheet_export_jobs')).toBeGreaterThan(0);
    } finally {
      backup.close();
    }

    // The backup is a single .sqlite file; the OAuth token store lives outside
    // SQLite and no `secrets` directory is created by a backup (adversarial 17, 18).
    const files = readdirSync(join(backupsRoot, 'manual'));
    expect(files).toHaveLength(1);
    expect(existsSync(join(temp.path, 'secrets'))).toBe(false);
  });
});

describe('TEST-BACKUP-007 / adversarial 3 — invalid destination', () => {
  it('reports a typed failure, records a FAILED row + audit, never a COMPLETED row, and sales keep working', async () => {
    // Put a *file* where the backups root should be a directory → mkdir fails.
    mkdirSync(temp.path, { recursive: true });
    writeFileSync(join(temp.path, 'blocked'), 'x');
    backupsRoot = join(temp.path, 'blocked', 'backups');

    await expect(service().createManual()).rejects.toMatchObject({ code: 'BACKUP_FAILED' });

    const rows = listBackupRecords(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('FAILED');
    expect(rows[0]!.errorCode).toBe('BACKUP_WRITE_FAILED');
    expect(rows[0]!.fileName).toBeNull();
    expect(rows.some((r) => r.status === 'COMPLETED')).toBe(false);

    const failAudit = db
      .prepare("SELECT * FROM audit_events WHERE event_type = 'BACKUP_FAILED'")
      .all();
    expect(failAudit).toHaveLength(1);

    // The healthy local database still works for sales.
    expect(() => commitSale()).not.toThrow();
  });
});

describe('TEST-BACKUP-009 — automatic backup failure: health + audit + sanitized diagnostic, sales still work', () => {
  it('surfaces the failure in every facility without leaking a path or a raw exception string', async () => {
    // A realistic OS failure whose message carries an absolute path.
    vi.spyOn(Database.prototype, 'backup').mockRejectedValueOnce(
      Object.assign(
        new Error(
          "ENOSPC: no space left on device, write 'C:\\Users\\owner\\AppData\\Local\\GoPhonesPOS\\backups\\automatic\\x.sqlite'",
        ),
        { code: 'ENOSPC' },
      ),
    );

    const result = await service().runAutomaticIfDue();
    expect(result).toEqual({ ran: true, ok: false });

    // 1. Backup health shows the failure.
    const health = service().status();
    expect(health.lastAutomatic).toMatchObject({
      outcome: 'FAILED',
      errorCode: 'BACKUP_WRITE_FAILED',
    });

    // 2. Durable failure audit event (actor SYSTEM for automatic).
    const audit = db
      .prepare("SELECT * FROM audit_events WHERE event_type = 'BACKUP_FAILED'")
      .all() as Array<Record<string, unknown>>;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_type).toBe('SYSTEM');
    expect(audit[0]!.reason).toBe('BACKUP_WRITE_FAILED');

    // 3. FAILED backup_records row.
    const rows = listBackupRecords(db);
    expect(rows[0]!.status).toBe('FAILED');
    expect(rows[0]!.errorCode).toBe('BACKUP_WRITE_FAILED');

    // 4. Exactly one sanitized structured diagnostic event.
    const diag = capture.records.filter((r) => r.event === 'backup.failed');
    expect(diag).toHaveLength(1);
    expect(diag[0]!.level).toBe('error');
    expect(diag[0]!.category).toBe('backup');
    expect(diag[0]!.fields).toEqual({
      backupType: 'AUTOMATIC',
      stage: 'snapshot',
      errorCode: 'BACKUP_WRITE_FAILED',
      osErrorCode: 'ENOSPC',
    });

    // No path or raw message anywhere in the captured diagnostic records.
    const serialized = JSON.stringify(capture.records);
    expect(serialized).not.toMatch(/C:\\|AppData|no space left|\.sqlite'/i);

    // 5. Sales still work.
    expect(() => commitSale()).not.toThrow();
  });
});

describe('adversarial (shutdown race) — a late failure after a verified artifact is handled cleanly', () => {
  it('never rejects, never records COMPLETED for the artifact, releases the mutex, and recovers', async () => {
    // Simulate the DB going away between the verified snapshot and its
    // backup_records + audit write: block only the COMPLETED insert.
    db.exec(
      'CREATE TEMP TRIGGER trg_block_completed BEFORE INSERT ON backup_records ' +
        "WHEN NEW.status = 'COMPLETED' BEGIN SELECT RAISE(ABORT, 'simulated shutdown race'); END;",
    );

    const svc = service();

    // runAutomaticIfDue must NOT throw (documented "never throws").
    await expect(svc.runAutomaticIfDue()).resolves.toEqual({ ran: true, ok: false });
    expect(svc.busy).toBe(false);

    // createManual surfaces a typed BACKUP_FAILED, not a generic INTERNAL error.
    await expect(svc.createManual()).rejects.toMatchObject({ code: 'BACKUP_FAILED' });

    // No COMPLETED row; the unrecorded artifacts were removed; FAILED evidence exists.
    expect(listBackupRecords(db).some((r) => r.status === 'COMPLETED')).toBe(false);
    expect(listBackupRecords(db).some((r) => r.errorCode === 'BACKUP_PERSIST_FAILED')).toBe(true);
    expect(readdirSync(join(backupsRoot, 'automatic'))).toHaveLength(0);
    expect(readdirSync(join(backupsRoot, 'manual'))).toHaveLength(0);

    // The mutex recovered — a normal backup works once the block is gone.
    db.exec('DROP TRIGGER trg_block_completed');
    const ok = await svc.createManual();
    expect(ok.status).toBe('COMPLETED');
    expect(svc.busy).toBe(false);
  });
});

describe('adversarial 4, 12 — a backup that fails verification is never usable', () => {
  it('deletes the artifact and records FAILED when the snapshot is not a Go Phones POS database', async () => {
    // A *valid* SQLite file that is not a Go Phones POS database.
    vi.spyOn(Database.prototype, 'backup').mockImplementation(async (dest: string) => {
      const bogus = new Database(dest);
      bogus.exec('CREATE TABLE not_ours (x)');
      bogus.close();
      return { totalPages: 1, remainingPages: 0 };
    });

    await expect(service().createManual()).rejects.toMatchObject({ code: 'BACKUP_FAILED' });

    expect(readdirSync(join(backupsRoot, 'manual'))).toHaveLength(0);
    const rows = listBackupRecords(db);
    expect(rows[0]!.status).toBe('FAILED');
    expect(rows[0]!.errorCode).toBe('BACKUP_NOT_GO_PHONES_SCHEMA');
    expect(rows.some((r) => r.status === 'COMPLETED')).toBe(false);
  });
});

describe('adversarial 5, 21 — no overlapping backups; rapid consecutive backups do not collide', () => {
  it('rejects a second concurrent backup with BACKUP_IN_PROGRESS', async () => {
    const svc = service();
    const first = svc.createManual();
    const second = svc.createManual();
    const [a, b] = await Promise.allSettled([first, second]);
    const outcomes = [a.status, b.status].sort();
    expect(outcomes).toEqual(['fulfilled', 'rejected']);
    const rejected = (a.status === 'rejected' ? a.reason : (b as PromiseRejectedResult).reason) as {
      code: string;
    };
    expect(rejected.code).toBe('BACKUP_IN_PROGRESS');
    expect(listBackupRecords(db).filter((r) => r.status === 'COMPLETED')).toHaveLength(1);
  });

  it('gives three sequential manual backups three distinct files', async () => {
    const svc = service();
    const names = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      clock = new Date(clock.getTime() + 1000);
      names.add((await svc.createManual()).fileName);
    }
    expect(names.size).toBe(3);
    expect(readdirSync(join(backupsRoot, 'manual'))).toHaveLength(3);
    expect(listBackupRecords(db).filter((r) => r.status === 'COMPLETED')).toHaveLength(3);
  });
});

describe('TEST-BACKUP-008 / adversarial 6, 7 — recurring automatic backup', () => {
  it('runs one automatic backup when due, updates health, and does not repeat the same day', async () => {
    const svc = service();

    const first = await svc.runAutomaticIfDue();
    expect(first).toEqual({ ran: true, ok: true });

    const autoRows = listBackupRecords(db).filter((r) => r.backupType === 'AUTOMATIC');
    expect(autoRows).toHaveLength(1);
    expect(autoRows[0]!.status).toBe('COMPLETED');
    expect(existsSync(join(backupsRoot, 'automatic', autoRows[0]!.fileName!))).toBe(true);

    const health = svc.status();
    expect(health.lastAutomatic).toMatchObject({ outcome: 'COMPLETED' });
    expect(health.lastSuccessfulAutomaticAt).toBe(autoRows[0]!.completedAt);
    expect(health.overdue).toBe(false);

    const sysAudit = db
      .prepare(
        "SELECT * FROM audit_events WHERE event_type = 'BACKUP_COMPLETED' AND actor_type = 'SYSTEM'",
      )
      .all();
    expect(sysAudit).toHaveLength(1);

    // adversarial 6 — same business day, already succeeded → not due again
    clock = new Date('2026-09-10T20:00:00.000Z');
    const second = await svc.runAutomaticIfDue();
    expect(second).toEqual({ ran: false, ok: true });
    expect(listBackupRecords(db).filter((r) => r.backupType === 'AUTOMATIC')).toHaveLength(1);

    // adversarial 7 — app "reopened" the next day after 03:00 → due again
    clock = new Date('2026-09-11T09:00:00.000Z');
    const third = await svc.runAutomaticIfDue();
    expect(third).toEqual({ ran: true, ok: true });
    expect(listBackupRecords(db).filter((r) => r.backupType === 'AUTOMATIC')).toHaveLength(2);

    // Checkout is never interrupted by automatic backup work.
    expect(() => commitSale()).not.toThrow();
  });
});

describe('TEST-BACKUP-011 — overdue health is a protection warning, not a DB-failure claim', () => {
  it('reports overdue = true without any database-failure signal when backups have lapsed', () => {
    // A successful automatic backup 3 days ago, nothing since.
    insertCompletedBackupRecord(db, {
      backupType: 'AUTOMATIC',
      locationKind: 'LOCAL_DISK',
      fileName: 'gophones-automatic-v1-old.sqlite',
      storagePath: join(backupsRoot, 'automatic'),
      sourceAppVersion: '0.1.0-test',
      sourceSchemaVersion: 1,
      targetAppVersion: null,
      sizeBytes: 4096,
      checksumSha256: 'a'.repeat(64),
      startedAt: '2026-09-07T08:00:00.000Z',
      completedAt: '2026-09-07T08:00:01.000Z',
    });

    const health = service().status();
    expect(health.overdue).toBe(true);
    expect(health.lastAutomatic).toMatchObject({ outcome: 'COMPLETED' });
    expect(health.protection).toBe('LOCAL_DISK_ONLY');
    // Nothing in the health DTO asserts the database itself is broken.
    expect(JSON.stringify(health).toLowerCase()).not.toContain('corrupt');
  });
});

describe('TEST-BACKUP-010 / adversarial 8 — retention cleanup', () => {
  it('prunes only out-of-policy owned backups, keeps pre-migration + the newest, leaves the active DB alone', () => {
    const autoDir = join(backupsRoot, 'automatic');
    const preDir = join(backupsRoot, 'pre-migration');
    mkdirSync(autoDir, { recursive: true });
    mkdirSync(preDir, { recursive: true });

    const add = (
      name: string,
      dir: string,
      type: 'AUTOMATIC' | 'MANUAL' | 'PRE_MIGRATION',
      completedAt: string,
    ): void => {
      writeFileSync(join(dir, name), 'x'.repeat(2048));
      insertCompletedBackupRecord(db, {
        backupType: type,
        locationKind: 'LOCAL_DISK',
        fileName: name,
        storagePath: dir,
        sourceAppVersion: '0.1.0-test',
        sourceSchemaVersion: 1,
        targetAppVersion: type === 'PRE_MIGRATION' ? '0.2.0' : null,
        sizeBytes: 2048,
        checksumSha256: 'a'.repeat(64),
        startedAt: completedAt,
        completedAt,
      });
    };

    add('gophones-automatic-v1-stale1.sqlite', autoDir, 'AUTOMATIC', '2026-08-01T03:00:00.000Z');
    add('gophones-automatic-v1-stale2.sqlite', autoDir, 'AUTOMATIC', '2026-08-10T03:00:00.000Z');
    add('gophones-automatic-v1-fresh.sqlite', autoDir, 'AUTOMATIC', '2026-09-09T03:00:00.000Z');
    add(
      'gophones-pre-migration-v1-keep.sqlite',
      preDir,
      'PRE_MIGRATION',
      '2026-01-01T00:00:00.000Z',
    );

    const dbBytesBefore = readFileSync(join(temp.path, 'gophones.sqlite')).length;

    applyRetention(db, backupsRoot, new Date('2026-09-10T12:00:00.000Z'), capture.logger);

    const remaining = listBackupRecords(db);
    const names = remaining.map((r) => r.fileName);
    expect(names).toContain('gophones-automatic-v1-fresh.sqlite');
    expect(names).toContain('gophones-pre-migration-v1-keep.sqlite');
    expect(names).not.toContain('gophones-automatic-v1-stale1.sqlite');
    expect(names).not.toContain('gophones-automatic-v1-stale2.sqlite');

    expect(existsSync(join(autoDir, 'gophones-automatic-v1-stale1.sqlite'))).toBe(false);
    expect(existsSync(join(preDir, 'gophones-pre-migration-v1-keep.sqlite'))).toBe(true);

    // The active operational database is untouched by retention.
    expect(readFileSync(join(temp.path, 'gophones.sqlite')).length).toBe(dbBytesBefore);
  });

  it('never deletes the only verified usable backup, even when it is past policy', () => {
    const autoDir = join(backupsRoot, 'automatic');
    mkdirSync(autoDir, { recursive: true });
    writeFileSync(join(autoDir, 'gophones-automatic-v1-lonely.sqlite'), 'x');
    insertCompletedBackupRecord(db, {
      backupType: 'AUTOMATIC',
      locationKind: 'LOCAL_DISK',
      fileName: 'gophones-automatic-v1-lonely.sqlite',
      storagePath: autoDir,
      sourceAppVersion: '0.1.0-test',
      sourceSchemaVersion: 1,
      targetAppVersion: null,
      sizeBytes: 1,
      checksumSha256: 'a'.repeat(64),
      startedAt: '2026-01-01T03:00:00.000Z',
      completedAt: '2026-01-01T03:00:01.000Z',
    });

    applyRetention(db, backupsRoot, new Date('2026-09-10T12:00:00.000Z'), capture.logger);

    expect(listBackupRecords(db)).toHaveLength(1);
    expect(existsSync(join(autoDir, 'gophones-automatic-v1-lonely.sqlite'))).toBe(true);
  });
});

describe('TEST-BACKUP-015 — backup metadata for each attempt', () => {
  it('records correct type/status/outcome for manual success, automatic success, and a failure', async () => {
    await service().createManual();
    await service().runAutomaticIfDue();

    vi.spyOn(Database.prototype, 'backup').mockRejectedValueOnce(new Error('disk full'));
    await expect(service().createManual()).rejects.toMatchObject({ code: 'BACKUP_FAILED' });

    const rows = listBackupRecords(db);
    const manual = rows.find((r) => r.backupType === 'MANUAL' && r.status === 'COMPLETED')!;
    const auto = rows.find((r) => r.backupType === 'AUTOMATIC' && r.status === 'COMPLETED')!;
    const failed = rows.find((r) => r.status === 'FAILED')!;

    expect(manual.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manual.targetAppVersion).toBeNull();
    expect(auto.completedAt).not.toBeNull();
    expect(failed.errorCode).toBe('BACKUP_WRITE_FAILED');
    expect(failed.fileName).toBeNull();
    expect(failed.checksumSha256).toBeNull();
  });
});
