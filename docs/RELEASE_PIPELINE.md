# Production Release Pipeline

This runbook implements the production mechanics required by
`UPDATE_RELEASE_STRATEGY.md`; it does not select or upload to a hosting vendor.

## Release identity

The repository may remain on a development prerelease such as
`0.1.0-foundation` until the first production version is chosen. A production
candidate requires all of the following to agree:

- `GO_PHONES_RELEASE_VERSION=X.Y.Z`
- `GO_PHONES_RELEASE_TAG=vX.Y.Z`
- the tag points at the clean checked-out `HEAD`
- `GO_PHONES_BUILD_SOURCE_REVISION` is that same commit SHA (CI supplies it)
- the packaged application, installer name, and `latest.yml` all report `X.Y.Z`

The release build embeds version, source SHA, build timestamp, and target schema
version in the main-process bundle. The installed application reads these
constants without Git or a source checkout.

## Signing contract

`npm run release:win` fails before running release gates unless the secure build
environment provides:

- `CSC_LINK`: electron-builder-supported certificate path/URL/base64 material
- `CSC_KEY_PASSWORD`: its password
- `GO_PHONES_WINDOWS_PUBLISHER_NAME`: the certificate's exact simple publisher
  name (non-secret)

Signing material must be held in CI secrets or an equivalent secure environment.
It is never copied to build output, app bundles, or the staged feed. The GitHub
workflow maps `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` secrets to the standard
electron-builder variables. Verification uses Windows
`Get-AuthenticodeSignature` and requires `Valid` status plus the configured
publisher on both the installer and packaged application executable.

## Feed and publication boundary

`GO_PHONES_UPDATE_FEED_URL` is required for production and must be HTTPS, contain
no embedded credentials, and not use the local `.invalid` fallback. The client
remains configured for electron-updater's `generic` provider.

After gates and packaging, the version-isolated `release-feed/X.Y.Z/` directory
is recreated with only:

- `latest.yml`
- `Go Phones POS Setup X.Y.Z.exe`
- `Go Phones POS Setup X.Y.Z.exe.blockmap`

`npm run verify:release` verifies package/metadata/version/SHA consistency,
generic feed configuration, bundled source identity, native packaging, and
Authenticode signatures. The tag workflow retains this directory as a CI
artifact for an operator-controlled upload to the independently configured
static HTTPS host. It does not publish automatically. A defective candidate can
therefore be stopped before exposure; an exposed bad feed entry is withdrawn or
superseded operationally, with a higher signed SemVer as the normal correction.
No automatic rollback is implemented.

For unsigned local packaging checks, `npm run stage:release:test` followed by
`npm run verify:release:test` exercises the same artifact and allowlist checks
but explicitly skips—without claiming—production signature validity.
