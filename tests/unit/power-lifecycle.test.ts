import { describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import {
  evaluateResumeSafety,
  installPowerLifecycleHandlers,
} from '../../src/main/diagnostics/powerLifecycle';
import type { PowerMonitorLike } from '../../src/main/diagnostics/powerLifecycle';
import { createCapturingLogger, createMigratedDb } from '../helpers/database';

function fakePowerMonitor(): {
  readonly powerMonitor: PowerMonitorLike;
  emit(event: 'suspend' | 'resume'): void;
} {
  const listeners = new Map<'suspend' | 'resume', () => void>();
  return {
    powerMonitor: {
      on(event, listener) {
        listeners.set(event, listener);
      },
    },
    emit(event) {
      listeners.get(event)?.();
    },
  };
}

describe('evaluateResumeSafety (pure)', () => {
  it('reports the database open and schema valid for a healthy migrated database', async () => {
    const db = await createMigratedDb();
    expect(evaluateResumeSafety(db, 'SAFE')).toEqual({
      databaseOpen: true,
      schemaValid: true,
      maintenanceState: 'SAFE',
    });
  });

  it('reports the database closed when there is no connection', () => {
    expect(evaluateResumeSafety(null, 'SAFE')).toEqual({
      databaseOpen: false,
      schemaValid: false,
      maintenanceState: 'SAFE',
    });
  });

  it('reports the database closed when the connection has been closed', async () => {
    const db = await createMigratedDb();
    db.close();
    expect(evaluateResumeSafety(db, 'SAFE')).toEqual({
      databaseOpen: false,
      schemaValid: false,
      maintenanceState: 'SAFE',
    });
  });

  it('passes an exclusive maintenance state through unchanged', async () => {
    const db = await createMigratedDb();
    expect(evaluateResumeSafety(db, 'RESTORE_IN_PROGRESS').maintenanceState).toBe(
      'RESTORE_IN_PROGRESS',
    );
  });
});

describe('installPowerLifecycleHandlers (suspend/resume — Phase 2M-E2A)', () => {
  it('records a safe suspend event with no heavy work', () => {
    const { powerMonitor, emit } = fakePowerMonitor();
    const capture = createCapturingLogger();
    installPowerLifecycleHandlers(powerMonitor, {
      logger: capture.logger,
      getDatabase: () => null,
      getMaintenanceState: () => 'SAFE',
    });

    emit('suspend');

    expect(capture.records).toEqual([
      { level: 'info', category: 'application', event: 'system.suspend', fields: undefined },
    ]);
  });

  it('records resume and a post-resume safety check through the existing trusted seam', async () => {
    const db = await createMigratedDb();
    const { powerMonitor, emit } = fakePowerMonitor();
    const capture = createCapturingLogger();
    const onResumeSafetyCheck = vi.fn();

    installPowerLifecycleHandlers(powerMonitor, {
      logger: capture.logger,
      getDatabase: () => db,
      getMaintenanceState: () => 'SAFE',
      onResumeSafetyCheck,
    });

    emit('resume');

    expect(capture.records.map((record) => record.event)).toEqual([
      'system.resume',
      'system.resume-safety-check',
    ]);
    const safetyRecord = capture.records[1];
    expect(safetyRecord?.fields).toEqual({
      databaseOpen: true,
      schemaValid: true,
      maintenanceState: 'SAFE',
    });
    expect(onResumeSafetyCheck).toHaveBeenCalledWith({
      databaseOpen: true,
      schemaValid: true,
      maintenanceState: 'SAFE',
    });
  });

  it('reports (without overriding) an active exclusive maintenance state on resume', async () => {
    const { powerMonitor, emit } = fakePowerMonitor();
    const capture = createCapturingLogger();
    const onResumeSafetyCheck = vi.fn();
    const getMaintenanceState = vi.fn(() => 'RESTORE_IN_PROGRESS' as const);

    installPowerLifecycleHandlers(powerMonitor, {
      logger: capture.logger,
      getDatabase: () => null,
      getMaintenanceState,
      onResumeSafetyCheck,
    });

    emit('resume');

    // The handler only ever READS maintenance state — it has no mutation
    // method available to it, so a RESTORE/MIGRATION owner's exclusive claim
    // is structurally impossible for resume to bypass or clear.
    expect(onResumeSafetyCheck).toHaveBeenCalledWith(
      expect.objectContaining({ maintenanceState: 'RESTORE_IN_PROGRESS' }),
    );
  });

  it('never inspects or reports printer/Google/network state on resume', async () => {
    const db = await createMigratedDb();
    const { powerMonitor, emit } = fakePowerMonitor();
    const capture = createCapturingLogger();

    installPowerLifecycleHandlers(powerMonitor, {
      logger: capture.logger,
      getDatabase: () => db,
      getMaintenanceState: () => 'SAFE',
    });

    emit('resume');

    const safetyRecord = capture.records.find(
      (record) => record.event === 'system.resume-safety-check',
    );
    expect(Object.keys(safetyRecord?.fields ?? {})).toEqual([
      'databaseOpen',
      'schemaValid',
      'maintenanceState',
    ]);
  });

  it('reuses the existing export-recovery hook only, and rebaselines the clock watcher, without touching crash evidence', async () => {
    const db = await createMigratedDb();
    const { powerMonitor, emit } = fakePowerMonitor();
    const capture = createCapturingLogger();
    const onResumeExportRecovery = vi.fn();
    const onResumeClockRebaseline = vi.fn();

    installPowerLifecycleHandlers(powerMonitor, {
      logger: capture.logger,
      getDatabase: () => db,
      getMaintenanceState: () => 'SAFE',
      onResumeExportRecovery,
      onResumeClockRebaseline,
    });

    emit('resume');

    expect(onResumeExportRecovery).toHaveBeenCalledTimes(1);
    expect(onResumeClockRebaseline).toHaveBeenCalledTimes(1);
    // No crash/termination-shaped event is ever produced by suspend/resume.
    expect(capture.records.map((record) => record.event)).toEqual([
      'system.resume',
      'system.resume-safety-check',
    ]);
  });

  it('records suspend and resume without ever calling a database method (no parallel database ownership)', () => {
    const openSpy = vi.fn();
    const fakeDb = { open: true, close: openSpy } as unknown as Database.Database;
    const { powerMonitor, emit } = fakePowerMonitor();
    const capture = createCapturingLogger();

    installPowerLifecycleHandlers(powerMonitor, {
      logger: capture.logger,
      getDatabase: () => fakeDb,
      getMaintenanceState: () => 'SAFE',
    });

    emit('suspend');
    emit('resume');

    expect(openSpy).not.toHaveBeenCalled();
  });
});
