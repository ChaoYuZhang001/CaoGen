# CaoGen Coding Standards

> Status: active engineering standard.
> Scope: TypeScript, Electron main/preload, React renderer, smoke/e2e scripts, release-facing code.

本标准的目标不是统一审美,而是让 CaoGen 的能力可验证、边界清楚、长期可维护。

## Core Rules

1. One change owns one purpose.
   - A PR or slice should fix one bug, add one capability, split one boundary, or optimize one measurable hotspot.
   - Do not mix feature work, broad formatting, unrelated refactors, and release copy in the same change.

2. Change by responsibility, not by file count.
   - Do not edit every touched-looking file.
   - Only modify files on the actual behavior chain.
   - If a layer is unaffected, leave it untouched.

3. Verify the claim before calling work complete.
   - "Builds locally" is not enough for UI, IPC, model, worktree, release, or security changes.
   - Every user-visible capability must have a matching smoke, e2e, audit, screenshot, pixel check, or report artifact.

4. Do not overstate capability.
   - If a feature needs a real key, login, Windows host, Apple Silicon host, signed build, or external account, state that condition.
   - Skipped external checks are not passes.

## Behavior Chain

For new or changed app capabilities, check the narrow chain below:

```text
main logic
-> IPC handler
-> preload API
-> shared type
-> renderer store
-> UI component
-> smoke/e2e/audit evidence
```

Only touch the layers that actually change.

Examples:

- Main-only parser fix: update module + unit/smoke. Do not touch UI.
- New renderer command backed by main: update main handler, preload API, shared type, store action, UI, and targeted smoke.
- 3D-only visual state: update Office model/component and 3D smoke. Do not edit provider/auth/session internals unless the state source changes.

## Hotspot File Policy

These files are current architectural hotspots and must not absorb unrelated logic:

```text
src/renderer/src/store.ts
src/main/sessionManager.ts
src/main/ipc.ts
src/shared/types.ts
src/preload/index.ts
```

Line-count guidance:

```text
> 800 lines   explain why the new logic belongs there
> 1200 lines  prefer extracting a module/slice for new behavior
> 2000 lines  treat as structural debt; do not add broad new responsibilities
```

Preferred extraction targets:

- Renderer store: split into session, workbench, browser, plugin, routine, provider/project slices while preserving the public `useStore` API during migration.
- IPC: split registration by domain, such as session, git, worktree, browser, terminal, plugin, memory, project.
- Session manager: keep a facade but move orchestration, DAG runtime, snapshots, budget, and notifications behind focused helpers.
- Shared types: keep only cross-process contracts; move domain-local implementation types closer to their modules.

## TypeScript Rules

- Do not introduce `any` unless it is at a third-party or dynamic JSON boundary.
- Wrap dynamic input in a narrow validator before passing it deeper into app logic.
- Prefer discriminated unions for event and result states.
- Keep IPC input and output types explicit.
- Renderer code must not trust values just because they came through `window.agentDesk`.
- Avoid stringly typed states when a union type already exists.

Allowed `any` cases:

- Electron or third-party APIs that do not expose a useful type.
- JSON from external tools before validation.
- Temporary compatibility shims with a short comment explaining the boundary.

## IPC And Preload Rules

- Every new `ipcMain.handle` must have a matching preload API method or be explicitly main-only.
- Every renderer-callable API must have a shared type contract.
- IPC handlers must validate session IDs, file paths, and user-controlled values before performing side effects.
- File operations must stay inside their intended project, attachment, plugin, or userData root.
- High-risk actions such as commit, push, merge, PR creation, GUI automation, command execution, and file write must preserve permission/audit behavior.

## Renderer Rules

- Subscribe to the smallest store selector needed by a component.
- Do not push domain logic into large UI components when a pure model function can own it.
- UI text must come through the i18n dictionary when user-facing.
- Buttons and controls need stable labels or data attributes when smoke tests depend on them.
- Avoid adding hidden defaults that change user intent, especially engine, provider, permission, cwd, worktree isolation, and model selection.

## 3D Office Rules

- 3D changes need evidence beyond typecheck.
- Required validation for substantial Office changes:

```text
npm run build
npm run test:orchestration
```

When relevant, also run:

```text
npm run test:office-status-recheck
```

3D smoke should verify:

- canvas is nonblank
- important objects are visible
- click targets select/open the intended session
- error, awaiting-permission, idle, running, and completed states are machine-readable
- screenshot or pixel checks do not rely only on human judgment

Performance rules:

- Avoid adding a new permanent `useFrame` loop unless the animation is stateful and necessary.
- Prefer instancing for repeated geometry.
- Add quality gates before expensive visual effects become default.
- Keep `OfficeView` lazy-loaded.

## Testing Rules

Use the smallest reliable gate first, then broaden before release.

Run the standards audit when changing project structure, IPC/preload contracts, shared types, renderer store boundaries, or this document:

```bash
npm run test:coding-standards
```

The default audit reports existing structural debt as warnings. Use strict mode only when intentionally hardening a branch:

```bash
npm run test:coding-standards -- --strict
```

Common mapping:

```text
Coding standard / structure     -> npm run test:coding-standards
Type/shared/module change        -> npm run typecheck
Build/bundle/Electron change     -> npm run build
3D Office/orchestration change   -> npm run test:orchestration
IPC contract change              -> Electron main IPC smoke or targeted e2e
Git/worktree change              -> git/worktree smoke
Provider/model routing change    -> model/router/provider smoke
Release-facing change            -> release notes, packaging, GitHub asset, secret audits
Security-sensitive change        -> npm run secret:scan
```

For failure-state tests:

- Success, product error, provider failure, permission wait, and user interruption are different states.
- Product errors should not be hidden by failover.
- Provider failures may trigger failover, but tests must assert that behavior explicitly.

## Release And Evidence Rules

- Public docs must match `STATUS.md`, release gate docs, and current test artifacts.
- Release notes must not claim unverified real API, Windows GUI, China network, signing, notarization, or arm64-device proof.
- Do not commit credentials, generated local evidence packs, signing material, private logs, or oversized artifacts.
- Keep `test-results` useful: latest passing and failing evidence matters more than unlimited history.

## Commit Standard

Commit messages should say what changed and why:

```text
fix: isolate office fault-beacon error fixture
refactor: split renderer workbench store actions
test: cover worktree conflict receipt refresh
docs: add coding standards
```

Commit or PR descriptions should include:

```text
What changed
Why this boundary was chosen
How it was verified
Known skipped external checks
```

## Completion Checklist

Before calling a change done:

- The changed behavior has a targeted verification command.
- The verification passed, or the failure is reported with exact command and blocker.
- Unrelated dirty files were not reverted or folded into the claim.
- User-facing claims state prerequisites and skipped external checks.
- New logic did not deepen known hotspot files without justification.
