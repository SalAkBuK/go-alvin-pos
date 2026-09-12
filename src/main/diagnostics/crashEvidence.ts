import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { ContextLogger } from '../app/logger';
import {
  assertPrivacySafeText,
  sanitizeSupportText,
  sanitizeSupportValue,
} from '../support/supportPrivacy';

export const CRASH_EVIDENCE_FORMAT_VERSION = 1 as const;
export const CRASH_SESSION_MARKER_VERSION = 1 as const;
export const DEFAULT_CRASH_EVIDENCE_MAX_RECORDS = 20;
export const DEFAULT_CRASH_EVIDENCE_MAX_AGE_DAYS = 30;
export const CRASH_EVIDENCE_MAX_FILE_BYTES = 128 * 1024;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const EVIDENCE_FILE_PATTERN = /^crash-(CE-[0-9A-F-]{36})\.json$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,99}$/;

export type CrashProcessType = 'MAIN' | 'RENDERER' | 'CHILD';
export type CrashEventType =
  | 'unexpected_previous_termination'
  | 'main_process_uncaught_exception'
  | 'main_process_unhandled_rejection'
  | 'renderer_process_gone'
  | 'child_process_gone';

export interface CrashEvidenceRecord {
  readonly formatVersion: 1;
  readonly evidenceId: string;
  readonly timestamp: string;
  readonly appVersion: string;
  readonly installationId: string;
  readonly sessionId: string | null;
  readonly schemaVersion: number | null;
  readonly processType: CrashProcessType;
  readonly eventType: CrashEventType;
  readonly errorCode: string | null;
  readonly exception?: unknown;
  readonly termination?: {
    readonly reason: string | null;
    readonly exitCode: number | null;
  };
  readonly correlationIds?: Readonly<Record<string, string>>;
  readonly details?: unknown;
}

export interface CrashEvidenceCollection {
  readonly records: readonly CrashEvidenceRecord[];
  readonly inspectedFiles: number;
  readonly issues: readonly string[];
}

export interface CrashEvidenceInput {
  readonly processType: CrashProcessType;
  readonly eventType: CrashEventType;
  readonly errorCode?: string | null;
  readonly exception?: unknown;
  readonly termination?: {
    readonly reason?: string | null;
    readonly exitCode?: number | null;
  };
  readonly correlationIds?: Readonly<Record<string, unknown>>;
  readonly details?: unknown;
}

export interface CrashEvidenceServiceOptions {
  readonly diagnosticsRoot: string;
  readonly appVersion: string;
  readonly installationId: string;
  readonly logger: ContextLogger;
  readonly getSchemaVersion?: () => number | null;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly maxRecords?: number;
  readonly maxAgeDays?: number;
}

export interface CrashEvidenceService {
  startSession(): string | null;
  markCleanShutdown(): void;
  record(input: CrashEvidenceInput): CrashEvidenceRecord | null;
  collectRecent(): CrashEvidenceCollection;
}

interface SessionMarker {
  readonly formatVersion: 1;
  readonly sessionId: string;
  readonly state: 'RUNNING' | 'CLEAN';
  readonly startedAt: string;
  readonly endedAt?: string;
}

type SessionMarkerReadResult =
  | { readonly present: false }
  | { readonly present: true; readonly marker: SessionMarker }
  | { readonly present: true; readonly corrupt: true };

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function safeLog(action: () => void): void {
  try {
    action();
  } catch {
    // A diagnostic logger failure must never recurse into crash collection.
  }
}

function atomicWrite(filePath: string, body: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeSync(descriptor, body, undefined, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, filePath);
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original write error.
      }
    }
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Best effort cleanup only.
    }
    throw error;
  }
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isSessionMarker(value: unknown): value is SessionMarker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const marker = value as Partial<SessionMarker>;
  return (
    marker.formatVersion === CRASH_SESSION_MARKER_VERSION &&
    typeof marker.sessionId === 'string' &&
    SAFE_IDENTIFIER_PATTERN.test(marker.sessionId) &&
    (marker.state === 'RUNNING' || marker.state === 'CLEAN') &&
    validDate(marker.startedAt) &&
    (marker.endedAt === undefined || validDate(marker.endedAt))
  );
}

