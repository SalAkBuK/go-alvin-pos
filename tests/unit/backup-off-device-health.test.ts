import { afterEach, describe, expect, it } from 'vitest';
import { computeOffDeviceBackupHealth } from '../../src/main/backup/backupHealth';
import { backupDirFor } from '../../src/main/backup/backupNaming';
import {
  insertCompletedBackupRecord,
  insertFailedBackupRecord,
} from '../../src/main/backup/backupRecordsRepository';
import { writeOffDeviceBackupDestination } from '../../src/main/settings/offDeviceBackupSettingsRepository';
import type {
  OffDeviceDestinationVerification,
  OffDeviceDestinationVerifier,
} from '../../src/main/backup/offDeviceDestination';
import { createMigratedDb } from '../helpers/database';

/**
 * Phase 2L-C.1 — OFF_DEVICE health taxonomy (`computeOffDeviceBackupHealth`).
 * One focused test per semantic state, plus the `configuredAt` staleness-
 * exclusion guarantee and the Phase 2L-C.1 historical-context fix for
 * UNAVAILABLE / VERIFICATION_FAILED.
 */

const DATABASE_FILE = 'C:\\Users\\owner\\AppData\\Local\\GoPhonesPOS\\gophones.sqlite';
const DESTINATION = 'E:\\GoPhonesPOS Backups';
const CONFIGURED_AT = '2026-09-01T00:00:00.000Z';

function usbOk(): OffDeviceDestinationVerification {
  return {
    ok: true,
    kind: 'USB',
    canonicalPath: DESTINATION,
    displayName: 'External USB drive (E:)',
  };
}

function fail(errorCode: string): OffDeviceDestinationVerification {
  return { ok: false, errorCode: errorCode as never };
}

function verifierReturning(result: OffDeviceDestinationVerification): OffDeviceDestinationVerifier {
  return { verify: async () => result };
}

let db: Awaited<ReturnType<typeof createMigratedDb>>;

afterEach(() => {
  db?.close();
});

async function freshDb(): Promise<Awaited<ReturnType<typeof createMigratedDb>>> {
  db = await createMigratedDb();
  return db;
}

function completedOffDeviceRow(
  backupType: 'AUTOMATIC' | 'MANUAL',
  startedAt: string,
  completedAt: string,
): Parameters<typeof insertCompletedBackupRecord>[1] {
  return {
    backupType,
    locationKind: 'OFF_DEVICE',
    fileName: `gophones-${backupType.toLowerCase()}-v1-x.sqlite`,
    storagePath: backupDirFor(DESTINATION, backupType),
    sourceAppVersion: 'test',
    sourceSchemaVersion: 1,
    targetAppVersion: null,
    sizeBytes: 4096,
    checksumSha256: 'a'.repeat(64),
    startedAt,
    completedAt,
  };
}

