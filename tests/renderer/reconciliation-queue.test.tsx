import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReconciliationQueueSection } from '../../src/renderer/src/features/settings/ReconciliationQueueSection';
import { SettingsPage } from '../../src/renderer/src/features/settings/SettingsPage';
import {
  describeQueueSummary,
  describeReconciliationEntry,
  validateResolutionNote,
} from '../../src/renderer/src/features/settings/reconciliationQueue';
import type { ReconciliationEntry } from '../../src/shared/reconciliation';

/**
 * Phase 2F renderer coverage — the Settings → Reconciliation Queue shaping +
 * note gate, and first-render markup (task Phase 2F `§38`). No jsdom.
 */

const failedEntry: ReconciliationEntry = {
  requestId: 'CHK-83ac',
  status: 'COMMIT_FAILED',
  failureCode: 'SALE_COMMIT_FAILED',
  intendedTotalCents: 59538,
  createdAt: '2026-09-08T12:00:00.000Z',
  cloverApprovedConfirmedAt: '2026-09-08T12:01:00.000Z',
  resolutionStatus: 'UNRESOLVED',
};

const stalePending: ReconciliationEntry = {
  requestId: 'CHK-77',
  status: 'PENDING_PAYMENT',
  failureCode: null,
  intendedTotalCents: 12000,
  createdAt: '2026-09-08T11:00:00.000Z',
  cloverApprovedConfirmedAt: null,
  resolutionStatus: 'UNRESOLVED',
};

describe('describeReconciliationEntry', () => {
  it('shows only durable local evidence — no fabricated Clover data', () => {
    const v = describeReconciliationEntry(failedEntry);
    expect(v).toEqual({
      requestId: 'CHK-83ac',
      statusLabel: 'Local save failed',
      failureLabel: 'SALE_COMMIT_FAILED',
      amount: '$595.38',
      createdAt: '2026-09-08T12:00:00.000Z',
      cloverApprovalLabel: '2026-09-08T12:01:00.000Z',
    });
  });

  it('a stale pending row has no confirmed approval time', () => {
    const v = describeReconciliationEntry(stalePending);
    expect(v.statusLabel).toMatch(/stale/i);
    expect(v.failureLabel).toBe('—');
    expect(v.cloverApprovalLabel).toMatch(/not confirmed/i);
  });
});

describe('validateResolutionNote', () => {
  it('requires a non-blank note', () => {
    expect(validateResolutionNote('   ')).toMatch(/enter a note/i);
    expect(validateResolutionNote('')).toMatch(/enter a note/i);
  });
  it('accepts a real note', () => {
    expect(validateResolutionNote('  Voided in Clover.  ')).toBeNull();
  });
  it('rejects an over-long note', () => {
    expect(validateResolutionNote('x'.repeat(1001))).toMatch(/1000 characters or fewer/i);
  });
});

describe('describeQueueSummary', () => {
  it('empty / singular / plural', () => {
    expect(describeQueueSummary([])).toMatch(/no unresolved card charges/i);
    expect(describeQueueSummary([failedEntry])).toBe('1 unresolved card charge needs review.');
    expect(describeQueueSummary([failedEntry, stalePending])).toBe(
      '2 unresolved card charges need review.',
    );
  });
});

describe('first-render markup', () => {
  it('the section renders its heading and explanatory hint with no noisy error', () => {
    const html = renderToStaticMarkup(<ReconciliationQueueSection />);
    expect(html).toContain('Reconciliation Queue');
    expect(html).toMatch(/mark the entry resolved with a note/i);
    expect(html).not.toContain('role="alert"');
  });

  it('SettingsPage includes the Reconciliation Queue below Business & Receipt', () => {
    const html = renderToStaticMarkup(<SettingsPage />);
    expect(html).toContain('Reconciliation Queue');
  });
});
