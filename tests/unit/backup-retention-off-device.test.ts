import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyRetention } from '../../src/main/backup/backupRetention';
import { backupDirFor } from '../../src/main/backup/backupNaming';
import {
  insertCompletedBackupRecord,
  listBackupRecords,
} from '../../src/main/backup/backupRecordsRepository';
import { createCapturingLogger, createMigratedDb, makeTempDir } from '../helpers/database';

/**
 * Phase 2L-C.1 — `applyRetention`'s OFF_DEVICE filesystem sweep (extends the
 * existing local `automatic`/`manual` sweep to the configured app-managed
 * OFF_DEVICE directory). `backup-retention.test.ts` covers the pure,
 * location-independent `planRetention` row-selection function; this file
 * covers the actual filesystem side effects `applyRetention` performs.
 */

let db: Awaited<ReturnType<typeof createMigratedDb>>;
let temp: ReturnType<typeof makeTempDir>;
let backupsRoot: string;
let offDeviceRoot: string;
let capture: ReturnType<typeof createCapturingLogger>;

const NOW = new Date('2026-09-10T12:00:00.000Z');
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function writeManagedFile(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, name);
  writeFileSync(filePath, 'not a real sqlite file — retention never opens it');
  return filePath;
}

beforeEach(async () => {
  temp = makeTempDir('gpp-retention-off-device-');
  backupsRoot = join(temp.path, 'backups');
  offDeviceRoot = join(temp.path, 'external-drive', 'GoPhonesPOS Backups');
  db = await createMigratedDb();
  capture = createCapturingLogger();
});

afterEach(() => {
  db.close();
  temp.cleanup();
});

