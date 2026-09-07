# Go Phones POS — Update & Release Strategy

## 1. Purpose

This document defines how Go Phones POS is versioned, built, tested, packaged, released, updated, and recovered safely.

The update system must preserve the central product rule:

> Update discovery, download, hosting, and package-verification failures must never prevent the currently installed healthy application from completing local sales. A database that cannot migrate or validate safely must block checkout rather than claim to be healthy.

Go Phones POS is an offline-capable Windows desktop application. Update availability, update hosting, internet connectivity, code-signing infrastructure, or release servers must never become dependencies for normal local checkout.

---

# 2. Core Update Principles

The V1 update system must follow these rules:

1. The currently installed application must remain usable when offline.
2. Failure to check for updates must not block application startup.
3. Failure to download an update must not block sales.
4. Updates must not automatically restart the application during an active checkout.
5. Application binaries and business data must remain separate.
6. Installing a new application version must not replace or delete the SQLite business database.
7. Database schema changes must use versioned migrations.
8. A verified SQLite-consistent backup must be created before every schema migration that modifies an existing initialized database, whether update-driven or otherwise. The one-time creation of a brand-new empty database (`001_initial_schema`) is bootstrap initialization and is exempt, since no prior database state exists to preserve.
9. A failed migration must stop safely.
10. A failed migration must not allow the POS to falsely appear healthy.
11. Existing committed sales must remain intact across updates.
12. Update failures must be diagnosable through logs and support tools.
13. Production releases must be code-signed.
14. Releases must pass required verification before publishing.
15. Update behavior must remain compatible with offline-first operation.

---

# 3. Versioning

Go Phones POS must use semantic versioning:

`MAJOR.MINOR.PATCH`

Examples:

`1.0.0`

`1.0.1`

`1.1.0`

`2.0.0`

---

## PATCH

Used for compatible bug fixes.

Example:

`1.0.0 → 1.0.1`

Possible changes:

- Receipt printing fix
- Report-calculation fix
- Google Sheets retry fix
- UI bug fix
- Logging improvement

---

## MINOR

Used for backward-compatible functionality.

Example:

`1.0.1 → 1.1.0`

Possible changes:

- Thermal-printer configuration
- New diagnostic capability
- Additional report
- New supported data export

---

## MAJOR

Used for significant breaking or architectural product changes.

Example:

`1.9.4 → 2.0.0`

Possible examples:

- Major database redesign
- Multi-location architecture
- Full repair-management system
- Major authentication redesign

A major release must receive additional migration and compatibility review.

---

# 4. Release Identity

Every production build must expose:

- Application version
- Database schema version
- Build identifier where appropriate
- Release date where useful

Example:

```text
Go Phones POS
Version: 1.3.2
Schema: 8
```

This information should be visible under:

`Settings → About`

and available to diagnostic/support reporting.

---

# 5. Git Release Strategy

Production releases must correspond to an immutable source-control reference.

Preferred workflow:

```text
main
↓
verified commit
↓
version bump
↓
tag
↓
release
```

Example tag:

`v1.2.3`

The released application must be reproducible from the corresponding repository state.

---

# 6. Release Pipeline

A production release follows this distribution architecture:

`Private source repository → CI-built/tested Windows release → code-signed build → independent generic HTTPS update feed → installed Go Phones POS clients`

A production release should conceptually follow:

```text
Source
↓
Install dependencies
↓
Lint
↓
TypeScript checks
↓
Unit tests
↓
Database integration tests
↓
Application integration tests
↓
Build
↓
Package Windows application
↓
Code signing
↓
Generate update artifacts
↓
Release verification
↓
Publish
```

Release publishing should not occur if production-blocking tests fail.

The source repository remains private. The update feed is hosted independently from source control through generic HTTPS/static hosting; S3-compatible storage or an equivalent provider may be selected later without changing the client contract. Production clients must not access GitHub or CI, hold repository/API/signing credentials, run shell commands or migrations, download builds manually during normal operation, or administer the update service.

---

# 7. Release Blocking Conditions

A production release must not be published if there is a known failure involving:

- Sale duplication
- Sale loss
- Incorrect inventory mutation
- Transaction atomicity
- Receipt-number duplication
- Database migration failure
- Offline checkout
- Database corruption
- Backup/restore failure affecting migration safety
- Serious authentication/security failure
- Update process capable of destroying business data

P0/P1 failures defined by `TEST_PLAN.md` remain release blockers.

---

# 8. Windows Packaging

Go Phones POS must be distributed as an installable Windows desktop application.

Example artifact:

`GoPhonesPOS-Setup-1.2.3.exe`

The production installer must not require:

- Node.js
- npm
- Git
- VS Code
- Development server

Application packaging must preserve business-data separation.

---

# 9. Code Signing

