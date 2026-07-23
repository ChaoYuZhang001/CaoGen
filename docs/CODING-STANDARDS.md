# CaoGen Coding Standards

> Status: active engineering standard.
> Scope: hand-written product, plugin, test, automation, and release-facing code, with deeper TypeScript/JavaScript analysis.

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

## Size And Complexity Rules

Size limits are guardrails for responsibility, not a substitute for design review. The audit counts physical lines so comments and blank lines cannot be used to hide file growth.

Tracked, hand-written code uses these profiles:

| Code profile | Target | Hard limit | Scope |
|---|---:|---:|---|
| Product and plugin source | 500 lines | 800 lines | `src`, plugin source, and tracked TS/JS/Kotlin/Python configuration code |
| Test and automation code | 800 lines | 1200 lines | `scripts`, test files, smoke/E2E runners, and plugin test/build scripts |

Generated code, vendored code, lockfiles, and machine-produced evidence are excluded. An exclusion must be explicit in the audit configuration; a filename containing `generated` is not enough by itself.

File rules:

- New files must stay at or below the hard limit.
- Files above the target require a clear single responsibility and should not collect unrelated helpers.
- Existing files above the hard limit are baseline debt. They may be reduced, but must not grow in physical lines or increase their oversized-function/complex-function debt.
- Moving code between files without improving ownership, dependencies, or testability does not count as remediation.
- Splitting a cohesive table, schema, fixture, or generated artifact only to satisfy a line counter is prohibited.

Function and method rules:

| Metric | Target | Review threshold | Hard limit |
|---|---:|---:|---:|
| Function/method length | 50 lines | over 80 lines | 120 lines |
| Cyclomatic complexity | 10 | 11-15 | 15 |
| Nesting depth | 3 | 4 | 4 |
| Positional parameters | 4 | 5 | 5 |

- A function above a review threshold must be simplified, split, or justified by a cohesive parser, protocol adapter, state transition, data table, or test fixture.
- New or changed functions must not cross a hard limit without a documented, time-bounded exception.
- Prefer a parameter object when more than four values describe one operation.
- Prefer early returns and explicit state transitions over deeply nested conditionals.
- Complexity limits apply to behavior, not declarative object literals or static data tables.

The automated audit enforces file length for all supported code files and performs function-length and cyclomatic-complexity analysis for TypeScript/JavaScript. Nesting depth, parameter count, and Kotlin/Python function analysis remain review requirements until their language-aware gates are added.

## Hotspot File Policy

These files are current architectural hotspots and must not absorb unrelated logic:

```text
src/renderer/src/store.ts
src/main/sessionManager.ts
src/main/ipc.ts
src/shared/types.ts
src/preload/index.ts
```

These files predate the repository-wide limits and are managed by the checked-in baseline:

- They must not grow while above the product-source hard limit.
- New behavior should be extracted behind a focused API unless it genuinely changes the facade or cross-domain contract.
- Reducing one metric does not permit worsening another, such as replacing file growth with a new 200-line function.
- Baseline debt is not an exemption from review. It records the maximum existing debt so the required gate can reject regressions.

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

Compiler suppressions:

- `@ts-ignore` is prohibited in production source.
- `@ts-expect-error` requires a specific reason and must describe when it can be removed.
- Double assertions such as `value as unknown as Type` are allowed only at verified third-party or serialization boundaries.
- A suppression or unsafe boundary that exists in the baseline must not be copied into new code.

## Comment Rules

Comments explain intent, constraints, and evidence that the code cannot express directly. CaoGen does not use a comment-percentage target.

Comments are required for:

- security, permission, privacy, path-jail, and trust-boundary decisions
- crash recovery, idempotency, compensation, ordering, concurrency, and persistence invariants
- non-obvious protocol behavior or third-party workarounds
- calibrated performance budgets and platform-specific behavior
- exported cross-process contracts whose preconditions or failure states are not obvious from the type
- temporary compatibility code, including the source of the incompatibility and its removal condition

Comments must not:

- narrate obvious syntax or repeat the function name
- preserve commented-out code; Git owns history
- claim behavior that is not covered by the current implementation
- use vague markers such as `TODO: fix later`

Debt markers use this form:

```text
TODO(issue-or-owner): reason; remove when <verifiable condition>
FIXME(issue-or-owner): observed failure; remove when <verifiable condition>
```

`@ts-expect-error`, `eslint-disable`, and similar suppression comments require an inline reason. Prohibited or unreasoned directives fail the required standards gate and cannot be accepted into the baseline.

## Architecture And Design Pattern Rules

Patterns are selected to make ownership and state transitions explicit. A change is not better merely because it names a GoF pattern.

| Problem | Preferred CaoGen pattern |
|---|---|
| Provider, model protocol, operating system, or IDE integration | Adapter |
| Routing, budget, quality, failover, or permission choice | Strategy or explicit policy function |
| Session, task, effect, approval, or delivery lifecycle | State machine represented by discriminated unions |
| Commands and external side effects | Command/Effect plus durable receipt |
| Storage implementation behind domain behavior | Repository |
| Stable entry point over a decomposed subsystem | Facade |
| Runtime construction selected by configuration | Factory at the composition root |
| Cross-process calls | Narrow typed contract with validation on the receiving side |
| Complex renderer state | Domain slice/reducer plus focused selectors |
| Dynamic JSON, model output, IPC input, or imported config | Parser/validator boundary |

