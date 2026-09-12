# Go Phones POS — Support & Diagnostics

## 1. Purpose

This document defines the V1 supportability, diagnostic, logging, health-monitoring, crash-evidence, and bug-reporting architecture for Go Phones POS.

The goal is:

> When the client reports a problem, the application should provide enough safe diagnostic evidence to understand what happened without relying entirely on memory or screenshots.

Diagnostics must never expose sensitive credentials or unnecessary customer/payment data.

---

# 2. Supportability Principle

Go Phones POS must distinguish between:

## Critical Local Failures

Failures that may compromise safe transaction processing.

Examples:

- SQLite database cannot open.
- Sale cannot commit.
- Database migration failed.
- A required migration cannot begin because its pre-migration backup cannot be verified.
- Database state is unsafe.
- Critical storage failure prevents durable writes.

These may block checkout.

---

## Secondary / External Failures

Failures that do not invalidate local transaction integrity.

Examples:

- Printer unavailable.
- Google Sheets unavailable.
- Internet unavailable.
- Update server unavailable.
- Routine backup attempt failed while the operational database remains healthy and no migration is required.
- A Card checkout's local commit failed after Clover approval was confirmed (`DATA_MODEL.md` Section 31A) — the local database itself may still be perfectly healthy; the failed *attempt* did not corrupt or invalidate anything, but the incident must remain visible until reconciled.

These must not invalidate an already committed sale.

---

# 3. Support & Diagnostics Screen

V1 must provide a built-in diagnostic area.

Recommended location:

`Settings → Support & Diagnostics`

Possible display:

```text
Go Phones POS Diagnostics

Application Version:   1.2.3
Database Schema:       7
Database Health:       Healthy
Internet:              Online
Printer:               Unavailable
Google Sheets:         Connected
Pending Exports:       3
Failed Exports:        0
Last Backup:           Today 2:00 AM (Local Disk)
Disk Space:            148 GB available
Unresolved Card Charges: 0

[Report a Problem]
[Run Diagnostics]
[Export Support Bundle]
[View Activity Log]
[View Reconciliation Queue]
```

"Unresolved Card Charges" counts `checkout_requests` rows with `status = COMMIT_FAILED` and `payment_method_snapshot = CARD` that have not yet been marked resolved (`DATA_MODEL.md` Sections 31A–31B). A non-zero count is a visible warning, not a critical failure, since the local database itself is healthy — but it must never be hidden among ordinary diagnostics, since it represents a possible customer charge with no matching local sale. A Cash `COMMIT_FAILED` row is never counted here: for Cash, `COMMIT_FAILED` is terminal/retry evidence for a local checkout attempt (`DATA_MODEL.md` Section 33), not a possible external charge.

---

# 4. Diagnostic Information

The diagnostics system must report appropriate information such as:

- Application version
- Build identifier where available
- Database schema version
- Windows version
- Electron/runtime version where useful
- Database health
- Database path category without unnecessarily exposing private filesystem detail
- Free disk space
- Configured printer status where detectable
- Internet connectivity state
- Google Sheets integration enabled/disabled
- Google Sheets queue counts
- Last successful Google export
- Last successful local recovery backup and local overdue state
- Separate off-device protection state and sanitized attention reason
- Migration state
- Update state
- Installation identifier
- Count of unresolved Card local-commit-failure reconciliation entries

---

# 5. Installation Identifier

Each installation must have a locally generated non-personal installation ID.

Example:

`INST-7F2A91C4`

Purpose:

- Correlate support reports from the same installation
- Distinguish store installation from test installations
- Help diagnose repeated problems

The ID must not encode:

- Customer name
- Phone number
- Address
- Hardware serial numbers unnecessarily
- Sensitive device identity

---

# 6. Structured Logging

Application logging must use a centralized structured logging layer.

Do not rely on scattered `console.log()` statements for production diagnostics.

Conceptual API:

```text
logger.debug()
logger.info()
logger.warn()
logger.error()
logger.fatal()
```

---

# 7. Log Levels

## DEBUG

Detailed development/diagnostic information.

Normally reduced or selectively enabled in production.

---

## INFO

Normal important lifecycle events.

Examples:

- Application started
- Database opened
- Migration completed
- Sale completed
- Backup completed
- Google export completed
- Update installed

