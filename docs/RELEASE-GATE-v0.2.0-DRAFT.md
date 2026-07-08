# CaoGen v0.2.0 Release Gate Draft

> Updated: 2026-07-08 Asia/Shanghai. This is a draft checklist only. Do not publish a `v0.2.0` GitHub Release until every required gate below is proved by current evidence.

## Current Public Release

| Item | State |
|---|---|
| Latest public GitHub Release | `v0.1.2` |
| Current package version | `0.1.2` |
| `origin/main` baseline | Check with `git rev-parse origin/main` on the release commit; last pulled baseline before this draft update was `448ecaf` |
| Release decision | Do not publish `v0.2.0` yet |

## Required Before Publishing

| Gate | Required command or evidence | Current status |
|---|---|---|
| Version bump | `package.json` and `package-lock.json` updated from `0.1.2` to the chosen release version | Open |
| Local type/build | `npm run typecheck` and `npm run build` pass | Passed on current worktree; rerun on release commit |
| Deep gate | `npm run test:deep` pass | Last known pass: 2026-07-08, 65 checks |
| P2 local smoke | `npm run test:p2` pass | Last known pass after validators fix |
| P2 required | `npm run test:p2-required` pass | Open: P2-001 GUI and P2-004 China external still failing |
| P2 audit strict | `npm run test:p2-audit -- --required` pass | Open: P2-001 `missing_evidence`, P2-004 `missing_external` |
| IDE build + VS Code host | `npm run test:p2-ide-build-and-vscode:required` pass with VS Code and JetBrains plugin build evidence | Passed on current worktree |
| JetBrains real IDE | `npm run test:jetbrains-recorder-e2e:required` and `npm run test:jetbrains-ide-interaction:required` pass with recorder/runIde evidence | Passed on current worktree |
| China external | `npm run test:china-real-network:required` and `npm run test:china-tool-call-parity:required` pass with real public HTTPS targets | Open |
| N1 migration | Human 30-minute migration drill record reviewed and `npm run test:n1-migration-audit:required` passes | Open |
| Packaging | `npm run dist:mac` produces expected DMG/zip assets and `npm run test:release-packaging-audit:required` passes; Windows/Linux only if actually verified | Open |
| Public GitHub Release assets | `npm run test:github-release-audit:required` passes before release edits; after publishing, run `npm run test:github-release-audit:required -- --tag v0.2.0` | Current public v0.1.0/v0.1.1/v0.1.2 assets passed; v0.2.0 not created |
| Secret hygiene | `npm run secret:scan` before commit, `npm run secret:scan:history` before release | Passed on current worktree/history; rerun immediately before release |
| Release doctor | `npm run workos:release-doctor -- --required` summarizes all domains as ready | Open |

## Release Notes Requirements

The final GitHub Release body must include:

- Supported platforms and the exact artifacts uploaded.
- macOS first-open instructions if the build is still unsigned.
- Conditional Claude/Gemini statements: Claude needs a real login/API key; Gemini CLI installed is not enough without auth.
- Work OS Phase 1 truth boundary: Genesis is plan-layer only, not external child-Agent execution or auto publish.
- P2 evidence summary with links or paths to the final reports used for the release decision.
- A statement that real keys, webhooks, certs, `.env`, signing material, `test-results`, `out`, `dist`, `node_modules`, and local evidence packs are not included in the repo or release assets.
- A list of exact uploaded asset names. Allowed public assets are installer/update files only: DMG, mac zip, Windows installer, AppImage, blockmap, and `latest*.yml`.

## Stop Conditions

Stop the release immediately if any of these is true:

- Any real secret, webhook URL, private key, certificate, signing material, or filled `.env` appears in `git status`, staged diff, or release assets.
- `npm run secret:scan:history` fails on a high-confidence real credential.
- `npm run test:github-release-audit:required` reports an unexpected, suspicious, or forbidden public Release asset. Delete the asset and rotate/revoke the credential if it contained a real secret.
- `test:p2-required` or strict P2 audit still reports `missing_evidence` or `missing_external`.
- Packaging produces assets for a platform that was not actually tested but the notes imply support.
- Release notes claim Genesis can execute, merge, push, or publish through external child Agents before that is proved by implementation and tests.
