# CaoGen Work OS Phase 2 Parallel Plan

> Updated: 2026-07-08 Asia/Shanghai. This is the execution plan after Work OS Phase 1 A1-A9 landed on `main`.
>
> Status boundary: Phase 1 is locally proved. Phase 2 is not release-complete until the required external evidence gates pass.

## Current Evidence

| Gate | Latest evidence | Result | Meaning |
|---|---|---|---|
| `origin/main` | `c5897f0 docs: plan Work OS phase 2 gates` | pushed | Phase 1 stabilization and Phase 2 planning are on GitHub |
| GitHub Release | `v0.1.2` public tag/release | current stable | Do not publish `v0.2.0` until gates below pass |
| `npm run test:deep` | `test-results/caogen-deep/2026-07-07T18-03-37-379Z/deep-test-report.md` | pass, 65 checks | Local deep gate is green |
| `npm run test:p2` | local P2 smoke after validators fix | pass | Skill/model/China-local/IDE-bridge/OpenAI P2 local smoke is green |
| `npm run test:p2-required` | `test-results/p2-required/latest.json` | failed | P2-005 now passes; P2-001 GUI and P2-004 China external gates still open |
| `npm run test:p2-audit -- --required` | `test-results/p2-completion-audit/2026-07-08T01-19-46-409Z/report.json` | failed | P2-002/P2-003/P2-005 proved; P2-001/P2-004 remain |
| `npm run test:jetbrains-recorder-e2e:required` | `test-results/jetbrains-recorder-e2e/2026-07-08T01-14-42-453Z` | pass | JetBrains runIde sandbox recorded connect/chat/selection/diff/apply/native undo/events/open desktop |

## Phase 1 Acceptance

Phase 1 can be presented as complete with these limits:

| Area | Accepted claim | Forbidden claim |
|---|---|---|
| Work OS modules | A1 Drive, A2 Quickbar, A3 Desktop Control, A4 Code Forge, A5 Skill Fabric, A6 Memory Loop, A7 Control Center, A8 Personal OS, A9 Genesis plan layer are merged to `main` | Do not claim Genesis executes real external child Agents or auto-publishes |
| Local verification | `test:deep` passes end-to-end local/mocked gates; P2-005 IDE evidence now covers VS Code Extension Host and JetBrains runIde recorder | Do not claim real Windows GUI, real China network, manual installed-IDE user workflow, or real N1 user migration is proved |
| Releases | `v0.1.2` remains latest public release | Do not ship or announce `v0.2.0` until required gates and packaging pass |
| Secrets | Current repository scans found no tracked real key/private-key patterns | If any real token was ever pushed or shared elsewhere, only platform rotation/revocation can make it safe |

## Phase 2 Goal

Turn CaoGen from "Phase 1 locally proved Work OS" into "v0.2.0 daily-usable release candidate" by closing required external evidence, release packaging, and N1 migration proof.

The next release cannot be based only on unit/smoke success. It needs real GUI, real IDE, real network/provider, and real user-flow evidence.

## Parallel Agent Allocation

Run 6 agents in parallel. Keep each task on its own branch and do not commit generated `test-results`, `out`, `dist`, `node_modules`, keys, certificates, or `.env` files.

| Agent | Branch | Objective | Main commands | Done evidence |
|---|---|---|---|---|
| B0 Release Gate | `codex/workos-b0-release-gate` | Keep README/STATUS/release notes truthful; prepare `v0.2.0` checklist without publishing; audit public GitHub Release assets | `npm run test:deep`, `npm run test:p2-audit -- --required`, `npm run test:release-packaging-audit:required`, `npm run test:github-release-audit:required`, `npm run secret:scan:history` | Draft release checklist and GitHub Release audit say exactly which gates are open/closed |
| B1 Windows GUI Required | `codex/workos-b1-gui-required` | Produce strict Windows/VS Code GUI evidence for P2-001 | `npm run test:gui-input-preflight:required`, `npm run test:gui-vscode-e2e:required`, `npm run test:gui-cross-app-e2e:required`, `npm run test:gui-desktop-e2e:required` | `test-results/gui-vscode-e2e/latest.json` and `test-results/gui-cross-app-e2e/latest.json` pass |
| B2 IDE Build + VS Code Host | `codex/workos-b2-ide-build` | Completed: VS Code extension compile/host plus JetBrains plugin distribution | `npm run test:p2-ide-build-and-vscode:required`, `npm run test:ide-plugins:required`, `npm run test:vscode-extension-host:required` | `test-results/ide-plugins/latest.json` and `test-results/vscode-extension-host/latest.json` pass |
| B3 JetBrains Real IDE | `codex/workos-b3-jetbrains-real` | Completed: JetBrains runIde recorder/evidence JSON accepted by required gate | `npm run test:jetbrains-recorder-e2e:required`, `npm run test:jetbrains-ide-interaction:required` | `test-results/jetbrains-ide-interaction/latest.json` passes with recorder interaction evidence |
| B4 China External Evidence | `codex/workos-b4-china-external` | Prove China real network and tool-call parity using real configured providers | `npm run test:p2-external:pack`, `npm run test:p2-external:doctor`, `npm run test:p2-external:preflight -- --required`, `npm run test:china-real-network:required`, `npm run test:china-tool-call-parity:required` | P2-004 moves from `missing_external` to proved |
| B5 N1 Migration Drill | `codex/workos-b5-n1-drill` | Run the real 30-minute migration drill and record proof | Follow `docs/N1-MIGRATION-DRILL.md`, then `npm run test:n1-migration-audit:required` and `npm run test:deep` | N1 audit passes for a dated human drill record with stopwatch, screen recording path, commit, no docs/help, and asset-zero-loss notes |