---

## WARN

Recoverable or degraded conditions.

Examples:

- Internet unavailable
- Printer unavailable
- Google export delayed
- Backup overdue
- Low disk space
- Significant clock change detected

---

## ERROR

Failed operations requiring attention but not necessarily complete shutdown.

Examples:

- Receipt print failure
- Google authentication failure
- Backup failure
- Support bundle generation failure
- Update download failure

---

## FATAL

Application cannot safely perform critical operation.

Examples:

- Database cannot open
- Database migration leaves application unusable
- Critical persistence initialization failure
- Local transaction system unavailable

---

# 8. Log Categories

Structured events must use consistent categories.

Recommended V1 categories:

```text
application
authentication
checkout
sales
inventory
database
migration
printing
google
backup
update
diagnostics
audit
export
```

---

# 9. Structured Event Naming

Prefer stable event names.

Examples:

```text
application.started
database.opened
database.open.failed
checkout.submitted
checkout.completed
checkout.failed
sale.voided
inventory.adjusted
printing.failed
google.export.pending
google.export.completed
google.export.failed
backup.completed
backup.failed
update.available
migration.started
migration.failed
```

---

# 10. Correlation IDs

Important workflows should carry stable identifiers.

Examples:

```text
checkoutRequestId
saleId
receiptNumber
exportJobId
supportReportId
```

Example:

```text
checkoutRequestId=CHK-83ac...
saleId=8f293...
receiptNumber=GP-000184
```

This allows support staff to reconstruct a transaction lifecycle.

---

# 11. Example Transaction Trace

Friendly lifecycle:

```text
Checkout submitted
↓
Sale committed
↓
Inventory changed
↓
Receipt generated
↓
Printer failed
↓
Google export queued
↓
Internet restored
↓
Google export completed
```

Technical events may correlate on the same Sale ID.

---

# 12. Friendly Activity Log

The application must expose a simplified human-readable activity and error history.

Example:

```text
4:31 PM
Sale GP-000184 completed successfully.

4:31 PM
Receipt could not be printed.
The configured printer appears unavailable.

4:32 PM
Google Sheets export is waiting for internet connectivity.

4:38 PM
Internet connection restored.

4:38 PM
Sale GP-000184 exported to Google Sheets.
```

The friendly log must avoid technical noise.

---

# 13. Technical Logs

Technical logs may include:

- Timestamp
- Level
- Category
- Event name
- Correlation IDs
- Error code
- Duration
- Sanitized context

Example:

```text
2026-09-06T20:31:24.481Z
INFO
checkout
checkout.completed
saleId=8f293
receiptNumber=GP-000184
durationMs=74
```

---

# 14. Sensitive Data Policy

Logs must never contain:

- Shared login password
- Password hashes unless absolutely necessary for debugging, which should generally be avoided
- Google access tokens
- Google refresh tokens
- OAuth authorization codes, PKCE verifiers (`code_verifier`), ID tokens, and raw OAuth token responses
- The developer OAuth client configuration
- API private keys
- OAuth secrets
- Card numbers
- CVV
- Magnetic-stripe data
- Clover payment credentials
- Raw authorization headers
- Complete database dumps
- Unnecessary customer personal data

---

# 15. Customer Data in Logs

Prefer:

```text
customerAttached=true
customerId=<internal-id>
```

Avoid:

```text
customerPhone=2818241234
```

If a phone number is ever required for a specific diagnostic reason, it should be masked.

Example:

`***-***-1234`

The default production logging model should avoid customer phone numbers.

---

# 16. Credential Redaction

The logging system must apply centralized redaction.

Sensitive patterns and fields must be removed before being written to disk.

Examples:

```text
Authorization
access_token
refresh_token
authorization code
code_verifier
id_token
password
client_secret
private_key
```

The system must not rely solely on individual developers remembering to sanitize every log statement.

---

# 17. Log Rotation

Logs must not grow indefinitely.

V1 must implement bounded retention.

Possible strategies:

- Size-based rotation
- Daily rotation
- Retain last N files
- Retain last N days

V1 default: size-based rotation at 10 MB per file, retaining the last 10 rotated files, with a 30-day retention ceiling (`ARCHITECTURE.md` Section 49A). This default is configurable but must not be left unspecified, since indefinite log growth is itself a low-disk risk.

