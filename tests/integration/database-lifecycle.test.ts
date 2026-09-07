import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProductionDatabase } from '../../src/main/database/database';
import { createCapturingLogger, makeTempDir } from '../helpers/database';

/**
 * `ProductionDatabase` lifecycle: open → configure → migrate → validate → ready
 * → close (task `§2`, `§12`, `§13`). Every test uses an injected temp path — the
 * real `%LOCALAPPDATA%\GoPhonesPOS\gophones.sqlite` is never touched.
 */

describe('ProductionDatabase', () => {
  let temp: ReturnType<typeof makeTempDir>;

  beforeEach(() => {
    temp = makeTempDir();
  });

  afterEach(() => {
    temp.cleanup();
  });

  function open(filename = join(temp.path, 'gophones.sqlite')) {
    return ProductionDatabase.open({
      filename,
      backupDir: join(temp.path, 'backups'),
      logger: createCapturingLogger().logger,
      appVersion: '0.1.0-test',
    });
  }

  it('initialises a fresh database to the current schema version', async () => {
    const production = await open();
    try {
      expect(production.schemaVersion).toBe(1);
      expect(production.validation.ok).toBe(true);
      // The connection is usable for main-process repositories.
      const row = production.connection
        .prepare("SELECT value FROM settings WHERE key='business_timezone'")
        .get() as { value: string };
      expect(row.value).toBe('America/Chicago');
    } finally {
      production.close();
    }
  });

  it('writes the database file at the injected path only', async () => {
    const filename = join(temp.path, 'nested', 'gophones.sqlite');
    const production = await open(filename);
    try {
      expect(existsSync(filename)).toBe(true);
    } finally {
      production.close();
    }
  });

  it('close() is idempotent and blocks further connection use', async () => {
    const production = await open();
    production.close();
    expect(() => production.close()).not.toThrow();
    expect(production.closed).toBe(true);
    expect(() => production.connection).toThrow(/after close/i);
  });

  it('reopening the same file does not re-run migrations and preserves data', async () => {
    const filename = join(temp.path, 'gophones.sqlite');
    const first = await open(filename);
    first.connection
      .prepare(
        `INSERT INTO products
           (id, name, brand, model, condition, selling_price_cents, quantity_on_hand, created_at, updated_at)
         VALUES ('P-KEEP', 'Keep', 'B', 'M', 'NEW', 5000, 2, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      )
      .run();
    first.close();

    const second = await open(filename);
    try {
      expect(second.schemaVersion).toBe(1);
      const count = second.connection
        .prepare('SELECT COUNT(*) AS c FROM schema_migrations')
        .get() as { c: number };
      expect(count.c).toBe(1);
      const product = second.connection
        .prepare("SELECT name FROM products WHERE id='P-KEEP'")
        .get() as { name: string };
      expect(product.name).toBe('Keep');
    } finally {
      second.close();
    }
  });

  it('reports the effective durability pragmas on the live connection', async () => {
    const production = await open();
    try {
      const db = production.connection;
      expect(Number(db.pragma('foreign_keys', { simple: true }))).toBe(1);
      expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
      expect(Number(db.pragma('synchronous', { simple: true }))).toBe(2);
      expect(Number(db.pragma('busy_timeout', { simple: true }))).toBe(5000);
    } finally {
      production.close();
    }
  });
});