Production Windows releases must be digitally signed.

Goals:

- Establish publisher identity
- Improve Windows trust
- Reduce unnecessary security warnings
- Protect release authenticity

Signing credentials must be protected and never committed to source control.

CI must treat signing material as sensitive secrets.

---

# 10. Application Data Separation

Application binaries and business data must be treated as separate lifecycles.

Conceptually:

```text
APPLICATION
replaceable during update

BUSINESS DATA
persistent across update
```

The SQLite database must live in an appropriate application-data directory.

It must not live inside:

- Source repository
- Build output directory
- Temporary directory
- Application installation directory that may be replaced during update

---

# 11. Update Discovery

When internet connectivity is available, the application may check whether a newer approved release exists.

Update checks may occur:

- At startup
- Periodically while the app is open
- When the user selects `Check for Updates`

Failure must be non-blocking.

Example:

```text
Could not check for updates.
You can continue using Go Phones POS normally.
```

The application should avoid repeatedly alarming the cashier about temporary update-server failures.

---

# 12. Offline Update Behavior

When internet is unavailable:

- Application launches normally.
- Login remains available.
- Checkout remains available.
- Products remain available.
- Inventory remains available.
- Printing remains available.
- Reports remain available.
- Existing installed version continues running.

The update check simply waits until connectivity returns.

An outdated application must not automatically lock the POS.

---

# 13. Background Download

When a newer approved version is discovered while online, the update automatically begins downloading in the background — download is not merely optional once an approved update is found; only whether/when the application *checks* for one (startup, periodic, manual) is flexible.

Checkout must remain responsive.

Update download must not hold:

- Database write locks
- Checkout transaction locks
- Inventory locks
- Maintenance locks

longer than technically required.

Update download failures are secondary failures.

---

# 14. Update Ready State

When the update has downloaded successfully, the UI may display:

```text
Update Ready

Go Phones POS 1.2.4 is ready to install.

[Restart & Update]
[Later]
```

The cashier must be allowed to choose `Later`.

---

# 15. Active Checkout Protection

The application must not restart for an update while:

- A checkout is active
- A sale transaction is in flight
- Critical database work is occurring
- A migration is already executing
- A restore operation is executing
- Another exclusive database maintenance action is executing

If an update becomes ready during checkout:

```text
Update ready
↓
checkout continues
↓
sale completes or cart is cancelled
↓
restart becomes available
```

---

# 16. Maintenance State

The application must expose an internal concept of maintenance safety.

Possible states:

```text
SAFE_TO_RESTART
CHECKOUT_ACTIVE
TRANSACTION_IN_FLIGHT
MIGRATION_IN_PROGRESS
RESTORE_IN_PROGRESS
```

A maintenance action requiring restart must not proceed while the application is in an unsafe state.

The same coordinator must prevent schema migration or database restore from starting while checkout is active or a sale transaction is in flight. New checkout must remain unavailable while migration or restore owns the exclusive database lifecycle.

---

# 17. Restart & Update Workflow

Expected workflow:

1. Update has downloaded.
2. User selects `Restart & Update`.
3. Application checks maintenance safety.
4. If checkout is active, restart is deferred.
5. Application completes/finishes safe shutdown work.
6. Application exits.
7. Update installs.
8. New version launches.
9. Database schema is inspected.
10. Required migration procedure begins if necessary.
11. POS opens only after database initialization succeeds.

---

# 18. Database Schema Versions

Application version and database schema version are separate concepts.

Example:

```text
App version: 1.2.4
Database schema: 7
```

A new application may require schema:

```text
8
```

The application must detect this at startup.

---

# 19. Migration Files

SQLite schema changes must use versioned migrations.

Example:

```text
001_initial_schema.sql
002_add_export_jobs.sql
003_add_audit_events.sql
004_add_void_fields.sql
```

Applied migrations must be recorded in `schema_migrations`.

Applied migrations must not automatically rerun.

---

# 20. Pre-Migration Backup

Before applying any schema migration **to an existing initialized database**:

1. Determine whether schema migration is required.
2. Create a SQLite-consistent database backup.
3. Verify backup creation succeeded.
4. Record backup metadata.
5. Only then begin migration.

Verification confirms at minimum that the backup file exists, is readable as SQLite, and represents the expected source schema. A mere file-copy success signal is insufficient.

This flow applies only when an initialized database already exists. The first-run creation of a brand-new empty database (`001_initial_schema`) is bootstrap initialization: steps 2–4 are skipped, because there is no prior authoritative state to back up and the backup-evidence tables do not yet exist. Step 5 still runs (`001_initial_schema` is applied).

If backup creation fails:

> Migration must not proceed automatically.

The application should present a clear maintenance error.

---

# 21. Pre-Migration Backup Naming

