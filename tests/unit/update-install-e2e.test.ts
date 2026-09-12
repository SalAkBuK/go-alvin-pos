import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PRODUCTION_UPDATE_APP_ID,
  PRODUCTION_UPDATE_PRODUCT_NAME,
  UPDATE_INSTALL_E2E_APP_ID,
  UPDATE_INSTALL_E2E_PACKAGE_NAME,
  UPDATE_INSTALL_E2E_PRODUCT_NAME,
  UPDATE_INSTALL_E2E_PROFILE_LEAF,
  UPDATE_INSTALL_E2E_RUN_PREFIX,
  UPDATE_INSTALL_E2E_RUNTIME_ENV,
  assertDistinctUpdateInstallE2eIdentity,
  isGuardedUpdateInstallE2eProfile,
  updateInstallE2eRuntimeAllowed,
  validateUpdateInstallE2eBuildConfig,
} from '../../src/main/updater/updateInstallE2eConfig';
import {
  UPDATE_INSTALL_E2E_TRIGGER_FILE,
  installUpdateInstallE2eTrigger,
} from '../../src/main/updater/updateInstallE2eTrigger';
import { migration001 } from '../../src/main/database/migrations/001_initial_schema';
import {
  UPDATE_INSTALL_E2E_APP_ID as LIB_APP_ID,
  UPDATE_INSTALL_E2E_PACKAGE_NAME as LIB_PACKAGE_NAME,
  UPDATE_INSTALL_E2E_PRODUCT_NAME as LIB_PRODUCT_NAME,
  UPDATE_INSTALL_E2E_PROFILE_LEAF as LIB_PROFILE_LEAF,
  UPDATE_INSTALL_E2E_RUN_PREFIX as LIB_RUN_PREFIX,
  UPDATE_INSTALL_E2E_TRIGGER_FILE as LIB_TRIGGER_FILE,
  PRODUCTION_APP_ID as LIB_PRODUCTION_APP_ID,
  PRODUCTION_PACKAGE_NAME as LIB_PRODUCTION_PACKAGE_NAME,
  PRODUCTION_PRODUCT_NAME as LIB_PRODUCTION_PRODUCT_NAME,
  allocateNextReceiptForContinuityCheck,
  assertSafeInstallRoot,
  assertSafeRunRoot,
  cleanupRunRoot,
  compareBusinessEvidence,
  captureBusinessEvidence,
  createRunRoot,
  findEvent,
  guardedLocalAppData,
  guardedProfilePath,
  installedAppLaunchEnvironment,
  isGuardedProfilePath,
  lastApplicationStart,
  readAllLogRecords,
  seedFixture,
} from '../../scripts/update-install-e2e-lib.mjs';

const builderConfig = createRequire(import.meta.url)('../../electron-builder.js') as {
  appId: string;
  productName: string;
};
const rootPackageJson = createRequire(import.meta.url)('../../package.json') as { name: string };

const roots: string[] = [];
function tempRoot(prefix = UPDATE_INSTALL_E2E_RUN_PREFIX): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await cleanupRunRoot(root).catch(() => rmSync(root, { recursive: true, force: true }));
});

