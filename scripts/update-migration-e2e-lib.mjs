import { createRequire } from 'node:module';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  UPDATE_INSTALL_E2E_BUILD_ENV,
  UPDATE_INSTALL_E2E_PROFILE_ENV,
} from './update-install-e2e-lib.mjs';

const require = createRequire(import.meta.url);

/**
 * Phase 2N-E3 packaged migration-safety E2E helpers.
 *
 * Builds entirely on E2's proven install/identity/isolation/cleanup
 * machinery (`update-install-e2e-lib.mjs`) — this file adds only what is
 * genuinely new for E3: build-time migration-mode selection, pre-migration
 * backup discovery/independent verification, a deterministic backup-gate
 * obstruction, and a migration-aware evidence comparator.
 */

export const E3_MIGRATION_MODE_ENV = 'GO_PHONES_E3_MIGRATION_MODE';
export const E3_DELIBERATE_MIGRATION_FAILURE_MARKER = 'PHASE_2N_E3_DELIBERATE_MIGRATION_FAILURE';

/** Build-time env for an E3 migration build, layered on top of E2's own install-E2E build env. */
export function buildE3Environment(baseEnv, profile, mode) {
  if (mode !== 'success' && mode !== 'fail') {
    throw new Error('E3 migration build mode must be "success" or "fail".');
  }
  return {
    ...baseEnv,
    [UPDATE_INSTALL_E2E_BUILD_ENV]: '1',
    [UPDATE_INSTALL_E2E_PROFILE_ENV]: profile,
    [E3_MIGRATION_MODE_ENV]: mode,
  };
}

function openDatabase(dbFile, { readonly = false } = {}) {
  const Database = require('better-sqlite3');
  return new Database(dbFile, readonly ? { readonly: true, fileMustExist: true } : undefined);
}

function tableExists(db, name) {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

/** Deterministically make the real pre-migration backup mechanism fail: the
 * backup writer (`backupSnapshot.ts`'s `createSqliteSnapshot`) does
 * `mkdirSync(dirname(destPath), { recursive: true })` before writing — a
 * plain FILE already occupying that exact directory path makes that throw,
 * which `createVerifiedPreMigrationBackup` maps to a normal `BACKUP_WRITE_FAILED`
 * result. Pure filesystem setup in the isolated E3 profile; zero product-code
 * failure-injection. */
export function obstructPreMigrationBackupDirectory(profile) {
  const backupsRoot = join(profile, 'backups');
  const obstruction = join(backupsRoot, 'pre-migration');
  // `backups/` itself must exist as a directory (createSqliteSnapshot only
  // creates the missing LEAF, `pre-migration`) — obstruct only the leaf.
  mkdirSync(backupsRoot, { recursive: true });
  writeFileSync(obstruction, 'phase-2n-e3 deterministic backup obstruction — not a directory');
  return obstruction;
}

/** List pre-migration backup `.sqlite` files (newest first) under a profile's backups root. */
export function findPreMigrationBackupFiles(profile) {
  const dir = join(profile, 'backups', 'pre-migration');
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter(
      (entry) => entry.isFile() && /^gophones-pre-migration-v\d+-.+\.sqlite$/.test(entry.name),
    )
    .map((entry) => join(dir, entry.name))
    .sort()
    .reverse();
}

/** Read the `backup_records` rows for PRE_MIGRATION backups from a live database file. */
export function readPreMigrationBackupRecords(dbFile) {
  const db = openDatabase(dbFile, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT id, status, file_name, storage_path, source_app_version, source_schema_version,
                target_app_version, size_bytes, checksum_sha256, started_at, completed_at, error_code
           FROM backup_records
          WHERE backup_type = 'PRE_MIGRATION'
          ORDER BY started_at ASC`,
      )
      .all();
  } finally {
    db.close();
  }
}

/** Read migration-lifecycle audit events (`MIGRATION_*`, `BACKUP_*`) from a live database file. */
export function readMigrationAuditEvents(dbFile) {
  const db = openDatabase(dbFile, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT event_type, occurred_at, outcome, subject_type, subject_id, reason
           FROM audit_events
          WHERE event_type IN ('MIGRATION_STARTED','MIGRATION_COMPLETED','MIGRATION_FAILED','BACKUP_COMPLETED','BACKUP_FAILED')
          ORDER BY sequence ASC`,
      )
      .all();
  } finally {
    db.close();
  }
}

/** Read the exact schema_migrations rows (version, name, checksum) from a database file. */
export function readSchemaMigrationsRows(dbFile, { readonly = true } = {}) {
  const db = openDatabase(dbFile, { readonly });
  try {
    return db
      .prepare(
        'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC',
      )
      .all();
  } finally {
    db.close();
  }
}

