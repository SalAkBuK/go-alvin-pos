import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackupService } from '../../src/main/backup/backupService';
import type { BackupService } from '../../src/main/backup/backupService';
import { listBackupRecords } from '../../src/main/backup/backupRecordsRepository';
import { backupDirFor } from '../../src/main/backup/backupNaming';
import {
  copyBackupOffDevice,
  OFF_DEVICE_COPY_ERROR_CODES,
} from '../../src/main/backup/offDeviceCopy';
import { sha256File } from '../../src/main/backup/backupSnapshot';
import type {
  OffDeviceDestinationVerification,
  OffDeviceDestinationVerifier,
} from '../../src/main/backup/offDeviceDestination';
import { createMigratedDb, createCapturingLogger, makeTempDir } from '../helpers/database';
import { seedBusiness, seedTaxRate } from '../helpers/checkout';

/**
 * Phase 2L-C.1 — OFF_DEVICE backup orchestration (configured destination).
 *
 * `tests/integration/backup.test.ts` exercises LOCAL_DISK creation and never
 * configures an off-device destination; every off-device branch it touches is
 * the `NOT_CONFIGURED` no-op. This file specifically configures a destination
 * (via an injectable fake `OffDeviceDestinationVerifier` — real Windows disk
 * inspection is covered in `off-device-destination.test.ts`) and exercises
 * the real `backupService.ts` / `offDeviceCopy.ts` orchestration against real
 * files on disk, proving: local-first ordering, exact-artifact copying,
 * independent destination verification, truthful record-keeping, and that an
 * OFF_DEVICE failure never touches the LOCAL_DISK result.
 */

let db: Database.Database;
let temp: ReturnType<typeof makeTempDir>;
let backupsRoot: string;
let externalDrive: string;
let clock: Date;
let capture: ReturnType<typeof createCapturingLogger>;

function usbOk(destinationDirectory: string): OffDeviceDestinationVerification {
  return {
    ok: true,
    kind: 'USB',
    canonicalPath: destinationDirectory,
    displayName: 'Test USB drive',
  };
}

/** A verifier whose result can be swapped mid-test (e.g. "succeeds at configure time, fails at copy time"). */
function switchableVerifier(
  initial: (destinationDirectory: string) => OffDeviceDestinationVerification,
): {
  verifier: OffDeviceDestinationVerifier;
  setResolver(fn: (destinationDirectory: string) => OffDeviceDestinationVerification): void;
} {
  let resolver = initial;
  return {
    verifier: {
      verify: async (_operationalDatabasePath, destinationDirectory) =>
        resolver(destinationDirectory),
    },
    setResolver(fn): void {
      resolver = fn;
    },
  };
}

function service(verifier: OffDeviceDestinationVerifier): BackupService {
  return createBackupService({
    db,
    backupsRoot,
    appVersion: '0.1.0-test',
    logger: capture.logger,
    now: () => clock,
    offDeviceVerifier: verifier,
  });
}

/** Bulk filler so a source snapshot is large enough to make its copy non-instantaneous (mirrors `backup.test.ts`'s `padDatabase`). */
function padDatabase(rows: number): void {
  const insert = db.prepare(
    `INSERT INTO products (id, name, brand, model, condition, selling_price_cents, quantity_on_hand, created_at, updated_at)
     VALUES (?, ?, 'Filler', 'F', 'NEW', 100, 0, ?, ?)`,
  );
  db.transaction(() => {
    for (let i = 0; i < rows; i += 1) {
      insert.run(
        `PAD-${i}`,
        `Filler product ${i} ${'x'.repeat(80)}`,
        clock.toISOString(),
        clock.toISOString(),
      );
    }
  })();
}

beforeEach(async () => {
  temp = makeTempDir('gpp-backup-off-device-');
  backupsRoot = join(temp.path, 'backups');
  externalDrive = join(temp.path, 'external-drive');
  mkdirSync(externalDrive, { recursive: true });
  db = await createMigratedDb(join(temp.path, 'gophones.sqlite'));
  seedTaxRate(db);
  seedBusiness(db);
  clock = new Date('2026-09-10T09:00:00.000Z');
  capture = createCapturingLogger();
});

afterEach(() => {
  db.close();
  temp.cleanup();
});

