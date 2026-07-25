# CaoGen 0.1.7 Intel Release Gate

> Updated: 2026-07-25 Asia/Shanghai. v0.1.6 remains the latest public release until an explicit v0.1.7 publication action succeeds.
> Package version 0.1.7 is an Intel-only signed candidate, not 1.0 stable.

## Current Decision

CaoGen remains a multi-vendor AI work desktop. This gate permits only capabilities and platforms bound to the exact v0.1.7 Intel candidate evidence.

| Item | State |
|---|---|
| Latest public GitHub Release | [`v0.1.6`](https://github.com/ChaoYuZhang001/CaoGen/releases/tag/v0.1.6) |
| Package and lockfile | `0.1.7` |
| Current M1 platform scope | macOS Intel x64 only; Apple Silicon and Windows are paused and are not counted as passes |
| Candidate identity | `main@bbec526554aea9785291edf4d8164084145347ae` |
| Candidate workflow | [`30162696430`](https://github.com/ChaoYuZhang001/CaoGen/actions/runs/30162696430), read-only `macos-x64` evidence run |
| Exact-commit Deep | `159 total / 157 required pass / 2 optional skip / 0 blocked / 0 fail` |
| macOS distribution | `120/120` required audit; Developer ID signing, notarization, staple, Gatekeeper, isolated install, clean detach, and renderer launch passed |
| Final notes | Exact five Intel assets and four candidate report families from run `30162696430` are bound; clean publication preflight must be rerun after this evidence-sync commit |
| Formal 1.0 product acceptance | 21/64 P0 verified; 43 open; not required for an honest 0.1.x wedge release |
| Publication | Owner authorization was received on 2026-07-25; no tag or GitHub Release has been created yet |

## M1 Scope Boundary

The current M1 release decision was explicitly narrowed to macOS Intel x64. A successful Intel lane may clear the Intel candidate and final-notes gates without manufacturing Apple Silicon or Windows evidence. It does not make either paused platform complete and does not make the complete-matrix Release Doctor ready.

The repository retains the complete three-platform contract for any future release that claims macOS Intel, macOS Apple Silicon, and Windows together. That contract still requires native distribution and installed-app evidence for each target plus aggregate 12-asset validation.

## Required Before Publication

| Gate | Required evidence | State |
|---|---|---|
| Candidate source | Exact clean `main` commit with package and lockfile at 0.1.7 | Passed at `bbec5265` |
| Source gates | Workflow contract, package-size policy, product positioning, typecheck, build, coding standards, and secret-history scan | Passed in run `30162696430` |
| Release scope | P2-002, P2-003, and P2-005 on the candidate | Passed; P2-001/P2-004 remain outside this Intel release claim |
| Exact Deep | Required checks pass on the candidate; optional skips remain explicit | Passed: `157/157` required; 2 optional external checks skipped |
| Signed Intel distribution | DMG/ZIP/update metadata bound to clean provenance and signed installed app | Passed: `120/120`, artifact set `7553d1ef33ec44d69e7b95c74aee8fcb7500a68daf008ed343e66ae3345a036c` |
| Final release notes | `release:publication:preflight:macos-x64` on a clean approved descendant using downloaded candidate reports | Exact SHA-256 values updated; clean descendant preflight rerun is next |
| Owner decision | Explicit authorization to create tag and GitHub Release | Passed on 2026-07-25 |
| Public upload audit | Tag target, five uploaded assets, hashes, metadata, and public download parity | Pending until publication |
| Website sync | Intel-only version, download, signing state, and truth boundary match the published Release | Pending until publication |

## Intel Distribution Contract

- The formal Intel app, DMG payload, and ZIP payload must embed schema, full candidate Git commit, clean-worktree state, package version, and x64 architecture.
- The app must use Developer ID signing, Hardened Runtime, explicit entitlements, notarization, stapling, and Gatekeeper acceptance.
- The audit must mount the DMG, install from an isolated path, launch the real renderer from packaged `app.asar`, terminate it cleanly, and confirm DMG detach.
- `latest-mac.yml` must contain exactly the x64 ZIP and DMG entries with candidate names, sizes, SHA-512 values, version, path, and release date.
- The exact upload set is five files: DMG, DMG blockmap, ZIP, ZIP blockmap, and `latest-mac.yml`.
- The artifact-set digest must cover all five files, and final notes must reproduce every SHA256 exactly.

## Runtime And Product Boundary

- Shipped model runtimes are OpenAI-compatible HTTP and native Anthropic Messages HTTP only.
- The base app does not embed or require an external Agent SDK or CLI.
- Provider use remains conditional on user-supplied real keys, account access, network conditions, quota, and protocol compatibility.
- Genesis is planning-layer orchestration; autonomous external agent execution, merge, push, and publication are not release claims.
- v0.1.7 does not claim full 1.0 acceptance, Apple Silicon, Windows, Linux, a public N1 migration result, or universal external-network parity.

## Security And Credentials

Signing and notarization credentials exist only in the ephemeral GitHub runner and are removed in `always()` cleanup. Certificate contents, passwords, private API keys, provider real keys, `.env` files, `test-results`, `out`, `dist`, `node_modules`, and local evidence packs must never be committed or uploaded as public assets.

The workflow has repository `contents: read` permission, accepts only an exact 40-character commit already reachable from `main`, and never creates a tag, GitHub Release, or public update entry.

## Stop Conditions

- Any required source, Deep, P2, signing, notarization, staple, Gatekeeper, metadata, package, installed-app, or final-notes check fails.
- Candidate evidence is dirty, stale, from another commit/version/architecture, or does not bind the exact five assets.
- The final notes contain an unverified capability, platform, external condition, or 1.0 claim.
- A secret, certificate, private key, signing material, local evidence directory, or unapproved extra asset enters the public upload set.
- The owner has not explicitly authorized creation of the tag and GitHub Release.

## Publication Sequence

1. Download and independently verify the successful `macos-x64` candidate artifact.
2. Commit the exact final notes and status updates to `main`.
3. Run the scoped final-notes audit from that clean descendant commit using the downloaded reports.
4. Obtain the explicit owner publication decision.
5. Create tag `v0.1.7`, create the GitHub Release, and upload exactly the five audited assets.
6. Run the public asset audit, then update the website download and public status.

Steps 4-6 are intentionally not executed by the candidate workflow.
