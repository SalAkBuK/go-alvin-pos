import { createHash } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { RestoreCandidate } from '../../shared/restore';
import type { BackupLocationKind } from '../../shared/backup';
import { migrationChecksum } from '../database/migrationRunner';
import { PRODUCTION_MIGRATIONS } from '../database/migrations';
import type { Migration } from '../database/types';
import { backupDirFor, parseManagedBackupFile } from './backupNaming';
import type { BackupRecordRow } from './backupRecordsRepository';
import { listBackupRecords } from './backupRecordsRepository';
import {
  type BackupManifestV1,
  type BackupManifestReadResult,
  readBackupManifest,
} from './backupManifest';
import { BACKUP_REQUIRED_TABLES, sha256File } from './backupSnapshot';

export const BACKUP_DISCOVERY_ERROR_CODES = {
  pathUnavailable: 'BACKUP_CANDIDATE_UNAVAILABLE',
  pathOutsideRoot: 'BACKUP_CANDIDATE_OUTSIDE_MANAGED_ROOT',
  fileChanged: 'BACKUP_CANDIDATE_CHANGED',
  notReadable: 'BACKUP_NOT_READABLE',
  integrityFailed: 'BACKUP_INTEGRITY_FAILED',
  fkViolations: 'BACKUP_FK_VIOLATIONS',
  notGoPhonesSchema: 'BACKUP_NOT_GO_PHONES_SCHEMA',
  schemaHistoryInvalid: 'BACKUP_SCHEMA_HISTORY_INVALID',
  schemaVersionMismatch: 'BACKUP_SCHEMA_VERSION_MISMATCH',
  criticalTableUnreadable: 'BACKUP_CRITICAL_TABLE_UNREADABLE',
  catalogMismatch: 'BACKUP_CATALOG_MISMATCH',
  manifestInvalid: 'BACKUP_MANIFEST_INVALID',
  manifestMismatch: 'BACKUP_MANIFEST_MISMATCH',
} as const;

export type BackupDiscoveryErrorCode =
  (typeof BACKUP_DISCOVERY_ERROR_CODES)[keyof typeof BACKUP_DISCOVERY_ERROR_CODES];

export interface VerifiedBackupFile {
  readonly filePath: string;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly schemaVersion: number;
  readonly modifiedAt: string;
  readonly manifest: BackupManifestV1 | null;
}

export type VerifyBackupCandidateResult =
  | { readonly ok: true; readonly value: VerifiedBackupFile }
  | { readonly ok: false; readonly errorCode: BackupDiscoveryErrorCode };

export interface BackupDiscoveryOptions {
  /** Parent of the canonical local `automatic/` and `manual/` directories. */
  readonly localBackupsRoot: string;
  /** Parent of the configured OFF_DEVICE `automatic/` and `manual/` directories. */
  readonly offDeviceBackupsRoot?: string | null;
  readonly migrations?: readonly Migration[];
}

export interface DiscoveredManagedBackup {
  readonly candidate: RestoreCandidate;
  /** Trusted-main-process-only canonical path; never return this object over IPC. */
  readonly filePath: string;
  readonly checksumSha256: string;
  readonly manifest: BackupManifestV1 | null;
  readonly catalogRecord: BackupRecordRow | null;
}

export interface RejectedManagedBackup {
  /** Catalog id is already opaque; absent for a filesystem-only artifact. */
  readonly backupId: string | null;
  readonly errorCode: BackupDiscoveryErrorCode;
}

export interface BackupDiscoveryResult {
  readonly candidates: readonly DiscoveredManagedBackup[];
  readonly rejected: readonly RejectedManagedBackup[];
}

interface ManagedRoot {
  readonly parentDirectory: string;
  readonly directory: string;
  readonly backupType: 'AUTOMATIC' | 'MANUAL';
  readonly locationKind: BackupLocationKind;
}

interface PhysicalSource {
  readonly canonicalPath: string;
  readonly backupType: 'AUTOMATIC' | 'MANUAL';
  readonly locationKind: BackupLocationKind;
  readonly catalogRecords: readonly BackupRecordRow[];
}

