# CaoGen Optimization Plan

> Updated: 2026-07-10 Asia/Shanghai. This plan is the product optimization target from the current 0.1.3 line onward. It does not force a fixed future release number; the owner chooses version bumps when the release is ready.
>
> Evidence boundary: implementation notes and test counts below are historical snapshots from the dates in their linked artifacts, not current release claims. For current capability and release truth, use [`STATUS.md`](../STATUS.md) and the newest dated Deep report. As of 2026-07-20, the latest dirty-worktree Deep is `123 total / 120 required pass / 3 optional skip / 0 blocked / 0 fail` (`test-results/caogen-deep/2026-07-20T14-04-52-427Z/deep-test-report.md`); this remains separate from the 1.0 clean-release gate.

## Product Definition

CaoGen is a multi-vendor AI work desktop. It supports multi-model, multi-key, and multi-provider configuration; lets each project define its own AI working rules; and brings code execution, project understanding, task decomposition, automatic scheduling, workspace isolation, plugins, project memory, file preview, Office document viewing, and 3D office visualization into one desktop environment.

The public product language must not mention external product names or comparison framing. Feature descriptions should describe CaoGen's own capabilities.

## Core Objectives

| Objective | Target |
|---|---|
| Multi-vendor capability | Users can connect their own models, API keys, gateways, relay services, and local compatible services. |
| Project-level working rules | Each project can define prompts, background, tech stack, commands, boundaries, scheduling policy, and memory independently. |
| Complete work desktop | Users can inspect files, run tasks, review outputs, manage delivery, and observe work in 3D instead of using CaoGen as only a chat box. |
| Desktop layout | The default app shape is a CaoGen-owned three-zone workspace: navigation, primary conversation, and a tool workspace. |

## Phase 0: Agent Runtime Hardening

Goal: every unfinished task has an explicit, persistent lifecycle and one authoritative recovery source.

Tasks:

- Persist TaskRun states independently from transient session status.
- Preserve completed, failed, and cancelled run history after recovery snapshots are removed.
- Record approval waiting and recovery transitions without restoring stale permission resolvers.
- Make SQLite task snapshots authoritative over the legacy active-session registry.
- Route interruption through SessionManager so cancellation cannot bypass runtime state.
- Persist TaskStep and ToolExecution records, then enforce idempotency decisions in the permission/execution policy layer.

Current implementation note:

- `TaskRun` now uses the explicit states `queued`, `planning`, `executing`, `waiting_approval`, `verifying`, `recovering`, `completed`, `failed`, and `cancelled`. State transitions are validated in a focused module instead of being inferred only from chat text or session status. SQLite schema v4 stores active runs atomically with recovery snapshots, adds an explicit recovery cursor, rejects stale lower-cursor writes, and retains terminal runs in a separate `task_runs` table when the snapshot is deleted. Existing v2/v3 SQLite stores are durably upgraded on first read, legacy JSON is imported only when SQLite is empty, and stores from a newer unsupported schema are rejected instead of being downgraded. Startup reads snapshots before the legacy active-session registry, so richer transcript and DAG runtime recovery cannot be shadowed by an older session record. Recovery clears stale approval request ids and increments attempt/recovery counters. Session interruption now passes through SessionManager and persists cancellation, while shutdown keeps snapshot protection active for provider events that arrive after disposal starts.
- Migration boundary: the schema-v4 details above are the historical Phase 0 snapshot. The current `task-snapshots.db` is v8: it retains the v6 TaskRun Effect evidence append-only hash-chain foundation, the Goal/WorkItem/Run/Artifact/Acceptance/Evidence Link workflow event chain, and adds canonical recovery sessions plus a persistent `workflow_store_identity`. Task Snapshot/TaskRun recovery reads now support database-path-scoped `legacy`, `compare`, and `canonical` modes. Compare mode fails closed on source drift; canonical mode reads Workflow Runs and recovery sessions; an unset mode still defaults to legacy. Runtime mode changes are serialized through the database mutation queue, force a fresh readiness assessment, and exercise both recovery surfaces before the new mode is published. First-open readiness is shared per database path across modes. Committed migration journals bind store identity and durable high-water marks so deletion, truncation, version regression, or replacement with a same-version empty store fails closed. This is a verified recovery read-source cutover mechanism, not a complete canonical workflow or conversation ledger: full Artifact/blob/sourceRef lifecycle, all domain entry points, unified retention/delete, and production compensation remain open.
- Each user request inside a run now creates an ordered `TaskStep`; queued messages remain separate steps, and a successful intermediate turn no longer deletes the recovery snapshot while later steps remain. Parallel permission requests remain in `waiting_approval` until the final request for that step is resolved. Tool events create `ToolExecution` records linked to their step and retain permission state, input/output SHA-256 digests, terminal result, and a stable session-scoped idempotency key for side-effecting tools. Raw tool inputs and outputs are not copied into the TaskRun ledger. During recovery, stale approval-only tools are cancelled, while tools that may have started but lack a durable result become `unknown_outcome`; the replay prompt requires state inspection before repetition. Session scope preserves protection when a failed run is followed by a new run in the same conversation without creating cross-project or cross-session blocks, and hydrated execution history is bounded to the newest 100 records per session.
- Specialized SDK runtimes and generic API runtimes now consult the same in-memory TaskRun registry before permission-mode shortcuts. An identical operation that is still active is denied; an `unknown_outcome` always requires explicit user confirmation; and a previously successful high-risk operation such as Bash, Git mutation, PR creation, DAG dispatch, Genesis, GUI automation, or commit/PR delivery requires confirmation before repetition. These rules also override `bypassPermissions` but never override stricter deny, sandbox, or plan-mode decisions. Safe repeat candidates such as an identical file write remain recorded through `duplicateOfExecutionId` without being silently blocked. A confirmed retry carries the prior execution id through the approval event and, after success, marks the linked unknown record `superseded` in both in-memory and persisted run history. CaoGen still does not automatically inspect an external system and decide that an unknown operation succeeded, nor does it silently skip a user-confirmed retry.
- Every new engine event now carries a stable `streamId`, `eventId`, monotonic sequence, timestamp, and optional causation/correlation links. Conversation JSONL retains the identity for replay, while a separate append-only lifecycle receipt records only event kind and correlation ids for non-streaming events, never raw permission inputs or tool outputs. Binding a newly discovered SDK session no longer renumbers events that were already emitted. TaskStep and ToolExecution records retain the event ids for request, permission, tool signal, and result stages; duplicate or older cursors cannot advance TaskRun revision. Recovery merges the snapshot with any newer transcript/receipt tail before replay, so a durable successful `turn-result` removes a stale recovery entry instead of executing the completed request again. The crash smoke terminates one process immediately after a permission receipt and verifies that a second process resumes above the persisted cursor. This is still not a transactional exactly-once guarantee across an arbitrary external system: `tool-start` means the model proposed a call, not proof that the side effect began, and unknown external outcomes still require explicit inspection.

Acceptance:

- Application restart leaves unfinished runs recoverable from their latest snapshot.
- A completed run remains queryable after its recovery snapshot is removed.
- A stale approval cannot become implicitly authorized after recovery.
- Legacy snapshots without TaskRun data remain readable.
- DAG recovery does not repeat already completed child tasks.
- Multiple queued messages remain independent steps and only close the run after the final step completes.
- Resolving one of several pending approvals does not move the step or run out of `waiting_approval` early.
- Side-effecting tool records have stable idempotency keys without persisting raw tool payloads.
- A tool interrupted after possible execution is reported as `unknown_outcome`, not falsely classified as unexecuted.
- In-progress duplicate side effects are denied, while unknown or previously completed high-risk repeats require explicit confirmation even in bypass mode.
- A user-confirmed successful retry persists the duplicate/superseded link across run boundaries and restart history.
- Event ids remain stable in transcript and lifecycle receipts, and resume never reuses or renumbers an already emitted cursor.
- Replaying the same event id or an older cursor does not add a TaskStep, mutate ToolExecution, or increment TaskRun revision.
- A successful turn persisted after the latest snapshot is reconciled as terminal before recovery prompts can run.
- Lifecycle receipts preserve request/tool correlation without persisting raw tool inputs or outputs.
- A forced-process-exit smoke proves that the next process resumes above the durable cursor.
- State-machine, snapshot, DAG recovery, typecheck, build, integration, and coding-standard gates pass.

## Phase 1: Product Positioning

Goal: make all public copy consistent, free of external-product comparison framing, and broader than "developer only".

Tasks:

- Rewrite README first screen and feature categories.
- Update app welcome copy where it over-narrows the audience.
- Keep release notes and release gates version-neutral until the owner chooses a version.
- Remove fixed future-version language from scripts and docs.
- Do not claim unverified Office, GUI, signing, cloud, or external-network proof.

Acceptance:

- A new user can understand CaoGen in 3 seconds.
- Public copy contains no external product names or comparison framing.
- Public copy says CaoGen is an AI work desktop, with AI coding as a strong core but not the only audience.
- Release tooling follows the current package version by default and accepts an explicit target version only when provided.

