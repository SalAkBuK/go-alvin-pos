import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { BackupType } from '../../shared/backup';

/**
 * Backup file naming + directory layout (`UPDATE_RELEASE_STRATEGY.md §21`;
 * `DATA_MODEL.md §36B`).
 *
 * Files stay identifiable as Go Phones POS backup artifacts so retention only
 * ever manages files the application can prove are its own — an arbitrary
 * `*.sqlite` in the folder is never touched.
 *
 * Layout, all under the pinned per-machine app-data `backups/` directory
 * (`ARCHITECTURE.md §13`, `src/main/app/paths.ts`), never inside the repo,
 * packaged app, or a location wiped on upgrade:
 *
 * ```
 * backups/
 *   automatic/     gophones-automatic-v<schema>-<stamp>-<rand>.sqlite
 *   manual/        gophones-manual-v<schema>-<stamp>-<rand>.sqlite
 *   pre-migration/ gophones-pre-migration-v<schema>-<stamp>-<rand>.sqlite
 * ```
 */

const PREFIX = 'gophones';
const EXTENSION = '.sqlite';

const TYPE_SLUG: Record<BackupType, string> = {
  AUTOMATIC: 'automatic',
  MANUAL: 'manual',
  PRE_MIGRATION: 'pre-migration',
};

const SLUG_TYPE: Record<string, BackupType> = {
  automatic: 'AUTOMATIC',
  manual: 'MANUAL',
  'pre-migration': 'PRE_MIGRATION',
};

/** Subdirectory (relative to the backups root) that holds a given backup type. */
export function backupSubdir(type: BackupType): string {
  return TYPE_SLUG[type];
}

export function backupDirFor(backupsRoot: string, type: BackupType): string {
  return join(backupsRoot, TYPE_SLUG[type]);
}

/**
 * The pre-restore recovery copy lives here (`DATA_MODEL.md §52A` step 1;
 * Phase 2L-B Item 12). It is deliberately NOT a `backup_records` row — canon has
 * no `PRE_RESTORE` `backup_type` enum value and no schema migration is added to
 * invent one. These files are excluded from normal retention cleanup.
 */
export const PRE_RESTORE_SUBDIR = 'pre-restore';

export function preRestoreDir(backupsRoot: string): string {
  return join(backupsRoot, PRE_RESTORE_SUBDIR);
}

/** A collision-safe pre-restore recovery copy file name. */
export function preRestoreFileName(sourceSchemaVersion: number, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const rand = randomBytes(4).toString('hex');
  return `${PREFIX}-pre-restore-v${sourceSchemaVersion}-${stamp}-${rand}${EXTENSION}`;
}

/** `true` when `fileName` is a managed pre-restore recovery copy. */
export function isPreRestoreFileName(fileName: string): boolean {
  return /^gophones-pre-restore-v\d+-.+\.sqlite$/.test(fileName);
}

/**
 * A collision-safe file name. Two manual backups issued in the same millisecond
 * still get distinct names because of the random suffix (adversarial test 21).
 */
export function backupFileName(
  type: BackupType,
  sourceSchemaVersion: number,
  now: Date = new Date(),
): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const rand = randomBytes(4).toString('hex');
  return `${PREFIX}-${TYPE_SLUG[type]}-v${sourceSchemaVersion}-${stamp}-${rand}${EXTENSION}`;
}

export interface ParsedBackupFile {
  readonly type: BackupType;
  readonly sourceSchemaVersion: number;
}

/**
 * Parse a file name the application generated, or `null` when the name does not
 * match the managed pattern (so it is not one of our artifacts and must never be
 * deleted by retention).
 */
export function parseManagedBackupFile(fileName: string): ParsedBackupFile | null {
  const match = /^gophones-(automatic|manual|pre-migration)-v(\d+)-.+\.sqlite$/.exec(fileName);
  if (!match) {
    return null;
  }
  const type = SLUG_TYPE[match[1]!];
  if (!type) {
    return null;
  }
  return { type, sourceSchemaVersion: Number(match[2]) };
}
