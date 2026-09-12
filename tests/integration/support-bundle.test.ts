import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DiagnosticSnapshot } from '../../src/shared/diagnostics';
import type { ProductionDatabase } from '../../src/main/database/database';
import { createSupportBundleService } from '../../src/main/support/supportBundleService';
import { collectRecentSanitizedLogs } from '../../src/main/support/recentLogs';
import { createCrashEvidenceService } from '../../src/main/diagnostics/crashEvidence';
import { createMigratedDb, createCapturingLogger, makeTempDir } from '../helpers/database';

const NOW = new Date('2026-09-12T15:30:00.000Z');
const REPORT_ID = 'SPR-20260912-0123456789ABCDEF';

function diagnostics(): DiagnosticSnapshot {
  return {
    generatedAt: NOW.toISOString(),
    mode: 'SUMMARY',
    application: {
      version: '1.2.3',
      buildIdentifier: 'build-safe',
      installationId: 'INST-TESTSAFE',
    },
    runtime: {
      platform: 'win32',
      osRelease: '11',
      arch: 'x64',
      electron: '44.2.0',
      node: '24.0.0',
    },
    overallStatus: 'WARNING',
    components: {
      database: {
        status: 'HEALTHY',
        open: true,
        schemaVersion: 1,
        expectedSchemaVersion: 1,
        migrationStateValid: true,
        foreignKeysEnabled: true,
        criticalTablesAvailable: true,
        quickCheck: 'NOT_RUN',
        issueCodes: [],
      },
      disk: {
        status: 'HEALTHY',
        inspectionAvailable: true,
        availableBytes: 10_000_000_000,
        warningBelowBytes: 2_000_000_000,
        criticalBelowBytes: 500_000_000,
        issueCode: null,
      },
      backup: {
        status: 'HEALTHY',
        lastSuccessfulLocalAt: '2026-09-12T08:00:00.000Z',
        lastLocalFailure: null,
        localOverdue: false,
        offDevice: { state: 'NOT_CONFIGURED' },
        issueCode: null,
      },
      google: {
        status: 'WARNING',
        enabled: true,
        setupState: 'READY',
        needsReauthorization: false,
        setupNeedsAttention: false,
        pendingExports: 2,
        exportingExports: 1,
        failedExports: 3,
        lastSuccessfulExportAt: '2026-09-12T14:00:00.000Z',
        issueCode: 'GOOGLE_EXPORT_BACKLOG',
      },
      cardReconciliation: { status: 'HEALTHY', unresolvedCount: 0, issueCode: null },
      printer: {
        status: 'HEALTHY',
        state: 'AVAILABLE',
        configuredName: 'Receipt Printer',
        availabilitySupported: true,
        printHistorySupported: false,
        lastSuccessfulPrintAt: null,
        lastFailedPrintAt: null,
        issueCode: null,
      },
      connectivity: {
        status: 'WARNING',
        supported: true,
        state: 'OFFLINE',
        issueCode: 'INTERNET_OFFLINE',
      },
    },
  };
}

function readZipEntries(archive: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 30 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = archive.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, inflateRawSync(compressed));
    offset = dataStart + compressedSize;
  }
  return entries;
}

