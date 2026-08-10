# Sprint 01 Gate Baseline

> Date: 2026-08-04 (Asia/Shanghai)  
> Scope: `GATE-001`, `GATE-002`, `GATE-003`, `ARCH-001`, `VIS-001`, `QA-001`, `PKG-000`  
> Source baseline: `main@374793c486261c90e91190d68ec81d3f8389d631`  
> This worktree is dirty. The Windows package is D0 `unsigned-preview`, not a C1 candidate or a release.

## Truth Rules

- A source/build smoke is not Owner acceptance. Owner evidence must come from the installed EXE and remain private when it contains credentials, provider URLs, or project paths.
- A dirty-worktree package may be used to discover defects only. Its provenance must say `worktreeClean=false`; it cannot close a release gate.
- The historical `OWNER-TEST-000` report at `test-results/section5-blackbox/report.md` records S1, S2, and STOP-1, but its tested artifact SHA-256 was not captured. It is valid defect-discovery evidence only and cannot close a later artifact.
- The current FIX-000 D0 artifact is `dist/CaoGen-0.1.8-windows-x64-unsigned-preview.exe`, size 229,172,133 bytes, SHA-256 `938bc5c13ead77cb4dc592cbfa66ad3a4e93c44dbca7758c48f820815d4619c2`, and artifact-set SHA-256 `898e778c976e1f2552854b244b4197b2b5d68123785718bf967acd4d0722bb13`. The package audit is bound to commit `374793c486261c90e91190d68ec81d3f8389d631`, reports dirty provenance, and passes 45/45 checks. This SHA includes the Provider authentication-header fix, restored in-process NSIS install-root removal, bundled TypeScript/JavaScript semantic runtime proven against the exact unpacked app (8/8), compatibility handling that preserves non-replayable quarantined historical Runs without blocking unrelated new sessions, repeated legacy Run ownership ordering, complete canonical ownership propagation for managed-worktree Operations, aggregate compatibility for historical ledger-only Operations, Artifact lifecycle ownership rooted in the active Electron user-data store, immediate target-bound confirmed-side-effect replay suppression across Responses and Chat Completions failover, Windows ProjectWorkspace lock-contention recovery, and no-egress page validation. The Office delivery required gate passes 44/44; the required private portable audit and complete 12-step Owner audit must bind to this exact SHA.
- The D0 package audit passes 41/41 explicit preview checks, including x64 PE, unsigned app/installer, no stable update metadata, provenance, packaged `en-US`, `zh-CN`, `zh-TW` locales, explicit non-silent uninstall confirmation, direct-uninstall file restoration hooks, and post-atomic bounded install-root cleanup scheduling.
- An earlier D0 observation entered Windows SmartScreen/security handling and then displayed `Failed to uninstall old application files. Please try running the installer again.: 2`; it created no isolated-install files. Read-only registry inspection found an existing all-users CaoGen 0.1.8 uninstall entry, proving that NSIS upgrade handling can invoke the old uninstaller before honoring the intended isolated `/D` target. The default D0 smoke detects this state and fails fast with `installation.status=blocked`. `npm run test:packaged-app:win:preview:d0:interactive` remains valid only on a clean disposable Windows environment with an Owner present.
- A separate isolated-user-data launch of the current freshly unpacked `CaoGen.exe` reached interactive state in 1270 ms on first launch and 1135 ms after restart. Both launches rendered a non-empty React root and welcome/first-task composer, exposed a ready preload bridge, and reported `documentLanguage=zh-CN` with settings language `zh`. This narrows S1/S2 against the latest D0 build, but the report is explicitly `development_diagnostic`; it is not installed-package or Owner evidence and does not close either finding.
- The Owner later removed the existing installation. A new clean-host check found zero CaoGen process and uninstall registration, and the requested manual-install directory was absent before preflight. The previous D0 revision's portable installed smoke then passed install, non-empty `zh-CN` renderer, uninstall, registry cleanup, isolated-user-data preservation, and temporary-root cleanup; its private record SHA-256 is `08f184b198b245124e00218358f8a81d78cc1dc382db2085b151b2b13831b140`. That record is historical defect evidence and does not satisfy the current SHA.
- A standalone Owner kit removes the clean-host dependency on a source checkout, Git, npm, or system Node. The current SHA-bound ZIP is 262,412,957 bytes with SHA-256 `d8486f5751a4e2d1f62fd486ef06e72bf2ee1ecc81165383e3d6d017ee5cf284`; its ten-file manifest SHA-256 is `7fdcf56c40bb7dbeea214edf7219467d24e6350419e844c525bfed10ac821eb3` and content-set SHA-256 is `0445ee1cfbab283bf18fa12e9e26e5caee7372a5f37eba75914baa6953fcad6d`. It contains the path-bound assisted installer and exact current D0 metadata.
- The current SHA passed its required private portable audit, path-bound assisted install, installed Provider model discovery and fixed-route read-only task, Studio recruitment and persistence, one successful Office artifact with exactly one confirmed `create_document` side effect, durable restart recovery, one-prompt default-No cancel/relaunch, and confirmed uninstall. The exact install root disappeared in 0.293 seconds; registration and process counts were zero; 5 Providers, 5 API-key records, 10/10 encrypted envelopes, and 5 DigitalWorkers remained. The complete 12-step Owner audit passed with record SHA-256 `511e689723246bf507dd9db2dbf22e92a43152ac1c85a61f802480cbef552914` and zero findings.
- The subsequent manual-flow preflight passed for a new custom directory. After the assisted install completed, read-only inspection found the preflighted directory empty while the running executable and uninstall registration referenced a different directory. The run stopped at step 1 before Provider, project, task, Office, restart, or uninstall testing. Attribution remains undetermined between installer path handling and manual path-entry deviation; the redacted failed record SHA-256 is `e6d89b91f451bb344f4d68fadf926f6027ed01ac76b81f40c3f721c423215ae3` and its observation audit has no schema or gate failure.
- A later read-only observation of the preserved install found a separate High first-task blocker. A real Provider was stored with encrypted credentials and had a recent successful health result, but session creation left only `starting` journal drafts and no session/active-registry record. Native-window inspection reconfirmed `WorkflowLedgerMigrationError: Committed migration target durable history regressed`. The source defect was an old committed-v8 readiness journal without Conversation Ledger evidence combined with v9 readiness collapsing all otherwise-valid verification when the new additive tables were absent. The current FIX-000 D0 retains partial verification so continuity can compare existing high-water marks and then perform the additive v9 migration. Migration regression, typecheck, production build, package audit and isolated renderer diagnostics pass. A separate real-data clone diagnostic copied only the database and migration evidence, rebound absolute journal paths inside the temporary clone, then proved v8-to-v9 migration, Conversation Ledger creation, existing-table count preservation, recovery of both failed IPCs, absence of the visible regression and an unchanged source aggregate digest. It copied no Provider, URL, project or session record and cleaned the clone. Installed reproduction against this SHA remains required before the High finding can close.
- The install-target mismatch cannot be attributed from the old evidence because preflight and installer launch were separate actions: the preflight validated a planned directory but never supplied it to NSIS. FIX-000 now has a path-bound assisted-install entry that repeats clean-host preflight, launches the interactive installer with the planned directory as its sole final `/D` argument, and verifies application/uninstaller files plus both uninstall registry commands against that directory without publishing it. A contract smoke passes, and a real negative run on the currently installed host failed before invocation with `installerInvoked=false`. The entry is present in the current SHA-bound kit; a clean-host positive Owner run remains required.

