import type { NewerDataLoss, RestoreCandidate } from '../../../../shared/restore';

/**
 * Pure presentation helpers for Settings → Restore Database (Phase 2L-B).
 * Exported for direct testing (this suite has no jsdom).
 *
 * The wording is calm and precise: whole-database restore *replaces* the current
 * data, and the newer-data warning names the exact count + date range. "Restore
 * Anyway" is the only path past a loss warning; Cancel is the safe default.
 */

export function formatRestoreTimestamp(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

export function describeCandidate(candidate: RestoreCandidate): string {
  const kb = Math.max(1, Math.round(candidate.sizeBytes / 1024));
  const type = candidate.backupType === 'MANUAL' ? 'Manual' : 'Automatic';
  return `${type} backup — ${formatRestoreTimestamp(candidate.createdAt)} · app ${candidate.sourceAppVersion} · schema v${candidate.schemaVersion} · ${kb} KB`;
}

export function describeIncompatible(reason: 'SCHEMA_OLDER' | 'SCHEMA_NEWER'): string {
  return reason === 'SCHEMA_OLDER'
    ? 'This backup is from an older version of Go Phones POS and cannot be restored by this version.'
    : 'This backup was made by a newer version of Go Phones POS. Update this computer first.';
}

/** Variant A — the stronger warning body when newer completed sales would be lost. */
export function describeNewerDataLoss(loss: NewerDataLoss): string {
  const n = loss.transactionCount;
  const range =
    loss.earliestCompletedAt.slice(0, 10) === loss.latestCompletedAt.slice(0, 10)
      ? loss.earliestCompletedAt.slice(0, 10)
      : `${loss.earliestCompletedAt.slice(0, 10)} – ${loss.latestCompletedAt.slice(0, 10)}`;
  return `Restoring this backup replaces your entire current database. ${n} newer completed ${
    n === 1 ? 'transaction' : 'transactions'
  } (${range}) would be removed and cannot be recovered.`;
}

/**
 * Variant B — the generic whole-database confirmation shown when no newer
 * completed sale is detected. Policy 1 (2L-B final corrections): a restore
 * never silently proceeds merely because nothing sale-related would be lost —
 * a void, an inventory adjustment, a product/customer edit, or a setting
 * change made since the backup would still be reverted.
 */
export function describeGenericRestoreWarning(): string {
  return 'Restoring this backup will replace the current Go Phones POS database with the selected backup. Changes made after that backup may be reverted.';
}

export const RESTORE_IN_PROGRESS_MESSAGE =
  'Restoring database — sales are temporarily unavailable. This will finish in a moment.';

export function describeRestoreError(code: string, message: string): string {
  // The trusted layer already supplies a complete, sanitized sentence.
  return message || `Restore failed (${code}).`;
}

/**
 * Fold a freshly Browse-selected candidate into the existing candidate list
 * (Phase 2L-C.4). The browsed candidate is placed first so it is immediately
 * visible next to the app-managed ones; re-browsing the same file (same
 * opaque id) replaces its previous entry rather than duplicating it. `null`
 * (a cancelled dialog) never reaches this function — the caller returns
 * before touching state, so the list is left completely unchanged.
 */
export function mergeBrowsedCandidate(
  existing: readonly RestoreCandidate[] | null,
  browsed: RestoreCandidate,
): readonly RestoreCandidate[] {
  const rest = (existing ?? []).filter((c) => c.backupId !== browsed.backupId);
  return [browsed, ...rest];
}
