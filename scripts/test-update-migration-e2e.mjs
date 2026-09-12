import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { access, mkdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
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
  assertSafeInstallRoot,
  captureBusinessEvidence,
  cleanupRunRoot,
  createRunRoot,
  findEvent,
  guardedLocalAppData,
  guardedProfilePath,
  installedAppLaunchEnvironment,
  lastApplicationStart,
  readAllLogRecords,
  seedFixture,
} from './update-install-e2e-lib.mjs';
import {
  E3_DELIBERATE_MIGRATION_FAILURE_MARKER,
  buildE3Environment,
  compareBusinessEvidenceThroughMigration,
  findPreMigrationBackupFiles,
  hasFailingSchema2Probe,
  hasSchema2Probe,
  obstructPreMigrationBackupDirectory,
  readMigrationAuditEvents,
  readPreMigrationBackupRecords,
  readSchemaMigrationsRows,
  verifyPreMigrationBackupIndependently,
} from './update-migration-e2e-lib.mjs';

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
const VERSION_A = '0.1.100';
const VERSION_B_SUCCESS = '0.1.102';
const VERSION_B_FAIL = '0.1.103';
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
  'CN=Go Phones POS Update Migration E2E',
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

async function buildVersion({
  runRoot,
  feedUrl,
  version,
  profile,
  sourceRevision,
  buildTimestamp,
  label,
  e3Mode,
}) {
  if (!NPM_CLI) throw new Error('Run the packaged update-migration E2E through its npm script.');
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
  const finalEnv = e3Mode ? buildE3Environment(env, profile, e3Mode) : env;
  delete finalEnv.CSC_LINK;
  delete finalEnv.CSC_KEY_PASSWORD;
  delete finalEnv.GO_PHONES_WINDOWS_PUBLISHER_NAME;
  console.log(`Building ${label} (${version}, e3Mode=${e3Mode ?? 'none'})...`);
  await run(process.execPath, [NPM_CLI, 'run', 'build'], { env: finalEnv });
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
      // See test-update-install-e2e.mjs's identical override: electron-
      // builder's per-user NSIS default install directory is named from
      // package.json's `name` field, not `productName`.
      `--config.extraMetadata.name=${UPDATE_INSTALL_E2E_PACKAGE_NAME}`,
    ],
    { env: finalEnv },
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

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Build A (schema-1, no E3 mode) and one B variant, BOTH embedding
 * `paths.profile` as their compile-time-baked userData profile, and both
 * built under `paths.runRoot` so `cleanupRunRoot(paths.runRoot)` removes
 * them together with the profile at the end of the scenario.
 *
 * Each scenario calls this with its OWN `paths` — the embedded profile is
 * baked in at build time (`__UPDATE_INSTALL_E2E_PROFILE__`), so builds
 * cannot be shared across scenarios that need their own isolated database;
 * an earlier version of this harness built once and reused the artifacts
 * across scenarios, which silently pointed every installed app at ONE
 * build-time profile while the harness kept checking a different,
 * never-written-to per-scenario path.
 */
async function buildScenarioBinaries({
  paths,
  feed,
  sourceRevision,
  buildTimestamp,
  versionB,
  e3ModeB,
  labelB,
}) {
  const buildADir = await buildVersion({
    runRoot: paths.runRoot,
    feedUrl: feed.feedUrl,
    version: VERSION_A,
    profile: paths.profile,
    sourceRevision,
    buildTimestamp,
    label: 'a',
    e3Mode: null,
  });
  const buildBDir = await buildVersion({
    runRoot: paths.runRoot,
    feedUrl: feed.feedUrl,
    version: versionB,
    profile: paths.profile,
    sourceRevision,
    buildTimestamp,
    label: labelB,
    e3Mode: e3ModeB,
  });
  const feedADir = join(paths.runRoot, 'feeds', 'a');
  const feedBDir = join(paths.runRoot, 'feeds', labelB);
  await stagePackagedFeed({ buildDir: buildADir, feedDir: feedADir, version: VERSION_A });
  await stagePackagedFeed({ buildDir: buildBDir, feedDir: feedBDir, version: versionB });
  return { buildADir, feedADir, feedBDir };
}

