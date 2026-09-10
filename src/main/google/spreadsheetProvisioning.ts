import {
  GOOGLE_SALES_SHEET,
  GOOGLE_SALE_ITEMS_SHEET,
  GOOGLE_SPREADSHEET_NAME,
} from '../../shared/google';
import { SALES_HEADER, SALE_ITEMS_HEADER } from './exportSerialization';
import type { DriveTransport } from './driveTransport';
import { GoogleApiError, scrubExternalText } from './googleRedaction';
import type { SheetsStructureTransport } from './sheetsStructureTransport';

/**
 * The LOCKED V1 spreadsheet provisioning mechanism (`ARCHITECTURE.md §27.5.1`;
 * `REQ-GSHEET-017`; `POS_WORKFLOWS.md §71`; `TEST-GSHEET-039`, `-040`, `-047`,
 * `-048`, `-049`).
 *
 *  - The durable provisioning token is generated/persisted by the caller BEFORE
 *    this runs and is passed in unchanged on every retry.
 *  - Lookup (`files.list` by marker + token) happens BEFORE any create.
 *  - Creation is ONE Drive `files.create` carrying name + Sheets MIME +
 *    `appProperties` (marker + token) together. Sheets `spreadsheets.create` and
 *    "create then tag with files.update" are never used.
 *  - An ambiguous create response never recreates — it re-runs the lookup.
 *  - More than one match ⇒ STOP in a safe not-ready state (no delete, no guess).
 *  - Worksheet convergence via the Sheets API is idempotent and re-inspects
 *    after an ambiguous mutation instead of blindly re-adding.
 */

export type ProvisioningOutcome =
  | { readonly outcome: 'ready'; readonly spreadsheetId: string }
  | { readonly outcome: 'incomplete'; readonly reason: string };

export interface ProvisionSpreadsheetDeps {
  readonly drive: DriveTransport;
  readonly makeStructureTransport: (spreadsheetId: string) => SheetsStructureTransport;
  readonly provisioningToken: string;
  readonly spreadsheetName?: string;
  /**
   * `true` (default) — an owner-initiated run (`Connect`, `Retry Setup`) that
   * MAY issue the single tagged `files.create` on a zero-match lookup.
   * `false` — bounded automatic startup recovery: lookup only. A zero-match
   * result returns `incomplete` and NEVER creates or mutates a worksheet
   * (`ARCHITECTURE.md §27.5.1` "Startup recovery boundary"; `TEST-GSHEET-052`).
   */
  readonly allowCreate?: boolean;
  /**
   * Called once, immediately BEFORE the Drive `files.create` request is sent, so
   * the caller can persist the durable "create attempted" marker while a crash
   * afterward still leaves restart-recovery evidence. Never called when a match
   * is adopted or when `allowCreate` is `false`.
   */
  readonly onCreateAttempt?: () => void | Promise<void>;
  readonly logger?: {
    info: (event: string, fields?: Record<string, unknown>) => void;
    warn: (event: string, fields?: Record<string, unknown>) => void;
  };
}

const CANONICAL = [
  { title: GOOGLE_SALES_SHEET, header: SALES_HEADER },
  { title: GOOGLE_SALE_ITEMS_SHEET, header: SALE_ITEMS_HEADER },
] as const;

function reason(detail: string): string {
  return scrubExternalText(detail).slice(0, 300);
}

function headersEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export async function provisionSpreadsheet(
  deps: ProvisionSpreadsheetDeps,
): Promise<ProvisioningOutcome> {
  const { drive, provisioningToken, logger } = deps;
  const name = deps.spreadsheetName ?? GOOGLE_SPREADSHEET_NAME;
  const allowCreate = deps.allowCreate ?? true;

  // ── Step 1-3: lookup BEFORE create ────────────────────────────────────────
  let matches: string[];
  try {
    matches = await drive.findProvisionedSpreadsheets(provisioningToken);
  } catch (error) {
    return { outcome: 'incomplete', reason: reason(describe(error, 'could not search Drive')) };
  }
  if (matches.length > 1) {
    logger?.warn('google.spreadsheet.multiple_matches', { count: matches.length });
    return {
      outcome: 'incomplete',
      reason:
        'More than one Go Phones POS spreadsheet was found. Setup stopped so nothing is changed.',
    };
  }

  let spreadsheetId: string;
  if (matches.length === 1) {
    spreadsheetId = matches[0]!;
    logger?.info('google.spreadsheet.adopted_existing');
  } else if (!allowCreate) {
    // ── Bounded startup recovery: lookup returned zero → NEVER create ───────
    logger?.info('google.spreadsheet.recovery_lookup_no_match');
    return {
      outcome: 'incomplete',
      reason: 'Google Sheets setup is not finished. Use Retry Setup to finish connecting.',
    };
  } else {
    // ── Step 4: single tagged files.create ─────────────────────────────────
    try {
      await deps.onCreateAttempt?.();
      spreadsheetId = await drive.createProvisionedSpreadsheet({ name, provisioningToken });
      logger?.info('google.spreadsheet.provisioned');
    } catch (error) {
      // ── Step 5: ambiguous create ⇒ re-run the lookup, never recreate ──────
      if (error instanceof GoogleApiError && error.unknownOutcome) {
        logger?.warn('google.spreadsheet.create_ambiguous');
        let recheck: string[];
        try {
          recheck = await drive.findProvisionedSpreadsheets(provisioningToken);
        } catch (lookupError) {
          return {
            outcome: 'incomplete',
            reason: reason(describe(lookupError, 'setup could not be verified')),
          };
        }
        if (recheck.length > 1) {
          return {
            outcome: 'incomplete',
            reason:
              'More than one Go Phones POS spreadsheet was found. Setup stopped so nothing is changed.',
          };
        }
        if (recheck.length === 1) {
          spreadsheetId = recheck[0]!;
          logger?.info('google.spreadsheet.adopted_existing', { after: 'ambiguous_create' });
        } else {
          return {
            outcome: 'incomplete',
            reason:
              'The sales spreadsheet may have been created but could not be confirmed yet. Try Retry Setup.',
          };
        }
      } else {
        return {
          outcome: 'incomplete',
          reason: reason(describe(error, 'the sales spreadsheet could not be created')),
        };
      }
    }
  }

  // ── Worksheet convergence (idempotent) ────────────────────────────────────
  const structure = deps.makeStructureTransport(spreadsheetId);
  try {
    await convergeWorksheets(structure);
  } catch (error) {
    return {
      outcome: 'incomplete',
      reason: reason(describe(error, 'the spreadsheet worksheets could not be set up')),
    };
  }

  // ── Final verification ────────────────────────────────────────────────────
  let worksheets;
  try {
    worksheets = await structure.listWorksheets();
  } catch (error) {
    return {
      outcome: 'incomplete',
      reason: reason(describe(error, 'the spreadsheet could not be verified')),
    };
  }
  for (const canonical of CANONICAL) {
    const found = worksheets.filter((w) => w.title === canonical.title);
    if (found.length !== 1) {
      return {
        outcome: 'incomplete',
        reason: `The "${canonical.title}" worksheet is not set up correctly.`,
      };
    }
    let header: string[];
    try {
      header = await structure.readHeaderRow(canonical.title);
    } catch (error) {
      return {
        outcome: 'incomplete',
        reason: reason(describe(error, 'the spreadsheet headers could not be verified')),
      };
    }
    if (!headersEqual(header, canonical.header)) {
      return {
        outcome: 'incomplete',
        reason: `The "${canonical.title}" worksheet header could not be verified.`,
      };
    }
  }

  return { outcome: 'ready', spreadsheetId };
}

async function convergeWorksheets(structure: SheetsStructureTransport): Promise<void> {
  for (const canonical of CANONICAL) {
    let worksheets = await structure.listWorksheets();
    let existing = worksheets.filter((w) => w.title === canonical.title);

    if (existing.length === 0) {
      const canonicalTitles = new Set<string>(CANONICAL.map((c) => c.title));
      const nonCanonical = worksheets.filter((w) => !canonicalTitles.has(w.title));
      if (worksheets.length === 1 && nonCanonical.length === 1) {
        // A freshly created (or empty adopted) spreadsheet: rename its lone
        // default tab into this canonical role rather than accumulating junk.
        await structure.renameWorksheet(nonCanonical[0]!.sheetId, canonical.title);
      } else {
        await structure.addWorksheet(canonical.title);
      }
      // Re-inspect after the mutation — never blindly repeat.
      worksheets = await structure.listWorksheets();
      existing = worksheets.filter((w) => w.title === canonical.title);
    }

    if (existing.length !== 1) {
      throw new Error(`worksheet "${canonical.title}" did not converge to exactly one tab`);
    }

    const header = await structure.readHeaderRow(canonical.title);
    if (!headersEqual(header, canonical.header)) {
      await structure.writeHeaderRow(canonical.title, canonical.header);
    }
  }
}

function describe(error: unknown, fallback: string): string {
  if (error instanceof GoogleApiError) {
    return error.message || fallback;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}
