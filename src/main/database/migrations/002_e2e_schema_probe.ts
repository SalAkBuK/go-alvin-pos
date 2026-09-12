import type { Migration } from '../types';

/**
 * Phase 2N-E3 test-only schema-2 fixture migration (SUCCESS path).
 *
 * This is NOT a real product migration and is never a member of
 * `PRODUCTION_MIGRATIONS` (`migrations/index.ts`) — it exists purely so the
 * packaged migration-safety E2E (`docs/PACKAGED_UPDATE_MIGRATION_E2E.md`) can
 * prove the real pre-migration-backup-gated, transactional migration runner
 * behaves safely for a genuine schema change, without inventing a real
 * production schema requirement to do it. It is selected only by
 * `e3MigrationConfig.ts`'s compile-time-gated `resolveActiveMigrations()`,
 * which an ordinary production build never activates.
 *
 * The change is deliberately harmless and isolated: one dedicated probe table
 * that touches no production business table, with one deterministic seeded
 * row so post-migration verification has something concrete to check.
 */

const SCHEMA_SQL = /* sql */ `
CREATE TABLE e2e_schema2_probe (
  id         INTEGER PRIMARY KEY,
  marker     TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);
`;

const SEED_MARKER = 'phase-2n-e3-schema2-probe';

export const migration002E2ESuccess: Migration = {
  version: 2,
  name: 'e2e_schema2_probe',
  fingerprint: `${SCHEMA_SQL}\nseed:marker=${SEED_MARKER}`,
  run(db, ctx) {
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO e2e_schema2_probe (marker, created_at) VALUES (?, ?)').run(
      SEED_MARKER,
      ctx.now,
    );
  },
};
