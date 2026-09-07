import Database from 'better-sqlite3';
import type { EffectivePragmas } from './types';

/**
 * The fixed V1 SQLite durability policy (`DATA_MODEL.md §54`, `REQ-DB-007`).
 *
 * Values are the *effective* runtime values `PRAGMA` reports back, not the
 * statement text: `synchronous` reports `2` for `FULL`, `foreign_keys` reports
 * `1` for `ON`.
 */
export const REQUIRED_PRAGMAS: EffectivePragmas = {
  foreign_keys: 1,
  journal_mode: 'wal',
  synchronous: 2, // 0=OFF, 1=NORMAL, 2=FULL, 3=EXTRA
  busy_timeout: 5000,
};

export class PragmaVerificationError extends Error {
  override readonly name = 'PragmaVerificationError';
  constructor(
    message: string,
    readonly expected: EffectivePragmas,
    readonly actual: EffectivePragmas,
  ) {
    super(message);
  }
}

/** Read the four durability pragmas back from a live connection. */
export function readEffectivePragmas(db: Database.Database): EffectivePragmas {
  return {
    foreign_keys: Number(db.pragma('foreign_keys', { simple: true })),
    journal_mode: String(db.pragma('journal_mode', { simple: true })).toLowerCase(),
    synchronous: Number(db.pragma('synchronous', { simple: true })),
    busy_timeout: Number(db.pragma('busy_timeout', { simple: true })),
  };
}

/** Throw {@link PragmaVerificationError} unless every effective pragma matches {@link REQUIRED_PRAGMAS}. */
export function assertRequiredPragmas(db: Database.Database): void {
  const actual = readEffectivePragmas(db);
  const mismatches = (Object.keys(REQUIRED_PRAGMAS) as (keyof EffectivePragmas)[]).filter(
    (key) => actual[key] !== REQUIRED_PRAGMAS[key],
  );
  if (mismatches.length > 0) {
    throw new PragmaVerificationError(
      `SQLite durability configuration not applied: ${mismatches.join(', ')}`,
      REQUIRED_PRAGMAS,
      actual,
    );
  }
}

/**
 * Open a connection and apply + verify the V1 durability policy.
 *
 * `PRAGMA foreign_keys` and `PRAGMA journal_mode` must be issued outside any
 * transaction, which is the case here (nothing else has touched the connection).
 * `:memory:` cannot host a WAL journal, so this function is for real database
 * files only; constraint-only tests open `:memory:` directly with
 * `foreign_keys = ON`.
 */
export function openConfiguredConnection(filename: string): Database.Database {
  const db = new Database(filename);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = FULL');
    db.pragma('busy_timeout = 5000');
    assertRequiredPragmas(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