/** `true` when the schema-2 E3 success probe table exists in this database file. */
export function hasSchema2Probe(dbFile, { readonly = true } = {}) {
  const db = openDatabase(dbFile, { readonly });
  try {
    return tableExists(db, 'e2e_schema2_probe');
  } finally {
    db.close();
  }
}

/** `true` when the (should-have-rolled-back) failing-migration probe table exists. */
export function hasFailingSchema2Probe(dbFile, { readonly = true } = {}) {
  const db = openDatabase(dbFile, { readonly });
  try {
    return tableExists(db, 'e2e_schema2_probe_failing');
  } finally {
    db.close();
  }
}

/**
 * Open a pre-migration backup file completely independently (its own
 * read-only connection) and verify: it opens, integrity/quick_check passes,
 * schema_migrations shows exactly schema 1 (not 2 — a backup taken BEFORE
 * migration must never itself already contain the migration it precedes),
 * the E3 success/failure probe tables are absent, and the seeded business
 * fixture rows match the pre-update evidence exactly. Never writes to the
 * file.
 */
export function verifyPreMigrationBackupIndependently(backupFile, beforeEvidence) {
  const db = openDatabase(backupFile, { readonly: true });
  try {
    const quick = String(db.pragma('quick_check', { simple: true })).toLowerCase();
    const schemaRows = db
      .prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
      .all()
      .map((row) => row.version);
    const probePresent = tableExists(db, 'e2e_schema2_probe');
    const failingProbePresent = tableExists(db, 'e2e_schema2_probe_failing');
    const product = db
      .prepare('SELECT * FROM products WHERE id = ?')
      .get(beforeEvidence.product.id);
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(beforeEvidence.sale.id);
    const problems = [];
    if (quick !== 'ok') problems.push(`backup quick_check returned "${quick}"`);
    if (JSON.stringify(schemaRows) !== JSON.stringify([1])) {
      problems.push(`backup schema_migrations is ${JSON.stringify(schemaRows)}, expected [1]`);
    }
    if (probePresent) problems.push('backup already contains the schema-2 success probe table');
    if (failingProbePresent)
      problems.push('backup already contains the failing-migration probe table');
    if (JSON.stringify(product) !== JSON.stringify(beforeEvidence.product)) {
      problems.push('backup product row does not match the pre-update fixture');
    }
    if (JSON.stringify(sale) !== JSON.stringify(beforeEvidence.sale)) {
      problems.push('backup sale row does not match the pre-update fixture');
    }
    return { ok: problems.length === 0, problems, schemaRows, quick };
  } finally {
    db.close();
  }
}

/**
 * Migration-aware business-data preservation comparator. Identical in spirit
 * to E2's `compareBusinessEvidence`, but tolerant of ADDITIONAL rows that a
 * real migration is expected to add (backup_records, plus MIGRATION_ and
 * BACKUP_ audit events) — those are asserted separately, never treated as
 * corruption here.
 */
export function compareBusinessEvidenceThroughMigration(before, after) {
  const problems = [];
  const eq = (label, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      problems.push(`${label} changed: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    }
  };
  eq('product row', before.product, after.product);
  eq('customer row', before.customer, after.customer);
  eq('sale row', before.sale, after.sale);
  eq('sale item row', before.saleItem, after.saleItem);
  eq('payment row', before.payment, after.payment);
  eq('inventory movement row', before.movement, after.movement);
  eq('audit event row', before.auditEvent, after.auditEvent);
  eq('checkout request row', before.checkoutRequest, after.checkoutRequest);
  eq('fixture setting', before.setting, after.setting);
  eq('business timezone setting', before.businessTimezone, after.businessTimezone);
  eq('receipt-number counter', before.receiptCounterValue, after.receiptCounterValue);
  if (after.exportJob?.status !== 'PENDING') {
    problems.push(`export job status is no longer PENDING: ${after.exportJob?.status}`);
  }
  eq('export job identity', before.exportJob?.id, after.exportJob?.id);
  // Business row counts must be identical (no duplicates); audit_events may
  // legitimately grow by exactly the migration's own MIGRATION_*/BACKUP_*
  // rows, so it is compared separately by the caller, never here.
  for (const key of Object.keys(before.counts)) {
    if (key === 'auditEvents') continue;
    if (before.counts[key] !== after.counts[key]) {
      problems.push(
        `row count for ${key} changed (possible duplicate): ${before.counts[key]} -> ${after.counts[key]}`,
      );
    }
  }
  if (!after.integrityOk) problems.push('post-update SQLite integrity_check failed');
  if (!after.foreignKeysOk)
    problems.push('post-update SQLite foreign_key_check reported violations');
  return problems;
}
