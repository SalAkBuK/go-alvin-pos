import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
} from 'node:fs';

/**
 * Windows-safe operational-database file swap for restore (Phase 2L-B Item 14;
 * `DATA_MODEL.md §52A` step 5; `§54` WAL rules).
 *
 * All functions here assume **every SQLite handle to `databaseFile` is already
 * closed** — `ProductionDatabase.close()` (which `wal_checkpoint(TRUNCATE)`s
 * first) has run. Only then may the `-wal` / `-shm` sidecars be touched: a
 * sidecar left from the previous database generation must never be paired with
 * a newly activated main file, so both are removed before the new file is
 * opened.
 *
 * Ordering is crash-recoverable in combination with the restore marker + the
 * verified pre-restore recovery copy:
 *  - the candidate is staged to a sibling temp path and only then renamed in;
 *  - the previous main file is renamed aside (`.pre-restore-old`), not deleted,
 *    until the restored database has validated;
 *  - a failure at any step leaves either the old file in place or recoverable
 *    from `.pre-restore-old` / the pre-restore copy.
 */

function walShmPaths(databaseFile: string): readonly string[] {
  return [`${databaseFile}-wal`, `${databaseFile}-shm`, `${databaseFile}-journal`];
}

/** Remove any `-wal` / `-shm` / `-journal` companions of `databaseFile`. Handles must be closed. */
export function removeSqliteSidecars(databaseFile: string): void {
  for (const sidecar of walShmPaths(databaseFile)) {
    try {
      rmSync(sidecar, { force: true });
    } catch {
      /* best effort — a stale sidecar that cannot be removed is surfaced by the
         subsequent open/validation, which then triggers rollback */
    }
  }
}

function fsyncFile(path: string): void {
  try {
    const fd = openSync(path, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* best effort durability flush */
  }
}

export interface StagedActivation {
  /** The renamed-aside previous main file, or `null` if there was none. */
  readonly previousMainAside: string | null;
}

/**
 * Copy `candidateFile` to `<databaseFile>.restore-staged`, remove old sidecars,
 * move the current main file aside to `<databaseFile>.pre-restore-old`, then
 * rename the staged file into place. `candidateFile` is never modified.
 */
export function stageAndActivate(candidateFile: string, databaseFile: string): StagedActivation {
  const stagedPath = `${databaseFile}.restore-staged`;
  const asidePath = `${databaseFile}.pre-restore-old`;

  try {
    rmSync(stagedPath, { force: true });
  } catch {
    /* best effort */
  }
  copyFileSync(candidateFile, stagedPath);
  fsyncFile(stagedPath);

  removeSqliteSidecars(databaseFile);

  let previousMainAside: string | null = null;
  if (existsSync(databaseFile)) {
    try {
      rmSync(asidePath, { force: true });
    } catch {
      /* best effort */
    }
    renameSync(databaseFile, asidePath);
    previousMainAside = asidePath;
  }

  try {
    renameSync(stagedPath, databaseFile);
  } catch (error) {
    // Put the previous main file back so the caller can recover from it.
    if (previousMainAside && !existsSync(databaseFile)) {
      try {
        renameSync(previousMainAside, databaseFile);
      } catch {
        /* the pre-restore recovery copy is the remaining safety net */
      }
    }
    throw error;
  }

  return { previousMainAside };
}

/** After a successful, validated restore: drop the renamed-aside previous main file. */
export function discardPreviousMain(databaseFile: string): void {
  try {
    rmSync(`${databaseFile}.pre-restore-old`, { force: true });
  } catch {
    /* best effort */
  }
  try {
    rmSync(`${databaseFile}.restore-staged`, { force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Restore `databaseFile` from a verified recovery copy (`recoveryCopyFile`):
 * remove the failed main file + its sidecars, then copy the recovery copy into
 * place. Used both by the in-process rollback and by startup interrupted-restore
 * recovery.
 */
export function restoreFromRecoveryCopy(recoveryCopyFile: string, databaseFile: string): void {
  try {
    rmSync(databaseFile, { force: true });
  } catch {
    /* best effort */
  }
  removeSqliteSidecars(databaseFile);
  copyFileSync(recoveryCopyFile, databaseFile);
  fsyncFile(databaseFile);
}