describe('applyRetention — OFF_DEVICE filesystem sweep', () => {
  it('deletes an expired managed OFF_DEVICE backup file and its record', () => {
    const dir = backupDirFor(offDeviceRoot, 'MANUAL');
    const oldFile = writeManagedFile(
      dir,
      'gophones-manual-v1-2026-06-01T00-00-00-000Z-aaaaaaaa.sqlite',
    );
    const recentFile = writeManagedFile(
      dir,
      'gophones-manual-v1-2026-09-09T00-00-00-000Z-bbbbbbbb.sqlite',
    );
    insertCompletedBackupRecord(db, {
      backupType: 'MANUAL',
      locationKind: 'OFF_DEVICE',
      fileName: 'gophones-manual-v1-2026-06-01T00-00-00-000Z-aaaaaaaa.sqlite',
      storagePath: dir,
      sourceAppVersion: 'test',
      sourceSchemaVersion: 1,
      targetAppVersion: null,
      sizeBytes: 10,
      checksumSha256: 'a'.repeat(64),
      startedAt: daysAgo(120),
      completedAt: daysAgo(120),
    });
    insertCompletedBackupRecord(db, {
      backupType: 'MANUAL',
      locationKind: 'OFF_DEVICE',
      fileName: 'gophones-manual-v1-2026-09-09T00-00-00-000Z-bbbbbbbb.sqlite',
      storagePath: dir,
      sourceAppVersion: 'test',
      sourceSchemaVersion: 1,
      targetAppVersion: null,
      sizeBytes: 10,
      checksumSha256: 'b'.repeat(64),
      startedAt: daysAgo(1),
      completedAt: daysAgo(1),
    });

    const result = applyRetention(db, backupsRoot, NOW, capture.logger, offDeviceRoot);

    expect(result.prunedRecords).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(recentFile)).toBe(true);
    expect(listBackupRecords(db).map((r) => r.checksumSha256)).toEqual(['b'.repeat(64)]);
  });

  it('deletes the paired sidecar manifest together with its pruned OFF_DEVICE SQLite file', () => {
    const dir = backupDirFor(offDeviceRoot, 'MANUAL');
    const fileName = 'gophones-manual-v1-2026-06-01T00-00-00-000Z-cccccccc.sqlite';
    const filePath = writeManagedFile(dir, fileName);
    const sidecarPath = `${filePath}.manifest.json`;
    writeFileSync(sidecarPath, '{"manifestVersion":1}');
    // A recent survivor so this is a genuine prune, not a rescued survivor.
    insertCompletedBackupRecord(db, {
      backupType: 'MANUAL',
      locationKind: 'OFF_DEVICE',
      fileName: 'gophones-manual-v1-2026-09-09T00-00-00-000Z-dddddddd.sqlite',
      storagePath: dir,
      sourceAppVersion: 'test',
      sourceSchemaVersion: 1,
      targetAppVersion: null,
      sizeBytes: 10,
      checksumSha256: 'd'.repeat(64),
      startedAt: daysAgo(1),
      completedAt: daysAgo(1),
    });
    insertCompletedBackupRecord(db, {
      backupType: 'MANUAL',
      locationKind: 'OFF_DEVICE',
      fileName,
      storagePath: dir,
      sourceAppVersion: 'test',
      sourceSchemaVersion: 1,
      targetAppVersion: null,
      sizeBytes: 10,
      checksumSha256: 'c'.repeat(64),
      startedAt: daysAgo(120),
      completedAt: daysAgo(120),
    });

    applyRetention(db, backupsRoot, NOW, capture.logger, offDeviceRoot);

    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(sidecarPath)).toBe(false);
  });

  it('never removes a sidecar whose SQLite file was not itself pruned', () => {
    const dir = backupDirFor(offDeviceRoot, 'MANUAL');
    const fileName = 'gophones-manual-v1-2026-09-09T00-00-00-000Z-eeeeeeee.sqlite';
    const filePath = writeManagedFile(dir, fileName);
    const sidecarPath = `${filePath}.manifest.json`;
    writeFileSync(sidecarPath, '{"manifestVersion":1}');
    insertCompletedBackupRecord(db, {
      backupType: 'MANUAL',
      locationKind: 'OFF_DEVICE',
      fileName,
      storagePath: dir,
      sourceAppVersion: 'test',
      sourceSchemaVersion: 1,
      targetAppVersion: null,
      sizeBytes: 10,
      checksumSha256: 'e'.repeat(64),
      startedAt: daysAgo(1),
      completedAt: daysAgo(1),
    });

    applyRetention(db, backupsRoot, NOW, capture.logger, offDeviceRoot);

    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(sidecarPath)).toBe(true);
  });

  it('removes a stale OFF_DEVICE `.partial` file past the grace period', () => {
    const dir = backupDirFor(offDeviceRoot, 'AUTOMATIC');
    const partialPath = writeManagedFile(
      dir,
      'gophones-automatic-v1-2026-09-10T00-00-00-000Z-ffffffff.sqlite.partial',
    );
    const old = new Date(NOW.getTime() - 5 * 60_000); // 5 minutes old, past the 60s grace period
    utimesSync(partialPath, old, old);

    const result = applyRetention(db, backupsRoot, NOW, capture.logger, offDeviceRoot);

    expect(existsSync(partialPath)).toBe(false);
    expect(result.prunedOrphanFiles).toBe(1);
  });

  it('preserves a recent OFF_DEVICE `.partial` file (still inside the 60s grace period)', () => {
    const dir = backupDirFor(offDeviceRoot, 'AUTOMATIC');
    const partialPath = writeManagedFile(
      dir,
      'gophones-automatic-v1-2026-09-10T00-00-00-000Z-11111111.sqlite.partial',
    );
    // Freshly written — well inside the grace period relative to real wall-clock time.
    const result = applyRetention(db, backupsRoot, NOW, capture.logger, offDeviceRoot);

    expect(existsSync(partialPath)).toBe(true);
    expect(result.prunedOrphanFiles).toBe(0);
  });

  it('preserves a final, unreferenced OFF_DEVICE `.sqlite` file rather than deleting it', () => {
    const dir = backupDirFor(offDeviceRoot, 'MANUAL');
    const filePath = writeManagedFile(
      dir,
      'gophones-manual-v1-2026-09-09T00-00-00-000Z-22222222.sqlite',
    );

    applyRetention(db, backupsRoot, NOW, capture.logger, offDeviceRoot);

    expect(existsSync(filePath)).toBe(true);
    expect(
      capture.records.some((r) => r.event === 'backup.retention.unreferenced-backup-preserved'),
    ).toBe(true);
  });

  it('skips safely when the OFF_DEVICE root is unavailable, without aborting local retention', () => {
    const localDir = backupDirFor(backupsRoot, 'MANUAL');
    const oldLocalFile = writeManagedFile(
      localDir,
      'gophones-manual-v1-2026-06-01T00-00-00-000Z-33333333.sqlite',
    );
    insertCompletedBackupRecord(db, {
      backupType: 'MANUAL',
      locationKind: 'LOCAL_DISK',
      fileName: 'gophones-manual-v1-2026-06-01T00-00-00-000Z-33333333.sqlite',
      storagePath: localDir,
      sourceAppVersion: 'test',
      sourceSchemaVersion: 1,
      targetAppVersion: null,
      sizeBytes: 10,
      checksumSha256: 'f'.repeat(64),
      startedAt: daysAgo(120),
      completedAt: daysAgo(120),
    });
    insertCompletedBackupRecord(db, {
      backupType: 'MANUAL',
      locationKind: 'LOCAL_DISK',
      fileName: 'gophones-manual-v1-2026-09-09T00-00-00-000Z-44444444.sqlite',
      storagePath: localDir,
      sourceAppVersion: 'test',
      sourceSchemaVersion: 1,
      targetAppVersion: null,
      sizeBytes: 10,
      checksumSha256: 'g'.repeat(64),
      startedAt: daysAgo(1),
      completedAt: daysAgo(1),
    });
    writeManagedFile(localDir, 'gophones-manual-v1-2026-09-09T00-00-00-000Z-44444444.sqlite');

    // The configured off-device destination directory does not exist at all
    // (e.g. an unplugged USB drive) — this must never throw and must never
    // prevent local retention from completing.
    const unavailableOffDeviceRoot = join(temp.path, 'not-mounted', 'GoPhonesPOS Backups');
    expect(() =>
      applyRetention(db, backupsRoot, NOW, capture.logger, unavailableOffDeviceRoot),
    ).not.toThrow();

    expect(existsSync(oldLocalFile)).toBe(false); // local pruning still ran
    expect(listBackupRecords(db).map((r) => r.checksumSha256)).toEqual(['g'.repeat(64)]);
  });

  it('a `null` OFF_DEVICE root (nothing configured) sweeps local only, unchanged from before this slice', () => {
    const localDir = backupDirFor(backupsRoot, 'AUTOMATIC');
    const partialPath = writeManagedFile(
      localDir,
      'gophones-automatic-v1-2026-09-10T00-00-00-000Z-55555555.sqlite.partial',
    );
    const old = new Date(NOW.getTime() - 5 * 60_000);
    utimesSync(partialPath, old, old);

    const result = applyRetention(db, backupsRoot, NOW, capture.logger, null);

    expect(existsSync(partialPath)).toBe(false);
    expect(result.prunedOrphanFiles).toBe(1);
  });
});