/**
 * One read-only discovery pass across live catalogue rows and the four known
 * managed directories. It never inserts reconstructed `backup_records` rows.
 */
export async function discoverManagedBackups(
  db: Database.Database,
  options: BackupDiscoveryOptions,
): Promise<BackupDiscoveryResult> {
  const roots = managedRoots(options);
  const rootStates = (
    await Promise.all(
      roots.map(async (root) => {
        try {
          const canonicalParent = await realpath(root.parentDirectory);
          const canonicalDirectory = await realpath(root.directory);
          if (!isContainedFile(canonicalParent, canonicalDirectory)) return null;
          return { ...root, canonicalDirectory };
        } catch {
          return null;
        }
      }),
    )
  ).filter((root): root is ManagedRoot & { readonly canonicalDirectory: string } => root !== null);

  const completedRows = listBackupRecords(db).filter(isRestorableCatalogRow);
  const byCanonicalPath = new Map<string, PhysicalSource>();
  const rejected: RejectedManagedBackup[] = [];

  // Catalogue rows are a source, but only when their real path remains within
  // the configured managed root of the claimed type and location.
  for (const row of completedRows) {
    const root = rootStates.find(
      (candidate) =>
        candidate.backupType === row.backupType && candidate.locationKind === row.locationKind,
    );
    const catalogPath = safeCatalogPath(row);
    if (!root || !catalogPath) {
      rejected.push({ backupId: row.id, errorCode: BACKUP_DISCOVERY_ERROR_CODES.pathOutsideRoot });
      continue;
    }
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(catalogPath);
    } catch {
      rejected.push({ backupId: row.id, errorCode: BACKUP_DISCOVERY_ERROR_CODES.pathUnavailable });
      continue;
    }
    if (!isContainedFile(root.canonicalDirectory, canonicalPath)) {
      rejected.push({ backupId: row.id, errorCode: BACKUP_DISCOVERY_ERROR_CODES.pathOutsideRoot });
      continue;
    }
    addPhysicalSource(byCanonicalPath, {
      canonicalPath,
      backupType: root.backupType,
      locationKind: root.locationKind,
      catalogRecord: row,
    });
  }

  // Filesystem rediscovery is intentionally shallow and filename-filtered.
  for (const root of rootStates) {
    let entries;
    try {
      entries = await readdir(root.canonicalDirectory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.endsWith('.partial')) continue;
      const parsed = parseManagedBackupFile(entry.name);
      if (!parsed || parsed.type !== root.backupType) continue;

      let canonicalPath: string;
      try {
        canonicalPath = await realpath(join(root.canonicalDirectory, entry.name));
        const fileStat = await stat(canonicalPath);
        if (!fileStat.isFile() || !isContainedFile(root.canonicalDirectory, canonicalPath))
          continue;
      } catch {
        continue;
      }
      addPhysicalSource(byCanonicalPath, {
        canonicalPath,
        backupType: root.backupType,
        locationKind: root.locationKind,
        catalogRecord: null,
      });
    }
  }

  const candidates: DiscoveredManagedBackup[] = [];
  for (const source of byCanonicalPath.values()) {
    const catalogRecord = chooseCatalogRecord(source.catalogRecords);
    const verification = await verifyBackupCandidate(source.canonicalPath, {
      ...(options.migrations ? { migrations: options.migrations } : {}),
      catalogRecord,
      expectedBackupType: source.backupType,
      expectedLocationKind: source.locationKind,
    });
    if (!verification.ok) {
      rejected.push({ backupId: catalogRecord?.id ?? null, errorCode: verification.errorCode });
      continue;
    }

    const verified = verification.value;
    const backupId =
      catalogRecord?.id ?? opaquePhysicalCandidateId(verified.filePath, verified.checksumSha256);
    const createdAt =
      catalogRecord?.completedAt ?? verified.manifest?.completedAt ?? verified.modifiedAt;
    candidates.push({
      candidate: {
        backupId,
        backupType: source.backupType,
        createdAt,
        sourceAppVersion:
          catalogRecord?.sourceAppVersion ?? verified.manifest?.sourceAppVersion ?? 'unknown',
        schemaVersion: verified.schemaVersion,
        sizeBytes: verified.sizeBytes,
        locationKind: source.locationKind,
        sourceKind: 'MANAGED',
        catalogued: catalogRecord !== null,
      },
      filePath: verified.filePath,
      checksumSha256: verified.checksumSha256,
      manifest: verified.manifest,
      catalogRecord,
    });
  }

  candidates.sort(
    (a, b) =>
      b.candidate.createdAt.localeCompare(a.candidate.createdAt) ||
      a.candidate.backupId.localeCompare(b.candidate.backupId),
  );
  return { candidates, rejected };
}

