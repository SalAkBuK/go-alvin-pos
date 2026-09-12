import type { Migration } from '../types';
import { PRODUCTION_MIGRATIONS } from './index';
import { migration001 } from './001_initial_schema';
import { migration002E2ESuccess } from './002_e2e_schema_probe';
import { migration002E2EFailing } from './002_e2e_schema_probe_failing';

/**
 * Phase 2N-E3 test-only migration-SET selection authority.
 *
 * Exactly one compile-time switch decides which migration set a build
 * converges to — `resolveActiveMigrations()` — and every trusted component
 * that needs to agree on "what schema does this build target" (main
 * database open, restore-service reopen/target, build-identity embedding)
 * calls it, so an E3 build can never migrate to schema 2 while some other
 * component still expects schema 1 (`§5` of the E3 handoff).
 *
 * `GO_PHONES_E3_MIGRATION_MODE` is read ONLY at build time (by
 * `electron.vite.config.ts`, exactly like `updateInstallE2eConfig.ts`'s
 * `GO_PHONES_UPDATE_INSTALL_E2E_BUILD`) and baked into the `__E3_MIGRATION_MODE__`
 * compile-time constant. There is no runtime environment-variable path, no
 * renderer-selectable mode, and no filesystem-loaded migration — an ordinary
 * production build never sets this variable, so `__E3_MIGRATION_MODE__` is a
 * literal `null` and `resolveActiveMigrations()` returns exactly
 * `PRODUCTION_MIGRATIONS`, unconditionally.
 */

export const E3_MIGRATION_MODE_ENV = 'GO_PHONES_E3_MIGRATION_MODE';

export type E3MigrationMode = 'success' | 'fail';

declare const __E3_MIGRATION_MODE__: string | null | undefined;

/** Build-time-only parser (called from `electron.vite.config.ts`). Fails closed on garbage input. */
export function validateE3MigrationModeBuildConfig(env: NodeJS.ProcessEnv): E3MigrationMode | null {
  const raw = env[E3_MIGRATION_MODE_ENV];
  if (raw === undefined || raw === '') return null;
  if (raw !== 'success' && raw !== 'fail') {
    throw new Error(`${E3_MIGRATION_MODE_ENV} must be "success" or "fail" when set, got "${raw}".`);
  }
  return raw;
}

/** Pure mapping from a resolved mode to the migration set it selects. Used at both build time
 * (for build-identity embedding) and runtime (for the actual migration run). */
export function migrationsForE3Mode(mode: E3MigrationMode | null): readonly Migration[] {
  if (mode === 'success') return [migration001, migration002E2ESuccess];
  if (mode === 'fail') return [migration001, migration002E2EFailing];
  return PRODUCTION_MIGRATIONS;
}

/** Runtime-only: read the compile-time-baked mode. `null` in every ordinary build. */
export function embeddedE3MigrationMode(): E3MigrationMode | null {
  return typeof __E3_MIGRATION_MODE__ === 'string' &&
    (__E3_MIGRATION_MODE__ === 'success' || __E3_MIGRATION_MODE__ === 'fail')
    ? __E3_MIGRATION_MODE__
    : null;
}

/**
 * The one call every runtime consumer (main database open, restore service,
 * build identity) makes. Deliberately branches directly on the compile-time
 * literal `__E3_MIGRATION_MODE__` here — NOT via `migrationsForE3Mode(embeddedE3MigrationMode())`
 * — because `scripts/verify-packaging.mjs` proves the two fixture migrations
 * are absent from an ordinary production bundle by bundler dead-code
 * elimination, and that only reliably eliminates an `if` block whose
 * condition is the literal itself, not one reached through an intermediate
 * function call (the same reasoning `updateInstallE2eTrigger.ts`'s
 * compile-time gate relies on).
 */
export function resolveActiveMigrations(): readonly Migration[] {
  if (typeof __E3_MIGRATION_MODE__ === 'string' && __E3_MIGRATION_MODE__ === 'success') {
    return [migration001, migration002E2ESuccess];
  }
  if (typeof __E3_MIGRATION_MODE__ === 'string' && __E3_MIGRATION_MODE__ === 'fail') {
    return [migration001, migration002E2EFailing];
  }
  return PRODUCTION_MIGRATIONS;
}
