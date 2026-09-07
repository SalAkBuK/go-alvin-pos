import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * Smallest reusable audit-append capability (task `§12`, `DATA_MODEL.md §36A`).
 *
 * It does exactly three things and nothing more:
 *   1. allocate the next `audit_sequence` value from the `counters` row, using
 *      the same read-then-increment pattern as `receipt_number` (`§29`);
 *   2. insert one `audit_events` row carrying that sequence;
 *   3. run entirely on the connection it is handed — it opens NO transaction of
 *      its own, so it participates in whatever transaction the caller has open.
 *
 * The caller is responsible for wrapping this in the same transaction as the
 * business change it records (`§36A`: "no `sequence` value is ever assigned to
 * an event that does not durably commit"). This is not an audit UI, a query
 * API, or the Support & Diagnostics system.
 */

export type AuditEventType =
  | 'SALE_COMPLETED'
  | 'SALE_VOIDED'
  | 'PRICE_OVERRIDE'
  | 'INVENTORY_ADJUSTED'
  | 'TAX_SETTING_CHANGED'
  | 'BUSINESS_SETTING_CHANGED'
  | 'GOOGLE_CONFIGURATION_CHANGED'
  | 'BACKUP_COMPLETED'
  | 'BACKUP_FAILED'
  | 'MIGRATION_STARTED'
  | 'MIGRATION_COMPLETED'
  | 'MIGRATION_FAILED'
  | 'UPDATE_INSTALLED'
  | 'CARD_LOCAL_COMMIT_FAILURE'
  | 'AUTH_CREDENTIAL_CHANGED';

export interface AppendAuditEventInput {
  readonly eventType: AuditEventType;
  /** ISO-8601 UTC. */
  readonly occurredAt: string;
  readonly actorType: 'USER' | 'SYSTEM';
  readonly outcome: 'SUCCESS' | 'FAILURE';
  readonly appVersion: string;
  readonly actorIdentifier?: string | null;
  readonly subjectType?: string | null;
  readonly subjectId?: string | null;
  readonly correlationId?: string | null;
  readonly reason?: string | null;
  /** Sanitized, schema-validated context only — never secrets or unnecessary PII. */
  readonly details?: Record<string, unknown> | null;
}

export interface AppendedAuditEvent {
  readonly id: string;
  readonly sequence: number;
}

/** Allocate the next audit sequence and insert the event. Must be called inside the caller's transaction. */
export function appendAuditEvent(
  db: Database.Database,
  input: AppendAuditEventInput,
): AppendedAuditEvent {
  const counter = db.prepare("SELECT value FROM counters WHERE key = 'audit_sequence'").get() as
    { value: number } | undefined;
  if (!counter) {
    throw new Error('audit_sequence counter row is missing');
  }
  const sequence = counter.value + 1;
  db.prepare("UPDATE counters SET value = ?, updated_at = ? WHERE key = 'audit_sequence'").run(
    sequence,
    input.occurredAt,
  );

  const id = randomUUID();
  db.prepare(
    `INSERT INTO audit_events
       (id, sequence, event_type, occurred_at, actor_type, actor_identifier, subject_type,
        subject_id, correlation_id, outcome, reason, details_json, app_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    sequence,
    input.eventType,
    input.occurredAt,
    input.actorType,
    input.actorIdentifier ?? null,
    input.subjectType ?? null,
    input.subjectId ?? null,
    input.correlationId ?? null,
    input.outcome,
    input.reason ?? null,
    input.details == null ? null : JSON.stringify(input.details),
    input.appVersion,
  );

  return { id, sequence };
}