## GATE-001: Replacement Boundary

### Users

The first target is a solo technical or knowledge worker who needs one desktop entry point for model configuration, local projects, delegated work, tool execution, approvals, and verifiable delivery. The next target is a small team that needs Project-scoped workers, audit, and handoff. The product is not claiming to replace a provider, a cloud control plane, or a full team-chat suite.

### Product boundary

In scope: Provider-neutral native Runtime; Project/Goal/WorkItem/Run/Worker state; permission and Effect review; Artifact/Evidence/Acceptance delivery; local automation; Office/connectors with explicit trust boundaries; and the watercolor worker projection after its asset gates pass.

Compatibility adapters may import or proxy CC Switch, Codex, Claude, Hermes, OpenClaw, and WorkBuddy assets. They are migration boundaries, not runtime prerequisites. A user must be able to launch CaoGen without installing a competing agent CLI.

Out of scope for this plan: training a foundation model, copying private vendor cloud services, unauthorized reuse of closed-source code, a plugin marketplace, mobile clients, and a public stable replacement claim before the release gates pass.

### Technical boundary

| Layer | Owns | Must not own |
|---|---|---|
| Domain | Provider-neutral Project, Goal, WorkItem, Worker, Run, Artifact, Evidence, Acceptance identities and invariants | Provider names, API keys, renderer state, or HTTP details |
| Adapter | Provider protocol, capability translation, request/response normalization, provider-specific errors | Canonical business state or direct renderer access |
| Runtime | Session/Run/Context/Tool/Permission/usage/checkpoint/recovery orchestration | Secret persistence or unreviewed external side effects |
| Trust | Effect, permission, credential lease, approval, postcondition, reconciliation and fail-closed decisions | UI-only authorization or implicit replay |
| Persistence | Versioned schemas, atomic writes, journals, snapshots, backups, migration and digest verification | Unversioned ad-hoc production writes |
| UI | Assistant/Studio projections, controls, accessibility, status and evidence links | Direct file/provider mutation or hidden provider identity |

