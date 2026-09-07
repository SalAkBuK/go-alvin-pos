import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Logger } from '../app/logger';
import type {
  AppliedMigration,
  Migration,
  MigrationRunResult,
  PreMigrationBackupContext,
  PreMigrationBackupResult,
} from './types';

/**
 * Versioned migration runner (`ARCHITECTURE.md §45`, `DATA_MODEL.md §27`,
 * `REQ-DB-005`, task `§9`).
 *
 * Explicit and deterministic, not a general framework:
 *  - determines fresh vs. initialized, and which migrations are applied;
 *  - applies pending migrations strictly in ascending version order, each in
 *    its own exclusive transaction;
 *  - records every applied migration in `schema_migrations` (with a content
 *    checksum) and never re-runs one;
 *  - fails **closed** on any inconsistency (gap, unknown applied version,
 *    checksum drift, non-contiguous set) and on a failed pre-migration backup;
 *  - a failed migration rolls back with no `schema_migrations` advance;
 *  - emits sanitized structured diagnostics for every lifecycle step, and
 *    `MIGRATION_*` / `BACKUP_*` audit events once `audit_events` exists.
 */

export const MIGRATION_ERROR_CODES = {
  historyUnreadable: 'MIGRATION_HISTORY_UNREADABLE',
  historyGap: 'MIGRATION_HISTORY_GAP',
  historyUnknownVersion: 'MIGRATION_HISTORY_UNKNOWN_VERSION',
  historyChecksumDrift: 'MIGRATION_CHECKSUM_DRIFT',
  setNotContiguous: 'MIGRATION_SET_NOT_CONTIGUOUS',
  pendingNotContiguous: 'MIGRATION_PENDING_NOT_CONTIGUOUS',
  preMigrationBackupFailed: 'PRE_MIGRATION_BACKUP_FAILED',
  applyFailed: 'MIGRATION_APPLY_FAILED',
} as const;

export type MigrationErrorCode = (typeof MIGRATION_ERROR_CODES)[keyof typeof MIGRATION_ERROR_CODES];

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  readonly detail: Record<string, unknown> | undefined;

  constructor(code: MigrationErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
    this.detail = detail;
  }
}

export function migrationChecksum(migration: Migration): string {
  return createHash('sha256').update(migration.fingerprint).digest('hex');
}

