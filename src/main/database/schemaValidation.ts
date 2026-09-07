import type Database from 'better-sqlite3';
import { readEffectivePragmas, REQUIRED_PRAGMAS } from './connection';
import type { SchemaValidationResult } from './types';

/**
 * Post-migration health gate (task `§11`).
 *
 * Cheap, deterministic checks run on every normal startup — enough to refuse to
 * treat persistence as healthy if the schema is wrong, without an expensive
 * full `integrity_check` on each launch (that belongs to the crash/recovery
 * path, not steady state).
 */

export const REQUIRED_V1_TABLES = [
  'schema_migrations',
  'counters',
  'products',
  'customers',
  'sales',
  'sale_items',
  'payments',
  'inventory_movements',
  'settings',
  'google_sheet_export_jobs',
  'checkout_requests',
  'audit_events',
  'backup_records',
] as const;

const REQUIRED_COUNTER_KEYS = ['receipt_number', 'audit_sequence'] as const;

function tableNames(db: Database.Database): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: string;
  }[];
  return new Set(rows.map((row) => row.name));
}

export function validateSchema(
  db: Database.Database,
  options: { readonly expectedVersion: number },
): SchemaValidationResult {
  const failures: string[] = [];

  // Schema version reached, and history is readable.
  let schemaVersion: number | null = null;
  try {
    const row = db
      .prepare('SELECT MAX(version) AS version, COUNT(*) AS count FROM schema_migrations')
      .get() as { version: number | null; count: number };
    schemaVersion = row.version;
    if (row.version !== options.expectedVersion) {
      failures.push(
        `schema version is ${String(row.version)}, expected ${options.expectedVersion}`,
      );
    }
    if (row.count !== options.expectedVersion) {
      failures.push(
        `schema_migrations has ${row.count} row(s), expected ${options.expectedVersion}`,
      );
    }
  } catch (error) {
    failures.push(
      `schema_migrations is not readable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Critical tables present.
  const present = tableNames(db);
  for (const table of REQUIRED_V1_TABLES) {
    if (!present.has(table)) {
      failures.push(`required table missing: ${table}`);
    }
  }

  // Durability pragmas effective (REQ-DB-007).
  try {
    const pragmas = readEffectivePragmas(db);
    (Object.keys(REQUIRED_PRAGMAS) as (keyof typeof REQUIRED_PRAGMAS)[]).forEach((key) => {
      if (pragmas[key] !== REQUIRED_PRAGMAS[key]) {
        failures.push(
          `PRAGMA ${key} is ${String(pragmas[key])}, expected ${String(REQUIRED_PRAGMAS[key])}`,
        );
      }
    });
  } catch (error) {
    failures.push(
      `could not read durability pragmas: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Required counter rows initialised exactly once.
  if (present.has('counters')) {
    for (const key of REQUIRED_COUNTER_KEYS) {
      try {
        const row = db.prepare('SELECT COUNT(*) AS count FROM counters WHERE key = ?').get(key) as {
          count: number;
        };
        if (row.count !== 1) {
          failures.push(`counter "${key}" has ${row.count} row(s), expected exactly 1`);
        }
      } catch (error) {
        failures.push(
          `counter "${key}" not readable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // Basic safe read works against a representative table.
  try {
    db.prepare('SELECT COUNT(*) FROM products').get();
  } catch (error) {
    failures.push(
      `basic read against products failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // No foreign-key violations (cheap on a fresh/small database).
  try {
    const violations = db.pragma('foreign_key_check') as unknown[];
    if (violations.length > 0) {
      failures.push(`PRAGMA foreign_key_check reported ${violations.length} violation(s)`);
    }
  } catch (error) {
    failures.push(
      `foreign_key_check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { ok: failures.length === 0, schemaVersion, failures };
}