describe('computeOffDeviceBackupHealth', () => {
  it('NOT_CONFIGURED: no destination has ever been set', async () => {
    const database = await freshDb();
    const result = await computeOffDeviceBackupHealth(database, {
      databaseFile: DATABASE_FILE,
      verifier: verifierReturning(usbOk()),
    });
    expect(result).toEqual({ state: 'NOT_CONFIGURED' });
  });

  it('HEALTHY: a recent successful copy exists for the currently verified destination', async () => {
    const database = await freshDb();
    writeOffDeviceBackupDestination(database, DESTINATION, CONFIGURED_AT);
    insertCompletedBackupRecord(
      database,
      completedOffDeviceRow('MANUAL', '2026-09-10T09:00:00.000Z', '2026-09-10T09:00:05.000Z'),
    );
    const result = await computeOffDeviceBackupHealth(database, {
      databaseFile: DATABASE_FILE,
      verifier: verifierReturning(usbOk()),
      now: new Date('2026-09-10T10:00:00.000Z'),
    });
    expect(result).toEqual({
      state: 'HEALTHY',
      lastSuccessfulAt: '2026-09-10T09:00:05.000Z',
      destinationKind: 'USB',
    });
  });

  it('ATTENTION / NEVER_SUCCEEDED: configured and verifiable, but no completion has ever been recorded', async () => {
    const database = await freshDb();
    writeOffDeviceBackupDestination(database, DESTINATION, CONFIGURED_AT);
    const result = await computeOffDeviceBackupHealth(database, {
      databaseFile: DATABASE_FILE,
      verifier: verifierReturning(usbOk()),
    });
    expect(result).toEqual({
      state: 'ATTENTION',
      reason: 'NEVER_SUCCEEDED',
      lastSuccessfulAt: null,
      destinationKind: 'USB',
    });
  });

  it('ATTENTION / UNAVAILABLE: destination unreachable now, preserving a real past success', async () => {
    const database = await freshDb();
    writeOffDeviceBackupDestination(database, DESTINATION, CONFIGURED_AT);
    insertCompletedBackupRecord(
      database,
      completedOffDeviceRow('MANUAL', '2026-09-05T09:00:00.000Z', '2026-09-05T09:00:05.000Z'),
    );
    const result = await computeOffDeviceBackupHealth(database, {
      databaseFile: DATABASE_FILE,
      verifier: verifierReturning(fail('OFF_DEVICE_DESTINATION_UNAVAILABLE')),
    });
    expect(result).toEqual({
      state: 'ATTENTION',
      reason: 'UNAVAILABLE',
      lastSuccessfulAt: '2026-09-05T09:00:05.000Z', // Phase 2L-C.1 fix: preserved, not discarded
      destinationKind: null, // never fabricated — no trusted source when verification fails
    });
  });

  it('ATTENTION / VERIFICATION_FAILED: ambiguous/ failed inspection now, preserving a real past success', async () => {
    const database = await freshDb();
    writeOffDeviceBackupDestination(database, DESTINATION, CONFIGURED_AT);
    insertCompletedBackupRecord(
      database,
      completedOffDeviceRow('AUTOMATIC', '2026-09-06T03:00:00.000Z', '2026-09-06T03:00:05.000Z'),
    );
    const result = await computeOffDeviceBackupHealth(database, {
      databaseFile: DATABASE_FILE,
      verifier: verifierReturning(fail('OFF_DEVICE_VERIFICATION_FAILED')),
    });
    expect(result).toEqual({
      state: 'ATTENTION',
      reason: 'VERIFICATION_FAILED',
      lastSuccessfulAt: '2026-09-06T03:00:05.000Z',
      destinationKind: null,
    });
  });

  it('ATTENTION / UNAVAILABLE never reports HEALTHY merely because a historical success exists', async () => {
    const database = await freshDb();
    writeOffDeviceBackupDestination(database, DESTINATION, CONFIGURED_AT);
    insertCompletedBackupRecord(
      database,
      completedOffDeviceRow('MANUAL', '2026-09-09T09:00:00.000Z', '2026-09-09T09:00:05.000Z'),
    );
    const result = await computeOffDeviceBackupHealth(database, {
      databaseFile: DATABASE_FILE,
      verifier: verifierReturning(fail('OFF_DEVICE_DESTINATION_UNAVAILABLE')),
      now: new Date('2026-09-09T09:01:00.000Z'), // would be well within the "fresh" window
    });
    expect(result.state).toBe('ATTENTION');
  });

  it('ATTENTION / UNAVAILABLE reports no history when no success has ever matched the configured destination', async () => {
    const database = await freshDb();
    writeOffDeviceBackupDestination(database, DESTINATION, CONFIGURED_AT);
    const result = await computeOffDeviceBackupHealth(database, {
      databaseFile: DATABASE_FILE,
      verifier: verifierReturning(fail('OFF_DEVICE_DESTINATION_UNAVAILABLE')),
    });
    expect(result).toEqual({
      state: 'ATTENTION',
      reason: 'UNAVAILABLE',
      lastSuccessfulAt: null,
      destinationKind: null,
    });
  });

  it('ATTENTION / STALE: last success is 2+ business-calendar days behind', async () => {
    const database = await freshDb();
    writeOffDeviceBackupDestination(database, DESTINATION, CONFIGURED_AT);
    insertCompletedBackupRecord(
      database,
      completedOffDeviceRow('AUTOMATIC', '2026-09-01T09:00:00.000Z', '2026-09-01T09:00:05.000Z'),
    );
    const result = await computeOffDeviceBackupHealth(database, {
      databaseFile: DATABASE_FILE,
      verifier: verifierReturning(usbOk()),
      now: new Date('2026-09-10T09:00:00.000Z'), // 9 days later — well past any timezone ambiguity
    });
    expect(result).toEqual({
      state: 'ATTENTION',
      reason: 'STALE',
      lastSuccessfulAt: '2026-09-01T09:00:05.000Z',
      destinationKind: 'USB',
    });
  });

  it('ATTENTION / LAST_COPY_FAILED: the most recent attempt after the last success failed', async () => {
    const database = await freshDb();
    writeOffDeviceBackupDestination(database, DESTINATION, CONFIGURED_AT);
    insertCompletedBackupRecord(
      database,
      completedOffDeviceRow('MANUAL', '2026-09-05T09:00:00.000Z', '2026-09-05T09:00:05.000Z'),
    );
    insertFailedBackupRecord(database, {
      backupType: 'MANUAL',
      locationKind: 'OFF_DEVICE',
      sourceAppVersion: 'test',
      sourceSchemaVersion: 1,
      startedAt: '2026-09-06T09:00:00.000Z',
      errorCode: 'OFF_DEVICE_COPY_FAILED',
    });
    const result = await computeOffDeviceBackupHealth(database, {
      databaseFile: DATABASE_FILE,
      verifier: verifierReturning(usbOk()),
      now: new Date('2026-09-06T10:00:00.000Z'),
    });
    expect(result).toEqual({
      state: 'ATTENTION',
      reason: 'LAST_COPY_FAILED',
      lastSuccessfulAt: '2026-09-05T09:00:05.000Z',
      destinationKind: 'USB',
    });
  });

  it('excludes backup history from before the currently configured destination`s configuredAt', async () => {
    const database = await freshDb();
    // A success recorded BEFORE the (re-)configuration — must not count toward
    // the currently configured destination's health.
    insertCompletedBackupRecord(
      database,
      completedOffDeviceRow('MANUAL', '2026-08-01T09:00:00.000Z', '2026-08-01T09:00:05.000Z'),
    );
    writeOffDeviceBackupDestination(database, DESTINATION, CONFIGURED_AT);
    const result = await computeOffDeviceBackupHealth(database, {
      databaseFile: DATABASE_FILE,
      verifier: verifierReturning(usbOk()),
    });
    expect(result).toEqual({
      state: 'ATTENTION',
      reason: 'NEVER_SUCCEEDED',
      lastSuccessfulAt: null,
      destinationKind: 'USB',
    });
  });
});
