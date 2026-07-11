# CaoGen v0.1.4 Release Notes

> Release decision: publish package version 0.1.4 as v0.1.4 on GitHub Releases after the release commit and remote tag are verified.

## Release Decision

v0.1.4 is the selected macOS x64 release for the current main branch. The tag must point to the exact release commit, and only the listed installer and update metadata assets may be uploaded.

## Highlights

- Local execution is now the default path, so Docker is not required for normal use.
- Optional engines and provider integrations remain optional; authentication is required only when the user selects a provider or CLI that needs it.
- Task execution has stronger recovery, idempotency, snapshot, and effect-reconciliation behavior.
- Provider routing, key failover, project rules, search/replace, file preview, and IDE integration received substantial reliability improvements.
- The 3D office now has clearer work zones, richer workstation detail, provider identity cues, and more stable agent movement.
- Code search and local command execution include tighter configuration and permission boundaries.

## Uploaded Assets

- `CaoGen-0.1.4.dmg`
- `CaoGen-0.1.4.dmg.blockmap`
- `CaoGen-0.1.4-mac.zip`
- `CaoGen-0.1.4-mac.zip.blockmap`
- `latest-mac.yml`

The `latest*.yml` metadata and every installer archive are release assets only. Local build output and evidence directories are not uploaded.

### SHA256

| Asset | SHA256 |
|---|---|
| `CaoGen-0.1.4.dmg` | `f7c578787702fb9b5720d133c659ef62a8163759f401e1106527c9e1c4b098f0` |
| `CaoGen-0.1.4.dmg.blockmap` | `ee21df9b44db7c5b3fa51c9828abce6a79731661c6fdc8916e563cb6073a651c` |
| `CaoGen-0.1.4-mac.zip` | `eedb671e96b46eb478f0c1fd41d46ee54d543e1926f9f9fe94393e46bb77c8b5` |
| `CaoGen-0.1.4-mac.zip.blockmap` | `e20f02ffc63fbb1fb5cfb8fb1740c4cba7ee742b3d4448ef90534833b47bfea8` |
| `latest-mac.yml` | `f9fb5e39bd328743950013907723cbd049e84cab01eb1bd10076b4a612fac1eb` |

## Truth Boundary

- CaoGen is a multi-vendor AI work desktop with model/provider configuration, project rules, code execution, task orchestration, workspace isolation, plugins, project memory, file preview, and 3D office visualization.
- Genesis remains plan-layer orchestration; this release does not claim autonomous external child-agent execution, merging, pushing, or publishing.
- Provider and CLI capabilities depend on real keys, provider authentication, and locally configured tools when those integrations are selected.
- Multiple encrypted keys and error-driven same-provider failover are locally verified. Proactive quota probing and weighted key load balancing are not claimed.
- macOS document viewing provides a sandboxed system preview with extracted-structure fallback. Pixel-identical editing, complex formula execution, and presentation animation are not claimed.
- This release contains macOS x64 assets only. macOS arm64, Windows GUI, user-configured external-network parity, and the private 30-minute migration drill are not claimed.

## Known Blockers

- The macOS packages are unsigned and not notarized.
- There is no macOS arm64, Windows, or Linux installer in v0.1.4.
- External provider connectivity still depends on the user's network, credentials, provider account, and local tool configuration.

## Security Statement

The repository and public release assets do not include real keys, webhooks, certificates, private keys, signing material, filled `.env` files, `test-results`, `out`, `dist`, `node_modules`, local evidence packs, logs, or private URLs.

If any real credential is ever pushed, shared, or uploaded, deleting the public copy is not sufficient; the credential must also be rotated or revoked at its provider.

## macOS First Open

These builds are unsigned. On first launch, right-click CaoGen in Finder, choose **Open**, then confirm **Open**. The release is not notarized and is not distributed through the Mac App Store.

## Verification

- TypeScript typecheck and production build.
- Full required deep-test suite.
- macOS x64 packaging audit.
- DMG verification, ZIP integrity checks, SHA256 generation, release-note audit, public asset audit, and secret-history scan.
