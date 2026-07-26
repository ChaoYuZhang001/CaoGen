# CaoGen 0.1.8 macOS Intel Patch Candidate Draft

> Status: Do not publish this draft. v0.1.7 is the latest public release on
> GitHub Releases. No new 0.1.8 release assets uploaded yet.

## Release Decision

The package and lockfile version is `0.1.8`. CaoGen remains a multi-vendor AI work desktop.
This patch candidate exists because user-facing fixes merged after the
v0.1.7 tag and are not present in the package that users can currently download.
The candidate scope is macOS Intel x64 only. Apple Silicon, Windows, Linux, and the
formal three-platform matrix remain outside this patch candidate.

Preparation of this candidate does not authorize a tag or a public Release. The
exact candidate commit must first pass clean source gates, exact-commit Deep,
Developer ID signing, notarization, stapling, Gatekeeper, isolated installation,
real renderer launch, package-size policy, and final five-asset verification in the
read-only `macos-x64` evidence workflow.

## Candidate Highlights

- Preserve the Quick Start prompt, project, directory, Drive mode, permission,
  routing, Provider, model, and Studio subpage while the user opens Settings to
  recover from a missing or unusable Provider.
- Open the real Provider editor from first-run recovery and keep incomplete entries
  in the editor with explicit errors. Only a Provider with a stored key and at least
  one model may return the user to the pending first task.
- Keep first-run failure recovery at zero sessions until the user explicitly starts
  the task, then continue through the normal Router and streaming path.
- Detach a new-session draft when its project is deleted or archived so the next
  send cannot silently recreate the removed project.
- Retain the shipped OpenAI-compatible HTTP and native Anthropic Messages HTTP
  runtimes without embedding or requiring an external Agent SDK or CLI runtime.

## Uploaded Assets

No new 0.1.8 assets uploaded yet. A final macOS Intel release, if separately
authorized after all gates pass, must contain exactly the audited DMG, DMG blockmap,
ZIP, ZIP blockmap, and `latest-mac.yml`. Final notes must list each uploaded file and
its exact SHA256 digest. Local `test-results`, build output, and candidate evidence
archives are not public Release assets.

Public update metadata such as `latest*.yml` must match the exact installer set and
must not advertise Apple Silicon or Windows artifacts that are outside this scope.

## Truth Boundary

- The latest complete clean local Deep report before this version-only candidate
  change is bound to `7ed1b5fb4e7d414587734f8c660aca8b8c40bad9`: `163 total / 161
  required pass / 2 optional skip / 0 blocked / 0 fail`. It proves regression
  stability of that exact clean commit, not the future 0.1.8 package or public release.
- The two optional skips are external-network checks and are not passes.
- No non-project participant has completed the private M1 first-user drill. Automated
  tests do not prove first-time installation, Provider setup, copy clarity, or task
  completion on another person's machine.
- Provider availability depends on user-supplied real keys, account access, network,
  compatible protocols, and quota.
- Genesis remains a planning surface; this patch does not claim autonomous external
  child-agent execution, merge, push, or publication.
- Formal 1.0 acceptance remains open at 21 of 64 P0 requirements verified. This is a
  0.1.x patch candidate, not CaoGen 1.0 stable.
- The current public v0.1.7 Release has eight assets and Windows text that do not match
  the repository's approved five-asset Intel contract. This candidate does not edit,
  delete, or retroactively approve those remote assets.

## Known Blockers

- `release_identity`: the final 0.1.8 candidate commit and tag do not exist.
- `deep_test`: no clean Deep report is bound to the final 0.1.8 candidate commit yet.
- `p2_required` and `dag_finalization`: the final candidate evidence workflow has not
  rerun these required gates for 0.1.8.
- `packaging_release`: no provenance-bound, signed, notarized, stapled, installed, and
  launched 0.1.8 Intel five-asset set exists.
- `product_positioning`: required public-positioning validation is not yet bound to
  the final candidate evidence set.
- `release_notes`: this is a draft; exact assets, hashes, evidence reports, and final
  wording are still missing.
- `github_release_assets`: no public 0.1.8 asset set exists, and no publication has
  been authorized.
- Apple Silicon and Windows are paused. Skipped jobs must remain skips, not passes.
- Do not publish while any required scoped gate fails or the owner has not explicitly
  authorized the exact tag and GitHub Release operation.

## Security Statement

The repository and public assets must not include real keys, webhooks, certificates,
private keys, signing material, filled `.env` files, `test-results`, `out`, `dist`,
`node_modules`, local evidence packs, logs, or private URLs.

If any real credential is pushed, shared, or uploaded, deleting the public copy is not
sufficient; revoke or rotate it at the provider as well.

## macOS First Open

No 0.1.8 package is available yet. If the scoped candidate and final publication gates
later pass, users will open the signed and notarized Intel DMG from GitHub Releases,
drag CaoGen to Applications, and launch it normally without bypass commands. Until
then, v0.1.7 remains the latest public release and no 0.1.8 first-open behavior is
claimed.

## Final Required Checks

- `npm run test:release-workflow-contract`
- `npm run test:package-size-policy`
- `npm run test:macos-dmg-detach:required`
- `npm run test:product-positioning:required`
- `npm run typecheck`
- `npm run build`
- `npm run test:coding-standards:required`
- `npm run secret:scan:history`
- `npm run test:p2-release-scope:required`
- `npm run test:deep`
- read-only GitHub candidate workflow with version `0.1.8` and scope `macos-x64`
- `npm run dist:mac:release:x64`
- `npm run test:macos-release-audit:required -- --arch x64`
- `npm run test:packaged-app:mac:x64`
- final scoped notes and public asset audits after a separate publication decision
