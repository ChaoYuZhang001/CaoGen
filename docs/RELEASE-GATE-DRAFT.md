# CaoGen 0.1.7 Candidate Release Gate

> Updated: 2026-07-24 Asia/Shanghai. v0.1.6 remains the latest public release.
> Package version 0.1.7 is a candidate, not a publication decision or 1.0 stable.

## Current Decision

CaoGen remains positioned as a multi-vendor AI work desktop. This gate permits only
claims supported by the exact 0.1.7 candidate evidence.

| Item | State |
|---|---|
| Latest public GitHub Release | [`v0.1.6`](https://github.com/ChaoYuZhang001/CaoGen/releases/tag/v0.1.6) |
| Package and lockfile | `0.1.7` |
| Formal 1.0 product acceptance | 21/64 P0 verified; 43 open; not required for a truthful 0.1.x wedge release |
| Clean Deep | Latest clean-main report passes `156/156` required checks with 3 optional skips; the report itself is the source of truth for the exact commit, and any new commit invalidates that binding |
| Release identity | Package and lockfile are 0.1.7; workflow dispatch binds and verifies one exact 40-character SHA already present on `main` |
| P2 release scope | P2-002, P2-003, and P2-005 are proved; P2-001 Windows GUI and P2-004 China external evidence remain unclaimed, non-blocking boundaries |
| macOS preflight | Developer ID identity present; notarization configuration missing in the current process |
| Native arm64 | Open; current host is Intel and cannot provide Apple Silicon runtime evidence |
| Windows release config | Pass; NSIS and mandatory code signing are configured, but native signed artifacts are absent |
| Platform matrix | macOS x64, macOS arm64, and Windows x64 each require distribution plus native install/renderer evidence; incomplete |
| Candidate workflow | Manual-only, read-only workflow implemented; no credential-backed run exists and required repository secrets are not configured yet |
| Release decision | `not_ready`; `packaging_release` and `release_notes` remain open |

## Required Before 0.1.7

| Gate | Required command or evidence | Current status |
|---|---|---|
| Final identity | Exact clean `main` commit with package and lockfile at 0.1.7 | Select the full SHA at dispatch; candidate preflight verifies reachability, version, and clean identity |
| Clean Deep | `npm run test:deep` on the exact final commit | Latest clean-main run passes; rerun in the x64 candidate lane and after any source or documentation commit |
| Secret history | `npm run secret:scan:history` | Passes on clean `main`; rerun inside the refreshed Doctor before publication |
| P2 release scope | P2-002, P2-003, and P2-005 proved on the candidate commit | Ready; do not claim P2-001 or P2-004 until their separate external gates pass |
| Product positioning | `npm run test:product-positioning:required` | Ready |
| macOS x64 preflight | `npm run release:mac:preflight:x64` | Blocked only by missing notarization configuration |
| macOS x64 release | `npm run dist:mac:release:x64` and required macOS audit | Open; local signed baseline lacks notarization, staple, Gatekeeper acceptance, and build provenance |
| macOS arm64 release | Native Apple Silicon build, install, launch, and required audit | External hardware required |
| Windows x64 release | Signed native build plus install and launch evidence | External Windows/signing lane required |
| Candidate workflow | Dispatch `.github/workflows/release-candidate-evidence.yml` with the exact full `main` SHA and version | Implemented; real credential-backed run pending |
| Packaging/runtime | Required packaging audit over all 12 assets plus per-platform installed-app launch | Open for 0.1.7 |
| Final notes | Exact uploaded names, SHA256 values, platforms, signing state, and residual risks | Draft only |
| Final Doctor | Required refreshed Doctor for version 0.1.7 | `not_ready` until packaging and notes close |
| Public asset audit | Post-upload audit for tag v0.1.7 and exact local asset set | No v0.1.7 release exists |

## macOS Distribution Contract

- Preview builds never satisfy the signed release gate.
- Formal builds use `electron-builder.release.cjs`, Developer ID signing, Hardened
  Runtime, explicit entitlements, notarization, stapling, and macOS 14 or newer.
- Every 0.1.7+ formal app, DMG payload, and ZIP payload must embed the same schema,
  full Git commit, clean-worktree state, and package version; the required audit binds
  that provenance to the current commit and exact uploadable artifact-set digest.
- x64 and arm64 are separate assets. Embedded arm64 binaries do not prove an arm64 app
  ran on Apple Silicon.
- macOS signing retries only transient Apple timestamp-service failures, at most five
  attempts. Certificate, entitlement, Keychain, and other signing errors fail immediately.
- Do not print, persist, stage, or upload certificate contents, passwords, API private
  keys, app-specific passwords, or notarization profile values.

## Cross-platform Distribution Contract

- The complete upload set is 12 assets: four macOS x64 assets, four macOS arm64
  assets, three Windows x64 assets, and shared `latest-mac.yml`.
- Windows x64 requires PE x64 validation, NSIS output, valid timestamped Authenticode
  signatures on both the unpacked app and installer, and a native silent-install,
  renderer-start, uninstall, and cleanup record.
- Every platform report must bind the exact package version, clean Git commit, build
  provenance, target architecture, and that platform's artifact-set digest.
- The aggregate job must recalculate every downloaded asset digest, generate and parse
  one shared dual-architecture `latest-mac.yml`, require the exact-commit Deep report,
  and pass the complete packaging audit before it can upload an unpublished candidate bundle.

## Manual Candidate Workflow

The workflow is intentionally separate from publication. It accepts only
`workflow_dispatch`, has repository `contents: read` permission, pins every action by
full commit, and requires the selected 40-character SHA to already be reachable from
`origin/main`. It never creates a tag, GitHub Release, or public update entry.

Required GitHub Actions repository secrets:

- `MACOS_CERTIFICATE_P12_BASE64` and `MACOS_CERTIFICATE_PASSWORD`
- `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`
- `WINDOWS_CERTIFICATE_P12_BASE64` and `WINDOWS_CERTIFICATE_PASSWORD`

The certificate values are base64-encoded PKCS#12 payloads; the Apple API value is the
complete private `.p8` text. They are materialized only under the ephemeral runner temp
directory, removed in `always()` cleanup steps, and never included in artifacts or
reports. A missing value fails its native lane before packaging.

Configure the values under repository **Settings -> Secrets and variables -> Actions**.
Verify only the secret names with `gh secret list`; never print secret values into shell
output, issues, pull requests, reports, or chat. The current workflow needs all seven
names above before dispatch because all three native lanes are required.

For a local macOS x64 notarization run, the preflight accepts one of these complete
credential methods:

- App Store Connect API key: `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and
  `APPLE_API_ISSUER`.
- Apple ID: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`.
- A Keychain profile created by `xcrun notarytool store-credentials`, selected through
  `APPLE_KEYCHAIN_PROFILE`.

Run `npm run release:mac:preflight:x64` before packaging. It authenticates with Apple
without emitting credential values and fails closed when the Developer ID identity,
notarization method, commit provenance, or worktree cleanliness is missing.

Run the workflow only after the intended commit is on `main`. Its final artifact is
named `caogen-unpublished-candidate-<version>-<commit>` and expires after 14 days. A
successful workflow proves the candidate evidence matrix, not publication approval;
the final release notes, required Doctor, explicit owner release decision, tag, upload,
and post-upload audit remain separate steps.

Dispatch command after all seven secret names are present:

```bash
gh workflow run release-candidate-evidence.yml \
  --ref main \
  -f commit=<full-40-character-main-sha> \
  -f version=0.1.7
```

## Release Notes Contract

The final GitHub Releases body must list the exact uploaded assets and SHA256 values,
supported platforms, signing/notarization state, minimum OS, conditional external
requirements, and residual risks. It must not upgrade local tests, optional skips,
roadmap work, or unavailable platform evidence into released capability.

## Stop Conditions

- Any required check fails, blocks, or is reclassified as optional to bypass the gate.
- The worktree is dirty or the version/commit changes after evidence is generated.
- A macOS asset is unsigned, lacks Hardened Runtime, is not notarized/stapled, or fails
  Gatekeeper and packaged launch audit.
- A platform asset is uploaded without native install and runtime evidence.
- Any macOS x64, macOS arm64, or Windows x64 distribution/install report is missing,
  stale, from the wrong architecture, or bound to another commit or artifact digest.
- A real secret, certificate, private key, signing material, `.env`, `test-results`,
  `out`, `dist`, `node_modules`, or local evidence pack is staged or uploaded.
- Release copy presents 0.1.7 as 1.0 stable or claims an unverified external condition.
- The refreshed Release Doctor is not `ready`.
