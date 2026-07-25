# CaoGen v0.1.7 Release Notes

## Release Decision

v0.1.7 is the selected signed and notarized macOS Intel x64 wedge release. The five assets below are the complete upload set for this version on GitHub Releases. This release is a truthful 0.1.x delivery of currently verified capabilities, not a claim that the full CaoGen 1.0 vision is complete.

## Highlights

- The desktop runtime now connects through OpenAI-compatible APIs and native Anthropic Messages APIs without embedding an external Agent SDK or CLI.
- The macOS Intel package is Developer ID signed, notarized, stapled, accepted by Gatekeeper, and verified through an isolated DMG install and real renderer launch.
- Removing the embedded external runtime reduced the local unsigned Intel DMG and ZIP baselines by more than 36% while preserving the supported provider, project, session, routing, tool, memory, preview, and 3D office surfaces.
- Provider configuration supports multiple providers, multiple encrypted keys, custom Base URLs, local compatible services, and error-driven same-provider key failover.
- Sessions can use a fixed provider/model, automatic routing within one provider, or automatic routing across configured providers.

## Uploaded Assets

- `CaoGen-0.1.7.dmg`
- `CaoGen-0.1.7.dmg.blockmap`
- `CaoGen-0.1.7-mac.zip`
- `CaoGen-0.1.7-mac.zip.blockmap`
- `latest-mac.yml`

The `latest*.yml` metadata and the four installer/update files above are the only public release assets for v0.1.7. Local build output and evidence directories are excluded.

### SHA256

| Asset | SHA256 |
|---|---|
| `CaoGen-0.1.7.dmg` | `24bb2e4d6d98987955495b51fa4d6a8feda9634b923a3fa9e5f66f9fd60f0d9b` |
| `CaoGen-0.1.7.dmg.blockmap` | `d54ad1b15934d0f3d1a464d4d8500ac41ddf54266911656ad83b0182508e3c8a` |
| `CaoGen-0.1.7-mac.zip` | `1e668a18dfb758b20dcadadf23b6a95433d6c4c8197a753738a54ba33722af45` |
| `CaoGen-0.1.7-mac.zip.blockmap` | `8e319a8507769031abb06a8b348a605b4510a7944bd17c9486063e81a043772a` |
| `latest-mac.yml` | `dbe298b83aa9e5c8a546129698d4d0915e1ddecfa1428412a21531a68dc0cf5c` |

## Truth Boundary

- CaoGen is a multi-vendor AI work desktop with provider/model configuration, project rules, code execution, task orchestration, workspace isolation, plugins, project memory, file preview, and 3D office visualization.
- The supported model runtimes are OpenAI-compatible HTTP APIs and native Anthropic Messages HTTP APIs. Availability depends on real keys, account access, network conditions, quotas, and protocol compatibility.
- The base distribution does not embed or require an external Agent SDK, CLI login, or CLI runtime.
- Genesis remains planning-layer orchestration. This release does not claim autonomous external child-agent execution, merging, pushing, or publishing.
- Multiple encrypted keys and error-driven same-provider failover are verified. Proactive quota probing, weighted key load balancing, and universal cross-provider continuity are not claimed.
- This release contains macOS Intel x64 assets only. Apple Silicon, Windows, Linux, full 1.0 product acceptance, and the private 30-minute migration drill are outside this release claim.
- AGPL-compliant commercial use does not require a separate license. Proprietary integration or distribution rights require a signed written commercial agreement.

## Known Blockers

- No Apple Silicon, Windows, or Linux installer is included in v0.1.7.
- External provider connectivity still depends on the user's network, credentials, provider account, quota, and service compatibility.
- The full 1.0 acceptance matrix remains open; v0.1.7 does not represent 1.0 stable.
- First-user onboarding and the 30-minute migration path still require validation with people outside the project.

## Security Statement

The repository and public release assets do not include real keys, webhooks, certificates, private keys, signing material, filled `.env` files, `test-results`, `out`, `dist`, `node_modules`, local evidence packs, logs, or private URLs.

If any real credential is ever pushed, shared, or uploaded, deleting the public copy is insufficient; the credential must also be rotated or revoked at its provider.

## macOS First Open

Open `CaoGen-0.1.7.dmg`, drag CaoGen to Applications, and launch it normally. The app is Developer ID signed, notarized, and stapled for macOS Intel x64. Download only from the official GitHub Releases page and verify the SHA256 value above.

## Verification

- Candidate commit: `e8f617f822be458065dabe7f2440d1f5a33ee2b3` on `main`.
- GitHub candidate run: `30150795350`, scoped to macOS Intel x64; Apple Silicon and Windows jobs were skipped rather than counted as passes.
- Exact-commit Deep: `157 total / 155 required pass / 2 optional skip / 0 blocked / 0 fail`.
- macOS x64 release audit: `120/120` required checks, including package/update metadata, x86_64 architecture, clean provenance, signing, notarization, staple, Gatekeeper, package integrity, and exclusion of external SDK/CLI files.
- Packaged-app smoke: isolated DMG install, clean detach, and real renderer startup passed.
- P2 release scope: P2-002, P2-003, and P2-005 passed; Windows GUI and China external-network evidence remain outside this release scope.
- Final release-note audit passed from a clean descendant commit and binds these notes to the exact five candidate assets and all four evidence report families.
