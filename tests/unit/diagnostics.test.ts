import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BackupHealth } from '../../src/shared/backup';
import type { GoogleConfig } from '../../src/shared/google';
import type { BackupService } from '../../src/main/backup/backupService';
import { insertCompletedBackupRecord } from '../../src/main/backup/backupRecordsRepository';
import type { ProductionDatabase } from '../../src/main/database/database';
import { inspectDatabaseHealth } from '../../src/main/diagnostics/databaseHealth';
import {
  DISK_CRITICAL_BELOW_BYTES,
  DISK_WARNING_BELOW_BYTES,
  classifyDiskSpace,
} from '../../src/main/diagnostics/diskSpace';
import {
  aggregateHealth,
  createDiagnosticsService,
} from '../../src/main/diagnostics/diagnosticsService';
import type { DiagnosticsServiceDeps } from '../../src/main/diagnostics/diagnosticsService';
import { createCapturingLogger, createMigratedDb } from '../helpers/database';

const NOW = '2026-09-11T16:00:00.000Z';

const HEALTHY_BACKUP: BackupHealth = {
  lastAutomatic: { outcome: 'COMPLETED', at: '2026-09-11T08:00:00.000Z' },
  lastSuccessfulAutomaticAt: '2026-09-11T08:00:00.000Z',
  overdue: false,
  lastFailure: null,
  protection: 'LOCAL_DISK_ONLY',
  offDevice: { state: 'NOT_CONFIGURED' },
  automaticEnabled: true,
  schedule: { cadence: 'DAILY', atLocalTime: '03:00' },
};

const HEALTHY_GOOGLE: GoogleConfig = {
  setupState: 'READY',
  connected: true,
  enabled: true,
  ready: true,
  accountEmail: 'owner-secret@example.test',
  spreadsheetName: 'Go Phones POS Sales',
  canOpenSpreadsheet: true,
  lastSuccessfulSyncAt: '2026-09-11T15:00:00.000Z',
  secureStorageAvailable: true,
  oauthClientConfigured: true,
  needsReauthorization: false,
  setupIncompleteReason: null,
  restoreReconnectRequired: false,
  queue: { pending: 0, exporting: 0, exported: 4, failed: 0 },
};

function productionHandle(db: Database.Database): ProductionDatabase {
  return { connection: db, closed: false, schemaVersion: 1 } as ProductionDatabase;
}

function backupService(health: BackupHealth): BackupService {
  return { statusVerified: () => Promise.resolve(health) } as BackupService;
}

function serviceDeps(
  db: Database.Database,
  overrides: Partial<DiagnosticsServiceDeps> = {},
): DiagnosticsServiceDeps {
  const capture = createCapturingLogger();
  return {
    appVersion: '1.2.3',
    installationId: 'INST-00000000-0000-4000-8000-000000000001',
    storagePath: 'C:\\private\\GoPhonesPOS',
    logger: capture.logger,
    getDatabase: () => productionHandle(db),
    getDatabaseStatus: () => ({ state: 'ready', schemaVersion: 1, failureCode: null }),
    getBackupService: () => backupService(HEALTHY_BACKUP),
    getGoogleConfig: () => Promise.resolve(HEALTHY_GOOGLE),
    getPrinterConfig: () =>
      Promise.resolve({
        selectedDeviceName: 'receipt-device',
        selectedDisplayName: 'Receipt Printer',
        selectedIsAvailable: true,
      }),
    diskInspector: { availableBytes: () => Promise.resolve(10 * 1024 * 1024 * 1024) },
    now: () => new Date(NOW),
    runtime: {
      platform: 'win32',
      osRelease: '10.0.test',
      arch: 'x64',
      electron: '44.2.0',
      node: '24.0.0',
    },
    ...overrides,
  };
}

describe('health aggregation and disk thresholds', () => {
  it('aggregates deterministically', () => {
    expect(aggregateHealth(['HEALTHY', 'HEALTHY'])).toBe('HEALTHY');
    expect(aggregateHealth(['HEALTHY', 'WARNING'])).toBe('WARNING');
    expect(aggregateHealth(['WARNING', 'CRITICAL'])).toBe('CRITICAL');
  });

  it('uses the canonical exact disk boundaries', () => {
    expect(classifyDiskSpace(DISK_WARNING_BELOW_BYTES).status).toBe('HEALTHY');
    expect(classifyDiskSpace(DISK_WARNING_BELOW_BYTES - 1).status).toBe('WARNING');
    expect(classifyDiskSpace(DISK_CRITICAL_BELOW_BYTES).status).toBe('WARNING');
    expect(classifyDiskSpace(DISK_CRITICAL_BELOW_BYTES - 1).status).toBe('CRITICAL');
  });
});