The design must ensure logs cannot consume the entire disk over time.

---

# 18. Log Storage

Logs must be stored in an appropriate application-data/log directory.

They must not be stored:

- In source control
- In installation binaries
- In arbitrary customer document directories

The application must locate relevant logs automatically when generating a support bundle.

---

# 19. Report a Problem

The application must provide:

`Report a Problem`

Suggested form:

```text
What happened?

[________________________________]
[________________________________]

What were you doing?

○ Making a sale
○ Printing
○ Inventory
○ Google Sheets
○ Starting the application
○ Updating
○ Other

Receipt number if applicable:
[GP-________]

☑ Include diagnostic information
☑ Include recent sanitized logs

[Create Support Report]
```

---

# 20. Problem Report Metadata

A support report may include:

- Report ID
- User-written description
- Selected problem category
- Receipt number if provided
- Application version
- Database schema
- Installation ID
- Diagnostic summary
- Recent sanitized logs
- Timestamp

---

# 21. Offline Problem Reporting

Problem-report creation must not require internet connectivity.

If offline:

```text
Support report created locally.
```

The user may later:

- Export it as a support bundle
- Send it when internet becomes available
- Manually provide it to support

Automatic remote submission may be added only when a secure support destination is defined.

---

# 22. Support Bundle

The application must provide:

`Export Support Bundle`

Possible output:

```text
GoPhonesPOS-Support-2026-09-06.zip
```

---

# 23. Support Bundle Contents

A sanitized bundle may contain:

```text
support-info.json
diagnostics.json
recent-app.log
recent-errors.log
migration-history.json
backup-status.json
export-queue-summary.json
```

It must not automatically contain the full SQLite database.

---

# 24. Support Information Example

Example:

```text
Application Version: 1.2.3
Database Schema: 7
Windows Version: Windows 11
Installation ID: INST-7F2A91C4

Database Health: Healthy
Pending Google Exports: 3
Failed Google Exports: 0
Last Backup: 2026-09-06T06:00:00Z
Printer Configured: Yes
Printer Reachable: No
Disk Space: 148 GB
```

---

# 25. Support Bundle Privacy

Before support-bundle generation:

- Secrets must be redacted.
- Customer PII should be minimized.
- Payment data must be excluded.
- OAuth tokens must be excluded — refresh tokens, access tokens, authorization codes, PKCE verifiers, ID tokens, raw token responses, and the developer OAuth client configuration.
- The encrypted Google credential wrapper file must not be included.
- Database credentials/secrets must be excluded.
- Raw card information must never be collected.

Supportability must not become a privacy/security vulnerability.

---

# 26. Run Diagnostics

The application must provide a manual diagnostic check.

Possible checks:

```text
Database open
Database schema
Foreign keys enabled
Database write capability where safe
Disk-space status
Backup recency
Google configuration state
Google queue backlog
Printer status where detectable
Update state
```

Diagnostics must not mutate sales or inventory.

---

# 27. Database Health Checks

At minimum, V1 diagnostics should identify:

- Database can be opened
- Expected schema is present
- Required migration state is valid
- Foreign-key enforcement enabled
- Critical tables available

More expensive integrity checking may be run manually or periodically rather than continuously.

---

# 28. Storage Health

The application must monitor available disk space.

Possible status:

```text
Healthy
Warning
Critical
```

Example:

```text
⚠ Low disk space

Only 1.4 GB remains.
Backups or future database writes may fail.
```

V1 default thresholds (`ARCHITECTURE.md` Section 49A): `WARNING` below 2 GB free, `CRITICAL` below 500 MB free. These are configurable but must not be left undefined, since low-disk behavior is otherwise nondeterministic.

---

# 29. Backup Health

Diagnostics must expose:

- Last successful local-disk recovery backup time, last local failure, and whether local backup is overdue
- Separate off-device protection state: not configured, healthy, or needs attention
- When off-device needs attention, a safe reason distinguishing never succeeded, unavailable, stale, last copy failed, and verification failed
- Whether the configured destination is positively verified now; a historical success must not imply protection after a device swap, disconnect, or failed re-verification

Example:

```text
Backup Status:
Warning

No successful backup has occurred in 7 days.
```