describe('local-first ordering, exact-copy semantics, and truthful records (success)', () => {
  it('completes the LOCAL_DISK backup first, then copies the exact artifact off-device and records both truthfully', async () => {
    const svc = service({ verify: async (_db, dest) => usbOk(dest) });
    const configured = await svc.configureOffDevice(externalDrive);
    expect(configured).toMatchObject({ configured: true, destinationKind: 'USB', verified: true });

    const result = await svc.createManual();

    expect(result.status).toBe('COMPLETED');
    expect(result.locationKind).toBe('LOCAL_DISK');
    expect(result.offDevice).toEqual({ outcome: 'COMPLETED', completedAt: expect.any(String) });

    const records = listBackupRecords(db);
    const local = records.find((r) => r.locationKind === 'LOCAL_DISK' && r.status === 'COMPLETED');
    const offDevice = records.find(
      (r) => r.locationKind === 'OFF_DEVICE' && r.status === 'COMPLETED',
    );
    expect(local).toBeDefined();
    expect(offDevice).toBeDefined();

    // The off-device copy is the exact same logical snapshot: identical bytes.
    const localPath = join(local!.storagePath!, local!.fileName!);
    const offDevicePath = join(offDevice!.storagePath!, offDevice!.fileName!);
    expect(offDevicePath).not.toBe(localPath);
    expect(readFileSync(offDevicePath)).toEqual(readFileSync(localPath));
    expect(offDevice!.checksumSha256).toBe(local!.checksumSha256);
    expect(offDevice!.sizeBytes).toBe(local!.sizeBytes);

    // A sidecar manifest was published next to the off-device copy.
    expect(existsSync(`${offDevicePath}.manifest.json`)).toBe(true);

    // Durable, truthful COMPLETED audit evidence for both locations.
    const completedAudit = db
      .prepare("SELECT * FROM audit_events WHERE event_type = 'BACKUP_COMPLETED'")
      .all() as Array<Record<string, unknown>>;
    expect(completedAudit).toHaveLength(2);
  });
});

