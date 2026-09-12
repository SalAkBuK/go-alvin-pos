import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  APP_DATA_DIRECTORY_NAME,
  UPDATE_E2E_RUN_PREFIX,
  UPDATE_E2E_VERSION_A,
  UPDATE_E2E_VERSION_B,
  assertReadyEvidence,
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
} from './update-download-e2e-lib.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const POWERSHELL = 'powershell.exe';
const NPM_CLI = process.env.npm_execpath;
const ELECTRON_BUILDER_CLI = join(
  REPO_ROOT,
  'node_modules',
  'electron-builder',
  'out',
  'cli',
  'cli.js',
);
const SCENARIO_TIMEOUT_MS = 120_000;

function encodedPowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: options.env ?? process.env,
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  if (options.capture) {
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
  }
  const [code] = await once(child, 'exit');
  if (code !== 0) {
    throw new Error(`${command} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`);
  }
  return stdout.trim();
}

async function gitOutput(...args) {
  return run('git.exe', args, { capture: true });
}

function pem(label, der) {
  const body = Buffer.from(der, 'base64')
    .toString('base64')
    .match(/.{1,64}/g)
    .join('\n');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

async function createLoopbackCertificate() {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$rsa = [System.Security.Cryptography.RSA]::Create(2048)
$request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
  'CN=Go Phones POS Update E2E',
  $rsa,
  [System.Security.Cryptography.HashAlgorithmName]::SHA256,
  [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
)
$san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$san.AddDnsName('localhost')
$san.AddIpAddress([System.Net.IPAddress]::Parse('127.0.0.1'))
$request.CertificateExtensions.Add($san.Build())
$request.CertificateExtensions.Add(
  [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true)
)
$certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5), [DateTimeOffset]::UtcNow.AddDays(7))
$parameters = $rsa.ExportParameters($true)
[ordered]@{
  certificate = [Convert]::ToBase64String($certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))
  modulus = [Convert]::ToBase64String($parameters.Modulus)
  exponent = [Convert]::ToBase64String($parameters.Exponent)
  d = [Convert]::ToBase64String($parameters.D)
  p = [Convert]::ToBase64String($parameters.P)
  q = [Convert]::ToBase64String($parameters.Q)
  dp = [Convert]::ToBase64String($parameters.DP)
  dq = [Convert]::ToBase64String($parameters.DQ)
  inverseQ = [Convert]::ToBase64String($parameters.InverseQ)
} | ConvertTo-Json -Compress
`;
  const json = await run(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script)],
    { capture: true },
  );
  const generated = JSON.parse(json);
  const base64url = (value) => value.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const key = createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'RSA',
      n: base64url(generated.modulus),
      e: base64url(generated.exponent),
      d: base64url(generated.d),
      p: base64url(generated.p),
      q: base64url(generated.q),
      dp: base64url(generated.dp),
      dq: base64url(generated.dq),
      qi: base64url(generated.inverseQ),
    },
  });
  const cert = pem('CERTIFICATE', generated.certificate);
  const computed = createHash('sha256')
    .update(createPublicKey(key).export({ type: 'spki', format: 'der' }))
    .digest('base64');
  const certificateSpki = createHash('sha256')
    .update(createPublicKey(cert).export({ type: 'spki', format: 'der' }))
    .digest('base64');
  if (computed !== certificateSpki) throw new Error('Loopback TLS SPKI verification failed.');
  return {
    key: key.export({ type: 'pkcs8', format: 'pem' }),
    cert,
    spkiSha256: computed,
  };
}

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (!match) return false;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
    return false;
  }
  return { start, end: Math.min(end, size - 1) };
}

async function createFeedServer(tls) {
  const recorder = createRequestRecorder();
  const state = { feedDir: null, denyArtifacts: false };
  const server = createServer({ key: tls.key, cert: tls.cert }, async (request, response) => {
    const method = request.method ?? 'UNKNOWN';
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'https://127.0.0.1/').pathname);
    const name = pathname.startsWith('/') ? pathname.slice(1) : pathname;
    const rangeRequested = typeof request.headers.range === 'string';
    let statusCode = 500;
    try {
      if (!['GET', 'HEAD'].includes(method) || !name || basename(name) !== name || !state.feedDir) {
        statusCode = method === 'GET' || method === 'HEAD' ? 404 : 405;
        response.writeHead(statusCode).end();
      } else if (state.denyArtifacts && name !== 'latest.yml') {
        statusCode = 404;
        response.writeHead(statusCode).end();
      } else {
        const file = join(state.feedDir, name);
        const info = await stat(file);
        if (!info.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
        const range = parseRange(request.headers.range, info.size);
        if (range === false) {
          statusCode = 416;
          response.writeHead(statusCode, { 'Content-Range': `bytes */${info.size}` }).end();
        } else {
          const start = range?.start ?? 0;
          const end = range?.end ?? info.size - 1;
          statusCode = range ? 206 : 200;
          response.writeHead(statusCode, {
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
          });
          if (method === 'HEAD') response.end();
          else createReadStream(file, { start, end }).pipe(response);
        }
      }
    } catch (error) {
      statusCode = error && error.code === 'ENOENT' ? 404 : 500;
      if (!response.headersSent) response.writeHead(statusCode);
      response.end();
    } finally {
      recorder.record({ method, path: pathname, statusCode, rangeRequested });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback HTTPS feed did not bind.');
  return {
    feedUrl: loopbackFeedUrl(address.port),
    use(feedDir, { denyArtifacts = false } = {}) {
      state.feedDir = feedDir;
      state.denyArtifacts = denyArtifacts;
      recorder.clear();
    },
    requests: () => recorder.snapshot(),
    close: async () => {
      if (!server.listening) return;
      server.close();
      await once(server, 'close');
    },
  };
}

function buildEnvironment(feedUrl, version, sourceRevision, buildTimestamp) {
  const env = {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    GO_PHONES_UPDATE_FEED_URL: feedUrl,
    GO_PHONES_RELEASE_VERSION: version,
    GO_PHONES_BUILD_SOURCE_REVISION: sourceRevision,
    GO_PHONES_BUILD_TIMESTAMP: buildTimestamp,
  };
  delete env.CSC_LINK;
  delete env.CSC_KEY_PASSWORD;
  delete env.GO_PHONES_WINDOWS_PUBLISHER_NAME;
  return env;
}

async function buildVersion(runRoot, feedUrl, version, sourceRevision, buildTimestamp, label) {
  if (!NPM_CLI) throw new Error('Run the packaged update E2E through its npm script.');
  const output = join(runRoot, 'builds', label);
  const env = buildEnvironment(feedUrl, version, sourceRevision, buildTimestamp);
  console.log(`Building genuine NSIS update artifacts for ${version} (${label})...`);
  await run(process.execPath, [NPM_CLI, 'run', 'build'], { env });
  await run(
    process.execPath,
    [
      ELECTRON_BUILDER_CLI,
      '--win',
      'nsis',
      '--publish',
      'never',
      `--config.directories.output=${output}`,
      `--config.extraMetadata.version=${version}`,
    ],
    { env },
  );
  return output;
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function normalClose(child) {
  if (child.exitCode !== null) return;
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$process = Get-Process -Id ${child.pid}
[void]$process.CloseMainWindow()
if (-not $process.WaitForExit(15000)) { exit 2 }
`;
  try {
    await run(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script)],
      { capture: true },
    );
  } catch {
    if (child.exitCode === null) {
      await run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { capture: true }).catch(
        () => {},
      );
    }
  }
  if (child.exitCode === null) await once(child, 'exit');
}

