# Packaged Update Migration Safety E2E (Phase 2N-E3)

Run the Windows-only, real, schema-migrating update round trip with:

```powershell
npm run test:update:e2e:migration
```

This proves the real, existing pre-migration-backup-gated, transactional
migration runner (`src/main/database/migrationRunner.ts`) behaves safely
through a genuine installed-A → installed-B NSIS update, across three
isolated scenarios. It never introduces a real production schema change,
never adds a retry policy, and never adds automatic restore/rollback — those
remain outside V1's recovery model (`docs/UPDATE_RELEASE_STRATEGY.md`).

## A test-only schema-2 fixture, never in production

`src/main/database/migrations/002_e2e_schema_probe.ts` (a harmless
`e2e_schema2_probe` table) and `002_e2e_schema_probe_failing.ts` (creates a
table, then deliberately throws `PHASE_2N_E3_DELIBERATE_MIGRATION_FAILURE`
inside the same transaction the real migration runner always wraps `run()`
in) are never members of `PRODUCTION_MIGRATIONS`
(`database/migrations/index.ts`, still exactly `[migration001]`, schema 1).

`database/migrations/e3MigrationConfig.ts` is the one build-time migration-
SET authority. `resolveActiveMigrations()` branches directly on the
compile-time literal `__E3_MIGRATION_MODE__` (baked by `electron.vite.config.ts`
from `GO_PHONES_E3_MIGRATION_MODE`, read only at build time, never at
runtime) — an ordinary build compiles that literal to `null`, and
`resolveActiveMigrations()` returns exactly `PRODUCTION_MIGRATIONS`,
unconditionally. `src/main/index.ts` calls this ONE function everywhere a
migration set is needed (main database open, restore-service reopen/target,
build-identity's embedded `schemaVersion`), so an E3 build can never migrate
to schema 2 while some other trusted component still expects schema 1.
`scripts/verify-packaging.mjs` scans the packaged production bundle to
confirm the deliberate-failure marker is absent (bundler dead-code
elimination removes the whole gated branch — confirmed empirically by
building with and without the env var and grepping the bundle both ways).

## Reused, not reinvented

Install/uninstall, the distinct E2E app/package identity, isolated
`LOCALAPPDATA`, the guarded compile-time-baked business-data profile, the
loopback HTTPS feed, and the real trusted `restartAndInstall()` path are all
exactly Phase 2N-E2's proven machinery (`update-install-e2e-lib.mjs`). E3
adds only what's genuinely new in `update-migration-e2e-lib.mjs`: the E3
build-env layering, pre-migration backup discovery/independent verification,
a deterministic backup-gate obstruction, and a migration-aware evidence
comparator. The existing compile-time E2E trigger
(`updateInstallE2eTrigger.ts`) needed no changes — the same
`CHECKOUT_ACTIVE` → clear → `restartAndInstall()` sequence E2 already proved
works unchanged for a migrating update.

Each scenario builds its OWN A + B pair against its OWN isolated profile —
the embedded profile is baked in at build time, so artifacts cannot be
shared across scenarios that need their own isolated database (an early
version of this harness built once and reused artifacts across scenarios,
which silently pointed every installed app at one build-time profile while
the harness kept checking a different, never-written-to path).

## Deterministic backup-gate failure, zero production changes

The real backup writer (`backup/backupSnapshot.ts`'s `createSqliteSnapshot`)
does `mkdirSync(dirname(destPath), { recursive: true })` before writing. The
backup-failure scenario pre-creates a plain FILE at the exact
`<profile>/backups/pre-migration` path before triggering the update — pure
filesystem setup in the isolated E3 profile, no product-code failure
injection, no compile-time-only failure seam.

## Scenarios

**A — success.** Install A (schema 1), seed a deterministic business
fixture, discover and install real B (schema 2) through the real updater.
Prove: the verified `PRE_MIGRATION` backup completes strictly before
migration 2 completes; the backup, opened independently afterward, is schema
1 only, contains no schema-2 probe, and matches the pre-update fixture
exactly; schema reaches 2 with exactly one migration-2 row; all business
data survives (receipt sequence, pending export job, settings, audit trail);
one additional clean restart of B never re-runs the migration and never
creates a second backup.

**B — apply failure.** Install A, seed the fixture, install a build whose
migration 2 deliberately fails mid-transaction. Prove: the backup still
succeeds and is preserved; the migration transaction genuinely rolls back
(no stray probe table, no `schema_migrations` advance); the app reports
`databaseReady: false`; business data is untouched; one controlled restart
of the failed build is observed to retry migration (and backup) again on
every startup — current architecture has no retry-limit policy, and this
harness does not add one, only reports the fact.

**C — backup failure.** Install A, seed the fixture, obstruct the backup
directory, then attempt to install a schema-changing B. Prove: the backup
gate fails with a normalized error code; migration 2 never starts; schema
stays at 1; business data is untouched; the app reports `databaseReady: false`.

None of the negative scenarios auto-restore, auto-downgrade, or otherwise
touch the preserved backup — V1's recovery model stays a controlled,
support-driven decision.

## Evidence and qualification

The command prints the source revision, all three test-only versions
(`0.1.100` → `0.1.102` / `0.1.103`), the real backup/migration ordering and
row evidence for each scenario, and:

```text
FUNCTIONAL PACKAGED MIGRATION SAFETY E2E VERIFIED
PRODUCTION AUTHENTICODE NOT VERIFIED LOCALLY
```

Unsigned local artifacts prove the migration-safety mechanism only.
Production release signing remains governed by the release pipeline and is
not weakened or claimed by this E2E. Cleanup uninstalls each scenario's
E2E-identity install via its own generated uninstaller — polling until the
install directory actually disappears, since an NSIS uninstaller reporting
exit 0 does not guarantee its own deferred self-delete has finished yet —
and removes only paths under that scenario's dedicated
`%TEMP%\gpp-update-install-e2e-*` run root, matching E1/E2's cleanup
discipline exactly.
