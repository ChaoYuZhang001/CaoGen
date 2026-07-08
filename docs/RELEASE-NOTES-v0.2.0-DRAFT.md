# CaoGen v0.2.0 Draft Release Notes

> Status: Do not publish yet. Latest public release remains v0.1.2 on GitHub Releases.

## Release Decision

Do not publish v0.2.0 yet. The current draft exists to keep public claims, asset rules, and security checks ready before the final GitHub Releases entry is created.

## Uploaded Assets

No v0.2.0 assets uploaded yet.

Final release asset names must be listed here exactly after packaging. Allowed public assets are installer and update metadata files only: DMG, mac zip, Windows installer, AppImage, blockmap, and `latest*.yml`.

## Truth Boundary

- Work OS Phase 1 can be described as merged to main with local/mocked deep-gate evidence.
- Genesis is plan-layer orchestration only; it does not execute, merge, push, or publish through external child Agents.
- Claude and Gemini capability claims must stay conditional on a real login, API key, provider auth, and configured local tools.
- Do not claim Windows GUI evidence, China external network/tool-call parity, N1 migration proof, or packaging readiness until the required gates pass.

## Known Blockers

- p2_required: P2-001 Windows GUI required evidence and P2-004 China external evidence remain open.
- n1_migration: the human 30-minute migration drill record is still missing.
- packaging_release: package version, publish URL, dist assets, and packaging audit are not ready.
- release_notes: final notes must be audited again after all gates pass and exact uploaded assets exist.

## Security Statement

The repository and public release assets must not include real keys, webhooks, certificates, private keys, signing material, filled `.env` files, `test-results`, `out`, `dist`, `node_modules`, local evidence packs, logs, or private URLs.

If any real credential was pushed, shared, or uploaded, delete the public copy and rotate or revoke it at the provider. Git deletion alone is not enough.

## macOS First Open

If the v0.2.0 macOS build remains unsigned, the final release notes must include the first-open Gatekeeper instruction: right-click the app, choose Open, then confirm Open. The notes must not imply App Store distribution or notarization unless those steps are actually complete.

## Final Required Checks

- `npm run workos:release-doctor -- --refresh --required`
- `npm run typecheck`
- `npm run build`
- `npm run test:deep`
- `npm run test:p2-required`
- `npm run test:p2-audit -- --required`
- `npm run test:n1-migration-audit:required`
- `npm run test:release-packaging-audit:required`
- `npm run test:github-release-audit:required -- --tag v0.2.0`
- `npm run test:github-release-audit:read-text:required -- --tag v0.2.0`
- `npm run test:release-notes-audit:final`
- `npm run secret:scan:history`
