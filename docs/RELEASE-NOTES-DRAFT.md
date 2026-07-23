# CaoGen 0.1.7 Release Candidate Draft

> Status: Do not publish this draft. v0.1.6 is still the latest public release on
> GitHub Releases. No new release assets uploaded yet.

## Release Decision

The package and lockfile version is `0.1.7`. CaoGen remains a multi-vendor AI work desktop.
The candidate branch has a clean Deep
report with `157 total / 154 required pass / 3 optional skip / 0 blocked / 0 fail`,
but that report must be rerun after the final merge commit is selected. This is a
0.1.x wedge release, not CaoGen 1.0 stable and not proof that all Agent Work OS
requirements are complete.

One Developer ID Application identity is available on the current Intel Mac. The
release configuration, Hardened Runtime, entitlements, DMG/ZIP targets, and minimum
macOS version pass config audit. The current process does not have notarization
credentials configured. A local x64 Developer ID-signed baseline exists, but it was
explicitly built without notarization and without build-commit provenance, so it is
not a release candidate. No 0.1.7 artifact is notarized or uploaded, and a native
arm64 release requires Apple Silicon hardware.

The release gate now requires a complete macOS x64, macOS arm64, and Windows x64
matrix. Each platform must provide an independent distribution audit, clean-commit
build provenance, native installation, and real renderer launch. Windows additionally
requires PE x64, NSIS, and timestamped Authenticode evidence for both the unpacked app
and installer. A manual, read-only candidate workflow now orchestrates those three
native lanes and independently revalidates the downloaded 12-asset set; it does not
publish. These gates are implemented; the workflow has not run with real release
credentials and their final platform evidence is not complete.

## Candidate Highlights

- Run local projects with multiple configured providers, BYOK credentials, routing,
  backup-key handling, and controlled provider failover.
- Review task changes through isolated Git worktrees, Diff, terminal, file, browser,
  preview, and Git tools in one desktop workspace.
- Use Assistant and Studio as two projections over the same canonical project and run
  state; required Electron gates cover switching, continuity, and responsive controls.
- Inspect real session, routing, approval, cost, subtask, worktree, and Git signals in
  the current robot-based 3D office.
- Recover persisted task, Effect, ModelAttempt, workflow, and DAG-finalization state
  through locally verified crash and reconciliation paths.

## Uploaded Assets

No new 0.1.7 assets uploaded yet. Final notes must list only files actually uploaded
to GitHub Releases and must include one SHA256 row for every uploaded file.

Public update metadata such as `latest*.yml` must match the exact installer set. Test
reports, local evidence, and intermediate build directories are never release assets.

## Truth Boundary

- Formal 1.0 acceptance remains open: 21 of 64 P0 requirements are currently verified
  and 43 remain partial, foundation-only, or planned.
- The clean Deep has three explicit optional skips: real external-network parity for
  two China conditions and one optional real-engine E2E. They are not passes and are
  not claimed by this release.
- Provider availability depends on user-supplied real keys, account access, network,
  compatible protocols, and quota.
- The current 3D office uses robot assets. Richer character art remains roadmap work.
- Genesis remains a planning surface; this release does not claim automatic external
  agent execution, merge, push, or publication.
- No N1 30-minute migration, seven-day soak, Apple Silicon runtime, Windows signed
  package, or public 0.1.7 installation evidence is claimed yet.

## Known Blockers

- `release_identity`: the gate hardening changes are not yet bound to a clean final
  candidate commit.
- `deep_test`: the full required Deep gate must be rerun on that exact clean commit.
- `packaging_release`: no complete provenance-bound 12-asset matrix exists. The current
  process lacks notarization configuration, native arm64 evidence requires Apple
  Silicon, and signed Windows x64 distribution/install evidence requires a Windows
  signing lane.
- `release_notes`: this is a draft. Exact asset names, SHA256 values, platform support,
  signing state, final Doctor binding, and post-upload audit are still missing.
- Do not publish while Release Doctor is `not_ready`.

## Security Statement

The repository and public assets must not include real keys, webhooks, certificates,
private keys, signing material, filled `.env` files, `test-results`, `out`, `dist`,
`node_modules`, local evidence packs, logs, or private URLs.

If any real credential is pushed, shared, or uploaded, deleting the public copy is not
sufficient; revoke or rotate it at the provider as well.

## macOS First Open

The latest public macOS package remains unsigned. Until a signed, notarized, stapled,
and Gatekeeper-audited 0.1.7 package is uploaded, users may still need Finder's
right-click **Open** flow. Final notes must replace this paragraph with the exact
verified signing and first-open behavior of the uploaded artifact.

## Final Required Checks

- `npm run test:deep`
- `npm run secret:scan:history`
- `npm run release:mac:preflight:x64`
- `npm run dist:mac:release:x64`
- `npm run test:macos-release-audit:required -- --arch x64`
- `npm run test:packaged-app:mac:x64`
- native arm64 build and audit on Apple Silicon before uploading an arm64 asset
- `npm run test:packaged-app:mac:arm64` on native Apple Silicon
- `npm run dist:win:release:x64` with a valid Authenticode identity on native Windows x64
- `npm run test:windows-release-audit:required -- --arch x64`
- `npm run test:packaged-app:win:x64`
- `npm run test:release-packaging-audit:required`
- `npm run test:product-positioning:required`
- `npm run workos:release-doctor -- --required --refresh --version 0.1.7`
- `npm run test:release-notes-audit:final -- --version 0.1.7`
- `npm run test:github-release-audit:read-text:required -- --tag v0.1.7 --expected-assets-from-dist`
