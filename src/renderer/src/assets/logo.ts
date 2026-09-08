import logoUrl from './go-alvin-logo.jpeg';

/**
 * The official Go Phones - Alvin store logo, added to the repo by the owner and
 * bundled as a static renderer asset by Vite (Phase 2E.2).
 *
 * This is **store branding**, not transaction-time data: it is not persisted in
 * SQLite, not part of `ReceiptRepresentation`, and not snapshotted onto a sale.
 * Historical receipt preview/reprint therefore renders whatever logo is
 * currently installed — a deliberate V1 convention (`DATA_MODEL.md §44-49`
 * governs *financial/identity* snapshots; a logo is neither).
 */
export const GO_PHONES_LOGO_URL: string = logoUrl;

/** The store's official name — used as the logo's accessible name where no adjacent text already states it. */
export const GO_PHONES_LOGO_ALT = 'Go Phones - Alvin';