/** Genuinely install A, seed the fixture, and capture pre-update evidence.
 * Shared setup for all three scenarios (each with its own fresh runRoot).
 *
 * Path computation is split out into `createScenarioPaths()` and done BEFORE
 * any install/launch is attempted, specifically so a caller's try/finally
 * can call `cleanupScenario()` with the right paths even when installation
 * or seeding itself throws — an earlier version of this harness computed
 * these paths INSIDE `installAndSeedA()` and only returned them on success,
 * which leaked a real install and a temp profile the one time seeding
 * failed. */
async function createScenarioPaths(localAppDataReal) {
  // Check the install-root collision BEFORE allocating a temp runRoot: this
  // function throwing must never leak a `createRunRoot()` temp directory
  // that the caller's try/finally never gets a chance to see (an earlier
  // version created the runRoot first and leaked it on this exact throw).
  const installRoot = assertSafeInstallRoot(
    join(localAppDataReal, 'Programs', UPDATE_INSTALL_E2E_PACKAGE_NAME),
    localAppDataReal,
  );
  const installedExePath = join(installRoot, `${UPDATE_INSTALL_E2E_PRODUCT_NAME}.exe`);
  const uninstallerPath = join(installRoot, `Uninstall ${UPDATE_INSTALL_E2E_PRODUCT_NAME}.exe`);
  if (existsSync(installRoot)) {
    throw new Error(
      `E2E install root already exists (${installRoot}); a previous scenario did not clean up.`,
    );
  }

  const runRoot = await createRunRoot();
  const profile = guardedProfilePath(runRoot);
  const localAppDataE2e = guardedLocalAppData(runRoot);
  const dbFile = join(profile, 'gophones.sqlite');
  const logFile = join(profile, 'logs', 'main.log');
  return {
    runRoot,
    profile,
    localAppDataE2e,
    dbFile,
    logFile,
    installRoot,
    installedExePath,
    uninstallerPath,
  };
}

async function installAndSeedA({ buildA, tls, localAppDataReal, paths, feed, feedADir }) {
  const { runRoot, localAppDataE2e, dbFile, logFile, installedExePath } = paths;
  const productionInstallRoot = join(localAppDataReal, 'Programs', 'go-phones-pos');
  const productionExePath = join(productionInstallRoot, 'Go Phones POS.exe');
  const productionExisted = existsSync(productionInstallRoot);
  const productionHashBefore = productionExisted
    ? await hashFile(productionExePath).catch(() => null)
    : null;

  const installerA = installerPathFor(buildA, VERSION_A);
  await access(installerA);
  await runSilent(installerA, INSTALL_SEQUENCE_TIMEOUT_MS, process.env);
  await access(installedExePath);
  const productionUntouched =
    !productionExisted ||
    (await hashFile(productionExePath).catch(() => null)) === productionHashBefore;
  if (!productionUntouched) {
    throw new Error('Production install was touched by the E3 harness — aborting.');
  }
  console.log(`production install untouched: ${productionUntouched}`);

  await mkdir(localAppDataE2e, { recursive: true });
  // Point the seed launch at A's OWN feed (same version -> IDLE if its
  // 15-second scheduled check ever fires before we finish closing it) —
  // NOT an unreachable placeholder URL. An earlier version of this harness
  // used a bogus URL here; if closing took long enough for the scheduled
  // check to fire, it logged a real `update.failed` (`CHECK_FAILED`) into
  // this SAME shared, append-only log file. The next launch's own
  // `waitForUpdaterState` scans the log's CUMULATIVE state history, so that
  // stale FAILED state from the seed session poisoned the main run's own
  // READY wait even though the main run had barely started.
  feed.use(feedADir);
  const seedEnv = installedAppLaunchEnvironment(process.env, runRoot, feed.feedUrl);
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
  } catch (error) {
    const records = await readAllLogRecords(logFile).catch(() => []);
    console.error(
      `DIAGNOSTIC seed-launch log (${records.length} records):`,
      JSON.stringify(records, null, 2),
    );
    console.error(`DIAGNOSTIC seedChild.exitCode=${seedChild.exitCode}, pid=${seedChild.pid}`);
    throw error;
  } finally {
    if (seedChild.exitCode === null && seedChild.pid) {
      await closeProcessById(seedChild.pid);
    }
    if (seedChild.exitCode === null) {
      await once(seedChild, 'exit').catch(() => {});
    }
    // Node's own 'exit' event firing does not guarantee Electron's Windows
    // single-instance lock (a named mutex/pipe) has actually been released
    // yet — a real race observed empirically: the next launch silently
    // hands off to a not-quite-gone previous instance instead of starting
    // its own session. Poll process enumeration independently until truly
    // nothing with this exe path remains.
    await waitFor(
      async () => ((await findProcessIdByExePath(installedExePath)) === null ? true : null),
      30_000,
    );
  }
  await access(dbFile);

  const seeded = seedFixture(dbFile, { appVersion: VERSION_A });
  const before = captureBusinessEvidence(dbFile);

  return { ...paths, seeded, before, productionUntouched };
}

