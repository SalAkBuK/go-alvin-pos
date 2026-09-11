import { createHash, createHmac, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { NewerDataLoss, RestoreCandidate } from '../../shared/restore';
import { appErrors } from '../shared/appError';
import { backupDirFor } from './backupNaming';
import type { BackupRecordRow } from './backupRecordsRepository';
import { listBackupRecords } from './backupRecordsRepository';
import type { BrowseCandidateRegistry } from './browseCandidate';
import {
  BACKUP_DISCOVERY_ERROR_CODES,
  discoverManagedBackups,
  verifyBackupCandidate,
} from './backupDiscovery';
import type { VerifiedBackupFile } from './backupDiscovery';

/**
 * Restore-candidate lookup, immediate revalidation, newer-data loss, and the
 * confirmation-token / current-data-fingerprint machinery
 * (`REQ-BACKUP-011`; `DATA_MODEL.md §52A`; `POS_WORKFLOWS.md §67`, `§67A`,
 * `§67B`; Phase 2L-B Items 8, 9, 10, 11, 18; Phase 2L-C unified discovery).
 *
 * The renderer only ever names an opaque `backupId`: either a catalog id, a
 * deterministic uncatalogued-physical-file id, or a one-time Browse session
 * token. {@link resolveAndRevalidateCandidate} resolves whichever source the
 * id names and re-checks the file from scratch through the same independent
 * verification pipeline ({@link verifyBackupCandidate}) — previous
 * verification, a catalog row, and a sidecar manifest are never trusted
 * indefinitely.
 */

/** A resolved, still-valid restore candidate. */
export interface ResolvedCandidate {
  /** `null` for an uncatalogued managed file or a Browse-selected candidate. */
  readonly row: BackupRecordRow | null;
  readonly filePath: string;
  readonly checksum: string;
  readonly schemaVersion: number;
  readonly candidate: RestoreCandidate;
}

/** Where unified discovery looks for managed backups right now. */
export interface UnifiedCandidateSources {
  readonly localBackupsRoot: string;
  /** The currently configured OFF_DEVICE directory, or `null` when none is set. */
  readonly offDeviceBackupsRoot: string | null;
}

export async function listRestoreCandidates(
  db: Database.Database,
  sources: UnifiedCandidateSources,
): Promise<RestoreCandidate[]> {
  const { candidates } = await discoverManagedBackups(db, {
    localBackupsRoot: sources.localBackupsRoot,
    offDeviceBackupsRoot: sources.offDeviceBackupsRoot,
  });
  return candidates.map((c) => c.candidate);
}

/**
 * Build the safe DTO for a freshly verified Browse-selected file. `backupType`
 * is always `MANUAL` — an owner's one-time file-dialog selection is never the
 * scheduler's automatic cadence. `locationKind` is always `LOCAL_DISK`:
 * Browse never runs the OFF_DEVICE physical-disk verification, so it must
 * never claim the disk-loss protection that label implies, regardless of
 * where the selected file actually sits.
 */
function browsedCandidateDto(backupId: string, verified: VerifiedBackupFile): RestoreCandidate {
  return {
    backupId,
    backupType: 'MANUAL',
    createdAt: verified.manifest?.completedAt ?? verified.modifiedAt,
    sourceAppVersion: verified.manifest?.sourceAppVersion ?? 'unknown',
    schemaVersion: verified.schemaVersion,
    sizeBytes: verified.sizeBytes,
    locationKind: 'LOCAL_DISK',
    sourceKind: 'BROWSED',
    catalogued: false,
  };
}

/**
 * Best-effort preview DTO built directly from a catalog row's OWN recorded
 * metadata, with NO independent reverification — used only so
 * `RestoreService.inspect` can still explain why a schema-incompatible
 * catalogued backup is disabled after discovery has excluded it from the
 * restorable candidate list entirely. Never used as a restore source.
 */
export function previewIncompatibleCandidate(
  db: Database.Database,
  backupId: string,
): RestoreCandidate | null {
  const row = listBackupRecords(db).find((r) => r.id === backupId) ?? null;
  if (row === null || (row.backupType !== 'AUTOMATIC' && row.backupType !== 'MANUAL')) {
    return null;
  }
  return {
    backupId: row.id,
    backupType: row.backupType,
    createdAt: row.completedAt ?? row.startedAt,
    sourceAppVersion: row.sourceAppVersion ?? 'unknown',
    schemaVersion: row.sourceSchemaVersion ?? 0,
    sizeBytes: row.sizeBytes ?? 0,
    locationKind: row.locationKind,
    sourceKind: 'MANAGED',
    catalogued: true,
  };
}

/**
 * Locate a still-known catalog row's file, so a schema-incompatible candidate
 * (rejected by discovery's exact schema-history check) can still be resolved
 * well enough to report the specific older/newer reason. Same containment
 * rule as discovery: the file must sit inside one of the exact managed
 * directories for its claimed type/location.
 */
function catalogRowFilePath(row: BackupRecordRow, sources: UnifiedCandidateSources): string | null {
  if (
    row.fileName === null ||
    row.storagePath === null ||
    row.fileName.includes('/') ||
    row.fileName.includes('\\') ||
    row.fileName.includes('..') ||
    (row.backupType !== 'AUTOMATIC' && row.backupType !== 'MANUAL')
  ) {
    return null;
  }
  const resolvedStorage = resolve(row.storagePath);
  const allowedRoots = [resolve(backupDirFor(sources.localBackupsRoot, row.backupType))];
  if (sources.offDeviceBackupsRoot) {
    allowedRoots.push(resolve(backupDirFor(sources.offDeviceBackupsRoot, row.backupType)));
  }
  if (!allowedRoots.includes(resolvedStorage)) {
    return null;
  }
  return join(row.storagePath, row.fileName);
}

/**
 * Resolve `backupId` and re-run the full independent file safety check from
 * scratch (Item 9; Phase 2L-C unified discovery). Throws a typed `AppError`
 * on any failure — nothing is replaced. `backupId` may name: a currently
 * verified managed candidate (catalogued or rediscovered, local or
 * off-device); a catalogued row that discovery just rejected (resolved only
 * far enough to report a specific schema-incompatible reason, matching the
 * pre-2L-C preview behavior); or a live Browse session token.
 */
export async function resolveAndRevalidateCandidate(
  db: Database.Database,
  sources: UnifiedCandidateSources,
  browseRegistry: BrowseCandidateRegistry,
  backupId: string,
  targetSchemaVersion: number,
): Promise<ResolvedCandidate> {
  const discovery = await discoverManagedBackups(db, {
    localBackupsRoot: sources.localBackupsRoot,
    offDeviceBackupsRoot: sources.offDeviceBackupsRoot,
  });
  const managed = discovery.candidates.find((c) => c.candidate.backupId === backupId);
  if (managed) {
    return {
      row: managed.catalogRecord,
      filePath: managed.filePath,
      checksum: managed.checksumSha256,
      schemaVersion: managed.candidate.schemaVersion,
      candidate: managed.candidate,
    };
  }

  // Not currently an offered candidate. A known catalog row whose file sits
  // inside a managed area resolves only far enough to give the specific
  // older/newer schema message the UI already relies on; a row that does NOT
  // even resolve to a managed path is treated exactly like an unknown id
  // (never partially trusted), and any other in-area rejection reason is
  // reported generically — the candidate list is the single source of truth
  // for what is restorable.
  const row = listBackupRecords(db).find((r) => r.id === backupId) ?? null;
  if (row) {
    const filePath = catalogRowFilePath(row, sources);
    if (filePath === null) {
      throw appErrors.restoreCandidateNotFound();
    }
    const actual = readSchemaVersion(filePath);
    if (actual !== null && actual !== targetSchemaVersion) {
      throw appErrors.restoreSchemaIncompatible(actual < targetSchemaVersion ? 'older' : 'newer');
    }
    throw appErrors.restoreCandidateInvalid();
  }

  const browsedPath = browseRegistry.resolve(backupId);
  if (browsedPath === null) {
    throw appErrors.restoreCandidateNotFound();
  }
  const verification = await verifyBackupCandidate(browsedPath);
  if (!verification.ok) {
    if (verification.errorCode === BACKUP_DISCOVERY_ERROR_CODES.schemaVersionMismatch) {
      const actual = readSchemaVersion(browsedPath);
      throw appErrors.restoreSchemaIncompatible(
        actual !== null && actual < targetSchemaVersion ? 'older' : 'newer',
      );
    }
    throw appErrors.restoreCandidateInvalid();
  }
  return {
    row: null,
    filePath: verification.value.filePath,
    checksum: verification.value.checksumSha256,
    schemaVersion: verification.value.schemaVersion,
    candidate: browsedCandidateDto(backupId, verification.value),
  };
}

/**
 * Verify an owner-selected file from the native "Browse for a backup file…"
 * dialog and register it as a one-time restore candidate. Throws a typed
 * `AppError` when the file does not pass the same independent verification
 * every managed candidate passes.
 */
export async function resolveBrowsedCandidate(
  filePath: string,
  browseRegistry: BrowseCandidateRegistry,
): Promise<RestoreCandidate> {
  const verification = await verifyBackupCandidate(filePath);
  if (!verification.ok) {
    throw appErrors.restoreCandidateInvalid();
  }
  const token = browseRegistry.register(verification.value.filePath);
  return browsedCandidateDto(token, verification.value);
}

function readSchemaVersion(filePath: string): number | null {
  let db: Database.Database | undefined;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
    return (
      (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null })
        .v ?? null
    );
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Completed sales present in `currentDb` that a restore of `candidateFilePath`
 * would discard, identified by immutable Sale ID membership — NOT by comparing
 * `completed_at` to the candidate's latest timestamp (Item 18; corrected per
 * the 2L-B adversarial follow-up, "Item 2").
 *
 * A wall-clock boundary (`completed_at > MAX(candidate.completed_at)`) can miss
 * a sale that the current database committed after the backup was taken: a
 * system clock moved backward, or two sales share the exact same
 * `completed_at` value. `ARCHITECTURE.md` / `DATA_MODEL.md` do not allow true
 * event ordering to depend solely on wall-clock time, so membership is decided
 * by the sale's immutable primary key — a sale whose id does not exist as a
 * COMPLETED sale in the candidate is "lost". `completed_at` is used only
 * afterward, to compute the display range over the lost rows.
 */
