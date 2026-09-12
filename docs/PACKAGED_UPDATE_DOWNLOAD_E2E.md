# Packaged Update Download E2E (Phase 2N-E1)

Run the Windows-only, intentionally expensive packaged updater check with:

```powershell
npm run test:update:e2e:download
```

This is a functional test of the existing production updater boundary. It does
not add a renderer control channel, change the production feed protocol, weaken
production TLS, install an update, restart the application, or exercise schema
migration behavior.

## Architecture

The harness requires a clean Git worktree, records `HEAD` and its commit time,
and builds two genuine electron-builder NSIS outputs from that same source:

- packaged A: `0.1.100`
- packaged B: `0.1.101`

Those versions are injected only through electron-builder `extraMetadata` and
the existing build-identity environment contract. `package.json` and Git tags
are never rewritten. Each output must contain electron-builder's genuine
`latest.yml`, installer, and blockmap. The existing release staging validator
checks the metadata, size, SHA-512, and allowlist before the feed serves them.

The harness creates an in-memory, short-lived self-signed certificate and a
static HTTPS server bound only to `127.0.0.1` on an ephemeral port. Only the
packaged child receives Chromium's SPKI exception for that exact certificate.
The OS trust store and the application's production TLS behavior are unchanged.
The server implements `GET`, `HEAD`, and byte ranges and records only bounded
method/path/status/range evidence; it never records request headers.

## Data isolation

Every scenario gets a unique temporary `LOCALAPPDATA` and `APPDATA`. Production
code still derives its fixed `%LOCALAPPDATA%\GoPhonesPOS` path in the normal
way, so the SQLite database, logs, Electron preferences, and electron-updater
cache all remain under the scenario's temporary profile. The harness verifies
that the isolated database exists. It never supplies, reads, or writes the
operator's real POS data directory.

Cleanup refuses to recursively remove anything except a direct child of the OS
temporary directory carrying the dedicated `gpp-update-download-e2e-` prefix.
Applications are closed through their main window; an exact-PID process-tree
termination is retained only as failure cleanup. The temporary certificate,
feeds, packaged outputs, databases, logs, profiles, and updater caches are then
removed.

## Scenarios and evidence

The harness launches the real packaged A executable (`app.isPackaged === true`)
four times with separate profiles and observes the existing structured
`main.log` events:

1. A feed for A: metadata is requested and the updater returns `IDLE`, without
   requesting an installer or blockmap.
2. A feed for B: the real `electron-updater` reaches `CHECKING`, `AVAILABLE`,
   `DOWNLOADING`, and `READY`; the server observes B metadata, blockmap, and
   installer traffic.
3. B metadata with artifacts denied: the app remains alive and reports the
   normalized `FAILED` state after an artifact request receives `404`.
4. Feed unavailable: the app remains alive and reports normalized `FAILED`.

The successful scenario must still be alive at `READY`. The harness never calls
the install IPC or updater install primitive. It rejects any `update.install.*`
event and confirms packaged A's executable hash did not change. Normal shutdown
also cannot install because the production adapter keeps
`autoInstallOnAppQuit = false`.

The command prints request/state summaries, the source revision, both test-only
versions, the unchanged canonical package version, and these exact qualification
statements when successful:

```text
FUNCTIONAL PACKAGED UPDATE DOWNLOAD VERIFIED
PRODUCTION SIGNATURE NOT VERIFIED LOCALLY
```

Unsigned local artifacts prove discovery and download behavior only. Production
release signing and publisher verification remain governed by the release
pipeline and are not weakened or claimed by this E2E.
