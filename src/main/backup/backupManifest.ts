import { randomBytes } from 'node:crypto';
import { lstat, open, rename, rm, writeFile } from 'node:fs/promises';

/** Versioned, non-secret metadata written next to an OFF_DEVICE SQLite copy. */
export interface BackupManifestV1 {
  readonly manifestVersion: 1;
  readonly logicalBackupId: string;
  readonly backupType: 'AUTOMATIC' | 'MANUAL';
  readonly createdAt: string;
  readonly completedAt: string;
  readonly sourceAppVersion: string;
  readonly sourceSchemaVersion: number;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly locationKind: 'OFF_DEVICE';
}

export type BackupManifestReadResult =
  | { readonly status: 'MISSING' }
  | { readonly status: 'VALID'; readonly manifest: BackupManifestV1 }
  | { readonly status: 'INVALID'; readonly errorCode: 'BACKUP_MANIFEST_INVALID' };

const MANIFEST_SUFFIX = '.manifest.json';
const MAX_MANIFEST_BYTES = 16 * 1024;
const MANIFEST_KEYS = new Set([
  'manifestVersion',
  'logicalBackupId',
  'backupType',
  'createdAt',
  'completedAt',
  'sourceAppVersion',
  'sourceSchemaVersion',
  'checksumSha256',
  'sizeBytes',
  'locationKind',
]);

export function manifestPathForBackup(backupPath: string): string {
  return `${backupPath}${MANIFEST_SUFFIX}`;
}

/**
 * Write a complete sidecar before publishing it with an atomic same-directory
 * rename. A failed/crashed write can leave only a uniquely named `.partial`
 * file; discovery never enumerates sidecars or partials as SQLite candidates.
 */
export async function writeBackupManifestAtomic(
  backupPath: string,
  manifest: BackupManifestV1,
): Promise<void> {
  if (!isBackupManifestV1(manifest)) {
    throw new Error('BACKUP_MANIFEST_INVALID');
  }

  const destination = manifestPathForBackup(backupPath);
  const partial = `${destination}.${process.pid}-${randomBytes(6).toString('hex')}.partial`;
  try {
    await writeFile(partial, `${JSON.stringify(manifest)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(partial, destination);
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Read and strictly validate a v1 sidecar without trusting any of its claims. */
export async function readBackupManifest(backupPath: string): Promise<BackupManifestReadResult> {
  let handle;
  try {
    const path = manifestPathForBackup(backupPath);
    const linkStat = await lstat(path);
    if (!linkStat.isFile() || linkStat.isSymbolicLink()) {
      return { status: 'INVALID', errorCode: 'BACKUP_MANIFEST_INVALID' };
    }
    handle = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'MISSING' };
    }
    return { status: 'INVALID', errorCode: 'BACKUP_MANIFEST_INVALID' };
  }

  try {
    // Bound the allocation/read before parsing a possibly hostile sidecar.
    const bytes = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
    if (bytesRead > MAX_MANIFEST_BYTES) {
      return { status: 'INVALID', errorCode: 'BACKUP_MANIFEST_INVALID' };
    }
    const parsed: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    return isBackupManifestV1(parsed)
      ? { status: 'VALID', manifest: parsed }
      : { status: 'INVALID', errorCode: 'BACKUP_MANIFEST_INVALID' };
  } catch {
    return { status: 'INVALID', errorCode: 'BACKUP_MANIFEST_INVALID' };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Strict shape check also prevents accidentally adding secrets or business data. */
export function isBackupManifestV1(value: unknown): value is BackupManifestV1 {
  if (!isRecord(value) || Object.keys(value).some((key) => !MANIFEST_KEYS.has(key))) {
    return false;
  }
  return (
    Object.keys(value).length === MANIFEST_KEYS.size &&
    value.manifestVersion === 1 &&
    isIdentifier(value.logicalBackupId) &&
    (value.backupType === 'AUTOMATIC' || value.backupType === 'MANUAL') &&
    isIsoTimestamp(value.createdAt) &&
    isIsoTimestamp(value.completedAt) &&
    Date.parse(value.completedAt) >= Date.parse(value.createdAt) &&
    isShortNonEmpty(value.sourceAppVersion) &&
    typeof value.sourceSchemaVersion === 'number' &&
    Number.isSafeInteger(value.sourceSchemaVersion) &&
    value.sourceSchemaVersion >= 1 &&
    typeof value.checksumSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.checksumSha256) &&
    typeof value.sizeBytes === 'number' &&
    Number.isSafeInteger(value.sizeBytes) &&
    value.sizeBytes >= 0 &&
    value.locationKind === 'OFF_DEVICE'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isShortNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

function isIdentifier(value: unknown): value is string {
  return isShortNonEmpty(value) && /^[A-Za-z0-9._:-]+$/.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}
