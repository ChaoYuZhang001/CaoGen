# CaoGen v0.1.6 Release Notes

> Release decision: publish package version 0.1.6 as v0.1.6 on GitHub Releases after the release commit and remote tag are verified.

## Release Decision

v0.1.6 is the selected macOS x64 stability release. It is the first CaoGen release under `AGPL-3.0-only`, with a separate written commercial-license path for proprietary integration or distribution. The tag must point to the exact release commit, and only the five listed installer and update metadata assets may be uploaded.

## Highlights

- Creating a session no longer requires selecting a project; unassigned sessions remain available in a dedicated collection.
- Deleting the last session returns to a usable empty state, and a newly created session accepts input immediately.
- Projects can be archived, restored, and deleted from the project collection.
- New-session actions from the 3D office and project/session navigation now share the same creation path.
- Start suggestions remain closed when a session becomes active and load only after an explicit user action.
- Provider settings use a full-page workspace, and sessions support fixed Provider/model, automatic routing inside one Provider, or automatic routing across configured Providers.
- The packaged app now declares the `tree-sitter` runtime loader directly. Packaging fails if `node-gyp-build` is absent from `app.asar`, and the release gate launches the packaged app from a fresh user-data directory before publication.

## Uploaded Assets

- `CaoGen-0.1.6.dmg`
- `CaoGen-0.1.6.dmg.blockmap`
- `CaoGen-0.1.6-mac.zip`
- `CaoGen-0.1.6-mac.zip.blockmap`
- `latest-mac.yml`

The `latest*.yml` metadata and every installer archive are release assets only. Local build output and evidence directories are not uploaded.

### SHA256

| Asset | SHA256 |
|---|---|
| `CaoGen-0.1.6.dmg` | `7b193469e2c3b87546c797436652c8d73121f2bcdd7357850fa5521d605ef1f9` |
| `CaoGen-0.1.6.dmg.blockmap` | `e72745a97d84b872d0d65994484e903cf7621a0addcf76f3ad79a8b21b14d870` |
| `CaoGen-0.1.6-mac.zip` | `4ac838081f17ae2a645909171a7370bc348840894156f20d8ee76ba8c1a19b75` |
| `CaoGen-0.1.6-mac.zip.blockmap` | `96acd326104e568d51f208c6458db8b22f4b2bae0b81e144340801fc50f0a6e6` |
| `latest-mac.yml` | `419a2f6266cee414b44c0a608c6f3b9cd0469c47f293c2d6317782c4697aa4de` |

## Truth Boundary

- CaoGen is a multi-vendor AI work desktop with model/provider configuration, project rules, code execution, task orchestration, workspace isolation, plugins, project memory, file preview, and 3D office visualization.
- Genesis remains plan-layer orchestration; this release does not claim autonomous external child-agent execution, merging, pushing, or publishing.
- Provider and CLI capabilities depend on real keys, provider authentication, and locally configured tools when those integrations are selected.
- Multiple encrypted keys and error-driven same-provider failover are locally verified. Proactive quota probing and weighted key load balancing are not claimed.
- macOS document viewing provides a sandboxed system preview with extracted-structure fallback. Pixel-identical editing, complex formula execution, and presentation animation are not claimed.
- This release contains macOS x64 assets only. macOS arm64, a v0.1.6 Windows build, Linux, user-configured external-network parity, and the private 30-minute migration drill are not claimed.
- AGPL-compliant commercial use does not require a separate license. Proprietary integration or distribution rights require a signed written commercial agreement.
- Releases through v0.1.5 retain their historical MIT terms.

## Known Blockers

- The macOS packages are unsigned and not notarized.
- There is no macOS arm64, Windows, or Linux installer in v0.1.6.
- External provider connectivity still depends on the user's network, credentials, provider account, and local tool configuration.

## Security Statement

The repository and public release assets do not include real keys, webhooks, certificates, private keys, signing material, filled `.env` files, `test-results`, `out`, `dist`, `node_modules`, local evidence packs, logs, or private URLs.

If any real credential is ever pushed, shared, or uploaded, deleting the public copy is not sufficient; the credential must also be rotated or revoked at its provider.

## macOS First Open

These builds are unsigned. On first launch, right-click CaoGen in Finder, choose **Open**, then confirm **Open**. The release is not notarized and is not distributed through the Mac App Store.

## Verification

- TypeScript typecheck and production build.
- Full required deep-test suite: 84 required passes, 3 optional skips, 0 blocked, and 0 failures.
- P2 release scope: model/skill orchestration and both supported IDE integration gates proved; Windows GUI and user-configured external-network tracks remain outside this release claim.
- macOS x64 packaging audit verified DMG/ZIP integrity, x86_64 architecture, package version, license files, and the required `tree-sitter` / `node-gyp-build` files inside `app.asar`.
- Packaged-app startup smoke created the real `CaoGen` renderer from the packaged `app.asar` without a main-process module-loading error.
- SHA256 generation, release-note audit, product-positioning audit, public asset audit, and secret-history scan.
