# CaoGen Work OS Phase 2 Parallel Plan

> Updated: 2026-07-08 Asia/Shanghai. This is the execution plan after Work OS Phase 1 A1-A9 landed on `main`.
>
> Status boundary: Phase 1 is locally proved. For the next owner-chosen release, P2-001 Windows GUI evidence is delegated to a separate Windows agent, P2-004 China external evidence is user-configured, and N1 human migration proof is not a blocking gate unless release notes claim it.

## Current Evidence

| Gate | Latest evidence | Result | Meaning |
|---|---|---|---|
| `origin/main` | `ce2e2ee test: add release notes audit gate` | pushed | Phase 1 stabilization, Phase 2 planning, release-note audit, and public release audit gates are on GitHub |
| GitHub Release | `v0.1.3` public tag/release | current stable | Do not publish a new release until gates below pass and the owner chooses the version |
| `npm run test:deep` | `test-results/caogen-deep/2026-07-07T18-03-37-379Z/deep-test-report.md` | pass, 65 checks | Local deep gate is green |
| `npm run test:p2` | local P2 smoke after validators fix | pass | Skill/model/China-local/IDE-bridge/OpenAI P2 local smoke is green |
| P2 release scope | `test:p2`, IDE build/host, JetBrains interaction evidence | partial | P2-002/P2-003/P2-005 are blocking; P2-001/P2-004 are tracked as non-blocking boundaries |
| `npm run test:jetbrains-recorder-e2e:required` | `test-results/jetbrains-recorder-e2e/2026-07-08T01-14-42-453Z` | pass | JetBrains runIde sandbox recorded connect/chat/selection/diff/apply/native undo/events/open desktop |

## Phase 1 Acceptance

Phase 1 can be presented as complete with these limits:

| Area | Accepted claim | Forbidden claim |
|---|---|---|
| Work OS modules | A1 Drive, A2 Quickbar, A3 Desktop Control, A4 Code Forge, A5 Skill Fabric, A6 Memory Loop, A7 Control Center, A8 Personal OS, A9 Genesis plan layer are merged to `main` | Do not claim Genesis executes real external child Agents or auto-publishes |
| Local verification | `test:deep` passes end-to-end local/mocked gates; P2-005 IDE evidence now covers VS Code Extension Host and JetBrains runIde recorder | Do not claim real Windows GUI, real China network, manual installed-IDE user workflow, or real N1 user migration is proved |
| Releases | `v0.1.3` remains latest public release | Do not ship or announce a new release until required gates and packaging pass |
| Secrets | Current repository scans found no tracked real key/private-key patterns | If any real token was ever pushed or shared elsewhere, only platform rotation/revocation can make it safe |

## Phase 2 Goal

Turn CaoGen from "Phase 1 locally proved Work OS" into a daily-usable rolling release candidate by closing release-scope evidence, release packaging, public asset hygiene, and truthful notes.

The next release cannot overclaim external evidence. Windows GUI proof, China external proof, and N1 human migration proof are not blockers unless release notes claim them, but must be explicitly excluded from claims until their separate audits pass.

## Parallel Agent Allocation

Track B0 plus the delegated/user-configured evidence lanes below. Keep each task on its own branch and do not commit generated `test-results`, `out`, `dist`, `node_modules`, keys, certificates, or `.env` files.

| Agent | Branch | Objective | Main commands | Done evidence |
|---|---|---|---|---|
| B0 Release Gate | `codex/workos-b0-release-gate` | Keep README/STATUS/release notes truthful; prepare the rolling release checklist without publishing; audit public GitHub Release assets | `npm run test:deep`, `npm run test:p2`, `npm run test:p2-ide-build-and-vscode:required`, `npm run test:jetbrains-ide-interaction:required`, `npm run test:release-packaging-audit:required`, `npm run test:release-notes-audit:required`, `npm run test:github-release-audit:required`, `npm run test:github-release-audit:read-text`, `npm run secret:scan:history` | Draft release checklist and GitHub Release audit say exactly which gates are open/closed |
| B1 Windows GUI Required | `codex/workos-b1-gui-required` | Produce strict Windows/VS Code GUI evidence for P2-001 after B0 is submitted | `npm run test:gui-input-preflight:required`, `npm run test:gui-vscode-e2e:required`, `npm run test:gui-cross-app-e2e:required`, `npm run test:gui-desktop-e2e:required` | Non-blocking for B0; when it passes, release notes may upgrade Windows GUI evidence |
| B2 IDE Build + VS Code Host | `codex/workos-b2-ide-build` | Completed: VS Code extension compile/host plus JetBrains plugin distribution | `npm run test:p2-ide-build-and-vscode:required`, `npm run test:ide-plugins:required`, `npm run test:vscode-extension-host:required` | `test-results/ide-plugins/latest.json` and `test-results/vscode-extension-host/latest.json` pass |
| B3 JetBrains Real IDE | `codex/workos-b3-jetbrains-real` | Completed: JetBrains runIde recorder/evidence JSON accepted by required gate | `npm run test:jetbrains-recorder-e2e:required`, `npm run test:jetbrains-ide-interaction:required` | `test-results/jetbrains-ide-interaction/latest.json` passes with recorder interaction evidence |
| B4 China External Evidence | `codex/workos-b4-china-external` | Optional/user-configured China real network and tool-call parity evidence | `npm run test:p2-external:pack`, `npm run test:p2-external:doctor`, `npm run test:p2-external:preflight -- --required`, `npm run test:china-real-network:required`, `npm run test:china-tool-call-parity:required` | Non-blocking unless release notes claim proof without user-provided config |

