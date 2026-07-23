# CaoGen 1.0.0 Local Release Candidate Draft

> Status: Do not publish this draft. v0.1.6 is still the latest public release. v1.0.0 is only a local release candidate and has not been published to GitHub Releases.

## Release Decision

The local package and lockfile version is 1.0.0. One Developer ID Application identity is available, API-key notarization authentication is configured, and `notarytool history` authentication succeeded. The latest release preflight (`test-results/macos-release-preflight/2026-07-22T07-18-51-441Z/report.json`) failed only because the worktree is dirty. These are prerequisites, not distribution evidence: the existing macOS x64 asset set is unsigned dirty-worktree output, `dist/mac/CaoGen.app` is an older unsigned artifact, and no clean candidate has been signed, notarized, or stapled. This is also not yet the product defined by the formal 1.0 PRD: 21 of 64 P0 requirements are fully verified, while 43 remain target, foundation, or partial work. There is no clean 1.0.0 release commit or public tag, stable Go record, or uploaded 1.0.0 asset set. The GitHub Releases body may be finalized only after the exact clean candidate passes the product, human, time, security, packaging, and distribution gates and replacement artifact hashes are available.

## Candidate Highlights

- The local candidate implements Workflow Ledger v8 canonical storage with `legacy`, `compare`, and `canonical` read modes, plus stricter Snapshot/Run ownership and migration-readiness checks.
- EXP-002 now has a real-Electron 5/5 required report proving Assistant and Studio share exact canonical Project, Goal, WorkItem, production Run, and Artifact identities across ten roundtrips plus renderer reload, with source/build freshness passing before and after the run. PROJ-003 now has 27/27 Project-ownership checks with `notProved=[]`, including Project-ID Memory cutover and production mutation ingress. NFR-PRIV-004 now has 13 local Provider parity checks plus a 7/7 real-Electron zero-choice leg, proving local/inner-network compatible Providers are not penalized by location or protocol label.
- These closures do not complete the adjacent domains. ART-001 still lacks production registration for report, document, screenshot, test, release, PR, and other important producers; RUN-002 still leaves raw provider stream parsing and fragmented tool-call assembly in the three engines; TEAM-003 passes 35 action-policy checks but retains five P0 bypass classes covering immutable Worker/Assignment session binding, per-dispatch Provider rechecks, composite tool capabilities, mandatory compatibility-SDK pre-tool enforcement, and durable monthly-budget accounting.
- Queryable operation-effect coverage now includes hardened Code Forge patch artifacts and expanded Git index and managed-worktree boundaries. Code Forge report/descriptor reads reject executable Git filters, validate registered worktree identity, bound untracked-file and patch reads, and publish content-addressed patch artifacts through a queryable effect.
- Operation and recovery paths retain persisted evidence for reconciliation instead of treating a tool return value alone as proof of an external mutation.
- Automatic/model Memory suggestions, automatic Skill review, and `optimize_skill` now share a project-scoped draft and trusted-user approval lifecycle. Drafts preserve provenance and complete diffs without entering prompts or materializing `SKILL.md`; approved state has monotonic versions, revoke/rollback/expiry/delete, restart audit, fail-closed Skill journaling, and approved/unexpired Memory injection across Anthropic and OpenAI prompt paths. Worker-scoped Memory, project-wide retention/export/privacy, and clean release binding remain open.
- The latest local Deep completed `150 total / 147 required pass / 3 optional skip / 0 blocked / 0 fail` (`test-results/caogen-deep/2026-07-22T03-13-05-163Z/deep-test-report.md`). It ran from a dirty worktree with 456 expanded status entries, so the `deep_test` Doctor domain remains open until the same required gate passes on the exact clean release commit.
- Canonical ModelAttempt v1 now records default compatible-runtime, model-DAG, compatibility-SDK turn, and every native Anthropic HTTP attempt before Provider work, preserves immutable request/failover chains, and forces explicit retry or cancellation after an unknown crash result. The native Anthropic engine is production-registered and locally covers tool loops, conservative Key/same-protocol Provider failover, and image restart recovery. ROUTE-004 remains partial because real-provider evidence, the complete recovery ladder, unified Run/Context parity, and clean release binding remain open.
- Failed Workflow Acceptance reviews now deterministically and idempotently create a canonical repair WorkItem plus Acceptance, recover a missing repair on startup, reject binding conflicts, block retest until the repair is done with passed/waived Acceptance, and then start a new verifying revision. Multi-criterion Acceptance requires per-criterion Evidence and matching criterion-scoped `verifies` links. Optional immutable criterion policies now require complete stable criterion identities and exact Workflow Evidence kind/allowed-source semantics; typed records reject Task Effect origin or kind/source mismatches, retest preserves the original policy, and legacy records without a policy remain readable. Repair-derived Acceptances now inherit those kind/source policies on creation, duplicate recovery, and startup recovery, rebinding criterion identity to the deterministic repair WorkItem criterion. When `criterionIndexes` is omitted for a policy-bearing Acceptance, a compatible failure producer requires exactly one matching criterion; zero or multiple matches fail closed without writing Evidence. The terminal gate re-resolves the live store, binds Workflow Evidence to its recorded event envelope/payload digest and Task Evidence to its event/Run/Effect source, verifies available local Artifact bytes against the Artifact/Evidence digests and declared checksum/size, and blocks ProjectWorkspace terminal commit if a passed Acceptance's database Evidence row or Evidence Link was deleted. Typed main-only failure ingress atomically records Evidence, criterion links, the failed Acceptance revision, and an audit event. Structured cross-validation arbitration and failed native `bash` invocations of explicit test commands are bounded real producers; the test path requires exact Session/TaskRun/ToolExecution/canonical WorkItem and event-digest binding. Acceptance failure Evidence is emitted only when `commandTermination === 'exited'`, `isError === true`, and `exitCode` is a nonzero safe integer; `timed_out`, `aborted`, `output_limit`, `spawn_error`, and `not_started` are infrastructure terminations and do not create Acceptance failures. Targeted evidence covers immutable Snapshot capture, per-session failure-queue flush, persistence before deletion, failure latch, startup recovery, per-criterion semantic coverage, event/source binding, Artifact byte integrity, and database Evidence/Link deletion rejection; policy authoring plus Acceptance review/evidence selection additionally has a real Electron required gate for multi-criterion kind/source authoring, empty-source rejection, per-criterion matching Evidence, pass, and restart equality. This remains dirty-worktree evidence, not clean release evidence. WORK-004 and ART-004 remain partial because remote/non-file Artifact trust, other test producers and orchestration, full WorkItem controls, automatic repair execution, independent Verification history, repair/retest review UI, strong-kill proof, and the end-to-end delivery loop remain open.
- Each newly projected Run now freezes the owning Acceptance ID and revision. Both real failure producers carry that Run binding, so a delayed first arrival from an older test or arbitration Run is rejected before Evidence or Acceptance mutation instead of drifting to a newer retest revision; legacy Runs without a binding fail closed and require reconciliation.
- The required durable DAG finalization crash gate passed in that Deep run. It is no longer a functional blocker, but its passing evidence must still be bound to the exact clean release commit.
- The existing unsigned macOS x64 package passed the packaged-app smoke and opened a real renderer page titled `CaoGen` from the packaged `app.asar`. This is dirty-worktree launch evidence, not signed candidate or clean release evidence.
- The latest local page-operation smoke passed all 22 checks, but this does not replace clean-commit Deep, signing, notarization, or platform-specific release gates.
- Platform, external-provider, migration-time, and public-distribution claims remain conditional on their own evidence.

