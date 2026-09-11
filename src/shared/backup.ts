/**
 * Shared Backup & Restore contract (Phase 2L — backup-creation half).
 *
 * Dependency-free types shared by the main process, the sandboxed preload, and
 * the renderer. This slice covers manual + automatic backup creation,
 * verification, retention, local health, and the Phase 2L-C OFF_DEVICE DTOs.
 * Whole-database restore has its own contract in `shared/restore.ts`
 * (`REQ-BACKUP-001`,
 * `REQ-BACKUP-002`, `REQ-BACKUP-005`, `REQ-BACKUP-006`, `REQ-BACKUP-007`,
 * `REQ-BACKUP-009`; `DATA_MODEL.md §36B`, `§52`, `§54`; `POS_WORKFLOWS.md §65`,
 * `§66`; `ARCHITECTURE.md §37`).
 */

/** Canonical `backup_records.backup_type` values (`DATA_MODEL.md §36B`). */
export type BackupType = 'AUTOMATIC' | 'MANUAL' | 'PRE_MIGRATION';

/** Canonical `backup_records.location_kind` values. V1 default is `LOCAL_DISK`. */
export type BackupLocationKind = 'LOCAL_DISK' | 'OFF_DEVICE';

/** Positively verified V1 OFF_DEVICE destination classes. */
export type OffDeviceDestinationKind = 'NETWORK' | 'USB';

/** Safe renderer-facing configuration state. No filesystem path is exposed. */
export type OffDeviceBackupConfiguration =
  | { readonly configured: false }
  | {
      readonly configured: true;
      readonly destinationKind: OffDeviceDestinationKind | null;
      readonly displayName: string;
      readonly updatedAt: string;
      readonly verified: boolean;
    };

export type OffDeviceAttentionReason =
  'NEVER_SUCCEEDED' | 'UNAVAILABLE' | 'STALE' | 'LAST_COPY_FAILED' | 'VERIFICATION_FAILED';

/** Separate device/disk-loss protection health; local backup health is unchanged. */
export type OffDeviceBackupHealth =
  | { readonly state: 'NOT_CONFIGURED' }
  | {
      readonly state: 'HEALTHY';
      readonly lastSuccessfulAt: string;
      readonly destinationKind: OffDeviceDestinationKind;
    }
  | {
      readonly state: 'ATTENTION';
      readonly reason: OffDeviceAttentionReason;
      readonly lastSuccessfulAt: string | null;
      readonly destinationKind: OffDeviceDestinationKind | null;
    };

/** Secondary outcome returned alongside an independently successful local backup. */
export type OffDeviceCopyResult =
  | { readonly outcome: 'NOT_CONFIGURED' }
  | { readonly outcome: 'COMPLETED'; readonly completedAt: string }
  | { readonly outcome: 'FAILED'; readonly errorCode: string };

/** Outcome of the most recent automatic backup attempt. */
export type LatestAutomaticBackup =
  | { readonly outcome: 'COMPLETED'; readonly at: string }
  | { readonly outcome: 'FAILED'; readonly at: string; readonly errorCode: string };

/**
 * Backup protection state for health display and `Support & Diagnostics`
 * (Phase 2M consumes this DTO without re-deriving it).
 *
 * `overdue` is a protection/health warning — it is **not** proof of database
 * failure and must never be presented as "database corrupted"
 * (`REQ-BACKUP-007`, `TEST-BACKUP-011`).
 */
export interface BackupHealth {
  /** Result + time of the most recent automatic backup attempt, or `null` when none has run. */
  readonly lastAutomatic: LatestAutomaticBackup | null;
  /** Time of the most recent *successful* automatic backup, or `null`. */
  readonly lastSuccessfulAutomaticAt: string | null;
  /** `true` when at least one full daily automatic backup window has been missed. */
  readonly overdue: boolean;
  /** The most recent failed backup of any type, or `null`. */
  readonly lastFailure: {
    readonly backupType: BackupType;
    readonly at: string;
    readonly errorCode: string;
  } | null;
  /**
   * Protection the currently configured backups provide. `LOCAL_DISK_ONLY`
   * protects against accidental deletion, application-level corruption, and a
   * bad migration — **not** loss of the machine/disk. An off-device destination
   * (a later slice) would be required for disk-loss protection
   * (`REQ-BACKUP-010`, `PRODUCT_SCOPE.md §23`).
   */
  readonly protection: 'LOCAL_DISK_ONLY' | 'OFF_DEVICE';
  /** Independently evaluated external/network protection state. */
  readonly offDevice?: OffDeviceBackupHealth;
  /** Automatic backups run on the canonical V1 default schedule; always `true` in V1. */
  readonly automaticEnabled: true;
  /** Canonical V1 automatic backup cadence, for display ("Daily at 3:00 AM"). */
  readonly schedule: { readonly cadence: 'DAILY'; readonly atLocalTime: string };
}

/** Result of an owner-initiated `Back Up Now`. */
export interface ManualBackupResult {
  readonly status: 'COMPLETED';
  /** Backup file name only — never an absolute path (`task` filesystem-safety rule). */
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly completedAt: string;
  readonly locationKind: BackupLocationKind;
  /** Best-effort protection copy result; never changes the local COMPLETED status. */
  readonly offDevice?: OffDeviceCopyResult;
}
