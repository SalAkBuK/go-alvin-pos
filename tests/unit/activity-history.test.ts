import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Logger } from '../../src/main/app/logger';
import {
  ACTIVITY_HISTORY_MAX_ENTRIES,
  createActivityHistoryService,
} from '../../src/main/diagnostics/activityHistory';
import { collectRecentSanitizedLogRecords } from '../../src/main/support/recentLogs';
import { createCapturingLogger, makeTempDir } from '../helpers/database';

/** A real Logger instance writing genuine JSONL lines, so tests exercise the actual on-disk format. */
function realLogger(dir: string, now: () => Date): Logger {
  return new Logger({ dir, installationId: 'INST-TEST', minLevel: 'debug', now });
}

function tickingClock(startIso: string): () => Date {
  let ms = Date.parse(startIso);
  return () => {
    const value = new Date(ms);
    ms += 1000;
    return value;
  };
}

describe('activity history mapping (approved events → friendly entries)', () => {
  it('maps checkout.completed to a friendly sale-completed entry with the receipt number preserved', async () => {
    const temp = makeTempDir('gpp-activity-completed-');
    try {
      const log = realLogger(temp.path, tickingClock('2026-09-12T10:00:00.000Z'));
      log.info('checkout', 'checkout.completed', {
        checkoutRequestId: 'CR-1',
        saleId: 'SALE-1',
        receiptNumber: 'GP-000123',
        paymentMethod: 'CASH',
        durationMs: 42,
      });
      const service = createActivityHistoryService({
        logsRoot: temp.path,
        logger: createCapturingLogger().logger,
      });
      const history = await service.getRecent();
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({
        severity: 'INFO',
        title: 'Sale completed',
        detail: 'Sale GP-000123 was completed and saved.',
        receiptNumber: 'GP-000123',
      });
    } finally {
      temp.cleanup();
    }
  });

  it('distinguishes a possible-card-charge failure from an ordinary sale-save failure', async () => {
    const temp = makeTempDir('gpp-activity-card-fail-');
    try {
      const log = realLogger(temp.path, tickingClock('2026-09-12T10:00:00.000Z'));
      log.error('checkout', 'checkout.failed', {
        checkoutRequestId: 'CR-2',
        paymentMethod: 'CARD',
        errorCode: 'CARD_LOCAL_COMMIT_FAILURE',
        durationMs: 10,
      });
      log.error('checkout', 'checkout.failed', {
        checkoutRequestId: 'CR-3',
        paymentMethod: 'CASH',
        errorCode: 'SALE_COMMIT_FAILED',
        durationMs: 10,
      });
      const service = createActivityHistoryService({
        logsRoot: temp.path,
        logger: createCapturingLogger().logger,
      });
      const history = await service.getRecent();
      expect(history.entries).toHaveLength(2);
      // newest-first: the CASH failure was logged second.
      expect(history.entries[0]).toMatchObject({
        title: 'A sale could not be saved',
        errorCode: 'SALE_COMMIT_FAILED',
      });
      expect(history.entries[1]).toMatchObject({
        title: 'A card charge may need review',
        errorCode: 'CARD_LOCAL_COMMIT_FAILURE',
      });
      expect(history.entries[1]!.detail).toMatch(/reconciliation queue/i);
    } finally {
      temp.cleanup();
    }
  });

  it('omits an unmapped/unknown technical event entirely', async () => {
    const temp = makeTempDir('gpp-activity-unknown-');
    try {
      const log = realLogger(temp.path, tickingClock('2026-09-12T10:00:00.000Z'));
      log.error('google', 'google.config.reconcile-failed', { error: 'unexpected' });
      log.info('migration', 'database.migrations.applied', { count: 1 });
      const service = createActivityHistoryService({
        logsRoot: temp.path,
        logger: createCapturingLogger().logger,
      });
      const history = await service.getRecent();
      expect(history.entries).toEqual([]);
    } finally {
      temp.cleanup();
    }
  });

  it('never lets an unexpected context field (path/token/PII-shaped) reach the friendly entry', async () => {
    const temp = makeTempDir('gpp-activity-defense-');
    try {
      const log = realLogger(temp.path, tickingClock('2026-09-12T10:00:00.000Z'));
      log.error('printing', 'printing.failed', {
        saleId: 'SALE-9',
        errorCode: 'PRINT_FAILED',
        // Fields that must never appear in the friendly entry even if present.
        path: 'C:\\Users\\Alice\\AppData\\gophones.sqlite',
        stack: 'Error: boom\n at printer.ts:42',
        token: 'super-secret-token',
        customerEmail: 'jane@example.test',
      });
      const service = createActivityHistoryService({
        logsRoot: temp.path,
        logger: createCapturingLogger().logger,
      });
      const history = await service.getRecent();
      expect(history.entries).toHaveLength(1);
      const serialized = JSON.stringify(history.entries[0]);
      for (const unsafe of [
        'C:\\Users\\Alice',
        'AppData',
        'boom',
        'printer.ts',
        'super-secret-token',
        'jane@example.test',
      ]) {
        expect(serialized).not.toContain(unsafe);
      }
      expect(history.entries[0]).toMatchObject({
        title: 'Receipt could not be printed',
        detail: 'The sale was saved successfully, but the printer was unavailable.',
      });
    } finally {
      temp.cleanup();
    }
  });

  it('frames Google export delay/failure and backup failure as local-sale-is-safe secondary issues', async () => {
    const temp = makeTempDir('gpp-activity-secondary-');
    try {
      const log = realLogger(temp.path, tickingClock('2026-09-12T10:00:00.000Z'));
      log.warn('export', 'google.export.retry_scheduled', {
        saleId: 'SALE-4',
        exportJobId: 'JOB-1',
        category: 'RATE_LIMIT',
        httpStatus: 429,
        attemptCount: 2,
      });
      log.error('google', 'google.export.failed', {
        saleId: 'SALE-5',
        exportJobId: 'JOB-2',
        category: 'AUTH',
        httpStatus: 401,
        attemptCount: 10,
      });
      log.error('backup', 'backup.failed', {
        backupType: 'AUTOMATIC',
        stage: 'snapshot',
        errorCode: 'BACKUP_WRITE_FAILED',
        osErrorCode: 'ENOSPC',
      });
      const service = createActivityHistoryService({
        logsRoot: temp.path,
        logger: createCapturingLogger().logger,
      });
      const history = await service.getRecent();
      expect(history.entries).toHaveLength(3);
      for (const entry of history.entries) {
        expect(entry.detail.toLowerCase()).toContain('safe');
      }
    } finally {
      temp.cleanup();
    }
  });

  it('maps crash-evidence eventType, clock-change, disk-space, and support-action failures', async () => {
    const temp = makeTempDir('gpp-activity-diagnostics-');
    try {
      const log = realLogger(temp.path, tickingClock('2026-09-12T10:00:00.000Z'));
      log.info('diagnostics', 'crash.evidence.recorded', {
        evidenceId: 'CE-1',
        processType: 'MAIN',
        eventType: 'unexpected_previous_termination',
      });
      log.warn('application', 'clock.change.detected', {
        previousObservedTime: '2026-09-12T09:00:00.000Z',
        currentObservedTime: '2026-09-12T09:20:00.000Z',
        differenceMs: 1_200_000,
        direction: 'FORWARD',
      });
      log.warn('diagnostics', 'diagnostics.disk-space.low', {
        errorCode: 'DISK_SPACE_CRITICAL',
        availableBytes: 300 * 1024 ** 2,
      });
      log.error('diagnostics', 'support.report.creation-failed', {
        supportReportId: undefined,
        errorCode: 'SUPPORT_REPORT_CREATE_FAILED',
      });
      const service = createActivityHistoryService({
        logsRoot: temp.path,
        logger: createCapturingLogger().logger,
      });
      const history = await service.getRecent();
      expect(history.entries.map((entry) => entry.title)).toEqual([
        'A support report could not be created',
        'Critically low disk space',
        'A significant system clock change was detected',
        'The application did not close normally last time',
      ]);
      const disk = history.entries.find((entry) => entry.title === 'Critically low disk space');
      expect(disk?.severity).toBe('ERROR');
      expect(disk?.detail).toContain('300 MB');
    } finally {
      temp.cleanup();
    }
  });

  it('omits an unrecognized crash-evidence eventType rather than fabricating one', async () => {
    const temp = makeTempDir('gpp-activity-crash-unknown-');
    try {
      const log = realLogger(temp.path, tickingClock('2026-09-12T10:00:00.000Z'));
      log.info('diagnostics', 'crash.evidence.recorded', {
        evidenceId: 'CE-2',
        processType: 'MAIN',
        eventType: 'some_future_event_type',
      });
      const service = createActivityHistoryService({
        logsRoot: temp.path,
        logger: createCapturingLogger().logger,
      });
      const history = await service.getRecent();
      expect(history.entries).toEqual([]);
    } finally {
      temp.cleanup();
    }
  });
});