describe('database diagnostics', () => {
  let db: Database.Database;
  beforeEach(async () => {
    db = await createMigratedDb();
  });
  afterEach(() => db.close());

  it('checks open/schema/migrations/foreign keys/tables and runs quick_check only manually', () => {
    expect(inspectDatabaseHealth(db, { deep: false })).toMatchObject({
      status: 'HEALTHY',
      open: true,
      schemaVersion: 1,
      expectedSchemaVersion: 1,
      migrationStateValid: true,
      foreignKeysEnabled: true,
      criticalTablesAvailable: true,
      quickCheck: 'NOT_RUN',
    });
    expect(inspectDatabaseHealth(db, { deep: true }).quickCheck).toBe('OK');
  });

  it('fails closed for invalid migration state, disabled foreign keys, or a missing critical table', async () => {
    db.prepare("UPDATE schema_migrations SET checksum = 'bad'").run();
    expect(inspectDatabaseHealth(db, { deep: false })).toMatchObject({
      status: 'CRITICAL',
      migrationStateValid: false,
    });
    db.close();

    db = await createMigratedDb();
    db.pragma('foreign_keys = OFF');
    expect(inspectDatabaseHealth(db, { deep: false })).toMatchObject({
      status: 'CRITICAL',
      foreignKeysEnabled: false,
    });
    db.exec('DROP TABLE backup_records');
    expect(inspectDatabaseHealth(db, { deep: false })).toMatchObject({
      status: 'CRITICAL',
      criticalTablesAvailable: false,
    });
  });
});