V1 default cadence/retention (`ARCHITECTURE.md` Section 49A): automatic backups run daily at 03:00 local business time; automatic backups are retained 14 days and manual backups 90 days.

Off-device automatic/manual copies use fixed V1 retention of 14/90 days. Off-device failures remain warnings/secondary failures while the local database and local recovery backup remain healthy. User wording should say **Off-device backup not set up**, **Protected with an external/network backup**, or **External/network backup needs attention**. It must not expose PowerShell, disk numbers, bus types, command output, raw paths, WAL details, or other filesystem internals.

---

# 30. Google Sheets Health

Possible diagnostics:

- Integration enabled
- Google account connected (and which account, by display email)
- Setup state: disconnected / connected but setup incomplete / ready to sync
- Setup-incomplete reason (sanitized) when applicable — e.g. the configured
  spreadsheet needs attention
- Authentication valid (refresh token usable) or needs re-authorization —
  reflecting the **current active OAuth credential generation**, not a
  historical export-job error from a superseded generation
- Last successful export
- Pending count
- Failed count
- Oldest pending export age

A not-connected, setup-incomplete, or re-authorization-needed state is a
secondary warning only and never implies local sales failed. A definite
structural failure of the configured spreadsheet (deleted, or access lost)
moves the integration to `connected but setup incomplete` with a sanitized
reason; it does not disconnect the account and does not block local sales
(`ARCHITECTURE.md §27.5.2`, `REQ-GSHEET-020`).

Example:

```text
Google Sheets
Warning

23 transactions are waiting to export.
Local sales data remains safe.
```

---

# 31. Printer Health

Where practical, diagnostics must expose:

- Configured printer name
- Printer discovered by Windows
- Last successful print
- Last print failure

Printer-health detection may vary depending on Windows drivers.

Printer failure must remain secondary.

---

# 32. Connectivity Health

The application may display:

```text
Online
Offline
```

This state is informational.

It must not decide whether local checkout is permitted.

---

# 33. Clock-Change Awareness

The application must detect and log significant suspicious clock changes where practical.

Example event:

```text
clock.change.detected
previousObservedTime=...
currentObservedTime=...
difference=...
```

User-facing warning may be appropriate for extreme changes.

V1 default: a clock change exceeding 5 minutes relative to expected elapsed time between checks is treated as significant (`ARCHITECTURE.md` Section 49A). Ordering of audit events does not depend on the wall clock regardless — each event also carries a monotonically increasing local `sequence` value (`DATA_MODEL.md` Section 36A) unaffected by clock changes.

The app must not automatically block sales solely because the clock changed unless future requirements define such behavior.

---

# 34. Single-Instance Diagnostics

If the user launches Go Phones POS while it is already running:

- Existing instance must be focused/restored.
- A second independent instance must not start.

Optional log event:

```text
application.second_instance_detected
```

---

# 35. Sleep / Resume Diagnostics

The application must handle Windows sleep/resume.

Useful events:

```text
system.suspend
system.resume
```

After resume, the application may:

- Re-evaluate connectivity
- Resume export queue
- Re-check printer state where appropriate
- Continue normal local operation

Before accepting new checkout after resume, the application must confirm that the database is open, the schema remains valid, and no exclusive maintenance state is active. Network, printer, and update warnings remain secondary.

---

## 35.1 Abrupt Termination and Restart

After an application crash, abrupt termination or power loss, or Windows restart, SQLite recovery must yield a complete committed transaction or no transaction. On launch the application validates database/schema health, recovers stale Google export work idempotently, evaluates backup and disk health, and preserves crash evidence. Checkout is blocked only when local persistence cannot be trusted.

---

# 36. Crash Evidence

The system must collect useful crash evidence for:

- Main-process crash
- Renderer crash
- Child-process failure where relevant
- Unexpected application termination signals where detectable

Crash handling must preserve privacy.

---

# 37. Crash Metadata

Useful crash metadata may include:

- App version
- Schema version
- Process type
- Windows version
- Timestamp
- Installation ID
- Relevant non-sensitive event IDs

Avoid attaching complete memory dumps automatically to remote support unless privacy/security has been explicitly reviewed.

---

# 38. Local Crash Collection

V1 stores privacy-safe crash information locally so it survives restart and can be included in a support bundle.