function assertStates(evidence, required, forbidden = []) {
  const states = observedUpdaterStates(evidence);
  for (const state of required) {
    if (!states.includes(state)) throw new Error(`Scenario evidence is missing ${state}.`);
  }
  for (const state of forbidden) {
    if (states.includes(state)) throw new Error(`Scenario unexpectedly reached ${state}.`);
  }
  return states;
}

function assertAlive(child, label) {
  if (child.exitCode !== null) throw new Error(`${label} packaged app exited unexpectedly.`);
}

function assertNoInstall(evidence) {
  if (evidence.some((entry) => entry.state === 'INSTALL_EVENT')) {
    throw new Error('Packaged update E2E observed an install/restart event.');
  }
}

function assertPackagedAStarted(evidence) {
  const started = evidence.find((entry) => entry.state === 'APPLICATION_STARTED');
  if (started?.version !== UPDATE_E2E_VERSION_A || started.databaseReady !== true) {
    throw new Error('Scenario did not start packaged A with an isolated ready database.');
  }
}

async function runScenario({ runRoot, executable, feedUrl, tlsSpki, name, target, rejectStates }) {
  const layout = isolatedProfileLayout(runRoot, name);
  await mkdir(layout.localAppData, { recursive: true });
  await mkdir(layout.roamingAppData, { recursive: true });
  const env = isolatedLaunchEnvironment(process.env, layout, feedUrl);
  const child = spawn(executable, [`--ignore-certificate-errors-spki-list=${tlsSpki}`], {
    cwd: REPO_ROOT,
    env,
    stdio: 'ignore',
    windowsHide: true,
  });
  const logFile = join(layout.expectedUserData, 'logs', 'main.log');
  try {
    const evidence = await waitForUpdaterState({
      readEvidence: async () => {
        assertAlive(child, name);
        return readPackagedUpdaterEvidence(logFile);
      },
      targetState: target,
      rejectStates,
      timeoutMs: SCENARIO_TIMEOUT_MS,
      pollIntervalMs: 200,
    });
    assertAlive(child, name);
    await access(join(layout.expectedUserData, 'gophones.sqlite'));
    assertPackagedAStarted(evidence);
    return { child, evidence, layout, logFile };
  } catch (error) {
    await normalClose(child);
    throw error;
  }
}

