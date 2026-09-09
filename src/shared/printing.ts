/**
 * Shared Printing contract (Phase 2I — Physical Printing & Receipt Reprint).
 *
 * Pure TypeScript types, dependency-free, so the identical shapes bundle into
 * the main process, the sandboxed preload, and the renderer. These are the ONLY
 * printing shapes that cross the IPC boundary.
 *
 * Printing is a secondary, post-commit, read-only operation
 * (`ARCHITECTURE.md §17`-`§19`, `POS_WORKFLOWS.md §40`, `REQ-REC-005`): a print
 * or reprint NEVER creates or mutates a sale, payment, inventory, movement,
 * checkout request, export job, receipt number, or void status. The renderer
 * supplies at most an immutable Sale ID; the printable receipt is rebuilt in the
 * trusted process from stored transaction-time snapshots via the existing
 * `ReceiptService` (`§3`), never from a renderer-supplied object.
 */

/**
 * A Windows printer as exposed to the renderer — deliberately narrow. Never a
 * raw Electron `PrinterInfo` object.
 */
export interface PrinterDevice {
  /**
   * The device identity the OS/print API requires (Electron `PrinterInfo.name`,
   * e.g. `Brother_QL_820NWB`) — NOT the friendly display name when they differ.
   * This is exactly what is persisted as `settings.selected_printer` and passed
   * back to the print call.
   */
  readonly deviceName: string;
  /** Human-facing label (Electron `PrinterInfo.displayName`). */
  readonly displayName: string;
  /** Whether Windows reports this as the system default printer. */
  readonly isDefault: boolean;
  /**
   * Coarse platform-reported status when Electron makes it available, else
   * `null`. `0` conventionally means "idle/ready" on Windows. Advisory only —
   * the app never claims hardware certainty the OS spooler does not provide
   * (`task §16`).
   */
  readonly status: number | null;
}

/** The locally-persisted receipt-printer selection (`DATA_MODEL.md §19`-`§20`). */
export interface PrinterConfig {
  /**
   * `settings.selected_printer`, or `null` when the store user has not chosen a
   * printer yet. `null` is a clear, non-error state — it never invalidates a
   * completed sale (`REQ-PRINT-005`, `task §12`).
   */
  readonly selectedDeviceName: string | null;
  /**
   * The selected device's friendly label if it is still present in the current
   * enumeration, else `null` (selected but currently not found).
   */
  readonly selectedDisplayName: string | null;
  /** Whether `selectedDeviceName` appears in the current printer enumeration. */
  readonly selectedIsAvailable: boolean;
}

/** `printing:select-printer` payload — only a device name, re-validated in the trusted layer. */
export interface SelectPrinterInput {
  readonly deviceName: string;
}

/**
 * A successful print/reprint. Represents "the job was accepted at the
 * Electron/Windows print-API boundary" — NOT proof that paper physically
 * emerged (`task §16`). Purely informational; nothing is persisted.
 */
export interface PrintReceiptResult {
  readonly saleId: string;
  readonly receiptNumber: string;
  /** The device the job was submitted to. */
  readonly deviceName: string;
  /** `true` when the printed sale is `VOIDED` (the document shows a VOIDED banner). */
  readonly voided: boolean;
  /** ISO-8601 UTC instant the OS spooler accepted the job. */
  readonly acceptedAt: string;
}