function readSessionMarker(filePath: string): SessionMarkerReadResult {
  if (!existsSync(filePath)) return { present: false };
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    return isSessionMarker(parsed)
      ? { present: true, marker: parsed }
      : { present: true, corrupt: true };
  } catch {
    return { present: true, corrupt: true };
  }
}

function safeCorrelationIds(
  value: Readonly<Record<string, unknown>> | undefined,
): Record<string, string> {
  if (!value) return {};
  const result: Record<string, string> = {};
  for (const [key, child] of Object.entries(value).slice(0, 20)) {
    if (
      SAFE_IDENTIFIER_PATTERN.test(key) &&
      typeof child === 'string' &&
      SAFE_IDENTIFIER_PATTERN.test(child)
    ) {
      result[key] = child;
    }
  }
  return result;
}

function isCrashEvidenceRecord(value: unknown): value is CrashEvidenceRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<CrashEvidenceRecord>;
  const validTermination =
    record.termination === undefined ||
    (record.termination !== null &&
      typeof record.termination === 'object' &&
      (record.termination.reason === null || typeof record.termination.reason === 'string') &&
      (record.termination.exitCode === null ||
        (typeof record.termination.exitCode === 'number' &&
          Number.isSafeInteger(record.termination.exitCode))));
  return (
    record.formatVersion === CRASH_EVIDENCE_FORMAT_VERSION &&
    typeof record.evidenceId === 'string' &&
    /^CE-[0-9A-F-]{36}$/.test(record.evidenceId) &&
    validDate(record.timestamp) &&
    typeof record.appVersion === 'string' &&
    typeof record.installationId === 'string' &&
    (record.sessionId === null ||
      (typeof record.sessionId === 'string' && SAFE_IDENTIFIER_PATTERN.test(record.sessionId))) &&
    (record.schemaVersion === null ||
      (typeof record.schemaVersion === 'number' && Number.isSafeInteger(record.schemaVersion))) &&
    (record.processType === 'MAIN' ||
      record.processType === 'RENDERER' ||
      record.processType === 'CHILD') &&
    (record.eventType === 'unexpected_previous_termination' ||
      record.eventType === 'main_process_uncaught_exception' ||
      record.eventType === 'main_process_unhandled_rejection' ||
      record.eventType === 'renderer_process_gone' ||
      record.eventType === 'child_process_gone') &&
    (record.errorCode === null ||
      (typeof record.errorCode === 'string' && SAFE_ERROR_CODE_PATTERN.test(record.errorCode))) &&
    validTermination
  );
}

function sanitizeRecord(record: CrashEvidenceRecord): CrashEvidenceRecord {
  const sanitized = sanitizeSupportValue(record);
  if (!isCrashEvidenceRecord(sanitized)) {
    throw new Error('Crash evidence failed validation after sanitization.');
  }
  const text = JSON.stringify(sanitized);
  assertPrivacySafeText(text);
  return sanitized;
}

/**
 * Privacy-safe crash evidence stored outside the authoritative business database.
 * All public methods fail open so diagnostics can never prevent POS startup.
 */
