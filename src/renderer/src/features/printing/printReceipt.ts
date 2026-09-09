import type { IpcResult } from '../../../../shared/products';
import type { PrintReceiptResult } from '../../../../shared/printing';

/**
 * Pure, React-free helpers for the deliberate "Print Receipt" / "Reprint
 * Receipt" flow (`POS_WORKFLOWS.md §40`-`§41`, `§63`; `ARCHITECTURE.md §19`;
 * `task §13`-`§15`). No jsdom in this repo, so the state machine and its
 * messages are unit-tested here directly.
 *
 * A print is a secondary operation on an ALREADY-COMMITTED sale: the renderer
 * calls `window.pos.printing.printReceipt(saleId)` with only the immutable Sale
 * ID, and a failure here is NEVER a sale failure — the copy must keep saying so.
 * A retry re-runs the print for the SAME Sale ID; it never re-sends a checkout.
 */

export type PrintPhase = 'idle' | 'printing' | 'printed' | 'failed';

export interface PrintState {
  readonly phase: PrintPhase;
  /** Present only in `failed`. */
  readonly error: string | null;
  /** Present only in `printed`. */
  readonly result: PrintReceiptResult | null;
}

export const IDLE_PRINT: PrintState = { phase: 'idle', error: null, result: null };

export function printingState(): PrintState {
  return { phase: 'printing', error: null, result: null };
}

export function printedState(result: PrintReceiptResult): PrintState {
  return { phase: 'printed', error: null, result };
}

export function failedState(error: string): PrintState {
  return { phase: 'failed', error, result: null };
}

/** The reassurance line shown alongside a print failure — the sale is fine. */
export const PRINT_FAILURE_HEADLINE = 'The sale is saved. The receipt could not be printed.';

/** Short positive confirmation for a completed print. */
export function describePrintSuccess(result: PrintReceiptResult): string {
  const where = result.deviceName.trim() === '' ? 'the selected printer' : result.deviceName;
  return `Receipt ${result.receiptNumber} sent to ${where}.`;
}

/**
 * Run one print attempt. Resolves to the next {@link PrintState}; never throws.
 * `invoke` is `window.pos.printing.printReceipt` (injected so this is testable).
 */
export async function runPrint(
  invoke: (saleId: string) => Promise<IpcResult<PrintReceiptResult>>,
  saleId: string,
): Promise<PrintState> {
  try {
    const result = await invoke(saleId);
    return result.ok ? printedState(result.data) : failedState(result.error.message);
  } catch (error) {
    return failedState(error instanceof Error ? error.message : String(error));
  }
}