This allows the user to later include relevant sanitized crash evidence in a support bundle.

Automatic centralized crash upload is optional and may be introduced later.

---

# 39. Remote Error Monitoring

Future versions may optionally integrate a centralized error-monitoring platform.

Potential benefits:

- Automatic error aggregation
- Version-based regression detection
- Crash-rate monitoring
- Stack-trace aggregation

This is not required to block V1.

If introduced, customer privacy and secret redaction must be reviewed first.

---

# 40. Audit Trail vs Diagnostic Logs

These are different systems.

## Audit Trail

Durable business/system history.

Examples:

- Sale completed
- Sale voided
- Inventory adjusted
- Tax setting changed

Audit information may be retained long-term.

---

## Diagnostic Log

Operational troubleshooting detail.

Examples:

- Printer timeout
- Export API retry
- Migration duration
- Renderer crash

Logs may rotate and expire.

Do not treat rotating logs as the authoritative audit trail.

---

# 41. Audit Events

The append-only local audit trail must record durable events such as:

```text
SALE_COMPLETED
SALE_VOIDED
PRICE_OVERRIDE
INVENTORY_ADJUSTED
TAX_SETTING_CHANGED
BUSINESS_SETTING_CHANGED
GOOGLE_CONFIGURATION_CHANGED
BACKUP_COMPLETED
BACKUP_FAILED
MIGRATION_COMPLETED
MIGRATION_STARTED
MIGRATION_FAILED
UPDATE_INSTALLED
CARD_LOCAL_COMMIT_FAILURE
AUTH_CREDENTIAL_CHANGED
```

Exact persistence is defined in `DATA_MODEL.md`.

Audit events identify event type, timestamp, installation/shared-user context where available, affected entity and ID where applicable, correlation ID, and a minimal non-secret detail payload. Events coupled to a business mutation are committed in the same SQLite transaction as that mutation. Backup, migration, and update lifecycle events are recorded as soon as the database is safely writable. If a database-open or migration failure makes the audit store unavailable, rotating structured diagnostics preserve the failure evidence; diagnostics do not become a substitute for a successful durable audit write.

---

# 42. Error Codes

Important failures must use stable error codes.

Examples:

```text
DB_OPEN_FAILED
SALE_COMMIT_FAILED
CARD_LOCAL_COMMIT_FAILURE
CLOVER_DECLINED
PRINTER_UNAVAILABLE
GOOGLE_AUTH_FAILED
GOOGLE_EXPORT_FAILED
BACKUP_FAILED
MIGRATION_FAILED
UPDATE_DOWNLOAD_FAILED
UPDATE_VERIFICATION_FAILED
DISK_SPACE_LOW
RESTORE_VALIDATION_FAILED
DB_PATH_UNSUPPORTED_FILESYSTEM
```

These help support identify categories without reading raw stack traces.

## Phase 2 checkout-request failure codes

When a Phase 2 sale attempt rolls back, the same code is stored as `checkout_requests.failure_code` (`DATA_MODEL.md` Sections 31, 33) and surfaced to the renderer:

```text
SALE_COMMIT_FAILED       unexpected or storage-level local commit failure — no sale recorded
CHECKOUT_DRIFT           reviewed values no longer match authoritative state — re-review required
INSUFFICIENT_STOCK       cart quantity now exceeds available stock — re-review required
PRODUCT_ARCHIVED         a cart product was archived since review — re-review required
TAX_RATE_NOT_CONFIGURED  no tax rate is configured — fix in Settings, then re-review
BUSINESS_NOT_CONFIGURED  store identity is incomplete — fix in Settings, then re-review
```

`SALE_COMMIT_FAILED` is the only code that means "something went wrong with the local write"; the retry path for it is to try the same request again once the underlying problem clears (`DATA_MODEL.md` Section 34). Every other code is a *trusted revalidation* reason — the local database is healthy, the reviewed checkout is simply no longer valid, and the cashier must Review again (a fresh review carries a new `request_id`). These codes reuse the application's existing error-code spellings; no new synonyms are introduced.

Whether a `COMMIT_FAILED` row is a **reconciliation incident** is determined by payment method and the Card workflow (`DATA_MODEL.md` Sections 31A–31B), never by the mere existence of the row. A Cash `COMMIT_FAILED` row is terminal/retry evidence for a local attempt and is not a reconciliation case.

