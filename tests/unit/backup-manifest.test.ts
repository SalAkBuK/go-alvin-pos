import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isBackupManifestV1,
  manifestPathForBackup,
  readBackupManifest,
  writeBackupManifestAtomic,
  type BackupManifestV1,
} from '../../src/main/backup/backupManifest';
import { makeTempDir } from '../helpers/database';

function manifest(overrides: Partial<BackupManifestV1> = {}): BackupManifestV1 {
  return {
    manifestVersion: 1,
    logicalBackupId: 'backup-123',
    backupType: 'AUTOMATIC',
    createdAt: '2026-09-11T10:00:00.000Z',
    completedAt: '2026-09-11T10:00:01.000Z',
    sourceAppVersion: '0.1.0-test',
    sourceSchemaVersion: 1,
    checksumSha256: 'a'.repeat(64),
    sizeBytes: 4096,
    locationKind: 'OFF_DEVICE',
    ...overrides,
  };
}

describe('OFF_DEVICE backup manifest', () => {
  it('writes a strict versioned sidecar atomically and reads it back', async () => {
    const dir = makeTempDir('gpp-manifest-');
    try {
      const backupPath = join(dir.path, 'backup.sqlite');
      await writeBackupManifestAtomic(backupPath, manifest());

      expect(await readBackupManifest(backupPath)).toEqual({
        status: 'VALID',
        manifest: manifest(),
      });
      expect(JSON.parse(await readFile(manifestPathForBackup(backupPath), 'utf8'))).toEqual(
        manifest(),
      );
      await expect(access(`${manifestPathForBackup(backupPath)}.partial`)).rejects.toThrow();
    } finally {
      dir.cleanup();
    }
  });

  it('allows a missing sidecar for backward-compatible managed backups', async () => {
    const dir = makeTempDir('gpp-manifest-missing-');
    try {
      expect(await readBackupManifest(join(dir.path, 'older.sqlite'))).toEqual({
        status: 'MISSING',
      });
    } finally {
      dir.cleanup();
    }
  });

  it('rejects malformed, oversized, unknown-field, and unsupported-version sidecars', async () => {
    const dir = makeTempDir('gpp-manifest-invalid-');
    try {
      const backupPath = join(dir.path, 'backup.sqlite');
      const sidecar = manifestPathForBackup(backupPath);
      for (const value of [
        '{bad json',
        JSON.stringify({ ...manifest(), customerName: 'must never be here' }),
        JSON.stringify({ ...manifest(), manifestVersion: 2 }),
        'x'.repeat(16 * 1024 + 1),
      ]) {
        await writeFile(sidecar, value, 'utf8');
        expect(await readBackupManifest(backupPath)).toEqual({
          status: 'INVALID',
          errorCode: 'BACKUP_MANIFEST_INVALID',
        });
      }
    } finally {
      dir.cleanup();
    }
  });

  it('validates identifiers, exact UTC timestamps, hashes, and chronological order', () => {
    expect(isBackupManifestV1(manifest())).toBe(true);
    expect(isBackupManifestV1(manifest({ logicalBackupId: '../secret' }))).toBe(false);
    expect(isBackupManifestV1(manifest({ checksumSha256: 'A'.repeat(64) }))).toBe(false);
    expect(
      isBackupManifestV1(
        manifest({
          createdAt: '2026-09-11T10:00:02.000Z',
          completedAt: '2026-09-11T10:00:01.000Z',
        }),
      ),
    ).toBe(false);
  });
});