## Uploaded Assets

No new release assets uploaded yet. The existing v0.1.6 public assets remain the latest published set; they are not 1.0.0 assets and must not be renamed or reused as candidate evidence.

An unsigned macOS x64 asset set exists in `dist/`; it is not the signed release candidate:

- `CaoGen-1.0.0.dmg` - SHA256 `f0f33b9052b78acbe7153a8ce710c0426c3938d316a90dd99ab484119cf74c6a`
- `CaoGen-1.0.0.dmg.blockmap` - SHA256 `5a2374559e5edc04e54ba035d4c5bf0f45b220750b1d0c9e2058d3b8182aade8`
- `CaoGen-1.0.0-mac.zip` - SHA256 `e114032a73a041369cb7693f2e074d62ecf57c743494fd0c16ecc139b6c3e60d`
- `CaoGen-1.0.0-mac.zip.blockmap` - SHA256 `ea76197eb657f25faf5dbd7567202a04002f0f6cfb4159048cf8fd334b1bec8e`
- `latest-mac.yml` - SHA256 `2c24f5407ecae90d8764a99008e956a08ca5afcf7df5e46c7db433ebac7d6a46`

These files and hashes are local dirty-worktree evidence only. They must not be uploaded, renamed, or reused as the formal clean-build asset set. Packaging must be regenerated from the exact clean release commit, and the replacement hashes must be audited before publication. Allowed public assets are installer files plus public update metadata such as blockmaps and `latest*.yml`; local build output and evidence directories are never release assets.