Introduce an abstraction only when at least one is true:

- two real implementations must satisfy the same contract
- an external or security-sensitive boundary needs isolation
- a state invariant or side-effect lifecycle needs one owner
- repeated behavior has the same semantics and failure contract
- decomposition removes a dependency cycle or a known hotspot responsibility

Prefer composition over inheritance. Keep interfaces close to the consumer that needs them. Do not create `Manager`, `Service`, `Utils`, or `Common` modules without a specific domain responsibility.

Prohibited anti-patterns:

- new god objects or domain-wide mutable singletons
- service locator access from arbitrary modules
- generic renderer-controlled IPC such as `invoke(channel, payload)`
- boolean-flag APIs that select unrelated workflows
- stringly typed lifecycle states when a union or state machine can represent them
- UI components that directly own persistence, credentials, permissions, or provider routing
- speculative factories, repositories, or interfaces with only one trivial use and no boundary value
- catch blocks that silently convert product errors into success or provider failover
- hidden defaults that override provider, model, cwd, permission, isolation, or delivery intent

## Exception Rules

An exception is not a baseline refresh. The baseline records legacy debt and locks improvements; it does not authorize new debt.

A hard-limit exception requires all of the following in the PR or commit description:

```text
Scope: exact file/function/rule
Reason: technical constraint that prevents compliance now
Owner: person or team responsible for removal
Expires: review date, never "permanent"
Remove when: verifiable condition that closes the exception
Evidence: tests or measurements showing the exception is contained
```

Schedule pressure, avoiding a refactor, or matching an already-large neighboring file are not valid reasons. Generated protocol surfaces, cohesive static schemas, platform adapters constrained by an external API, and emergency incident fixes may qualify when their boundary is explicit.

`--accept-current-debt` is reserved for the initial baseline bootstrap or a reviewed policy/schema migration. It is intentionally not exposed as a package script and must not be used in normal feature work.

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
npm run test:office-quality-policy
npm run test:office-performance
npm run test:office-performance:required
```

The performance report records both optimization targets and calibrated
regression budgets. Target misses stay visible as warnings; the required gate
blocks only when the current scene regresses beyond the recorded envelope.

- Persist only the requested Office quality mode. Auto's effective tier is runtime evidence, not user intent, and must not be written back to settings.
- Keep the Canvas and camera mounted while the Office view is active. Hidden or unfocused windows must stop the render loop; quality changes must not reset session, hit-target, or camera state.
- High, Balanced, and Low must map to measurable renderer differences such as DPR, realtime shadows, and contact-shadow passes. Do not claim savings from a post-processing stack that the live Office view does not mount.
- The performance matrix covers Auto at 1/6/12 agents plus fixed High/Balanced/Low at the largest scenario. Low must reduce renderer load while preserving session count, robot ownership, click targets, and camera presets.

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
- Keep renderer diagnostics opt-in and free of their own `useFrame` loop.

## Testing Rules

Use the smallest reliable gate first, then broaden before release.

Run the standards audit when changing project structure, IPC/preload contracts, shared types, renderer store boundaries, or this document:

```bash
npm run test:coding-standards
```

The audit has three modes:

```text
default    report current quality and baseline debt; warnings do not fail the command
required   block new hard-limit violations and any regression above the checked-in baseline
strict     treat every warning as a failure; use for zero-debt modules or intentional hardening
```

Required mode is the normal merge gate:

```bash
npm run test:coding-standards:required
```

Strict mode is intentionally stronger than the current whole-repository baseline:

```bash
npm run test:coding-standards -- --strict
```

The ratchet baseline lives at `scripts/coding-standards-baseline.json`. It stores the content hash and hard-limit function identities for every accepted debt file. Any accepted-debt file change, improvement, removal, or function-identity change requires an explicit baseline refresh. The normal baseline command refuses to widen file, function, complexity, IPC, or unsafe-type debt:

```bash
npm run test:coding-standards:baseline
git diff -- scripts/coding-standards-baseline.json
```

Review that diff before committing it. New debt must remain visible as a new file or function entry; never refresh the baseline merely to make a regression pass. Prohibited or unreasoned comment directives cannot be baselined.

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
New or changed exceptions and their removal conditions
```

## Completion Checklist

Before calling a change done:

- The changed behavior has a targeted verification command.
- The verification passed, or the failure is reported with exact command and blocker.
- `npm run test:coding-standards:required` passes for code changes.
- Unrelated dirty files were not reverted or folded into the claim.
- User-facing claims state prerequisites and skipped external checks.
- New logic did not deepen file, function, complexity, suppression, or hotspot debt.
- Required comments explain non-obvious invariants and temporary exceptions without narrating obvious code.
- Any introduced pattern owns a real boundary or invariant; no speculative abstraction was added.
