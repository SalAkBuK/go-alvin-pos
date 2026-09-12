export const E3_MIGRATION_MODE_ENV: string;
export const E3_DELIBERATE_MIGRATION_FAILURE_MARKER: string;

export function buildE3Environment(
  baseEnv: NodeJS.ProcessEnv,
  profile: string,
  mode: 'success' | 'fail',
): NodeJS.ProcessEnv;
export function obstructPreMigrationBackupDirectory(profile: string): string;
export function findPreMigrationBackupFiles(profile: string): string[];

export interface BackupRecordRow {
  readonly id: string;
  readonly status: 'COMPLETED' | 'FAILED';
  readonly file_name: string | null;
  readonly storage_path: string | null;
  readonly source_app_version: string | null;
  readonly source_schema_version: number | null;
  readonly target_app_version: string | null;
  readonly size_bytes: number | null;
  readonly checksum_sha256: string | null;
  readonly started_at: string;
  readonly completed_at: string | null;
  readonly error_code: string | null;
}
export function readPreMigrationBackupRecords(dbFile: string): BackupRecordRow[];

export interface MigrationAuditEventRow {
  readonly event_type: string;
  readonly occurred_at: string;
  readonly outcome: 'SUCCESS' | 'FAILURE';
  readonly subject_type: string | null;
  readonly subject_id: string | null;
  readonly reason: string | null;
}
export function readMigrationAuditEvents(dbFile: string): MigrationAuditEventRow[];

export interface SchemaMigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly applied_at: string;
}
export function readSchemaMigrationsRows(
  dbFile: string,
  options?: { readonly readonly?: boolean },
): SchemaMigrationRow[];
export function hasSchema2Probe(dbFile: string, options?: { readonly readonly?: boolean }): boolean;
export function hasFailingSchema2Probe(
  dbFile: string,
  options?: { readonly readonly?: boolean },
): boolean;

export interface BackupVerificationResult {
  readonly ok: boolean;
  readonly problems: string[];
  readonly schemaRows: number[];
  readonly quick: string;
}
export function verifyPreMigrationBackupIndependently(
  backupFile: string,
  beforeEvidence: { readonly product: unknown; readonly sale: unknown },
): BackupVerificationResult;

export function compareBusinessEvidenceThroughMigration(before: unknown, after: unknown): string[];
