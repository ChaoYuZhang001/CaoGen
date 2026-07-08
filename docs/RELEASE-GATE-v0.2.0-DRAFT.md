# CaoGen v0.2.0 Release Gate Draft

> Updated: 2026-07-08 Asia/Shanghai. This is a draft checklist only. Do not publish a `v0.2.0` GitHub Release until every blocking gate below is proved by current evidence.

## Current Public Release

| Item | State |
|---|---|
| Latest public GitHub Release | `v0.1.2` |
| Current package version | `0.1.2` |
| `origin/main` baseline | Check with `git rev-parse origin/main` on the release commit; last pulled baseline before this merge was `ce2e2ee` |
| Release decision | Do not publish `v0.2.0` yet |

## Required Before Publishing

| Gate | Required command or evidence | Current status |
|---|---|---|
| Version bump | `package.json` and `package-lock.json` updated from `0.1.2` to the chosen release version | Open |
| Local type/build | `npm run typecheck` and `npm run build` pass | Passed on current worktree; rerun on release commit |
| Deep gate | `npm run test:deep` pass | Last known pass: 2026-07-08, 65 checks |
| P2 local smoke | `npm run test:p2` pass | Last known pass after validators fix |
| P2 release scope | P2-002/P2-003/P2-005 proved by `npm run test:p2`, `npm run test:p2-ide-build-and-vscode:required`, and `npm run test:jetbrains-ide-interaction:required` | Blocking scope only; full strict audit may still report delegated/user-configured gaps |
| IDE build + VS Code host | `npm run test:p2-ide-build-and-vscode:required` pass with VS Code and JetBrains plugin build evidence | Passed on current worktree |
| JetBrains real IDE | `npm run test:jetbrains-recorder-e2e:required` and `npm run test:jetbrains-ide-interaction:required` pass with recorder/runIde evidence | Passed on current worktree |
| P2-001 Windows GUI | Separate Windows agent will compile/run strict GUI evidence after this release-gate branch is submitted | Non-blocking for this commit; do not claim Windows strict GUI proof until it lands |
| P2-004 China external | User-configured real network/provider evidence via `npm run test:china-real-network:required` and `npm run test:china-tool-call-parity:required` | Non-blocking; release notes must frame it as requiring user credentials/config |
| N1 migration | Human 30-minute migration audit | Not required for v0.2.0; do not claim N1 pass without evidence |
| Packaging | `npm run dist:mac` produces expected DMG/zip assets and `npm run test:release-packaging-audit:required` passes; Windows/Linux only if actually verified | Open |
| Release notes | `npm run test:release-notes-audit:final` passes against the final GitHub Release body before publishing | Draft exists; final audit still open |
| Public GitHub Release assets | `npm run test:github-release-audit:required` passes before release edits; after publishing, run `npm run test:github-release-audit:required -- --tag v0.2.0` plus `npm run test:github-release-audit:read-text:required -- --tag v0.2.0` for public small text metadata | Current public v0.1.0/v0.1.1/v0.1.2 asset metadata passed; v0.2.0 not created |
| Secret hygiene | `npm run secret:scan` before commit, `npm run secret:scan:history` before release | Passed on current worktree/history; rerun immediately before release |
| Release doctor | `npm run workos:release-doctor -- --refresh --required` refreshes local lightweight audits and summarizes all domains as ready | Open |

## Release Notes Requirements

The final GitHub Release body must include:

- Supported platforms and the exact artifacts uploaded.
- macOS first-open instructions if the build is still unsigned.
- Conditional Claude/Gemini statements: Claude needs a real login/API key; Gemini CLI installed is not enough without auth.
- Work OS Phase 1 truth boundary: Genesis is plan-layer only, not external child-Agent execution or auto publish.
- P2 release-scope evidence summary with links or paths to the final reports used for the release decision.
- Explicit boundary: P2-001 Windows GUI evidence is delegated to the Windows agent, P2-004 China external evidence requires user configuration, and N1 30-minute migration is not claimed in v0.2.0.
- A statement that real keys, webhooks, certs, `.env`, signing material, `test-results`, `out`, `dist`, `node_modules`, and local evidence packs are not included in the repo or release assets.
- A list of exact uploaded asset names. Allowed public assets are installer/update files only: DMG, mac zip, Windows installer, AppImage, blockmap, and `latest*.yml`.
- A note that public `latest*.yml`/small text metadata passed the read-text release audit; if the network cannot read those assets, do not claim their contents were scanned.
- A passing `npm run test:release-notes-audit:final` report for the exact body used on GitHub.

## Stop Conditions

Stop the release immediately if any of these is true:

- Any real secret, webhook URL, private key, certificate, signing material, or filled `.env` appears in `git status`, staged diff, or release assets.
- `npm run secret:scan:history` fails on a high-confidence real credential.
- `npm run test:github-release-audit:required` or `npm run test:github-release-audit:read-text:required -- --tag v0.2.0` reports an unexpected, suspicious, forbidden, unreadable, or secret-bearing public Release asset. Delete the asset and rotate/revoke the credential if it contained a real secret.
- Release-scope P2 evidence for P2-002/P2-003/P2-005 is missing or stale.
- Release notes claim P2-001 Windows GUI, P2-004 China external evidence, or N1 30-minute migration as proved before those separate audits pass.
- Packaging produces assets for a platform that was not actually tested but the notes imply support.
- Release notes claim Genesis can execute, merge, push, or publish through external child Agents before that is proved by implementation and tests.
