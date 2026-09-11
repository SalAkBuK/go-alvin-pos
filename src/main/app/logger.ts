import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

/** Trusted main-process structured diagnostics; audit events stay in SQLite. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_CATEGORIES = [
  'application',
  'authentication',
  'checkout',
  'sales',
  'inventory',
  'database',
  'migration',
  'printing',
  'google',
  'backup',
  'update',
  'diagnostics',
  'audit',
  'export',
] as const;
export type LogCategory = (typeof LOG_CATEGORIES)[number];

export const CORRELATION_ID_KEYS = [
  'correlationId',
  'checkoutRequestId',
  'saleId',
  'receiptNumber',
  'exportJobId',
  'supportReportId',
] as const;
export type CorrelationIdKey = (typeof CORRELATION_ID_KEYS)[number];
export type CorrelationIds = Partial<Record<CorrelationIdKey, string>>;
export type LogFields = Record<string, unknown>;

export interface LogRecord {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly category: LogCategory;
  readonly event: string;
  readonly installationId: string;
  readonly correlationIds?: CorrelationIds;
  readonly errorCode?: string;
  readonly context: LogFields;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

export const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_LOG_MAX_ROTATED_FILES = 10;
export const DEFAULT_LOG_MAX_AGE_DAYS = 30;
export const REDACTED = '[redacted]';

const ACTIVE_LOG_NAME = 'main.log';
const MAX_DEPTH = 8;
const MAX_ENTRIES_PER_CONTAINER = 200;
const MAX_TOTAL_NODES = 5000;
const MAX_STRING_LENGTH = 32_768;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

const SENSITIVE_KEY_SUBSTRINGS = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'credential',
  'apikey',
  'clientsecret',
  'privatekey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'tokenresponse',
  'authorizationcode',
  'oauthcode',
  'codeverifier',
  'oauthresponse',
  'oauthclientconfig',
  'developeroauthclient',
  'paymentcredential',
  'clovercredential',
  'cardnumber',
  'primaryaccountnumber',
  'magneticstripe',
  'magstripe',
  'trackdata',
  'track1',
  'track2',
  'customerphone',
  'customername',
  'customeremail',
  'accountemail',
];

const SENSITIVE_KEY_EXACT = new Set([
  'auth',
  'authorization',
  'bearer',
  'credential',
  'credentials',
  'secret',
  'secrets',
  'token',
  'apikey',
  'pwd',
  'passwordhash',
  'hash',
  'pan',
  'cvv',
  'cvv2',
  'cvc',
  'track1',
  'track2',
  'phone',
  'phonenumber',
  'telephone',
  'email',
  'clientconfig',
]);

const SECRET_ASSIGNMENT_PATTERN =
  /\b(authorization|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|authorization[_ -]?code|code[_ -]?verifier|client[_ -]?secret|private[_ -]?key|password|cvv2?|cvc|card[_ -]?number)\b(\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&#]+)/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const CARD_NUMBER_PATTERN = /\b(?:\d[ -]*?){13,19}\b/g;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\s_.-]/g, '');
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (SENSITIVE_KEY_EXACT.has(normalized)) {
    return true;
  }
  return SENSITIVE_KEY_SUBSTRINGS.some((needle) => normalized.includes(needle));
}

/** Scrub common secret-bearing text so errors and URLs cannot bypass key redaction. */
export function redactString(value: string): string {
  const truncated =
    value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}[truncated]` : value;
  return truncated
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
    .replace(
      SECRET_ASSIGNMENT_PATTERN,
      (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`,
    )
    .replace(CARD_NUMBER_PATTERN, REDACTED);
}

interface SanitizeBudget {
  nodes: number;
}