export function createCrashEvidenceService(
  options: CrashEvidenceServiceOptions,
): CrashEvidenceService {
  const evidenceRoot = join(options.diagnosticsRoot, 'crash-evidence');
  const markerFile = join(options.diagnosticsRoot, 'application-session.json');
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? (() => randomUUID().toUpperCase());
  const maxRecords = Math.max(1, options.maxRecords ?? DEFAULT_CRASH_EVIDENCE_MAX_RECORDS);
  const maxAgeMs =
    Math.max(1, options.maxAgeDays ?? DEFAULT_CRASH_EVIDENCE_MAX_AGE_DAYS) * MILLISECONDS_PER_DAY;
  let activeMarker: SessionMarker | null = null;

  function listManagedFiles(): Array<{ readonly name: string; readonly mtimeMs: number }> {
    try {
      return readdirSync(evidenceRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile() && EVIDENCE_FILE_PATTERN.test(entry.name))
        .map((entry) => {
          const info = statSync(join(evidenceRoot, entry.name));
          return { name: entry.name, mtimeMs: info.mtimeMs };
        });
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return [];
      throw error;
    }
  }

  function applyRetention(): void {
    const cutoff = now().getTime() - maxAgeMs;
    const files = listManagedFiles().sort(
      (left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name),
    );
    for (const [index, file] of files.entries()) {
      if (index >= maxRecords || file.mtimeMs < cutoff) {
        rmSync(join(evidenceRoot, file.name), { force: true });
      }
    }
  }

  function record(input: CrashEvidenceInput): CrashEvidenceRecord | null {
    try {
      const evidenceId = `CE-${createId()}`;
      if (!/^CE-[0-9A-F-]{36}$/.test(evidenceId)) {
        throw new Error('Crash evidence identifier generation failed.');
      }
      const correlationIds = safeCorrelationIds(input.correlationIds);
      const raw: CrashEvidenceRecord = {
        formatVersion: CRASH_EVIDENCE_FORMAT_VERSION,
        evidenceId,
        timestamp: now().toISOString(),
        appVersion: sanitizeSupportText(options.appVersion),
        installationId: options.installationId,
        sessionId: activeMarker?.sessionId ?? null,
        schemaVersion: options.getSchemaVersion?.() ?? null,
        processType: input.processType,
        eventType: input.eventType,
        errorCode:
          input.errorCode && SAFE_ERROR_CODE_PATTERN.test(input.errorCode) ? input.errorCode : null,
        ...(input.exception !== undefined ? { exception: input.exception } : {}),
        ...(input.termination
          ? {
              termination: {
                reason:
                  typeof input.termination.reason === 'string'
                    ? sanitizeSupportText(input.termination.reason)
                    : null,
                exitCode:
                  typeof input.termination.exitCode === 'number' &&
                  Number.isSafeInteger(input.termination.exitCode)
                    ? input.termination.exitCode
                    : null,
              },
            }
          : {}),
        ...(Object.keys(correlationIds).length > 0 ? { correlationIds } : {}),
        ...(input.details !== undefined ? { details: input.details } : {}),
      };
      const evidence = sanitizeRecord(raw);
      const body = `${JSON.stringify(evidence, null, 2)}\n`;
      if (Buffer.byteLength(body, 'utf8') > CRASH_EVIDENCE_MAX_FILE_BYTES) {
        throw new Error('Crash evidence exceeded the bounded record size.');
      }
      atomicWrite(join(evidenceRoot, `crash-${evidenceId}.json`), body);
      try {
        applyRetention();
      } catch {
        safeLog(() =>
          options.logger.warn('diagnostics', 'crash.evidence.retention-failed', {
            errorCode: 'CRASH_EVIDENCE_RETENTION_FAILED',
          }),
        );
      }
      safeLog(() =>
        options.logger.info('diagnostics', 'crash.evidence.recorded', {
          evidenceId,
          processType: evidence.processType,
          eventType: evidence.eventType,
        }),
      );
      return evidence;
    } catch (error) {
      safeLog(() =>
        options.logger.warn('diagnostics', 'crash.evidence.record-failed', {
          errorCode: 'CRASH_EVIDENCE_RECORD_FAILED',
          eventType: input.eventType,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return null;
    }
  }

  function collectRecent(): CrashEvidenceCollection {
    const issues = new Set<string>();
    let files: Array<{ readonly name: string; readonly mtimeMs: number }>;
    try {
      applyRetention();
      files = listManagedFiles().sort(
        (left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name),
      );
    } catch {
      safeLog(() =>
        options.logger.warn('diagnostics', 'crash.evidence.read-failed', {
          errorCode: 'CRASH_EVIDENCE_UNAVAILABLE',
        }),
      );
      return { records: [], inspectedFiles: 0, issues: ['CRASH_EVIDENCE_UNAVAILABLE'] };
    }

    const records: CrashEvidenceRecord[] = [];
    let inspectedFiles = 0;
    for (const file of files.slice(0, maxRecords)) {
      inspectedFiles += 1;
      try {
        const filePath = join(evidenceRoot, file.name);
        const info = statSync(filePath);
        if (!info.isFile() || info.size > CRASH_EVIDENCE_MAX_FILE_BYTES) {
          throw new Error('Invalid crash evidence file size.');
        }
        const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
        if (!isCrashEvidenceRecord(parsed)) throw new Error('Invalid crash evidence shape.');
        records.push(sanitizeRecord(parsed));
      } catch {
        issues.add('CRASH_EVIDENCE_RECORD_SKIPPED');
        safeLog(() =>
          options.logger.warn('diagnostics', 'crash.evidence.parse-failed', {
            errorCode: 'CRASH_EVIDENCE_PARSE_FAILED',
          }),
        );
      }
    }
    records.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
    return { records, inspectedFiles, issues: [...issues].sort() };
  }

  function startSession(): string | null {
    const startedAt = now().toISOString();
    const sessionId = `SESSION-${createId()}`;
    if (!/^SESSION-[0-9A-F-]{36}$/.test(sessionId)) {
      safeLog(() =>
        options.logger.warn('diagnostics', 'crash.session.start-failed', {
          errorCode: 'CRASH_SESSION_MARKER_WRITE_FAILED',
        }),
      );
      return null;
    }
    try {
      const previous = readSessionMarker(markerFile);
      activeMarker = {
        formatVersion: CRASH_SESSION_MARKER_VERSION,
        sessionId,
        state: 'RUNNING',
        startedAt,
      };
      if (previous.present && 'corrupt' in previous) {
        safeLog(() =>
          options.logger.warn('diagnostics', 'crash.session.marker-parse-failed', {
            errorCode: 'CRASH_SESSION_MARKER_CORRUPT',
          }),
        );
      } else if (previous.present && previous.marker.state === 'RUNNING') {
        safeLog(() =>
          options.logger.warn('diagnostics', 'crash.session.unexpected-previous-termination', {
            previousSessionId: previous.marker.sessionId,
          }),
        );
        record({
          processType: 'MAIN',
          eventType: 'unexpected_previous_termination',
          errorCode: 'UNEXPECTED_PREVIOUS_TERMINATION',
          correlationIds: { previousSessionId: previous.marker.sessionId },
        });
      }
      atomicWrite(markerFile, `${JSON.stringify(activeMarker, null, 2)}\n`);
      return sessionId;
    } catch {
      activeMarker = null;
      safeLog(() =>
        options.logger.warn('diagnostics', 'crash.session.start-failed', {
          errorCode: 'CRASH_SESSION_MARKER_WRITE_FAILED',
        }),
      );
      return null;
    }
  }

  function markCleanShutdown(): void {
    if (!activeMarker) return;
    try {
      const clean: SessionMarker = {
        ...activeMarker,
        state: 'CLEAN',
        endedAt: now().toISOString(),
      };
      atomicWrite(markerFile, `${JSON.stringify(clean, null, 2)}\n`);
      activeMarker = clean;
      safeLog(() => options.logger.info('diagnostics', 'crash.session.clean-shutdown'));
    } catch {
      safeLog(() =>
        options.logger.warn('diagnostics', 'crash.session.clean-shutdown-marker-failed', {
          errorCode: 'CRASH_SESSION_MARKER_WRITE_FAILED',
        }),
      );
    }
  }

  return { startSession, markCleanShutdown, record, collectRecent };
}
