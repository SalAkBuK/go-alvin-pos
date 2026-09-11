import type Database from 'better-sqlite3';

/**
 * Post-swap validation of the operational connection opened on a restored (or
 * recovered) database (`DATA_MODEL.md §52A` step 5; `POS_WORKFLOWS.md §67A`
 * step 7; Phase 2L-B Item 16).
 *
 * `ProductionDatabase.open` already applied + verified the durability pragmas
 * and ran `validateSchema` (schema version, table presence, pragmas, FK check).
 * This adds the explicit per-table readability + receipt-counter checks the
 * restore contract calls out, on the live connection that checkout will use.
 *
 * Throws {@link RestoreValidationError} on the first failure — the caller then
 * rolls back to the pre-restore recovery copy.
 */

export class RestoreValidationError extends Error {
  override readonly name = 'RestoreValidationError';
  constructor(
    readonly failure: string,
    readonly osErrorCode?: string,
  ) {
    super(`restored database validation failed: ${failure}`);
  }
}

const READABLE_TABLES = [
  'products',
  'customers',
  'sales',
  'sale_items',
  'payments',
  'inventory_movements',
  'settings',
  'google_sheet_export_jobs',
  'checkout_requests',
  'counters',
  'audit_events',
  'backup_records',
  'schema_migrations',
] as const;

export function assertRestoredDatabaseUsable(
  db: Database.Database,
  expectedSchemaVersion: number,
): void {
  // Integrity + foreign keys on the live connection.
  try {
    const quick = String(db.pragma('quick_check', { simple: true })).toLowerCase();
    if (quick !== 'ok') {
      throw new RestoreValidationError(`quick_check=${quick}`);
    }
  } catch (error) {
    if (error instanceof RestoreValidationError) throw error;
    throw new RestoreValidationError('quick_check threw', codeOf(error));
  }

  try {
    if ((db.pragma('foreign_key_check') as unknown[]).length > 0) {
      throw new RestoreValidationError('foreign_key_check reported violations');
    }
  } catch (error) {
    if (error instanceof RestoreValidationError) throw error;
    throw new RestoreValidationError('foreign_key_check threw', codeOf(error));
  }

  if (Number(db.pragma('foreign_keys', { simple: true })) !== 1) {
    throw new RestoreValidationError('foreign_keys pragma is not ON');
  }

  // Schema version + history coherence.
  let version: number | null;
  let count: number;
  try {
    const row = db
      .prepare('SELECT MAX(version) AS version, COUNT(*) AS count FROM schema_migrations')
      .get() as { version: number | null; count: number };
    version = row.version;
    count = row.count;
  } catch (error) {
    throw new RestoreValidationError('schema_migrations not readable', codeOf(error));
  }
  if (version !== expectedSchemaVersion) {
    throw new RestoreValidationError(
      `schema version ${String(version)} != expected ${expectedSchemaVersion}`,
    );
  }
  if (count !== expectedSchemaVersion) {
    throw new RestoreValidationError(`schema_migrations has ${count} row(s), expected ${count}`);
  }

  // Every canonical table present + readable (`DATA_MODEL.md §52`).
  for (const table of READABLE_TABLES) {
    try {
      db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get();
    } catch (error) {
      throw new RestoreValidationError(`table "${table}" not readable`, codeOf(error));
    }
  }

  // The receipt-number counter must be readable (`TEST-BACKUP-014`, adversarial "receipt counter preserved").
  try {
    const counter = db.prepare("SELECT value FROM counters WHERE key = 'receipt_number'").get() as
      { value: number } | undefined;
    if (!counter || typeof counter.value !== 'number') {
      throw new RestoreValidationError('receipt_number counter missing or unreadable');
    }
  } catch (error) {
    if (error instanceof RestoreValidationError) throw error;
    throw new RestoreValidationError('receipt_number counter read threw', codeOf(error));
  }
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : undefined;
}