describe('diagnostic snapshot', () => {
  let db: Database.Database;
  beforeEach(async () => {
    db = await createMigratedDb();
  });
  afterEach(() => db.close());

  it('returns a fully healthy, typed, pathless summary and a deeper manual snapshot', async () => {
    const service = createDiagnosticsService(serviceDeps(db));
    const summary = await service.getSummary();
    expect(summary.overallStatus).toBe('HEALTHY');
    expect(summary.components.database.quickCheck).toBe('NOT_RUN');
    expect(summary.components.connectivity).toMatchObject({ supported: false, state: 'UNKNOWN' });
    expect(summary.components.printer.printHistorySupported).toBe(false);
    expect(summary.components.update).toEqual({
      status: 'HEALTHY',
      supported: false,
      state: 'UNKNOWN',
      currentVersion: '1.2.3',
      availableVersion: null,
      lastCheckedAt: null,
      issueCode: null,
    });

    const manual = await service.runDiagnostics();
    expect(manual.mode).toBe('MANUAL');
    expect(manual.components.database.quickCheck).toBe('OK');
    const serialized = JSON.stringify(manual);
    expect(serialized).not.toContain('C:\\private');
    expect(serialized).not.toContain('owner-secret@example.test');
    expect(serialized).not.toMatch(/spreadsheet[_ -]?id|refresh[_ -]?token|customerPhone/i);
  });

  it('keeps Google, printer, and offline connectivity failures at WARNING', async () => {
    const google = await createDiagnosticsService(
      serviceDeps(db, {
        getGoogleConfig: () =>
          Promise.resolve({ ...HEALTHY_GOOGLE, setupState: 'DISCONNECTED', connected: false }),
      }),
    ).getSummary();
    expect(google.components.google.status).toBe('WARNING');
    expect(google.overallStatus).toBe('WARNING');

    const printer = await createDiagnosticsService(
      serviceDeps(db, {
        getPrinterConfig: () =>
          Promise.resolve({
            selectedDeviceName: 'missing',
            selectedDisplayName: null,
            selectedIsAvailable: false,
          }),
      }),
    ).getSummary();
    expect(printer.components.printer.status).toBe('WARNING');
    expect(printer.overallStatus).toBe('WARNING');

    const offline = await createDiagnosticsService(
      serviceDeps(db, { connectivityInspector: { inspect: () => Promise.resolve('OFFLINE') } }),
    ).getSummary();
    expect(offline.components.connectivity).toMatchObject({
      status: 'WARNING',
      state: 'OFFLINE',
    });
    expect(offline.overallStatus).toBe('WARNING');
  });

  it('represents backup overdue/failure/off-device states without making them critical', async () => {
    insertCompletedBackupRecord(db, {
      backupType: 'AUTOMATIC',
      locationKind: 'LOCAL_DISK',
      fileName: 'safe.sqlite',
      storagePath: 'C:\\private\\backups',
      sourceAppVersion: '1.2.3',
      sourceSchemaVersion: 1,
      targetAppVersion: null,
      sizeBytes: 4096,
      checksumSha256: 'a'.repeat(64),
      startedAt: '2026-09-11T07:59:00.000Z',
      completedAt: '2026-09-11T08:00:00.000Z',
    });
    for (const health of [
      { ...HEALTHY_BACKUP, overdue: true },
      {
        ...HEALTHY_BACKUP,
        lastFailure: {
          backupType: 'AUTOMATIC' as const,
          at: '2026-09-11T10:00:00.000Z',
          errorCode: 'BACKUP_FAILED',
        },
      },
      {
        ...HEALTHY_BACKUP,
        offDevice: {
          state: 'ATTENTION' as const,
          reason: 'UNAVAILABLE' as const,
          lastSuccessfulAt: null,
          destinationKind: null,
        },
      },
    ]) {
      const result = await createDiagnosticsService(
        serviceDeps(db, { getBackupService: () => backupService(health) }),
      ).getSummary();
      expect(result.components.backup.status).toBe('WARNING');
      expect(result.components.backup.lastSuccessfulLocalAt).toBe('2026-09-11T08:00:00.000Z');
      expect(result.overallStatus).toBe('WARNING');
    }

    const protectedResult = await createDiagnosticsService(
      serviceDeps(db, {
        getBackupService: () =>
          backupService({
            ...HEALTHY_BACKUP,
            protection: 'OFF_DEVICE',
            offDevice: {
              state: 'HEALTHY',
              lastSuccessfulAt: '2026-09-11T08:01:00.000Z',
              destinationKind: 'USB',
            },
          }),
      }),
    ).getSummary();
    expect(protectedResult.components.backup.status).toBe('HEALTHY');
  });

  it('makes critical local persistence conditions CRITICAL overall', async () => {
    const lowDisk = await createDiagnosticsService(
      serviceDeps(db, {
        diskInspector: {
          availableBytes: () => Promise.resolve(DISK_CRITICAL_BELOW_BYTES - 1),
        },
      }),
    ).getSummary();
    expect(lowDisk.components.disk.status).toBe('CRITICAL');
    expect(lowDisk.overallStatus).toBe('CRITICAL');

    const unavailableDatabase = await createDiagnosticsService(
      serviceDeps(db, {
        getDatabase: () => null,
        getDatabaseStatus: () => ({
          state: 'unavailable',
          schemaVersion: null,
          failureCode: 'DB_OPEN_FAILED',
        }),
      }),
    ).getSummary();
    expect(unavailableDatabase.components.database).toMatchObject({
      status: 'CRITICAL',
      open: false,
    });
    expect(unavailableDatabase.overallStatus).toBe('CRITICAL');
  });

  it('counts canonical unresolved Card incidents and excludes Cash COMMIT_FAILED', async () => {
    const insert = db.prepare(
      `INSERT INTO checkout_requests
       (request_id, request_fingerprint, payment_method_snapshot, intended_total_cents,
        status, failure_code, created_at, failed_at)
       VALUES (?, ?, ?, 100, 'COMMIT_FAILED', 'SALE_COMMIT_FAILED', ?, ?)`,
    );
    insert.run('card', 'fp-card', 'CARD', '2026-09-11T10:00:00.000Z', '2026-09-11T10:00:00.000Z');
    insert.run('cash', 'fp-cash', 'CASH', '2026-09-11T10:00:00.000Z', '2026-09-11T10:00:00.000Z');

    const result = await createDiagnosticsService(serviceDeps(db)).getSummary();
    expect(result.components.cardReconciliation).toMatchObject({
      status: 'WARNING',
      unresolvedCount: 1,
      issueCode: 'CARD_RECONCILIATION_REQUIRED',
    });
  });

  it('safely represents and logs component failures', async () => {
    const capture = createCapturingLogger();
    const result = await createDiagnosticsService(
      serviceDeps(db, {
        logger: capture.logger,
        diskInspector: { availableBytes: () => Promise.reject(new Error('C:\\secret\\db')) },
        getGoogleConfig: () => Promise.reject(new Error('refresh_token=secret')),
      }),
    ).runDiagnostics();
    expect(result.components.disk.issueCode).toBe('DISK_INSPECTION_FAILED');
    expect(result.components.google.issueCode).toBe('GOOGLE_DIAGNOSTIC_UNAVAILABLE');
    expect(capture.records.some((entry) => entry.event === 'diagnostics.component.failed')).toBe(
      true,
    );
    expect(JSON.stringify(capture.records)).not.toContain('C:\\secret');
    expect(JSON.stringify(capture.records)).not.toContain('refresh_token');
  });

  it('does not mutate sales, inventory, settings, or any other database row', async () => {
    const changesBefore = db.prepare('SELECT total_changes() AS n').get() as { n: number };
    const tablesBefore = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const countsBefore = Object.fromEntries(
      tablesBefore.map(({ name }) => [
        name,
        (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n,
      ]),
    );

    await createDiagnosticsService(serviceDeps(db)).runDiagnostics();

    const changesAfter = db.prepare('SELECT total_changes() AS n').get() as { n: number };
    const countsAfter = Object.fromEntries(
      tablesBefore.map(({ name }) => [
        name,
        (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n,
      ]),
    );
    expect(changesAfter.n).toBe(changesBefore.n);
    expect(countsAfter).toEqual(countsBefore);
  });
});

describe('update-health diagnostics', () => {
  let db: Database.Database;
  beforeEach(async () => {
    db = await createMigratedDb();
  });
  afterEach(() => db.close());

  it('is honestly unsupported/UNKNOWN with no injected inspector — no updater exists yet', async () => {
    const result = await createDiagnosticsService(serviceDeps(db)).getSummary();
    expect(result.components.update).toEqual({
      status: 'HEALTHY',
      supported: false,
      state: 'UNKNOWN',
      currentVersion: '1.2.3',
      availableVersion: null,
      lastCheckedAt: null,
      issueCode: null,
    });
    expect(Object.keys(result.components.update).sort()).toEqual(
      [
        'status',
        'supported',
        'state',
        'currentVersion',
        'availableVersion',
        'lastCheckedAt',
        'issueCode',
      ].sort(),
    );
  });

  it.each(['UP_TO_DATE', 'AVAILABLE', 'PENDING', 'DEFERRED'] as const)(
    'keeps a supported %s state HEALTHY and never elevates overall status',
    async (state) => {
      const result = await createDiagnosticsService(
        serviceDeps(db, {
          updateStateInspector: {
            inspect: () =>
              Promise.resolve({
                supported: true,
                state,
                currentVersion: '1.2.3',
                availableVersion: state === 'UP_TO_DATE' ? null : '1.3.0',
                lastCheckedAt: '2026-09-12T09:00:00.000Z',
              }),
          },
        }),
      ).getSummary();
      expect(result.components.update.status).toBe('HEALTHY');
      expect(result.components.update.issueCode).toBeNull();
      expect(result.overallStatus).toBe('HEALTHY');
    },
  );

  it('reports a FAILED update state as WARNING and contributes overall WARNING, never CRITICAL', async () => {
    const result = await createDiagnosticsService(
      serviceDeps(db, {
        updateStateInspector: {
          inspect: () =>
            Promise.resolve({
              supported: true,
              state: 'FAILED',
              currentVersion: '1.2.3',
              issueCode: 'UPDATE_INSTALL_FAILED',
            }),
        },
      }),
    ).getSummary();
    expect(result.components.update).toMatchObject({
      status: 'WARNING',
      state: 'FAILED',
      issueCode: 'UPDATE_INSTALL_FAILED',
    });
    expect(result.overallStatus).toBe('WARNING');
  });

  it('never produces CRITICAL from update state alone, even alongside other WARNING components', async () => {
    const result = await createDiagnosticsService(
      serviceDeps(db, {
        getPrinterConfig: () =>
          Promise.resolve({
            selectedDeviceName: 'missing',
            selectedDisplayName: null,
            selectedIsAvailable: false,
          }),
        updateStateInspector: {
          inspect: () =>
            Promise.resolve({ supported: true, state: 'FAILED', currentVersion: '1.2.3' }),
        },
      }),
    ).getSummary();
    expect(result.components.update.status).toBe('WARNING');
    expect(result.components.printer.status).toBe('WARNING');
    expect(result.overallStatus).toBe('WARNING');
  });

  it('fails open to the unsupported/UNKNOWN diagnostic and logs safely when the inspector throws', async () => {
    const capture = createCapturingLogger();
    const result = await createDiagnosticsService(
      serviceDeps(db, {
        logger: capture.logger,
        updateStateInspector: {
          inspect: () => Promise.reject(new Error('C:\\secret\\feed-internal-url')),
        },
      }),
    ).getSummary();
    expect(result.components.update).toMatchObject({ status: 'HEALTHY', state: 'UNKNOWN' });
    expect(result.overallStatus).toBe('HEALTHY');
    expect(
      capture.records.some(
        (entry) =>
          entry.event === 'diagnostics.component.failed' && entry.fields?.component === 'update',
      ),
    ).toBe(true);
    expect(JSON.stringify(capture.records)).not.toContain('C:\\secret');
    expect(JSON.stringify(capture.records)).not.toContain('feed-internal-url');
  });

  it('checkout/database-critical diagnostics remain unaffected by update state', async () => {
    const result = await createDiagnosticsService(
      serviceDeps(db, {
        getDatabase: () => null,
        getDatabaseStatus: () => ({
          state: 'unavailable',
          schemaVersion: null,
          failureCode: 'DB_OPEN_FAILED',
        }),
        updateStateInspector: {
          inspect: () =>
            Promise.resolve({ supported: true, state: 'UP_TO_DATE', currentVersion: '1.2.3' }),
        },
      }),
    ).getSummary();
    expect(result.components.database.status).toBe('CRITICAL');
    expect(result.overallStatus).toBe('CRITICAL');
    expect(result.components.update.status).toBe('HEALTHY');
  });
});