## Merge Order

| Order | Merge when | Reason |
|---|---|---|
| 1 | B2 if it only changes local build/test code and passes `test:p2-ide-build-and-vscode:required` | It unblocks B3 and P2-005 |
| 2 | B1 whenever the Windows agent finishes | It upgrades P2-001 evidence, but does not block B0 unless the release claims Windows GUI proof |
| 3 | B3 after real IDE evidence passes and no local IDE paths/secrets are committed | It closes JetBrains portion of P2-005 |
| 4 | B4 after external provider evidence passes and all secrets stay outside git | It closes optional/user-configured P2-004 proof |
| 5 | B0 last | It updates public docs/release notes to match the final proved state |

## Release Gate

Only create a new GitHub Release after all blocking items below are true, and after every non-blocking boundary is described truthfully in the release notes:

| Gate | Required evidence |
|---|---|
| Release doctor | `npm run workos:release-doctor -- --refresh --required` passes |
| Version | Owner chooses the release version; `package.json` and `package-lock.json` match that chosen version |
| Local | `npm run typecheck`, `npm run build`, `npm run test:deep` pass |
| P2 release scope | P2-002/P2-003/P2-005 evidence stays proved; P2-001 and P2-004 are listed as non-blocking boundaries |
| Packaging | `npm run dist:mac` produces expected DMG/zip assets and `npm run test:release-packaging-audit:required` passes; Windows/Linux only if actually verified |
| Release notes | `npm run test:release-notes-audit:final` passes against the exact GitHub Release body |
| Public Release assets | `npm run test:github-release-audit:required` passes before release edits; after publishing, run `npm run test:github-release-audit:required -- --tag vX.Y.Z` and `npm run test:github-release-audit:read-text:required -- --tag vX.Y.Z` for public small text metadata |
| Release notes | Notes include truthful unsupported/conditional items, macOS first-open instructions, and no overclaim about Genesis execution |
| N1 audit | Not required unless release notes claim N1 pass; never claim N1 without a private passed record |
| Secret hygiene | `npm run secret:scan:history` passes; current tree and staged diff scan clean; no `.env`, private key, cert, token, webhook, signing material, generated artifact, or local evidence pack staged |

## P2 Evidence Boundary

As of 2026-07-08, the latest audit says:

| P2 item | Status | Next action |
|---|---|---|
| P2-001 GUI automation and permission boundary | `delegated` | Separate Windows agent will compile/run strict GUI/VS Code/cross-app gates |
| P2-002 Skill learning/review/optimization/invocation | `proved` | Keep covered by `p2_default_smoke` |
| P2-003 Model routing/optimization/cross validation | `proved` | Keep covered by `p2_default_smoke` |
| P2-004 China ecosystem real network/parity | `user-configured` | User provides real external provider config and runs required China gates when needed |
| P2-005 IDE integrations | `proved` | Keep `test:p2-ide-build-and-vscode:required`, `test:jetbrains-recorder-e2e:required`, and `test:jetbrains-ide-interaction:required` green |

## Terminal Objective Path

| Stage | Outcome |
|---|---|
| Phase 1 | Native Work OS base merged and locally proved |
| Phase 2 | Release-scope evidence, packaging, public asset hygiene, and truthful notes closed; the next owner-chosen release can be published without overclaiming delegated/user-configured gates |
| Phase 3 | Genesis moves from plan layer to controlled execution layer: child session creation, isolated worktrees, verification queue, review, merge proposal |
| Phase 4 | CaoGen becomes a daily Agent Work OS replacement: Quickbar, Desktop Control, Code Forge, Skills/MCP, Memory Loop, Personal OS, Control Center, and Genesis execution all run from one task system |
