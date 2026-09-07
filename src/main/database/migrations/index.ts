import type { Migration } from '../types';
import { migration001 } from './001_initial_schema';

/**
 * The ordered production migration set.
 *
 * Bundled into the main-process build; never loaded from the filesystem. Add
 * new migrations here in ascending version order (`002_*`, `003_*`, …). The
 * runner independently asserts the set is contiguous and starts at 1.
 */
export const PRODUCTION_MIGRATIONS: readonly Migration[] = [migration001];

/** Highest version defined in a migration set (the schema version it converges to). */
export function targetSchemaVersion(
  migrations: readonly Migration[] = PRODUCTION_MIGRATIONS,
): number {
  return migrations.reduce((max, migration) => Math.max(max, migration.version), 0);
}