Current implementation note:

- Public positioning now has a repeatable guard: `npm run test:product-positioning:required` scans README, the welcome-entry copy, release notes, release gate, and public brand surfaces for fixed future-version assumptions, external product names or comparison framing, developer-only positioning, unproved relay/Office overclaims, and old diamond placeholder logos. `npm run workos:release-doctor -- --refresh` includes this audit before summarizing release readiness.
- Release packaging now has a repeatable macOS candidate path on the current 0.1.3 line: `npm run dist:mac` runs a native-build preparation step that patches `tree-sitter` 0.21.x to C++20 for Electron 40 rebuilds, then produces x64/arm64 DMG and zip assets. `npm run test:release-packaging-audit:required` verifies the expected asset matrix and excludes local debug metadata from uploadable assets.

## Phase 2: Multi-Vendor Configuration

Goal: users can manage models, keys, providers, relay services, and local endpoints like a workbench.

Tasks:

- Multi Provider configuration.
- Multi API Key management.
- Custom Base URL.
- Built-in relay template for the CaoGen relay entry: `https://gpt.zhangrui.xyz/dashboard`; API Key is user-configured, and availability must remain "not live" until the service is actually online.
- Model list fetch.
- Connectivity check.
- Health, latency, failure, and availability display.
- Default model, fallback model, low-cost model, and strong-reasoning model configuration.

Current implementation note:

- Provider storage supports multiple encrypted API keys with an active-key selector and legacy single-key compatibility. The settings UI can add, rename, disable, and remove key metadata without exposing plaintext keys. Runtime requests now record key usage and sanitized key-failure metadata. On credential-bound failures (authentication, forbidden access, rate limits, or quota/credit exhaustion), CaoGen first rotates to an enabled, non-cooling key in the same Provider; only after the usable key pool is exhausted does normal cross-Provider failover run. OpenAI requests retry directly, while SDK Agent sessions rebuild the child process and resume the active conversation context. Key-switch events contain only Provider/key ids and user-owned labels, and are visible in chat and the 3D office. `npm run test:provider-key-failover` verifies failure classification, disabled/cooling key exclusion, turn-local loop prevention, and the cross-process visibility boundary (`test-results/provider-key-failover/latest.json`). The real Electron OpenAI mock now starts with an expired primary key, receives HTTP 401, switches to the backup key, completes the response, and verifies persisted active-key/failure metadata (`test-results/openai-mock-e2e/2026-07-10T07-27-01-023Z/openai-mock-e2e.json`). Provider rows also include an explicit connectivity probe that uses the saved active key, refreshes provider health, and syncs fetched model lists on success. Provider health persists under Electron `userData`, keeps bounded recent failure records, tracks latest and EMA latency, clears the active error after recovery, and sanitizes stored error text. This proves error-driven same-Provider key failover, not proactive quota probing, weighted key load balancing, or the availability of the CaoGen relay service.

Acceptance:

- A user can add a custom provider or relay and complete a real conversation.
- Unavailable models produce explicit errors.
- Default templates never pretend to be usable without credentials and a live endpoint.
- Failed providers can fall back according to policy.

## Phase 3: Project-Level Prompts And Rules

Goal: every project can have its own AI working style without polluting global settings.

Tasks:

- Project prompt.
- Project background and current stage.
- Tech stack and architecture notes.
- Common commands: dev, test, build, lint, smoke.
- Forbidden paths and risky operations.
- Default workspace isolation policy.
- Default model scheduling policy.
- Project memory and historical decisions.
- UI editing surface for project rules.
- Project identity injection when no `caogen.md` exists yet.
- Project model dispatch hints feed automatic routing decisions.

Current implementation note:

- The Project rules settings page can read and write project-scoped `caogen.md`, and includes structured fields for prompts, background, tech stack, common commands, test/build commands, forbidden paths, workspace isolation policy, model dispatch policy, project memory, historical decisions, and acceptance rules. The Electron page smoke verifies editing these structured fields from Settings writes the selected project's `caogen.md` and does not mutate global `settings.json`. Context and model-routing smokes now also verify that two different projects inject different rules and route the same request through different project-scoped model preferences without leaking dispatch hints between projects.

Acceptance:

- Different projects load different rules.
- Agents automatically read the active project's rules.
- New projects without rule files still expose project identity and missing-rule status to the Agent.
- Project model dispatch choices appear in routing reasons when applied.
- Users can edit project rules in the app.
- Project rules remain project-scoped and do not mutate global settings.