export function computeNewerSaleLoss(
  currentDb: Database.Database,
  candidateFilePath: string,
): NewerDataLoss | null {
  let candidate: Database.Database | undefined;
  let candidateCompletedIds: Set<string>;
  try {
    candidate = new Database(candidateFilePath, { readonly: true, fileMustExist: true });
    candidateCompletedIds = new Set(
      (
        candidate.prepare("SELECT id FROM sales WHERE status = 'COMPLETED'").all() as Array<{
          id: string;
        }>
      ).map((row) => row.id),
    );
  } finally {
    candidate?.close();
  }

  const currentCompleted = currentDb
    .prepare("SELECT id, completed_at AS at FROM sales WHERE status = 'COMPLETED'")
    .all() as Array<{ id: string; at: string }>;

  const lost = currentCompleted
    .filter((row) => !candidateCompletedIds.has(row.id))
    .sort((a, b) => a.at.localeCompare(b.at));

  if (lost.length === 0) {
    return null;
  }
  return {
    transactionCount: lost.length,
    earliestCompletedAt: lost[0]!.at,
    latestCompletedAt: lost[lost.length - 1]!.at,
  };
}

/**
 * Explicit, reviewable list of the tables whose content is authoritative
 * business data for restore-confirmation purposes (2L-B final corrections,
 * "material restore-state fingerprint"). Each entry names its own stable
 * primary-key ordering and an explicit column list — never `SELECT *` — so the
 * fingerprint is immune to column-order/schema drift and to row-return order
 * without `ORDER BY`.
 *
 * Deliberately EXCLUDED (secondary/operational bookkeeping, not business data;
 * excluding them is what stops routine background work from manufacturing a
 * false stale confirmation): `google_sheet_export_jobs`, every `settings` row
 * whose key starts with `google_`, `backup_records`, and `audit_events` (every
 * audit event that represents a material change is already reflected by that
 * change's own source-table row above; the remaining audit events describe
 * exactly the Google/backup churn this list otherwise excludes).
 * `schema_migrations` does not participate — restore already requires an exact
 * schema match, and a migration cannot run concurrently with a restore
 * confirmation.
 *
 * IMPORTANT: revisit this list whenever a future migration introduces a new
 * table or settings key that holds authoritative, owner-facing business data —
 * an addition here is the only way it starts protecting restore confirmation.
 */