describe('failure isolation — an OFF_DEVICE failure never touches the LOCAL_DISK result', () => {
  it('destination verification failure: local stays COMPLETED, off-device is recorded FAILED, no local file is touched', async () => {
    const sw = switchableVerifier((dest) => usbOk(dest));
    const svc = service(sw.verifier);
    await svc.configureOffDevice(externalDrive);

    // The destination becomes unverifiable only once an actual copy is attempted.
    sw.setResolver(() => ({ ok: false, errorCode: 'OFF_DEVICE_SAME_PHYSICAL_DISK' }));

    const result = await svc.createManual();

    expect(result.status).toBe('COMPLETED');
    expect(result.locationKind).toBe('LOCAL_DISK');
    expect(result.offDevice).toEqual({
      outcome: 'FAILED',
      errorCode: 'OFF_DEVICE_SAME_PHYSICAL_DISK',
    });

    const localFile = join(backupsRoot, 'manual', readdirSync(join(backupsRoot, 'manual'))[0]!);
    expect(existsSync(localFile)).toBe(true);

    const records = listBackupRecords(db);
    expect(records.find((r) => r.locationKind === 'LOCAL_DISK')?.status).toBe('COMPLETED');
    const offDeviceRow = records.find((r) => r.locationKind === 'OFF_DEVICE');
    expect(offDeviceRow?.status).toBe('FAILED');
    expect(offDeviceRow?.errorCode).toBe('OFF_DEVICE_SAME_PHYSICAL_DISK');

    // No off-device directory/file was ever created for the failed attempt.
    expect(existsSync(join(externalDrive, 'GoPhonesPOS Backups', 'manual'))).toBe(false);
  });

  it('an automatic backup: local health reflects success even while off-device protection needs attention', async () => {
    const sw = switchableVerifier((dest) => usbOk(dest));
    const svc = service(sw.verifier);
    await svc.configureOffDevice(externalDrive);
    sw.setResolver(() => ({ ok: false, errorCode: 'OFF_DEVICE_DESTINATION_UNAVAILABLE' }));

    const outcome = await svc.runAutomaticIfDue();
    expect(outcome).toEqual({ ran: true, ok: true });

    const health = svc.status();
    expect(health.lastAutomatic).toMatchObject({ outcome: 'COMPLETED' });
    expect(health.protection).toBe('LOCAL_DISK_ONLY');

    const records = listBackupRecords(db);
    expect(records.find((r) => r.locationKind === 'LOCAL_DISK')?.status).toBe('COMPLETED');
    expect(records.find((r) => r.locationKind === 'OFF_DEVICE')?.status).toBe('FAILED');
  });

  it('checksum/size verification failure at the destination: local stays COMPLETED and the corrupted off-device copy is discarded', async () => {
    const svc = service({ verify: async (_db, dest) => usbOk(dest) });
    const local = await svc.createManual(); // no off-device configured yet — a plain local backup
    const localPath = join(backupsRoot, 'manual', local.fileName);

    const destinationDirectory = backupDirFor(externalDrive, 'MANUAL');
    const outcome = await copyBackupOffDevice({
      verifier: { verify: async (_db, dest) => usbOk(dest) },
      operationalDatabasePath: db.name,
      offDeviceBackupsRoot: externalDrive,
      sourceFilePath: localPath,
      fileName: local.fileName,
      backupType: 'MANUAL',
      logicalBackupId: 'logical-1',
      sourceAppVersion: '0.1.0-test',
      sourceSchemaVersion: 1,
      expectedChecksumSha256: '0'.repeat(64), // deliberately wrong
      expectedSizeBytes: local.sizeBytes,
      createdAt: clock.toISOString(),
      completedAt: clock.toISOString(),
    });

    expect(outcome).toEqual({
      ok: false,
      errorCode: OFF_DEVICE_COPY_ERROR_CODES.copiedBytesInvalid,
    });
    // The mismatched copy is never published under its final name, and no
    // partial is left behind.
    expect(existsSync(join(destinationDirectory, local.fileName))).toBe(false);
    expect(existsSync(join(destinationDirectory, `${local.fileName}.partial`))).toBe(false);
    // The LOCAL_DISK artifact this off-device attempt read from is untouched.
    expect(existsSync(localPath)).toBe(true);
    expect(await sha256File(localPath)).toBe(
      createHash('sha256').update(readFileSync(localPath)).digest('hex'),
    );
  });

  it('copy failure (unreadable source): reports OFF_DEVICE_COPY_FAILED without touching the destination', async () => {
    const destinationDirectory = backupDirFor(externalDrive, 'MANUAL');
    const outcome = await copyBackupOffDevice({
      verifier: { verify: async (_db, dest) => usbOk(dest) },
      operationalDatabasePath: db.name,
      offDeviceBackupsRoot: externalDrive,
      sourceFilePath: join(temp.path, 'does-not-exist.sqlite'),
      fileName: 'gophones-manual-v1-2026-09-10T09-00-00-000Z-deadbeef.sqlite',
      backupType: 'MANUAL',
      logicalBackupId: 'logical-2',
      sourceAppVersion: '0.1.0-test',
      sourceSchemaVersion: 1,
      expectedChecksumSha256: 'a'.repeat(64),
      expectedSizeBytes: 4096,
      createdAt: clock.toISOString(),
      completedAt: clock.toISOString(),
    });

    expect(outcome).toEqual({ ok: false, errorCode: OFF_DEVICE_COPY_ERROR_CODES.copyFailed });
    expect(existsSync(destinationDirectory)).toBe(true); // created, but left empty
    expect(readdirSync(destinationDirectory)).toEqual([]);
  });

  it('copy timeout: an interrupted copy times out and leaves no partial or final file', async () => {
    padDatabase(15_000); // several MB, so the copy cannot complete within 1ms
    const svc = service({ verify: async (_db, dest) => usbOk(dest) });
    const local = await svc.createManual();
    const localPath = join(backupsRoot, 'manual', local.fileName);
    const destinationDirectory = backupDirFor(externalDrive, 'MANUAL');

    const outcome = await copyBackupOffDevice({
      verifier: { verify: async (_db, dest) => usbOk(dest) },
      operationalDatabasePath: db.name,
      offDeviceBackupsRoot: externalDrive,
      sourceFilePath: localPath,
      fileName: local.fileName,
      backupType: 'MANUAL',
      logicalBackupId: 'logical-3',
      sourceAppVersion: '0.1.0-test',
      sourceSchemaVersion: 1,
      expectedChecksumSha256: await sha256File(localPath),
      expectedSizeBytes: local.sizeBytes,
      createdAt: clock.toISOString(),
      completedAt: clock.toISOString(),
      timeoutMs: 1,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect([
        OFF_DEVICE_COPY_ERROR_CODES.copyTimedOut,
        OFF_DEVICE_COPY_ERROR_CODES.copyFailed,
      ]).toContain(outcome.errorCode);
    }
    expect(existsSync(join(destinationDirectory, local.fileName))).toBe(false);
    expect(existsSync(join(destinationDirectory, `${local.fileName}.partial`))).toBe(false);
    // Local artifact this attempt read from remains intact regardless.
    expect(existsSync(localPath)).toBe(true);
  });

  it('manifest failure: the valid final SQLite copy is preserved but NOT recorded as COMPLETED', async () => {
    const svc = service({ verify: async (_db, dest) => usbOk(dest) });
    const local = await svc.createManual();
    const localPath = join(backupsRoot, 'manual', local.fileName);

    const destinationDirectory = backupDirFor(externalDrive, 'MANUAL');
    mkdirSync(destinationDirectory, { recursive: true });
    // Occupy the sidecar's own path with a directory so the atomic rename
    // inside `writeBackupManifestAtomic` fails deterministically, without
    // mocking any production code.
    mkdirSync(join(destinationDirectory, `${local.fileName}.manifest.json`));

    const outcome = await copyBackupOffDevice({
      verifier: { verify: async (_db, dest) => usbOk(dest) },
      operationalDatabasePath: db.name,
      offDeviceBackupsRoot: externalDrive,
      sourceFilePath: localPath,
      fileName: local.fileName,
      backupType: 'MANUAL',
      logicalBackupId: 'logical-4',
      sourceAppVersion: '0.1.0-test',
      sourceSchemaVersion: 1,
      expectedChecksumSha256: await sha256File(localPath),
      expectedSizeBytes: local.sizeBytes,
      createdAt: clock.toISOString(),
      completedAt: clock.toISOString(),
    });

    expect(outcome).toEqual({
      ok: false,
      errorCode: OFF_DEVICE_COPY_ERROR_CODES.manifestFailed,
    });
    // The valid SQLite bytes were preserved as recovery evidence even though
    // this attempt is not recorded as COMPLETED (documented behavior — not
    // fixed in this slice; unified discovery will pick this up later).
    const finalPath = join(destinationDirectory, local.fileName);
    expect(existsSync(finalPath)).toBe(true);
    expect(await sha256File(finalPath)).toBe(await sha256File(localPath));
  });
});
