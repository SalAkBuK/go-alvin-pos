import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createCrashEvidenceService,
  type CrashEvidenceService,
} from '../../src/main/diagnostics/crashEvidence';
import {
  recordChildProcessGone,
  recordMainProcessFailure,
  recordRendererProcessGone,
} from '../../src/main/diagnostics/crashLifecycle';
import { writeRestoreMarker } from '../../src/main/maintenance/restoreMarker';
import { createCapturingLogger, makeTempDir } from '../helpers/database';

const INSTALLATION_ID = 'INST-12345678-1234-4123-8123-123456789ABC';
const BASE_TIME = Date.parse('2026-09-12T12:00:00.000Z');

function idFactory(): () => string {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, '0')}`;
}

function makeService(
  diagnosticsRoot: string,
  overrides: Partial<Parameters<typeof createCrashEvidenceService>[0]> = {},
): CrashEvidenceService {
  return createCrashEvidenceService({
    diagnosticsRoot,
    appVersion: '1.2.3',
    installationId: INSTALLATION_ID,
    logger: createCapturingLogger().logger,
    now: () => new Date(BASE_TIME),
    createId: idFactory(),
    ...overrides,
  });
}

describe('crash evidence and session recovery', () => {
  it('does not create false evidence after a clean session shutdown', () => {
    const temp = makeTempDir('gpp-crash-clean-');
    try {
      const first = makeService(temp.path);
      expect(first.startSession()).toMatch(/^SESSION-/);
      first.markCleanShutdown();

      const second = makeService(temp.path);
      expect(second.startSession()).toMatch(/^SESSION-/);
      expect(second.collectRecent().records).toEqual([]);
    } finally {
      temp.cleanup();
    }
  });

  it('turns a stale running marker into unexpected-previous-termination evidence', () => {
    const temp = makeTempDir('gpp-crash-stale-');
    try {
      expect(makeService(temp.path).startSession()).toMatch(/^SESSION-/);
      const restarted = makeService(temp.path);
      expect(restarted.startSession()).toMatch(/^SESSION-/);

      const records = restarted.collectRecent().records;
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        appVersion: '1.2.3',
        installationId: INSTALLATION_ID,
        processType: 'MAIN',
        eventType: 'unexpected_previous_termination',
        errorCode: 'UNEXPECTED_PREVIOUS_TERMINATION',
      });
      expect(records[0]?.correlationIds?.['previousSessionId']).toMatch(/^SESSION-/);
    } finally {
      temp.cleanup();
    }
  });

  it('replaces a corrupt marker safely without claiming a known termination cause', () => {
    const temp = makeTempDir('gpp-crash-corrupt-marker-');
    const capture = createCapturingLogger();
    try {
      mkdirSync(temp.path, { recursive: true });
      writeFileSync(join(temp.path, 'application-session.json'), '{not-json');
      const service = makeService(temp.path, { logger: capture.logger });

      expect(() => service.startSession()).not.toThrow();
      expect(service.collectRecent().records).toEqual([]);
      expect(
        capture.records.some((record) => record.event === 'crash.session.marker-parse-failed'),
      ).toBe(true);
      expect(() =>
        JSON.parse(readFileSync(join(temp.path, 'application-session.json'), 'utf8')),
      ).not.toThrow();
    } finally {
      temp.cleanup();
    }
  });

  it('records and sanitizes main, renderer, and child failure surfaces', () => {
    const temp = makeTempDir('gpp-crash-surfaces-');
    try {
      const service = makeService(temp.path);
      service.startSession();
      const fatal = new Error(
        'access_token=main-secret at C:\\Users\\Alice\\private.ts customer@example.test 281-555-1234 4111111111111111',
      );
      recordMainProcessFailure(service, fatal, 'uncaughtException');
      recordRendererProcessGone(service, 42, {
        reason: 'crashed C:\\Users\\Alice\\renderer.exe',
        exitCode: 9,
      });
      recordChildProcessGone(service, {
        type: 'Utility',
        reason: 'oom',
        exitCode: 7,
        name: 'Network Service customer@example.test',
        serviceName: 'access_token=child-secret',
      });

      const records = service.collectRecent().records;
      expect(records.map((record) => record.eventType).sort()).toEqual(
        ['child_process_gone', 'main_process_uncaught_exception', 'renderer_process_gone'].sort(),
      );
      const persisted = JSON.stringify(records);
      for (const unsafe of [
        'main-secret',
        'child-secret',
        'C:\\Users\\Alice',
        'customer@example.test',
        '281-555-1234',
        '4111111111111111',
      ]) {
        expect(persisted).not.toContain(unsafe);
      }
      expect(persisted).toContain('[redacted');
    } finally {
      temp.cleanup();
    }
  });

  it('redacts nested credential, customer, path, and payment material before persistence', () => {
    const temp = makeTempDir('gpp-crash-nested-');
    const capture = createCapturingLogger();
    try {
      const service = makeService(temp.path, { logger: capture.logger });
      service.record({
        processType: 'MAIN',
        eventType: 'main_process_uncaught_exception',
        errorCode: 'MAIN_PROCESS_UNCAUGHT_EXCEPTION',
        details: {
          request: { headers: { Authorization: 'Bearer bearer-secret' } },
          oauth: { refresh_token: 'refresh-secret' },
          customer: {
            profile: { name: 'Sensitive Customer', phone: '281-555-9876' },
          },
          payment: { pan: '4111111111111111', cvv: '987', intendedTotalCents: 12345 },
          file: 'C:\\Users\\Alice\\gophones.sqlite',
        },
      });

      expect(
        capture.records.filter((record) => record.event === 'crash.evidence.record-failed'),
      ).toEqual([]);

      const files = readdirSync(join(temp.path, 'crash-evidence'));
      expect(files).toHaveLength(1);
      const persisted = readFileSync(join(temp.path, 'crash-evidence', files[0]!), 'utf8');
      for (const unsafe of [
        'bearer-secret',
        'refresh-secret',
        'Sensitive Customer',
        '281-555-9876',
        '4111111111111111',
        'C:\\Users\\Alice',
      ]) {
        expect(persisted).not.toContain(unsafe);
      }
      const parsed = JSON.parse(persisted) as {
        details: { payment: { cvv: string; intendedTotalCents: string } };
      };
      expect(parsed.details.payment).toMatchObject({
        cvv: '[redacted]',
        intendedTotalCents: '[redacted]',
      });
    } finally {
      temp.cleanup();
    }
  });

  it('enforces the record-count retention bound and survives a new service instance', () => {
    const temp = makeTempDir('gpp-crash-retention-');
    try {
      const service = makeService(temp.path, { maxRecords: 3 });
      for (let index = 0; index < 7; index += 1) {
        service.record({
          processType: 'MAIN',
          eventType: 'main_process_uncaught_exception',
          errorCode: 'MAIN_PROCESS_UNCAUGHT_EXCEPTION',
          details: { safeIndex: index },
        });
      }
      expect(readdirSync(join(temp.path, 'crash-evidence'))).toHaveLength(3);

      const restarted = makeService(temp.path, { maxRecords: 3 });
      expect(restarted.collectRecent().records).toHaveLength(3);
    } finally {
      temp.cleanup();
    }
  });

  it('skips a corrupt evidence file without failing collection', () => {
    const temp = makeTempDir('gpp-crash-corrupt-evidence-');
    const capture = createCapturingLogger();
    try {
      const evidenceRoot = join(temp.path, 'crash-evidence');
      mkdirSync(evidenceRoot, { recursive: true });
      writeFileSync(
        join(evidenceRoot, 'crash-CE-11111111-1111-4111-8111-111111111111.json'),
        '{bad-json',
      );
      const service = makeService(temp.path, { logger: capture.logger });
      const result = service.collectRecent();

      expect(result.records).toEqual([]);
      expect(result.inspectedFiles).toBe(1);
      expect(result.issues).toEqual(['CRASH_EVIDENCE_RECORD_SKIPPED']);
      expect(capture.records.some((record) => record.event === 'crash.evidence.parse-failed')).toBe(
        true,
      );
    } finally {
      temp.cleanup();
    }
  });

  it('never blocks startup when crash storage is unavailable', () => {
    const temp = makeTempDir('gpp-crash-unavailable-');
    try {
      const occupied = join(temp.path, 'not-a-directory');
      writeFileSync(occupied, 'occupied');
      const service = makeService(occupied);
      expect(() => service.startSession()).not.toThrow();
      expect(() =>
        service.record({
          processType: 'MAIN',
          eventType: 'main_process_uncaught_exception',
        }),
      ).not.toThrow();
      expect(service.collectRecent().records).toEqual([]);
    } finally {
      temp.cleanup();
    }
  });

  it('does not alter the independent Phase 2L restore marker', () => {
    const temp = makeTempDir('gpp-crash-restore-marker-');
    try {
      const restoreMarker = {
        version: 1 as const,
        preRestoreFileName: 'gophones-pre-restore-v1-2026-09-10T09-00-00-000Z-abcd.sqlite',
        startedAt: '2026-09-10T09:00:00.000Z',
      };
      writeRestoreMarker(temp.path, restoreMarker);
      const before = readFileSync(join(temp.path, 'restore-in-progress.json'), 'utf8');

      const service = makeService(join(temp.path, 'diagnostics'));
      service.startSession();
      service.markCleanShutdown();

      expect(readFileSync(join(temp.path, 'restore-in-progress.json'), 'utf8')).toBe(before);
    } finally {
      temp.cleanup();
    }
  });
});
