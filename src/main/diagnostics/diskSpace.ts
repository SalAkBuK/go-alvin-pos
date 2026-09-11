import { statfs } from 'node:fs/promises';
import type { DiskDiagnostic, HealthStatus } from '../../shared/diagnostics';

export const GIBIBYTE = 1024 * 1024 * 1024;
export const DISK_WARNING_BELOW_BYTES = 2 * GIBIBYTE;
export const DISK_CRITICAL_BELOW_BYTES = 500 * 1024 * 1024;

export interface DiskSpaceInspector {
  /** Inspect the filesystem containing this trusted main-process path. */
  availableBytes(storagePath: string): Promise<number>;
}

export function createDiskSpaceInspector(): DiskSpaceInspector {
  return {
    async availableBytes(storagePath): Promise<number> {
      const result = await statfs(storagePath, { bigint: true });
      const available = result.bavail * result.bsize;
      return Number(
        available > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : available,
      );
    },
  };
}

export function classifyDiskSpace(availableBytes: number): DiskDiagnostic {
  let status: HealthStatus = 'HEALTHY';
  let issueCode: DiskDiagnostic['issueCode'] = null;
  if (availableBytes < DISK_CRITICAL_BELOW_BYTES) {
    status = 'CRITICAL';
    issueCode = 'DISK_SPACE_CRITICAL';
  } else if (availableBytes < DISK_WARNING_BELOW_BYTES) {
    status = 'WARNING';
    issueCode = 'DISK_SPACE_LOW';
  }
  return {
    status,
    inspectionAvailable: true,
    availableBytes,
    warningBelowBytes: DISK_WARNING_BELOW_BYTES,
    criticalBelowBytes: DISK_CRITICAL_BELOW_BYTES,
    issueCode,
  };
}

export function failedDiskInspection(): DiskDiagnostic {
  return {
    status: 'WARNING',
    inspectionAvailable: false,
    availableBytes: null,
    warningBelowBytes: DISK_WARNING_BELOW_BYTES,
    criticalBelowBytes: DISK_CRITICAL_BELOW_BYTES,
    issueCode: 'DISK_INSPECTION_FAILED',
  };
}
