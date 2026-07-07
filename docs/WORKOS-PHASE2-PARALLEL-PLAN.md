# CaoGen Work OS Phase 2 Parallel Plan

> Updated: 2026-07-08 Asia/Shanghai. This is the execution plan after Work OS Phase 1 A1-A9 landed on `main`.
>
> Status boundary: Phase 1 is locally proved. Phase 2 is not release-complete until the required external evidence gates pass.

## Current Evidence

| Gate | Latest evidence | Result | Meaning |
|---|---|---|---|
| `origin/main` | `e4c4b58 fix: stabilize Work OS deep gate` | pushed | Phase 1 stabilization is on GitHub |
| GitHub Release | `v0.1.2` public tag/release | current stable | Do not publish `v0.2.0` until gates below pass |
| `npm run test:deep` | `test-results/caogen-deep/2026-07-07T18-03-37-379Z/deep-test-report.md` | pass, 65 checks | Local deep gate is green |
| `npm run test:p2` | local P2 smoke after validators fix | pass | Skill/model/China-local/IDE-bridge/OpenAI P2 local smoke is green |
| `npm run test:p2-required` | `test-results/p2-required/latest.json` | failed | Required external gates still open |
| `npm run test:p2-audit -- --required` | `test-results/p2-completion-audit/2026-07-07T18-23-39-174Z/report.json` | failed | P2-002 and P2-003 proved; P2-001/P2-004/P2-005 remain |

## Phase 1 Acceptance

Phase 1 can be presented as complete with these limits:

| Area | Accepted claim | Forbidden claim |
|---|---|---|
| Work OS modules | A1 Drive, A2 Quickbar, A3 Desktop Control, A4 Code Forge, A5 Skill Fabric, A6 Memory Loop, A7 Control Center, A8 Personal OS, A9 Genesis plan layer are merged to `main` | Do not claim Genesis executes real external child Agents or auto-publishes |
| Local verification | `test:deep` passes end-to-end local/mocked gates | Do not claim real Windows GUI, real China network, real JetBrains IDE, or real N1 user migration is proved |
| Releases | `v0.1.2` remains latest public release | Do not ship or announce `v0.2.0` until required gates and packaging pass |
| Secrets | Current repository scans found no tracked real key/private-key patterns | If any real token was ever pushed or shared elsewhere, only platform rotation/revocation can make it safe |

## Phase 2 Goal

Turn CaoGen from "Phase 1 locally proved Work OS" into "v0.2.0 daily-usable release candidate" by closing required external evidence, release packaging, and N1 migration proof.

The next release cannot be based only on unit/smoke success. It needs real GUI, real IDE, real network/provider, and real user-flow evidence.

## Parallel Agent Allocation

Run 6 agents in parallel. Keep each task on its own branch and do not commit generated `test-results`, `out`, `dist`, `node_modules`, keys, certificates, or `.env` files.

| Agent | Branch | Objective | Main commands | Done evidence |
|---|---|---|---|---|
| B0 Release Gate | `codex/workos-b0-release-gate` | Keep README/STATUS/release notes truthful; prepare `v0.2.0` checklist without publishing | `npm run test:deep`, `npm run test:p2-audit -- --required`, secret scan | Draft release checklist says exactly which gates are open/closed |
| B1 Windows GUI Required | `codex/workos-b1-gui-required` | Produce strict Windows/VS Code GUI evidence for P2-001 | `npm run test:gui-input-preflight:required`, `npm run test:gui-vscode-e2e:required`, `npm run test:gui-cross-app-e2e:required`, `npm run test:gui-desktop-e2e:required` | `test-results/gui-vscode-e2e/latest.json` and `test-results/gui-cross-app-e2e/latest.json` pass |
| B2 IDE Build + VS Code Host | `codex/workos-b2-ide-build` | Fix required IDE build gate: VS Code extension compile/host plus JetBrains plugin distribution | `npm run test:p2-ide-build-and-vscode:required`, `npm run test:ide-plugins:required`, `npm run test:vscode-extension-host:required` | `test-results/ide-plugins/latest.json` and `test-results/vscode-extension-host/latest.json` pass |
| B3 JetBrains Real IDE | `codex/workos-b3-jetbrains-real` | Prove real JetBrains IDE interaction with recorder/evidence JSON | `npm run test:jetbrains-recorder-e2e`, `npm run test:jetbrains-ide-interaction:required` | `test-results/jetbrains-ide-interaction/latest.json` passes with real IDE executable and real interaction evidence |
| B4 China External Evidence | `codex/workos-b4-china-external` | Prove China real network and tool-call parity using real configured providers | `npm run test:p2-external:pack`, `npm run test:p2-external:doctor`, `npm run test:p2-external:preflight -- --required`, `npm run test:china-real-network:required`, `npm run test:china-tool-call-parity:required` | P2-004 moves from `missing_external` to proved |
| B5 N1 Migration Drill | `codex/workos-b5-n1-drill` | Run the real 30-minute migration drill and record proof | Follow `docs/N1-MIGRATION-DRILL.md`, then `npm run test:deep` | Dated drill record with user, stopwatch, screen recording path, pass/fail notes |

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
| Version | `package.json` bumped from `0.1.2` to the chosen release version |
| Local | `npm run typecheck`, `npm run build`, `npm run test:deep` pass |
| P2 required | `npm run test:p2-required` passes |
| P2 audit | `npm run test:p2-audit -- --required` passes |
| Packaging | `npm run dist:mac` produces expected DMG/zip assets; Windows/Linux only if actually verified |
| Release notes | Notes include truthful unsupported/conditional items, macOS first-open instructions, and no overclaim about Genesis execution |
| Secret hygiene | Current tree and staged diff scan clean; no `.env`, private key, cert, token, webhook, or signing material staged |

## Open Required Evidence

As of 2026-07-08, the latest audit says:

| P2 item | Status | Next action |
|---|---|---|
| P2-001 GUI automation and permission boundary | `missing_evidence` | Run Windows strict GUI/VS Code/cross-app gates and keep `gui_permission_required` green |
| P2-002 Skill learning/review/optimization/invocation | `proved` | Keep covered by `p2_default_smoke` |
| P2-003 Model routing/optimization/cross validation | `proved` | Keep covered by `p2_default_smoke` |
| P2-004 China ecosystem real network/parity | `missing_external` | Provide real external provider config and run required China gates |
| P2-005 IDE integrations | `missing_evidence` | Fix IDE plugin/VS Code host build; collect real JetBrains interaction evidence |

## Terminal Objective Path

| Stage | Outcome |
|---|---|
| Phase 1 | Native Work OS base merged and locally proved |
| Phase 2 | Required external evidence closed; `v0.2.0` can be truthfully released |
| Phase 3 | Genesis moves from plan layer to controlled execution layer: child session creation, isolated worktrees, verification queue, review, merge proposal |
| Phase 4 | CaoGen becomes a daily Agent Work OS replacement: Quickbar, Desktop Control, Code Forge, Skills/MCP, Memory Loop, Personal OS, Control Center, and Genesis execution all run from one task system |