## Phase 4: File Preview And Office Documents

Goal: CaoGen becomes a complete work desktop, not only a code viewer.

Tasks:

- CaoGen-specific workspace control rail and tool drawer.
- Three-zone layout: left project/session navigation, center command conversation, right tool workspace.
- HTML preview.
- Markdown preview.
- JSON preview.
- CSV/table preview.
- PDF embedded preview plus best-effort text-layer extraction.
- Image preview.
- Word document text preview for `.docx`.
- Excel workbook sheet/table preview for `.xlsx`.
- PowerPoint slide text preview for `.pptx`.
- Sandboxed macOS system-document preview with thumbnail and structure fallback.
- Page, sheet, and slide navigation with current-unit Agent references.
- Preview content can be referenced by the Agent.
- Preview failures show clear reasons.

Acceptance:

- The app may reference common desktop information architecture, but must use CaoGen-owned visuals, names, ordering, shortcut labels, and interaction styling.
- Drawer entries open real CaoGen panels, not placeholder menus.
- Common work files open inside the app.
- Agent workflows can reference previewed files.
- Office text/structure preview must pass real sample checks before being claimed.
- System-document rendering is claimed only after real sample files render visually and pass checks.
- Pixel-identical original-application layout, editing, complex formulas, and animations remain out of scope until separately proved.
- Unsupported files fail with clear, actionable messages.

Current implementation note:

- OOXML Office preview extracts text/structure from `.docx`, `.xlsx`, and `.pptx`. Word explicit page breaks, Excel sheets, and PowerPoint slides are navigable structural units; the selected unit can be sent to the Agent, and annotations persist its position, quote, and selector. On macOS, an independent Quick Look IPC generates a bounded, cached system-document preview, recursively inlines HTML/CSS/JS/image attachments, blocks network access with CSP, and renders the result in a sandboxed iframe. Failure falls back first to a system first-page PNG and then to structure; stale responses and child processes are cleaned up. `npm run test:office-visual-preview` verifies a real DOCX system preview plus deterministic attachment/CID/network isolation (`test-results/office-visual-preview/latest.json`); the Electron page smoke verifies the iframe, sheet/slide navigation, current-unit Agent prompt, and located annotation (`test-results/caogen-deep/2026-07-10T12-48-21-376Z/page-operation-smoke.json`). Preview-to-Agent prompts continue to exclude visual data URLs. The built-in browser defaults to `https://caobao.chat/official`. Editing, complex formulas, animations, and pixel-identical original-application fidelity are not claimed.

## Phase 5: Automatic Scheduling

Goal: users should not need to manually decide which model or provider fits every task.

Status: implemented and verified for the current structured-policy scope.

Tasks:

- Task type detection.
- Default scheduling rules.
- User-custom scheduling rules.
- Cost-first, quality-first, and speed-first modes.
- Failure retry and fallback.
- Planning/coding/review model roles.
- Routing log and explanation.
- Budget control.

Current implementation note:

- Automatic routing supports task inference, Drive-level default strategy, role preferences, project dispatch hints, ordered user-owned rules, failure failover targets, cross-validation plans, and session/monthly budget constraints. Custom rules are edited in Settings and can combine optional keyword matching (`any` or `all`), inferred request task types, a minimum effective risk level, and the active scheduling strategy. Configured condition groups use AND semantics, selected task types use OR semantics, and old keyword-only rules remain compatible. A matching rule writes its name and structured conditions into the routing reason, while hard budget and Provider-health constraints remain authoritative. Project dispatch hints are read from the active project's `caogen.md` and remain project-scoped: current smokes verify that separate projects can route the same prompt to different Provider/model targets. Smart routing now reads the persisted Provider health state: unhealthy Providers are excluded when a healthy candidate exists, while an all-unhealthy pool remains runnable with an explicit warning instead of silently disabling routing. Each routing event carries a structured decision log with the selected Provider/model, effective strategy, inferred tasks and risk, candidate count, selected score inputs, reliability, estimated cost, remaining budget, rule or role basis, budget downgrade state, provider-switch state, health-filter warnings, and top alternatives. The renderer preserves that data, shows a compact Provider-to-model summary with expandable details in chat, and feeds the same Provider/model and selection basis into the selected-Agent panel in the 3D office. Control Center now consumes a shared budget report: active sessions and current-month history are deduplicated by `id` or `sdkSessionId`; the UI shows monthly spent/remaining/progress, active and historical cost, Provider aggregation, and highest-cost sessions. Active limits resolve in the order explicit session limit, Provider per-session limit, then global per-session limit, and either a monthly overage or active-session overage raises the budget warning state. Historical records do not contain their original explicit session limit, so the report deliberately does not invent historical budget ratios. The Electron page smoke verifies users can configure and persist a structured review rule through the real Settings UI (`test-results/caogen-deep/2026-07-10T12-48-21-376Z/page-operation-smoke.json`). `npm run test:model-router` verifies structured-only task/risk/strategy matching, task mismatches, all-keyword behavior, legacy rules, role preferences, project isolation, and hard-budget downgrades. `npm run test:failover-target` verifies that the configured fallback Provider/model wins after a primary failure, unhealthy fallback targets are skipped, model-only fallback preferences find an advertising Provider, both OpenAI and SDK AgentSession failover paths update the fixed model, and the renderer shows a readable failover note (`test-results/failover-target/latest.json`). `npm run test:routing-visibility` server-renders the routing message and guards the chat/store/3D visibility contract (`test-results/routing-visibility/latest.json`); `npm run test:provider-health-history` guards the persisted health state consumed by routing (`test-results/provider-health-history/latest.json`); `npm run test:budget-report` verifies budget deduplication, monthly totals, Provider aggregation, limit priority, sorting, and Control Center wiring (`test-results/budget-report/latest.json`). This is not yet a free-form natural-language policy editor, per-key quota router, cross-month exact cost ledger, or long-term cost trend surface.

