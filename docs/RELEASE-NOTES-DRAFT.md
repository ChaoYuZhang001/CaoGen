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
Release. Exact `main@837f8f90945d558c44b2d05cbc09a24e93d1202f` passed clean source
gates, exact-commit Deep, Developer ID signing, notarization, stapling, Gatekeeper,
isolated installation, real renderer launch, package-size policy, and five-asset
verification in read-only workflow run `30212121353`. Independent artifact download,
final notes binding, publication preflight, and explicit owner authorization remain.

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

No public 0.1.8 assets have been uploaded. Read-only workflow run `30212121353`
produced the following private candidate set:

| Candidate file | Size | SHA256 |
|---|---:|---|
| `CaoGen-0.1.8.dmg` | 127,702,969 B | `bb79e9abf1a8e1e245c87feca352db109f275bc96af1d35469b8e6b82e9224c3` |
| `CaoGen-0.1.8.dmg.blockmap` | 134,481 B | `aa0b1924d8db3df620abbb82f76e66c2c2592b0b2491617e050527fe040618f5` |
| `CaoGen-0.1.8-mac.zip` | 127,017,842 B | `3befafbfda324062d1514607d2e9629798e0a501479e045ef4240edb823f39b8` |
| `CaoGen-0.1.8-mac.zip.blockmap` | 132,978 B | `435f0587ba2324742b152b9ad83b647e5fdc9e830c65fa0e7f1e03ed7c0bd3b6` |
| `latest-mac.yml` | 484 B | `8d76dcc865c48e2a18e2ebea6658509a65ca9e62c4e38929320f24338d101dc5` |

The candidate artifact-set SHA256 is
`48667aeb2f5bb2e16187e88c53a5db96d448d9cfa94e8c3afcfcaf561d510ed1`.
A final macOS Intel release, if separately authorized after all remaining gates pass,
must contain exactly these five audited files. Local `test-results`, build output, and
the Actions candidate evidence archive are not public Release assets.

Public update metadata such as `latest*.yml` must match the exact installer set and
must not advertise Apple Silicon or Windows artifacts that are outside this scope.

## Truth Boundary

- The exact candidate commit `837f8f90945d558c44b2d05cbc09a24e93d1202f` passed clean Deep in
  run `30212121353`: `163 total / 161 required pass / 2 optional skip / 0 blocked /
  0 fail`. It proves regression stability of that exact candidate, not publication or
  first-user success.
- The same run passed the `120/120` required macOS release audit, signed/notarized
  installation and real renderer launch. Apple Silicon, Windows, and complete-matrix
  jobs were skipped by scope.
- The later first-task restart and asynchronous catalog hydration fixes are not present
  in `837f8f90`. The current targeted real Electron report passed `11/11` with 8
  screenshots and page operations passed `22/22`, but the final signed candidate must
  be rerun on a clean descendant before publication.
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
- `candidate_freshness`: run `30212121353` predates the first-task restart recovery
  fix and cannot be used to publish the latest 0.1.8 source.
- `deep_test`, `dag_finalization`, `p2_required`, and `packaging_release`: the complete
  three-platform/formal 1.0 Release Doctor still lists these domains as open. The
  narrower Intel candidate equivalents passed in run `30212121353`; that scoped pass
  does not make the complete Doctor ready.
- `release_notes`: this remains a draft; the Actions artifact must be independently
  downloaded and its four candidate report families and five exact files must be bound
  into final notes on a clean publication-only descendant.
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
