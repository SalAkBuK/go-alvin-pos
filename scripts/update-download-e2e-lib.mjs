import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { stagePublicationBundle, validateVersion } from './release-lib.mjs';

export const UPDATE_E2E_VERSION_A = '0.1.100';
export const UPDATE_E2E_VERSION_B = '0.1.101';
export const UPDATE_E2E_RUN_PREFIX = 'gpp-update-download-e2e-';
export const APP_DATA_DIRECTORY_NAME = 'GoPhonesPOS';

const UPDATER_EVENT_TO_STATE = Object.freeze({
  'update.check.started': 'CHECKING',
  'update.check.no_update': 'IDLE',
  'update.available': 'AVAILABLE',
  'update.download.progress': 'DOWNLOADING',
  'update.download.completed': 'READY',
  'update.failed': 'FAILED',
});

function stableParts(version) {
  const stable = validateVersion(version, { production: true });
  return stable.split('.').map((part) => BigInt(part));
}

/** Validate the two stable, deterministic test-only versions and return them unchanged. */
export function validateUpdateVersionPair(versionA, versionB) {
  const a = stableParts(versionA);
  const b = stableParts(versionB);
  let comparison = 0;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] < b[index]) {
      comparison = -1;
      break;
    }
    if (a[index] > b[index]) {
      comparison = 1;
      break;
    }
  }
  if (comparison >= 0) {
    throw new Error('Packaged update E2E version B must be strictly newer than version A.');
  }
  return { versionA, versionB };
}

/** Build the canonical credential-free HTTPS loopback feed URL. */
export function loopbackFeedUrl(port) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Packaged update E2E feed port is invalid.');
  }
  return `https://127.0.0.1:${port}/`;
}

function assertChildPath(parent, candidate, label) {
  const rel = relative(resolve(parent), resolve(candidate));
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..') {
    throw new Error(`${label} must remain inside the packaged update E2E run root.`);
  }
  return resolve(candidate);
}

/**
 * Create the exact paths a packaged scenario receives through its private
 * LOCALAPPDATA/APPDATA environment. The production app still appends its fixed
 * GoPhonesPOS leaf; no application data-path override is added to product code.
 */
export function isolatedProfileLayout(runRoot, scenario) {
  if (!/^[a-z][a-z0-9-]*$/.test(scenario)) {
    throw new Error('Packaged update E2E scenario name is invalid.');
  }
  const scenarioRoot = assertChildPath(runRoot, join(runRoot, 'profiles', scenario), 'Profile');
  const localAppData = join(scenarioRoot, 'local');
  const roamingAppData = join(scenarioRoot, 'roaming');
  const expectedUserData = join(localAppData, APP_DATA_DIRECTORY_NAME);
  assertChildPath(runRoot, expectedUserData, 'Expected userData');
  return { scenarioRoot, localAppData, roamingAppData, expectedUserData };
}

/** Return a child-only environment without mutating the caller's environment. */
export function isolatedLaunchEnvironment(baseEnv, layout, feedUrl) {
  const url = new URL(feedUrl);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Packaged update E2E child feed must be credential-free HTTPS.');
  }
  const environment = {
    ...baseEnv,
    LOCALAPPDATA: layout.localAppData,
    APPDATA: layout.roamingAppData,
    GO_PHONES_UPDATE_FEED_URL: feedUrl,
  };
  // Codex/CI shells may use this to run Electron's embedded Node process. A
  // genuine packaged GUI launch must never inherit it.
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

/** Stage only genuine electron-builder metadata/installer/blockmap artifacts. */
export async function stagePackagedFeed({ buildDir, feedDir, version }) {
  return stagePublicationBundle({ buildDir, outputDir: feedDir, expectedVersion: version });
}

/** Bounded, header-free request evidence recorder for the loopback feed. */
export function createRequestRecorder(limit = 200) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('Request evidence limit must be a positive integer.');
  }
  let entries = [];
  return {
    record(entry) {
      if (entries.length < limit) {
        entries.push({
          method: entry.method,
          path: entry.path,
          statusCode: entry.statusCode,
          rangeRequested: entry.rangeRequested === true,
        });
      }
    },
    snapshot() {
      return entries.map((entry) => ({ ...entry }));
    },
    clear() {
      entries = [];
    },
  };
}

