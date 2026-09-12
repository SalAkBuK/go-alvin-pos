import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:https';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  UPDATE_E2E_VERSION_A,
  UPDATE_E2E_VERSION_B,
  loopbackFeedUrl,
  readPackagedUpdaterEvidence,
  stagePackagedFeed,
  validateUpdateVersionPair,
  waitForUpdaterState,
  createRequestRecorder,
  assertReadyEvidence,
} from './update-download-e2e-lib.mjs';
import {
  UPDATE_INSTALL_E2E_BUILD_ENV,
  UPDATE_INSTALL_E2E_PACKAGE_NAME,
  UPDATE_INSTALL_E2E_PROFILE_ENV,
  UPDATE_INSTALL_E2E_PRODUCT_NAME,
  UPDATE_INSTALL_E2E_TRIGGER_FILE,
  allocateNextReceiptForContinuityCheck,
  assertSafeInstallRoot,
  captureBusinessEvidence,
  cleanupRunRoot,
  compareBusinessEvidence,
  createRunRoot,
  findEvent,
  guardedLocalAppData,
  guardedProfilePath,
  installedAppLaunchEnvironment,
  lastApplicationStart,
  readAllLogRecords,
  seedFixture,
} from './update-install-e2e-lib.mjs';

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
const READY_TIMEOUT_MS = 180_000;
const INSTALL_SEQUENCE_TIMEOUT_MS = 30_000;
const APP_EXIT_TIMEOUT_MS = 60_000;
const RELAUNCH_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 300;

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
  'CN=Go Phones POS Update Install E2E',
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
  const state = { feedDir: null };
  const server = createServer({ key: tls.key, cert: tls.cert }, async (request, response) => {
    const method = request.method ?? 'UNKNOWN';
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'https://127.0.0.1/').pathname);
    const name = pathname.startsWith('/') ? pathname.slice(1) : pathname;
    const rangeRequested = typeof request.headers.range === 'string';
    let statusCode = 500;
    try {
      if (!['GET', 'HEAD'].includes(method) || !name || name.includes('..') || !state.feedDir) {
        statusCode = method === 'GET' || method === 'HEAD' ? 404 : 405;
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
    use(feedDir) {
      state.feedDir = feedDir;
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

async function buildE2eVersion({
  runRoot,
  feedUrl,
  version,
  profile,
  sourceRevision,
  buildTimestamp,
  label,
}) {
  if (!NPM_CLI) throw new Error('Run the packaged update-install E2E through its npm script.');
  const output = join(runRoot, 'builds', label);
  const env = {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    GO_PHONES_UPDATE_FEED_URL: feedUrl,
    GO_PHONES_BUILD_SOURCE_REVISION: sourceRevision,
    GO_PHONES_BUILD_TIMESTAMP: buildTimestamp,
    [UPDATE_INSTALL_E2E_BUILD_ENV]: '1',
    [UPDATE_INSTALL_E2E_PROFILE_ENV]: profile,
  };
  delete env.CSC_LINK;
  delete env.CSC_KEY_PASSWORD;
  delete env.GO_PHONES_WINDOWS_PUBLISHER_NAME;
  console.log(`Building E2E-identity NSIS artifact for ${version} (${label})...`);
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
      // electron-builder's per-user (non-`perMachine`) NSIS installer derives
      // its DEFAULT install directory from package.json's `name` field, NOT
      // from `productName` (confirmed empirically: without this override, an
      // E2E build installed to the exact same `%LOCALAPPDATA%\Programs\
      // go-phones-pos` a real per-user production install would use). This
      // is the only thing `extraMetadata.name` is for here — `app.getName()`
      // is independently forced to `UPDATE_INSTALL_E2E_PRODUCT_NAME` by
      // `applyUpdateInstallE2eAppName()`, so runtime identity is unaffected.
      `--config.extraMetadata.name=${UPDATE_INSTALL_E2E_PACKAGE_NAME}`,
    ],
    { env },
  );
  return output;
}

function installerPathFor(buildDir, version) {
  return join(buildDir, `Go Phones POS Setup ${version}.exe`);
}

async function runSilent(exePath, timeoutMs, env = process.env) {
  const child = spawn(exePath, ['/S'], { cwd: REPO_ROOT, stdio: 'ignore', env, windowsHide: true });
  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }, timeoutMs);
  try {
    const [code] = await once(child, 'exit');
    if (code !== 0 && code !== null) {
      throw new Error(`Silent NSIS run of ${exePath} exited with code ${code}.`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function findProcessIdByExePath(exePath) {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$target = '${exePath.replace(/'/g, "''")}'
$proc = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $target } | Select-Object -First 1
if ($proc) { Write-Output $proc.ProcessId } else { Write-Output '' }
`;
  const out = await run(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script)],
    { capture: true },
  );
  const pid = parseInt(out.trim(), 10);
  return Number.isInteger(pid) ? pid : null;
}

async function closeProcessById(pid, timeoutMs = 30_000) {
  // A single blind `CloseMainWindow()` + `WaitForExit()` is unreliable right
  // after a fresh launch: the main window may not exist/be findable yet,
  // and Get-Process's snapshot is one-shot (a later-created window is never
  // seen). Poll for a non-zero MainWindowHandle and retry CloseMainWindow
  // until the process actually exits, so `will-quit` -> `markCleanShutdown()`
  // gets a real chance to run instead of falling through to a hard kill.
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$deadline = (Get-Date).AddMilliseconds(${timeoutMs})
while ((Get-Date) -lt $deadline) {
  try {
    $process = Get-Process -Id ${pid} -ErrorAction Stop
  } catch {
    exit 0
  }
  if ($process.MainWindowHandle -ne 0) {
    [void]$process.CloseMainWindow()
  }
  if ($process.WaitForExit(500)) { exit 0 }
}
exit 2
`;
  try {
    await run(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script)],
      { capture: true },
    );
  } catch {
    await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { capture: true }).catch(() => {});
  }
}

