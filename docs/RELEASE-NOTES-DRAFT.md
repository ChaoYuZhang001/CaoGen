# CaoGen Rolling Release Draft Notes

> Status: Do not publish yet. Current package version: 0.1.3. Latest public release remains v0.1.3 on GitHub Releases.

## Release Decision

Do not publish a new release until the owner chooses the next version number and every required gate is current. The current draft exists to keep public claims, asset rules, and security checks ready before the final GitHub Releases entry is created.

## Uploaded Assets

No new release assets uploaded yet.

Local macOS candidate assets have been generated for the current package version, but they are not uploaded. Final release asset names must be listed here exactly after publishing is approved. Allowed public assets are installer and update metadata files only: DMG, mac zip, Windows installer, AppImage, blockmap, and `latest*.yml`. The release tag must match the version chosen by the owner.

## Truth Boundary

- CaoGen can be described as a multi-vendor AI work desktop with model/provider configuration, project rules, code execution, task orchestration, workspace isolation, plugins, project memory, file preview, and 3D office visualization.
- Product copy must not mention external product names, use comparison framing, or claim parity with named products.
- Work OS Phase 1 can be described as merged to main with local/mocked deep-gate evidence.
- Genesis is plan-layer orchestration only; it does not execute, merge, push, or publish through external child Agents.
- External provider and CLI capability claims must stay conditional on a real login, API key, provider auth, and configured local tools.
- Multiple encrypted keys and error-driven same-Provider key failover are locally proved; proactive quota probing and weighted key load balancing are not claimed.
- macOS Office viewing may be described as a sandboxed system-document preview with first-page thumbnail and extracted-structure fallback. Page, sheet, and slide units can be referenced by the Agent. Do not claim pixel-identical original-application layout, editing, complex formulas, or animations.
- Do not claim Windows GUI evidence, China external network/tool-call parity, N1 migration proof, complete Office layout rendering, or packaging readiness until the required gates pass.

## Known Blockers

- release_notes: final notes must be audited again after all gates pass and exact uploaded assets exist.

Non-claimed boundaries that must stay out of the final public claims unless separately proved:

- P2-001 Windows GUI required evidence remains delegated to a Windows desktop run.
- P2-004 China external network/tool-call parity requires user-configured real targets and providers.
- n1_migration: the human 30-minute migration drill record is still missing.
- macOS packages are unsigned; keep the first-open Gatekeeper instruction unless signing and notarization are completed.

## Security Statement

The repository and public release assets must not include real keys, webhooks, certificates, private keys, signing material, filled `.env` files, `test-results`, `out`, `dist`, `node_modules`, local evidence packs, logs, or private URLs.

If any real credential was pushed, shared, or uploaded, delete the public copy and rotate or revoke it at the provider. Git deletion alone is not enough.

## macOS First Open

If the macOS build remains unsigned, the final release notes must include the first-open Gatekeeper instruction: right-click the app, choose Open, then confirm Open. The notes must not imply App Store distribution or notarization unless those steps are actually complete.

## Final Required Checks

- `npm run workos:release-doctor -- --refresh --required`
- `npm run typecheck`
- `npm run build`
- `npm run test:deep`
- `npm run test:p2`
- `npm run test:p2-ide-build-and-vscode:required`
- `npm run test:jetbrains-recorder-e2e:required`
- `npm run test:jetbrains-ide-interaction:required`
- `npm run test:p2-audit`
- `npm run test:release-packaging-audit:required`
- `npm run test:product-positioning:required`
- `npm run test:github-release-audit:required -- --tag vX.Y.Z`
- `npm run test:github-release-audit:read-text:required -- --tag vX.Y.Z`
- `npm run test:release-notes-audit:final`
- `npm run secret:scan:history`

Only add `npm run test:p2-audit -- --required`, `npm run test:n1-migration-audit:required`, Windows GUI required checks, or China external required checks when the release body claims those exact proofs.