## Truth Boundary

- CaoGen is a multi-vendor AI work desktop with model/provider configuration, project rules, code execution, task orchestration, workspace isolation, plugins, project memory, file preview, and 3D office visualization.
- Genesis remains plan-layer orchestration; no release may claim autonomous external child-agent execution, merging, pushing, or publishing without separate proof.
- Workflow Ledger v8 and queryable operation effects improve local recovery and reconciliation boundaries; they do not prove a clean release, distributed durability across machines, or successful execution of every workflow.
- The repair/retest, structured arbitration, and native `bash` explicit-test failure ingress paths are local domain foundations. A real Electron gate now also covers the Studio WorkItem transition/lease control slice (allowed state sequence, owner-bound lease lifecycle, terminal cleanup, and restart persistence); this does not prove other test producers or automatic test orchestration, complete pause/cancel/resume/retry/reassign Supervisor controls, automatic repair Runs, an independent immutable Verification chain, or final delivery closure.
- Provider and CLI capabilities depend on real keys, provider authentication, and locally configured tools when those integrations are selected.
- Multiple encrypted keys and error-driven same-provider failover are locally verified. Native Anthropic replay is allowed only before partial output and when no abort, ledger failure, or unresolved Effect makes the result ambiguous; its Provider failover is restricted to Anthropic-engine targets. Proactive quota probing and weighted key load balancing are not claimed.
- macOS document viewing provides a sandboxed system preview with extracted-structure fallback. Pixel-identical editing, complex formula execution, and presentation animation are not claimed.
- Platform support must follow real platform-specific packaging and runtime evidence.
- User-configured external-network parity and the private 30-minute migration drill remain outside public claims until their separate evidence passes.
- No seven-day soak was run for `1.0.0`. The release owner explicitly accepted the long-duration defect and hotfix/rollback risk in `docs/1.0-SOAK-WAIVER.json`; Release Doctor may report this gate only as `waived`, and the decision expires after exact version `1.0.0`.
- AGPL-compliant commercial use does not require a separate license; proprietary integration or distribution rights require a signed written commercial agreement.

## Accepted 1.0.0 Waiver

- `product_1_0_soak`: no seven-consecutive-day record exists. The release owner explicitly accepted the long-duration defect and hotfix/rollback risk in `docs/1.0-SOAK-WAIVER.json`.
- Release Doctor must report this domain as `waived`, never `passed`. It is non-blocking only when the target is exact version `1.0.0`; `1.0.1` and every other release remain blocked without their required soak evidence.
- The waiver changes no other release gate. Its compensating Deep, P0 acceptance, Provider, SBOM, secret-history, signed/notarized artifact, rollback, and final-release evidence must still pass independently.

## Known Blockers

