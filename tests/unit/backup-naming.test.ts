import { describe, expect, it } from 'vitest';
import {
  backupDirFor,
  backupFileName,
  backupSubdir,
  parseManagedBackupFile,
} from '../../src/main/backup/backupNaming';

/**
 * Phase 2L — backup file naming (`UPDATE_RELEASE_STRATEGY.md §21`; adversarial
 * test 21: rapid consecutive backups cannot collide).
 */

describe('backupFileName', () => {
  it('encodes type + schema version + timestamp and stays identifiable', () => {
    const name = backupFileName('MANUAL', 1, new Date('2026-09-10T14:03:05.123Z'));
    expect(name).toMatch(/^gophones-manual-v1-2026-09-10T14-03-05-123Z-[0-9a-f]{8}\.sqlite$/);
  });

  it('produces distinct names for backups issued in the same millisecond', () => {
    const at = new Date('2026-09-10T14:03:05.123Z');
    const names = new Set(Array.from({ length: 50 }, () => backupFileName('AUTOMATIC', 1, at)));
    expect(names.size).toBe(50);
  });

  it('maps each backup type to its own subdirectory', () => {
    expect(backupSubdir('AUTOMATIC')).toBe('automatic');
    expect(backupSubdir('MANUAL')).toBe('manual');
    expect(backupSubdir('PRE_MIGRATION')).toBe('pre-migration');
    expect(backupDirFor('/root', 'PRE_MIGRATION')).toMatch(/pre-migration$/);
  });
});

describe('parseManagedBackupFile', () => {
  it('recognises our own artifacts', () => {
    expect(
      parseManagedBackupFile('gophones-automatic-v1-2026-09-10T00-00-00-000Z-abcdef01.sqlite'),
    ).toEqual({ type: 'AUTOMATIC', sourceSchemaVersion: 1 });
  });

  it('rejects anything that is not our pattern (retention never touches it)', () => {
    expect(parseManagedBackupFile('random.sqlite')).toBeNull();
    expect(parseManagedBackupFile('gophones.sqlite')).toBeNull();
    expect(parseManagedBackupFile('backup.db')).toBeNull();
    expect(parseManagedBackupFile('gophones-unknown-v1-x.sqlite')).toBeNull();
  });
});