describe('activity history bounds and fail-open reading', () => {
  it('returns entries newest-first', async () => {
    const temp = makeTempDir('gpp-activity-order-');
    try {
      const log = realLogger(temp.path, tickingClock('2026-09-12T10:00:00.000Z'));
      log.info('checkout', 'checkout.completed', { receiptNumber: 'GP-000001' });
      log.info('checkout', 'checkout.completed', { receiptNumber: 'GP-000002' });
      log.info('checkout', 'checkout.completed', { receiptNumber: 'GP-000003' });
      const service = createActivityHistoryService({
        logsRoot: temp.path,
        logger: createCapturingLogger().logger,
      });
      const history = await service.getRecent();
      expect(history.entries.map((entry) => entry.receiptNumber)).toEqual([
        'GP-000003',
        'GP-000002',
        'GP-000001',
      ]);
    } finally {
      temp.cleanup();
    }
  });

  it(`never returns more than ${ACTIVITY_HISTORY_MAX_ENTRIES} entries`, async () => {
    const temp = makeTempDir('gpp-activity-bound-');
    try {
      const log = realLogger(temp.path, tickingClock('2026-09-12T10:00:00.000Z'));
      for (let index = 0; index < ACTIVITY_HISTORY_MAX_ENTRIES + 10; index += 1) {
        log.info('checkout', 'checkout.completed', {
          receiptNumber: `GP-${String(index).padStart(6, '0')}`,
        });
      }
      const service = createActivityHistoryService({
        logsRoot: temp.path,
        logger: createCapturingLogger().logger,
      });
      const history = await service.getRecent();
      expect(history.entries).toHaveLength(ACTIVITY_HISTORY_MAX_ENTRIES);
    } finally {
      temp.cleanup();
    }
  });

  it('skips a malformed log line safely and keeps the surrounding valid entries', async () => {
    const temp = makeTempDir('gpp-activity-malformed-');
    try {
      mkdirSync(temp.path, { recursive: true });
      const lines = [
        JSON.stringify({
          timestamp: '2026-09-12T10:00:00.000Z',
          level: 'info',
          category: 'checkout',
          event: 'checkout.completed',
          installationId: 'INST-TEST',
          correlationIds: { receiptNumber: 'GP-000001' },
          context: {},
        }),
        '{not-json-at-all',
        JSON.stringify({
          timestamp: '2026-09-12T10:00:02.000Z',
          level: 'info',
          category: 'checkout',
          event: 'checkout.completed',
          installationId: 'INST-TEST',
          correlationIds: { receiptNumber: 'GP-000002' },
          context: {},
        }),
      ];
      writeFileSync(join(temp.path, 'main.log'), `${lines.join('\n')}\n`, 'utf8');

      const service = createActivityHistoryService({
        logsRoot: temp.path,
        logger: createCapturingLogger().logger,
      });
      const history = await service.getRecent();
      expect(history.entries.map((entry) => entry.receiptNumber)).toEqual([
        'GP-000002',
        'GP-000001',
      ]);
    } finally {
      temp.cleanup();
    }
  });

  it('returns an empty history when no log files exist yet', async () => {
    const temp = makeTempDir('gpp-activity-missing-');
    try {
      const service = createActivityHistoryService({
        logsRoot: join(temp.path, 'does-not-exist'),
        logger: createCapturingLogger().logger,
      });
      const history = await service.getRecent();
      expect(history.entries).toEqual([]);
    } finally {
      temp.cleanup();
    }
  });

  it('fails open to an empty history (never throws) when the log directory cannot be read', async () => {
    const temp = makeTempDir('gpp-activity-unreadable-');
    try {
      const occupied = join(temp.path, 'not-a-directory');
      writeFileSync(occupied, 'occupied', 'utf8');
      const capture = createCapturingLogger();
      const service = createActivityHistoryService({ logsRoot: occupied, logger: capture.logger });
      await expect(service.getRecent()).resolves.toEqual(expect.objectContaining({ entries: [] }));
    } finally {
      temp.cleanup();
    }
  });

  it('collectRecentSanitizedLogRecords itself is bounded by record count, not just bytes', async () => {
    const temp = makeTempDir('gpp-activity-records-bound-');
    try {
      const log = realLogger(temp.path, tickingClock('2026-09-12T10:00:00.000Z'));
      for (let index = 0; index < 20; index += 1) {
        log.info('checkout', 'checkout.completed', { receiptNumber: `GP-${index}` });
      }
      const { records, inspectedFiles } = await collectRecentSanitizedLogRecords(temp.path, 5);
      expect(records).toHaveLength(5);
      expect(inspectedFiles).toBeGreaterThan(0);
    } finally {
      temp.cleanup();
    }
  });
});
