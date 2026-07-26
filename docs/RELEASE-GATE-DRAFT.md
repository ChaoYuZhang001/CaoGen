# CaoGen Intel Patch Release Gate

> Updated: 2026-07-27 Asia/Shanghai. v0.1.7 is the latest public release.
> Package version 0.1.8 is an unpublished macOS Intel-only patch candidate, not 1.0 stable.

## Current 0.1.8 Candidate Decision

CaoGen remains a multi-vendor AI work desktop. The current package line moves to
`0.1.8` because the first-user onboarding recovery and deleted-project draft fixes
landed after the public v0.1.7 tag. A source fix that is absent from the downloadable
package is not considered delivered to users.

| Item | Current state |
|---|---|
| Latest public GitHub Release | v0.1.7; its current eight-asset remote state still fails the repository's approved historical five-asset contract |
| Package and lockfile | `0.1.8` |
| Allowed candidate scope | `macos-x64` only; Apple Silicon and Windows remain paused |
| Candidate identity | `main@837f8f90945d558c44b2d05cbc09a24e93d1202f` |
| Candidate workflow | [`30212121353`](https://github.com/ChaoYuZhang001/CaoGen/actions/runs/30212121353), successful read-only `macos-x64` evidence run |
| Exact-commit Deep | `163 total / 161 required pass / 2 optional skip / 0 blocked / 0 fail` |
| 0.1.8 signed distribution evidence | Passed: `120/120` required audit, signed/notarized/stapled/installed/launched x64 app, packaged-app smoke, artifact set `48667aeb2f5bb2e16187e88c53a5db96d448d9cfa94e8c3afcfcaf561d510ed1` |
| Candidate freshness | Historical only: later first-task restart recovery and asynchronous Project/Provider catalog hydration fixes are not present in `837f8f90`; current targeted Electron is `11/11` and page operations `22/22`, but the candidate must be rerun on the final clean descendant before publication |
| Publication authority | Not granted; no tag, GitHub Release, remote body edit, or asset mutation is permitted |

The manual candidate workflow remains read-only with `contents: read`, accepts only
an exact commit already on `main`, defaults to package version `0.1.8` and
`macos-x64`, and cannot create a tag or Release. Run `30212121353` created candidate
evidence only. It did not close the first-user M1 gate and did not authorize
publication. Its Apple Silicon, Windows, and complete-matrix jobs were skipped.
The candidate remains valid evidence for exact commit `837f8f90`, but later user-facing
welcome-draft persistence and asynchronous catalog hydration fixes mean it no longer
represents the latest 0.1.8 source.

Before any 0.1.8 publication decision, the candidate artifact must be regenerated from
the final clean descendant and independently checked. The exact five assets and report
families must then be bound into final notes, and a clean publication-only descendant
must pass the scoped notes and handoff preflight. The final notes must describe only
the post-v0.1.7 fixes present in that candidate. Windows and Apple Silicon remain
skipped, not passed. Publication still requires a new explicit owner authorization.

### 0.1.8 Candidate Asset Record

| Candidate file | Size | SHA256 |
|---|---:|---|
| `CaoGen-0.1.8.dmg` | 127,702,969 B | `bb79e9abf1a8e1e245c87feca352db109f275bc96af1d35469b8e6b82e9224c3` |
| `CaoGen-0.1.8.dmg.blockmap` | 134,481 B | `aa0b1924d8db3df620abbb82f76e66c2c2592b0b2491617e050527fe040618f5` |
| `CaoGen-0.1.8-mac.zip` | 127,017,842 B | `3befafbfda324062d1514607d2e9629798e0a501479e045ef4240edb823f39b8` |
| `CaoGen-0.1.8-mac.zip.blockmap` | 132,978 B | `435f0587ba2324742b152b9ad83b647e5fdc9e830c65fa0e7f1e03ed7c0bd3b6` |
| `latest-mac.yml` | 484 B | `8d76dcc865c48e2a18e2ebea6658509a65ca9e62c4e38929320f24338d101dc5` |

The five-file artifact-set SHA256 is
`48667aeb2f5bb2e16187e88c53a5db96d448d9cfa94e8c3afcfcaf561d510ed1`.
GitHub Actions artifact `8635086153`, named
`caogen-release-macos-x64-837f8f90945d558c44b2d05cbc09a24e93d1202f`,
contains the candidate assets and evidence reports and expires on 2026-08-09. It is
not a public Release asset.

## Historical v0.1.7 Publication Record

## Current Decision

CaoGen remains a multi-vendor AI work desktop. This gate permits only capabilities and platforms bound to the exact v0.1.7 Intel candidate evidence.

| Item | State |
|---|---|
| Latest public GitHub Release | [`v0.1.7`](https://github.com/ChaoYuZhang001/CaoGen/releases/tag/v0.1.7), published 2026-07-25 |
| Package and lockfile | `0.1.7` |
| Current M1 platform scope | macOS Intel x64 only; Apple Silicon and Windows are paused and are not counted as passes |
| Candidate identity | `main@bbec526554aea9785291edf4d8164084145347ae` |
| Candidate workflow | [`30162696430`](https://github.com/ChaoYuZhang001/CaoGen/actions/runs/30162696430), read-only `macos-x64` evidence run |
| Exact-commit Deep | `159 total / 157 required pass / 2 optional skip / 0 blocked / 0 fail` |
| macOS distribution | `120/120` required audit; Developer ID signing, notarization, staple, Gatekeeper, isolated install, clean detach, and renderer launch passed |
| Final notes | Exact five Intel assets and four candidate report families from run `30162696430` are bound; scoped final audit and clean publication preflight passed |
| Formal 1.0 product acceptance | 21/64 P0 verified; 43 open; not required for an honest 0.1.x wedge release |
| Publication | Passed; annotated tag `v0.1.7` targets `d8e883a21b64133b4ec18d20d0c77fd33c054718`, Release is public and is neither draft nor prerelease |

## M1 Scope Boundary

The current M1 release decision was explicitly narrowed to macOS Intel x64. A successful Intel lane may clear the Intel candidate and final-notes gates without manufacturing Apple Silicon or Windows evidence. It does not make either paused platform complete and does not make the complete-matrix Release Doctor ready.

The repository retains the complete three-platform contract for any future release that claims macOS Intel, macOS Apple Silicon, and Windows together. That contract still requires native distribution and installed-app evidence for each target plus aggregate 12-asset validation.

## Publication Gate Record

| Gate | Required evidence | State |
|---|---|---|
| Candidate source | Exact clean `main` commit with package and lockfile at 0.1.7 | Passed at `bbec5265` |
| Source gates | Workflow contract, package-size policy, product positioning, typecheck, build, coding standards, and secret-history scan | Passed in run `30162696430` |
| Release scope | P2-002, P2-003, and P2-005 on the candidate | Passed; P2-001/P2-004 remain outside this Intel release claim |
| Exact Deep | Required checks pass on the candidate; optional skips remain explicit | Passed: `157/157` required; 2 optional external checks skipped |
| Signed Intel distribution | DMG/ZIP/update metadata bound to clean provenance and signed installed app | Passed: `120/120`, artifact set `7553d1ef33ec44d69e7b95c74aee8fcb7500a68daf008ed343e66ae3345a036c` |
| Final release notes | `release:publication:preflight:macos-x64` on a clean approved descendant using downloaded candidate reports | Passed on publication-only descendant `d8e883a2` |
| Owner decision | Explicit authorization to create tag and GitHub Release | Passed on 2026-07-25 |
| Public upload audit | Tag target, five uploaded assets, hashes, metadata, and public download parity | Passed: 5 assets, 0 warnings, 0 failures; every public SHA-256 digest matches the candidate |
| Website sync | Intel-only version, download, signing state, and truth boundary match the published Release | Passed on `caogen.dev`, `/en/`, and `/docs/` |

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

The candidate workflow intentionally did not execute steps 4-6. The owner-authorized publication flow completed them separately on 2026-07-25.
