import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createSqliteSnapshot,
  sanitizedOsErrorCode,
  sha256File,
} from '../../src/main/backup/backupSnapshot';
import { createMigratedDb, makeTempDir } from '../helpers/database';

/**
 * Phase 2L — backup failure diagnostics must never leak a raw exception string
 * or a filesystem path (`POS_WORKFLOWS.md §66`, `TEST-BACKUP-009`). Only a plain
 * uppercase OS/SQLite error token survives.
 */
describe('sanitizedOsErrorCode', () => {
  it('keeps a plain OS / SQLite error token', () => {
    expect(sanitizedOsErrorCode(Object.assign(new Error('x'), { code: 'ENOSPC' }))).toBe('ENOSPC');
    expect(
      sanitizedOsErrorCode(Object.assign(new Error('x'), { code: 'SQLITE_IOERR_WRITE' })),
    ).toBe('SQLITE_IOERR_WRITE');
  });

  it('drops anything that is not a bare token', () => {
    expect(
      sanitizedOsErrorCode(new Error('ENOENT: no such file, open /secret/path')),
    ).toBeUndefined();
    expect(sanitizedOsErrorCode(Object.assign(new Error('x'), { code: 12 }))).toBeUndefined();
    expect(
      sanitizedOsErrorCode(Object.assign(new Error('x'), { code: 'C:\\Users\\o\\db.sqlite' })),
    ).toBeUndefined();
    expect(sanitizedOsErrorCode('a string')).toBeUndefined();
    expect(sanitizedOsErrorCode(null)).toBeUndefined();
    expect(sanitizedOsErrorCode(undefined)).toBeUndefined();
  });
});

/**
 * 2L-B adversarial follow-up Item 1: the restore confirmation token now binds
 * to the checksum of a fresh pre-restore snapshot rather than a narrow
 * sales/receipt-counter summary. That is only a valid "current-state
 * fingerprint" if two snapshots of the SAME unchanged logical state produce
 * byte-identical files — verified directly here rather than assumed.
 */
describe('createSqliteSnapshot determinism (restore confirmation fingerprint)', () => {
  it('two snapshots of an unchanged database produce an identical checksum', async () => {
    const db = await createMigratedDb();
    const dir = makeTempDir('gpp-snapshot-determinism-');
    try {
      const pathA = join(dir.path, 'a.sqlite');
      const pathB = join(dir.path, 'b.sqlite');
      await createSqliteSnapshot(db, pathA);
      await createSqliteSnapshot(db, pathB);
      expect(await sha256File(pathA)).toBe(await sha256File(pathB));
    } finally {
      db.close();
      dir.cleanup();
    }
  });
});