- evidence_refresh: the latest required refresh Doctor (`test-results/workos-release-doctor/2026-07-22T08-17-49-240Z/report.json`) completed acceptance, SBOM, packaging, positioning, GitHub Release, and same-run secret-history refreshes. Its sole failed refresh command was the macOS distribution audit because the existing `dist` app is older, unsigned, unnotarized, and unstapled. The release preflight separately found one Developer ID Application identity and configured API-key notarization auth, failing only on the dirty worktree; these prerequisites do not turn the old artifact into release evidence.
- product_1_0_acceptance: the latest structural PRD map (`test-results/product-1.0-acceptance-map/2026-07-22T13-55-02-664Z/report.json`) reports 64 P0 total, 21 fully verified, and 43 open. Structure passes, but strict closure still fails with 134 findings and the worktree is dirty. The executable owner/evidence plan is `docs/1.0-ACCEPTANCE-MATRIX.md`.
- release_identity: 1.0.0 matches the local package version, but the worktree is not clean and no exact release commit or v1.0.0 tag is selected.
- deep_test: the latest Deep passed `150 total / 147 required pass / 3 optional skip / 0 blocked / 0 fail`, including canonical ProjectWorkspace write-source crash recovery, Acceptance repair/retest, failure ingress and Artifact byte integrity, TEAM-002 real Electron recruitment, the unified Learning lifecycle, ModelAttempt crash reconciliation, the native Anthropic production-path gates, and the required durable DAG finalization crash gate. The domain remains open because this is dirty-worktree evidence with 456 expanded status entries rather than evidence from the exact clean release commit.
- real_default_provider: formal 1.0 still requires one private redacted OpenAI-compatible run covering send, tool, Artifact, recovery, and usage/billing fields. Optional Anthropic or China parity does not replace this default-path gate.
- release_sbom: the local CycloneDX 1.5 audit covers 856 components and passes with High=0/Critical=0, but no SBOM and dependency disposition is yet bound to the exact clean candidate commit and artifact set.
- dag_finalization: the required crash gate passes functionally, but the refreshed Doctor and clean release commit binding remain open.
- n1_migration: the private timestamped 30-minute migration drill and recording have not passed the required audit.
- packaging_release: the 1.0.0 packaging audit, complete five-file asset set, artifact-set match, and packaged-app launch all passed. The domain remains open because `cleanCommitEvidence` and `packagedLaunchCleanEvidence` are false, and the local macOS x64 package is unsigned.
- release_notes: this is a local candidate draft, not the final GitHub Releases body; final asset names, SHA256 values, clean-commit binding, and the final audit are still missing.
- macOS distribution blocker: signing identity and API-key notarization authentication are available, but candidate signing, Hardened Runtime verification, Apple notarization, stapling, and native platform install/upgrade evidence are not complete. No draft text may imply a trusted macOS distribution until all are proved.
- Human/time blockers: the required real-user workflows, N1 timed migration, and selected P1 Go review do not have passed records. The missing seven-day soak is an accepted, release-specific residual risk only for `1.0.0`.
- secret_hygiene: the worktree and Git-history scan passed in the latest refreshed Doctor decision; it must run again on the exact clean release commit before release.

## Security Statement

The repository and public release assets must not include real keys, webhooks, certificates, private keys, signing material, filled `.env` files, `test-results`, `out`, `dist`, `node_modules`, local evidence packs, logs, or private URLs.

If any real credential is pushed, shared, or uploaded, deleting the public copy is not sufficient; the credential must also be rotated or revoked at its provider.

## macOS First Open

The existing unsigned macOS x64 package passed the packaged-app launch smoke, but it was built from a dirty worktree and is not the signed release candidate; the current `dist/mac/CaoGen.app` is an older unsigned artifact. For local preview testing, Gatekeeper may require users to right-click CaoGen in Finder, choose **Open**, then confirm **Open**. A formal 1.x stable macOS build may not remain unsigned: it must pass the dedicated Developer ID, Hardened Runtime, notarization, stapling, Gatekeeper, install, launch, permission, and upgrade gates.

## Final Required Checks

- `npm run typecheck`
- `npm run build`
- `npm run test:product-1.0-acceptance:required`
- `npm run test:1.0-soak-audit:required -- --version 1.0.0 --waiver docs/1.0-SOAK-WAIVER.json`
- `npm run test:release-sbom:required`
- `npm run test:deep`
- `npm run test:macos-release-config`
- `npm run release:mac:preflight:x64`
- `npm run dist:mac:release:x64`
- `npm run test:macos-release-audit:required -- --arch x64`
- `npm run test:release-packaging-audit:required`
- `npm run test:packaged-app:mac`
- `npm run test:product-positioning:required`
- `npm run workos:release-doctor -- --refresh --version 1.0.0`
- `npm run test:release-notes-audit:final -- --version 1.0.0`
- `npm run workos:release-doctor -- --required --refresh --version 1.0.0`
- `npm run test:github-release-audit:read-text:required -- --tag v1.0.0 --expected-assets-from-dist`
- `npm run secret:scan:history`