function safeSanitize(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  budget: SanitizeBudget,
): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (budget.nodes++ > MAX_TOTAL_NODES) {
    return '[truncated]';
  }

  const kind = typeof value;
  if (kind === 'string') {
    return redactString(value as string);
  }
  if (kind === 'boolean') {
    return value;
  }
  if (kind === 'number') {
    return Number.isFinite(value as number) ? value : String(value);
  }
  if (kind === 'bigint') {
    return `${(value as bigint).toString()}n`;
  }
  if (kind === 'function') {
    return '[function]';
  }
  if (kind === 'symbol') {
    return (value as symbol).toString();
  }

  if (depth >= MAX_DEPTH) {
    return '[max depth]';
  }
  const container = value as object;
  if (seen.has(container)) {
    return '[circular]';
  }
  seen.add(container);

  try {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: redactString(value.message),
        ...(typeof value.stack === 'string' ? { stack: redactString(value.stack) } : {}),
      };
    }

    if (Array.isArray(value)) {
      const out = value
        .slice(0, MAX_ENTRIES_PER_CONTAINER)
        .map((item) => safeSanitize(item, depth + 1, seen, budget));
      if (value.length > MAX_ENTRIES_PER_CONTAINER) {
        out.push(`[+${value.length - MAX_ENTRIES_PER_CONTAINER} more]`);
      }
      return out;
    }

    const entries = Object.entries(value as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [key, entryValue] of entries.slice(0, MAX_ENTRIES_PER_CONTAINER)) {
      out[key] = isSensitiveKey(key) ? REDACTED : safeSanitize(entryValue, depth + 1, seen, budget);
    }
    if (entries.length > MAX_ENTRIES_PER_CONTAINER) {
      out['…'] = `[+${entries.length - MAX_ENTRIES_PER_CONTAINER} more]`;
    }
    return out;
  } catch {
    return '[unserializable]';
  }
}

export function sanitizeFields(fields: LogFields): LogFields {
  try {
    const sanitized = safeSanitize(fields, 0, new WeakSet(), { nodes: 0 });
    if (sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)) {
      return sanitized as LogFields;
    }
    return { value: sanitized };
  } catch {
    return { note: '[unserializable log fields]' };
  }
}

function splitRecordFields(fields: LogFields): {
  readonly correlationIds?: CorrelationIds;
  readonly errorCode?: string;
  readonly context: LogFields;
} {
  const sanitized = sanitizeFields(fields);
  const context = { ...sanitized };
  const correlationIds: CorrelationIds = {};

  for (const key of CORRELATION_ID_KEYS) {
    const value = sanitized[key];
    if (typeof value === 'string' && value.trim() !== '') {
      correlationIds[key] = value;
    }
    delete context[key];
  }

  const rawErrorCode = sanitized['errorCode'] ?? sanitized['failureCode'];
  const errorCode =
    typeof rawErrorCode === 'string' && rawErrorCode.trim() !== '' ? rawErrorCode : undefined;
  delete context['errorCode'];
  delete context['failureCode'];

  return {
    ...(Object.keys(correlationIds).length > 0 ? { correlationIds } : {}),
    ...(errorCode ? { errorCode } : {}),
    context,
  };
}

export function buildLogRecord(
  level: LogLevel,
  category: LogCategory,
  event: string,
  fields: LogFields = {},
  now: Date = new Date(),
  installationId = 'INST-UNKNOWN',
): LogRecord {
  const stableEvent = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(event)
    ? event
    : 'diagnostics.invalid_event_name';
  return {
    timestamp: now.toISOString(),
    level,
    category,
    event: stableEvent,
    installationId,
    ...splitRecordFields(fields),
  };
}

export function formatLogLine(record: LogRecord): string {
  try {
    return JSON.stringify(record);
  } catch {
    return JSON.stringify({
      timestamp: record.timestamp,
      level: record.level,
      category: record.category,
      event: record.event,
      installationId: record.installationId,
      context: { note: '[unserializable log fields]' },
    });
  }
}

export interface LoggerOptions {
  readonly dir: string;
  readonly installationId: string;
  readonly minLevel?: LogLevel;
  readonly console?: boolean;
  readonly maxFileBytes?: number;
  readonly maxRotatedFiles?: number;
  readonly maxAgeDays?: number;
  readonly now?: () => Date;
}

export interface ContextLogger {
  debug(category: LogCategory, event: string, fields?: LogFields): void;
  info(category: LogCategory, event: string, fields?: LogFields): void;
  warn(category: LogCategory, event: string, fields?: LogFields): void;
  error(category: LogCategory, event: string, fields?: LogFields): void;
  fatal(category: LogCategory, event: string, fields?: LogFields): void;
}

function rotatedLogName(index: number): string {
  return `${ACTIVE_LOG_NAME}.${index}`;
}

export class Logger implements ContextLogger {
  private readonly file: string;
  private readonly minRank: number;
  private readonly mirrorConsole: boolean;
  private readonly maxFileBytes: number;
  private readonly maxRotatedFiles: number;
  private readonly maxAgeMs: number;
  private readonly now: () => Date;
  private dirReady = false;
  private lastRetentionCheckAt: number | null = null;