## Merge Order

| Order | Merge when | Reason |
|---|---|---|
| 1 | B2 if it only changes local build/test code and passes `test:p2-ide-build-and-vscode:required` | It unblocks B3 and P2-005 |
| 2 | B1 after Windows GUI evidence is present and no credentials/artifacts are staged | It closes P2-001 evidence |
| 3 | B3 after real IDE evidence passes and no local IDE paths/secrets are committed | It closes JetBrains portion of P2-005 |
| 4 | B4 after external provider evidence passes and all secrets stay outside git | It closes P2-004 |
| 5 | B5 after the human drill record is reviewed | It closes N1 v0.2.0 release requirement |
| 6 | B0 last | It updates public docs/release notes to match the final proved state |

## Release Gate

Only create a new GitHub Release after all items below are true:

| Gate | Required evidence |
|---|---|
| Release doctor | `npm run workos:release-doctor -- --required` passes |
| Version | `package.json` and `package-lock.json` bumped from `0.1.2` to the chosen release version |
| Local | `npm run typecheck`, `npm run build`, `npm run test:deep` pass |
| P2 required | `npm run test:p2-required` passes |
| P2 audit | `npm run test:p2-audit -- --required` passes |
| Packaging | `npm run dist:mac` produces expected DMG/zip assets and `npm run test:release-packaging-audit:required` passes; Windows/Linux only if actually verified |
| Public Release assets | `npm run test:github-release-audit:required` passes before release edits; after publishing, run `npm run test:github-release-audit:required -- --tag vX.Y.Z` |
| Release notes | Notes include truthful unsupported/conditional items, macOS first-open instructions, and no overclaim about Genesis execution |
| N1 audit | `npm run test:n1-migration-audit:required` passes on the private human drill record |
| Secret hygiene | `npm run secret:scan:history` passes; current tree and staged diff scan clean; no `.env`, private key, cert, token, webhook, signing material, generated artifact, or local evidence pack staged |

## Open Required Evidence

As of 2026-07-08, the latest audit says:

| P2 item | Status | Next action |
|---|---|---|
| P2-001 GUI automation and permission boundary | `missing_evidence` | Run Windows strict GUI/VS Code/cross-app gates and keep `gui_permission_required` green |
| P2-002 Skill learning/review/optimization/invocation | `proved` | Keep covered by `p2_default_smoke` |
| P2-003 Model routing/optimization/cross validation | `proved` | Keep covered by `p2_default_smoke` |
| P2-004 China ecosystem real network/parity | `missing_external` | Provide real external provider config and run required China gates |
| P2-005 IDE integrations | `proved` | Keep `test:p2-ide-build-and-vscode:required`, `test:jetbrains-recorder-e2e:required`, and `test:jetbrains-ide-interaction:required` green |

## Terminal Objective Path

| Stage | Outcome |
|---|---|
| Phase 1 | Native Work OS base merged and locally proved |
| Phase 2 | Required external evidence closed; `v0.2.0` can be truthfully released |
| Phase 3 | Genesis moves from plan layer to controlled execution layer: child session creation, isolated worktrees, verification queue, review, merge proposal |
| Phase 4 | CaoGen becomes a daily Agent Work OS replacement: Quickbar, Desktop Control, Code Forge, Skills/MCP, Memory Loop, Personal OS, Control Center, and Genesis execution all run from one task system |
