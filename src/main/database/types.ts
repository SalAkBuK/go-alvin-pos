import type Database from 'better-sqlite3';

/** Effective values of the four V1 durability pragmas (`DATA_MODEL.md §54`, `REQ-DB-007`). */
export interface EffectivePragmas {
  readonly foreign_keys: number;
  readonly journal_mode: string;
  readonly synchronous: number;
  readonly busy_timeout: number;
}

export interface MigrationContext {
  /** ISO-8601 UTC timestamp to stamp on rows this migration writes. */
  readonly now: string;
  /** Current application version (`app.getVersion()`). */
  readonly appVersion: string;
}

/**
 * One ordered, versioned schema migration.
 *
 * Migrations are TypeScript modules bundled into the main-process build — not
 * loose `.sql` asset files — so they are always present in dev, tests, the
 * production bundle, and the packaged `app.asar` with no runtime path
 * resolution (`§17` of the task, `ARCHITECTURE.md §45`).
 */
export interface Migration {
  /** Strictly increasing, starting at 1, contiguous across the set. */
  readonly version: number;
  /** Short stable identifier, e.g. `initial_schema`. */
  readonly name: string;
  /**
   * Stable content fingerprint. The runner hashes this and records the hash in
   * `schema_migrations.checksum`; a later change to an already-applied
   * migration is then detected and fails closed (`§9`).
   */
  readonly fingerprint: string;
  /** Applies the migration. Invoked inside an exclusive transaction by the runner. */
  run(db: Database.Database, ctx: MigrationContext): void;
}

/** A row of `schema_migrations`. */
export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly applied_at: string;
}

export interface PreMigrationBackupContext {
  readonly sourceSchemaVersion: number;
  readonly targetSchemaVersion: number;
}

export type PreMigrationBackupResult =
  | {
      readonly ok: true;
      readonly fileName: string;
      readonly storagePath: string;
      readonly sizeBytes: number;
      readonly checksumSha256: string;
    }
  | {
      readonly ok: false;
      readonly errorCode: string;
      readonly message: string;
    };

export interface MigrationRunResult {
  readonly freshInstall: boolean;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly applied: readonly { readonly version: number; readonly name: string }[];
}

export interface SchemaValidationResult {
  readonly ok: boolean;
  readonly schemaVersion: number | null;
  readonly failures: readonly string[];
}