Example:

```text
backups/
gophones-pre-migration-v1.3.0-schema8-2026-09-06.sqlite
```

The exact naming format may change, but the backup must remain identifiable.

---

# 22. Migration Execution

Conceptual migration startup:

```text
Open database
↓
Determine current schema
↓
Determine required schema
↓
Migration required?
   ↓ yes
Create verified backup
↓
Begin migration sequence
↓
Run unapplied migrations in order
↓
Record applied versions
↓
Validate resulting schema
↓
Continue startup
```

---

# 23. Migration Failure

If migration fails:

- Stop the migration process.
- Do not pretend the database is healthy.
- Do not enter normal checkout mode.
- Record structured diagnostic logs.
- Preserve the pre-migration backup.
- Provide support/export-diagnostics capability where possible.
- Avoid automatically retrying a destructive migration indefinitely.

Example user-facing message:

```text
Go Phones POS could not safely update the local database.

Sales cannot be processed until this issue is resolved.

Your pre-update database backup has been preserved.
```

---

# 24. Migration Idempotence

The system must know which migrations have already succeeded.

A migration that completed successfully must not be blindly run again during every startup.

Migration identifiers must be stable.

---

# 25. Migration Testing

Every schema-changing release must include:

- Fresh-install schema test
- Upgrade from previous production schema
- Upgrade with realistic sales data
- Upgrade with customers
- Upgrade with inventory
- Upgrade with pending Google exports
- Upgrade with historical receipts
- Backup-before-migration verification
- Migration failure simulation where practical

Fresh-database testing alone is insufficient.

---

# 26. Post-Migration Validation

After migrations succeed, application initialization must verify critical state before opening the POS.

Examples:

- Expected schema version reached
- Database opens normally
- Foreign keys enabled
- Required tables exist
- Critical constraints available
- Existing key records readable

---

# 27. Business Data Preservation

Updates must preserve:

- Products
- Inventory
- Customers
- Sales
- Sale items
- Payments
- Receipt numbers
- Inventory movements
- Audit records
- Google Sheets export queue
- Settings
- Backup metadata where applicable
- Checkout idempotency records

---

# 28. Pending Work Across Updates

Pending operations must survive an update when appropriate.

Example:

```text
Sale GP-000184
Google export = PENDING
```

Application updates.

After restart:

```text
GP-000184
Google export still = PENDING
```

The new version may later retry it.

---

# 29. Update Failure Isolation

Update-system failures must not become transaction-system failures.

Examples:

```text
Update server unavailable
→ POS continues

Update download failed
→ POS continues

No internet
→ POS continues

Code-sign validation or package failure before installation
→ existing installed version remains in use
```

---

# 30. Bad Release Recovery

No update system can guarantee a release will never contain a defect.

V1 release recovery should therefore support:

- Pre-migration backups
- Clear version identification
- Structured diagnostics
- Rapid corrective releases
- Safe migration failure behavior
- Ability to determine which client version is installed
- Ability to determine schema version
- Preservation of business data

If an approved release is found defective, publishing stops and its feed entry is withdrawn or superseded so additional clients do not install it. A rapid, higher-version, code-signed corrective release is the normal recovery path. A client that has not installed the release continues on its current version. A client that has installed it preserves business data and uses diagnostics and its verified pre-migration backup for controlled recovery when schema repair is required. Automatic binary or schema downgrade is not assumed safe.

A future enhancement may add more sophisticated binary rollback.

---

# 31. Downgrade Caution

Application downgrade may be dangerous when a newer version has already migrated the database.

Example:

```text
App 1.3.0
Schema 8
```

Downgrading to:

```text
App 1.2.0
expects Schema 7
```

may not be safe.

Therefore manual downgrade must not be treated as a normal recovery method unless database compatibility is explicitly verified.

---

# 32. Release Channels

V1 does not require complex release channels.

Preferred initial model:

```text
Production
```

During development, internal/pre-release builds may exist.

Future channels might include:

- Internal
- Pilot
- Stable

Only add them if operationally necessary.

---

# 33. Client Pilot

Major releases should be piloted before broad adoption where practical.

Pilot verifies:

- Installation
- Database migration
- Offline operation
- Scanner
- Printer
- Clover operational workflow
- Google Sheets export
- Reports
- Diagnostics
- Update behavior

---

# 34. Update User Interface

Recommended Settings area:

```text
Settings → About & Updates

Version: 1.2.3
Database Schema: 7

Automatic Update Checks: On

Last Check:
Today 3:42 PM

[Check for Updates]
```

Possible statuses:

```text
You're up to date.
```

```text
Downloading version 1.2.4...
```

```text
Version 1.2.4 ready.
[Restart & Update]
```

---

# 35. Update Logging

Relevant structured events may include:

