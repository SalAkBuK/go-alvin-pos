import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Crash-consistent restore-in-progress marker (`DATA_MODEL.md §52A`;
 * `POS_WORKFLOWS.md §67A` step 8; Phase 2L-B Item 13).
 *
 * Written outside SQLite, under the pinned application-data root, BEFORE the
 * operational database is replaced. Startup inspects it BEFORE the normal
 * database open — if a previous process died after the destructive swap but
 * before the restored database validated, the verified pre-restore recovery
 * copy is put back first.
 *
 * The marker holds only the minimum internal recovery information: which
 * pre-restore recovery file (by name, resolved under `backups/pre-restore/`) to
 * fall back to. No absolute path is logged.
 */

export const RESTORE_MARKER_VERSION = 1 as const;

export interface RestoreMarker {
  readonly version: 1;
  /** File name (not a path) of the verified pre-restore recovery copy, under `backups/pre-restore/`. */
  readonly preRestoreFileName: string;
  /** ISO-8601 UTC — for diagnostics only. */
  readonly startedAt: string;
}

export type RestoreMarkerReadResult =
  | { readonly present: false }
  | { readonly present: true; readonly marker: RestoreMarker }
  | { readonly present: true; readonly corrupt: true };

function markerPath(userDataDir: string): string {
  return join(userDataDir, 'restore-in-progress.json');
}

/** Write `.tmp`, fsync, atomically rename into place. */
export function writeRestoreMarker(userDataDir: string, marker: RestoreMarker): void {
  const finalPath = markerPath(userDataDir);
  mkdirSync(dirname(finalPath), { recursive: true });
  const tmpPath = `${finalPath}.tmp`;
  const body = JSON.stringify(marker);
  const fd = openSync(tmpPath, 'w');
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, finalPath);
}

export function clearRestoreMarker(userDataDir: string): void {
  try {
    rmSync(markerPath(userDataDir), { force: true });
  } catch {
    /* best effort */
  }
  try {
    rmSync(`${markerPath(userDataDir)}.tmp`, { force: true });
  } catch {
    /* best effort */
  }
}

export function readRestoreMarker(userDataDir: string): RestoreMarkerReadResult {
  const finalPath = markerPath(userDataDir);
  if (!existsSync(finalPath)) {
    return { present: false };
  }
  try {
    const parsed = JSON.parse(readFileSync(finalPath, 'utf8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as RestoreMarker).version === RESTORE_MARKER_VERSION &&
      typeof (parsed as RestoreMarker).preRestoreFileName === 'string' &&
      /^gophones-pre-restore-v\d+-.+\.sqlite$/.test((parsed as RestoreMarker).preRestoreFileName) &&
      typeof (parsed as RestoreMarker).startedAt === 'string'
    ) {
      return { present: true, marker: parsed as RestoreMarker };
    }
    return { present: true, corrupt: true };
  } catch {
    return { present: true, corrupt: true };
  }
}
