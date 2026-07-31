# CaoGen 0.1.8 macOS Intel Patch Candidate Draft

> Status: Do not publish this draft. v0.1.7 is the latest public release on
> GitHub Releases. The signed 0.1.8 candidate exists only as a private Actions
> artifact. No new release assets uploaded yet; specifically, no 0.1.8 public
> Release assets have been uploaded.

## Release Decision

The package and lockfile version is `0.1.8`. CaoGen remains a multi-vendor AI work desktop.
This patch candidate exists because user-facing fixes merged after the
v0.1.7 tag and are not present in the package that users can currently download.
The candidate scope is macOS Intel x64 only. Apple Silicon, Windows, Linux, and the
formal three-platform matrix remain outside this patch candidate.

Preparation and validation of this candidate do not authorize a tag or a public
Release. Exact `main@9591c20bde2330a6f57951e7381b5e7e9d642091` passed clean source
gates, exact-commit Deep, Developer ID signing, notarization, stapling, Gatekeeper,
isolated installation, real renderer launch, package-size policy, and five-asset
verification in read-only workflow run `30215660873`. The five candidate assets and
four report families were independently downloaded and checked. Final notes binding,
publication preflight, and explicit owner authorization remain. The current source now
also contains a later fixed-model/Drive correction, so this exact candidate is historical
and must be regenerated before the latest source can be published.

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
- Restore the complete first-task draft after a renderer reload or app restart, while
  excluding API keys, Provider Base URLs, and model responses from the local draft
  record. Clear the record after the first task starts successfully.
- Preserve saved Project and Provider bindings while their catalogs are still loading.
  After loading completes, fail closed for deleted or unusable Providers without
  silently switching vendors, and keep the remaining draft intact while the user
  recreates the Provider through the real editor.
- Retain the shipped OpenAI-compatible HTTP and native Anthropic Messages HTTP
  runtimes without embedding or requiring an external Agent SDK or CLI runtime.

## Uploaded Assets

No public 0.1.8 assets have been uploaded. Read-only workflow run `30215660873`
produced the following private candidate set:

| Candidate file | Size | SHA256 |
|---|---:|---|
| `CaoGen-0.1.8.dmg` | 127,700,399 B | `6ef85b3e612b3c008c07b8db61794e991eaed4d68d88f266e6b79370c00346c7` |
| `CaoGen-0.1.8.dmg.blockmap` | 132,560 B | `7f8106b550893455490a0a1201ead9e35a9a0cd24dc226abb11a1ff6ac12216e` |
| `CaoGen-0.1.8-mac.zip` | 127,018,880 B | `3229d52d18722b54824638ff0a81e248b5c646b7153dfa840d73aa18144bca18` |
| `CaoGen-0.1.8-mac.zip.blockmap` | 133,809 B | `50f473753f275540990883532205261de39dc696b04fd81f92251eece08f0158` |
| `latest-mac.yml` | 484 B | `613dca4e5568c01486b57055e2251ddc6129c7a4cebd8a9f6f573c91fabd9872` |

The candidate artifact-set SHA256 is
`b5e03719796ea3236fab617c8e1493a238e3a07e48552daa1dc74b04f7d27252`.
These five audited files bind only exact commit `9591c20b`; they cannot be reused to
publish the later source. Local `test-results`, build output, and the Actions candidate
evidence archive are not public Release assets.

GitHub Actions artifact `8636056669`, named
`caogen-release-macos-x64-9591c20bde2330a6f57951e7381b5e7e9d642091`, contains
the candidate assets and evidence reports and expires on 2026-08-09. The independent
download matched the release audit and packaged-app report for every file size and
SHA256 digest.

Public update metadata such as `latest*.yml` must match the exact installer set and
must not advertise Apple Silicon or Windows artifacts that are outside this scope.

## Truth Boundary

- The exact candidate commit `9591c20bde2330a6f57951e7381b5e7e9d642091` passed clean Deep in
  run `30215660873`: `163 total / 161 required pass / 2 optional skip / 0 blocked /
  0 fail`. It proves regression stability of that exact candidate, not publication or
  first-user success.
- The same run passed the `120/120` required macOS release audit, signed/notarized
  installation and real renderer launch. Apple Silicon, Windows, and complete-matrix
  jobs were skipped by scope.
- The first-task restart and asynchronous catalog hydration fixes are present in this
  candidate. Their targeted real Electron report passed `11/11` with 8 screenshots and
  page operations passed `22/22`; the exact candidate then passed the complete Deep and
  signed distribution workflow.
- The later fixed-model/Drive correction is not present in `9591c20b`. Its targeted
  real Electron report passed `12/12` with 9 screenshots and page operations passed
  `22/22`, but those checks do not bind a signed candidate.
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

- `release_identity`: the exact candidate exists, but no v0.1.8 tag or publication-only
  release identity exists.
- `candidate_freshness`: run `30215660873` predates the fixed-model/Drive correction
  and cannot publish the latest 0.1.8 source.
- `deep_test`, `dag_finalization`, `p2_required`, and `packaging_release`: the complete
  three-platform/formal 1.0 Release Doctor still lists these domains as open. The
  narrower Intel candidate equivalents passed in run `30215660873`; that scoped pass
  does not make the complete Doctor ready.
- `release_notes`: this remains a draft; the independently checked four candidate report
  families and five exact files must still be bound into final notes on a clean
  publication-only descendant.
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

No public 0.1.8 package is available yet. If the remaining scoped publication gates
later pass and the owner authorizes publication, users will open the signed and
notarized Intel DMG from GitHub Releases,
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
