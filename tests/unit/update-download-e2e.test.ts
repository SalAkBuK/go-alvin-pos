import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_DATA_DIRECTORY_NAME,
  UPDATE_E2E_RUN_PREFIX,
  UPDATE_E2E_VERSION_A,
  UPDATE_E2E_VERSION_B,
  assertReadyEvidence,
  assertSafeRunRoot,
  cleanupRunRoot,
  createRequestRecorder,
  isolatedLaunchEnvironment,
  isolatedProfileLayout,
  loopbackFeedUrl,
  observedUpdaterStates,
  readPackagedUpdaterEvidence,
  stagePackagedFeed,
  validateUpdateVersionPair,
  waitForUpdaterState,
} from '../../scripts/update-download-e2e-lib.mjs';

const roots: string[] = [];

function tempRoot(prefix = UPDATE_E2E_RUN_PREFIX): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeCandidate(root: string, version: string) {
  const buildDir = join(root, 'build');
  mkdirSync(buildDir, { recursive: true });
  const installerName = `Go Phones POS Setup ${version}.exe`;
  const installer = Buffer.from('genuine-builder-shape-fixture');
  const sha512 = createHash('sha512').update(installer).digest('base64');
  writeFileSync(join(buildDir, installerName), installer);
  writeFileSync(join(buildDir, `${installerName}.blockmap`), 'blockmap fixture');
  writeFileSync(
    join(buildDir, 'latest.yml'),
    [
      `version: ${version}`,
      'files:',
      `  - url: ${installerName}`,
      `    sha512: ${sha512}`,
      `    size: ${installer.length}`,
      `path: ${installerName}`,
      `sha512: ${sha512}`,
      "releaseDate: '2026-09-12T12:00:00.000Z'",
      '',
    ].join('\n'),
  );
  return { buildDir, installerName };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await cleanupRunRoot(root);
});

describe('packaged update E2E version and URL helpers', () => {
  it('uses stable, ordered test-only versions without changing the canonical package version', () => {
    expect(validateUpdateVersionPair(UPDATE_E2E_VERSION_A, UPDATE_E2E_VERSION_B)).toEqual({
      versionA: '0.1.100',
      versionB: '0.1.101',
    });
    expect(() => validateUpdateVersionPair('0.1.101', '0.1.100')).toThrow(/strictly newer/);
    expect(() => validateUpdateVersionPair('0.1.100-dev', '0.1.101')).toThrow(/stable/);
  });

  it('creates only bounded, credential-free HTTPS loopback URLs', () => {
    expect(loopbackFeedUrl(44321)).toBe('https://127.0.0.1:44321/');
    expect(() => loopbackFeedUrl(0)).toThrow(/port/);
    expect(() => loopbackFeedUrl(65_536)).toThrow(/port/);
  });
});

describe('packaged update E2E profile isolation and cleanup', () => {
  it('isolates LOCALAPPDATA, APPDATA, updater cache, and the fixed product userData leaf', () => {
    const root = tempRoot();
    const layout = isolatedProfileLayout(root, 'happy-download');
    const base = {
      PATH: 'fixture',
      LOCALAPPDATA: 'real-local',
      APPDATA: 'real-roaming',
      ELECTRON_RUN_AS_NODE: '1',
    };
    const env = isolatedLaunchEnvironment(base, layout, loopbackFeedUrl(44443));
    expect(env).toMatchObject({
      LOCALAPPDATA: layout.localAppData,
      APPDATA: layout.roamingAppData,
      GO_PHONES_UPDATE_FEED_URL: 'https://127.0.0.1:44443/',
    });
    expect(layout.expectedUserData).toBe(join(layout.localAppData, APP_DATA_DIRECTORY_NAME));
    expect(base.LOCALAPPDATA).toBe('real-local');
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(base.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(() => isolatedProfileLayout(root, '../escape')).toThrow(/scenario/);
    expect(() => isolatedLaunchEnvironment(base, layout, 'http://127.0.0.1/')).toThrow(/HTTPS/);
  });

  it('only removes a direct temporary child carrying the dedicated prefix', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'proof.txt'), 'remove me');
    expect(assertSafeRunRoot(root)).toBe(root);
    await cleanupRunRoot(root);
    roots.splice(roots.indexOf(root), 1);
    expect(() => readFileSync(join(root, 'proof.txt'))).toThrow();
    expect(() => assertSafeRunRoot(tmpdir())).toThrow(/Refusing/);
    expect(() => assertSafeRunRoot(join(tmpdir(), 'unrelated-folder'))).toThrow(/Refusing/);
  });
});