/**
 * Full common verification for managed and Browse-selected candidates. The
 * path is resolved, hashed afresh, and opened read-only; catalogue and sidecar
 * metadata are claims to compare, never trust roots.
 */
export async function verifyBackupCandidate(
  filePath: string,
  options: {
    readonly migrations?: readonly Migration[];
    readonly catalogRecord?: BackupRecordRow | null;
    readonly expectedBackupType?: 'AUTOMATIC' | 'MANUAL';
    readonly expectedLocationKind?: BackupLocationKind;
  } = {},
): Promise<VerifyBackupCandidateResult> {
  let canonicalPath: string;
  let before;
  try {
    canonicalPath = await realpath(filePath);
    before = await stat(canonicalPath);
    if (!before.isFile()) return failure(BACKUP_DISCOVERY_ERROR_CODES.notReadable);
  } catch {
    return failure(BACKUP_DISCOVERY_ERROR_CODES.pathUnavailable);
  }

  let checksumSha256: string;
  try {
    checksumSha256 = await sha256File(canonicalPath);
  } catch {
    return failure(BACKUP_DISCOVERY_ERROR_CODES.notReadable);
  }

  const schema = verifySqliteExactly(canonicalPath, options.migrations ?? PRODUCTION_MIGRATIONS);
  if (!schema.ok) return schema;

  let after;
  try {
    after = await stat(canonicalPath);
  } catch {
    return failure(BACKUP_DISCOVERY_ERROR_CODES.fileChanged);
  }
  if (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    (before.ino !== 0 && after.ino !== 0 && before.ino !== after.ino)
  ) {
    return failure(BACKUP_DISCOVERY_ERROR_CODES.fileChanged);
  }

  // Metadata can be preserved while content is replaced. Hash again so the
  // returned identity names the exact bytes that passed SQLite verification.
  let checksumAfterVerification: string;
  try {
    checksumAfterVerification = await sha256File(canonicalPath);
  } catch {
    return failure(BACKUP_DISCOVERY_ERROR_CODES.fileChanged);
  }
  if (checksumAfterVerification !== checksumSha256) {
    return failure(BACKUP_DISCOVERY_ERROR_CODES.fileChanged);
  }

  if (
    !catalogClaimsMatch(options.catalogRecord, checksumSha256, after.size, schema.schemaVersion)
  ) {
    return failure(BACKUP_DISCOVERY_ERROR_CODES.catalogMismatch);
  }

  const manifestRead = await readBackupManifest(canonicalPath);
  if (manifestRead.status === 'INVALID') {
    return failure(BACKUP_DISCOVERY_ERROR_CODES.manifestInvalid);
  }
  const manifest = manifestRead.status === 'VALID' ? manifestRead.manifest : null;
  if (
    !manifestClaimsMatch(manifest, {
      checksumSha256,
      sizeBytes: after.size,
      schemaVersion: schema.schemaVersion,
      ...(options.expectedBackupType ? { backupType: options.expectedBackupType } : {}),
      ...(options.expectedLocationKind ? { locationKind: options.expectedLocationKind } : {}),
    })
  ) {
    return failure(BACKUP_DISCOVERY_ERROR_CODES.manifestMismatch);
  }

  return {
    ok: true,
    value: {
      filePath: canonicalPath,
      checksumSha256,
      sizeBytes: after.size,
      schemaVersion: schema.schemaVersion,
      modifiedAt: after.mtime.toISOString(),
      manifest,
    },
  };
}

