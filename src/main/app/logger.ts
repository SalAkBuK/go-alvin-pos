import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Structured logging foundation (SUPPORT_DIAGNOSTICS.md Sections 6-9;
 * ARCHITECTURE.md Section 46).
 *
 * Invariants:
 *   - A logging call MUST NOT throw into its caller, whatever the field values
 *     contain (BigInt, circular references, `Error`, throwing `toJSON`, etc.).
 *   - Obviously credential-like fields are redacted before anything is written,
 *     recursively through nested objects and arrays.
 *
 * Not implemented yet (deliberately): log rotation, correlation IDs, crash
 * evidence, support-bundle collection.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Log categories from SUPPORT_DIAGNOSTICS.md Section 8. */
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

export type LogFields = Record<string, unknown>;

export interface LogRecord {
  readonly time: string;
  readonly level: LogLevel;
  readonly category: LogCategory;
  readonly event: string;
  readonly fields: LogFields;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

export const REDACTED = '[redacted]';

/** Bounds on the safe-sanitize walk, so a hostile/huge object can never hang or overflow. */
const MAX_DEPTH = 8;
const MAX_ENTRIES_PER_CONTAINER = 200;
const MAX_TOTAL_NODES = 5000;

/**
 * Substrings that unambiguously mark a credential when they appear anywhere in
 * a normalized (lowercased, separator-stripped) key.
 */
const SENSITIVE_KEY_SUBSTRINGS = [
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'secret',
  'token',
  'credential',
  'apikey',
  'privatekey',
];

/**
 * Keys that are sensitive as a whole word but whose substrings would wrongly
 * flag ordinary fields (e.g. `auth` is a substring of `author`).
 */
const SENSITIVE_KEY_EXACT = new Set(['auth', 'authorization', 'bearer']);

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[\s_-]/g, '');
  if (SENSITIVE_KEY_EXACT.has(normalized)) {
    return true;
  }
  return SENSITIVE_KEY_SUBSTRINGS.some((needle) => normalized.includes(needle));
}

/**
 * Produce a JSON-safe copy of `value`: primitives pass through, `BigInt`
 * becomes a string, functions/symbols become tags, `Error` becomes a plain
 * object, cycles become `"[circular]"`, and anything that throws while being
 * read becomes `"[unserializable]"`. Depth and per-container breadth are
 * bounded.
 */
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
  if (kind === 'string' || kind === 'boolean') {
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

  // Objects and arrays.
  if (depth >= MAX_DEPTH) {
    return '[max depth]';
  }
  const container = value as object;
  // Permanent (not path-scoped) visited set: guarantees O(n) work and no
  // stack/loop blow-up. A value reused in sibling positions renders as
  // "[circular]" on the second encounter — acceptable for logs.
  if (seen.has(container)) {
    return '[circular]';
  }
  seen.add(container);

  try {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        ...(typeof value.stack === 'string' ? { stack: value.stack } : {}),
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
    // Throwing getters, exotic proxies, etc.
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

export function buildLogRecord(
  level: LogLevel,
  category: LogCategory,
  event: string,
  fields: LogFields = {},
  now: Date = new Date(),
): LogRecord {
  return {
    time: now.toISOString(),
    level,
    category,
    event,
    fields: sanitizeFields(fields),
  };
}

export function formatLogLine(record: LogRecord): string {
  try {
    return JSON.stringify(record);
  } catch {
    return JSON.stringify({
      time: record.time,
      level: record.level,
      category: record.category,
      event: record.event,
      fields: { note: '[unserializable log fields]' },
    });
  }
}

export interface LoggerOptions {
  /** Directory that receives `main.log`. Created on demand. */
  readonly dir: string;
  /** Lowest level that is emitted. Defaults to `info`. */
  readonly minLevel?: LogLevel;
  /** Also mirror records to the console. Defaults to `false`. */
  readonly console?: boolean;
}

export class Logger {
  private readonly file: string;
  private readonly minRank: number;
  private readonly mirrorConsole: boolean;
  private dirReady = false;

  constructor(private readonly options: LoggerOptions) {
    this.file = join(options.dir, 'main.log');
    this.minRank = LEVEL_RANK[options.minLevel ?? 'info'];
    this.mirrorConsole = options.console ?? false;
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

  /**
   * Build, sanitize, serialize, and write one record. The entire path is
   * wrapped: a logging call never throws into the application.
   */
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

      const line = formatLogLine(buildLogRecord(level, category, event, fields ?? {}));

      if (this.mirrorConsole) {
        const sink = level === 'error' || level === 'fatal' ? console.error : console.log;
        sink(line);
      }

      if (!this.dirReady) {
        mkdirSync(this.options.dir, { recursive: true });
        this.dirReady = true;
      }
      appendFileSync(this.file, `${line}\n`, 'utf8');
    } catch (error) {
      // Logging must never crash the POS. Best-effort console notice, then continue.
      try {
        console.error(
          'logger: failed to emit log record',
          error instanceof Error ? error.message : error,
        );
      } catch {
        /* nothing else we can safely do */
      }
    }
  }
}
