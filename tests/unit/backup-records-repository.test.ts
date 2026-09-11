import { afterEach, describe, expect, it } from 'vitest';
import {
  insertCompletedBackupRecord,
  insertFailedBackupRecord,
  latestBackupRecord,
  latestCompletedBackupRecord,
  latestFailedBackupRecord,
} from '../../src/main/backup/backupRecordsRepository';
import { createMigratedDb } from '../helpers/database';

/**
 * Phase 2L-C.1 — the new optional `locationKind` parameter on
 * `latestBackupRecord` / `latestCompletedBackupRecord` / `latestFailedBackupRecord`
 * (previously exercised only indirectly, and only ever with `LOCAL_DISK` data,
 * through `backupHealth.ts`/`backupService.ts`'s integration tests).
 */

let db: Awaited<ReturnType<typeof createMigratedDb>>;

afterEach(() => {
  db?.close();
});

function completed(
  locationKind: 'LOCAL_DISK' | 'OFF_DEVICE',
  startedAt: string,
  completedAt: string,
): Parameters<typeof insertCompletedBackupRecord>[1] {
  return {
    backupType: 'AUTOMATIC',
    locationKind,
    fileName: `gophones-automatic-v1-x-${locationKind}.sqlite`,
    storagePath: `C:\\backups\\${locationKind}`,
    sourceAppVersion: 'test',
    sourceSchemaVersion: 1,
    targetAppVersion: null,
    sizeBytes: 10,
    checksumSha256: 'a'.repeat(64),
    startedAt,
    completedAt,
  };
}

describe('backupRecordsRepository — location_kind-scoped queries', () => {
  it('latestBackupRecord: an omitted filter preserves the previous cross-location behavior', async () => {
    db = await createMigratedDb();
    insertCompletedBackupRecord(
      db,
      completed('LOCAL_DISK', '2026-09-10T09:00:00.000Z', '2026-09-10T09:00:01.000Z'),
    );
    insertCompletedBackupRecord(
      db,
      completed('OFF_DEVICE', '2026-09-10T09:05:00.000Z', '2026-09-10T09:05:01.000Z'),
    );

    const unscoped = latestBackupRecord(db, 'AUTOMATIC');
    expect(unscoped?.locationKind).toBe('OFF_DEVICE'); // most recent overall, regardless of location
  });

  it('latestBackupRecord: LOCAL_DISK and OFF_DEVICE filters each see only their own rows', async () => {
    db = await createMigratedDb();
    insertCompletedBackupRecord(
      db,
      completed('LOCAL_DISK', '2026-09-10T09:00:00.000Z', '2026-09-10T09:00:01.000Z'),
    );
    insertCompletedBackupRecord(
      db,
      completed('OFF_DEVICE', '2026-09-10T09:05:00.000Z', '2026-09-10T09:05:01.000Z'),
    );

    expect(latestBackupRecord(db, 'AUTOMATIC', 'LOCAL_DISK')?.locationKind).toBe('LOCAL_DISK');
    expect(latestBackupRecord(db, 'AUTOMATIC', 'OFF_DEVICE')?.locationKind).toBe('OFF_DEVICE');
  });

  it('latestCompletedBackupRecord: a later OFF_DEVICE success never shadows the LOCAL_DISK-scoped query', async () => {
    db = await createMigratedDb();
    insertCompletedBackupRecord(
      db,
      completed('LOCAL_DISK', '2026-09-10T09:00:00.000Z', '2026-09-10T09:00:01.000Z'),
    );
    insertCompletedBackupRecord(
      db,
      completed('OFF_DEVICE', '2026-09-10T09:05:00.000Z', '2026-09-10T09:05:01.000Z'),
    );

    const local = latestCompletedBackupRecord(db, 'AUTOMATIC', 'LOCAL_DISK');
    expect(local?.completedAt).toBe('2026-09-10T09:00:01.000Z');
    const offDevice = latestCompletedBackupRecord(db, 'AUTOMATIC', 'OFF_DEVICE');
    expect(offDevice?.completedAt).toBe('2026-09-10T09:05:01.000Z');
    const unscoped = latestCompletedBackupRecord(db, 'AUTOMATIC');
    expect(unscoped?.completedAt).toBe('2026-09-10T09:05:01.000Z');
  });

  it('latestFailedBackupRecord: LOCAL_DISK and OFF_DEVICE failures are scoped independently', async () => {
    db = await createMigratedDb();
    insertFailedBackupRecord(db, {
      backupType: 'AUTOMATIC',
      locationKind: 'LOCAL_DISK',
      sourceAppVersion: 'test',
      sourceSchemaVersion: 1,
      startedAt: '2026-09-10T09:00:00.000Z',
      errorCode: 'BACKUP_WRITE_FAILED',
    });
    insertFailedBackupRecord(db, {
      backupType: 'MANUAL',
      locationKind: 'OFF_DEVICE',
      sourceAppVersion: 'test',
      sourceSchemaVersion: 1,
      startedAt: '2026-09-10T09:05:00.000Z',
      errorCode: 'OFF_DEVICE_COPY_FAILED',
    });

    expect(latestFailedBackupRecord(db, 'LOCAL_DISK')?.errorCode).toBe('BACKUP_WRITE_FAILED');
    expect(latestFailedBackupRecord(db, 'OFF_DEVICE')?.errorCode).toBe('OFF_DEVICE_COPY_FAILED');
    // Omitted filter preserves the previous "most recent failure of any kind" behavior.
    expect(latestFailedBackupRecord(db)?.errorCode).toBe('OFF_DEVICE_COPY_FAILED');
  });

  it('a scoped query returns null when only the other location has data', async () => {
    db = await createMigratedDb();
    insertCompletedBackupRecord(
      db,
      completed('LOCAL_DISK', '2026-09-10T09:00:00.000Z', '2026-09-10T09:00:01.000Z'),
    );
    expect(latestBackupRecord(db, 'AUTOMATIC', 'OFF_DEVICE')).toBeNull();
    expect(latestCompletedBackupRecord(db, 'AUTOMATIC', 'OFF_DEVICE')).toBeNull();
    expect(latestFailedBackupRecord(db, 'OFF_DEVICE')).toBeNull();
  });
});