  constructor(private readonly options: LoggerOptions) {
    this.file = join(options.dir, ACTIVE_LOG_NAME);
    this.minRank = LEVEL_RANK[options.minLevel ?? 'info'];
    this.mirrorConsole = options.console ?? false;
    this.maxFileBytes = Math.max(1, options.maxFileBytes ?? DEFAULT_LOG_MAX_BYTES);
    this.maxRotatedFiles = Math.max(0, options.maxRotatedFiles ?? DEFAULT_LOG_MAX_ROTATED_FILES);
    this.maxAgeMs =
      Math.max(0, options.maxAgeDays ?? DEFAULT_LOG_MAX_AGE_DAYS) * MILLISECONDS_PER_DAY;
    this.now = options.now ?? (() => new Date());
  }

  withContext(fields: LogFields): ContextLogger {
    const call = (level: LogLevel, category: LogCategory, event: string, extra?: LogFields): void =>
      this.write(level, category, event, { ...fields, ...(extra ?? {}) });
    return {
      debug: (category, event, extra) => call('debug', category, event, extra),
      info: (category, event, extra) => call('info', category, event, extra),
      warn: (category, event, extra) => call('warn', category, event, extra),
      error: (category, event, extra) => call('error', category, event, extra),
      fatal: (category, event, extra) => call('fatal', category, event, extra),
    };
  }

  debug(category: LogCategory, event: string, fields?: LogFields): void {
    this.write('debug', category, event, fields);
  }
  info(category: LogCategory, event: string, fields?: LogFields): void {
    this.write('info', category, event, fields);
  }
  warn(category: LogCategory, event: string, fields?: LogFields): void {
    this.write('warn', category, event, fields);
  }
  error(category: LogCategory, event: string, fields?: LogFields): void {
    this.write('error', category, event, fields);
  }
  fatal(category: LogCategory, event: string, fields?: LogFields): void {
    this.write('fatal', category, event, fields);
  }

  private ensureDirectory(): void {
    if (!this.dirReady) {
      mkdirSync(this.options.dir, { recursive: true });
      this.dirReady = true;
    }
  }

  private cleanupRetention(nowMs: number): void {
    const cutoff = nowMs - this.maxAgeMs;
    for (const name of readdirSync(this.options.dir)) {
      const match = /^main\.log\.(\d+)$/.exec(name);
      if (!match) {
        continue;
      }
      const index = Number(match[1]);
      const path = join(this.options.dir, name);
      if (index > this.maxRotatedFiles || statSync(path).mtimeMs < cutoff) {
        rmSync(path, { force: true });
      }
    }
    this.lastRetentionCheckAt = nowMs;
  }

  private rotateIfNeeded(incomingBytes: number): void {
    if (!existsSync(this.file) || statSync(this.file).size + incomingBytes <= this.maxFileBytes) {
      return;
    }

    if (this.maxRotatedFiles === 0) {
      rmSync(this.file, { force: true });
      return;
    }

    rmSync(join(this.options.dir, rotatedLogName(this.maxRotatedFiles)), { force: true });
    for (let index = this.maxRotatedFiles - 1; index >= 1; index -= 1) {
      const source = join(this.options.dir, rotatedLogName(index));
      if (existsSync(source)) {
        renameSync(source, join(this.options.dir, rotatedLogName(index + 1)));
      }
    }
    renameSync(this.file, join(this.options.dir, rotatedLogName(1)));
  }

  private write(
    level: LogLevel,
    category: LogCategory,
    event: string,
    fields: LogFields | undefined,
  ): void {
    try {
      if (LEVEL_RANK[level] < this.minRank) {
        return;
      }

      const now = this.now();
      const line = formatLogLine(
        buildLogRecord(level, category, event, fields ?? {}, now, this.options.installationId),
      );

      if (this.mirrorConsole) {
        const sink = level === 'error' || level === 'fatal' ? console.error : console.log;
        sink(line);
      }

      this.ensureDirectory();
      const nowMs = now.getTime();
      if (
        this.lastRetentionCheckAt === null ||
        nowMs < this.lastRetentionCheckAt ||
        nowMs - this.lastRetentionCheckAt >= MILLISECONDS_PER_DAY
      ) {
        this.cleanupRetention(nowMs);
      }
      const output = `${line}\n`;
      this.rotateIfNeeded(Buffer.byteLength(output, 'utf8'));
      appendFileSync(this.file, output, 'utf8');
    } catch (error) {
      try {
        console.error(
          'logger: failed to emit log record',
          error instanceof Error ? redactString(error.message) : '[unknown error]',
        );
      } catch {
        /* no safe fallback remains */
      }
    }
  }
}
