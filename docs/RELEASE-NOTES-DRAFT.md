# CaoGen Rolling Release Draft Notes

> Status: Do not publish this rolling draft. Package version v0.1.6 is selected as a macOS x64 stability release candidate; the latest public release remains v0.1.5 until every required gate passes.

## Release Decision

v0.1.6 is selected for macOS x64 distribution through GitHub Releases. It will be the first release of the current source tree under `AGPL-3.0-only` with a separate written commercial-license inquiry path. The exact public body must not be finalized or published before the clean release commit, artifact hashes, and final gates are verified.

## Candidate Highlights

- Creating a session no longer requires selecting a project; unassigned sessions remain available in a dedicated collection.
- Deleting the last session returns to a usable empty state, and a newly created session accepts input immediately.
- Project archive, restore, and delete actions are available from the project collection.
- New-session actions from the 3D office and project/session navigation share the same creation path.
- Start suggestions remain closed on session activation and load only after an explicit user action.
- Provider settings remain a full-page workspace, and new sessions retain the three explicit routing scopes introduced in v0.1.5.
- The root license is `AGPL-3.0-only`; releases through v0.1.5 retain their historical MIT terms.

## Uploaded Assets

No new release assets uploaded yet. The v0.1.6 candidate assets do not exist until the exact clean release commit passes the required gates and macOS x64 packaging is regenerated.

Future release assets must be listed here exactly after a version is selected. Allowed public assets are installer and update metadata files only: DMG, mac zip, Windows installer, AppImage, blockmap, and `latest*.yml`. Local build output and evidence directories are never release assets.

## Truth Boundary

- CaoGen is a multi-vendor AI work desktop with model/provider configuration, project rules, code execution, task orchestration, workspace isolation, plugins, project memory, file preview, and 3D office visualization.
- Genesis remains plan-layer orchestration; no release may claim autonomous external child-agent execution, merging, pushing, or publishing without separate proof.
- Provider and CLI capabilities depend on real keys, provider authentication, and locally configured tools when those integrations are selected.
- Multiple encrypted keys and error-driven same-provider failover are locally verified. Proactive quota probing and weighted key load balancing are not claimed.
- macOS document viewing provides a sandboxed system preview with extracted-structure fallback. Pixel-identical editing, complex formula execution, and presentation animation are not claimed.
- v0.1.6 currently targets macOS x64 only. A Windows x64 asset must not be added without a separate real-Windows verification run.
- User-configured external-network parity and the private 30-minute migration drill remain outside public claims until their separate evidence passes.
- AGPL-compliant commercial use does not require a separate license; proprietary integration or distribution rights require a signed written commercial agreement.

## Known Blockers

- release_identity: v0.1.6 is selected but is not yet bound to a clean release commit and remote tag.
- deep_test: v0.1.6 must rerun the complete required suite from its exact clean release commit.
- packaging_release: v0.1.6 assets and checksums must be regenerated after the candidate code and documentation are final.
- release_notes: the exact v0.1.6 body must pass against that same release commit before publishing.
- macOS packages remain unsigned unless signing and notarization are completed for a future release.
- Windows GUI and user-configured external-network evidence remain separate, non-default validation tracks.

## Security Statement

The repository and public release assets must not include real keys, webhooks, certificates, private keys, signing material, filled `.env` files, `test-results`, `out`, `dist`, `node_modules`, local evidence packs, logs, or private URLs.

If any real credential is pushed, shared, or uploaded, deleting the public copy is not sufficient; the credential must also be rotated or revoked at its provider.

## macOS First Open

If a future macOS build remains unsigned, its final release notes must tell users to right-click CaoGen in Finder, choose **Open**, then confirm **Open**. The notes must not imply notarization or Mac App Store distribution unless those steps are complete.

## Final Required Checks

- `npm run typecheck`
- `npm run build`
- `npm run test:deep`
- `npm run test:release-packaging-audit:required`
- `npm run test:product-positioning:required`
- `npm run workos:release-doctor -- --refresh --version 0.1.6`
- `npm run test:release-notes-audit:final`
- `npm run workos:release-doctor -- --required --version 0.1.6`
- `npm run test:github-release-audit:read-text:required -- --tag vX.Y.Z --expected-assets-from-dist`
- `npm run secret:scan:history`