/** Point the real feed at B, relaunch installed A, reach READY, and drive the
 * real trusted install through the shared E2 compile-time trigger (the exact
 * same CHECKOUT_ACTIVE -> clear -> `restartAndInstall()` sequence E2 already
 * proved — E3 needs no new trigger). */
async function triggerRealUpdate({
  installedExePath,
  runRoot,
  profile,
  logFile,
  feed,
  feedDir,
  tls,
  versionB,
}) {
  feed.use(feedDir);
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

  let readyEvidence;
  try {
    readyEvidence = await waitForUpdaterState({
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
  } catch (error) {
    const records = await readAllLogRecords(logFile).catch(() => []);
    console.error(
      `DIAGNOSTIC main-run log (${records.length} records):`,
      JSON.stringify(records, null, 2),
    );
    console.error(`DIAGNOSTIC feed requests:`, JSON.stringify(feed.requests()));
    throw error;
  }
  const readyStates = assertReadyEvidence(readyEvidence, versionB);

  const diagnosticsDir = join(profile, 'diagnostics');
  await mkdir(diagnosticsDir, { recursive: true });
  await writeFile(join(diagnosticsDir, UPDATE_INSTALL_E2E_TRIGGER_FILE), '');

  await waitFor(async () => {
    const records = await readAllLogRecords(logFile);
    return findEvent(records, 'update.install-e2e.checkout-deferral').at(-1) ?? null;
  }, INSTALL_SEQUENCE_TIMEOUT_MS);

  const installResult = await waitFor(async () => {
    const records = await readAllLogRecords(logFile);
    return findEvent(records, 'update.install-e2e.install-result').at(-1) ?? null;
  }, INSTALL_SEQUENCE_TIMEOUT_MS + 5_000);
  if (installResult.context?.resultCode !== 'INSTALL_ACCEPTED') {
    throw new Error(`Trusted install was not accepted: ${JSON.stringify(installResult)}`);
  }

  await waitFor(async () => (mainChild.exitCode !== null ? true : null), APP_EXIT_TIMEOUT_MS);

  return { readyStates, installResult };
}

async function cleanupScenario({ runRoot, installRoot, installedExePath, uninstallerPath }) {
  try {
    const strandedPid = await findProcessIdByExePath(installedExePath).catch(() => null);
    if (strandedPid) await closeProcessById(strandedPid);
  } catch {
    /* best effort */
  }
  try {
    if (existsSync(uninstallerPath)) {
      await runSilent(uninstallerPath, INSTALL_SEQUENCE_TIMEOUT_MS, process.env);
      // The uninstaller process reporting exit 0 does not mean the install
      // directory is actually gone yet: NSIS uninstallers cannot delete
      // their own running .exe, so final directory removal is a deferred,
      // asynchronous self-delete that can lag briefly behind the process
      // exit — observed empirically as the very next scenario's
      // `createScenarioPaths()` finding the "already exists" guard tripped
      // on a directory that finishes disappearing moments later.
      await waitFor(async () => (!existsSync(installRoot) ? true : null), 30_000).catch(() => {
        console.error(`WARNING: E3 install root did not disappear after uninstall: ${installRoot}`);
      });
    }
  } catch (error) {
    console.error(`WARNING: E3 uninstall failed: ${error.message}`);
  }
  await cleanupRunRoot(runRoot);
}

// ── Scenario A: successful migration ──────────────────────────────────────
async function runSuccessScenario({ tls, feed, localAppDataReal, sourceRevision, buildTimestamp }) {
  console.log('\n=== Scenario A: successful migration ===');
  const paths = await createScenarioPaths(localAppDataReal);
  try {
    const { buildADir, feedADir, feedBDir } = await buildScenarioBinaries({
      paths,
      feed,
      sourceRevision,
      buildTimestamp,
      versionB: VERSION_B_SUCCESS,
      e3ModeB: 'success',
      labelB: 'b-success',
    });
    const setup = await installAndSeedA({
      buildA: buildADir,
      tls,
      localAppDataReal,
      paths,
      feed,
      feedADir,
    });
    const update = await triggerRealUpdate({
      installedExePath: setup.installedExePath,
      runRoot: setup.runRoot,
      profile: setup.profile,
      logFile: setup.logFile,
      feed,
      feedDir: feedBDir,
      tls,
      versionB: VERSION_B_SUCCESS,
    });

    const bStart = await waitFor(async () => {
      const records = await readAllLogRecords(setup.logFile);
      const start = lastApplicationStart(records);
      return start?.context?.version === VERSION_B_SUCCESS ? start : null;
    }, RELAUNCH_TIMEOUT_MS);
    if (bStart.context?.databaseReady !== true) {
      throw new Error('B (success) started without a ready database.');
    }
    const bPid = await findProcessIdByExePath(setup.installedExePath);
    if (!bPid) throw new Error('Could not locate the relaunched B (success) process.');

    // Pre-migration backup must exist and be independently valid BEFORE we
    // touch anything else.
    const backups = findPreMigrationBackupFiles(setup.profile);
    if (backups.length !== 1) {
      throw new Error(`Expected exactly 1 pre-migration backup, found ${backups.length}.`);
    }
    const backupVerification = verifyPreMigrationBackupIndependently(backups[0], setup.before);
    if (!backupVerification.ok) {
      throw new Error(
        `Pre-migration backup verification failed: ${backupVerification.problems.join('; ')}`,
      );
    }
    const backupRecords = readPreMigrationBackupRecords(setup.dbFile);
    if (backupRecords.length !== 1 || backupRecords[0].status !== 'COMPLETED') {
      throw new Error(
        `Expected exactly 1 COMPLETED PRE_MIGRATION backup_records row, got ${JSON.stringify(backupRecords)}`,
      );
    }
    if (backupRecords[0].source_schema_version !== 1) {
      throw new Error(
        `Backup record source_schema_version was ${backupRecords[0].source_schema_version}, expected 1.`,
      );
    }

    // Ordering: backup completion must precede migration-2 completion in the
    // log. The log also contains A's OWN unrelated `database.migration.completed`
    // for migration 1 from its earlier fresh-install bootstrap — filter to
    // version 2 specifically, not just the first completion event ever logged.
    const allRecords = await readAllLogRecords(setup.logFile);
    const backupVerifiedAt = findEvent(allRecords, 'database.pre-migration-backup.verified').at(
      0,
    )?.timestamp;
    const migrationCompletedAt = findEvent(allRecords, 'database.migration.completed').find(
      (r) => r.context?.version === 2,
    )?.timestamp;
    if (!backupVerifiedAt || !migrationCompletedAt || backupVerifiedAt >= migrationCompletedAt) {
      throw new Error(
        'Pre-migration backup did not provably complete before migration 2 completed.',
      );
    }

    const schemaRows = readSchemaMigrationsRows(setup.dbFile);
    if (schemaRows.length !== 2 || schemaRows[1].version !== 2) {
      throw new Error(
        `Expected exactly 2 schema_migrations rows ending at version 2, got ${JSON.stringify(schemaRows)}`,
      );
    }
    if (!hasSchema2Probe(setup.dbFile))
      throw new Error('Schema-2 success probe table is missing after migration.');

    const after = captureBusinessEvidence(setup.dbFile);
    const problems = compareBusinessEvidenceThroughMigration(setup.before, after);
    if (problems.length > 0) {
      throw new Error(
        `Business-data preservation through migration FAILED:\n${problems.join('\n')}`,
      );
    }
    const auditEvents = readMigrationAuditEvents(setup.dbFile);

    // Idempotence: close B, restart it once more, prove no re-migration / no second backup.
    await closeProcessById(bPid);
    await waitFor(
      async () => ((await findProcessIdByExePath(setup.installedExePath)) === null ? true : null),
      30_000,
    );

    const restartEnv = installedAppLaunchEnvironment(process.env, setup.runRoot, feed.feedUrl);
    const restartChild = spawn(
      setup.installedExePath,
      [`--ignore-certificate-errors-spki-list=${tls.spkiSha256}`],
      { cwd: REPO_ROOT, env: restartEnv, stdio: 'ignore', windowsHide: true },
    );
    const secondStart = await waitFor(async () => {
      if (restartChild.exitCode !== null)
        throw new Error('B (success) restart exited unexpectedly.');
      const records = await readAllLogRecords(setup.logFile);
      const starts = records.filter(
        (r) => r.event === 'application.started' && r.context?.version === VERSION_B_SUCCESS,
      );
      return starts.length >= 2 ? starts[starts.length - 1] : null;
    }, RELAUNCH_TIMEOUT_MS);
    if (secondStart.context?.databaseReady !== true)
      throw new Error('Second B (success) restart was not database-ready.');
    await closeProcessById(restartChild.pid);
    await waitFor(async () => (restartChild.exitCode !== null ? true : null), 30_000);

    const backupsAfterRestart = findPreMigrationBackupFiles(setup.profile);
    const schemaRowsAfterRestart = readSchemaMigrationsRows(setup.dbFile);
    if (backupsAfterRestart.length !== 1) {
      throw new Error(
        `A clean restart created ${backupsAfterRestart.length} pre-migration backups, expected exactly 1 (no re-migration).`,
      );
    }
    if (schemaRowsAfterRestart.length !== 2) {
      throw new Error(
        `A clean restart changed schema_migrations to ${schemaRowsAfterRestart.length} rows, expected 2.`,
      );
    }

    console.log(
      'SUCCESS scenario: schema 1 -> 2, backup verified, data preserved, idempotent restart confirmed.',
    );
    return {
      readyStates: update.readyStates,
      backupRecords,
      backupVerification,
      schemaRows,
      auditEvents,
      receiptCounterValue: after.receiptCounterValue,
      exportJobStatus: after.exportJob?.status,
    };
  } finally {
    await cleanupScenario({
      runRoot: paths.runRoot,
      installRoot: paths.installRoot,
      installedExePath: paths.installedExePath,
      uninstallerPath: paths.uninstallerPath,
    });
  }
}

// ── Scenario B: migration APPLY failure ────────────────────────────────────
async function runApplyFailureScenario({
  tls,
  feed,
  localAppDataReal,
  sourceRevision,
  buildTimestamp,
}) {
  console.log('\n=== Scenario B: migration apply failure ===');
  const paths = await createScenarioPaths(localAppDataReal);
  try {
    const { buildADir, feedADir, feedBDir } = await buildScenarioBinaries({
      paths,
      feed,
      sourceRevision,
      buildTimestamp,
      versionB: VERSION_B_FAIL,
      e3ModeB: 'fail',
      labelB: 'b-fail',
    });
    const setup = await installAndSeedA({
      buildA: buildADir,
      tls,
      localAppDataReal,
      paths,
      feed,
      feedADir,
    });
    await triggerRealUpdate({
      installedExePath: setup.installedExePath,
      runRoot: setup.runRoot,
      profile: setup.profile,
      logFile: setup.logFile,
      feed,
      feedDir: feedBDir,
      tls,
      versionB: VERSION_B_FAIL,
    });

    const bStart = await waitFor(async () => {
      const records = await readAllLogRecords(setup.logFile);
      const start = lastApplicationStart(records);
      return start?.context?.version === VERSION_B_FAIL ? start : null;
    }, RELAUNCH_TIMEOUT_MS);
    if (bStart.context?.databaseReady !== false) {
      throw new Error('B (fail) unexpectedly reported a ready database.');
    }

    const allRecords = await readAllLogRecords(setup.logFile);
    const failureLog = findEvent(allRecords, 'database.migration.failed').at(0);
    if (
      !failureLog ||
      !String(failureLog.context?.error ?? '').includes(E3_DELIBERATE_MIGRATION_FAILURE_MARKER)
    ) {
      throw new Error(
        `Expected a database.migration.failed record carrying the deliberate marker, got ${JSON.stringify(failureLog)}`,
      );
    }
    const initFailure = findEvent(allRecords, 'database.initialization-failed').at(-1);
    if (!initFailure)
      throw new Error('Expected a database.initialization-failed record after migration failure.');

    const schemaRows = readSchemaMigrationsRows(setup.dbFile);
    if (schemaRows.length !== 1 || schemaRows[0].version !== 1) {
      throw new Error(
        `Schema advanced past 1 after a failed migration: ${JSON.stringify(schemaRows)}`,
      );
    }
    if (hasFailingSchema2Probe(setup.dbFile)) {
      throw new Error(
        'The failing migration left its probe table behind — transaction did not roll back.',
      );
    }

    const backups = findPreMigrationBackupFiles(setup.profile);
    if (backups.length !== 1)
      throw new Error(`Expected exactly 1 pre-migration backup, found ${backups.length}.`);
    const backupVerification = verifyPreMigrationBackupIndependently(backups[0], setup.before);
    if (!backupVerification.ok) {
      throw new Error(
        `Pre-migration backup verification failed: ${backupVerification.problems.join('; ')}`,
      );
    }
    const backupRecords = readPreMigrationBackupRecords(setup.dbFile);
    if (backupRecords.length !== 1 || backupRecords[0].status !== 'COMPLETED') {
      throw new Error(
        `Expected the PRE_MIGRATION backup to remain COMPLETED, got ${JSON.stringify(backupRecords)}`,
      );
    }

    const after = captureBusinessEvidence(setup.dbFile);
    const problems = compareBusinessEvidenceThroughMigration(setup.before, after);
    if (problems.length > 0) {
      throw new Error(`Business data changed despite a failed migration:\n${problems.join('\n')}`);
    }

    // Section 19: one controlled restart of the failed build. The B process
    // that just failed migration (relaunched by NSIS after quitAndInstall)
    // is still running and still holds the single-instance lock — it must
    // be closed first, or the "restart" below silently hands off to it
    // instead of starting a real new session (the same class of bug as the
    // success scenario's own idempotence restart already guards against).
    const firstBPid = await findProcessIdByExePath(setup.installedExePath);
    if (firstBPid) {
      await closeProcessById(firstBPid);
      await waitFor(
        async () => ((await findProcessIdByExePath(setup.installedExePath)) === null ? true : null),
        30_000,
      );
    }
    const restartEnv = installedAppLaunchEnvironment(process.env, setup.runRoot, feed.feedUrl);
    const restartChild = spawn(
      setup.installedExePath,
      [`--ignore-certificate-errors-spki-list=${tls.spkiSha256}`],
      { cwd: REPO_ROOT, env: restartEnv, stdio: 'ignore', windowsHide: true },
    );
    const secondStart = await waitFor(async () => {
      const records = await readAllLogRecords(setup.logFile);
      const starts = records.filter(
        (r) => r.event === 'application.started' && r.context?.version === VERSION_B_FAIL,
      );
      return starts.length >= 2 ? starts[starts.length - 1] : null;
    }, RELAUNCH_TIMEOUT_MS);
    const secondSchemaRows = readSchemaMigrationsRows(setup.dbFile);
    const secondBackups = findPreMigrationBackupFiles(setup.profile);
    const afterRestart = captureBusinessEvidence(setup.dbFile);
    const restartProblems = compareBusinessEvidenceThroughMigration(setup.before, afterRestart);
    await closeProcessById(
      restartChild.pid ?? (await findProcessIdByExePath(setup.installedExePath)),
    );
    await waitFor(
      async () => ((await findProcessIdByExePath(setup.installedExePath)) === null ? true : null),
      30_000,
    );

    if (secondStart.context?.databaseReady !== false) {
      throw new Error('A restart of the failed B build unexpectedly reported a ready database.');
    }
    if (secondSchemaRows.length !== 1) {
      throw new Error(
        `A restart of the failed build advanced schema to ${JSON.stringify(secondSchemaRows)}.`,
      );
    }
    if (restartProblems.length > 0) {
      throw new Error(
        `Business data changed across a restart of the failed build:\n${restartProblems.join('\n')}`,
      );
    }

    console.log(
      `APPLY FAILURE scenario: backup preserved, schema stayed 1, DB unavailable, data intact. ` +
        `Restart attempted migration again (now ${secondBackups.length} backups on disk) and failed safely again — ` +
        'current architecture retries every startup; no retry-limit policy exists or was added.',
    );
    return {
      schemaRows,
      backupRecords,
      backupVerification,
      failureLog,
      initFailure,
      secondBackupCount: secondBackups.length,
    };
  } finally {
    await cleanupScenario({
      runRoot: paths.runRoot,
      installRoot: paths.installRoot,
      installedExePath: paths.installedExePath,
      uninstallerPath: paths.uninstallerPath,
    });
  }
}

// ── Scenario C: pre-migration BACKUP failure ───────────────────────────────
async function runBackupFailureScenario({
  tls,
  feed,
  localAppDataReal,
  sourceRevision,
  buildTimestamp,
}) {
  console.log('\n=== Scenario C: pre-migration backup failure ===');
  const paths = await createScenarioPaths(localAppDataReal);
  try {
    const { buildADir, feedADir, feedBDir } = await buildScenarioBinaries({
      paths,
      feed,
      sourceRevision,
      buildTimestamp,
      versionB: VERSION_B_SUCCESS,
      e3ModeB: 'success',
      labelB: 'b-success',
    });
    const setup = await installAndSeedA({
      buildA: buildADir,
      tls,
      localAppDataReal,
      paths,
      feed,
      feedADir,
    });
    obstructPreMigrationBackupDirectory(setup.profile);

    await triggerRealUpdate({
      installedExePath: setup.installedExePath,
      runRoot: setup.runRoot,
      profile: setup.profile,
      logFile: setup.logFile,
      feed,
      feedDir: feedBDir,
      tls,
      versionB: VERSION_B_SUCCESS,
    });

    const bStart = await waitFor(async () => {
      const records = await readAllLogRecords(setup.logFile);
      const start = lastApplicationStart(records);
      return start?.context?.version === VERSION_B_SUCCESS ? start : null;
    }, RELAUNCH_TIMEOUT_MS);
    if (bStart.context?.databaseReady !== false) {
      throw new Error('B unexpectedly reported a ready database despite the backup obstruction.');
    }

    const allRecords = await readAllLogRecords(setup.logFile);
    const backupFailure = findEvent(allRecords, 'database.pre-migration-backup.failed').at(0);
    if (!backupFailure) throw new Error('Expected a database.pre-migration-backup.failed record.');
    // A's OWN earlier fresh-install bootstrap also logs `database.migration.started`
    // (for migration 1) — filter to version 2 specifically, the only one this
    // scenario cares never starts.
    const migrationStarted = findEvent(allRecords, 'database.migration.started').filter(
      (r) => r.context?.version === 2,
    );
    if (migrationStarted.length > 0) {
      throw new Error('Migration 2 started despite the pre-migration backup failing.');
    }

    const schemaRows = readSchemaMigrationsRows(setup.dbFile);
    if (schemaRows.length !== 1 || schemaRows[0].version !== 1) {
      throw new Error(
        `Schema advanced despite a backup-gate failure: ${JSON.stringify(schemaRows)}`,
      );
    }
    if (hasSchema2Probe(setup.dbFile))
      throw new Error('Schema-2 probe exists despite the migration never starting.');

    const backupRecords = readPreMigrationBackupRecords(setup.dbFile);
    if (backupRecords.length !== 1 || backupRecords[0].status !== 'FAILED') {
      throw new Error(
        `Expected exactly 1 FAILED PRE_MIGRATION backup_records row, got ${JSON.stringify(backupRecords)}`,
      );
    }
    if (!backupRecords[0].error_code)
      throw new Error('FAILED backup_records row is missing an error_code.');

    const after = captureBusinessEvidence(setup.dbFile);
    const problems = compareBusinessEvidenceThroughMigration(setup.before, after);
    if (problems.length > 0) {
      throw new Error(
        `Business data changed despite a backup-gate failure:\n${problems.join('\n')}`,
      );
    }

    console.log(
      'BACKUP FAILURE scenario: migration never started, schema stayed 1, DB unavailable, data intact.',
    );
    return { backupRecords, backupFailure, schemaRows };
  } finally {
    await cleanupScenario({
      runRoot: paths.runRoot,
      installRoot: paths.installRoot,
      installedExePath: paths.installedExePath,
      uninstallerPath: paths.uninstallerPath,
    });
  }
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('Packaged update-migration E2E requires Windows.');
  }
  const localAppDataReal = process.env.LOCALAPPDATA;
  if (!localAppDataReal) throw new Error('Real %LOCALAPPDATA% is required to install/uninstall.');

  validateUpdateVersionPair(VERSION_A, VERSION_B_SUCCESS);
  validateUpdateVersionPair(VERSION_A, VERSION_B_FAIL);

  const sourceRevision = (await gitOutput('rev-parse', 'HEAD')).trim();
  const worktreeStatus = await gitOutput('status', '--porcelain');
  const buildTimestamp = new Date().toISOString();

  let feed = null;
  const results = {};
  try {
    const tls = await createLoopbackCertificate();
    feed = await createFeedServer(tls);

    // Each scenario builds its OWN A + B pair against its OWN isolated
    // profile (see `buildScenarioBinaries()`'s docstring for why artifacts
    // cannot be shared across scenarios here) and cleans up fully before the
    // next one starts — no scenario ever runs concurrently with another.
    results.success = await runSuccessScenario({
      tls,
      feed,
      localAppDataReal,
      sourceRevision,
      buildTimestamp,
    });
    results.applyFailure = await runApplyFailureScenario({
      tls,
      feed,
      localAppDataReal,
      sourceRevision,
      buildTimestamp,
    });
    results.backupFailure = await runBackupFailureScenario({
      tls,
      feed,
      localAppDataReal,
      sourceRevision,
      buildTimestamp,
    });

    console.log('\nFUNCTIONAL PACKAGED MIGRATION SAFETY E2E VERIFIED');
    console.log('PRODUCTION AUTHENTICODE NOT VERIFIED LOCALLY');
    console.log(
      `source revision: ${sourceRevision}${worktreeStatus ? ' (worktree had uncommitted changes)' : ''}`,
    );
    console.log(`versions: A=${VERSION_A} success-B=${VERSION_B_SUCCESS} fail-B=${VERSION_B_FAIL}`);
    console.log(`SUCCESS: ready states ${results.success.readyStates.join(' -> ')}`);
    console.log(`SUCCESS: backup records ${JSON.stringify(results.success.backupRecords)}`);
    console.log(`SUCCESS: schema rows ${JSON.stringify(results.success.schemaRows)}`);
    console.log(
      `SUCCESS: receipt counter ${results.success.receiptCounterValue}, export job ${results.success.exportJobStatus}`,
    );
    console.log(`APPLY FAILURE: schema rows ${JSON.stringify(results.applyFailure.schemaRows)}`);
    console.log(
      `APPLY FAILURE: backup records ${JSON.stringify(results.applyFailure.backupRecords)}`,
    );
    console.log(
      `APPLY FAILURE: restart attempted migration again -> ${results.applyFailure.secondBackupCount} backups on disk`,
    );
    console.log(
      `BACKUP FAILURE: backup records ${JSON.stringify(results.backupFailure.backupRecords)}`,
    );
    console.log(`BACKUP FAILURE: schema rows ${JSON.stringify(results.backupFailure.schemaRows)}`);
  } finally {
    if (feed) await feed.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