function hasRequest(requests, pattern, statuses) {
  return requests.some(
    (request) => pattern.test(request.path) && (!statuses || statuses.includes(request.statusCode)),
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function main() {
  if (process.platform !== 'win32')
    throw new Error('Packaged update download E2E requires Windows.');
  validateUpdateVersionPair(UPDATE_E2E_VERSION_A, UPDATE_E2E_VERSION_B);
  if (await gitOutput('status', '--porcelain')) {
    throw new Error(
      'Packaged update download E2E requires a clean Git worktree for source tracing.',
    );
  }
  const sourceRevision = await gitOutput('rev-parse', 'HEAD');
  const buildTimestamp = new Date(
    await gitOutput('show', '-s', '--format=%cI', 'HEAD'),
  ).toISOString();
  const packageBefore = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')).version;
  const runRoot = await mkdtemp(join(tmpdir(), UPDATE_E2E_RUN_PREFIX));
  let feed = null;
  const activeChildren = new Set();
  const results = {};
  try {
    const tls = await createLoopbackCertificate();
    feed = await createFeedServer(tls);
    const buildA = await buildVersion(
      runRoot,
      feed.feedUrl,
      UPDATE_E2E_VERSION_A,
      sourceRevision,
      buildTimestamp,
      'a',
    );
    const buildB = await buildVersion(
      runRoot,
      feed.feedUrl,
      UPDATE_E2E_VERSION_B,
      sourceRevision,
      buildTimestamp,
      'b',
    );
    const feedA = join(runRoot, 'feeds', 'a');
    const feedB = join(runRoot, 'feeds', 'b');
    const stagedA = await stagePackagedFeed({
      buildDir: buildA,
      feedDir: feedA,
      version: UPDATE_E2E_VERSION_A,
    });
    const stagedB = await stagePackagedFeed({
      buildDir: buildB,
      feedDir: feedB,
      version: UPDATE_E2E_VERSION_B,
    });
    const executable = join(buildA, 'win-unpacked', 'Go Phones POS.exe');
    await access(executable);
    const executableHashBefore = await hashFile(executable);

    feed.use(feedA);
    let scenario = await runScenario({
      runRoot,
      executable,
      feedUrl: feed.feedUrl,
      tlsSpki: tls.spkiSha256,
      name: 'same-version',
      target: 'IDLE',
      rejectStates: ['AVAILABLE', 'FAILED'],
    });
    activeChildren.add(scenario.child);
    results.sameVersion = {
      states: assertStates(
        scenario.evidence,
        ['APPLICATION_STARTED', 'CHECKING', 'IDLE'],
        ['AVAILABLE', 'READY', 'FAILED'],
      ),
      requests: feed.requests(),
    };
    assertNoInstall(scenario.evidence);
    if (!hasRequest(results.sameVersion.requests, /\/latest\.yml$/, [200]))
      throw new Error('Same-version metadata request was not observed.');
    if (results.sameVersion.requests.some((request) => /\.(?:exe|blockmap)$/.test(request.path)))
      throw new Error('Same-version check unexpectedly requested an artifact.');
    await normalClose(scenario.child);
    activeChildren.delete(scenario.child);

    feed.use(feedB);
    scenario = await runScenario({
      runRoot,
      executable,
      feedUrl: feed.feedUrl,
      tlsSpki: tls.spkiSha256,
      name: 'happy-download',
      target: 'READY',
      rejectStates: ['FAILED'],
    });
    activeChildren.add(scenario.child);
    results.happy = {
      states: assertReadyEvidence(scenario.evidence, UPDATE_E2E_VERSION_B),
      requests: feed.requests(),
    };
    assertAlive(scenario.child, 'happy-download READY');
    const installerPattern = new RegExp(`/${escapeRegExp(stagedB.artifacts.installerName)}$`);
    const blockmapPattern = new RegExp(`/${escapeRegExp(stagedB.artifacts.blockmapName)}$`);
    if (!hasRequest(results.happy.requests, /\/latest\.yml$/, [200]))
      throw new Error('Happy-path metadata request was not observed.');
    if (!hasRequest(results.happy.requests, blockmapPattern, [200, 206]))
      throw new Error('Happy-path B blockmap request was not observed.');
    if (!hasRequest(results.happy.requests, installerPattern, [200, 206]))
      throw new Error('Happy-path B installer request was not observed.');
    await normalClose(scenario.child);
    activeChildren.delete(scenario.child);

    feed.use(feedB, { denyArtifacts: true });
    scenario = await runScenario({
      runRoot,
      executable,
      feedUrl: feed.feedUrl,
      tlsSpki: tls.spkiSha256,
      name: 'missing-artifact',
      target: 'FAILED',
      rejectStates: ['READY'],
    });
    activeChildren.add(scenario.child);
    results.missing = {
      states: assertStates(
        scenario.evidence,
        ['APPLICATION_STARTED', 'CHECKING', 'AVAILABLE', 'FAILED'],
        ['READY'],
      ),
      requests: feed.requests(),
      failureCode: scenario.evidence.findLast((entry) => entry.state === 'FAILED')?.failureCode,
    };
    assertNoInstall(scenario.evidence);
    if (!hasRequest(results.missing.requests, /\.(?:exe|blockmap)$/, [404]))
      throw new Error('Missing-artifact 404 was not observed.');
    await normalClose(scenario.child);
    activeChildren.delete(scenario.child);

    await feed.close();
    scenario = await runScenario({
      runRoot,
      executable,
      feedUrl: feed.feedUrl,
      tlsSpki: tls.spkiSha256,
      name: 'feed-unavailable',
      target: 'FAILED',
      rejectStates: ['AVAILABLE', 'READY'],
    });
    activeChildren.add(scenario.child);
    results.unavailable = {
      states: assertStates(
        scenario.evidence,
        ['APPLICATION_STARTED', 'CHECKING', 'FAILED'],
        ['AVAILABLE', 'READY'],
      ),
      requests: [],
      failureCode: scenario.evidence.findLast((entry) => entry.state === 'FAILED')?.failureCode,
    };
    assertNoInstall(scenario.evidence);
    await normalClose(scenario.child);
    activeChildren.delete(scenario.child);

    const executableHashAfter = await hashFile(executable);
    if (executableHashAfter !== executableHashBefore)
      throw new Error('Packaged A executable changed during download testing.');
    const packageAfter = JSON.parse(
      await readFile(join(REPO_ROOT, 'package.json'), 'utf8'),
    ).version;
    if (packageAfter !== packageBefore)
      throw new Error('Canonical package version changed during test-only builds.');

    console.log('FUNCTIONAL PACKAGED UPDATE DOWNLOAD VERIFIED');
    console.log('PRODUCTION SIGNATURE NOT VERIFIED LOCALLY');
    console.log(`source revision: ${sourceRevision}`);
    console.log(`test-only versions: ${UPDATE_E2E_VERSION_A} -> ${UPDATE_E2E_VERSION_B}`);
    console.log(`canonical package version unchanged: ${packageAfter}`);
    console.log(`staged A files: ${stagedA.files.join(', ')}`);
    console.log(`staged B files: ${stagedB.files.join(', ')}`);
    console.log(`same-version states: ${results.sameVersion.states.join(' -> ')}`);
    console.log(`happy states: ${results.happy.states.join(' -> ')}`);
    console.log(`happy requests: ${JSON.stringify(results.happy.requests)}`);
    console.log(
      `missing-artifact states/failure: ${results.missing.states.join(' -> ')} / ${results.missing.failureCode}`,
    );
    console.log(
      `feed-unavailable states/failure: ${results.unavailable.states.join(' -> ')} / ${results.unavailable.failureCode}`,
    );
    console.log(`isolated userData leaf: ${APP_DATA_DIRECTORY_NAME}`);
    console.log('install/restart events: none');
    console.log(
      'temporary feed, artifacts, certificates, updater caches, and profiles will be removed',
    );
  } finally {
    for (const child of activeChildren) await normalClose(child);
    if (feed) await feed.close();
    await cleanupRunRoot(runRoot);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