- Cost-first, quality-first, speed-first, and balanced are four independent strategies. Speed-first ranks by latency class and then by historical latency EMA within the same class; focused routing coverage proves that speed-first and quality-first select different models for the same complex task and records the latency class/EMA in the decision explanation. Effective strategy priority is project rules, then the user-selected Core strategy, then the preset of a specialized work mode. Project `caogen.md` parses `速度优先` as `speed` instead of collapsing it into balanced, while Core preserves the saved user strategy. The real Settings page persists both `schedulerStrategy: speed` and custom-rule `whenStrategy: speed`; chat routing details, Control Center, and the selected-Agent 3D office panel expose the effective strategy. Historical evidence is page operations 17/17 (`test-results/caogen-deep/2026-07-10T12-48-21-376Z/page-operation-smoke.json`), integration 33/33, and the then-current Deep gate 81/81 (`test-results/caogen-deep/2026-07-10T12-44-23-898Z/deep-test-report.md`); these counts are not the current 2026-07-18 Deep baseline.

Acceptance:

- Simple tasks prefer fast or low-cost routes.
- Complex tasks prefer stronger reasoning routes.
- Failures trigger fallback without hiding the failure reason.
- Users can inspect why a model/provider was selected.

## Phase 6: Real 3D Office

Goal: 3D office is not decoration; it is a live visualization of model, task, cost, and workspace state.

Tasks:

- Multi-task workstations.
- Model and provider status.
- Subtask flow.
- Approval waiting state.
- Failure and retry state.
- Cost and duration indicators.
- File and workspace state.
- Agent message flow.

Current implementation note:

- The 3D office model derives workstation state from real renderer `SessionState`: session activity, pending approvals, running tools, task/DAG flow, subagent packets, routing decisions, failover events, cost, budget, latest turn duration, worktree isolation/branch/state, and checkpoint file-change events. When the office is open, visible sessions also refresh `git status` on demand so branch, dirty file count, staged/unstaged/untracked counts, and git errors feed the office summary, selected-agent panel, and workstation signal stack. Electron page smoke now verifies this through the rendered app, not only source/static checks: an isolated worktree session with a dirty untracked file must surface in `data-office-*` telemetry, the selected-agent panel, clickable workstation state, failover/duration signal, and a nonblank WebGL canvas. This is not full live git-diff polling, a full delivery dashboard, trend analytics surface, or release-management replacement.

Acceptance:

- 3D scene state comes from real task/session data.
- No fake progress or decorative-only status.
- Users can understand what CaoGen is doing by looking at the office.

## Near-Term Priority

1. Keep release tooling and public copy aligned with the current version-neutral product definition.
2. Continue automatic scheduling from structured rules toward a free-form user-owned policy editor without hiding hard budget and health constraints.
3. Extend proved error-driven key failover toward quota-aware selection only when real provider evidence can support it.
4. Improve Office viewing beyond text/structure while preserving explicit format and fidelity limits.
5. Turn the real 3D office signals into a clearer task, approval, retry, cost, and delivery control surface.

## One-Line Goal

CaoGen's next step is not adding more buttons; it is unifying models, projects, files, tasks, and tools into a real AI work desktop.