/** Read only the safe structured events needed by the packaged updater harness. */
export async function readPackagedUpdaterEvidence(logFile) {
  let text;
  try {
    text = await readFile(logFile, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return [];
    throw error;
  }

  const evidence = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const state = UPDATER_EVENT_TO_STATE[record.event];
    if (state) {
      evidence.push({
        state,
        event: record.event,
        ...(typeof record.context?.availableVersion === 'string'
          ? { availableVersion: record.context.availableVersion }
          : {}),
        ...(typeof record.errorCode === 'string' ? { failureCode: record.errorCode } : {}),
      });
    } else if (record.event === 'application.started') {
      evidence.push({
        state: 'APPLICATION_STARTED',
        event: record.event,
        ...(typeof record.context?.version === 'string' ? { version: record.context.version } : {}),
        ...(typeof record.context?.databaseReady === 'boolean'
          ? { databaseReady: record.context.databaseReady }
          : {}),
      });
    } else if (typeof record.event === 'string' && record.event.startsWith('update.install.')) {
      evidence.push({ state: 'INSTALL_EVENT', event: record.event });
    }
  }
  return evidence;
}

export function observedUpdaterStates(evidence) {
  return evidence
    .map((entry) => entry.state)
    .filter((state, index, states) => index === 0 || states[index - 1] !== state);
}

/** Wait for one target state, failing early on a forbidden terminal state. */
export async function waitForUpdaterState({
  readEvidence,
  targetState,
  rejectStates = [],
  timeoutMs,
  pollIntervalMs = 100,
  now = () => Date.now(),
  delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Packaged update E2E timeout must be positive.');
  }
  const startedAt = now();
  for (;;) {
    const evidence = await readEvidence();
    const states = observedUpdaterStates(evidence);
    if (states.includes(targetState)) return evidence;
    const rejected = rejectStates.find((state) => states.includes(state));
    if (rejected) {
      throw new Error(`Packaged updater reached ${rejected} before ${targetState}.`);
    }
    if (now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for packaged updater state ${targetState}.`);
    }
    await delay(pollIntervalMs);
  }
}

export function assertReadyEvidence(evidence, expectedVersion) {
  const states = observedUpdaterStates(evidence);
  for (const required of ['APPLICATION_STARTED', 'CHECKING', 'AVAILABLE', 'DOWNLOADING', 'READY']) {
    if (!states.includes(required)) {
      throw new Error(`Packaged updater READY evidence is missing ${required}.`);
    }
  }
  const available = evidence.find((entry) => entry.state === 'AVAILABLE');
  const ready = evidence.find((entry) => entry.state === 'READY');
  if (
    available?.availableVersion !== expectedVersion ||
    ready?.availableVersion !== expectedVersion
  ) {
    throw new Error('Packaged updater READY evidence is associated with the wrong version.');
  }
  if (states.includes('INSTALL_EVENT')) {
    throw new Error('Packaged updater E2E must never invoke installation.');
  }
  return states;
}

export function assertSafeRunRoot(runRoot, temporaryRoot = tmpdir()) {
  const resolvedRunRoot = resolve(runRoot);
  const resolvedTemporaryRoot = resolve(temporaryRoot);
  if (
    dirname(resolvedRunRoot) !== resolvedTemporaryRoot ||
    !resolvedRunRoot.split(sep).pop()?.startsWith(UPDATE_E2E_RUN_PREFIX)
  ) {
    throw new Error('Refusing to clean a path that is not a packaged update E2E run root.');
  }
  return resolvedRunRoot;
}

export async function cleanupRunRoot(runRoot, temporaryRoot = tmpdir()) {
  await rm(assertSafeRunRoot(runRoot, temporaryRoot), { recursive: true, force: true });
}
