# CaoGen 0.1.7 Candidate Release Gate

> Updated: 2026-07-23 Asia/Shanghai. v0.1.6 remains the latest public release.
> Package version 0.1.7 is a candidate, not a publication decision or 1.0 stable.

## Current Decision

CaoGen remains positioned as a multi-vendor AI work desktop. This gate permits only
claims supported by the exact 0.1.7 candidate evidence.

| Item | State |
|---|---|
| Latest public GitHub Release | [`v0.1.6`](https://github.com/ChaoYuZhang001/CaoGen/releases/tag/v0.1.6) |
| Package and lockfile | `0.1.7` |
| Formal 1.0 product acceptance | 21/64 P0 verified; 43 open; not required for a truthful 0.1.x wedge release |
| Clean Deep | `153/153` required pass; 3 optional skip; latest report bound to clean commit `7035a6c5`; final candidate rerun pending |
| Release identity | Ready for version 0.1.7 on a clean commit |
| macOS preflight | Developer ID identity present; notarization configuration missing in the current process |
| Native arm64 | Open; current host is Intel and cannot provide Apple Silicon runtime evidence |
| Release decision | `not_ready`; `packaging_release` and `release_notes` remain open |

## Required Before 0.1.7

| Gate | Required command or evidence | Current status |
|---|---|---|
| Final identity | Exact merged clean commit with package and lockfile at 0.1.7 | Rerun after merge |
| Clean Deep | `npm run test:deep` on the exact final commit | Branch evidence passes; final merge binding pending |
| Secret history | `npm run secret:scan:history` | Passes on the branch; rerun before publication |
| Product positioning | `npm run test:product-positioning:required` | Ready |
| macOS x64 preflight | `npm run release:mac:preflight:x64` | Blocked only by missing notarization configuration |
| macOS x64 release | `npm run dist:mac:release:x64` and required macOS audit | Open; local signed baseline lacks notarization, staple, Gatekeeper acceptance, and build provenance |
| macOS arm64 release | Native Apple Silicon build, install, launch, and required audit | External hardware required |
| Windows x64 release | Signed native build plus install and launch evidence | External Windows/signing lane required |
| Packaging/runtime | Required packaging audit and packaged-app launch against exact assets | Open for 0.1.7 |
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
- Do not print, persist, stage, or upload certificate contents, passwords, API private
  keys, app-specific passwords, or notarization profile values.

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
- A real secret, certificate, private key, signing material, `.env`, `test-results`,
  `out`, `dist`, `node_modules`, or local evidence pack is staged or uploaded.
- Release copy presents 0.1.7 as 1.0 stable or claims an unverified external condition.
- The refreshed Release Doctor is not `ready`.