async function waitFor(predicate, timeoutMs, pollIntervalMs = POLL_INTERVAL_MS) {
  const startedAt = Date.now();
  for (;;) {
    const result = await predicate();
    if (result) return result;
    if (Date.now() - startedAt >= timeoutMs) throw new Error('Timed out waiting for condition.');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, pollIntervalMs));
  }
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('Packaged update-install E2E requires Windows.');
  }
  const localAppDataReal = process.env.LOCALAPPDATA;
  if (!localAppDataReal) throw new Error('Real %LOCALAPPDATA% is required to install/uninstall.');

  validateUpdateVersionPair(UPDATE_E2E_VERSION_A, UPDATE_E2E_VERSION_B);
  const sourceRevision = (await gitOutput('rev-parse', 'HEAD')).trim();
  const worktreeStatus = await gitOutput('status', '--porcelain');
  const buildTimestamp = new Date().toISOString();

  const runRoot = await createRunRoot();
  const profile = guardedProfilePath(runRoot);
  const localAppDataE2e = guardedLocalAppData(runRoot);
  const dbFile = join(profile, 'gophones.sqlite');
  const logFile = join(profile, 'logs', 'main.log');
  // NOTE: electron-builder's per-user (non-`perMachine`) NSIS default install
  // directory is named from package.json's `name` field (the package name),
  // NOT `productName` — confirmed empirically. `installedExePath`/
  // `uninstallerPath` still use `productName` because that names the actual
  // files electron-builder generates inside that directory.
  const installRoot = assertSafeInstallRoot(
    join(localAppDataReal, 'Programs', UPDATE_INSTALL_E2E_PACKAGE_NAME),
    localAppDataReal,
  );
  const installedExePath = join(installRoot, `${UPDATE_INSTALL_E2E_PRODUCT_NAME}.exe`);
  const uninstallerPath = join(installRoot, `Uninstall ${UPDATE_INSTALL_E2E_PRODUCT_NAME}.exe`);
  const productionInstallRoot = join(localAppDataReal, 'Programs', 'go-phones-pos');

  let feed = null;
  let installed = false;
  const report = {};

  try {
    // (guard) production installation must not already collide with our E2E path.
    if (existsSync(installRoot)) {
      throw new Error(`E2E install root already exists (${installRoot}); refusing to proceed.`);
    }
    const productionExisted = existsSync(productionInstallRoot);
    const productionHashBefore = productionExisted
      ? await hashFile(join(productionInstallRoot, 'Go Phones POS.exe')).catch(() => null)
      : null;

    const tls = await createLoopbackCertificate();
    feed = await createFeedServer(tls);

    const buildA = await buildE2eVersion({
      runRoot,
      feedUrl: feed.feedUrl,
      version: UPDATE_E2E_VERSION_A,
      profile,
      sourceRevision,
      buildTimestamp,
      label: 'a',
    });
    const buildB = await buildE2eVersion({
      runRoot,
      feedUrl: feed.feedUrl,
      version: UPDATE_E2E_VERSION_B,
      profile,
      sourceRevision,
      buildTimestamp,
      label: 'b',
    });

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

    // ── Section 9: install A for real ──────────────────────────────────
    const installerA = installerPathFor(buildA, UPDATE_E2E_VERSION_A);
    await access(installerA);
    await runSilent(installerA, INSTALL_SEQUENCE_TIMEOUT_MS, process.env);
    installed = true;
    await access(installedExePath);
    report.installIdentityProof = {
      installRoot,
      installedExePath,
      productionInstallRoot,
      productionExisted,
      productionUntouched:
        !productionExisted ||
        (await hashFile(join(productionInstallRoot, 'Go Phones POS.exe')).catch(() => null)) ===
          productionHashBefore,
    };

    // ── Seed launch: create schema, then close, then seed fixture directly ──
    await mkdir(localAppDataE2e, { recursive: true });
    const seedEnv = installedAppLaunchEnvironment(process.env, runRoot, feed.feedUrl);
    feed.use(feedA);
    const seedChild = spawn(
      installedExePath,
      [`--ignore-certificate-errors-spki-list=${tls.spkiSha256}`],
      {
        cwd: REPO_ROOT,
        env: seedEnv,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    try {
      await waitFor(async () => {
        if (seedChild.exitCode !== null)
          throw new Error('Seed launch of installed A exited unexpectedly.');
        const records = await readAllLogRecords(logFile);
        const start = lastApplicationStart(records);
        return start?.context?.databaseReady === true ? start : null;
      }, RELAUNCH_TIMEOUT_MS);
    } finally {
      // A graceful close (not a hard kill) so `will-quit` -> `markCleanShutdown()`
      // runs — a hard kill here would make the NEXT launch's crash-evidence
      // session read a stale RUNNING marker and record a false
      // `unexpected_previous_termination`.
      if (seedChild.exitCode === null && seedChild.pid) {
        await closeProcessById(seedChild.pid);
      }
      if (seedChild.exitCode === null) {
        await once(seedChild, 'exit').catch(() => {});
      }
    }
    await access(dbFile);

    const seeded = seedFixture(dbFile, { appVersion: UPDATE_E2E_VERSION_A });
    const before = captureBusinessEvidence(dbFile);
    report.fixture = seeded;
    report.preUpdateEvidence = before;

    // ── Discover + download real B, reach real READY ────────────────────
    feed.use(feedB);
    const mainEnv = installedAppLaunchEnvironment(process.env, runRoot, feed.feedUrl);
    const mainChild = spawn(
      installedExePath,
      [`--ignore-certificate-errors-spki-list=${tls.spkiSha256}`],
      {
        cwd: REPO_ROOT,
        env: mainEnv,
        stdio: 'ignore',
        windowsHide: true,
      },
    );

    const readyEvidence = await waitForUpdaterState({
      readEvidence: async () => {
        if (mainChild.exitCode !== null)
          throw new Error('Installed A exited before reaching READY.');
        return readPackagedUpdaterEvidence(logFile);
      },
      targetState: 'READY',
      rejectStates: ['FAILED'],
      timeoutMs: READY_TIMEOUT_MS,
      pollIntervalMs: 500,
    });
    report.readyStates = assertReadyEvidence(readyEvidence, UPDATE_E2E_VERSION_B);
    report.readyRequests = feed.requests();

    // ── Real packaged CHECKOUT_ACTIVE deferral + trusted install, driven
    // entirely by the compiled-in one-shot trigger (updateInstallE2eTrigger.ts) —
    // the harness only ever writes the fixed empty marker file. ───────────
    const diagnosticsDir = join(profile, 'diagnostics');
    await mkdir(diagnosticsDir, { recursive: true });
    await writeFile(join(diagnosticsDir, UPDATE_INSTALL_E2E_TRIGGER_FILE), '');

    await waitFor(async () => {
      if (mainChild.exitCode !== null && mainChild.exitCode !== 0) {
        throw new Error('Installed A exited unexpectedly while awaiting checkout deferral.');
      }
      const records = await readAllLogRecords(logFile);
      const deferral = findEvent(records, 'update.install-e2e.checkout-deferral').at(-1);
      return deferral ?? null;
    }, INSTALL_SEQUENCE_TIMEOUT_MS).then((deferral) => {
      if (
        deferral.context?.draftAccepted !== true ||
        deferral.context?.maintenanceState !== 'CHECKOUT_ACTIVE' ||
        deferral.context?.resultCode !== 'CHECKOUT_ACTIVE'
      ) {
        throw new Error(
          `Checkout-active deferral evidence is not conclusive: ${JSON.stringify(deferral)}`,
        );
      }
      report.checkoutActiveDeferral = deferral;
    });

    const installResult = await waitFor(async () => {
      const records = await readAllLogRecords(logFile);
      return findEvent(records, 'update.install-e2e.install-result').at(-1) ?? null;
    }, INSTALL_SEQUENCE_TIMEOUT_MS + 5_000);
    if (installResult.context?.resultCode !== 'INSTALL_ACCEPTED') {
      throw new Error(`Trusted install was not accepted: ${JSON.stringify(installResult)}`);
    }
    report.installAccepted = installResult;

    // ── Real NSIS update install + relaunch as B ─────────────────────────
    await waitFor(async () => (mainChild.exitCode !== null ? true : null), APP_EXIT_TIMEOUT_MS);
    report.aExited = true;

    const bStart = await waitFor(async () => {
      const records = await readAllLogRecords(logFile);
      const start = lastApplicationStart(records);
      return start?.context?.version === UPDATE_E2E_VERSION_B ? start : null;
    }, RELAUNCH_TIMEOUT_MS);
    report.bStart = bStart;
    if (bStart.context?.databaseReady !== true) {
      throw new Error('B started without a ready database.');
    }

    const bPid = await findProcessIdByExePath(installedExePath);
    if (!bPid) throw new Error('Could not locate the relaunched B process.');
    report.bPid = bPid;

    // ── Business-data preservation (read-only, safe concurrently with B) ──
    const after = captureBusinessEvidence(dbFile);
    report.postUpdateEvidence = after;
    const problems = compareBusinessEvidence(before, after);
    if (problems.length > 0) {
      throw new Error(`Business-data preservation FAILED:\n${problems.join('\n')}`);
    }

    // ── Clean shutdown / crash evidence for the ACTUAL A(main run) -> B
    // update transition under test. The harness's own earlier seed-launch
    // (used only to create the schema before seeding the fixture) is closed
    // best-effort and is not part of the production update path this
    // section verifies — its own shutdown is deliberately excluded here.
    const allRecords = await readAllLogRecords(logFile);
    const mainRunStarts = allRecords.filter(
      (r) => r.event === 'application.started' && r.context?.version === UPDATE_E2E_VERSION_A,
    );
    const mainRunStart = mainRunStarts.at(-1);
    if (!mainRunStart)
      throw new Error('Could not identify the main-run application.started record.');
    const falseCrash = findEvent(
      allRecords,
      'crash.session.unexpected-previous-termination',
    ).filter((record) => record.timestamp >= mainRunStart.timestamp);
    if (falseCrash.length > 0) {
      throw new Error(
        `The real A(main run) -> B update was misclassified as a crash: ${JSON.stringify(falseCrash)}`,
      );
    }
    report.crashEvidenceClean = true;
    report.restoreMarkerAbsent = !existsSync(join(profile, 'restore-in-progress.json'));

    await closeProcessById(bPid);
    await waitFor(
      async () => ((await findProcessIdByExePath(installedExePath)) === null ? true : null),
      30_000,
    );

    // ── Receipt-sequence continuity (after B has released the connection) ─
    const continuity = allocateNextReceiptForContinuityCheck(dbFile);
    if (continuity.value !== before.receiptCounterValue + 1) {
      throw new Error(
        `Receipt sequence was not continuous: expected ${before.receiptCounterValue + 1}, got ${continuity.value}.`,
      );
    }
    report.receiptContinuity = continuity;

    console.log('FUNCTIONAL PACKAGED UPDATE INSTALL VERIFIED');
    console.log('PRODUCTION AUTHENTICODE NOT VERIFIED LOCALLY');
    console.log(
      `source revision: ${sourceRevision}${worktreeStatus ? ' (worktree had uncommitted changes)' : ''}`,
    );
    console.log(`versions: ${UPDATE_E2E_VERSION_A} -> ${UPDATE_E2E_VERSION_B}`);
    console.log(`E2E product identity: ${UPDATE_INSTALL_E2E_PRODUCT_NAME}`);
    console.log(`install root: ${installRoot}`);
    console.log(`production install untouched: ${report.installIdentityProof.productionUntouched}`);
    console.log(`staged A: ${stagedA.files.join(', ')}`);
    console.log(`staged B: ${stagedB.files.join(', ')}`);
    console.log(`READY states: ${report.readyStates.join(' -> ')}`);
    console.log(`checkout-active deferral: ${JSON.stringify(report.checkoutActiveDeferral)}`);
    console.log(`install accepted: ${JSON.stringify(report.installAccepted)}`);
    console.log(`B started: ${JSON.stringify(report.bStart)}`);
    console.log('business-data preservation: PASS (0 discrepancies)');
    console.log(
      `receipt continuity: ${before.receiptCounterValue} -> ${continuity.value} (${continuity.receiptNumber})`,
    );
    console.log(`pending export job status after update: ${after.exportJob?.status}`);
    console.log(`schema version unchanged: ${before.schemaVersion} -> ${after.schemaVersion}`);
  } finally {
    try {
      const strandedPid = await findProcessIdByExePath(installedExePath).catch(() => null);
      if (strandedPid) await closeProcessById(strandedPid);
    } catch {
      /* best-effort */
    }
    if (installed) {
      try {
        if (existsSync(uninstallerPath)) {
          await runSilent(uninstallerPath, INSTALL_SEQUENCE_TIMEOUT_MS, process.env);
        }
      } catch (error) {
        console.error(`WARNING: E2E uninstall failed: ${error.message}`);
      }
    }
    if (feed) await feed.close();
    await cleanupRunRoot(runRoot);
  }
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
