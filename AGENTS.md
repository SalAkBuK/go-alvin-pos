# Go Phones POS Agent Guide

Before changing architecture or behavior, read the complete canonical specification in `docs/`:

- `PRODUCT_SCOPE.md` defines V1 boundaries.
- `PRODUCT_REQUIREMENTS.md` defines required behavior.
- `ARCHITECTURE.md` defines technical boundaries.
- `DATA_MODEL.md` defines persistence and transaction rules.
- `POS_WORKFLOWS.md` defines operational behavior.
- `TEST_PLAN.md` defines required verification.
- `UPDATE_RELEASE_STRATEGY.md` defines release and update behavior.
- `SUPPORT_DIAGNOSTICS.md` defines support, logging, health, and diagnostic behavior.

Never change documentation silently to justify an implementation. If implementation conflicts with the canonical specification, surface the contradiction before proceeding. Do not opportunistically implement out-of-scope functionality.

Preserve these invariants:

1. SQLite is the authoritative local operational database, and core sales work without internet.
2. External integrations never sit on the critical sale-commit path.
3. Money uses integer cents.
4. Sale, sale items, payment, inventory changes, inventory movements, required audit events, and durable post-commit work remain transactionally consistent.
5. Completed transaction history is preserved; accidental completed sales may become `VOIDED` with reason, timestamp, and reversing inventory movements, but are never silently deleted.
6. Google Sheets synchronization is one-way from POS to Sheets in V1. Its failure never blocks checkout, and a void updates the same logical exported sale.
7. Printing failure never invalidates a committed sale.
8. Clover processing and any card reversal/refund are manual and separate in V1. Full refunds and returns remain out of scope. If a Clover-approved card charge is followed by a local SQLite commit failure, the application must never fabricate a completed sale or pretend the charge did not happen; it durably records the checkout attempt, payment method, intended total, and cashier-confirmed Clover approval before attempting the commit, and warns the cashier that Clover review/void/refund may be required separately.
9. Application updates never replace business data. Every schema migration that modifies an existing initialized database requires a verified pre-migration backup and stops safely on failure; first-run creation of the database via `001_initial_schema` is bootstrap initialization and is exempt, as no prior state exists to preserve. Automatic binary/schema rollback is never assumed; recovery uses a corrective release or a documented restore procedure.
10. Diagnostics and support bundles never expose secrets, card data, or unnecessary customer data.
11. Restart or exclusive database maintenance must not interrupt an active or in-flight checkout.
12. V1 local backups protect against accidental deletion, application-level corruption, and bad migrations; a same-disk backup is never described as protecting against physical disk/device loss unless an optional off-device backup location is actually configured. A whole-database restore preserves a pre-restore recovery copy and requires explicit confirmation before overwriting data newer than the backup being restored.