function migratedDatabase(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'gpp-update-install-e2e-schema-'));
  const file = join(dir, 'gophones.sqlite');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  migration001.run(db, { now: '2026-09-12T00:00:00.000Z', appVersion: '0.1.100' });
  db.prepare(
    'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (1, ?, ?, ?)',
  ).run('initial_schema', 'test-checksum', '2026-09-12T00:00:00.000Z');
  db.close();
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('packaged update-install E2E identity', () => {
  it('is distinct from production and consistent across every toolchain that duplicates it', () => {
    expect(UPDATE_INSTALL_E2E_APP_ID).not.toBe(PRODUCTION_UPDATE_APP_ID);
    expect(UPDATE_INSTALL_E2E_PRODUCT_NAME).not.toBe(PRODUCTION_UPDATE_PRODUCT_NAME);
    expect(() =>
      assertDistinctUpdateInstallE2eIdentity(
        {
          appId: PRODUCTION_UPDATE_APP_ID,
          productName: PRODUCTION_UPDATE_PRODUCT_NAME,
          packageName: 'x',
        },
        { appId: PRODUCTION_UPDATE_APP_ID, productName: 'y', packageName: 'z' },
      ),
    ).toThrow(/distinct from production/);

    // Cross-toolchain duplication check: TS config module <-> plain-Node
    // harness lib <-> electron-builder.js (a plain CJS config with no
    // TypeScript/bundler step). All three must agree, or the E2E identity
    // guarantees this whole slice relies on silently drift apart.
    expect(LIB_APP_ID).toBe(UPDATE_INSTALL_E2E_APP_ID);
    expect(LIB_PRODUCT_NAME).toBe(UPDATE_INSTALL_E2E_PRODUCT_NAME);
    expect(LIB_PACKAGE_NAME).toBe(UPDATE_INSTALL_E2E_PACKAGE_NAME);
    expect(LIB_PRODUCTION_APP_ID).toBe(PRODUCTION_UPDATE_APP_ID);
    expect(LIB_PRODUCTION_PRODUCT_NAME).toBe(PRODUCTION_UPDATE_PRODUCT_NAME);
    expect(LIB_TRIGGER_FILE).toBe(UPDATE_INSTALL_E2E_TRIGGER_FILE);
    expect(LIB_RUN_PREFIX).toBe(UPDATE_INSTALL_E2E_RUN_PREFIX);
    expect(LIB_PROFILE_LEAF).toBe(UPDATE_INSTALL_E2E_PROFILE_LEAF);
    expect(builderConfig.appId).toBe(PRODUCTION_UPDATE_APP_ID);
    expect(builderConfig.productName).toBe(PRODUCTION_UPDATE_PRODUCT_NAME);
    expect(LIB_PACKAGE_NAME).not.toBe(LIB_PRODUCTION_PACKAGE_NAME);

    // The one fact that actually caused a real, empirically-discovered bug:
    // electron-builder's per-user NSIS default install directory is named
    // from package.json's `name` field, not `productName` — so the "real
    // production per-user install directory" this whole slice must avoid
    // colliding with is governed by THIS value, not by `productName`.
    expect(LIB_PRODUCTION_PACKAGE_NAME).toBe(rootPackageJson.name);
  });
});