## GATE-002: Golden Workflows

The comparator baseline is the shortest successful path in the named competitor surfaces. Values are intentionally `not measured` until a private Owner/competitor run records start/end timestamps, screenshots, failure count, and recovery result.

| ID | Golden workflow | CaoGen acceptance signal | Comparator baseline |
|---|---|---|---|
| GW-01 | First launch and first task | Interactive shell, welcome/first-task prompt, no duplicate session | Codex/Claude Desktop/WorkBuddy first usable shell; not measured |
| GW-02 | Add OpenAI-compatible Provider | Main-process credential save, encrypted token, health result | CC Switch/Multica provider add and test; not measured |
| GW-03 | Add Anthropic Messages Provider | Protocol selection, scoped credential lease, health result | Claude Desktop provider/auth setup; not measured |
| GW-04 | Open a local Project | Project identity and `projects.json`/canonical record survive restart | Codex/Claude Code workspace open; not measured |
| GW-05 | Read-only repository summary | No project-file mutation; transcript and audit evidence | Codex/Claude Code read-only request; not measured |
| GW-06 | Plan a multi-step Goal | Editable Goal/WorkItem/Acceptance draft before execution | WorkBuddy/Hermes planning flow; not measured |
| GW-07 | Execute an approved WorkItem | Run identity, lease, permission and status projection | Codex/Claude Code task execution; not measured |
| GW-08 | Tool approval and denial | Effect record, user decision, postcondition or blocked state | Claude Code/Codex approval prompt; not measured |
| GW-09 | Fail and repair a task | Repair WorkItem, new Acceptance revision, retest evidence | Hermes/OpenClaw retry/repair behavior; not measured |
| GW-10 | Recruit a DigitalWorker in Studio | Role/Worker/Assignment persistence without external agent CLI | WorkBuddy/Studio worker setup; not measured |
| GW-11 | Observe real task status | Worker identity, action, Run and WorkItem status are live and truthful | WorkBuddy/Hermes activity view; not measured |
| GW-12 | Switch Assistant and Studio | Same canonical identities, draft and transcript after switch/reload | Codex/Claude Desktop surface continuity; not measured |
| GW-13 | Generate a Word artifact | Confirmed Effect, bytes/digest, Artifact/Evidence/Acceptance links | Office-capable competitor workflow; not measured |
| GW-14 | Generate an Excel artifact | Workbook exists, digest and delivery report are bound | Office-capable competitor workflow; not measured |
| GW-15 | Generate a PowerPoint artifact | Deck exists, digest and delivery report are bound | Office-capable competitor workflow; not measured |
| GW-16 | Restart during a running task | Recovery classification, no unsafe replay, stable IDs | Codex/Claude/Hermes restart behavior; not measured |
| GW-17 | Provider/key failover | Attempt ledger, route reason, no duplicate external side effect | CC Switch/Multica failover; not measured |
| GW-18 | Import a sanitized competitor asset | Preview, backup, idempotent import, rollback and redacted report | CC Switch/Codex/Hermes/OpenClaw migration; not measured |
| GW-19 | Review and accept delivery | Acceptance criteria, Evidence, approval and report are complete | WorkBuddy/Codex delivery review; not measured |
| GW-20 | Uninstall and clean recovery | Visible/controlled uninstall, app remains launchable until confirmed, residual scan | Windows desktop installer/uninstaller baseline; not measured |