```text
update.check.started
update.check.no_update
update.available
update.download.started
update.download.completed
update.download.failed
update.install.requested
update.install.deferred.checkout_active
update.install.started
update.install.completed
migration.required
migration.backup.completed
migration.started
migration.completed
migration.failed
```

Sensitive update credentials must never be logged.

---

# 36. Release Audit Information

A released build should retain enough metadata to diagnose where it came from.

Useful metadata may include:

- Semantic version
- Build ID
- Source commit
- Build timestamp
- Database schema target

This information may be included in diagnostics.

---

# 37. Update Tests

Required testing includes:

- Check succeeds while online
- Check failure while offline
- Offline app remains usable
- Update downloads while app remains usable
- Active checkout blocks restart
- Update can be deferred
- Successful update preserves business data
- Pending exports survive update
- Receipt numbering survives update
- Database migration succeeds
- Pre-migration backup succeeds
- Migration does not begin if backup fails
- Failed migration prevents unsafe normal startup
- Logs contain migration evidence
- Secrets absent from update logs
- Clean Windows update installation path works

---

# 38. Production Release Checklist

Before publishing a release:

1. Version updated.
2. Repository state clean.
3. Required tests pass.
4. Database migrations reviewed.
5. Migration upgrade tests pass.
6. Offline regression passes.
7. Backup/restore regression passes.
8. Update-path test passes.
9. Installer builds successfully.
10. Code signing succeeds.
11. No production secrets embedded in client bundle.
12. Release notes prepared.
13. Build metadata recorded.
14. Release artifact verified.
15. Release published only after required checks pass.

---

# 39. Release Notes

Each release should have concise notes.

Example:

```text
Go Phones POS 1.2.4

Fixed
- Receipt reprint failure on certain printers.
- Google Sheets retry duplication edge case.

Improved
- Added clearer printer diagnostics.

Database
- No schema changes.
```

For schema-changing releases:

```text
Database
- Schema 7 → 8.
- Automatic pre-migration backup created before upgrade.
```

---

# 40. Update Security

The update system must protect against untrusted releases.

Requirements include:

- Trusted release source
- HTTPS or equivalent secure transport
- Code-signed Windows packages
- Protected CI/release credentials
- No arbitrary update URL controlled through unsafe renderer input
- No execution of unverified arbitrary files

The client must actively reject, rather than merely fail to prefer, the following before installing anything:

- A feed response that is tampered with or fails integrity/signature verification.
- A package signed by a certificate that does not match the expected publisher identity.
- A corrupted or partially downloaded package (verified via checksum/signature before installation begins).
- A signed package whose version would downgrade the installed schema-incompatible application without following the documented recovery procedure (Section 31).

A rotated signing certificate is expected over the product's lifetime; the update client must be able to trust a newly rotated, still-legitimate publisher certificate through its normal chain-of-trust verification without requiring a client-side code change for every rotation, while still rejecting a certificate that does not chain to a trusted publisher identity.

---

# 41. Update Hosting

The exact production update-hosting provider may be selected during implementation.

The architecture must support a trusted static or release-hosting source that can provide:

- Version metadata
- Windows update package
- Required update artifacts

The feed and artifacts must be available through generic HTTPS independently of the private source repository. Installed clients must not need a GitHub token or source-repository access.

The product must not depend on the repository being public.

---

# 42. No Forced Update Lockout

V1 must not implement:

```text
New version exists
↓
Current POS disabled
```

unless a future exceptional business/security requirement explicitly introduces it.

A temporarily outdated POS should remain capable of local sales.

---

# 43. Critical Update Messaging

For serious reliability/security releases, the UI may emphasize importance.

Example:

```text
Important Update Available

Version 1.2.5 includes a transaction reliability fix.

[Restart & Update]
[Later]
```

But an active checkout still must not be interrupted.

---

# 44. Future Update Capabilities

Future versions may consider:

- Multiple release channels
- Central fleet management
- Remote version dashboard
- Automatic scheduled installation
- Binary rollback
- Managed-device deployment

These are not V1 requirements.

---

# 45. Update Definition of Success

The update architecture is successful when this scenario works:

```text
Store running v1.0.0
↓
Internet available
↓
v1.1.0 discovered
↓
Update downloads
↓
Cashier continues selling
↓
Update becomes ready
↓
Cashier finishes checkout
↓
Selects Restart & Update
↓
Application restarts
↓
Schema upgrade required
↓
Verified database backup created
↓
Migration succeeds
↓
v1.1.0 opens
↓
Products remain
Customers remain
Sales remain
Inventory remains correct
Pending Google exports remain
Receipts remain reprintable
```

If the internet is unavailable during the same period:

```text
POS remains on v1.0.0
↓
Sales continue normally
```

That is the intended V1 update behavior.