describe('packaged update-install E2E build/runtime gates', () => {
  it('requires the explicit build env and rejects an unguarded profile', () => {
    expect(validateUpdateInstallE2eBuildConfig({})).toEqual({ enabled: false, profile: '' });
    expect(() =>
      validateUpdateInstallE2eBuildConfig({ GO_PHONES_UPDATE_INSTALL_E2E_BUILD: '1' }),
    ).toThrow(/not safely isolated/);
  });

  it('rejects an unguarded profile even with the build flag set', () => {
    expect(() =>
      validateUpdateInstallE2eBuildConfig({
        GO_PHONES_UPDATE_INSTALL_E2E_BUILD: '1',
        GO_PHONES_UPDATE_INSTALL_E2E_PROFILE: 'C:\\Users\\someone\\AppData\\Local\\GoPhonesPOS',
      }),
    ).toThrow(/not safely isolated/);
  });

  it('accepts only a profile nested under the dedicated run prefix with the exact leaf name', () => {
    const root = tempRoot();
    const good = guardedProfilePath(root);
    expect(isGuardedUpdateInstallE2eProfile(good)).toBe(true);
    expect(isGuardedProfilePath(root, good)).toBe(true);
    expect(isGuardedUpdateInstallE2eProfile(join(root, 'profile', 'WrongLeaf'))).toBe(false);
    expect(isGuardedUpdateInstallE2eProfile(join(tmpdir(), 'GoPhonesPOS'))).toBe(false);
    const config = validateUpdateInstallE2eBuildConfig({
      GO_PHONES_UPDATE_INSTALL_E2E_BUILD: '1',
      GO_PHONES_UPDATE_INSTALL_E2E_PROFILE: good,
    });
    expect(config.enabled).toBe(true);
  });

  it('arms the runtime trigger only with every one of: build flag, packaged, exact app name, runtime marker, and a matching guarded profile+LOCALAPPDATA', () => {
    const root = tempRoot();
    const profile = guardedProfilePath(root);
    const localAppData = guardedLocalAppData(root);
    const base = {
      buildEnabled: true,
      isPackaged: true,
      appName: UPDATE_INSTALL_E2E_PRODUCT_NAME,
      runtimeValue: '1',
      userData: profile,
      localAppData,
    };
    expect(updateInstallE2eRuntimeAllowed(base)).toBe(true);
    expect(updateInstallE2eRuntimeAllowed({ ...base, buildEnabled: false })).toBe(false);
    expect(updateInstallE2eRuntimeAllowed({ ...base, isPackaged: false })).toBe(false);
    expect(updateInstallE2eRuntimeAllowed({ ...base, appName: 'Go Phones POS' })).toBe(false);
    expect(updateInstallE2eRuntimeAllowed({ ...base, runtimeValue: undefined })).toBe(false);
    expect(updateInstallE2eRuntimeAllowed({ ...base, runtimeValue: 'yes' })).toBe(false);
    expect(updateInstallE2eRuntimeAllowed({ ...base, localAppData: undefined })).toBe(false);
    expect(updateInstallE2eRuntimeAllowed({ ...base, localAppData: tmpdir() })).toBe(false);
    expect(
      updateInstallE2eRuntimeAllowed({ ...base, userData: join(tmpdir(), 'GoPhonesPOS') }),
    ).toBe(false);
  });

  it('is completely inert outside an E2E build (never touches the marker file or maintenance/update services)', () => {
    const calls: string[] = [];
    const trigger = installUpdateInstallE2eTrigger({
      buildEnabled: false,
      isPackaged: true,
      appName: UPDATE_INSTALL_E2E_PRODUCT_NAME,
      userData: '/does/not/matter',
      localAppData: '/does/not/matter',
      diagnosticsRoot: '/does/not/matter',
      logger: {
        info: () => calls.push('info'),
        warn: () => calls.push('warn'),
      } as never,
      maintenanceCoordinator: {
        noteDraftCartActivity: () => calls.push('noteDraftCartActivity'),
        status: () => calls.push('status'),
      } as never,
      updateService: {
        restartAndInstall: () => calls.push('restartAndInstall'),
        getSnapshot: () => calls.push('getSnapshot'),
      } as never,
    });
    trigger.stopSync();
    expect(calls).toEqual([]);
  });
});

describe('packaged update-install E2E run/install root guards', () => {
  it('only cleans a direct temporary child carrying the dedicated E2E run prefix', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'proof.txt'), 'remove me');
    expect(assertSafeRunRoot(root)).toBe(root);
    await cleanupRunRoot(root);
    roots.splice(roots.indexOf(root), 1);
    expect(() => assertSafeRunRoot(tmpdir())).toThrow(/Refusing/);
    expect(() => assertSafeRunRoot(join(tmpdir(), 'unrelated'))).toThrow(/Refusing/);
  });

  it('only ever targets the E2E package Programs install directory, never a sibling or the real production one', () => {
    const localAppData = 'C:\\Users\\fixture\\AppData\\Local';
    const expected = join(localAppData, 'Programs', UPDATE_INSTALL_E2E_PACKAGE_NAME);
    expect(assertSafeInstallRoot(expected, localAppData)).toBe(expected);
    // The real production per-user install directory (package.json `name`,
    // not `productName` — see the identity test above for why).
    expect(() =>
      assertSafeInstallRoot(join(localAppData, 'Programs', 'go-phones-pos'), localAppData),
    ).toThrow(/Refusing/);
    expect(() =>
      assertSafeInstallRoot(
        join(localAppData, 'Programs', 'Go Phones POS Update E2E'),
        localAppData,
      ),
    ).toThrow(/Refusing/);
    expect(() =>
      assertSafeInstallRoot(join(localAppData, 'Programs', 'Other App'), localAppData),
    ).toThrow(/Refusing/);
  });

  it('never leaks the real LOCALAPPDATA into the installed-app launch environment', () => {
    const root = tempRoot();
    const env = installedAppLaunchEnvironment(
      { LOCALAPPDATA: 'C:\\Users\\real\\AppData\\Local', ELECTRON_RUN_AS_NODE: '1' },
      root,
      'https://127.0.0.1:1/',
    );
    expect(env.LOCALAPPDATA).toBe(guardedLocalAppData(root));
    expect(env.LOCALAPPDATA).not.toBe('C:\\Users\\real\\AppData\\Local');
    expect(env[UPDATE_INSTALL_E2E_RUNTIME_ENV]).toBe('1');
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(() => installedAppLaunchEnvironment({}, root, 'http://127.0.0.1/')).toThrow(/HTTPS/);
  });
});