const MATERIAL_FINGERPRINT_TABLES: ReadonlyArray<{ readonly name: string; readonly sql: string }> =
  [
    {
      name: 'products',
      sql: `SELECT id, sku, barcode, name, brand, model, condition, cost_price_cents,
              selling_price_cents, quantity_on_hand, low_stock_threshold, is_active,
              created_at, updated_at
            FROM products ORDER BY id`,
    },
    {
      name: 'customers',
      sql: `SELECT id, name, phone, phone_normalized, created_at, updated_at
            FROM customers ORDER BY id`,
    },
    {
      name: 'sales',
      sql: `SELECT id, receipt_number, customer_id, customer_name_snapshot, customer_phone_snapshot,
              business_name_snapshot, business_address_snapshot, business_phone_snapshot,
              receipt_disclaimer_snapshot, receipt_footer_snapshot, status, sync_version,
              subtotal_cents, discount_cents, taxable_amount_cents, tax_rate_bps, tax_cents,
              total_cents, payment_method_snapshot, created_at, completed_at, voided_at, void_reason
            FROM sales ORDER BY id`,
    },
    {
      name: 'sale_items',
      sql: `SELECT id, sale_id, product_id, product_name_snapshot, brand_snapshot, model_snapshot,
              condition_snapshot, sku_snapshot, barcode_snapshot, listed_price_cents,
              sold_price_cents, discount_cents, quantity, line_subtotal_cents, line_total_cents,
              created_at
            FROM sale_items ORDER BY id`,
    },
    {
      name: 'payments',
      sql: `SELECT id, sale_id, method, amount_cents, status, created_at
            FROM payments ORDER BY id`,
    },
    {
      name: 'inventory_movements',
      sql: `SELECT id, product_id, sale_id, movement_type, reverses_movement_id, quantity_change,
              quantity_before, quantity_after, reason, created_at
            FROM inventory_movements ORDER BY id`,
    },
    {
      name: 'checkout_requests',
      sql: `SELECT request_id, request_fingerprint, payment_method_snapshot, intended_total_cents,
              clover_approved_confirmed_at, sale_id, status, failure_code, resolution_status,
              resolution_note, created_at, completed_at, failed_at, resolved_at
            FROM checkout_requests ORDER BY request_id`,
    },
    {
      // `receipt_number` only — tied directly to completed sales, already
      // covered above. `audit_sequence` is deliberately EXCLUDED: it advances
      // on every audit event, including the secondary `GOOGLE_CONFIGURATION_CHANGED`/
      // `BACKUP_*` ones `audit_events` is excluded for, so including it would
      // silently reintroduce exactly the background churn this fingerprint
      // exists to ignore.
      name: 'counters',
      sql: `SELECT key, value, updated_at FROM counters WHERE key = 'receipt_number' ORDER BY key`,
    },
    {
      // Every locally-configured, owner-facing setting EXCEPT the `google_*`
      // keys (Google connectivity/credential bookkeeping — secondary).
      name: 'settings',
      sql: `SELECT key, value, updated_at FROM settings WHERE key NOT LIKE 'google_%' ORDER BY key`,
    },
  ];

