# CaoGen Rolling Release Draft Notes

> Status: Do not publish this rolling draft. v0.1.6 is the latest public release; no later release version or platform set has been selected.

## Release Decision

The current package version is 0.1.6. No later release is selected. The next GitHub Releases body must be finalized only after the owner chooses a version and platform scope, a clean release commit passes every required gate, and the exact artifact hashes are available.

## Candidate Highlights

- No next-release feature or fix list is committed yet.
- Add only behavior that is implemented and verified on the selected release commit.
- Keep platform, signing, external-provider, and migration claims conditional on their own evidence.

## Uploaded Assets

No new release assets uploaded yet. The five v0.1.6 macOS x64 assets are documented in `docs/RELEASE-NOTES-FINAL.md`; they are not placeholders for a later release.

Future release assets must be listed here exactly after a version is selected. Allowed public assets are installer and update metadata files only: DMG, mac zip, Windows installer, AppImage, blockmap, and `latest*.yml`. Local build output and evidence directories are never release assets.

## Truth Boundary

- CaoGen is a multi-vendor AI work desktop with model/provider configuration, project rules, code execution, task orchestration, workspace isolation, plugins, project memory, file preview, and 3D office visualization.
- Genesis remains plan-layer orchestration; no release may claim autonomous external child-agent execution, merging, pushing, or publishing without separate proof.
- Provider and CLI capabilities depend on real keys, provider authentication, and locally configured tools when those integrations are selected.
- Multiple encrypted keys and error-driven same-provider failover are locally verified. Proactive quota probing and weighted key load balancing are not claimed.
- macOS document viewing provides a sandboxed system preview with extracted-structure fallback. Pixel-identical editing, complex formula execution, and presentation animation are not claimed.
- Platform support must follow real platform-specific packaging and runtime evidence.
- User-configured external-network parity and the private 30-minute migration drill remain outside public claims until their separate evidence passes.
- AGPL-compliant commercial use does not require a separate license; proprietary integration or distribution rights require a signed written commercial agreement.

## Known Blockers

- release_identity: no later release version, clean release commit, or remote tag is selected.
- deep_test: a future candidate must rerun the complete required suite from its exact clean release commit.
- p2_required: release-scope P2 evidence must be refreshed and bound to the selected candidate.
- packaging_release: future assets and checksums do not exist until packaging is regenerated from the selected candidate.
- release_notes: the next exact release body has not been written or audited.
- github_release_assets: no later GitHub Release asset set exists; uploaded files and public text metadata require post-upload audit.
- macOS packages remain unsigned unless signing and notarization are completed for a future release.
- Windows GUI and user-configured external-network evidence remain separate validation tracks.

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
- `npm run test:packaged-app:mac`
- `npm run test:product-positioning:required`
- `npm run workos:release-doctor -- --refresh --version X.Y.Z`
- `npm run test:release-notes-audit:final -- --version X.Y.Z`
- `npm run workos:release-doctor -- --required --version X.Y.Z`
- `npm run test:github-release-audit:read-text:required -- --tag vX.Y.Z --expected-assets-from-dist`
- `npm run secret:scan:history`
