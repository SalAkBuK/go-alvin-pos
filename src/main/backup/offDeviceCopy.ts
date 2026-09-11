import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { BackupType } from '../../shared/backup';
import { backupDirFor, parseManagedBackupFile } from './backupNaming';
import type { OffDeviceDestinationVerifier } from './offDeviceDestination';
import { sha256File, verifySqliteBackup } from './backupSnapshot';
import { writeBackupManifestAtomic } from './backupManifest';

export const OFF_DEVICE_COPY_ERROR_CODES = {
  destinationVerificationFailed: 'OFF_DEVICE_VERIFICATION_FAILED',
  invalidSource: 'OFF_DEVICE_SOURCE_INVALID',
  copyFailed: 'OFF_DEVICE_COPY_FAILED',
  copyTimedOut: 'OFF_DEVICE_COPY_TIMEOUT',
  copiedBytesInvalid: 'OFF_DEVICE_COPY_VERIFICATION_FAILED',
  manifestFailed: 'OFF_DEVICE_MANIFEST_FAILED',
} as const;

export interface OffDeviceCopyInput {
  readonly verifier: OffDeviceDestinationVerifier;
  readonly operationalDatabasePath: string;
  readonly offDeviceBackupsRoot: string;
  readonly sourceFilePath: string;
  readonly fileName: string;
  readonly backupType: Exclude<BackupType, 'PRE_MIGRATION'>;
  readonly logicalBackupId: string;
  readonly sourceAppVersion: string;
  readonly sourceSchemaVersion: number;
  readonly expectedChecksumSha256: string;
  readonly expectedSizeBytes: number;
  readonly createdAt: string;
  readonly completedAt: string;
  readonly timeoutMs?: number;
}

export type OffDeviceCopyOutcome =
  | {
      readonly ok: true;
      readonly destinationRoot: string;
      readonly destinationDirectory: string;
      readonly destinationKind: 'NETWORK' | 'USB';
      readonly fileName: string;
      readonly sizeBytes: number;
      readonly checksumSha256: string;
    }
  | { readonly ok: false; readonly errorCode: string };

/**
 * Copy one already-completed LOCAL_DISK artifact to a reverified OFF_DEVICE
 * destination. The final name is published only after the partial copy passes
 * its own SQLite, size, and SHA-256 checks. PRE_MIGRATION is excluded by type.
 */
export async function copyBackupOffDevice(
  input: OffDeviceCopyInput,
): Promise<OffDeviceCopyOutcome> {
  const parsed = parseManagedBackupFile(input.fileName);
  if (!parsed || parsed.type !== input.backupType) {
    return { ok: false, errorCode: OFF_DEVICE_COPY_ERROR_CODES.invalidSource };
  }

  const destination = await input.verifier.verify(
    input.operationalDatabasePath,
    input.offDeviceBackupsRoot,
  );
  if (!destination.ok) {
    return { ok: false, errorCode: destination.errorCode };
  }

  const destinationDirectory = backupDirFor(destination.canonicalPath, input.backupType);
  const finalPath = join(destinationDirectory, input.fileName);
  const partialPath = `${finalPath}.partial`;
  await mkdir(destinationDirectory, { recursive: true });
  await rm(partialPath, { force: true }).catch(() => undefined);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 30_000);
  try {
    await pipeline(
      createReadStream(input.sourceFilePath),
      createWriteStream(partialPath, { flags: 'wx', mode: 0o600 }),
      { signal: controller.signal },
    );
  } catch (error) {
    await rm(partialPath, { force: true }).catch(() => undefined);
    return {
      ok: false,
      errorCode:
        controller.signal.aborted || (error as { name?: unknown } | null)?.name === 'AbortError'
          ? OFF_DEVICE_COPY_ERROR_CODES.copyTimedOut
          : OFF_DEVICE_COPY_ERROR_CODES.copyFailed,
    };
  } finally {
    clearTimeout(timer);
  }

  try {
    const [copyStat, checksum] = await Promise.all([stat(partialPath), sha256File(partialPath)]);
    const verification = verifySqliteBackup(partialPath, {
      expectedSchemaVersion: input.sourceSchemaVersion,
    });
    if (
      !verification.ok ||
      copyStat.size !== input.expectedSizeBytes ||
      checksum !== input.expectedChecksumSha256
    ) {
      await rm(partialPath, { force: true }).catch(() => undefined);
      return { ok: false, errorCode: OFF_DEVICE_COPY_ERROR_CODES.copiedBytesInvalid };
    }

    await rename(partialPath, finalPath);
    try {
      await writeBackupManifestAtomic(finalPath, {
        manifestVersion: 1,
        logicalBackupId: input.logicalBackupId,
        backupType: input.backupType,
        createdAt: input.createdAt,
        completedAt: input.completedAt,
        sourceAppVersion: input.sourceAppVersion,
        sourceSchemaVersion: input.sourceSchemaVersion,
        checksumSha256: checksum,
        sizeBytes: copyStat.size,
        locationKind: 'OFF_DEVICE',
      });
    } catch {
      // Preserve the independently valid final SQLite artifact as recovery
      // evidence. Discovery deliberately supports valid legacy/missing-sidecar
      // files, but this copy attempt is not recorded as COMPLETED.
      return { ok: false, errorCode: OFF_DEVICE_COPY_ERROR_CODES.manifestFailed };
    }
    return {
      ok: true,
      destinationRoot: destination.canonicalPath,
      destinationDirectory,
      destinationKind: destination.kind,
      fileName: input.fileName,
      sizeBytes: copyStat.size,
      checksumSha256: checksum,
    };
  } catch {
    await rm(partialPath, { force: true }).catch(() => undefined);
    return { ok: false, errorCode: OFF_DEVICE_COPY_ERROR_CODES.copiedBytesInvalid };
  }
}
