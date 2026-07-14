# CaoGen v0.1.5 Release Notes

> Release decision: publish package version 0.1.5 as v0.1.5 on GitHub Releases after the release commit and remote tag are verified.

## Release Decision

v0.1.5 is the selected macOS x64 release for the current main branch. The tag must point to the exact release commit, and only the listed installer and update metadata assets may be uploaded.

## Highlights

- Settings and Provider editing now use a full-page workspace instead of nested modal dialogs.
- Projects are first-class session containers, with direct project session creation and a dedicated collection for sessions without a project.
- New sessions expose three explicit routing scopes: fixed Provider/model, automatic routing inside one Provider, and automatic routing across configured Providers.
- The execution engine is owned by Provider configuration, so users no longer select an Agent engine for every session.
- Automatic routing recognizes research, planning, coding, testing, and documentation tasks, with user-configurable role mappings and custom rules.
- Cross-Provider selection happens before session creation; active sessions only switch among Providers compatible with the current engine so native context is preserved.

## Uploaded Assets

- `CaoGen-0.1.5.dmg`
- `CaoGen-0.1.5.dmg.blockmap`
- `CaoGen-0.1.5-mac.zip`
- `CaoGen-0.1.5-mac.zip.blockmap`
- `latest-mac.yml`

The `latest*.yml` metadata and every installer archive are release assets only. Local build output and evidence directories are not uploaded.

### SHA256

| Asset | SHA256 |
|---|---|
| `CaoGen-0.1.5.dmg` | `686754dd7b79ed51d4c5434436e04f0a0fa592aade8d1db8bb6fe4e89a90c93b` |
| `CaoGen-0.1.5.dmg.blockmap` | `5af0aa97812b360ed62abb404c2d124165804953ff3dc877b72af652e1904ff6` |
| `CaoGen-0.1.5-mac.zip` | `ff818c3a3b8ed9af9b921d7ca8505f77df3b9830654d1b07dc514ad8143d8301` |
| `CaoGen-0.1.5-mac.zip.blockmap` | `8ea1349c258ce158764534704c1248a79faf2000589c5ef2c0be239535c44fa9` |
| `latest-mac.yml` | `b416bc7661f0d0d4088666bb97e66387948abcb7832a960a660d22716507ee67` |

## Truth Boundary

- CaoGen is a multi-vendor AI work desktop with model/provider configuration, project rules, code execution, task orchestration, workspace isolation, plugins, project memory, file preview, and 3D office visualization.
- Genesis remains plan-layer orchestration; this release does not claim autonomous external child-agent execution, merging, pushing, or publishing.
- Provider and CLI capabilities depend on real keys, provider authentication, and locally configured tools when those integrations are selected.
- Multiple encrypted keys and error-driven same-provider failover are locally verified. Proactive quota probing and weighted key load balancing are not claimed.
- macOS document viewing provides a sandboxed system preview with extracted-structure fallback. Pixel-identical editing, complex formula execution, and presentation animation are not claimed.
- This release contains macOS x64 assets only. macOS arm64, Windows GUI, user-configured external-network parity, and the private 30-minute migration drill are not claimed.

## Known Blockers

- The macOS packages are unsigned and not notarized.
- There is no macOS arm64, Windows, or Linux installer in v0.1.5.
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
