import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { LogRecord } from '../app/logger';
import { assertPrivacySafeText, sanitizeSupportValue } from './supportPrivacy';

export const SUPPORT_LOG_MAX_BYTES = 1024 * 1024;
export const SUPPORT_LOG_MAX_FILES = 5;

export interface RecentLogCollection {
  readonly content: string;
  readonly includedRecords: number;
  readonly inspectedFiles: number;
  readonly issues: readonly string[];
}

export interface RecentLogRecordsCollection {
  readonly records: readonly LogRecord[];
  readonly inspectedFiles: number;
  readonly issues: readonly string[];
}

function logRank(name: string): number | null {
  if (name === 'main.log') return 0;
  const match = /^main\.log\.(\d+)$/.exec(name);
  if (!match) return null;
  const rank = Number(match[1]);
  return Number.isSafeInteger(rank) && rank > 0 ? rank : null;
}

function isStructuredLogRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['timestamp'] === 'string' &&
    typeof record['level'] === 'string' &&
    typeof record['category'] === 'string' &&
    typeof record['event'] === 'string' &&
    typeof record['installationId'] === 'string' &&
    typeof record['context'] === 'object' &&
    record['context'] !== null &&
    !Array.isArray(record['context'])
  );
}

async function readBoundedTail(
  path: string,
  maxBytes: number,
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error('Not a regular log file.');
  const bytes = Math.min(info.size, maxBytes);
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, Math.max(0, info.size - bytes));
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    if (info.size <= bytes) return { text, truncated: false };
    const newline = text.indexOf('\n');
    return { text: newline === -1 ? '' : text.slice(newline + 1), truncated: true };
  } finally {
    await handle.close();
  }
}

/** Read only known rotating logger files, prioritize newest records, and skip malformed input. */
export async function collectRecentSanitizedLogs(
  logDir: string,
  maxBytes = SUPPORT_LOG_MAX_BYTES,
  maxFiles = SUPPORT_LOG_MAX_FILES,
): Promise<RecentLogCollection> {
  const issueSet = new Set<string>();
  let names: string[];
  try {
    names = (await readdir(logDir))
      .map((name) => ({ name, rank: logRank(name) }))
      .filter((entry): entry is { name: string; rank: number } => entry.rank !== null)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, maxFiles)
      .map(({ name }) => name);
  } catch {
    return {
      content: '',
      includedRecords: 0,
      inspectedFiles: 0,
      issues: ['LOG_DIRECTORY_UNAVAILABLE'],
    };
  }

  const newestFirst: string[] = [];
  let inspectedFiles = 0;
  let outputBytes = 0;
  let limitReached = false;
  for (const name of names) {
    let raw: string;
    try {
      const read = await readBoundedTail(join(logDir, name), maxBytes);
      raw = read.text;
      if (read.truncated) issueSet.add('LOG_INPUT_TRUNCATED');
      inspectedFiles += 1;
    } catch {
      issueSet.add('LOG_FILE_UNREADABLE');
      continue;
    }
    const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[index]!);
      } catch {
        issueSet.add('LOG_RECORD_SKIPPED');
        continue;
      }
      if (!isStructuredLogRecord(parsed)) {
        issueSet.add('LOG_RECORD_SKIPPED');
        continue;
      }
      const line = JSON.stringify(sanitizeSupportValue(parsed));
      try {
        assertPrivacySafeText(line);
      } catch {
        issueSet.add('LOG_RECORD_PRIVACY_REJECTED');
        continue;
      }
      const bytes = Buffer.byteLength(`${line}\n`, 'utf8');
      if (outputBytes + bytes > maxBytes) {
        issueSet.add('LOG_OUTPUT_TRUNCATED');
        limitReached = true;
        break;
      }
      newestFirst.push(line);
      outputBytes += bytes;
    }
    if (limitReached || outputBytes >= maxBytes) break;
  }

  const records = newestFirst.reverse();
  return {
    content: records.length === 0 ? '' : `${records.join('\n')}\n`,
    includedRecords: records.length,
    inspectedFiles,
    issues: [...issueSet].sort(),
  };
}

/**
 * Same bounded, privacy-checked read as `collectRecentSanitizedLogs` — reuses
 * the same rotating log files, the same per-file byte cap, and the same
 * shape/redaction checks — but returns parsed structured records (newest
 * first, bounded by count) instead of a joined text blob. For a consumer that
 * inspects fields (e.g. the friendly activity history), not one that embeds
 * raw JSONL into an archive.
 */
export async function collectRecentSanitizedLogRecords(
  logDir: string,
  maxRecords: number,
  maxFiles = SUPPORT_LOG_MAX_FILES,
): Promise<RecentLogRecordsCollection> {
  const issueSet = new Set<string>();
  let names: string[];
  try {
    names = (await readdir(logDir))
      .map((name) => ({ name, rank: logRank(name) }))
      .filter((entry): entry is { name: string; rank: number } => entry.rank !== null)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, maxFiles)
      .map(({ name }) => name);
  } catch {
    return { records: [], inspectedFiles: 0, issues: ['LOG_DIRECTORY_UNAVAILABLE'] };
  }

  const bound = Math.max(0, maxRecords);
  const newestFirst: LogRecord[] = [];
  let inspectedFiles = 0;
  for (const name of names) {
    if (newestFirst.length >= bound) break;
    let raw: string;
    try {
      const read = await readBoundedTail(join(logDir, name), SUPPORT_LOG_MAX_BYTES);
      raw = read.text;
      if (read.truncated) issueSet.add('LOG_INPUT_TRUNCATED');
      inspectedFiles += 1;
    } catch {
      issueSet.add('LOG_FILE_UNREADABLE');
      continue;
    }
    const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (newestFirst.length >= bound) break;
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[index]!);
      } catch {
        issueSet.add('LOG_RECORD_SKIPPED');
        continue;
      }
      if (!isStructuredLogRecord(parsed)) {
        issueSet.add('LOG_RECORD_SKIPPED');
        continue;
      }
      const sanitized = sanitizeSupportValue(parsed);
      try {
        assertPrivacySafeText(JSON.stringify(sanitized));
      } catch {
        issueSet.add('LOG_RECORD_PRIVACY_REJECTED');
        continue;
      }
      newestFirst.push(sanitized as LogRecord);
    }
  }

  return { records: newestFirst, inspectedFiles, issues: [...issueSet].sort() };
}