describe('problem reports and support bundles', () => {
  it('includes re-sanitized recent crash evidence when available', async () => {
    const temp = makeTempDir('gpp-support-crash-evidence-');
    const capture = createCapturingLogger();
    try {
      const crashEvidence = createCrashEvidenceService({
        diagnosticsRoot: join(temp.path, 'diagnostics'),
        appVersion: '1.2.3',
        installationId: 'INST-12345678-1234-4123-8123-123456789ABC',
        logger: capture.logger,
        now: () => NOW,
        createId: () => '11111111-1111-4111-8111-111111111111',
      });
      crashEvidence.record({
        processType: 'RENDERER',
        eventType: 'renderer_process_gone',
        errorCode: 'RENDERER_PROCESS_GONE',
        termination: { reason: 'crashed', exitCode: 9 },
        details: {
          customer: { name: 'Private Customer', phone: '281-555-2222' },
          access_token: 'bundle-token-sentinel',
          path: 'C:\\Users\\Alice\\renderer.js',
        },
      });
      const service = createSupportBundleService({
        appVersion: '1.2.3',
        installationId: 'INST-TESTSAFE',
        reportsRoot: join(temp.path, 'reports'),
        logsRoot: join(temp.path, 'logs'),
        logger: capture.logger,
        getDatabase: () => null,
        getDiagnostics: () => Promise.resolve(diagnostics()),
        getCrashEvidence: () => crashEvidence.collectRecent(),
        now: () => NOW,
        randomHex: () => '0123456789abcdef',
      });

      const entries = readZipEntries((await service.prepareBundle()).archive);
      expect(entries.has('crash-evidence.json')).toBe(true);
      const crashText = entries.get('crash-evidence.json')!.toString('utf8');
      expect(crashText).toContain('renderer_process_gone');
      expect(crashText).toContain('INST-12345678-1234-4123-8123-123456789ABC');
      for (const unsafe of [
        'Private Customer',
        '281-555-2222',
        'bundle-token-sentinel',
        'C:\\Users\\Alice',
      ]) {
        expect(crashText).not.toContain(unsafe);
      }
      expect(entries.get('bundle-manifest.json')!.toString('utf8')).toContain(
        '"crashEvidence": true',
      );
    } finally {
      temp.cleanup();
    }
  });

  it('creates a sanitized offline report with diagnostics and no business-data mutation', async () => {
    const temp = makeTempDir('gpp-support-report-');
    const db = await createMigratedDb();
    try {
      const before = db.prepare('SELECT total_changes() AS n').get() as { n: number };
      const service = createSupportBundleService({
        appVersion: '1.2.3',
        installationId: 'INST-TESTSAFE',
        reportsRoot: join(temp.path, 'reports'),
        logsRoot: join(temp.path, 'logs'),
        logger: createCapturingLogger().logger,
        getDatabase: () => ({ connection: db, closed: false }) as unknown as ProductionDatabase,
        getDiagnostics: () => Promise.resolve(diagnostics()),
        now: () => NOW,
        randomHex: () => '0123456789abcdef',
      });

      const report = await service.createProblemReport({
        description:
          'Printing failed at C:\\Users\\Alice\\receipt.txt for alice@example.test; refresh_token=secret-refresh',
        category: 'PRINTING',
        receiptNumber: 'gp-000123',
      });

      expect(report).toMatchObject({
        supportReportId: REPORT_ID,
        category: 'PRINTING',
        receiptNumber: 'GP-000123',
        appVersion: '1.2.3',
        schemaVersion: 1,
        installationId: 'INST-TESTSAFE',
      });
      expect(report.diagnostics.components.connectivity.state).toBe('OFFLINE');
      expect(report.description).toContain('[redacted-path]');
      expect(report.description).toContain('[redacted-email]');
      expect(report.description).not.toContain('secret-refresh');
      expect(existsSync(join(temp.path, 'reports', `${REPORT_ID}.json`))).toBe(true);

      const after = db.prepare('SELECT total_changes() AS n').get() as { n: number };
      expect(after.n).toBe(before.n);
    } finally {
      db.close();
      temp.cleanup();
    }
  });

  it('exports expected safe entries, bounded sanitized logs, and no database or credentials', async () => {
    const temp = makeTempDir('gpp-support-bundle-');
    const db = await createMigratedDb();
    const logsRoot = join(temp.path, 'logs');
    mkdirSync(logsRoot, { recursive: true });
    const sentinels = {
      password: 'plain-password-sentinel',
      access: 'ya29.access-token-sentinel',
      refresh: '1//refresh-token-sentinel',
      authorizationCode: '4/authorization-code-sentinel',
      verifier: 'pkce-verifier-sentinel',
      idToken: 'eyJ123456789.abcdefghijk.zyxwvutsrq',
      apiSecret: 'api-secret-sentinel',
      card: '4111111111111111',
      cvv: '987',
      customerName: 'Sensitive Customer Name',
      customerEmail: 'customer@example.test',
      customerPhone: '281-555-1234',
    };
    writeFileSync(
      join(logsRoot, 'main.log'),
      `${JSON.stringify({
        timestamp: NOW.toISOString(),
        level: 'error',
        category: 'google',
        event: 'test.failed',
        installationId: 'INST-TESTSAFE',
        context: {
          password: sentinels.password,
          access_token: sentinels.access,
          response: { nested: { refresh_token: sentinels.refresh, id_token: sentinels.idToken } },
          authorization_code: sentinels.authorizationCode,
          code_verifier: sentinels.verifier,
          apiSecret: sentinels.apiSecret,
          headers: { Authorization: `Bearer ${sentinels.access}` },
          payment: { number: sentinels.card, cvv: sentinels.cvv, trackData: 'track-sentinel' },
          customer: {
            profile: {
              name: sentinels.customerName,
              email: sentinels.customerEmail,
              phone: sentinels.customerPhone,
            },
          },
          safe: 'printer retry',
        },
      })}\nthis is a corrupt optional log record\n`,
    );
    mkdirSync(join(logsRoot, 'main.log.1'));
    writeFileSync(join(temp.path, 'gophones.sqlite'), 'must not be included');
    writeFileSync(join(temp.path, 'google-oauth.enc'), 'encrypted-wrapper-sentinel');

    try {
      const capture = createCapturingLogger();
      const service = createSupportBundleService({
        appVersion: '1.2.3',
        buildIdentifier: 'build-safe',
        installationId: 'INST-TESTSAFE',
        reportsRoot: join(temp.path, 'reports'),
        logsRoot,
        logger: capture.logger,
        getDatabase: () => ({ connection: db, closed: false }) as unknown as ProductionDatabase,
        getDiagnostics: () => Promise.resolve(diagnostics()),
        now: () => NOW,
        randomHex: () => '0123456789abcdef',
      });
      await service.createProblemReport({
        description: `Do not use ${sentinels.customerEmail} or C:\\private\\db; password=${sentinels.password}`,
        category: 'OTHER',
      });
      const changesBefore = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
      const prepared = await service.prepareBundle({ supportReportId: REPORT_ID });
      expect(prepared.suggestedFileName).toBe(`GoPhonesPOS-Support-2026-09-12-${REPORT_ID}.zip`);
      expect(prepared.suggestedFileName).toMatch(/^[A-Za-z0-9.-]+\.zip$/);

      const destination = join(temp.path, prepared.suggestedFileName);
      const result = await service.writePreparedBundle(prepared, destination);
      expect(result).toMatchObject({
        status: 'COMPLETED',
        fileName: prepared.suggestedFileName,
        supportReportId: REPORT_ID,
      });
      expect(existsSync(destination)).toBe(true);

      const entries = readZipEntries(readFileSync(destination));
      expect([...entries.keys()].sort()).toEqual(
        [
          'backup-status.json',
          'bundle-manifest.json',
          'diagnostics.json',
          'export-queue-summary.json',
          'migration-history.json',
          'problem-report.json',
          'recent-app.log',
          'support-info.json',
        ].sort(),
      );
      expect([...entries.keys()].every((name) => !name.includes('/') && !name.includes('..'))).toBe(
        true,
      );
      expect([...entries.keys()]).not.toContain('gophones.sqlite');
      expect([...entries.keys()]).not.toContain('google-oauth.enc');

      const allText = [...entries.values()].map((value) => value.toString('utf8')).join('\n');
      for (const sentinel of Object.values(sentinels)) expect(allText).not.toContain(sentinel);
      expect(allText).not.toContain('encrypted-wrapper-sentinel');
      expect(allText).not.toContain('must not be included');
      expect(allText).toContain('printer retry');
      expect(allText).toContain('LOG_RECORD_SKIPPED');
      expect(allText).toContain('LOG_FILE_UNREADABLE');
      expect(allText).toContain('initial_schema');
      expect(allText).toContain('"pending": 2');
      expect(allText).toContain('"databaseIncluded": false');
      expect(allText).toContain('"oauthWrapperIncluded": false');

      const changesAfter = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
      expect(changesAfter).toBe(changesBefore);
      expect(capture.records.some((record) => record.event === 'support.bundle.exported')).toBe(
        true,
      );
      expect(JSON.stringify(capture.records)).not.toContain(temp.path);
    } finally {
      db.close();
      temp.cleanup();
    }
  });

  it('bounds recent logs and safely reports an unavailable log directory', async () => {
    const temp = makeTempDir('gpp-support-logs-');
    try {
      const unavailable = await collectRecentSanitizedLogs(join(temp.path, 'missing'), 256, 2);
      expect(unavailable).toMatchObject({
        content: '',
        includedRecords: 0,
        issues: ['LOG_DIRECTORY_UNAVAILABLE'],
      });

      const logs = join(temp.path, 'logs');
      mkdirSync(logs);
      writeFileSync(
        join(logs, 'main.log'),
        Array.from({ length: 100 }, (_, index) =>
          JSON.stringify({
            timestamp: NOW.toISOString(),
            level: 'info',
            category: 'diagnostics',
            event: 'test.event',
            installationId: 'INST-TESTSAFE',
            context: { index, safe: 'x'.repeat(30) },
          }),
        ).join('\n'),
      );
      const collected = await collectRecentSanitizedLogs(logs, 256, 1);
      expect(Buffer.byteLength(collected.content, 'utf8')).toBeLessThanOrEqual(256);
      expect(collected.issues).toContain('LOG_INPUT_TRUNCATED');
      expect(collected.content).toContain('"index":99');
      expect(collected.content).not.toContain('"index":0');
    } finally {
      temp.cleanup();
    }
  });

  it('isolates report-file failure from SQLite and records only sanitized failure evidence', async () => {
    const temp = makeTempDir('gpp-support-failure-');
    const db = await createMigratedDb();
    const blockedRoot = join(temp.path, 'not-a-directory');
    writeFileSync(blockedRoot, 'occupied');
    try {
      const capture = createCapturingLogger();
      const service = createSupportBundleService({
        appVersion: '1.2.3',
        installationId: 'INST-TESTSAFE',
        reportsRoot: blockedRoot,
        logsRoot: join(temp.path, 'logs'),
        logger: capture.logger,
        getDatabase: () => ({ connection: db, closed: false }) as unknown as ProductionDatabase,
        getDiagnostics: () => Promise.resolve(diagnostics()),
        now: () => NOW,
        randomHex: () => '0123456789abcdef',
      });
      const before = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
      await expect(
        service.createProblemReport({ description: 'Could not print.', category: 'PRINTING' }),
      ).rejects.toThrow();
      const after = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
      expect(after).toBe(before);
      expect(capture.records).toContainEqual(
        expect.objectContaining({
          level: 'error',
          category: 'diagnostics',
          event: 'support.report.creation-failed',
          fields: expect.objectContaining({
            supportReportId: REPORT_ID,
            errorCode: 'SUPPORT_REPORT_CREATE_FAILED',
          }),
        }),
      );
      expect(JSON.stringify(capture.records)).not.toContain(temp.path);
    } finally {
      db.close();
      temp.cleanup();
    }
  });
});
