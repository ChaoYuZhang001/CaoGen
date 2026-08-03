# CaoGen Intel Patch Release Gate

> Updated: 2026-07-28 Asia/Shanghai. v0.1.7 is the latest public release.
> Package version 0.1.8 has historical macOS Intel-only candidate evidence, but the
> current source successor has no publishable candidate and is not 1.0 stable.

## Historical 0.1.8 Candidate Decision

CaoGen remains a multi-vendor AI work desktop. The current package line moves to
`0.1.8` because the first-user onboarding recovery and deleted-project draft fixes
landed after the public v0.1.7 tag. A source fix that is absent from the downloadable
package is not considered delivered to users.

| Item | Current state |
|---|---|
| Latest public GitHub Release | v0.1.7; its current eight-asset remote state still fails the repository's approved historical five-asset contract |
| Package and lockfile | `0.1.8` |
| Allowed candidate scope | `macos-x64` only; Apple Silicon and Windows remain paused |
| Candidate identity | `main@03c3fee2837d120fce43f4b7d11bd25488be4d36` |
| Candidate workflow | [`30243108279`](https://github.com/ChaoYuZhang001/CaoGen/actions/runs/30243108279), successful read-only `macos-x64` evidence run |
| Exact-commit Deep | `163 total / 161 required pass / 2 optional skip / 0 blocked / 0 fail` |
| 0.1.8 signed distribution evidence | Passed: `120/120` required audit, signed/notarized/application-stapled/installed/launched x64 app, packaged-app smoke, artifact set `2abe8622e3b37873e69abdd5deb1f16c8739336181688eeb2e665c601792ff52` |
| Candidate freshness | Historical product candidate: current source continues with IDE initial-message, Routine, start-suggestion, sequential task-snapshot replay, Provider preset, free-form subagent orchestration, model cross-validation reliability, versioned high-risk Effect-entry inventory, attachment/project-context Effects, and opaque MCP runtime-probe Effect work not present in `03c3fee2` |
| Current source successor | `main@04e1d29a1abd1e23c917a64d5eae8225736391e7`; clean Deep passed `171 total / 169 required pass / 2 optional skip / 0 blocked / 0 fail`, but no signed assets exist for this commit |
| Independent download | Passed: artifact ZIP length/SHA256/CRC, five assets, four report families, update SHA512, x86_64, provenance, codesign, Gatekeeper, application tickets, and removed external SDK/CLI absence independently match |
| Scoped publication preflight | Historical pass only: later product changes and this gate update invalidate it for current `main`; a refreshed candidate and preflight are required |
| Publication authority | Not granted; current `main` has no publishable v0.1.8 candidate, and no tag, GitHub Release, remote body edit, or asset mutation is permitted |

The manual candidate workflow remains read-only with `contents: read`, accepts only
an exact commit already on `main`, defaults to package version `0.1.8` and
`macos-x64`, and cannot create a tag or Release. Run `30243108279` created candidate
evidence only. It did not close the first-user M1 gate and did not authorize
publication. Its Apple Silicon, Windows, and complete-matrix jobs were skipped.
The candidate includes the user-facing welcome-draft persistence, asynchronous catalog
hydration, fixed-model/Drive preservation, rejected-send draft preservation, and
Browser/Preview availability and error-feedback fixes.

These exact five assets and four report families remain valid evidence for `03c3fee2`
only. The current source successor is not represented by those assets, and the earlier
scoped notes/handoff preflight is now historical. The successor has passed clean Deep,
but before any publication decision it still needs a refreshed Intel-only signed
candidate, independent asset verification, and the same fail-closed publication
preflight. Windows and Apple Silicon remain skipped, not passed. Publication still
requires new explicit owner authorization after those gates pass.

### 0.1.8 Candidate Asset Record

| Candidate file | Size | SHA256 |
|---|---:|---|
| `CaoGen-0.1.8.dmg` | 127,697,234 B | `95ca1ad3be1440149bd458cffbdd3063a4476018e059b19b4f4cbb3bdfac64c0` |
| `CaoGen-0.1.8.dmg.blockmap` | 134,439 B | `9683ef7f292049fd7265da874b24f6d09bfe90c6e15c3026d14a620a57cf6fd5` |
| `CaoGen-0.1.8-mac.zip` | 127,023,193 B | `73fb195147282274be360c32b735772164bc1b7c5d9c2fe3cd8b12f34bf03e51` |
| `CaoGen-0.1.8-mac.zip.blockmap` | 133,810 B | `63a1768f5454dd0a96663f530d9155a8316041d1234351ae9f854274b19968ac` |
| `latest-mac.yml` | 484 B | `a40b8cad8ba76e3f9608a0e20c7ce0f2ed9b98fc22cb64907409efed3ee342a6` |

The five-file artifact-set SHA256 is
`2abe8622e3b37873e69abdd5deb1f16c8739336181688eeb2e665c601792ff52`.
GitHub Actions artifact `8644829708`, named
`caogen-release-macos-x64-03c3fee2837d120fce43f4b7d11bd25488be4d36`,
contains the candidate assets and evidence reports and expires on 2026-08-10. It is
not a public Release asset. Its `255,552,267 B` ZIP matched GitHub SHA256
`ec343fe823c5e3a3502c4b6176d23dd59b46dd3e15c2338b06eab98f7384c16a`; independent
verification then matched every listed size and SHA256 digest plus update SHA512 data.

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
| Windows preview policy | Separate unsigned-preview configuration disables signing discovery and stable update metadata and requires explicit filename/copy labeling; no preview evidence is counted as a formal platform pass |
| Formal cross-platform matrix | Still blocked until native macOS arm64 evidence and timestamped Windows Authenticode evidence exist; preview evidence must never satisfy `packaging_release` |

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
| Windows unsigned preview channel | Native x64 unsigned audit, install, renderer launch, uninstall, cleanup and explicit preview labeling | Policy/configuration exists; no preview evidence is counted in this historical Intel publication record, and preview can never satisfy the formal matrix |
| Formal three-platform matrix | Exact 12 signed assets, native platform evidence, aggregate audit and Windows Authenticode | Remains `not_ready`; this is separate from the passed historical Intel-only publication record |

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

## Formal Cross-Platform Contract

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
- This formal contract remains blocked. It is not weakened, waived, or reclassified as
  optional for the 0.1.7 platform-scoped release.

## Windows Unsigned Preview Contract

- Preview builds use `electron-builder.windows-preview.cjs`, not the formal release config.
- Certificate auto-discovery, mandatory signing, and stable update
  metadata are disabled. The only publishable installer name is
  `CaoGen-<version>-windows-x64-unsigned-preview.exe`.
- `npm run test:windows-preview-audit:required -- --arch x64` must prove that the app
  and installer are actually unsigned, are PE x64/NSIS outputs, embed clean-commit
  provenance, and are bound to the exact preview artifact digest.
- `npm run test:packaged-app:win:preview:x64` must install into an isolated directory,
  launch the real renderer, uninstall, and clean temporary data on native Windows x64.
- The GitHub asset label, download page, and Release Notes must all say `unsigned preview`
  and warn that Microsoft Defender SmartScreen may show an unrecognized-app prompt.
- The preview must not ship `latest.yml` and must not enter the stable auto-update channel.
- Preview evidence is never accepted by `trustedWindowsDistributionChecks`, the 12-asset
  formal matrix, `packaging_release`, or a formal cross-platform readiness claim.

## Security And Credentials

Signing and notarization credentials exist only in the ephemeral GitHub runner and are removed in `always()` cleanup. Certificate contents, passwords, private API keys, provider real keys, `.env` files, `test-results`, `out`, `dist`, `node_modules`, and local evidence packs must never be committed or uploaded as public assets.

The workflow has repository `contents: read` permission, accepts only an exact 40-character commit already reachable from `main`, and never creates a tag, GitHub Release, or public update entry.

Required GitHub Actions repository secrets for the formal cross-platform workflow:

- `MACOS_CERTIFICATE_P12_BASE64` and `MACOS_CERTIFICATE_PASSWORD`
- `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`
- `WINDOWS_CERTIFICATE_P12_BASE64` and `WINDOWS_CERTIFICATE_PASSWORD`

The Windows secrets are intentionally absent until commercialization. After purchasing
SSL.com IV Code Signing + eSigner, configure the ephemeral signing credentials, rerun
the formal Windows audit and native install/launch checks, and only then attempt to
close the cross-platform Release Doctor.

The certificate values are base64-encoded PKCS#12 payloads; the Apple API value is the
complete private `.p8` text. They are materialized only under the ephemeral runner temp
directory, removed in `always()` cleanup steps, and never included in artifacts or
reports. A missing value fails its native lane before packaging.

Run the workflow only after the intended commit is on `main`. Its final artifact is
named `caogen-unpublished-candidate-<version>-<commit>` and expires after 14 days. A
successful workflow proves the candidate evidence matrix, not publication approval;
the final release notes, required Doctor, explicit owner release decision, tag, upload,
and post-upload audit remain separate steps.

## Release Notes Contract

The final GitHub Releases body must list the exact uploaded assets and SHA256 values,
supported platforms, signing/notarization state, minimum OS, conditional external
requirements, and residual risks. It must not upgrade local tests, optional skips,
roadmap work, or unavailable platform evidence into released capability.

For the current channel, the body must describe macOS as formal only after notarization,
stapling, Gatekeeper, and native launch evidence pass. Windows must be labeled `unsigned
preview` everywhere it appears and must never be described as signed, trusted, stable,
or formally cross-platform ready.

The dedicated platform-scoped final audit requires the machine-readable Doctor
`distributionPolicy.platformScopedRelease.candidateGate` to be ready while
`distributionPolicy.formalCrossPlatform.status` remains `blocked`. The legacy final
audit is unchanged and still requires formal cross-platform Doctor readiness.

## Stop Conditions

- Any required source, Deep, P2, signing, notarization, staple, Gatekeeper, metadata, package, installed-app, or final-notes check fails.
- Candidate evidence is dirty, stale, from another commit/version/architecture, or does not bind the exact five assets.
- The final notes contain an unverified capability, platform, external condition, or 1.0 claim.
- A secret, certificate, private key, signing material, local evidence directory, or unapproved extra asset enters the public upload set.
- The owner has not explicitly authorized creation of the tag and GitHub Release.
- Any required check is reclassified as optional to bypass the gate, or the version/commit changes after evidence is generated.
- A platform asset lacks native install/runtime evidence, or a macOS asset lacks Hardened Runtime, notarization/stapling, Gatekeeper acceptance, or packaged launch proof.
- The Windows preview filename or public copy omits `unsigned preview`, the preview is unexpectedly signed, or stable Windows update metadata is generated.
- Release copy claims formal cross-platform readiness while the refreshed Release Doctor is `not_ready`.

## Publication Sequence

1. Download and independently verify the successful `macos-x64` candidate artifact.
2. Commit the exact final notes and status updates to `main`.
3. Run the scoped final-notes audit from that clean descendant commit using the downloaded reports.
4. Obtain the explicit owner publication decision.
5. Create tag `v0.1.7`, create the GitHub Release, and upload exactly the five audited assets.
6. Run the public asset audit, then update the website download and public status.

The candidate workflow intentionally did not execute steps 4-6. The owner-authorized publication flow completed them separately on 2026-07-25.