---

# 43. User-Facing Errors

User messages should be clear and actionable.

Avoid:

```text
UnhandledPromiseRejection...
SQLITE_BUSY...
TypeError...
```

Prefer:

```text
Sale could not be completed because the local database could not be updated safely.

No sale was recorded.

Error code: SALE_COMMIT_FAILED
```

For secondary failure:

```text
Sale completed successfully.

Receipt could not be printed.

Error code: PRINTER_UNAVAILABLE

[Retry Print]
```

---

# 44. Technical Error Preservation

Friendly messages must not destroy useful developer detail.

The technical log may preserve:

- Internal exception type
- Stack trace
- Error code
- Operation
- Correlation ID
- Sanitized context

while the user sees a simplified explanation.

---

# 45. Critical Health State

If the local database cannot be trusted:

```text
CRITICAL

Go Phones POS cannot safely access the local sales database.

Do not complete new transactions.

[Run Diagnostics]
[Export Support Bundle]
```

A local integrity failure should be clearly distinguishable from an external outage.

---

# 46. Secondary Warning State

Example:

```text
Google Sheets synchronization delayed.

17 sales are safely stored locally and waiting to export.
```

The wording should reinforce that the local transaction is safe.

---

# 47. Support Bundle Generation Failure

If support-bundle generation itself fails:

- Record diagnostic event where possible.
- Provide clear user feedback.
- Do not affect POS sales.

---

# 48. Logging Performance

Logging must not materially slow checkout.

Avoid:

- Synchronous heavy disk operations on the UI thread
- Logging entire database objects
- Logging huge API payloads
- Excessive per-keystroke logging

---

# 49. Database Query Logging

Production logs should not indiscriminately record every SQL statement.

Target high-value events instead.

Detailed SQL logging may be temporarily enabled for diagnostic/development modes if needed.

---

# 50. Network Diagnostic Mode

Normal operation should not persist excessive low-level network traffic logs.

A temporary advanced diagnostic mode may be introduced for:

- Google Sheets connectivity issues
- Update connectivity issues

It should be:

- Explicitly enabled
- Time-limited where practical
- Clearly labeled
- Protected from secret leakage

---

# 51. Migration Diagnostics

Database migrations must be thoroughly logged.

Example:

```text
migration.required
fromSchema=7
toSchema=8

migration.backup.completed

migration.started
migrationId=008

migration.completed
durationMs=182
```

Failure:

```text
migration.failed
migrationId=008
errorCode=...
```

---

# 52. Backup Diagnostics

Useful events:

```text
backup.started
backup.completed
backup.failed
backup.retention.cleanup
backup.off_device.verification
restore.started
restore.completed
restore.failed
```

---

# 53. Update Diagnostics

Useful events:

```text
update.check.started
update.available
update.download.started
update.download.completed
update.install.deferred
update.install.started
update.install.completed
update.failed
```

---

# 54. Google Export and Connection Diagnostics

Useful export events:

```text
google.export.queued
google.export.started
google.export.completed
google.export.retry_scheduled
google.export.failed
```

Useful connection/setup events:

```text
google.oauth.authorization_started
google.oauth.authorization_succeeded
google.oauth.authorization_failed
google.account.disconnected
google.spreadsheet.provisioned
google.spreadsheet.adopted_existing
google.spreadsheet.setup_failed
```

Use Sale ID / export job ID for export events and the display account email (not
by default) or a non-secret reason code for connection events.

Do not log OAuth tokens, authorization codes, PKCE verifiers, ID tokens, the raw
OAuth token response, the developer OAuth client configuration, or full
sensitive request payloads.

---

# 55. Checkout Diagnostics

Useful events:

```text
checkout.started
checkout.submitted
checkout.validation_failed
checkout.commit.started
checkout.completed
checkout.rollback
checkout.duplicate_request_detected
```

Never log card/payment secrets.

---

# 56. Support Report Workflow

Expected:

```text
User encounters issue
↓
Report a Problem
↓
Describe issue
↓
Optionally identify receipt
↓
Run diagnostics
↓
Gather recent sanitized logs
↓
Generate support report
↓
Export locally or send later
```

---

# 57. Diagnostic Retention

Diagnostic files must have defined retention.

Possible categories:

