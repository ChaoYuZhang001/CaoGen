# CaoGen v0.1.8 Historical Candidate Notes

> Status: do not publish. v0.1.7 remains the latest public release; the v0.1.8 assets
> recorded here are private historical candidate evidence for exact commit `03c3fee2`,
> not an authorized or current release.

## Release Decision

Exact commit `03c3fee2` produced a signed and notarized macOS Intel x64 patch candidate.
The five assets below are the complete private candidate set for that commit; they have
not been authorized or uploaded as a v0.1.8 GitHub Release and do not represent the
current source successor. The evidence is not a claim that the full CaoGen 1.0 vision
is complete.

## Highlights

- Preserve the Quick Start prompt, project, directory, Drive mode, permission, routing,
  Provider, model, and Studio subpage while recovering from a missing or unusable
  Provider through the real Provider editor.
- Restore the complete first-task draft after a renderer reload or app restart without
  storing API keys, Provider Base URLs, or model responses. Clear the saved draft after
  the first task starts successfully.
- Keep Project and Provider bindings while their catalogs are still loading, then fail
  closed for deleted or unusable entries without silently switching vendors.
- Preserve a valid fixed Provider/model selection when changing Drive mode while still
  failing closed if that selected model has actually disappeared.
- Keep Composer, Browser annotation, and artifact Preview sends truthful while a task is
  busy or the execution engine rejects a message: drafts remain intact until acceptance,
  unavailable states cannot send, and failures no longer appear as success.
- Continue using OpenAI-compatible HTTP APIs and native Anthropic Messages HTTP APIs
  without embedding or requiring an external Agent SDK, CLI login, or CLI runtime.
- Creating a session no longer requires selecting a project; those sessions remain available in the dedicated "Chats" collection.
- Deleting the last session returns to a usable empty state, and a newly created session accepts input immediately.
- Projects can be archived, restored, and deleted from the project collection.
- New-session actions from the 3D office and project/session navigation now share the same creation path.
- Start suggestions remain closed when a session becomes active and load only after an explicit user action.
- Provider settings use a full-page workspace, and sessions support fixed Provider/model, automatic routing inside one Provider, or automatic routing across configured Providers.
- The packaged app now declares the `tree-sitter` runtime loader directly. Packaging fails if `node-gyp-build` is absent from `app.asar`, and the release gate launches the packaged app from a fresh user-data directory before publication.

## Historical Candidate Assets (Not Uploaded)

- `CaoGen-0.1.8.dmg`
- `CaoGen-0.1.8.dmg.blockmap`
- `CaoGen-0.1.8-mac.zip`
- `CaoGen-0.1.8-mac.zip.blockmap`
- `latest-mac.yml`

The `latest*.yml` metadata and four installer/update files above are the complete private
candidate set for `03c3fee2`; no public v0.1.8 asset set exists. Local build output and
evidence directories remain excluded from any future public upload.

### SHA256

| Asset | SHA256 |
|---|---|
| `CaoGen-0.1.8.dmg` | `95ca1ad3be1440149bd458cffbdd3063a4476018e059b19b4f4cbb3bdfac64c0` |
| `CaoGen-0.1.8.dmg.blockmap` | `9683ef7f292049fd7265da874b24f6d09bfe90c6e15c3026d14a620a57cf6fd5` |
| `CaoGen-0.1.8-mac.zip` | `73fb195147282274be360c32b735772164bc1b7c5d9c2fe3cd8b12f34bf03e51` |
| `CaoGen-0.1.8-mac.zip.blockmap` | `63a1768f5454dd0a96663f530d9155a8316041d1234351ae9f854274b19968ac` |
| `latest-mac.yml` | `a40b8cad8ba76e3f9608a0e20c7ce0f2ed9b98fc22cb64907409efed3ee342a6` |

## Truth Boundary

