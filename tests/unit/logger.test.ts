import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildLogRecord,
  isSensitiveKey,
  Logger,
  redactString,
  sanitizeFields,
} from '../../src/main/app/logger';

const INSTALLATION_ID = 'INST-12345678-1234-4123-8123-123456789ABC';

function readRecords(dir: string, name = 'main.log'): Array<Record<string, unknown>> {
  return readFileSync(join(dir, name), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('buildLogRecord', () => {
  it('produces the stable structured format with levels, category, event, and context', () => {
    const record = buildLogRecord(
      'warn',
      'checkout',
      'checkout.failed',
      { safe: true, errorCode: 'SALE_COMMIT_FAILED' },
      new Date('2026-09-07T12:00:00.000Z'),
      INSTALLATION_ID,
    );

    expect(record).toEqual({
      timestamp: '2026-09-07T12:00:00.000Z',
      level: 'warn',
      category: 'checkout',
      event: 'checkout.failed',
      installationId: INSTALLATION_ID,
      errorCode: 'SALE_COMMIT_FAILED',
      context: { safe: true },
    });
  });

  it('promotes supported correlation IDs while preserving ordinary safe context', () => {
    const record = buildLogRecord(
      'info',
      'checkout',
      'checkout.completed',
      {
        checkoutRequestId: 'CHK-1',
        saleId: 'sale-1',
        receiptNumber: 'GP-000184',
        exportJobId: 'job-1',
        durationMs: 74,
      },
      new Date('2026-09-07T12:00:00.000Z'),
      INSTALLATION_ID,
    );

    expect(record.correlationIds).toEqual({
      checkoutRequestId: 'CHK-1',
      saleId: 'sale-1',
      receiptNumber: 'GP-000184',
      exportJobId: 'job-1',
    });
    expect(record.context).toEqual({ durationMs: 74 });
  });
});

describe('central redaction', () => {
  it('recognizes credentials, payment data, OAuth material, and customer PII keys', () => {
    for (const key of [
      'password',
      'password_hash',
      'Authorization',
      'access_token',
      'refreshToken',
      'oauthAuthorizationCode',
      'code_verifier',
      'id_token',
      'rawTokenResponse',
      'client_secret',
      'private_key',
      'developerOAuthClientConfiguration',
      'cardNumber',
      'pan',
      'cvv',
      'track1',
      'magneticStripeData',
      'cloverPaymentCredential',
      'customerPhoneSnapshot',
      'customerName',
      'accountEmail',
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it('preserves safe operational fields', () => {
    for (const key of [
      'author',
      'productName',
      'foreignKey',
      'quantity',
      'total_cents',
      'customerId',
      'checksumSha256',
      'requestFingerprint',
    ]) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });

  it('redacts sensitive fields recursively through nested objects and arrays', () => {
    const out = sanitizeFields({
      request: {
        headers: { Authorization: 'Bearer abc' },
        oauth: {
          access_token: 'access',
          refresh_token: 'refresh',
          code_verifier: 'verifier',
          id_token: 'identity',
        },
      },
      attempts: [
        { cardNumber: '4111111111111111', cvv: '123' },
        { trackData: 'raw-track', note: 'retry' },
      ],
      customer: { phone: '281-824-1234', customerId: 'customer-1' },
      order: { productName: 'Pixel', quantity: 2 },
    });

    expect(out).toEqual({
      request: {
        headers: { Authorization: '[redacted]' },
        oauth: {
          access_token: '[redacted]',
          refresh_token: '[redacted]',
          code_verifier: '[redacted]',
          id_token: '[redacted]',
        },
      },
      attempts: [
        { cardNumber: '[redacted]', cvv: '[redacted]' },
        { trackData: '[redacted]', note: 'retry' },
      ],
      customer: { phone: '[redacted]', customerId: 'customer-1' },
      order: { productName: 'Pixel', quantity: 2 },
    });
  });

  it('redacts secrets and card numbers embedded in error text', () => {
    const value = redactString(
      'Authorization=Bearer-abc access_token=token-1 card number=4111 1111 1111 1111',
    );
    expect(value).not.toContain('Bearer-abc');
    expect(value).not.toContain('token-1');
    expect(value).not.toContain('4111');
  });

  it('does not throw on BigInt, circular references, or hostile objects', () => {
    const circular: Record<string, unknown> = { name: 'root' };
    circular['self'] = circular;
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('nope');
        },
      },
    );

    let result: unknown;
    expect(() => {
      result = sanitizeFields({ big: 10n, circular, hostile, err: new Error('boom') });
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

  it('writes every supported level and honors the configured minimum', () => {
    const logger = new Logger({ dir, installationId: INSTALLATION_ID, minLevel: 'debug' });

    logger.debug('application', 'level.debug');
    logger.info('application', 'level.info');
    logger.warn('application', 'level.warn');
    logger.error('application', 'level.error');
    logger.fatal('application', 'level.fatal');

    expect(readRecords(dir).map((record) => record.level)).toEqual([
      'debug',
      'info',
      'warn',
      'error',
      'fatal',
    ]);

    const filteredDir = join(dir, 'filtered');
    const filtered = new Logger({
      dir: filteredDir,
      installationId: INSTALLATION_ID,
      minLevel: 'warn',
    });
    filtered.info('application', 'ignored');
    filtered.warn('application', 'kept');
    expect(readRecords(filteredDir).map((record) => record.event)).toEqual(['kept']);
  });

  it('supports reusable workflow context without mutating the parent logger', () => {
    const logger = new Logger({ dir, installationId: INSTALLATION_ID });
    const checkout = logger.withContext({ checkoutRequestId: 'CHK-2' });
    checkout.info('checkout', 'checkout.completed', { saleId: 'sale-2', totalCents: 100 });
    logger.info('application', 'application.idle');

    const [scoped, unscoped] = readRecords(dir) as Array<{
      correlationIds?: Record<string, string>;
      context: Record<string, unknown>;
    }>;
    expect(scoped?.correlationIds).toEqual({ checkoutRequestId: 'CHK-2', saleId: 'sale-2' });
    expect(scoped?.context).toEqual({ totalCents: 100 });
    expect(unscoped?.correlationIds).toBeUndefined();
  });

  it('rotates before an entry would cross the configured threshold', () => {
    const logger = new Logger({
      dir,
      installationId: INSTALLATION_ID,
      maxFileBytes: 400,
    });
    logger.info('application', 'rotation.first', { value: 'x'.repeat(140) });
    logger.info('application', 'rotation.second', { value: 'y'.repeat(140) });

    expect(existsSync(join(dir, 'main.log.1'))).toBe(true);
    expect(readRecords(dir, 'main.log.1')[0]?.event).toBe('rotation.first');
    expect(readRecords(dir)[0]?.event).toBe('rotation.second');
  });

  it('retains only the configured number of rotated files', () => {
    const logger = new Logger({
      dir,
      installationId: INSTALLATION_ID,
      maxFileBytes: 1,
      maxRotatedFiles: 3,
    });
    for (let index = 0; index < 7; index += 1) {
      logger.info('application', `rotation.${index}`);
    }

    expect(readdirSync(dir).sort()).toEqual(['main.log', 'main.log.1', 'main.log.2', 'main.log.3']);
  });

  it('removes rotated logs beyond the age ceiling but leaves current/unrelated files', () => {
    const now = new Date('2026-09-11T12:00:00.000Z');
    writeFileSync(join(dir, 'main.log.1'), 'old');
    writeFileSync(join(dir, 'main.log.2'), 'recent');
    writeFileSync(join(dir, 'keep.txt'), 'unrelated');
    const old = new Date('2026-08-11T11:59:59.000Z');
    const recent = new Date('2026-08-13T12:00:00.000Z');
    utimesSync(join(dir, 'main.log.1'), old, old);
    utimesSync(join(dir, 'main.log.2'), recent, recent);

    const logger = new Logger({
      dir,
      installationId: INSTALLATION_ID,
      maxAgeDays: 30,
      now: () => now,
    });
    logger.info('application', 'retention.checked');

    expect(existsSync(join(dir, 'main.log.1'))).toBe(false);
    expect(existsSync(join(dir, 'main.log.2'))).toBe(true);
    expect(existsSync(join(dir, 'keep.txt'))).toBe(true);
  });

  it('never breaks critical caller flow when storage fails', () => {
    const filePath = join(dir, 'not-a-dir');
    writeFileSync(filePath, 'x');
    const logger = new Logger({
      dir: join(filePath, 'logs'),
      installationId: INSTALLATION_ID,
    });
    let criticalFlowReached = false;

    expect(() => {
      logger.fatal('checkout', 'checkout.commit.failed', { errorCode: 'SALE_COMMIT_FAILED' });
      criticalFlowReached = true;
    }).not.toThrow();
    expect(criticalFlowReached).toBe(true);
  });
});
