import { describe, expect, it } from 'vitest';
import {
  describePrintSuccess,
  failedState,
  IDLE_PRINT,
  PRINT_FAILURE_HEADLINE,
  runPrint,
} from '../../src/renderer/src/features/printing/printReceipt';
import type { PrintReceiptResult } from '../../src/shared/printing';
import type { IpcResult } from '../../src/shared/products';

/**
 * Phase 2I — the deliberate Print / Reprint state machine (`task §13`-`§15`).
 * No jsdom: the module is the exact gate the components run, so exercising it
 * exercises that path.
 */

const okResult: PrintReceiptResult = {
  saleId: 's1',
  receiptNumber: 'GP-000123',
  deviceName: 'Brother_QL_820NWB',
  voided: false,
  acceptedAt: '2026-09-08T18:00:00.000Z',
};

function ok(): Promise<IpcResult<PrintReceiptResult>> {
  return Promise.resolve({ ok: true, data: okResult });
}
function fail(code: string, message: string): Promise<IpcResult<PrintReceiptResult>> {
  return Promise.resolve({ ok: false, error: { code: code as never, message } });
}

describe('runPrint', () => {
  it('idle → printed on success, carrying the result', async () => {
    const state = await runPrint(ok, 's1');
    expect(state.phase).toBe('printed');
    expect(state.result).toEqual(okResult);
    expect(state.error).toBeNull();
  });

  it('maps a typed failure to the failed phase with the trusted message', async () => {
    const state = await runPrint(
      () => fail('PRINTER_UNAVAILABLE', 'The selected receipt printer is not available.'),
      's1',
    );
    expect(state.phase).toBe('failed');
    expect(state.error).toMatch(/not available/);
    expect(state.result).toBeNull();
  });

  it('never throws — a rejected invoke becomes a failed state', async () => {
    const state = await runPrint(() => Promise.reject(new Error('boom')), 's1');
    expect(state.phase).toBe('failed');
    expect(state.error).toBe('boom');
  });

  it('a retry uses the same Sale ID passed in (no checkout re-send concept here)', async () => {
    const seen: string[] = [];
    const invoke = (id: string) => {
      seen.push(id);
      return fail('PRINT_FAILED', 'nope');
    };
    await runPrint(invoke, 's1');
    await runPrint(invoke, 's1');
    expect(seen).toEqual(['s1', 's1']);
  });
});

describe('copy', () => {
  it('the failure headline never implies the sale failed', () => {
    expect(PRINT_FAILURE_HEADLINE.toLowerCase()).toContain('the sale is saved');
    expect(PRINT_FAILURE_HEADLINE.toLowerCase()).not.toContain('sale failed');
  });

  it('describePrintSuccess names the receipt and the printer', () => {
    expect(describePrintSuccess(okResult)).toBe('Receipt GP-000123 sent to Brother_QL_820NWB.');
  });

  it('IDLE_PRINT / failedState shapes', () => {
    expect(IDLE_PRINT).toEqual({ phase: 'idle', error: null, result: null });
    expect(failedState('x')).toEqual({ phase: 'failed', error: 'x', result: null });
  });
});
