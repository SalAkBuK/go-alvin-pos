import type { Migration } from '../types';

/**
 * Phase 2N-E3 test-only schema-2 fixture migration (APPLY-FAILURE path).
 *
 * Same non-production status as `002_e2e_schema_probe.ts` (never a member of
 * `PRODUCTION_MIGRATIONS`, selected only by `e3MigrationConfig.ts`'s
 * compile-time-gated resolver). This variant deliberately mutates schema
 * first and THEN throws, inside the same `run()` the real migration runner
 * (`migrationRunner.ts`) always wraps in one exclusive SQLite transaction —
 * proving that a genuine mid-migration failure rolls back completely (no
 * stray table, no `schema_migrations` advance), not merely that a failure
 * was reported.
 *
 * `PHASE_2N_E3_DELIBERATE_MIGRATION_FAILURE` is a stable, greppable marker
 * string carried into the thrown error message and, from there, into the
 * real `database.migration.failed` structured log line and the
 * `MIGRATION_FAILED` audit event `reason` — the E3 harness asserts on it to
 * confirm the *expected* failure occurred, not an unrelated bug.
 */

const SCHEMA_SQL = /* sql */ `
CREATE TABLE e2e_schema2_probe_failing (
  id INTEGER PRIMARY KEY
);
`;

export const E3_DELIBERATE_MIGRATION_FAILURE_MARKER = 'PHASE_2N_E3_DELIBERATE_MIGRATION_FAILURE';

export const migration002E2EFailing: Migration = {
  version: 2,
  name: 'e2e_schema2_probe_failing',
  fingerprint: `${SCHEMA_SQL}\n${E3_DELIBERATE_MIGRATION_FAILURE_MARKER}`,
  run(db) {
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO e2e_schema2_probe_failing (id) VALUES (1)').run();
    throw new Error(E3_DELIBERATE_MIGRATION_FAILURE_MARKER);
  },
};
