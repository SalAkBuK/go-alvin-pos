import { copyFile, mkdir, open, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BACKUP_DISCOVERY_ERROR_CODES,
  discoverManagedBackups,
  opaquePhysicalCandidateId,
  verifyBackupCandidate,
} from '../../src/main/backup/backupDiscovery';
import {
  writeBackupManifestAtomic,
  type BackupManifestV1,
} from '../../src/main/backup/backupManifest';
import { backupDirFor } from '../../src/main/backup/backupNaming';
import { createSqliteSnapshot, sha256File } from '../../src/main/backup/backupSnapshot';
import { migrationChecksum } from '../../src/main/database/migrationRunner';
import { PRODUCTION_MIGRATIONS } from '../../src/main/database/migrations';
import { createMigratedDb, makeTempDir, type TempDir } from '../helpers/database';

const tempDirs: TempDir[] = [];

afterEach(() => {
  while (tempDirs.length > 0) tempDirs.pop()!.cleanup();
});

function temp(prefix: string): TempDir {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

function managedName(type: 'automatic' | 'manual', suffix = 'abcd1234'): string {
  return `gophones-${type}-v1-2026-09-11T10-00-00-000Z-${suffix}.sqlite`;
}

async function makeSnapshot(
  root: string,
  type: 'AUTOMATIC' | 'MANUAL' = 'AUTOMATIC',
  name = managedName(type === 'AUTOMATIC' ? 'automatic' : 'manual'),
): Promise<string> {
  const sourcePath = join(temp('gpp-source-').path, 'source.sqlite');
  const source = await createMigratedDb(sourcePath);
  const directory = backupDirFor(root, type);
  const destination = join(directory, name);
  try {
    await createSqliteSnapshot(source, destination);
  } finally {
    source.close();
  }
  return destination;
}

function insertCatalogRow(
  db: Database.Database,
  input: {
    id: string;
    filePath: string;
    type?: 'AUTOMATIC' | 'MANUAL';
    location?: 'LOCAL_DISK' | 'OFF_DEVICE';
    checksum: string;
    size: number;
    schema?: number;
  },
): void {
  const slash = Math.max(input.filePath.lastIndexOf('/'), input.filePath.lastIndexOf('\\'));
  db.prepare(
    `INSERT INTO backup_records
       (id, backup_type, location_kind, status, file_name, storage_path, source_app_version,
        source_schema_version, target_app_version, size_bytes, checksum_sha256, started_at,
        completed_at, error_code)
     VALUES (?, ?, ?, 'COMPLETED', ?, ?, 'catalog-app', ?, NULL, ?, ?, ?, ?, NULL)`,
  ).run(
    input.id,
    input.type ?? 'AUTOMATIC',
    input.location ?? 'LOCAL_DISK',
    input.filePath.slice(slash + 1),
    input.filePath.slice(0, slash),
    input.schema ?? 1,
    input.size,
    input.checksum,
    '2026-09-11T10:00:00.000Z',
    '2026-09-11T10:00:01.000Z',
  );
}

async function manifestFor(filePath: string): Promise<BackupManifestV1> {
  const file = await import('node:fs/promises').then(({ stat }) => stat(filePath));
  return {
    manifestVersion: 1,
    logicalBackupId: 'logical-1',
    backupType: 'AUTOMATIC',
    createdAt: '2026-09-11T10:00:00.000Z',
    completedAt: '2026-09-11T10:00:01.000Z',
    sourceAppVersion: 'test',
    sourceSchemaVersion: 1,
    checksumSha256: await sha256File(filePath),
    sizeBytes: file.size,
    locationKind: 'OFF_DEVICE',
  };
}

describe('unified managed backup discovery', () => {
  it('rediscovers an uncatalogued final backup without mutating backup_records', async () => {
    const localRoot = temp('gpp-discovery-local-').path;
    const filePath = await makeSnapshot(localRoot);
    const live = await createMigratedDb();
    try {
      const before = (
        live.prepare('SELECT COUNT(*) AS count FROM backup_records').get() as { count: number }
      ).count;
      const first = await discoverManagedBackups(live, { localBackupsRoot: localRoot });
      const second = await discoverManagedBackups(live, { localBackupsRoot: localRoot });

      expect(first.candidates).toHaveLength(1);
      expect(first.candidates[0]!.candidate).toMatchObject({
        backupType: 'AUTOMATIC',
        locationKind: 'LOCAL_DISK',
        sourceKind: 'MANAGED',
        catalogued: false,
      });
      expect(first.candidates[0]!.candidate.backupId).toBe(
        second.candidates[0]!.candidate.backupId,
      );
      expect(first.candidates[0]!.candidate.backupId).not.toContain(filePath);
      expect(
        (live.prepare('SELECT COUNT(*) AS count FROM backup_records').get() as { count: number })
          .count,
      ).toBe(before);
    } finally {
      live.close();
    }
  });

  it('deduplicates catalog + filesystem references to one real file', async () => {
    const localRoot = temp('gpp-discovery-dedup-').path;
    const filePath = await makeSnapshot(localRoot);
    const checksum = await sha256File(filePath);
    const size = (await import('node:fs/promises').then(({ stat }) => stat(filePath))).size;
    const live = await createMigratedDb();
    try {
      insertCatalogRow(live, { id: 'catalog-id', filePath, checksum, size });
      const result = await discoverManagedBackups(live, { localBackupsRoot: localRoot });
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]!.candidate).toMatchObject({
        backupId: 'catalog-id',
        catalogued: true,
      });
    } finally {
      live.close();
    }
  });

  it('does not offer a catalogued file that is missing from disk', async () => {
    const localRoot = temp('gpp-discovery-missing-').path;
    const automatic = backupDirFor(localRoot, 'AUTOMATIC');
    await mkdir(automatic, { recursive: true });
    const live = await createMigratedDb();
    try {
      insertCatalogRow(live, {
        id: 'missing-id',
        filePath: join(automatic, managedName('automatic')),
        checksum: 'a'.repeat(64),
        size: 4096,
      });
      const result = await discoverManagedBackups(live, { localBackupsRoot: localRoot });
      expect(result.candidates).toHaveLength(0);
      expect(result.rejected).toContainEqual({
        backupId: 'missing-id',
        errorCode: BACKUP_DISCOVERY_ERROR_CODES.pathUnavailable,
      });
    } finally {
      live.close();
    }
  });

  it('keeps byte-identical LOCAL_DISK and OFF_DEVICE physical copies distinct', async () => {
    const localRoot = temp('gpp-discovery-two-local-').path;
    const offRoot = temp('gpp-discovery-two-off-').path;
    const localPath = await makeSnapshot(localRoot);
    const offDirectory = backupDirFor(offRoot, 'AUTOMATIC');
    const offPath = join(offDirectory, managedName('automatic'));
    await mkdir(offDirectory, { recursive: true });
    await copyFile(localPath, offPath);

    const live = await createMigratedDb();
    try {
      const result = await discoverManagedBackups(live, {
        localBackupsRoot: localRoot,
        offDeviceBackupsRoot: offRoot,
      });
      expect(result.candidates).toHaveLength(2);
      expect(new Set(result.candidates.map(({ candidate }) => candidate.backupId)).size).toBe(2);
      expect(result.candidates.map(({ candidate }) => candidate.locationKind).sort()).toEqual([
        'LOCAL_DISK',
        'OFF_DEVICE',
      ]);
      expect(new Set(result.candidates.map(({ checksumSha256 }) => checksumSha256)).size).toBe(1);
    } finally {
      live.close();
    }
  });

  it('excludes partial, unrelated SQLite, corrupted, and nested candidates', async () => {
    const localRoot = temp('gpp-discovery-filter-').path;
    const automatic = backupDirFor(localRoot, 'AUTOMATIC');
    await mkdir(join(automatic, 'nested'), { recursive: true });
    await writeFile(join(automatic, `${managedName('automatic')}.partial`), 'partial');
    await writeFile(join(automatic, managedName('automatic', 'corrupt')), 'not sqlite');
    const unrelatedPath = join(automatic, managedName('automatic', 'unrelated'));
    const unrelated = new Database(unrelatedPath);
    unrelated.exec('CREATE TABLE something_else (id INTEGER PRIMARY KEY)');
    unrelated.close();
    await writeFile(join(automatic, 'nested', managedName('automatic', 'nested')), 'not scanned');

    const live = await createMigratedDb();
    try {
      const result = await discoverManagedBackups(live, { localBackupsRoot: localRoot });
      expect(result.candidates).toHaveLength(0);
      expect(result.rejected.map(({ errorCode }) => errorCode)).toEqual(
        expect.arrayContaining([
          BACKUP_DISCOVERY_ERROR_CODES.notReadable,
          BACKUP_DISCOVERY_ERROR_CODES.notGoPhonesSchema,
        ]),
      );
    } finally {
      live.close();
    }
  });

  it('rejects a symlink/reparse candidate that resolves outside its managed root', async () => {
    const localRoot = temp('gpp-discovery-link-local-').path;
    const outsideRoot = temp('gpp-discovery-link-outside-').path;
    const outsidePath = await makeSnapshot(outsideRoot);
    const automatic = backupDirFor(localRoot, 'AUTOMATIC');
    await mkdir(automatic, { recursive: true });
    try {
      await symlink(outsidePath, join(automatic, managedName('automatic')), 'file');
    } catch (error) {
      // Windows without Developer Mode cannot create a test symlink. The same
      // realpath-containment branch is exercised on platforms that permit it.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }

    const live = await createMigratedDb();
    try {
      const result = await discoverManagedBackups(live, { localBackupsRoot: localRoot });
      expect(result.candidates).toHaveLength(0);
    } finally {
      live.close();
    }
  });

  it('rejects a managed type directory reparse point that escapes its parent root', async () => {
    const localRoot = temp('gpp-discovery-root-link-').path;
    const outsideRoot = temp('gpp-discovery-root-target-').path;
    await makeSnapshot(outsideRoot);
    const automatic = backupDirFor(localRoot, 'AUTOMATIC');
    try {
      await symlink(
        backupDirFor(outsideRoot, 'AUTOMATIC'),
        automatic,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }

    const live = await createMigratedDb();
    try {
      const result = await discoverManagedBackups(live, { localBackupsRoot: localRoot });
      expect(result.candidates).toHaveLength(0);
    } finally {
      live.close();
    }
  });
});

describe('independent candidate verification', () => {
  it('accepts a valid backup without a legacy sidecar', async () => {
    const filePath = await makeSnapshot(temp('gpp-verify-valid-').path);
    const result = await verifyBackupCandidate(filePath);
    expect(result.ok).toBe(true);
  });

  it('rejects catalog checksum, size, and schema claims that do not match actual bytes', async () => {
    const root = temp('gpp-verify-catalog-').path;
    const filePath = await makeSnapshot(root);
    const size = (await import('node:fs/promises').then(({ stat }) => stat(filePath))).size;
    const live = await createMigratedDb();
    try {
      insertCatalogRow(live, { id: 'bad-claim', filePath, checksum: '0'.repeat(64), size });
      const result = await discoverManagedBackups(live, { localBackupsRoot: root });
      expect(result.candidates).toHaveLength(0);
      expect(result.rejected).toContainEqual({
        backupId: 'bad-claim',
        errorCode: BACKUP_DISCOVERY_ERROR_CODES.catalogMismatch,
      });
    } finally {
      live.close();
    }
  });

  it('rejects malformed and mismatching sidecars but accepts a matching one', async () => {
    const filePath = await makeSnapshot(temp('gpp-verify-manifest-').path);
    const valid = await manifestFor(filePath);
    await writeBackupManifestAtomic(filePath, valid);
    expect(
      await verifyBackupCandidate(filePath, {
        expectedBackupType: 'AUTOMATIC',
        expectedLocationKind: 'OFF_DEVICE',
      }),
    ).toMatchObject({ ok: true });

    await writeBackupManifestAtomic(filePath, { ...valid, checksumSha256: '0'.repeat(64) });
    expect(await verifyBackupCandidate(filePath)).toEqual({
      ok: false,
      errorCode: BACKUP_DISCOVERY_ERROR_CODES.manifestMismatch,
    });

    await writeBackupManifestAtomic(filePath, { ...valid, sourceSchemaVersion: 2 });
    expect(await verifyBackupCandidate(filePath)).toEqual({
      ok: false,
      errorCode: BACKUP_DISCOVERY_ERROR_CODES.manifestMismatch,
    });

    await writeFile(`${filePath}.manifest.json`, '{broken', 'utf8');
    expect(await verifyBackupCandidate(filePath)).toEqual({
      ok: false,
      errorCode: BACKUP_DISCOVERY_ERROR_CODES.manifestInvalid,
    });
  });

  it('rejects migration checksum drift and incompatible schema history', async () => {
    const filePath = await makeSnapshot(temp('gpp-verify-schema-').path);
    const tampered = new Database(filePath);
    tampered
      .prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1')
      .run('0'.repeat(64));
    tampered.close();
    expect(await verifyBackupCandidate(filePath)).toEqual({
      ok: false,
      errorCode: BACKUP_DISCOVERY_ERROR_CODES.schemaHistoryInvalid,
    });

    const expectedChecksum = migrationChecksum(PRODUCTION_MIGRATIONS[0]!);
    const incompatible = new Database(filePath);
    incompatible
      .prepare('UPDATE schema_migrations SET version = 2, checksum = ? WHERE version = 1')
      .run(expectedChecksum);
    incompatible.close();
    expect(await verifyBackupCandidate(filePath)).toEqual({
      ok: false,
      errorCode: BACKUP_DISCOVERY_ERROR_CODES.schemaVersionMismatch,
    });
  });

  it('rejects databases with foreign-key violations', async () => {
    const filePath = await makeSnapshot(temp('gpp-verify-fk-').path);
    const violated = new Database(filePath);
    violated.pragma('foreign_keys = OFF');
    violated
      .prepare(
        `INSERT INTO google_sheet_export_jobs
           (id, sale_id, status, target_sync_version, attempt_count, created_at, updated_at)
         VALUES ('job', 'missing-sale', 'PENDING', 1, 0, ?, ?)`,
      )
      .run('2026-09-11T10:00:00.000Z', '2026-09-11T10:00:00.000Z');
    violated.close();
    expect(await verifyBackupCandidate(filePath)).toEqual({
      ok: false,
      errorCode: BACKUP_DISCOVERY_ERROR_CODES.fkViolations,
    });
  });

  it('builds an opaque identity from canonical path plus recalculated checksum', async () => {
    const first = opaquePhysicalCandidateId('C:\\managed\\a.sqlite', 'a'.repeat(64));
    expect(first).toBe(opaquePhysicalCandidateId('C:\\managed\\a.sqlite', 'a'.repeat(64)));
    expect(first).not.toBe(opaquePhysicalCandidateId('D:\\managed\\a.sqlite', 'a'.repeat(64)));
    expect(first).not.toBe(opaquePhysicalCandidateId('C:\\managed\\a.sqlite', 'b'.repeat(64)));
    expect(first).not.toContain('managed\\a.sqlite');
  });

  it('rejects a database that opens but fails PRAGMA quick_check', async () => {
    const filePath = await makeSnapshot(temp('gpp-verify-quickcheck-').path);

    // Corrupt a btree page's own type byte — NOT the 100-byte file header on
    // page 1, which would instead make the file fail to open at all
    // (`notReadable`, already covered elsewhere). The production schema's
    // many tables/indexes guarantee page 3 exists and holds real btree
    // content, so overwriting its first byte with a value that is not one of
    // SQLite's valid page-type codes deterministically corrupts that page's
    // structure without touching anything a mere `Database` open reads.
    const probe = new Database(filePath, { readonly: true, fileMustExist: true });
    const pageSize = probe.pragma('page_size', { simple: true }) as number;
    probe.close();

    const handle = await open(filePath, 'r+');
    try {
      await handle.write(Buffer.from([0xff]), 0, 1, pageSize * 2);
    } finally {
      await handle.close();
    }

    expect(await verifyBackupCandidate(filePath)).toEqual({
      ok: false,
      errorCode: BACKUP_DISCOVERY_ERROR_CODES.integrityFailed,
    });
  });

  it('rejects a database missing a required critical table', async () => {
    const filePath = await makeSnapshot(temp('gpp-verify-critical-table-').path);
    // `counters` has no incoming foreign-key references anywhere in the
    // schema, so dropping it cannot trip `quick_check`/`foreign_key_check` —
    // this isolates the critical-table-presence check specifically. Dropping
    // a table has no effect on the separately recorded `schema_migrations`
    // history, so the exact-schema-history check still passes.
    const tampered = new Database(filePath);
    tampered.exec('DROP TABLE counters');
    tampered.close();

    expect(await verifyBackupCandidate(filePath)).toEqual({
      ok: false,
      errorCode: BACKUP_DISCOVERY_ERROR_CODES.criticalTableUnreadable,
    });
  });
});