/**
 * Separator emitted before/after every table name and every row.
 * `JSON.stringify` always escapes a literal NUL character inside a string
 * value as a six-character escape sequence, so a raw NUL character code
 * concatenated here can never appear inside a row's own serialized
 * content — table/row boundaries can never be ambiguous with data.
 */
const FINGERPRINT_SEPARATOR = String.fromCharCode(0);

/**
 * Deterministic fingerprint of authoritative/material business state (2L-B
 * final corrections, replacing the whole-file snapshot checksum as the
 * restore-confirmation fingerprint). A whole-file checksum correctly detects
 * ANY SQLite mutation, including routine background bookkeeping (Google
 * export-job delivery-state churn, Google auth-health/provisioning markers, a
 * due automatic backup's new `backup_records` row, its `BACKUP_*` audit
 * event) — which restore's own post-`CONFIRMATION_REQUIRED` service restart
 * can trigger immediately, manufacturing a false "stale confirmation" with no
 * user action at all. This fingerprint instead hashes only
 * {@link MATERIAL_FINGERPRINT_TABLES} — explicit columns, explicit primary-key
 * order, never raw SQLite bytes — so it changes if and only if authoritative
 * business data changed, and is stable across that routine background churn.
 *
 * Clock-independent: no column compared here is a timestamp used for ordering
 * (rows are ordered by primary key); a clock anomaly cannot change the
 * fingerprint merely by moving a `created_at`/`completed_at` value.
 */