export function opaquePhysicalCandidateId(canonicalPath: string, checksumSha256: string): string {
  return `managed-${createHash('sha256')
    .update('go-phones-pos-managed-candidate-v1\0')
    .update(canonicalPathIdentity(canonicalPath))
    .update('\0')
    .update(checksumSha256)
    .digest('hex')}`;
}

function verifySqliteExactly(
  filePath: string,
  migrations: readonly Migration[],
):
  | { readonly ok: true; readonly schemaVersion: number }
  | { readonly ok: false; readonly errorCode: BackupDiscoveryErrorCode } {
  let db: Database.Database | undefined;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON');

    const quick = String(db.pragma('quick_check', { simple: true })).toLowerCase();
    if (quick !== 'ok') return failure(BACKUP_DISCOVERY_ERROR_CODES.integrityFailed);
    if ((db.pragma('foreign_key_check') as unknown[]).length > 0) {
      return failure(BACKUP_DISCOVERY_ERROR_CODES.fkViolations);
    }

    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map(({ name }) => name),
    );
    if (!tables.has('schema_migrations')) {
      return failure(BACKUP_DISCOVERY_ERROR_CODES.notGoPhonesSchema);
    }

    let history: Array<{ version: number; name: string; checksum: string }>;
    try {
      history = db
        .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
        .all() as Array<{ version: number; name: string; checksum: string }>;
    } catch {
      return failure(BACKUP_DISCOVERY_ERROR_CODES.schemaHistoryInvalid);
    }
    const expected = [...migrations].sort((a, b) => a.version - b.version);
    const latestExpected = expected.at(-1)?.version ?? 0;
    const latestActual = history.at(-1)?.version ?? 0;
    if (latestActual !== latestExpected) {
      return failure(BACKUP_DISCOVERY_ERROR_CODES.schemaVersionMismatch);
    }
    if (
      history.length !== expected.length ||
      history.some(
        (row, index) =>
          row.version !== expected[index]?.version ||
          row.name !== expected[index]?.name ||
          row.checksum !== migrationChecksum(expected[index]!),
      )
    ) {
      return failure(BACKUP_DISCOVERY_ERROR_CODES.schemaHistoryInvalid);
    }

    for (const table of BACKUP_REQUIRED_TABLES) {
      if (!tables.has(table)) {
        return failure(BACKUP_DISCOVERY_ERROR_CODES.criticalTableUnreadable);
      }
      try {
        db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
      } catch {
        return failure(BACKUP_DISCOVERY_ERROR_CODES.criticalTableUnreadable);
      }
    }
    return { ok: true, schemaVersion: latestActual };
  } catch {
    return failure(BACKUP_DISCOVERY_ERROR_CODES.notReadable);
  } finally {
    db?.close();
  }
}

function managedRoots(options: BackupDiscoveryOptions): ManagedRoot[] {
  const roots: ManagedRoot[] = [
    {
      parentDirectory: options.localBackupsRoot,
      directory: backupDirFor(options.localBackupsRoot, 'AUTOMATIC'),
      backupType: 'AUTOMATIC',
      locationKind: 'LOCAL_DISK',
    },
    {
      parentDirectory: options.localBackupsRoot,
      directory: backupDirFor(options.localBackupsRoot, 'MANUAL'),
      backupType: 'MANUAL',
      locationKind: 'LOCAL_DISK',
    },
  ];
  if (options.offDeviceBackupsRoot) {
    roots.push(
      {
        parentDirectory: options.offDeviceBackupsRoot,
        directory: backupDirFor(options.offDeviceBackupsRoot, 'AUTOMATIC'),
        backupType: 'AUTOMATIC',
        locationKind: 'OFF_DEVICE',
      },
      {
        parentDirectory: options.offDeviceBackupsRoot,
        directory: backupDirFor(options.offDeviceBackupsRoot, 'MANUAL'),
        backupType: 'MANUAL',
        locationKind: 'OFF_DEVICE',
      },
    );
  }
  return roots;
}