Required comparator measurements: time to interactive shell, time to first successful read-only task, number of user-visible recovery steps, duplicate/failed external effects, data-file mutation count for read-only tasks, and whether the same path can be completed without opening the competitor.

## GATE-003: Unique P0/P1 Mapping

Each of the 64 P0 and 38 P1 rows from `docs/PRODUCT-REQUIREMENTS.md` appears exactly once below. A row may share a delivery task with other rows, but no requirement is assigned to multiple Sprint tasks.

| Requirement | Priority | Sprint task |
|---|---:|---|
| EXP-001 | P0 | UX-001 |
| EXP-002 | P0 | UX-001 |
| EXP-003 | P0 | UX-001 |
| EXP-004 | P1 | UX-001 |
| EXP-005 | P1 | REPORT-001 |
| EXP-006 | P1 | UX-001 |
| PROJ-001 | P0 | LEDGER-001 |
| PROJ-002 | P0 | LEDGER-001 |
| PROJ-003 | P0 | LEDGER-001 |
| PROJ-004 | P0 | MIG-001 |
| PROJ-005 | P1 | GOAL-001 |
| PROJ-006 | P1 | MIG-001 |
| GOAL-001 | P0 | GOAL-001 |
| GOAL-002 | P0 | GOAL-001 |
| WORK-001 | P0 | WORK-001 |
| WORK-002 | P0 | WORK-001 |
| WORK-003 | P0 | WORK-001 |
| WORK-004 | P0 | WORK-001 |
| WORK-005 | P1 | PLAN-001 |
| WORK-006 | P1 | PLAN-001 |
| TEAM-001 | P0 | WORKER-001 |
| TEAM-002 | P0 | WORKER-001 |
| TEAM-003 | P0 | WORKER-002 |
| TEAM-004 | P0 | WORKER-001 |
| TEAM-005 | P0 | WORKER-001 |
| TEAM-006 | P1 | TEAM-001 |
| TEAM-007 | P1 | MEM-001 |
| TEAM-008 | P1 | PERF-001 |
| ROUTE-001 | P0 | ROUTE-001 |
| ROUTE-002 | P0 | FAILOVER-001 |
| ROUTE-003 | P0 | ROUTE-001 |
| ROUTE-004 | P0 | RUNTIME-001 |
| ROUTE-005 | P0 | ROUTE-001 |
| ROUTE-006 | P0 | ROUTE-001 |
| ROUTE-010 | P0 | FAILOVER-001 |
| ROUTE-007 | P1 | ROUTE-001 |
| ROUTE-008 | P1 | ROUTE-001 |
| RUN-001 | P0 | RUNTIME-001 |
| RUN-002 | P0 | RUNTIME-001 |
| RUN-003 | P0 | RUNTIME-002 |
| RUN-004 | P0 | REC-003 |
| RUN-005 | P0 | REC-003 |
| RUN-006 | P0 | MIG-002 |
| RUN-007 | P1 | MIG-002 |
| TRUST-001 | P0 | TRUST-001 |
| TRUST-002 | P0 | TRUST-001 |
| TRUST-003 | P0 | EFFECT-001 |
| TRUST-004 | P0 | CRED-001 |
| TRUST-005 | P0 | LEDGER-001 |
| TRUST-006 | P0 | CRED-001 |
| TRUST-007 | P1 | PLUGIN-001 |
| ART-001 | P0 | ART-001 |
| ART-002 | P0 | ACCEPT-001 |
| ART-003 | P0 | ART-001 |
| ART-004 | P0 | REPAIR-001 |
| ART-005 | P1 | REPORT-001 |
| ART-006 | P1 | CONN-002 |
| AUTO-001 | P1 | AUTO-001 |
| AUTO-002 | P1 | AUTO-002 |
| AUTO-003 | P0 | AUTO-003 |
| AUTO-004 | P0 | AUTO-003 |
| VIS-001 | P0 | VIS-001 |
| VIS-002 | P1 | VIS-002 |
| VIS-003 | P1 | VIS-003 |
| VIS-004 | P1 | VIS-006 |
| VIS-005 | P1 | VIS-007 |
| VIS-006 | P1 | VIS-009 |
| VIS-007 | P1 | VIS-009 |
| CONN-001 | P1 | PLUGIN-001 |
| CONN-002 | P1 | CONN-001 |
| NFR-PRIV-001 | P0 | CRED-001 |
| NFR-PRIV-002 | P0 | ROUTE-001 |
| NFR-PRIV-003 | P0 | SECRET-001 |
| NFR-PRIV-004 | P0 | ROUTE-001 |
| NFR-REC-001 | P0 | REC-001 |
| NFR-REC-002 | P0 | REC-002 |
| NFR-REC-003 | P0 | REC-003 |
| NFR-REC-004 | P0 | REC-004 |
| NFR-REC-005 | P0 | MIG-001 |
| NFR-AUD-001 | P0 | AUDIT-001 |
| NFR-AUD-002 | P0 | AUDIT-001 |
| NFR-AUD-003 | P0 | SECRET-001 |
| NFR-AUD-004 | P1 | REPORT-001 |
| NFR-PERF-001 | P1 | PERF-001 |
| NFR-PERF-002 | P1 | PERF-001 |
| NFR-PERF-003 | P1 | PERF-001 |
| NFR-PERF-004 | P1 | VIS-011 |
| NFR-PERF-005 | P1 | VIS-011 |
| NFR-UX-001 | P0 | UX-001 |
| NFR-UX-002 | P0 | UX-001 |
| NFR-UX-003 | P1 | UX-001 |
| NFR-UX-004 | P1 | VIS-010 |
| NFR-UX-005 | P1 | UX-001 |
| NFR-NEUTRAL-001 | P0 | RUNTIME-001 |
| NFR-NEUTRAL-002 | P0 | ROUTE-001 |
| NFR-NEUTRAL-003 | P0 | ROUTE-001 |
| NFR-NEUTRAL-004 | P1 | RUNTIME-001 |
| NFR-ENG-001 | P0 | ARCH-001 |
| NFR-ENG-002 | P0 | ARCH-001 |
| NFR-ENG-003 | P0 | QA-001 |
| NFR-ENG-004 | P1 | QA-001 |
| NFR-ENG-005 | P1 | QA-001 |

