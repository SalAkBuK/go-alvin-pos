// Post-packaging verification for the Go Phones POS foundation.
//
// Runs against `release/win-unpacked/` (produced by `npm run pack:win` /
// `npm run dist:win`) and asserts the invariants the adversarial review
// required us to keep proving on every packaged build:
//
//   1. the packaged app exists;
//   2. the native `better-sqlite3` binary is unpacked from the asar;
//   3. the packaged Electron runtime can actually `require('better-sqlite3')`
//      and call the SQLite Online Backup API (finding H1);
//   4. the packaged renderer HTML carries the production CSP, positioned
//      before the application bundle <script> (finding H3).
//
// Exits non-zero on any failure. No test framework, no new dependency:
// `@electron/asar` is already present via electron-builder.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile, listPackage } from '@electron/asar';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(repoRoot, 'release', 'win-unpacked');
const asarPath = join(appDir, 'resources', 'app.asar');
const unpackedRoot = join(appDir, 'resources', 'app.asar.unpacked');
const betterSqliteUnpacked = join(unpackedRoot, 'node_modules', 'better-sqlite3');

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const productName = pkg.build?.productName ?? pkg.name;
const exePath = join(appDir, `${productName}.exe`);

let failures = 0;
const pass = (msg) => console.log(`  PASS  ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.error(`  FAIL  ${msg}`);
};

console.log(`verify-packaging: inspecting ${appDir}`);

if (!existsSync(appDir)) {
  console.error(
    '\nrelease/win-unpacked not found. Run `npm run pack:win` (or `npm run dist:win`) first.',
  );
  process.exit(1);
}

// (1) packaged app present
if (existsSync(exePath)) pass(`packaged executable present (${productName}.exe)`);
else fail(`missing ${exePath}`);
if (existsSync(asarPath)) pass('resources/app.asar present');
else fail(`missing ${asarPath}`);

// (2) native better-sqlite3 binary is unpacked
const dotNodeFiles = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.node')) dotNodeFiles.push(full);
  }
};
if (existsSync(betterSqliteUnpacked)) {
  walk(betterSqliteUnpacked);
  const hasWinX64 = dotNodeFiles.some((f) => /win32-x64|build[\\/]Release/i.test(f));
  if (hasWinX64) {
    pass(
      `better-sqlite3 native binary unpacked (${dotNodeFiles.length} .node file(s), incl. win32-x64)`,
    );
  } else {
    fail(`no win32-x64 .node binary under ${betterSqliteUnpacked}`);
  }
} else {
  fail(`better-sqlite3 not unpacked from asar (expected ${betterSqliteUnpacked})`);
}

// (3) packaged runtime can load better-sqlite3 + expose the backup API
if (existsSync(exePath)) {
  const probe = [
    "const path = require('path');",
    "const bs3Dir = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'better-sqlite3');",
    'const Database = require(bs3Dir);',
    "const db = new Database(':memory:');",
    "db.pragma('journal_mode = WAL');",
    "const version = db.prepare('select sqlite_version() v').get().v;",
    "if (typeof db.backup !== 'function') { console.error('NO_BACKUP_API'); process.exit(3); }",
    'db.close();',
    "console.log('NATIVE_OK ' + version);",
  ].join(' ');
  try {
    const out = execFileSync(exePath, ['-e', probe], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (/NATIVE_OK \d+\.\d+\.\d+/.test(out)) {
      pass(`packaged Electron runtime loaded better-sqlite3 (${out.trim()})`);
    } else {
      fail(`packaged runtime probe returned unexpected output: ${out.trim()}`);
    }
  } catch (error) {
    fail(`packaged runtime could not load better-sqlite3: ${error.stderr || error.message}`);
  }
}

// (4) production CSP present in packaged renderer, before the bundle <script>
try {
  const html = extractFile(asarPath, join('out', 'renderer', 'index.html')).toString('utf8');
  const cspIndex = html.search(/<meta http-equiv="Content-Security-Policy"/i);
  const scriptIndex = html.search(/<script\b/i);

  if (cspIndex === -1) {
    fail('production CSP <meta> missing from packaged renderer HTML');
  } else if (scriptIndex !== -1 && cspIndex > scriptIndex) {
    fail('production CSP <meta> appears AFTER the bundle <script> in packaged renderer HTML');
  } else if (
    !/default-src 'self'/.test(html) ||
    !/script-src 'self'/.test(html) ||
    !/object-src 'none'/.test(html)
  ) {
    fail('production CSP <meta> present but missing expected directives');
  } else {
    pass('production CSP present and positioned before the bundle <script>');
  }
} catch (error) {
  fail(`could not read out/renderer/index.html from app.asar: ${error.message}`);
}

// (5) migrations are bundled into the packaged main process, not loose files.
// Phase 2A migrations are TypeScript modules compiled into out/main/index.js,
// so the canonical schema DDL + migration identity must be present in the bundle.
try {
  const mainBundle = extractFile(asarPath, join('out', 'main', 'index.js')).toString('utf8');
  const requiredTables = [
    'schema_migrations',
    'counters',
    'products',
    'customers',
    'sales',
    'sale_items',
    'payments',
    'inventory_movements',
    'settings',
    'google_sheet_export_jobs',
    'checkout_requests',
    'audit_events',
    'backup_records',
  ];
  const missingTables = requiredTables.filter(
    (table) => !mainBundle.includes(`CREATE TABLE ${table}`),
  );
  const hasMigrationIdentity =
    /initial_schema/.test(mainBundle) && /schema_migrations/.test(mainBundle);

  if (missingTables.length > 0) {
    fail(`packaged main bundle is missing CREATE TABLE for: ${missingTables.join(', ')}`);
  } else if (!hasMigrationIdentity) {
    fail('packaged main bundle does not contain the 001_initial_schema migration');
  } else {
    pass(
      `initial-schema migration bundled into packaged main process (${requiredTables.length} tables)`,
    );
  }
} catch (error) {
  fail(`could not read out/main/index.js from app.asar: ${error.message}`);
}

// (6) the packaged renderer bundle must not contain better-sqlite3 (REQ-DB-006).
// The renderer only ever talks to the narrow typed preload surface; the native
// module is a main-process concern.
try {
  const rendererAssets = listPackage(asarPath)
    .map((p) => p.replace(/^[\\/]/, ''))
    .filter((p) => {
      const norm = p.replace(/\\/g, '/');
      return norm.startsWith('out/renderer/') && /\.(js|mjs|cjs|html)$/.test(norm);
    });

  if (rendererAssets.length === 0) {
    fail('no renderer JS/HTML assets found in the packaged asar');
  } else {
    let bad = 0;
    for (const assetPath of rendererAssets) {
      const content = extractFile(asarPath, assetPath).toString('utf8');
      if (/better-sqlite3|bindings\.node|node_sqlite3/.test(content)) {
        fail(`renderer asset ${assetPath} references a native SQLite module`);
        bad += 1;
      }
    }
    if (bad === 0) {
      pass(
        `renderer bundle free of better-sqlite3 (${rendererAssets.length} JS/HTML asset(s) scanned)`,
      );
    }
  }
} catch (error) {
  fail(`could not scan renderer assets for native-module leakage: ${error.message}`);
}

console.log('');
if (failures > 0) {
  console.error(`verify-packaging: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('verify-packaging: all checks passed');