describe('packaged update-install E2E business-data fixture and preservation', () => {
  it('seeds a schema-valid, self-consistent fixture and captures every required fact', () => {
    const { file, cleanup } = migratedDatabase();
    try {
      const seeded = seedFixture(file, { appVersion: '0.1.100' });
      expect(seeded.receiptNumber).toBe('GP-000001');
      const evidence = captureBusinessEvidence(file);
      expect(evidence.product?.quantity_on_hand).toBe(9);
      expect(evidence.sale?.status).toBe('COMPLETED');
      expect(evidence.exportJob?.status).toBe('PENDING');
      expect(evidence.checkoutRequest?.status).toBe('COMPLETED');
      expect(evidence.integrityOk).toBe(true);
      expect(evidence.foreignKeysOk).toBe(true);
      expect(() => seedFixture(file, { appVersion: '0.1.100' })).toThrow(/already been seeded/);
    } finally {
      cleanup();
    }
  });

  it('detects zero discrepancies for an unchanged database and flags duplicates/drift otherwise', () => {
    const { file, cleanup } = migratedDatabase();
    try {
      seedFixture(file, { appVersion: '0.1.100' });
      const before = captureBusinessEvidence(file);
      const after = captureBusinessEvidence(file);
      expect(compareBusinessEvidence(before, after)).toEqual([]);

      const mutated = { ...after, counts: { ...after.counts, sales: after.counts.sales + 1 } };
      expect(
        compareBusinessEvidence(before, mutated).some((p) => p.includes('possible duplicate')),
      ).toBe(true);

      const exported = { ...after, exportJob: { ...after.exportJob, status: 'EXPORTED' } };
      expect(
        compareBusinessEvidence(before, exported).some((p) => p.includes('no longer PENDING')),
      ).toBe(true);

      const reset = { ...after, receiptCounterValue: 0 };
      expect(
        compareBusinessEvidence(before, reset).some((p) => p.includes('receipt-number counter')),
      ).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('continues the receipt sequence from where it was left, never from zero', () => {
    const { file, cleanup } = migratedDatabase();
    try {
      seedFixture(file, { appVersion: '0.1.100' });
      const before = captureBusinessEvidence(file);
      const next = allocateNextReceiptForContinuityCheck(file);
      expect(next.value).toBe(before.receiptCounterValue + 1);
      expect(next.receiptNumber).toBe('GP-000002');
    } finally {
      cleanup();
    }
  });
});

describe('packaged update-install E2E log evidence parsing', () => {
  it('finds structured install-e2e events and the most recent application start', async () => {
    const root = tempRoot();
    const log = join(root, 'main.log');
    writeFileSync(
      log,
      [
        JSON.stringify({
          event: 'application.started',
          context: { version: '0.1.100', databaseReady: true },
        }),
        JSON.stringify({
          event: 'update.install-e2e.checkout-deferral',
          context: {
            draftAccepted: true,
            maintenanceState: 'CHECKOUT_ACTIVE',
            resultCode: 'CHECKOUT_ACTIVE',
          },
        }),
        JSON.stringify({
          event: 'application.started',
          context: { version: '0.1.101', databaseReady: true },
        }),
      ].join('\n'),
    );
    const records = await readAllLogRecords(log);
    expect(findEvent(records, 'update.install-e2e.checkout-deferral')).toHaveLength(1);
    expect(lastApplicationStart(records)?.context?.version).toBe('0.1.101');
    expect(findEvent(records, 'crash.session.unexpected-previous-termination')).toEqual([]);
  });
});

describe('packaged update-install E2E run root creation', () => {
  it('creates a fresh, correctly-prefixed run root each time', async () => {
    const root = await createRunRoot();
    roots.push(root);
    expect(root.includes(UPDATE_INSTALL_E2E_RUN_PREFIX)).toBe(true);
    expect(assertSafeRunRoot(root)).toBe(root);
  });
});
