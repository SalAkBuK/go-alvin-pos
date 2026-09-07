import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildLogRecord, isSensitiveKey, Logger, sanitizeFields } from '../../src/main/app/logger';

describe('buildLogRecord', () => {
  it('produces a structured record with an ISO-8601 timestamp', () => {
    const when = new Date('2026-09-07T12:00:00.000Z');
    const record = buildLogRecord(
      'info',
      'application',
      'application.started',
      { version: '0.1.0' },
      when,
    );

    expect(record).toEqual({
      time: '2026-09-07T12:00:00.000Z',
      level: 'info',
      category: 'application',
      event: 'application.started',
      fields: { version: '0.1.0' },
    });
  });
});

describe('isSensitiveKey', () => {
  it('flags realistic credential-like keys (any separator/casing)', () => {
    for (const key of [
      'password',
      'passwd',
      'pwd',
      'secret',
      'clientSecret',
      'token',
      'access_token',
      'refreshToken',
      'authorization',
      'auth',
      'bearer',
      'credential',
      'credentials',
      'apiKey',
      'api_key',
      'privateKey',
      'private-key',
    ]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
  });

  it('does not flag ordinary business fields', () => {
    for (const key of [
      'author',
      'authorName',
      'productName',
      'sortKey',
      'foreignKey',
      'monkey',
      'quantity',
      'total_cents',
      'customerId',
      'description',
    ]) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });
});

describe('sanitizeFields', () => {
  it('redacts sensitive top-level keys and keeps the rest', () => {
    expect(
      sanitizeFields({ password: 'hunter2', accessToken: 'x', productName: 'iPhone' }),
    ).toEqual({
      password: '[redacted]',
      accessToken: '[redacted]',
      productName: 'iPhone',
    });
  });

  it('redacts secrets nested in objects and arrays', () => {
    const out = sanitizeFields({
      request: { headers: { authorization: 'Bearer abc' }, url: 'https://x' },
      attempts: [{ token: 't1' }, { token: 't2', note: 'retry' }],
      order: { productName: 'Pixel', qty: 2 },
    });
    expect(out).toEqual({
      request: { headers: { authorization: '[redacted]' }, url: 'https://x' },
      attempts: [{ token: '[redacted]' }, { token: '[redacted]', note: 'retry' }],
      order: { productName: 'Pixel', qty: 2 },
    });
  });

  it('does not throw on BigInt, circular refs, or a throwing toJSON', () => {
    const circular: Record<string, unknown> = { name: 'root' };
    circular['self'] = circular;

    let result: unknown;
    expect(() => {
      result = sanitizeFields({
        big: 10n,
        circular,
        hostile: {
          toJSON() {
            throw new Error('nope');
          },
        },
        err: new Error('boom'),
      });
    }).not.toThrow();

    const json = JSON.stringify(result);
    expect(json).toContain('10n');
    expect(json).toContain('[circular]');
    expect(json).toContain('boom');
    expect(() => JSON.parse(json)).not.toThrow();
  });
});

describe('Logger', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gpp-log-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes JSON-lines records at or above the configured minimum level', () => {
    const logger = new Logger({ dir, minLevel: 'info' });

    logger.debug('application', 'ignored.debug.event');
    logger.info('application', 'application.started', { packaged: false });
    logger.error('database', 'database.open-failed', { password: 'secret' });

    const lines = readFileSync(join(dir, 'main.log'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(first.event).toBe('application.started');
    expect(first.level).toBe('info');

    const second = JSON.parse(lines[1] ?? '') as { fields: Record<string, unknown> };
    expect(second.fields.password).toBe('[redacted]');
  });

  it('never throws into the caller, even for un-serializable fields', () => {
    const logger = new Logger({ dir, minLevel: 'debug' });
    const circular: Record<string, unknown> = {};
    circular['loop'] = circular;

    expect(() => {
      logger.error('checkout', 'sale.commit-failed', {
        big: 42n,
        circular,
        hostile: {
          toJSON() {
            throw new Error('kaboom');
          },
        },
      });
    }).not.toThrow();

    const line = readFileSync(join(dir, 'main.log'), 'utf8').trim();
    expect(line).toContain('sale.commit-failed');
    expect(() => JSON.parse(line)).not.toThrow();
  });

  it('does not propagate a write failure to the caller', () => {
    const filePath = join(dir, 'not-a-dir');
    writeFileSync(filePath, 'x');
    // Parent of the log dir is a file → mkdirSync throws ENOTDIR internally.
    const logger = new Logger({ dir: join(filePath, 'logs') });

    expect(() => logger.fatal('application', 'application.start-failed', { a: 1 })).not.toThrow();
  });
});
