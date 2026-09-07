import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type Database from 'better-sqlite3';
import type { Logger } from '../app/logger';
import { openConfiguredConnection } from './connection';
import { createVerifiedPreMigrationBackup } from './backup';
import { runMigrations } from './migrationRunner';
import { PRODUCTION_MIGRATIONS, targetSchemaVersion } from './migrations';
import { validateSchema } from './schemaValidation';
import type { Migration, SchemaValidationResult } from './types';

/**
 * The single authoritative production SQLite lifecycle owner
 * (`ARCHITECTURE.md §7, §13, §38, §39`; task `§2, §12, §13`).
 *
 * Exactly one instance owns the connection for the whole process. It is never
 * exposed through the preload or IPC. Repositories/services (later slices) take
 * the connection from `.connection`; they must not open their own.
 */

export type DatabaseInitFailureCode =
  'DB_OPEN_FAILED' | 'DB_MIGRATION_FAILED' | 'DB_VALIDATION_FAILED' | 'DB_INIT_FAILED';

export class DatabaseInitializationError extends Error {
  readonly code: DatabaseInitFailureCode;
  readonly failures: readonly string[];

  constructor(
    code: DatabaseInitFailureCode,
    message: string,
    cause?: unknown,
    failures: readonly string[] = [],
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DatabaseInitializationError';
    this.code = code;
    this.failures = failures;
  }
}

export interface ProductionDatabaseOptions {
  /** Absolute path to the operational database file (`%LOCALAPPDATA%\GoPhonesPOS\gophones.sqlite`). */
  readonly filename: string;
  /** Directory that receives pre-migration backups. */
  readonly backupDir: string;
  readonly logger: Logger;
  readonly appVersion: string;
  /** Overridable for tests; defaults to the bundled production migration set. */
  readonly migrations?: readonly Migration[];
}

export class ProductionDatabase {
  private isClosed = false;

  private constructor(
    private readonly db: Database.Database,
    private readonly logger: Logger,
    readonly schemaVersion: number,
    readonly validation: SchemaValidationResult,
  ) {}

  /**
   * open → configure (REQ-DB-007) → migrate (backup-gated for upgrades) →
   * validate → ready. Throws {@link DatabaseInitializationError} on any failure;
   * the caller must then NOT treat persistence as healthy.
   */
  static async open(options: ProductionDatabaseOptions): Promise<ProductionDatabase> {
    const { logger } = options;
    const migrations = options.migrations ?? PRODUCTION_MIGRATIONS;

    let db: Database.Database;
    try {
      mkdirSync(dirname(options.filename), { recursive: true });
      db = openConfiguredConnection(options.filename);
      logger.info('database', 'database.opened', { file: describePath(options.filename) });
    } catch (error) {
      logger.fatal('database', 'database.open-failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new DatabaseInitializationError(
        'DB_OPEN_FAILED',
        'could not open or configure the production database',
        error,
      );
    }

    try {
      const runResult = await runMigrations(db, migrations, {
        logger,
        appVersion: options.appVersion,
        createPreMigrationBackup: (sourceDb, ctx) =>
          createVerifiedPreMigrationBackup({ sourceDb, backupDir: options.backupDir }, ctx),
      });

      const validation = validateSchema(db, { expectedVersion: targetSchemaVersion(migrations) });
      if (!validation.ok) {
        logger.fatal('database', 'database.validation-failed', { failures: validation.failures });
        throw new DatabaseInitializationError(
          'DB_VALIDATION_FAILED',
          'production database failed post-migration validation',
          undefined,
          validation.failures,
        );
      }

      logger.info('database', 'database.ready', {
        schemaVersion: validation.schemaVersion,
        freshInstall: runResult.freshInstall,
        appliedMigrations: runResult.applied.map((migration) => migration.version),
      });

      return new ProductionDatabase(db, logger, validation.schemaVersion ?? 0, validation);
    } catch (error) {
      safeClose(db);
      if (error instanceof DatabaseInitializationError) {
        throw error;
      }
      // A MigrationError (or anything else) during migration.
      logger.fatal('database', 'database.initialization-failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new DatabaseInitializationError(
        'DB_MIGRATION_FAILED',
        'production database migration failed',
        error,
      );
    }
  }

  /**
   * The authoritative connection, for main-process repositories/services only.
   * Never pass this across the IPC boundary.
   */
  get connection(): Database.Database {
    if (this.isClosed) {
      throw new Error('ProductionDatabase.connection accessed after close()');
    }
    return this.db;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /**
   * Close the connection exactly once, checkpointing the WAL back into the main
   * file first. Idempotent and safe to call from multiple shutdown hooks.
   */
  close(): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* best effort — a failed checkpoint must not block shutdown */
    }
    safeClose(this.db);
    this.logger.info('database', 'database.closed');
  }
}

function safeClose(db: Database.Database): void {
  try {
    if (db.open) {
      db.close();
    }
  } catch {
    /* nothing else we can safely do during teardown */
  }
}

/** Redact everything except the final file name for logs. */
function describePath(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] ?? filePath;
}