export interface MigrationRunnerDeps {
  readonly logger: Logger;
  readonly appVersion: string;
  /**
   * Create + verify a pre-migration backup for an **existing** database being
   * upgraded. Injectable so tests can force success/failure without real I/O.
   */
  readonly createPreMigrationBackup: (
    db: Database.Database,
    ctx: PreMigrationBackupContext,
  ) => Promise<PreMigrationBackupResult>;
  /** Overridable clock for deterministic tests. */
  readonly now?: () => string;
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

function isDbWritable(db: Database.Database): boolean {
  try {
    return !db.readonly && db.prepare('SELECT 1').get() !== undefined;
  } catch {
    return false;
  }
}

/** Whether durable audit events can be written yet (post-`001`). */
function auditReady(db: Database.Database): boolean {
  return (
    tableExists(db, 'audit_events') &&
    tableExists(db, 'counters') &&
    db.prepare("SELECT 1 FROM counters WHERE key = 'audit_sequence'").get() !== undefined
  );
}

interface AuditEventInput {
  readonly eventType: string;
  readonly occurredAt: string;
  readonly outcome: 'SUCCESS' | 'FAILURE';
  readonly appVersion: string;
  readonly subjectType?: string;
  readonly subjectId?: string;
  readonly reason?: string;
  readonly detailsJson?: string;
}

/**
 * Best-effort durable audit event. Allocates `sequence` from the
 * `counters.audit_sequence` row (same mechanism as `receipt_number`, §36A) in
 * its own small transaction. Never throws — a failed audit write falls back to
 * the diagnostic log per §36A.
 */
function writeAuditEvent(db: Database.Database, logger: Logger, event: AuditEventInput): void {
  if (!auditReady(db)) {
    logger.info('migration', 'database.audit.deferred', {
      eventType: event.eventType,
      note: 'audit_events not available yet; diagnostic log is the record',
    });
    return;
  }
  try {
    db.transaction(() => {
      const counter = db
        .prepare("SELECT value FROM counters WHERE key = 'audit_sequence'")
        .get() as { value: number };
      const sequence = counter.value + 1;
      db.prepare("UPDATE counters SET value = ?, updated_at = ? WHERE key = 'audit_sequence'").run(
        sequence,
        event.occurredAt,
      );
      db.prepare(
        `INSERT INTO audit_events
           (id, sequence, event_type, occurred_at, actor_type, subject_type, subject_id,
            outcome, reason, details_json, app_version)
         VALUES (?, ?, ?, ?, 'SYSTEM', ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        sequence,
        event.eventType,
        event.occurredAt,
        event.subjectType ?? null,
        event.subjectId ?? null,
        event.outcome,
        event.reason ?? null,
        event.detailsJson ?? null,
        event.appVersion,
      );
    }).exclusive();
  } catch (error) {
    logger.error('migration', 'database.audit.write-failed', {
      eventType: event.eventType,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function readAppliedMigrations(db: Database.Database): AppliedMigration[] {
  try {
    return db
      .prepare(
        'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC',
      )
      .all() as AppliedMigration[];
  } catch (error) {
    throw new MigrationError(
      MIGRATION_ERROR_CODES.historyUnreadable,
      `schema_migrations is present but unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Assert the migration set is contiguous and starts at 1. */
function assertMigrationSetShape(migrations: readonly Migration[]): void {
  [...migrations]
    .sort((a, b) => a.version - b.version)
    .forEach((migration, index) => {
      if (migration.version !== index + 1) {
        throw new MigrationError(
          MIGRATION_ERROR_CODES.setNotContiguous,
          `migration set is not contiguous from 1: expected version ${index + 1}, found ${migration.version} (${migration.name})`,
        );
      }
    });
}

/** Validate recorded history against the migration definitions. Fails closed. */
function reconcileHistory(applied: AppliedMigration[], byVersion: Map<number, Migration>): void {
  applied.forEach((record, index) => {
    if (record.version !== index + 1) {
      throw new MigrationError(
        MIGRATION_ERROR_CODES.historyGap,
        `applied migration history has a gap at version ${record.version}`,
        { appliedVersions: applied.map((entry) => entry.version) },
      );
    }
    const definition = byVersion.get(record.version);
    if (!definition) {
      throw new MigrationError(
        MIGRATION_ERROR_CODES.historyUnknownVersion,
        `database reports migration ${record.version} (${record.name}) applied, but this build defines no such migration`,
      );
    }
    if (migrationChecksum(definition) !== record.checksum) {
      throw new MigrationError(
        MIGRATION_ERROR_CODES.historyChecksumDrift,
        `migration ${record.version} (${record.name}) content differs from the version recorded as applied`,
      );
    }
  });
}

function recordBackupRecord(
  db: Database.Database,
  input: {
    readonly status: 'COMPLETED' | 'FAILED';
    readonly startedAt: string;
    readonly completedAt: string | null;
    readonly errorCode: string | null;
    readonly sourceSchemaVersion: number;
    readonly appVersion: string;
    readonly file: {
      readonly fileName: string;
      readonly storagePath: string;
      readonly sizeBytes: number;
      readonly checksumSha256: string;
    } | null;
  },
): void {
  db.prepare(
    `INSERT INTO backup_records
       (id, backup_type, location_kind, status, file_name, storage_path,
        source_app_version, source_schema_version, target_app_version,
        size_bytes, checksum_sha256, started_at, completed_at, error_code)
     VALUES (?, 'PRE_MIGRATION', 'LOCAL_DISK', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.status,
    input.file?.fileName ?? null,
    input.file?.storagePath ?? null,
    input.status === 'COMPLETED' ? input.appVersion : null,
    input.status === 'COMPLETED' ? input.sourceSchemaVersion : null,
    // A migration replaces schema only; the app binary is unchanged in this phase.
    input.status === 'COMPLETED' ? input.appVersion : null,
    input.file?.sizeBytes ?? null,
    input.file?.checksumSha256 ?? null,
    input.startedAt,
    input.completedAt,
    input.errorCode,
  );
}

export async function runMigrations(
  db: Database.Database,
  migrations: readonly Migration[],
  deps: MigrationRunnerDeps,
): Promise<MigrationRunResult> {
  const { logger } = deps;
  const now = deps.now ?? ((): string => new Date().toISOString());

  assertMigrationSetShape(migrations);
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));

  const initialized = tableExists(db, 'schema_migrations');
  const applied = initialized ? readAppliedMigrations(db) : [];
  if (initialized) {
    reconcileHistory(applied, byVersion);
  }

  const currentVersion = applied.reduce((max, record) => Math.max(max, record.version), 0);
  const freshInstall = !initialized;

  const pending = migrations
    .filter((migration) => migration.version > currentVersion)
    .sort((a, b) => a.version - b.version);

  pending.forEach((migration, index) => {
    if (migration.version !== currentVersion + index + 1) {
      throw new MigrationError(
        MIGRATION_ERROR_CODES.pendingNotContiguous,
        `pending migrations are not contiguous from ${currentVersion + 1}`,
      );
    }
  });

  if (pending.length === 0) {
    logger.info('migration', 'database.migrations.up-to-date', { schemaVersion: currentVersion });
    return { freshInstall, fromVersion: currentVersion, toVersion: currentVersion, applied: [] };
  }

  const lastPending = pending[pending.length - 1]!;
  const targetVersion = lastPending.version;
  logger.info('migration', 'database.migrations.pending', {
    freshInstall,
    fromVersion: currentVersion,
    toVersion: targetVersion,
    versions: pending.map((migration) => migration.version),
  });

  // ── Pre-migration backup gate (existing database only) ──────────────────────
  // A brand-new empty database has no prior business state to recover to, so
  // bootstrap of `001` is initial creation, not an upgrade (see the report).
  // Every upgrade of an initialized database is gated on a verified
  // SQLite-consistent backup (§54, §36B, REQ-BACKUP-008).
  if (!freshInstall) {
    await runPreMigrationBackupGate(db, deps, now, currentVersion, targetVersion);
  }

  // ── Apply pending migrations, one exclusive transaction each ────────────────
  //
  // Durable MIGRATION_* / BACKUP_* audit events are written only when an
  // *existing* database is upgraded. A first-run bootstrap of `001` leaves
  // `audit_events` empty and both allocation counters at 0 — a fresh install
  // begins with no rows anywhere (task §8). Bootstrap lifecycle is captured in
  // the structured diagnostic log, which §36A explicitly allows as the record
  // when the audit table is not (yet) available.
  const writeMigrationAudit = !freshInstall;

  for (const migration of pending) {
    if (writeMigrationAudit && auditReady(db)) {
      writeAuditEvent(db, logger, {
        eventType: 'MIGRATION_STARTED',
        occurredAt: now(),
        outcome: 'SUCCESS',
        appVersion: deps.appVersion,
        subjectType: 'MIGRATION',
        subjectId: String(migration.version),
      });
    }
    logger.info('migration', 'database.migration.started', {
      version: migration.version,
      name: migration.name,
    });

    try {
      db.transaction(() => {
        migration.run(db, { now: now(), appVersion: deps.appVersion });
        db.prepare(
          'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        ).run(migration.version, migration.name, migrationChecksum(migration), now());
      }).exclusive();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.fatal('migration', 'database.migration.failed', {
        version: migration.version,
        name: migration.name,
        error: message,
      });
      if (writeMigrationAudit && isDbWritable(db)) {
        writeAuditEvent(db, logger, {
          eventType: 'MIGRATION_FAILED',
          occurredAt: now(),
          outcome: 'FAILURE',
          appVersion: deps.appVersion,
          subjectType: 'MIGRATION',
          subjectId: String(migration.version),
          reason: message.slice(0, 500),
        });
      }
      throw new MigrationError(
        MIGRATION_ERROR_CODES.applyFailed,
        `migration ${migration.version} (${migration.name}) failed and was rolled back: ${message}`,
        { version: migration.version },
      );
    }

    if (writeMigrationAudit) {
      writeAuditEvent(db, logger, {
        eventType: 'MIGRATION_COMPLETED',
        occurredAt: now(),
        outcome: 'SUCCESS',
        appVersion: deps.appVersion,
        subjectType: 'MIGRATION',
        subjectId: String(migration.version),
      });
    }
    logger.info('migration', 'database.migration.completed', {
      version: migration.version,
      name: migration.name,
    });
  }

  logger.info('migration', 'database.migrations.applied', {
    fromVersion: currentVersion,
    toVersion: targetVersion,
    count: pending.length,
  });

  return {
    freshInstall,
    fromVersion: currentVersion,
    toVersion: targetVersion,
    applied: pending.map((migration) => ({ version: migration.version, name: migration.name })),
  };
}

async function runPreMigrationBackupGate(
  db: Database.Database,
  deps: MigrationRunnerDeps,
  now: () => string,
  currentVersion: number,
  targetVersion: number,
): Promise<void> {
  const { logger } = deps;
  const backupCtx: PreMigrationBackupContext = {
    sourceSchemaVersion: currentVersion,
    targetSchemaVersion: targetVersion,
  };
  const startedAt = now();

  let result: PreMigrationBackupResult;
  try {
    result = await deps.createPreMigrationBackup(db, backupCtx);
  } catch (error) {
    result = {
      ok: false,
      errorCode: 'BACKUP_THREW',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (!result.ok) {
    try {
      recordBackupRecord(db, {
        status: 'FAILED',
        startedAt,
        completedAt: null,
        errorCode: result.errorCode,
        sourceSchemaVersion: currentVersion,
        appVersion: deps.appVersion,
        file: null,
      });
    } catch (recordError) {
      logger.error('migration', 'database.backup-record.write-failed', {
        error: recordError instanceof Error ? recordError.message : String(recordError),
      });
    }
    writeAuditEvent(db, logger, {
      eventType: 'BACKUP_FAILED',
      occurredAt: now(),
      outcome: 'FAILURE',
      appVersion: deps.appVersion,
      subjectType: 'MIGRATION',
      subjectId: String(targetVersion),
      reason: result.errorCode,
    });
    logger.fatal('migration', 'database.pre-migration-backup.failed', {
      fromVersion: currentVersion,
      toVersion: targetVersion,
      errorCode: result.errorCode,
    });
    throw new MigrationError(
      MIGRATION_ERROR_CODES.preMigrationBackupFailed,
      `pre-migration backup could not be created or verified (${result.errorCode}); migration will not begin`,
      { errorCode: result.errorCode },
    );
  }

  // §36B: the backup metadata must be durably recorded before the migration begins.
  try {
    recordBackupRecord(db, {
      status: 'COMPLETED',
      startedAt,
      completedAt: now(),
      errorCode: null,
      sourceSchemaVersion: currentVersion,
      appVersion: deps.appVersion,
      file: result,
    });
  } catch (recordError) {
    const message = recordError instanceof Error ? recordError.message : String(recordError);
    logger.fatal('migration', 'database.backup-record.write-failed', { error: message });
    throw new MigrationError(
      MIGRATION_ERROR_CODES.preMigrationBackupFailed,
      `pre-migration backup was verified but its metadata could not be persisted: ${message}`,
    );
  }

  writeAuditEvent(db, logger, {
    eventType: 'BACKUP_COMPLETED',
    occurredAt: now(),
    outcome: 'SUCCESS',
    appVersion: deps.appVersion,
    subjectType: 'MIGRATION',
    subjectId: String(targetVersion),
    detailsJson: JSON.stringify({
      backupType: 'PRE_MIGRATION',
      sourceSchemaVersion: currentVersion,
      targetSchemaVersion: targetVersion,
    }),
  });
  logger.info('migration', 'database.pre-migration-backup.verified', {
    fromVersion: currentVersion,
    toVersion: targetVersion,
    fileName: result.fileName,
    sizeBytes: result.sizeBytes,
  });
}