- CaoGen is a multi-vendor AI work desktop with provider/model configuration, project
  rules, code execution, task orchestration, workspace isolation, plugins, project
  memory, file preview, and 3D office visualization.
- The supported model runtimes are OpenAI-compatible HTTP APIs and native Anthropic
  Messages HTTP APIs. Availability depends on real keys, account access, network
  conditions, quotas, and protocol compatibility.
- The base distribution does not embed or require an external Agent SDK, CLI login, or
  CLI runtime.
- Genesis remains planning-layer orchestration. This release does not claim autonomous
  external child-agent execution, merging, pushing, or publishing.
- Multiple encrypted keys and error-driven same-provider failover are verified. Proactive
  quota probing, weighted key load balancing, and universal cross-provider continuity are
  not claimed.
- This historical candidate contains macOS Intel x64 assets only. Apple Silicon,
  Windows, Linux, full 1.0 product acceptance, and the private 30-minute migration
  drill are outside its evidence scope.
- The application bundles inside both DMG and ZIP are Developer ID signed, notarized,
  accepted by Gatekeeper, and carry valid application tickets. The DMG file itself is not
  claimed to carry a stapled ticket.
- AGPL-compliant commercial use does not require a separate license. Proprietary
  integration or distribution rights require a signed written commercial agreement.

## Publication Blockers

- Current source has moved beyond `03c3fee2`; a refreshed clean candidate, independent
  verification, scoped publication preflight, final notes, and explicit owner approval
  are required before any v0.1.8 publication.
- No public v0.1.8 Release or asset set exists, and no Apple Silicon, Windows, or Linux
  installer is included in this historical candidate.
- External provider connectivity still depends on the user's network, credentials,
  provider account, quota, and service compatibility.
- The full 1.0 acceptance matrix remains open; v0.1.8 does not represent 1.0 stable.
- First-user onboarding and the 30-minute migration path still require validation with
  people outside the project.

## Security Statement

The repository and public release assets do not include real keys, webhooks,
certificates, private keys, signing material, filled `.env` files, `test-results`,
`out`, `dist`, `node_modules`, local evidence packs, logs, or private URLs.

If any real credential is ever pushed, shared, or uploaded, deleting the public copy is
insufficient; the credential must also be rotated or revoked at its provider.

## macOS First Open

No public v0.1.8 package is available. The recorded private candidate app is Developer
ID signed and notarized for macOS Intel x64, but it must not be presented as the current
download or installed from an unofficial public location.

## Verification

- Candidate commit: `03c3fee2837d120fce43f4b7d11bd25488be4d36` on `main`.
- GitHub candidate run: `30243108279`, scoped to macOS Intel x64; Apple Silicon and
  Windows jobs were skipped rather than counted as passes.
- Exact-commit Deep: `163 total / 161 required pass / 2 optional skip / 0 blocked /
  0 fail`.
- macOS x64 release audit: `120/120` required checks, including package/update metadata,
  x86_64 architecture, clean provenance, signing, application notarization/tickets,
  Gatekeeper, package integrity, and exclusion of external SDK/CLI files.
- Packaged-app smoke: isolated DMG install, clean detach, and real renderer startup
  passed.
- Candidate artifact `8644829708`: `255,552,267 B`, SHA256
  `ec343fe823c5e3a3502c4b6176d23dd59b46dd3e15c2338b06eab98f7384c16a`, with ZIP CRC
  validation and four identical latest/timestamped report pairs.
- Five-file artifact-set SHA256:
  `2abe8622e3b37873e69abdd5deb1f16c8739336181688eeb2e665c601792ff52`.
- Independent checks matched every asset size and SHA256, both update SHA512 entries,
  clean provenance, deep/strict signatures, Gatekeeper acceptance, application tickets,
  pure x86_64 architecture, and absence of the removed external SDK/CLI runtime.
- P2 release scope: P2-002, P2-003, and P2-005 passed; paused-platform GUI and optional
  external-network evidence remain outside this release scope.
