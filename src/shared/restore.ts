/**
 * Shared Restore contract (Phase 2L-B — safe whole-database restore).
 *
 * Dependency-free types. The renderer only ever names an opaque `backupId` and
 * (for a confirmed loss) an opaque `confirmationToken`. It never supplies a
 * filesystem path, filename, or SQL. Off-device / external-file restore is
 * deferred with `OFF_DEVICE`.
 */

import type { MaintenanceState } from './maintenance';
import type { BackupLocationKind } from './backup';

/** Safe metadata for one app-managed restore candidate. */
export interface RestoreCandidate {
  /** Opaque physical-candidate id (a catalog id when one safely matches). */
  readonly backupId: string;
  readonly backupType: 'AUTOMATIC' | 'MANUAL';
  /** ISO-8601 UTC creation time (`backup_records.completed_at`). */
  readonly createdAt: string;
  /** Provenance / display only — compatibility is decided by `schemaVersion`. */
  readonly sourceAppVersion: string;
  readonly schemaVersion: number;
  readonly sizeBytes: number;
  /** Distinguishes same-machine recovery from a separately protected copy. */
  readonly locationKind: BackupLocationKind;
  /** Browse-selected candidates use a main-process-owned opaque token. */
  readonly sourceKind: 'MANAGED' | 'BROWSED';
  /** False for a valid managed artifact rediscovered after catalogue rewind. */
  readonly catalogued: boolean;
}

/** Completed sales newer than a candidate that a restore would discard. */
export interface NewerDataLoss {
  readonly transactionCount: number;
  /** Immutable `sales.completed_at` of the earliest / latest sale that would be lost. */
  readonly earliestCompletedAt: string;
  readonly latestCompletedAt: string;
}

/** Read-only restore-candidate preview (no lock taken, no pre-restore copy made). */
export interface RestoreCandidateInspection {
  readonly candidate: RestoreCandidate;
  readonly compatible: boolean;
  readonly incompatibleReason: 'SCHEMA_OLDER' | 'SCHEMA_NEWER' | null;
  /** Best-effort preview of newer-data loss; the authoritative check runs at restore time. */
  readonly newerData: NewerDataLoss | null;
}

export type RestoreOutcome =
  | {
      readonly outcome: 'COMPLETED';
      readonly restoredSchemaVersion: number;
      readonly restoredFromCreatedAt: string;
    }
  | {
      /**
       * ALWAYS returned on the first guarded restore attempt (Policy 1 — every
       * whole-database restore requires one explicit confirmation, never a
       * silent swap). `newerData` is present with the stronger warning content
       * when the current database holds completed sales the candidate does
       * not; `null` when no such sale is found, in which case the UI shows the
       * generic whole-database replacement warning instead.
       */
      readonly outcome: 'CONFIRMATION_REQUIRED';
      readonly newerData: NewerDataLoss | null;
      readonly confirmationToken: string;
    };

export interface RestoreRequest {
  readonly backupId: string;
  /** Required only to proceed past a `CONFIRMATION_REQUIRED` newer-data warning. */
  readonly confirmationToken?: string;
}

/** Live maintenance state for the renderer's application-level banner. */
export interface MaintenanceStatusDto {
  readonly state: MaintenanceState;
}
