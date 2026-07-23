# CaoGen 1.0.0 Candidate Release Gate

> Updated: 2026-07-22 Asia/Shanghai. v0.1.6 remains the latest public release. Package version 1.0.0 is a local candidate, not a stable release decision.

## Current Decision

| Item | State |
|---|---|
| Latest public GitHub Release | [`v0.1.6`](https://github.com/ChaoYuZhang001/CaoGen/releases/tag/v0.1.6) |
| Local package and lockfile | `1.0.0` |
| Formal product acceptance | 64 P0 total: 21 fully verified, 43 still target/foundation/partial; latest map `2026-07-22T13-55-02-664Z` passes structure but fails strict closure with 134 findings |
| Latest functional Deep | `150 total / 147 required pass / 3 optional skip / 0 blocked / 0 fail`, dirty-worktree evidence with 456 expanded status entries (`2026-07-22T03-13-05-163Z`) |
| Local package evidence | Existing unsigned macOS x64 DMG/ZIP set and packaged renderer launch pass, dirty-worktree evidence only; not a signed candidate |
| Release decision | `not_ready`; do not tag, upload, publish, or describe this candidate as CaoGen 1.0 stable |

CaoGen public positioning remains a multi-vendor AI work desktop. A green engineering test suite does not replace the Project, Goal, WorkItem, DigitalWorker, Artifact, Acceptance, human-workflow, signing, and distribution gates defined for formal 1.0. Current dirty-worktree evidence closes EXP-002 shared Assistant/Studio canonical projection, PROJ-003 Project ownership, and NFR-PRIV-004 local/inner-network Provider equal candidacy. ART-001 remains partial because only Code Forge patch is wired as a real important-output producer; RUN-002 remains partial while raw protocol parsing stays in three engines; TEAM-003 remains partial because five P0 policy bypass classes are still open. The release owner explicitly waived the elapsed seven-day soak only for `1.0.0`; this is a recorded residual-risk acceptance, not a passing soak result or a reusable bypass.

## Required Before Stable

| Gate | Required command or evidence | Current status |
|---|---|---|
| Formal P0 acceptance | `npm run test:product-1.0-acceptance:required` and [`1.0-ACCEPTANCE-MATRIX.md`](./1.0-ACCEPTANCE-MATRIX.md) | Open: 21/64 fully verified; 43 open |
| P1 disposition | Frozen selected-P1 list, explicit visual gates, owner/reason/evidence for every waiver, signed Go record | Open |
| Human workflows | Office/education and technical/OPC real-user runs with accepted artifacts and environment records | Open |
| N1 migration | Private timestamped 30-minute human migration result and `npm run test:n1-migration-audit:required` | Open |
| Seven-day soak | `npm run test:1.0-soak-audit:required -- --version 1.0.0 --waiver docs/1.0-SOAK-WAIVER.json`; exact-version owner, reason, accepted risk, expiry, and compensating gates | Waived only for `1.0.0`; all later releases remain blocked without required soak evidence |
| Release identity | Exact clean commit, `package.json`/lockfile `1.0.0`, unchanged tree, final `v1.0.0` tag resolution | Open |
| Local type/build | `npm run typecheck` and `npm run build` on the exact release commit | Must rerun after freeze |
| Deep gate | `npm run test:deep`; every required item must pass, with optional states explicit | 147/147 required functional pass exists; clean binding open |
| Real default Provider | `npm run test:real-provider-release:required -- --record /private/path/result.json`; private redacted OpenAI-compatible record covering send, tool, Artifact, recovery, usage/billing, clean identity, and evidence digests | Open; required for formal 1.0 even though optional Anthropic/China parity may remain unclaimed |
| P2 release scope | P2-002/P2-003/P2-005 remain proved; external/platform claims retain separate evidence | Ready for the current narrow scope |
| Secret history | `npm run secret:scan` and `npm run secret:scan:history` in the refreshed Doctor decision | Open for final commit |
| macOS release config | `npm run test:macos-release-config` | Config-only gate available |
| Developer ID preflight | `npm run release:mac:preflight:x64` or `:arm64` | Signing prerequisites available: one Developer ID Application identity, API-key notarization auth configured, and `notarytool history` authentication succeeded. The latest release preflight failed only because the worktree is dirty (`test-results/macos-release-preflight/2026-07-22T07-18-51-441Z/report.json`) |
| Signed package | `npm run dist:mac:release:x64` and, for arm64 assets, `npm run dist:mac:release:arm64` | Open: identity and notarization auth are available, but no clean candidate has been built and signed |
| Hardened/notarized/stapled audit | `npm run test:macos-release-audit:required -- --arch <arch>` | Open: no signed, notarized, and stapled candidate artifact exists; the current `dist/mac/CaoGen.app` is an older unsigned artifact |
| Packaging/runtime | `npm run test:release-packaging-audit:required` and `npm run test:packaged-app:mac` on the signed clean artifact | Existing evidence is for a dirty-worktree unsigned package; regenerate and test the signed clean candidate |
| Apple Silicon | Native arm64 build, install, launch, core workflow, permissions, and upgrade evidence before uploading an arm64 asset | Open; requires Apple Silicon hardware |
| SBOM/dependency decision | `npm run test:release-sbom:required`; release-bound CycloneDX inventory and Critical/High disposition | Local 856-component audit passes with High=0/Critical=0; clean commit/artifact binding open |
| Final notes | Exact signed assets, hashes, platforms, conditions, residual risk, and `npm run test:release-notes-audit:final -- --version 1.0.0` | Draft only |
| Final Doctor | `npm run workos:release-doctor -- --required --refresh --version 1.0.0` | `not_ready` (`test-results/workos-release-doctor/2026-07-22T08-17-49-240Z/report.json`); refreshed acceptance/SBOM/packaging/positioning/GitHub/secret evidence completed, while the old unsigned `dist` failed macOS distribution audit |
| Public asset audit | After publication only: `npm run test:github-release-audit:read-text:required -- --tag v1.0.0 --expected-assets-from-dist` | No v1.0.0 release exists |

## macOS Distribution Contract

- Unsigned preview builds may continue through `npm run dist:mac:x64` or `npm run dist:mac:unsigned:x64`, but they never satisfy a 1.x stable distribution gate.
- Formal builds use `electron-builder.release.cjs`, require code signing, Hardened Runtime, notarization, explicit entitlements, and macOS 14.0 or newer.
- The main app receives only the Electron JIT entitlements plus user-approved Apple Events automation. Helper inheritance does not add unrelated capabilities.
- The packaged Anthropic CLI keeps its upstream Developer ID signature and dedicated entitlements; the post-build audit verifies that exception explicitly.
- x64 and arm64 are separate artifacts. An Intel build or an embedded arm64 prebuild is not Apple Silicon runtime evidence.
- Do not print, persist, stage, or upload certificate contents, passwords, API private keys, app-specific passwords, or notarization profile values.

## Release Notes Contract

The final GitHub Release body must include exact supported platforms, artifact names, SHA-256 values, signing/notarization state, minimum macOS version, conditional external requirements, residual risks, the explicit `1.0.0` soak waiver, and the exact release-bound evidence used for Go. It must not claim complete Project/Goal/Worker/Artifact workflows, human acceptance, N1, a passed seven-day soak, Apple Silicon, or external-provider parity without their dedicated passed records. Native `bash` explicit-test failure ingress may create Acceptance failure Evidence only when `commandTermination === 'exited'`, `isError === true`, and `exitCode` is a nonzero safe integer; `timed_out`, `aborted`, `output_limit`, `spawn_error`, and `not_started` are infrastructure terminations and must not be misreported as Acceptance failures. Targeted evidence covers immutable Snapshot capture, per-session failure-queue flush, persistence before deletion, failure latch, startup recovery, per-criterion Evidence coverage, Evidence event/source binding, and fail-closed database Evidence/Link deletion, but remains dirty-worktree evidence rather than clean release evidence. Current repair/retest, structured arbitration, native explicit-test failure ingress, Acceptance Evidence integrity, and the Studio WorkItem transition/lease control slice support only a local foundation; policy authoring plus Acceptance review/evidence selection has a dedicated dirty-worktree Electron gate, while release copy must not describe WORK-004 or ART-004 as complete until physical Artifact availability/content verification, remaining test producers/orchestration, full Supervisor controls, Verification history, repair/retest review UI, strong-kill, and end-to-end delivery evidence pass.

## Stop Conditions

- Any PRD P0 remains short of the exact `当前已验证` state or lacks release-bound acceptance evidence.
- Any required test fails, blocks, or is reclassified as optional to bypass the gate.
- The worktree is dirty, the commit/version changes after evidence is generated, or the release tag resolves elsewhere.
- The macOS App, nested code, DMG, ZIP, notarization ticket, Gatekeeper assessment, install, launch, permission, or upgrade audit fails.
- A stable 1.x macOS asset is unsigned, lacks Hardened Runtime, is not notarized/stapled, or was built with the unsigned profile.
- A platform or architecture asset is uploaded without native install and runtime evidence for that exact asset.
- A real secret, certificate, private key, signing material, `.env`, `test-results`, `out`, `dist`, `node_modules`, or local evidence pack is staged or uploaded.
- Release copy upgrades a condition, target, foundation, mock, screenshot, or dirty-worktree result into a completed stable claim.
- The required refreshed Release Doctor is not `ready`.