describe('packaged update E2E staging and request evidence', () => {
  it('stages only validated latest.yml, installer, and blockmap files', async () => {
    const root = tempRoot();
    const { buildDir, installerName } = writeCandidate(root, UPDATE_E2E_VERSION_B);
    writeFileSync(join(buildDir, 'do-not-stage.sqlite'), 'private');
    const feedDir = join(root, 'feed');
    const result = await stagePackagedFeed({
      buildDir,
      feedDir,
      version: UPDATE_E2E_VERSION_B,
    });
    expect(result.files.sort()).toEqual(
      ['latest.yml', installerName, `${installerName}.blockmap`].sort(),
    );
    expect(() => readFileSync(join(feedDir, 'do-not-stage.sqlite'))).toThrow();
  });

  it('records a bounded, copied, header-free request summary', () => {
    const recorder = createRequestRecorder(2);
    const unsafeEntry = {
      method: 'GET',
      path: '/latest.yml',
      statusCode: 200,
      rangeRequested: false,
      authorization: 'must-not-be-recorded',
    };
    recorder.record(unsafeEntry);
    recorder.record({ method: 'GET', path: '/setup.exe', statusCode: 206, rangeRequested: true });
    recorder.record({ method: 'GET', path: '/ignored', statusCode: 200, rangeRequested: false });
    const snapshot = recorder.snapshot();
    expect(snapshot).toEqual([
      { method: 'GET', path: '/latest.yml', statusCode: 200, rangeRequested: false },
      { method: 'GET', path: '/setup.exe', statusCode: 206, rangeRequested: true },
    ]);
    expect(snapshot[0]).not.toHaveProperty('authorization');
    (snapshot[0] as { path: string }).path = '/mutated';
    expect(recorder.snapshot()[0]?.path).toBe('/latest.yml');
    recorder.clear();
    expect(recorder.snapshot()).toEqual([]);
  });
});

describe('packaged structured updater evidence', () => {
  it('parses the safe lifecycle and validates a real-download READY sequence', async () => {
    const root = tempRoot();
    const log = join(root, 'main.log');
    const records = [
      {
        event: 'application.started',
        context: { version: UPDATE_E2E_VERSION_A, databaseReady: true },
      },
      { event: 'update.check.started', context: {} },
      { event: 'update.available', context: { availableVersion: UPDATE_E2E_VERSION_B } },
      { event: 'update.download.progress', context: { progressPercent: 50 } },
      { event: 'update.download.completed', context: { availableVersion: UPDATE_E2E_VERSION_B } },
    ];
    writeFileSync(log, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    const evidence = await readPackagedUpdaterEvidence(log);
    expect(assertReadyEvidence(evidence, UPDATE_E2E_VERSION_B)).toEqual([
      'APPLICATION_STARTED',
      'CHECKING',
      'AVAILABLE',
      'DOWNLOADING',
      'READY',
    ]);
    expect(() => assertReadyEvidence(evidence, '0.1.102')).toThrow(/wrong version/);
  });

  it('normalizes failed evidence and detects install events', async () => {
    const root = tempRoot();
    const log = join(root, 'main.log');
    writeFileSync(
      log,
      [
        '{not-json}',
        JSON.stringify({ event: 'update.check.started', context: {} }),
        JSON.stringify({ event: 'update.failed', errorCode: 'CHECK_FAILED', context: {} }),
        JSON.stringify({ event: 'update.install.requested', context: {} }),
      ].join('\n'),
    );
    const evidence = await readPackagedUpdaterEvidence(log);
    expect(observedUpdaterStates(evidence)).toEqual(['CHECKING', 'FAILED', 'INSTALL_EVENT']);
    expect(evidence[1]?.failureCode).toBe('CHECK_FAILED');
    expect(() => assertReadyEvidence(evidence, UPDATE_E2E_VERSION_B)).toThrow(/missing/);
  });

  it('waits deterministically and fails early on forbidden or timed-out states', async () => {
    let reads = 0;
    const reached = await waitForUpdaterState({
      readEvidence: async () => {
        reads += 1;
        return reads === 1
          ? [{ state: 'CHECKING', event: 'update.check.started' }]
          : [{ state: 'READY', event: 'update.download.completed' }];
      },
      targetState: 'READY',
      timeoutMs: 10,
      pollIntervalMs: 0,
      now: () => 0,
      delay: async () => {},
    });
    expect(observedUpdaterStates(reached)).toEqual(['READY']);
    await expect(
      waitForUpdaterState({
        readEvidence: async () => [{ state: 'FAILED', event: 'update.failed' }],
        targetState: 'READY',
        rejectStates: ['FAILED'],
        timeoutMs: 10,
        now: () => 0,
      }),
    ).rejects.toThrow(/FAILED before READY/);
    let now = 0;
    await expect(
      waitForUpdaterState({
        readEvidence: async () => [],
        targetState: 'READY',
        timeoutMs: 1,
        now: () => now++,
        delay: async () => {},
      }),
    ).rejects.toThrow(/Timed out/);
  });
});