## ARCH-001: Layer Rules

The layer table in GATE-001 is normative. New code must declare its owner layer and cross a narrow interface. Domain modules cannot import Electron, provider SDKs, filesystem paths, or renderer stores. Adapters cannot write canonical state. Runtime actions must pass Trust and Persistence before an external effect. Persistence writers must declare schema/version and an atomic or journal strategy. UI is a projection and sends commands through preload/main; it cannot persist credentials or perform direct external effects.

Required review evidence: `npm run typecheck`, `npm run test:1.0-acceptance-map:smoke`, the relevant layer smoke, and a source-level negative check for direct renderer-to-provider/file mutation.

## VIS-001: Watercolor Contract

The normative visual source is [`WATERCOLOR-VISUAL-ASSET-PRODUCTION-SPEC.md`](WATERCOLOR-VISUAL-ASSET-PRODUCTION-SPEC.md). It defines the seven roles, original-art constraints, palette, silhouette, full/compact/list/silhouette LOD, reduced motion, and provenance. The current runtime inventory passes `npm run test:watercolor-assets:required` with 49/49 verified and 49 registered 1024x1536 RGBA PNG files; the valid-RGBA/corrupt-CRC smoke and required light/dark/96px/48px QC also pass. `npm run test:watercolor-packaged-assets:required` additionally proves 49/49 byte-for-byte digest parity in the audited ASAR build input (ASAR SHA-256 `8b319ddb41b7436011d757a6905a48bb4e76b740f0257df61d7de5353fff2d2d`). Installed-package digest parity, target-hardware performance and external blinded role/state recognition remain open and cannot be replaced by a development asset gate.

## QA-001: Evidence Classification

