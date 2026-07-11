# CaoGen Rolling Release Gate Draft

> Updated: 2026-07-12 Asia/Shanghai. v0.1.4 is the selected release candidate; publish only after every blocking gate below is proved on the exact release commit.

## Current Public Release

| Item | State |
|---|---|
| Latest public GitHub Release | `v0.1.3` |
| Current package version | `0.1.4` |
| `origin/main` baseline | Verify the release commit and remote tag immediately before publishing; pre-release main was `6711a5e` |
| Release decision | v0.1.4 selected for macOS x64 only; arm64, Windows, and Linux are not part of this release |

## Required Before Publishing

| Gate | Required command or evidence | Current status |
|---|---|---|
| Version decision | Owner chooses the release version; `package.json` and `package-lock.json` must match it | Passed: 0.1.4 selected and both files match |
| Local type/build | `npm run typecheck` and `npm run build` pass | Candidate worktree passed earlier; rerun after the final code changes |
| Deep gate | `npm run test:deep` pass | Candidate baseline: 87 total / 84 required pass / 3 optional skip / 0 blocked / 0 fail; rerun on the release commit |
| P2 local smoke | `npm run test:p2` pass | Passed on current worktree; latest run refreshed P2-002/P2-003 evidence |
| P2 release scope | P2-002/P2-003/P2-005 proved by `npm run test:p2`, `npm run test:p2-ide-build-and-vscode:required`, and `npm run test:jetbrains-ide-interaction:required` | Ready in latest release doctor; full strict audit still reports delegated/user-configured gaps only |
| IDE build + VS Code host | `npm run test:p2-ide-build-and-vscode:required` pass with VS Code and JetBrains plugin build evidence | Passed on current worktree with VS Code extension host evidence |
| JetBrains real IDE | `npm run test:jetbrains-recorder-e2e:required` and `npm run test:jetbrains-ide-interaction:required` pass with recorder/runIde evidence | Passed on current worktree with JetBrains runIde recorder evidence |
| P2-001 Windows GUI | Separate Windows agent will run strict GUI evidence after this release-gate branch is submitted | Non-blocking because v0.1.4 has no Windows asset; do not claim Windows strict GUI proof until it lands |
| P2-004 China external | User-configured real network/provider evidence via `npm run test:china-real-network:required` and `npm run test:china-tool-call-parity:required` | Non-blocking; release notes must frame it as requiring user credentials/config |
| N1 migration | Human 30-minute migration audit | Not required unless the release claims N1 pass |
| Packaging | `npm run dist:mac:x64` and `npm run test:release-packaging-audit:required` produce the exact 5 x64 assets | Final x64 rebuild, DMG/ZIP integrity, launch, update metadata, and SHA256 remain |
| Product positioning | `npm run test:product-positioning:required` passes across README, welcome copy, release notes, and release gate | Rerun after the release-candidate wording update |
| Release notes | `npm run test:release-notes-audit:final` passes against `docs/RELEASE-NOTES-FINAL.md`, the exact GitHub Release body | Final body prepared; audit only counts when version, commit, and clean-worktree binding match |
| Public GitHub Release assets | `npm run test:github-release-audit:required` passes before release edits; after publishing, run `npm run test:github-release-audit:read-text:required -- --tag vX.Y.Z --expected-assets-from-dist` to require the exact local `dist` asset set and read public text metadata | Pre-publish audit passed; v0.1.4 exact-5 post-publish audit remains mandatory |
| Secret hygiene | `npm run secret:scan` before commit, `npm run secret:scan:history` before release | Passed earlier; rerun immediately before commit and release |
| Release doctor | Preflight doctor on clean commit, then final notes audit, then required doctor | Open until the release candidate is committed and all three reports bind to v0.1.4 and the same clean commit |

## Release Notes Requirements

The final GitHub Release body must include:

- Supported platforms and the exact artifacts uploaded.
- macOS first-open instructions if the build is still unsigned.
- Conditional provider/CLI statements: provider and CLI features need a real login, API key, provider auth, and configured local tools.
- Work OS Phase 1 truth boundary: Genesis is plan-layer only, not external child-Agent execution or auto publish.
- P2 release-scope evidence summary with links or paths to the final reports used for the release decision.
- Explicit boundary: P2-001 Windows GUI evidence is delegated to the Windows agent, P2-004 China external evidence requires user configuration, and N1 30-minute migration is not claimed unless a private passed record exists.
- Product boundary: CaoGen is described as a multi-vendor AI work desktop; public copy must not mention external product names, use comparison framing, or claim unsupported Office preview, GUI, cloud, signing, or external-network proof.
- A statement that real keys, webhooks, certs, `.env`, signing material, `test-results`, `out`, `dist`, `node_modules`, and local evidence packs are not included in the repo or release assets.
- A list of exact uploaded asset names. Allowed public assets are installer/update files only: DMG, mac zip, Windows installer, AppImage, blockmap, and `latest*.yml`.
- A note that public `latest*.yml`/small text metadata passed the read-text release audit; if the network cannot read those assets, do not claim their contents were scanned.
- A passing `npm run test:release-notes-audit:final` report for the exact body used on GitHub.

## Stop Conditions

Stop the release immediately if any of these is true:

- Any real secret, webhook URL, private key, certificate, signing material, or filled `.env` appears in `git status`, staged diff, or release assets.
- `npm run secret:scan:history` fails on a high-confidence real credential.
- `npm run test:github-release-audit:required` or `npm run test:github-release-audit:read-text:required -- --tag vX.Y.Z --expected-assets-from-dist` reports a missing, extra, suspicious, forbidden, unreadable, or secret-bearing public Release asset. Delete the asset and rotate/revoke the credential if it contained a real secret.
- Release-scope P2 evidence for P2-002/P2-003/P2-005 is missing or stale.
- Release notes claim P2-001 Windows GUI, P2-004 China external evidence, or N1 30-minute migration as proved before those separate audits pass.
- Packaging produces assets for a platform that was not actually tested but the notes imply support.
- Release notes claim Genesis can execute, merge, push, or publish through external child Agents before that is proved by implementation and tests.
- Public product or release copy mentions external product names, uses comparison framing, forces a fixed future version target, narrows CaoGen to developers only, or claims complete Office layout rendering / live relay availability before proof.
