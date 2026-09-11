import type { BackupHealth } from '../../../../shared/backup';

/**
 * Pure presentation helpers for Settings → Backup & Restore (Phase 2L —
 * backup-creation half). Exported for direct testing (this suite has no jsdom).
 *
 * The wording is deliberately calm and precise: an overdue backup is a
 * protection warning, never a claim that the database has failed
 * (`REQ-BACKUP-007`, `TEST-BACKUP-011`). A same-disk backup is never described
 * as protecting against loss of the computer or disk (`REQ-BACKUP-010`,
 * `PRODUCT_SCOPE.md §23`, `TEST-BACKUP-020`).
 */

/** Fixed protection statement — Phase 2L ships `LOCAL_DISK` only. */
export const LOCAL_PROTECTION_TEXT =
  'Local backups protect against application or database problems on this computer. They do NOT protect against loss, theft, or failure of this computer or its disk.';

export function formatBackupTimestamp(iso: string): string {
  // ISO-8601 UTC → "2026-09-10 14:03 UTC". Deterministic, no locale dependency.
  const trimmed = iso.slice(0, 16).replace('T', ' ');
  return `${trimmed} UTC`;
}

/** The "Last automatic backup:" line. */
export function describeLastAutomatic(health: BackupHealth | null): string {
  if (health === null) {
    return 'Loading…';
  }
  const last = health.lastAutomatic;
  if (last === null) {
    return 'Never';
  }
  if (last.outcome === 'FAILED') {
    return `Failed at ${formatBackupTimestamp(last.at)}`;
  }
  return formatBackupTimestamp(last.at);
}

/**
 * The protection/health warning line, or `null` when there is nothing to warn
 * about. Never phrased as a database failure.
 */
export function describeBackupWarning(health: BackupHealth | null): string | null {
  if (health === null) {
    return null;
  }
  if (health.overdue) {
    return health.lastSuccessfulAutomaticAt === null
      ? 'No automatic backup has completed yet. Your data on this computer is not yet protected by a local backup.'
      : `Automatic backup is overdue — the last successful backup was ${formatBackupTimestamp(
          health.lastSuccessfulAutomaticAt,
        )}. This is a backup-protection warning, not a database problem.`;
  }
  if (health.lastAutomatic?.outcome === 'FAILED') {
    return `The most recent automatic backup did not complete (${health.lastAutomatic.errorCode}). Sales are unaffected. The next scheduled backup will try again.`;
  }
  return null;
}

/** The "Automatic backup:" status line. */
export function describeAutomaticSchedule(health: BackupHealth | null): string {
  if (health === null) {
    return 'Loading…';
  }
  return `On — daily at ${health.schedule.atLocalTime} (store time)`;
}