| Evidence class | Examples | Required owner | Current command/evidence |
|---|---|---|---|
| Automatic/local | typecheck, source maps, schema, encryption prefix, ledger recovery, provider routing | Development | `npm run typecheck`; targeted `scripts/*-smoke.mjs`; `npm run build:fix-000-owner-kit` |
| Human/UI | first launch, Provider form, Project open, Studio hire, Office output, language stability | Product Owner | Private screenshots/recording; agent only checks redacted state files |
| Time-bound | launch timing, first-task completion, N1 30-minute migration, 7/30-day soak | Product/Test owner | Timestamped private run record; `npm run test:fix-000-owner-retest:required -- --record <private-json>` |
| Hardware/platform | Windows x64 installer, SmartScreen, GUI, disk/full or strong kill, 3D GPU/LOD | Release/Test owner | Portable kit installed smoke plus native Owner evidence; build/preflight cannot replace it |
| External credential/network | real Provider calls, OAuth, GitHub/GitLab, Office/cloud connectors | Credential holder + Test owner | Redacted request/result; never record key or URL in public report |
| Package/provenance | EXE name/version/size/SHA-256/HEAD/worktree/signature/metadata | Release owner | `npm run test:windows-preview-config`; D0 `npm run test:windows-preview-audit:d0` |

## Sprint 01 Execution Status

| Item | Status | Evidence or blocker |
|---|---|---|
| `GATE-001` | Baseline documented | Boundary is frozen here; product approval still required |
| `GATE-002` | Baseline documented | 20 workflows defined; competitor timing data not measured |
| `GATE-003` | Baseline documented | 102 unique rows listed; `npm run test:sprint-01-gates` enforces exhaustive uniqueness |
| `ARCH-001` | Baseline documented | Rules frozen here; full source audit remains open |
| `VIS-001` | Partial | 49/49 runtime assets and audited ASAR build-input digests pass; installed digest, target-hardware performance and blinded human acceptance remain open |
| `QA-001` | Baseline documented | Evidence classes and ownership are defined |
| `PKG-000` | Partial | Current FIX-000 D0 EXE is SHA-bound and passes 40/40 audit; only the previous SHA passed portable installed smoke, so the dirty current package still requires machine evidence and cannot be a clean candidate |
| `OWNER-TEST-000` | Failed / No-Go | Historical installed-EXE report records S1, S2 and STOP-1 but lacks an artifact SHA; later workflows were stopped |
| `FIX-000` | Passed / Go for `PKG-001` preparation | Current dirty D0 passes package, required portable, path-bound assisted install, complete 12-step Owner, restart, Office side-effect replay, cancel/relaunch and confirmed-clean-uninstall evidence against one exact SHA |
| `PKG-001` | Not started | Requires exact clean commit and C1 audit |
| `OWNER-RETEST-001` | Not started | Must bind to `PKG-001` SHA-256 |

## FIX-000 Evidence and Owner Retest Boundary

Automated/local evidence currently supports only the following claims:

- Main-window creation, IPC/menu setup, and renderer diagnostics occur before recovery work that can fail or stall; preview updater startup is disabled when `app-update.yml` is absent. Provider Profile reconciliation errors keep the shell alive while later Provider Profile mutations continue to fail closed on the same unresolved journal state.
- The custom NSIS include requires explicit Yes/No confirmation for a direct non-silent uninstall, defaults to No, preserves user data, and restores application files when direct removal cannot complete.
- The audited D0 artifact contains those NSIS hooks and passes 41/41 preview checks. Its helper waits on the running uninstaller PID and uses one 30-second retry budget with a detached-process-safe delay. The SHA-bound interactive installed smoke passed renderer launch, uninstall registration cleanup, and complete install-root removal.
- The GitHub Actions unsigned smoke has a separate, explicit unattended authorization that is rejected outside GitHub Actions. On a clean runner, the smoke must now prove that silent cleanup removes both the isolated install root and the CaoGen uninstall registration before its own fallback temp cleanup runs. This automated path does not replace the Owner's direct non-silent confirmation/cancel check.
- The unpacked renderer diagnostic passes first launch and restart, but remains non-release evidence. It cannot change `OWNER-TEST-000`, S1, S2, or STOP-1 status.

The previous D0 SHA passed an earlier portable installed smoke but later reproduced an empty install-root residual in the Owner Yes branch. The current SHA above now passes the required private portable audit and the complete 12-step Owner record. The canceled uninstall showed exactly one confirmation with No as the default and left the application launchable; the confirmed uninstall removed the exact install root without partial deletion while preserving Roaming user data. `test:fix-000-owner-retest:required` passes against private records bound to the current exact D0 with zero findings. A passing Sprint hard gate permits preparation of `PKG-001` from an exact clean commit; it does not itself establish C1 or release acceptance.
