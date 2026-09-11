import type Database from 'better-sqlite3';
import type { DatabaseDiagnostic } from '../../shared/diagnostics';
import { readEffectivePragmas } from '../database/connection';
import { migrationChecksum } from '../database/migrationRunner';
import { PRODUCTION_MIGRATIONS, targetSchemaVersion } from '../database/migrations';
import { REQUIRED_V1_TABLES } from '../database/schemaValidation';
import type { AppliedMigration, Migration } from '../database/types';

export interface DatabaseHealthOptions {
  readonly deep: boolean;
  readonly migrations?: readonly Migration[];
}

function hasExactMigrationHistory(
  db: Database.Database,
  migrations: readonly Migration[],
): { readonly valid: boolean; readonly schemaVersion: number | null } {
  const rows = db
    .prepare(
      'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC',
    )
    .all() as AppliedMigration[];
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const valid =
    rows.length === ordered.length &&
    rows.every((row, index) => {
      const expected = ordered[index];
      return (
        expected !== undefined &&
        row.version === index + 1 &&
        row.version === expected.version &&
        row.name === expected.name &&
        row.checksum === migrationChecksum(expected)
      );
    });
  return { valid, schemaVersion: rows.at(-1)?.version ?? null };
}

export function unavailableDatabaseDiagnostic(
  failureCode: string | null,
  migrations: readonly Migration[] = PRODUCTION_MIGRATIONS,
): DatabaseDiagnostic {
  return {
    status: 'CRITICAL',
    open: false,
    schemaVersion: null,
    expectedSchemaVersion: targetSchemaVersion(migrations),
    migrationStateValid: false,
    foreignKeysEnabled: false,
    criticalTablesAvailable: false,
    quickCheck: 'NOT_RUN',
    issueCodes: [
      failureCode && /^[A-Z][A-Z0-9_]{0,99}$/.test(failureCode)
        ? failureCode
        : 'DATABASE_UNAVAILABLE',
    ],
  };
}

/** Read-only operational checks. Only an explicit manual run performs quick_check. */
export function inspectDatabaseHealth(
  db: Database.Database,
  options: DatabaseHealthOptions,
): DatabaseDiagnostic {
  const migrations = options.migrations ?? PRODUCTION_MIGRATIONS;
  const issueCodes: string[] = [];
  const expectedSchemaVersion = targetSchemaVersion(migrations);

  if (!db.open) {
    return unavailableDatabaseDiagnostic('DATABASE_UNAVAILABLE', migrations);
  }

  let schemaVersion: number | null = null;
  let migrationStateValid = false;
  try {
    const history = hasExactMigrationHistory(db, migrations);
    schemaVersion = history.schemaVersion;
    migrationStateValid = history.valid && schemaVersion === expectedSchemaVersion;
    if (!migrationStateValid) issueCodes.push('MIGRATION_HISTORY_INVALID');
  } catch {
    issueCodes.push('MIGRATION_HISTORY_INVALID');
  }

  let foreignKeysEnabled = false;
  try {
    foreignKeysEnabled = readEffectivePragmas(db).foreign_keys === 1;
    if (!foreignKeysEnabled) issueCodes.push('FOREIGN_KEYS_DISABLED');
  } catch {
    issueCodes.push('DATABASE_PRAGMA_CHECK_FAILED');
  }

  let criticalTablesAvailable = false;
  try {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>;
    const present = new Set(rows.map((row) => row.name));
    criticalTablesAvailable = REQUIRED_V1_TABLES.every((table) => present.has(table));
    if (criticalTablesAvailable) {
      for (const table of REQUIRED_V1_TABLES) {
        db.prepare(`SELECT 1 FROM "${table}" LIMIT 1`).get();
      }
    } else {
      issueCodes.push('CRITICAL_TABLES_MISSING');
    }
  } catch {
    criticalTablesAvailable = false;
    issueCodes.push('CRITICAL_TABLE_UNREADABLE');
  }

  let quickCheck: DatabaseDiagnostic['quickCheck'] = 'NOT_RUN';
  if (options.deep) {
    try {
      const rows = db.pragma('quick_check') as Array<Record<string, unknown>>;
      quickCheck = rows.length === 1 && Object.values(rows[0] ?? {})[0] === 'ok' ? 'OK' : 'FAILED';
      if (quickCheck === 'FAILED') issueCodes.push('DATABASE_QUICK_CHECK_FAILED');
    } catch {
      quickCheck = 'FAILED';
      issueCodes.push('DATABASE_QUICK_CHECK_FAILED');
    }
  }

  return {
    status: issueCodes.length === 0 ? 'HEALTHY' : 'CRITICAL',
    open: true,
    schemaVersion,
    expectedSchemaVersion,
    migrationStateValid,
    foreignKeysEnabled,
    criticalTablesAvailable,
    quickCheck,
    issueCodes: [...new Set(issueCodes)],
  };
}