export function materialRestoreStateFingerprint(db: Database.Database): string {
  const hash = createHash('sha256');
  for (const table of MATERIAL_FINGERPRINT_TABLES) {
    hash.update(FINGERPRINT_SEPARATOR);
    hash.update(table.name);
    hash.update(FINGERPRINT_SEPARATOR);
    const rows = db.prepare(table.sql).raw().all() as readonly unknown[][];
    for (const row of rows) {
      // `JSON.stringify` on a positional array (never a keyed object) preserves
      // NULL vs `""` vs `0` distinctions exactly and never depends on property
      // enumeration order.
      hash.update(JSON.stringify(row));
      hash.update(FINGERPRINT_SEPARATOR);
    }
  }
  return hash.digest('hex');
}

/**
 * Opaque, short-lived confirmation token bound to (candidate checksum, current
 * fingerprint). Self-contained: `<expiryMs>.<hmac>` — no server-side state
 * beyond the per-process secret.
 */
export function createConfirmationTokenizer(ttlMs = 10 * 60_000) {
  const secret = randomBytes(32);

  function sign(payload: string): string {
    return createHmac('sha256', secret).update(payload).digest('hex');
  }

  return {
    mint(candidateChecksum: string, currentFingerprint: string, nowMs: number): string {
      const exp = nowMs + ttlMs;
      const payload = `${exp}.${candidateChecksum}.${currentFingerprint}`;
      return `${exp}.${sign(payload)}`;
    },
    /** `true` only for an unexpired token whose signature matches the current state. */
    verify(
      token: string | undefined,
      candidateChecksum: string,
      currentFingerprint: string,
      nowMs: number,
    ): boolean {
      if (typeof token !== 'string') {
        return false;
      }
      const dot = token.indexOf('.');
      if (dot <= 0) {
        return false;
      }
      const exp = Number(token.slice(0, dot));
      const mac = token.slice(dot + 1);
      if (!Number.isFinite(exp) || exp < nowMs) {
        return false;
      }
      const expected = sign(`${exp}.${candidateChecksum}.${currentFingerprint}`);
      return timingSafeEqualHex(mac, expected);
    },
  };
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