function isRestorableCatalogRow(row: BackupRecordRow): row is BackupRecordRow & {
  readonly backupType: 'AUTOMATIC' | 'MANUAL';
  readonly status: 'COMPLETED';
  readonly fileName: string;
  readonly storagePath: string;
} {
  return (
    row.status === 'COMPLETED' &&
    (row.backupType === 'AUTOMATIC' || row.backupType === 'MANUAL') &&
    row.fileName !== null &&
    row.storagePath !== null
  );
}

function safeCatalogPath(row: BackupRecordRow): string | null {
  if (
    row.fileName === null ||
    row.storagePath === null ||
    row.fileName.includes('/') ||
    row.fileName.includes('\\') ||
    row.fileName.includes('..') ||
    parseManagedBackupFile(row.fileName)?.type !== row.backupType
  ) {
    return null;
  }
  return join(row.storagePath, row.fileName);
}

function isContainedFile(root: string, file: string): boolean {
  const child = relative(root, file);
  return (
    child.length > 0 &&
    child !== '..' &&
    !child.startsWith(`..${separator()}`) &&
    !isAbsolute(child)
  );
}

function separator(): '\\' | '/' {
  return process.platform === 'win32' ? '\\' : '/';
}

function canonicalPathIdentity(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLocaleLowerCase('en-US') : absolute;
}

function addPhysicalSource(
  sources: Map<string, PhysicalSource>,
  input: Omit<PhysicalSource, 'catalogRecords'> & {
    readonly catalogRecord: BackupRecordRow | null;
  },
): void {
  const key = canonicalPathIdentity(input.canonicalPath);
  const current = sources.get(key);
  if (current) {
    if (input.catalogRecord) {
      sources.set(key, {
        ...current,
        catalogRecords: [...current.catalogRecords, input.catalogRecord],
      });
    }
    return;
  }
  sources.set(key, {
    canonicalPath: input.canonicalPath,
    backupType: input.backupType,
    locationKind: input.locationKind,
    catalogRecords: input.catalogRecord ? [input.catalogRecord] : [],
  });
}

function chooseCatalogRecord(rows: readonly BackupRecordRow[]): BackupRecordRow | null {
  return (
    [...rows].sort(
      (a, b) =>
        (b.completedAt ?? b.startedAt).localeCompare(a.completedAt ?? a.startedAt) ||
        b.id.localeCompare(a.id),
    )[0] ?? null
  );
}

function catalogClaimsMatch(
  row: BackupRecordRow | null | undefined,
  checksum: string,
  sizeBytes: number,
  schemaVersion: number,
): boolean {
  if (!row) return true;
  return (
    row.checksumSha256 === checksum &&
    row.sizeBytes === sizeBytes &&
    row.sourceSchemaVersion === schemaVersion
  );
}

function manifestClaimsMatch(
  manifest: BackupManifestV1 | null,
  actual: {
    readonly checksumSha256: string;
    readonly sizeBytes: number;
    readonly schemaVersion: number;
    readonly backupType?: 'AUTOMATIC' | 'MANUAL';
    readonly locationKind?: BackupLocationKind;
  },
): boolean {
  if (!manifest) return true;
  return (
    manifest.checksumSha256 === actual.checksumSha256 &&
    manifest.sizeBytes === actual.sizeBytes &&
    manifest.sourceSchemaVersion === actual.schemaVersion &&
    (actual.backupType === undefined || manifest.backupType === actual.backupType) &&
    (actual.locationKind === undefined || manifest.locationKind === actual.locationKind)
  );
}

function failure(errorCode: BackupDiscoveryErrorCode): {
  readonly ok: false;
  readonly errorCode: BackupDiscoveryErrorCode;
} {
  return { ok: false, errorCode };
}

// Preserve this import as part of the public read-result contract for callers.
export type { BackupManifestReadResult };
