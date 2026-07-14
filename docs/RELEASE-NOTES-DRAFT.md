# CaoGen Rolling Release Draft Notes

> Status: Do not publish this rolling draft. Package version v0.1.5 is selected as a macOS x64 release candidate for distribution through GitHub Releases; the latest public release remains v0.1.4 until all gates pass.

## Release Decision

v0.1.5 is selected for macOS x64. Its proposed exact public body is in `docs/RELEASE-NOTES-FINAL.md`; it must not be published before the clean release commit and final gates are verified.

## Uploaded Assets

The v0.1.5 candidate assets exist locally. No new release assets uploaded yet.

Future release assets must be listed here exactly after a version is selected. Allowed public assets are installer and update metadata files only: DMG, mac zip, Windows installer, AppImage, blockmap, and `latest*.yml`. Local build output and evidence directories are never release assets.

## Truth Boundary

- CaoGen is a multi-vendor AI work desktop with model/provider configuration, project rules, code execution, task orchestration, workspace isolation, plugins, project memory, file preview, and 3D office visualization.
- Genesis remains plan-layer orchestration; no release may claim autonomous external child-agent execution, merging, pushing, or publishing without separate proof.
- Provider and CLI capabilities depend on real keys, provider authentication, and locally configured tools when those integrations are selected.
- Multiple encrypted keys and error-driven same-provider failover are locally verified. Proactive quota probing and weighted key load balancing are not claimed.
- macOS document viewing provides a sandboxed system preview with extracted-structure fallback. Pixel-identical editing, complex formula execution, and presentation animation are not claimed.
- Windows GUI proof, user-configured external-network parity, and the private 30-minute migration drill remain outside public claims until their separate evidence passes.

## Known Blockers

- release_identity: v0.1.5 is selected but is not yet bound to a clean release commit and remote tag.
- deep_test: any future release must rerun the complete required suite from its exact clean release commit.
- packaging_release: any future assets and checksums must be regenerated and rebound after its code is final.
- release_notes: any future exact body must pass against that same future release commit before publishing.
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
- `npm run workos:release-doctor -- --refresh --version 0.1.5`
- `npm run test:release-notes-audit:final`
- `npm run workos:release-doctor -- --required --version 0.1.5`
- `npm run test:github-release-audit:read-text:required -- --tag vX.Y.Z --expected-assets-from-dist`
- `npm run secret:scan:history`