```text
Current application logs
Rotated logs
Crash evidence
Support bundles explicitly generated by user
```

V1 crash evidence retention is bounded to the 20 most recent records with a
30-day age ceiling. Corrupt or unreadable records are skipped safely and never
prevent application startup or support-bundle creation.

Support bundles should not be deleted automatically without a defined retention decision if the user explicitly generated them.

---

# 58. Proactive Warnings

V1 must support warnings for conditions that may become operational problems.

Examples:

- Backup overdue
- Low disk space
- Large Google export backlog
- Printer unavailable
- Migration/update problem

Warnings should avoid unnecessary alarm fatigue.

---

# 59. Proactive Monitoring Limit

Go Phones POS does not need enterprise observability infrastructure in V1.

Avoid unnecessary:

- Distributed tracing systems
- External log clusters
- Complex monitoring agents
- Always-online observability dependencies

Local structured diagnostics are sufficient for V1.

---

# 60. Support Security

The Support & Diagnostics feature itself must obey least privilege.

Renderer must not receive unrestricted access to:

- Arbitrary files
- Database file
- Credential store
- OS secrets

Support-bundle generation must occur through controlled trusted application services.

---

# 61. Support Service Architecture

Suggested services:

```text
LoggingService
DiagnosticsService
HealthCheckService
SupportBundleService
CrashEvidenceService
AuditService
```

These should remain internal application capabilities rather than independent network services.

---

# 62. Health State Model

Possible high-level states:

```text
HEALTHY
WARNING
CRITICAL
```

Examples:

## HEALTHY

```text
Database: Healthy
Backup: Current
Disk: Healthy
```

## WARNING

```text
Google queue delayed
Printer unavailable
Backup overdue
Disk low
```

## CRITICAL

```text
Database cannot open
Migration failed
Persistence unavailable
```

---

# 63. System Status Summary

A compact UI may show:

```text
System Status

Database       ✓
Backup         ✓
Google Sheets  ⚠ 3 pending
Printer        ⚠ unavailable
Disk Space     ✓
Updates        ✓
```

---

# 64. Support Tests

Required tests include:

- Structured logs written
- Log categories correct
- Log levels correct
- Correlation IDs preserved
- Secrets redacted
- Customer PII minimized
- Log rotation works
- Support bundle generated
- Support bundle excludes secrets
- Support bundle contains app/schema metadata
- Health checks report correct status
- Printer warning does not block sales
- Google warning does not block sales
- Low disk warning works
- Critical database failure blocks unsafe checkout
- Offline problem report creation works
- Crash evidence survives restart where applicable
- Single-instance event works
- Sleep/resume does not corrupt state
- Clock-change event logs appropriately
- Migration diagnostics recorded
- Backup diagnostics recorded
- Update diagnostics recorded
- Card local-commit-failure incident visible as an unresolved reconciliation count and durable audit event
- Backup health correctly distinguishes local-disk from off-device backups
- Audit event ordering survives a significant clock change via monotonic `sequence`

---

# 65. Support Acceptance Scenario

Representative scenario:

```text
Sale GP-000184 commits successfully
↓
Printer fails
↓
Google Sheets unavailable
↓
Application logs:
sale completed
printer failed
google pending
↓
User opens Support & Diagnostics
↓
Database = Healthy
Printer = Warning
Pending Exports = 1
↓
User creates support bundle
↓
Bundle contains:
version
schema
relevant sanitized logs
printer failure
export queue summary
↓
Bundle contains no password
no Google token
no card data
```

That is successful supportability behavior.

---

# 66. Diagnostics Definition of Success

The diagnostics system is successful when a user can report:

> Something went wrong with sale GP-000184.

and support can determine, using safe evidence:

- Which application version was running
- Which database schema was active
- Whether the local sale committed
- Whether inventory updated
- Whether printing failed
- Whether Google export was pending
- Whether the database was healthy
- Whether the app restarted/crashed
- What relevant sanitized error occurred

without requiring access to passwords, payment credentials, or unnecessary customer information.

---

# 67. Final Support Rule

The primary support principle is:

> Collect enough structured evidence to diagnose failures, but never collect sensitive information merely because it might someday be useful.

Go Phones POS should be easy to troubleshoot without making diagnostics a security or privacy liability.
