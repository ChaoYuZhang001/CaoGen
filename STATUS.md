# CaoGen 项目状态

> 更新:2026-07-23· 实测口径,非文档自评。此文件为活文档,Current Focus 随日更新。
>
> ⚠️ **未达完整发布标准**。本地代码、构建和四态 Deep 门禁已收口；Intel x64 已完成本地 Developer ID 签名基线，但最终候选公证、Apple Silicon 真机启动、Windows 签名、指定真实 Provider/中国网络证据仍取决于外部账号、机器或额度。Docker 已从产品模式删除；Claude 是可选引擎，不登录也不阻塞默认 OpenAI-compatible 路径、本地启动或发布门禁。
> 当前源码版本为 `0.1.7` 发布候选，不是正式 1.0 stable：PRD 64 个 P0 中 21 个处于完整“当前已验证”，43 个仍开放，其中 25 个为立项目标、17 个部分完成、1 个仅达到基础。执行边界见 `docs/1.0-ACCEPTANCE-MATRIX.md`；0.1.7 只按已验证楔子能力发布，不把路线图能力写成已完成。
>
> **状态纪律**(修正第 2 次犯的"未复现即声称"):凡真对话/可用性类结论必须写明**成立条件与复现环境**,不写环境无关的绝对断言。

# Context

国产原创**多厂商 AI 工作桌面**(Electron + React + react-three-fiber,AGPL-3.0-only 开源并提供独立商业授权,[GitHub](https://github.com/ChaoYuZhang001/CaoGen))。差异化站位:**不绑定厂商** —— 支持多模型、多密钥、多厂商配置,接入中转站和本地兼容服务;每个项目可独立配置 AI 工作规则;内置代码执行、项目理解、任务拆解、自动调度、工作区隔离、插件扩展、项目记忆、文件预览和 3D 办公可视化。

# Current Status

- **[v0.1.6 macOS x64 已发布](https://github.com/ChaoYuZhang001/CaoGen/releases/tag/v0.1.6)**(2026-07-14)——发布 5 个 DMG、zip、blockmap 和更新元数据资产;macOS Intel 主二进制为 `x86_64`;包内运行时和真实 renderer 启动均纳入发布门禁;仍未签名/公证
- v0.1.5 Windows x64 安装包继续保留;v0.1.6 不发布 Windows、macOS arm64 或 Linux 资产。
- v0.1.5 新增整页设置与 Provider 编辑、项目级会话收纳、未关联项目会话收纳、三种显式调度范围，以及调研/策划/开发/测试/文档的默认与自定义模型调度。
- M1 文档收敛提交已快进到 `main@cf18cd0d`；`package.json` 与 lock 根版本均为 `0.1.7`。该 clean commit 上的完整 Deep 为 `156 total / 153 required pass / 3 optional skip / 0 blocked / 0 fail`，报告为 `test-results/caogen-deep/2026-07-23T05-54-33-895Z/deep-test-report.md`；测试开始和结束均为 clean 且 Git 状态不变。随后 Release Doctor（`test-results/workos-release-doctor/2026-07-23T06-24-24-832Z`）把 `deep_test` 标为 ready，开放域只剩 `packaging_release` 与 `release_notes`。
- 正式运行时现有默认 OpenAI-compatible API、可选 Claude Agent SDK，以及已注册到 Provider/SessionManager/UI 的原生 Anthropic Messages 三条执行路径。上述最新 Deep 的 3 个 optional skip 分别保留真实 Claude、China real-network、China tool-call parity 的外部条件，不计入 pass，也不阻塞默认发布档位；clean Deep 仍不能替代签名、公证、目标平台安装和最终资产绑定。
- Agent 恢复内核已升级为稳定事件身份 + 恢复游标 + 持久 Effect Ledger。`write_file`、`search_replace`、OpenAI/Claude 文件编辑、Git commit/merge/push、Renderer 文件与 Git Index 操作、文本 hunk 丢弃、managed-worktree create/remove/patch 和 GitHub/GitLab PR/MR 已接入专用只读对账；Operation Gateway、lease/fencing、强杀恢复、DAG autoMerge durable finalizer/receipt 已由 required E2E 覆盖。该边界不等于外部系统事务级 exactly-once，writer 仍可能在强杀/断电/ENOSPC 时留下半写文件。
- `task-snapshots.db` 当前为 v8：保留 v6 TaskRun Effect evidence append-only hash-chain foundation、Goal/WorkItem/Run/Artifact/Acceptance/Evidence Link 与全局 workflow event chain，并新增 canonical `workflow_recovery_sessions` 和持久 `workflow_store_identity`。显式对象的 main API、IPC/preload、Control Center 查询/校验和 cursor 分页已有 targeted smoke；Artifact Graph 的 edge/location、关系/归属校验、邻域查询、脱敏 export 与只读 diagnose/repair plan 也已接通。Task Snapshot/TaskRun 恢复读取现支持 `legacy`、`compare`、`canonical` 三态：`legacy` 读取旧 Snapshot/TaskRun 表，`compare` 同时读取 legacy 与 canonical 并在差异时 fail-closed，`canonical` 读取 Workflow Run 与 recovery session；未显式配置时仍默认 `legacy`。read mode 按解析后的数据库路径隔离，跨 mode 首次 open 共享同一路径的 single-flight readiness；运行时 mode flip 在数据库 mutation queue 中强制刷新 readiness，并实际读取 recovery sessions 与 Run 历史后才提交。legacy JSON/旧 SQLite 到 v8 的迁移仍使用 `prepared -> backup_verified -> migrated_verified -> committed`、`rollback_pending -> rolled_back`、精确备份/SHA-256/fsync/原子 rename、崩溃 checkpoint 续做和可恢复回滚；future/corrupt source 在 journal 前 fail-closed。committed journal 通过 `workflow_store_identity` 和 committed 高水位连续性阻止目标删除、截断、版本回退或同版本有效空库替换。Canonical-only 历史在后续双写和重启后仍可读取；同一 session 的连续 TaskRun、Snapshot freshness 和历史 Run ownership 已按精确 run/项目上下文收口。该能力完成的是 Task Snapshot/TaskRun 恢复读源的可验证 cutover，不代表所有业务入口已经 canonical，也不等于完整 1.0 Workflow OS。结构化交叉验证仲裁失败与原生 `bash` 显式测试命令的非零退出失败已有受限入口；Routine、DigitalWorker/Assignment、其他工具/引擎测试结果等外部事件仍未全部接入。完整 Artifact Graph 生命周期（blob/sourceRef、版本/保留/删除）、Canonical Conversation Ledger、统一 retention/delete 和生产补偿计划/审批/执行也未闭环。独立 `task_evidence` 子链没有直接 UI 或统一 retention/delete 通道。最新 clean 156 项 Deep 已包含 migration、read source、shadow consistency、Workflow Ledger、Artifact Graph、security、maintenance、ModelAttempt crash reconciliation、Canonical Goal/WorkItem schema parity、canonical ProjectWorkspace write-source crash、Acceptance failure ingress、Artifact byte integrity、TEAM-002 真实 Electron 招聘、Provider credential target binding、Assistant/Studio live-switch、Anthropic 生产路径与 Code Forge contract smoke；报告绑定 `cf18cd0d` 且开始和结束均为 clean，但仍不等于 1.0 release ready。
- Canonical ModelAttempt v1 已把 OpenAI-compatible 请求、模型 DAG、Claude Agent SDK turn 与原生 Anthropic Messages 每次底层 HTTP 请求接入 Run/WorkItem 归属、逻辑 request/step、Provider/model/protocol、route reason、usage 和不可变事件链；`started` Attempt 在强杀重启后会把 legacy TaskRun、canonical Run 和匹配 snapshot 原子投影为 `waiting_reconciliation`，普通发送/恢复/删除均 fail-closed。用户只能显式 `retry_authorized` 或 `cancelled_by_user`；授权本身不调用 Provider，successor 必须消费同一 requestId/stepId 并链接 predecessor，二次强杀不会复用旧授权。原生 Anthropic Messages 已注册独立 EngineKind 并接入 Provider/SessionManager/UI；saved Provider/Broker 目标绑定、`/v1/messages`、thinking/redacted thinking/text SSE、usage、HTTP/流错误、取消、`tool_use/tool_result` 多轮 NativeToolRuntime、权限/审计/Effect/幂等、40 请求上限、同 Provider Key 与仅限 Anthropic Engine 的 Provider failover，以及内容寻址图片重启恢复，分别由 `test:anthropic-messages:required` 17/17、`test:anthropic-tool-use-loop:required` 10/10、`test:anthropic-failover:required` 8/8、`test:anthropic-engine-registration:required` 和 `test:anthropic-image-restart:required` 覆盖。partial 输出、abort、账本失败或未决 Effect 会保守阻止重放；当前仍缺真实 Provider、clean release 绑定、完整恢复阶梯与统一 Run/Context 契约，因此 ROUTE-004/RUN-003 仍仅为部分完成。
- 2026-07-20 的 1.0 domain 增量已落地无目录 `ProjectWorkspace`、Goal Contract、WorkItem、Resource、归档/恢复/删除/manifest 导出，以及原生 RoleTemplate、DigitalWorker、Assignment、退休历史、lease/fencing 和 `done/completed` Evidence/waiver Acceptance Guard 基础；ProjectWorkspace、DigitalWorker 和 Acceptance targeted required smoke 均通过。Studio 已提供 Project/Goal/WorkItem 与数字员工基础 UI；固定 Assistant/Studio 控件在真实 Electron 中以鼠标、Space/Enter、唯一 `aria-pressed`、草稿/会话/转录不变、Office/搜索往返、遮罩层和 `1320x860 / 760x700 / 360x520` 六张截图完成 `9/9`。新增 running live-switch E2E 以单一 Responses 请求验证十次 Assistant/Studio 往返、流顺序/唯一性、重复发送防绕过、运行中模型切换 fail-closed、可见 UI 拒绝和 source/build 新鲜度。Goal/WorkItem 的生产 `list/get` 已默认切到 hash-chain verified rich view；生产命令现于持有 JSON CAS 锁期间先提交 Workflow Ledger，再把 JSON 作为 Workspace 可见性目录和恢复投影落盘。新 required smoke 已证明迁移时 JSON 仍是旧态、三个强杀检查点、死进程锁即时回收、重启 CAS 修复和无重复 replay；migration/digest/entity/compare 异常继续 fail-closed，只有显式 `legacy` 读模式才回滚读取。DigitalWorker 招聘已创建 CaoGen 原生岗位实例，v2 策略 schema 显式迁移并重启恢复；Assignment 加载、策略更新、lease 和 reassign preflight 会复核数据范围，拒绝发生在 owner 写入前；终态 Acceptance 还会执行 Evidence 下限和显式用户批准。新增真实 Electron required E2E 已以 `11/11` 跨三次启动验证 RoleTemplate 招聘、完整策略录入、WorkItem Assignment、重启无重复、UI 退休、拒绝新 Assignment、历史保留和外部 Agent CLI sentinel 零调用。tool/budget/concurrency/escalation 全动作执行、其他业务入口 canonical 化、Run/Artifact linkage、TEAM-005 完整保留/导出/删除策略和 clean release evidence 仍开放。
- Workflow Acceptance repair/retest 与结构化失败接入本地基础已接通：failed review 按 Acceptance ID + revision 确定性创建同 Project/Goal/parent/owner 的 canonical repair WorkItem 及其 Acceptance；并发/重复创建幂等，绑定冲突 fail-closed，启动时恢复已提交失败但缺失的 repair。repair 未 `done` 且 Acceptance 未 `passed/waived` 前拒绝 retest；完成后原 Acceptance 清空本轮 Evidence/Verifier 并进入新的 `verifying` revision。多 criterion Acceptance 已要求每项绑定非空 Evidence 和 criterion-scoped `verifies` link；可选且不可变的 `criterionPolicies` 一旦声明就必须全量覆盖 criteria、固定 criterion ID/index，并把每项限制为指定 Workflow Evidence kind 与允许 source，Task Effect origin 或 kind/source 不匹配均 fail-closed；无 policy 的旧记录继续兼容。review/retest 保留原 policy；repair-derived Acceptance 在新建、重复恢复和启动恢复时继承同一 kind/source 约束，并将 criterion ID 重新绑定到 repair WorkItem 的确定性 criterion。对带 policy 的 Acceptance，typed cross-validation/test failure 在未显式提供 `criterionIndexes` 时必须恰好匹配一个语义兼容的 review/test criterion 才能自动绑定，零个或多个匹配均 fail-closed 且不落 Evidence。终态 canonical gate 会重新解析 live store：Workflow Evidence 必须匹配 `workflow.evidence.recorded` envelope/payload digest，Task Evidence 必须匹配 `workflow.effect.evidence` 事件及 Run/Effect source；Acceptance passed 后删除 Workflow Evidence、Task Evidence 或 Evidence Link 会在 ProjectWorkspace 源提交前 fail-closed。passed Workflow Evidence 绑定 Artifact 时，门禁还要求 Artifact digest、Evidence content digest、available 本地 path 或 `file:` URI、声明 checksum/size 与稳定读取的真实常规文件字节一致；缺失、删除、篡改、符号链接、remote-only 或任一 available 本地副本异常都会在 ProjectWorkspace 源提交前 fail-closed。受信 main-only ingress 会把 typed cross-validation/test failure 原子写成 immutable Evidence、criterion links、failed Acceptance revision 与 audit event，并恢复缺失 repair；交叉验证生产者只接受首行结构化结论，只有 `BOTH_NEED_FIX` 或在 reviewer 已给出 `CONCERNS/BLOCKED` 时的 `REVIEWER_OK` 才接入，`PASS`、畸形文本、`PRIMARY_OK`、`NEED_HUMAN` 均不接入。原生 `bash` 工具结果现携带结构化 `commandTermination` 与 `exitCode`；只有绑定当前 Session/TaskRun/ToolExecution/canonical testing WorkItem、事件与输入/输出摘要一致、显式测试命令，并同时满足 `commandTermination === 'exited'`、`isError === true`、`exitCode` 为非零安全整数的真实 `tool-result`，才会生成只含摘要与 SHA-256 的测试失败 Evidence 并进入同一 repair 路径。`timed_out`、`aborted`、`output_limit`、`spawn_error`、`not_started` 等基础设施终止不会误报 Acceptance failure；普通 turn 错误、非测试命令、缺失退出码或跨项目 Run 同样拒绝/忽略。Snapshot barrier 固定为 `capture -> flush -> persist -> delete`，flush 受 per-session failure latch 约束；启动恢复会补齐快照已提交但 ingress 或 Run 绑定未提交的状态，并在 replay conflict 时 fail-closed。ART-002 的 policy authoring UI 与 Acceptance review/evidence UI 已由真实 Electron required gate 覆盖创建、多 criterion kind/source、空 source 拒绝、按 criterion 选择匹配 Evidence、通过和重启一致性；WorkItem transition/lease 控件也由真实 Electron required gate 覆盖状态图、owner-bound lease、终态清理和重启持久化。Supervisor pause/cancel/resume/retry/reassign 已接入受信 main-process SessionManager 控制切片；该能力仍不等于完整 WORK-004/ART-004：其他工具/引擎测试生产者、自动测试编排、Studio 控制 UI、自动 repair Run、独立 Verification/不可变端到端链、repair/retest review UI、跨域 strong-kill 和 clean release-bound evidence 仍开放。
- Supervisor 的持久状态/IPC foundation 已通过 `npm run test:supervisor-state:required`：最新 core/IPC/restart/bridge 报告分别为 `test-results/supervisor-state-smoke/2026-07-22T07-08-08-366Z/report.json`、`test-results/supervisor-ipc-e2e/2026-07-22T07-08-24-606Z/report.json`、`test-results/supervisor-restart-e2e/2026-07-22T07-08-38-598Z/report.json` 与 `test-results/supervisor-taskrun-bridge-smoke/2026-07-22T07-08-40-492Z/report.json`。新增 `test-results/supervisor-session-control-smoke/2026-07-22T07-08-50-631Z/report.json` 以受控 Engine 证明 pause→resume→reassign→cancel、failed→retry→resume、同一 TaskRun 身份、控制强制 expected revision/lease ID/fencing token、stale revision 在运行时动作前拒绝、retry 缺少匹配快照时不提交/不消耗次数、failed resume 转 blocked，以及 SessionManager 重建后 paused Run 仍保持发送/自动 replay 门禁直至显式 resume。pause/cancel/reassign 的 store 与执行器动作仍不是跨文件事务；Studio UI、预算/并发 enforcement、自动编排、真实 Provider 控制 parity 和跨域强杀后 retry/reconciliation 也仍开放。因此 `RUN-004`、`WORK-004` 与 `NFR-REC-004` 仅为部分完成，`RUN-005` 仍是立项目标，不构成 release evidence。
- 统一 Learning 生命周期已覆盖自动/模型 Memory、自动 Skill review 与 `optimize_skill`：三类入口只创建 project-scoped draft，保留来源、置信度、payload digest、目标路径与完整 before/after diff；仅主进程可信用户决定可 approve/reject/revoke/rollback/delete。单调版本、expiry、重启审计、项目隔离、symlink-safe journaled Skill 物化/对账，以及仅把 approved/unexpired Memory 注入 Anthropic、OpenAI Chat/Responses prompt 均由 required gate 和完整 Deep 覆盖。该边界不等于 TEAM-007 Worker memory namespace、退休 Worker 行为、全项目 retention/export/privacy 或 clean release-bound evidence。
- 1.0 验收映射已成为机器可读门禁：`npm run test:1.0-acceptance-map` 当前对 64 个 P0 和 38 个 P1 达到 `102/102` 唯一映射并通过结构自测，Release Doctor 已消费该结果；干净基线提交 `20fab616` 的报告（`test-results/product-1.0-acceptance-map/2026-07-23T05-06-26-438Z/report.json`）显示结构通过但严格 closure 仍失败：21/64 个 P0 当前已验证、43 个仍开放，108 个声明 gate command 中 78 个已实现、64 个 requirement 具备 implemented gate、132 项 closure failure。EXP-002 已由真实 Electron 的 5/5 检查证明 Assistant/Studio 共用 canonical Project/Goal/WorkItem/Run/Artifact；PROJ-003 以 27 项检查和 `notProved=[]` 关闭 Project ownership；NFR-PRIV-004 以 13 项本地 Provider parity 与 7/7 真实 Electron 零选择门禁关闭。ART-001、RUN-002、TEAM-003 仍仅部分完成。版本号、Deep 全绿或结构映射通过均不能替代 1.0 product closure。
- ✅ **32 并发压测:修复后 7/7 error=0**(连跑 3 次稳定)。根因=瞬时并发打爆 socket 层;修:并发闸门(默认 8 在途)+ 瞬时网络重试。压力脚本口径已修(idle/error 分统计、error=0 独立断言)
- **Claude 登录不是必需项**。Claude 不再是默认引擎；未配置 Claude 兼容凭据时状态为 `unknown/optional skip`，不会被任意 Provider key 误判为 ready。只有用户显式选择 Claude 专项时才需要 `ANTHROPIC_API_KEY`、兼容网关或有效 Claude 登录态。
- P1 全部可做项收口(2026-07-06):全文搜索、冲突三栏+合并回执、插件安装/卸载/版本/权限、CLI 真验
- Work OS 第一波已进入 main:A1 Drive、A2 Quickbar、A3 Desktop Control、A4 Code Forge、A5 Skill Fabric、A6 Memory Loop、A7 Control Center、A8 Personal OS、A9 Genesis(计划层)。Genesis 只宣称编排/交付计划,不宣称真实外部子 Agent 执行、自动合并、推送或发布。
- P2 本地 smoke 已刷新全绿;P2-005 IDE integrations 已由 `test:p2-ide-build-and-vscode:required`、`test:jetbrains-recorder-e2e:required`、`test:jetbrains-ide-interaction:required` 证明。最新 `npm run test:p2-audit` 报告中 P2-002/P2-003/P2-005 为 proved;`npm run test:p2-audit -- --required` 仍会失败,但失败范围只剩非本轮公开宣称的 P2-001 Windows GUI required evidence 与 P2-004 China external evidence。最新 clean-commit Doctor 为 `test-results/workos-release-doctor/2026-07-23T06-24-24-832Z`，overall 仍为 `not_ready`：0.1.7 release identity 与 Deep 已 ready，0.1.x 不要求正式 1.0 P0 closure、真实 Provider record、N1 或七天 soak；当前开放域是 `packaging_release` 与 `release_notes`。
- 私有 Provider 配置已由 fresh required gate 实测：6 个真实目标、72/72 golden tool-call cases、`maxGap=0`，报告为 `test-results/china-tool-call-parity/2026-07-22T09-54-35-764Z/report.json`。门禁仅对 `429/5xx` 或网络异常做最多三次短退避，最终 4 个用例发生重试、72 个结果均为 HTTP 200；没有降低 parity 标准。该结果不替代 clean candidate 上包含 send/tool/artifact/recovery/usage/billing 的真实默认 Provider release record。
- 当前 Intel 主机存在 1 个有效 Developer ID Application 身份，0.1.7 release config、entitlements、Hardened Runtime 和签名配置预检通过。clean `main@cf18cd0d` 上的本地 x64 签名基线已验证 Developer ID、TeamIdentifier、45/45 Mach-O、DMG/ZIP 内签名和真实 renderer 启动；`macos-release-audit` 为 `96/102`，仅剩 app、DMG 内 app、ZIP 内 app 各自的 Gatekeeper 与 stapled ticket 共 6 项。该产物显式跳过 notarize，不是最终候选；当前进程没有完整公证凭据，历史 `2026-07-22T09-50-24-743Z` API-key 认证结果不冒充当前配置。签名审计脚本已改为读取实际 app 签名，packaged-app 临时目录退出竞态已连续 3 次通过。
- 本轮 `node scripts/secret-scan.mjs --worktree --history` 已通过，覆盖 tracked、staged、worktree 内容、敏感文件名和 Git 历史；该 dirty-worktree 结果仍不替代精确 clean release commit、干净工作树 Deep 和 packaging 发布门禁。
- GitHub Releases 公开资产审计继续要求名称、大小、状态、SHA256 与 `latest*.yml` 文本全部可读;若发布后的远端 read-text 审计超时或失败,只保留本地校验结论,不得宣称公开文本资产已完成扫描。
- v0.1.6 最终发布说明保存在 `docs/RELEASE-NOTES-FINAL.md`,列出精确 5 资产及 SHA256,并作为 GitHub Release 正文。
- Packaging gate 的 v0.1.6 macOS x64 DMG/zip、两个 blockmap 与 `latest-mac.yml` 资产集 SHA256 为 `5ba568959b4973c7fa07a138ff80d1767be8945a9a76d155487b1d6556dc677b`。macOS 包仍未签名,Release notes 保留首次打开说明。
- v0.1.6 打包启动回归发现并修复 `tree-sitter` 运行时缺少 `node-gyp-build` 的主进程崩溃:`node-gyp-build` 已提升为应用直接依赖,`release-packaging-audit` 会解析 `app.asar` 并阻止缺失运行时文件的包通过,`test:packaged-app:mac` 会从全新用户目录启动成品并要求出现真实 `CaoGen` renderer。修复后的 macOS x64 `.app` 已通过该启动测试;仍未签名/公证。
- 项目级规则口径更新:`caogen.md/.caogen.md/README.md` 向 Claude Agent SDK 与 OpenAI-compatible 两条已验证路径注入项目身份与规则;原生 Anthropic Messages 的项目规则注入 parity 仍需独立门禁。未配置规则的新项目也会注入项目身份和缺失规则提示;设置页项目规则已提供结构化编辑器,可同步编辑项目提示词、背景、技术栈、常用命令、测试/构建命令、禁止目录、隔离策略、模型调度策略、项目记忆与历史决策;`caogen.md` 的模型调度策略会进入智能路由理由。由 `node scripts/context-loader-smoke.mjs`、`npm run test:project-rules-ui`、`node scripts/model-router-smoke.mjs` 覆盖;其中 context/model-router smoke 已验证不同项目的 prompt 与模型调度策略互不串用,同一请求会按各自项目规则路由到不同 Provider/模型;Electron 页面流 `npm run test:page` 也已验证当前项目规则可在设置页编辑并保存到项目 `caogen.md`,且不修改全局 `settings.json`(17/17,`test-results/caogen-deep/2026-07-10T12-48-21-376Z/page-operation-smoke.json`)。
- 多厂商配置口径更新:Provider 已支持多 API Key、活动 key 选择、行内连通性检测、模型列表同步和持久化健康状态。E1 Provider Credential Broker 基础已接入:安全 `safeStorage` 后端写入 `enc:`,不可用、`basic_text` 或加密失败时新 Key 仅保留在当前进程内存,持久化快照不会写入明文、`b64:` 或 session-only 引用;旧 `b64:` 只读兼容,安全存储可用时自动迁移,否则 UI 明确标记待迁移。Provider 文件采用同目录临时文件、fsync、原子 rename 和 POSIX `0600`;自定义请求头仅允许标准/路由元数据 allowlist,未知头、畸形行和已知凭据格式的值会被拒绝,历史值会从运行态/Renderer 移除并要求重新配置;Base URL 禁止 userinfo、查询参数和片段;非标准鉴权只允许明确支持的头名,值由 Broker 使用当前活动 Key 注入 OpenAI、Claude SDK、DAG、原生 Anthropic 和模型发现请求。活动 key 遇到鉴权、403、限流或余额/配额错误时,会先切到同 Provider 内未禁用、未处于 5 分钟失败冷却且本轮未尝试的备用 key;OpenAI 与原生 Anthropic 请求直接重试,SDK Agent 重建子进程并 resume 当前上下文;备用 key 池耗尽后才进入各引擎允许的 Provider failover。模型侧 MCP 已移除 `env/headers` 参数与任意 Claude Desktop 导入路径，stdio/client probe 使用最小基础环境，但 Claude SDK/CLI 的完整进程环境与原生 MCP 自动发现尚未闭环，因此仍不宣称全子进程最小环境。`npm run test:provider-keys`、`npm run typecheck`、`npm run build`、`npm run secret:scan` 和最新 Electron 页面流 22/22 已通过;最新完整 Deep 为 `156 total / 153 required pass / 3 optional skip / 0 blocked / 0 fail`（`test-results/caogen-deep/2026-07-23T05-54-33-895Z/deep-test-report.md`；报告绑定 `cf18cd0d` 且开始和结束均为 clean）。当前只宣称 Provider Broker 基础,不宣称完整 project/session/operation/expiry 作用域、完整子进程最小环境、凭据迁移 crash fault injection、全出口 secret canary、主动额度探测或按 key 权重负载均衡已完成。
- 产品定位门禁新增: `npm run test:product-positioning:required` 会扫描 README、欢迎页入口文案、Release notes、Release gate 和公开品牌入口,防止公开文案重新出现固定未来版本目标、外部产品名称/对比话术、开发者-only 定位、未验证的中转站/Office 版式过度宣称,以及旧的菱形占位 logo。最新通过报告见 `test-results/product-positioning-audit/latest.json`;v0.1.5 release doctor 已在 release commit `d9969e3` 上绑定版本、当前 commit 与干净工作树并达到 `status: ready`。
- 自动调度口径更新:设置页已支持按顺序执行的用户自定义调度规则,可组合关键词任一/全部、请求推断任务类型、最低风险和当前有效策略,命中后优先路由到指定 Provider/模型;未配置的条件不限制,条件组之间取 AND,任务类型组内取 OR。旧关键词规则无需迁移;规则目标仍受硬预算和 Provider 健康约束。项目级模型调度策略可覆盖默认角色偏好且保持项目隔离,OpenAI 引擎自动路由也已纳入月度剩余预算。智能路由现读取持久化 Provider 健康状态:存在健康候选时会跳过连续失败 Provider;若全部候选均不健康则继续给出可执行候选,同时把警告写入调度日志,避免静默停摆。每次路由会生成结构化决策日志,保留厂商、模型、有效策略、任务类型、风险、候选数、可靠性、成本估算、剩余预算、规则命中、预算降级、跨厂商状态、健康过滤、靠前备选和警告;渲染层不再丢失 `providerId`,聊天消息可展开查看详情,3D 办公选中 Agent 面板同步显示真实厂商/模型与选择依据。控制中心现接入共享预算报告:活跃会话与当月历史按 `id/sdkSessionId` 去重,显示月度已用/剩余/进度、活跃与历史成本、Provider 成本聚合和最高成本会话;活跃会话预算按“会话显式上限 > Provider 单会话上限 > 全局单会话上限”生效,月度或任一活跃会话超额都会进入告警状态。历史记录未保存当时的显式会话预算,因此不会伪造历史预算比例。Electron 页面流已验证用户可在设置页启用智能混合调度,配置模型角色,新增结构化“发布审查”规则并把关键词关系、成本策略、高风险门槛和审查任务类型保存到 `settings.json`(17/17,`test-results/caogen-deep/2026-07-10T12-48-21-376Z/page-operation-smoke.json`)。`npm run test:failover-target` 已验证主 Provider 失败后优先命中配置的备用 Provider/模型、不健康备用目标会被跳过、仅配置备用模型时能找到声明该模型的 Provider、OpenAI 与 SDK AgentSession 两条 failover 路径都会更新固定模型,并且 UI 会显示可读的切换原因与重试目标(最新报告 `test-results/failover-target/latest.json`)。由 `npm run test:model-router`、`npm run test:routing-visibility`、`npm run test:provider-health-history`、`npm run test:budget-report`、`node scripts/control-center-smoke.mjs`、`npm run test:failover-target`、`npm run typecheck`、`npm run build`、主集成 33/33 与扩展集成 7/7 覆盖;预算报告见 `test-results/budget-report/latest.json`。当前不宣称自然语言策略编排器、按 key 额度调度、跨月精确成本账本或长期趋势分析。
- 自动调度第五阶段最新闭环:均衡、成本优先、质量优先和速度优先已成为四个独立策略;速度优先先按延迟档排序,同档再参考历史延迟 EMA,专项测试证明它与质量优先会对同一复杂任务选择不同模型。策略优先级为“项目规则 > Core 用户策略 > 专用工作模式预设”;项目 `caogen.md` 的“速度优先”不会再折叠为均衡,Core 不再覆盖用户策略,专用模式仍保留自己的预设。设置页已真实保存 `schedulerStrategy: speed` 和自定义规则 `whenStrategy: speed`;聊天详情、控制中心和 3D 办公选中 Agent 面板均显示有效策略及延迟依据。当前完整深测口径为 `156 total / 153 required pass / 3 optional skip / 0 blocked / 0 fail`。当前仍不宣称自然语言策略编排器、按 key 额度调度、跨月精确成本账本或长期趋势分析。
- macOS 顶部菜单栏图标已与 Dock/应用图标分离:菜单栏使用 18×18 / 36×36 Retina 的透明单色 `trayTemplate` 轮廓并启用 Electron Template 模式,可随 macOS 深浅色菜单栏自动着色;Dock、窗口、应用内品牌与安装包继续使用正式全彩人物 Logo。`npm run test:macos-tray-icon` 已验证 PNG 尺寸/透明通道、打包资源声明、Electron `nativeImage` 加载、Template 标志和真实 Tray bounds(`test-results/macos-tray-icon/latest.json`)。
- 文件预览口径更新:HTML/Markdown/Text/CSV/JSON/图片/PDF 已有真实预览;PDF 已接入文本层 best-effort 提取并可发给 Agent;`.docx/.xlsx/.pptx` 已接入 OOXML 文本与结构提取。macOS 通过独立 Quick Look IPC 生成完整系统文档预览包,HTML/CSS/JS/图片附件全部内联,CSP 禁止网络,renderer iframe 仅开放 sandbox 脚本;完整预览失败时回退首屏 PNG,再失败则保留结构视图。结构视图已支持 Word 显式分页、Excel 工作表和 PowerPoint 幻灯片的上一项/下一项/选择器导航,可把当前页/表单独发给 Agent,批注会保存页码、摘录和结构选择器。`npm run test:office-visual-preview` 已用真实 DOCX 验证 625×980 系统文档预览、缓存、路径边界和附件/外链封锁(`test-results/office-visual-preview/latest.json`);`npm run test:page` 已验证完整 iframe、结构导航、当前单元发送和定位批注(17/17,`test-results/caogen-deep/2026-07-10T12-48-21-376Z/page-operation-smoke.json`)。发送给 Agent 的仍只有提取文本、元数据和批注,视觉 data URL 不会进入提示词。系统渲染可能与原应用中的完整原版式存在差异;编辑、复杂公式、动画和像素级一致性仍未完成,不得宣称。
- 3D 办公口径更新:Office model 已从真实 `SessionState` 派生路由决策、Provider/密钥故障切换、预算/成本、最近耗时、审批、工具、子任务、worktree 隔离/分支/状态与 checkpoint 文件变化;同 Provider 密钥接管会进入选中 Agent 信号栈并点亮工位故障恢复指示,只显示 key 标签。OfficeView 打开时会对可见会话按需刷新 `git status`,并把分支、dirty 文件数、staged/unstaged/untracked、错误状态汇入顶部指标、选中 Agent 面板和工位低位 3D 指示条。设施区离席 Agent 点击验证改为真实 canvas 投影路径扫描,不会直接调用 React/store 状态;最终实现已由两次连续单跑和完整 Deep 内的 orchestration E2E 连续 3 次通过,并覆盖工位、审批 Agent、设施 Agent 与会话打开链路(`test-results/caogen-deep/2026-07-19T16-02-28-655Z/deep-test-report.md`)。由 `npm run test:office-status-recheck`、`npm run test:provider-key-failover` 覆盖;Electron 页面流 `npm run test:page` 也已验证真实会话/worktree/Git 状态、可点击工位和非空 3D canvas。当前不宣称全量实时 git diff 轮询、完整项目交付驾驶舱、长期趋势图或可替代发布管理系统。
- 3D 办公性能口径更新:Office chunk 会在应用首帧后预取,进入 Office 后按 Boot → procedural Low → 选中 Agent Full 分阶段挂载;12 Agent 场景保持 `1 Full + 11 Low`,未选中 Agent 的 Low 不加载 GLB/Draco。历史基准（干净提交 `488caaa5`）记录过 14 项 required 检查及 macOS x64 12 Agent Auto 冷路径 shell/Canvas `26.6ms`、可交互 `170.9ms`、Low `350.0ms`、后台 Full `1310.5ms`;该历史 report 未随当前 checkout 保留。2026-07-18 当前 dirty-worktree 重跑写入 `test-results/office-performance/2026-07-18T09-13-54-270Z/report.md`，因 Electron page target not found 未形成通过证据；因此这些历史毫秒数和当前失败都不替代目标机器上的可复验 release gate。
- Assistant/Studio 性能口径更新:`NFR-PERF-001` 已由 `npm run test:assistant-studio-performance:required` 在参考设备 `MacBookPro16,1`（Intel i9-9980HK、32 GiB、macOS 26.5.2、Electron 40.10.2）完成三次 fresh-process Electron 测量，覆盖 `1320x860 / 760x700 / 360x520`。cold shell 共 3 个样本、P95 `33.5ms`，warm 共 60 个样本、P95 `34.1ms`；门禁终点是 Studio 首次可见、可聚焦、中心 hit-test 无遮罩且本地控件可操作，并在 Project 数据仍为 busy 时真实完成 Studio 内部视图往返。三种视口的 Project/Goal/WorkItem 完整 hydration 从 cold 点击起分别为 `1478.6ms / 1184.7ms / 1425.0ms`，仅作为独立诊断，不宣称小于 300ms。测量期间本地 Provider 响应保持挂起且不再发送数据，每个视口始终只有一个 Session、一个 canonical Run、一个模型请求，runtime/Run ID 与 `initCount` 不变；新版 `mobile-warm-final.png` 还确认 360px 下项目选择、新建/刷新、编辑、关联资源、归档、导出和删除操作不再重叠。证据见 `test-results/assistant-studio-performance/2026-07-22T14-12-03-432Z/report.json`。
- 五支柱当前判断:多厂商、调度和 3D 已形成可用优势;迁移级工作流与长期自主执行仍受真人 N1、跨 Provider 账本、后台持续运行和交付证据约束。当前没有统一评分工件,不再给出百分比。
- 用户实测反馈已修 4 项(冗余"你"标注、矛盾错误文案、引擎×Provider 404、填 key 不生效)

# Current Focus

**当前唯一焦点是 M1：发布已签名、可安装、诚实标注边界的 v0.1.7 楔子版。** M1-T1/T2/T5 与 clean Deep 已关闭；Intel x64 本地签名基线已把缺口压缩到公证 ticket/Gatekeeper。下一顺序是在最终 clean commit 注入公证凭据后重建 x64 并完成 notarize/staple/required audit，同时在 Apple Silicon 与 Windows x64 机器补齐对应平台签名、安装和启动证据，最后完成 Release Notes final gate。M1-M3 期间冻结新的 1.0 愿景功能；64 个 P0 仍为 21 已验证、43 开放，不因发布 0.1.7 而改变。

# Goal

**北极星 N1**:真实重度 AI 工作者 **30 分钟内**跑通日常主链路(导入资产→建会话→@文件/资料→执行任务→审结果→提交/交付),资产零丢失。以五支柱代差做成"世界第一 / 中国首创"验收方向的多厂商 AI 工作桌面。

# Next Milestone

**v0.1.7 签名楔子版** — Definition of Done:

1. 最终候选提交 worktree clean，`package.json` 与 lock 根版本均为 `0.1.7`
2. `test:deep` 在该精确提交上 required 全绿；optional skip 保持显式，不算 pass
3. macOS x64/arm64 与 Windows x64 候选资产完成目标平台签名；macOS 完成 notarize、staple、Gatekeeper 和 packaged-app 启动审计
4. Release Notes 只写当前已验证能力，`test:release-notes-audit:final` 绑定实际上传资产通过
5. GitHub Release 与官网只提供已审计资产；不创建 1.0 stable、N1、真实 Provider 或中国外部网络未验证声明

# Priority Tasks

**P0**
- 用户反馈快修循环(常设)
- v0.1.7 签名楔子版:在最终 clean commit 上完成 Deep、macOS x64/arm64 与 Windows x64 打包签名、macOS 公证/staple/启动审计和 Release Notes final gate
- ~~arm64 / universal 打包~~ ✅ 已发布至 v0.1.1
- P0-1B:~~接入 `search_replace`、OpenAI `edit_file` 与 Claude `Edit` 的 queryable file Effect~~ ✅;~~E2A 接入 Renderer worktree patch、独立 push→PR 与 Agent `git_create_pr`~~ ✅;~~E2B-1 接入 Renderer 文件保存/commit并阻止复合 Code Forge commit/pr~~ ✅;~~E2B-2 接入 Renderer stage/stageAll/unstage/accept hunk 的精确 Index CAS~~ ✅;~~E2B-3 接入 discard hunk 独立文件 Target 与强杀对账~~ ✅;~~DAG autoMerge patch Effects 与 completion/finalizer durable outbox/receipt 接入并确认~~ ✅;~~managed-worktree create/remove 生命周期 Effect~~ ✅;继续补齐 Issue、消息、可查询 MCP 与 Code Forge patch
- P0-1C:TaskRun Effect evidence v6 foundation、v8 Workflow Ledger、canonical recovery sessions、`legacy / compare / canonical` 恢复读源和可逆 migration/continuity 门禁已完成 targeted smoke；Goal/WorkItem/Artifact/Acceptance 基础和有限 IPC/UI/cursor 查询已落地，未显式配置时仍默认 legacy；下一步是全入口接入、完整 Artifact Graph/blob/sourceRef 生命周期、Canonical Conversation Ledger、保留/导出/修复和生产补偿计划/审批/执行
- P0-2A:把 GUI/工具临时授权绑定 app/window/action/path/diff/postcondition,统一设置页与运行时的实际沙箱状态
- ~~P0-4A:把深测改为 `pass / skip / blocked / fail` 四态,required 项不得以 skip 通过~~ ✅
- ~~P0-2A:移除新 Provider Key 的 `b64:` 写入 fallback,建立进程内 session-only 降级、旧数据安全迁移和 Provider Broker 基础~~ ✅
- P0-2B:完成 provider/project/session/operation/expiry 作用域、子进程最小环境、全出口 secret canary 与数据保留/导出/删除策略
- P0-3:建立 MCP/插件 Capability Manifest、固定版本/digest、最小环境和恶意 fixture 隔离门禁
- 凭据安全:所有疑似泄漏或曾经外发/公开上传的个人/仓库 token 必须在对应平台轮换或撤销;仓库和 GitHub Releases 内不得保存真实密钥、webhook、证书、keystore、provision profile、签名材料或本地证据包

**历史交付批次 P1**(2026-07-06 收口:3/3 保留项完成;不同于竞品差距文档的新 P1 路线)
- ~~插件治理下半场:安装 / 卸载 / 版本 / 权限声明~~ ✅(本地安装+回收站卸载+
  路径牢笼,7 断言冒烟;版本锁定降级为版本展示,市场分发本版不做)
- ~~会话全文搜索(U5.1)~~ ✅(侧栏消息内容命中直达会话)
- ~~worktree 冲突三栏 + 合并回执~~ ✅(三栏对照+patchSha256 回执)

**历史交付批次 P2**(2026-07-06 推进:3/5 已推送;不同于竞品差距文档的新 P2 路线)
- ~~聊天头工具栏图标化(U3.3)~~ ✅ 8 按钮→图标+⋯更多下拉;page-smoke 按 aria-label 适配全绿
- ~~chat 历史自动压缩~~ ✅ 超 48k token 摘要旧段,不切断 tool_call 配对(e2e 4/4)
- ~~Responses 协议接工具循环~~ ✅ 官方 OpenAI 模型也成真编码 Agent(e2e 5/5)
- ~~路由能力表自学习~~ ✅ 按实测成败/延迟给同档模型打平降权(集成 T17 验证)
- N1 迁移实测:向导映射✅、演练 fixture+计时脚本✅(docs/N1-MIGRATION-DRILL.md);真人 30 分钟计时仍未做，formal 1.0 stable 的 N1 硬门禁仍开放

**Work OS Phase 2 并行任务**(2026-07-08 新排期)
- B0 Release Gate:保持 README/STATUS/release notes 与真实 gate 一致,审计公开 GitHub Release 资产,最后合并;草稿门禁见 `docs/RELEASE-GATE-DRAFT.md`
- B1 Windows GUI Required:P2-001 strict VS Code GUI/cross-app/input evidence,由专门 Windows agent 后续补
- B2 IDE Build + VS Code Host:✅ P2-005 插件构建、VS Code extension host evidence 已通过
- B3 JetBrains Real IDE:✅ P2-005 JetBrains runIde recorder + interaction evidence 已通过
- B4 China External Evidence:6 Provider tool-call parity 已 72/72、`maxGap=0`；P2-004 的独立 China real-network evidence 与发布范围声明仍需按门禁处理

# Blockers

**本地发布门禁与外部条件:**

| 阻碍 | 等级 | 状态 |
|---|---|---|
| ~~32 并发压测 5/6~~ | High | ✅ 已修:并发闸门(8 在途)+ 瞬时重试;连跑 3 次 7/7 error=0 |
| ~~最新 dist:mac 卡 Electron 下载~~ | Medium | ✅ 已修:.npmrc 配 npmmirror;双架构 DMG 完整产出 |
| ~~Claude auth 误判~~ | High | ✅ 已修:auth 检测只认真实凭据;无凭据干净跳过/明确提示 |
| ~~窄屏响应式布局未过人眼复核~~ | Medium | ✅ 已修:同日 responsive smoke 覆盖桌面/窄屏暗色与浅色主题及水平溢出;证据:`test-results/caogen-responsive/2026-07-06T10-08-05-301Z/responsive-light-smoke.json` |
| arm64 包真机启动 | — | 需真实 Apple Silicon 机器(Intel 不可替代) |
| Docker | — | 不需要；产品运行模式、资源和分支已删除 |
| Claude 登录 | — | 不需要；只影响用户显式选择的 Claude 专项 |

**外部与人工发布门禁:**

| 阻碍 | 等什么 |
|---|---|
| Apple Developer / 签名材料 | Developer ID 已在本机完成 x64 本地签名；当前进程未配置公证凭据，需注入完整 API key、Apple ID 或 Keychain Profile 后在最终 clean candidate 执行 notarize、staple 与审计 |
| Apple Silicon 真机 | 只有要宣称 arm64 真机启动时需要；Intel 机器不能替代 |
| 指定 Provider key / 额度 | 6 Provider tool-call parity 已 72/72；formal 1.0 仍需在最终 clean candidate 上生成真实默认 OpenAI-compatible release record，覆盖 send/tool/artifact/recovery/usage/billing |
| 凭据轮换 | 曾暴露或疑似外发的 token 必须由凭据持有人在对应平台撤销/重建 |
| N1 30 分钟计时 | formal 1.0 stable 硬门禁；需真人按秒表跑并留证 |
| 后续版本 push / GitHub Release | 每次仍需在精确 release commit 上通过发布门禁并获得用户授权 |

# Decisions

不会改变的原则:

1. **实测才算完成**:每个特性配真实 E2E(真进程/真 IPC/真模型调用),"编译过"不算数;状态如实标注,不虚标
2. **六环链路**:新能力必须主进程 → IPC → preload → types → store → UI 全通才算接通
3. **不搬同类工具代码**:只借鉴信息架构与交互,纯自实现
4. **安全边界**:新密钥不得以明文或可逆编码持久化且不出主进程;旧可逆记录必须迁移或要求重新输入;文件工具路径牢笼;权限审批不可绕过(bypass 需显式选择);发布物不含任何凭据
5. **中英双语**:所有 UI 文案 zh/en 齐备,zh 为母语级
6. **每任务独立提交**,提交信息写"做了什么 + 怎么验证"
7. **诚实降级**:能力不可用时如实报告(如 OCR 无引擎、PR 无 gh/glab),绝不伪造结果

# Out of Scope

当前滚动发布周期明确不做:

- 云端 Routines / 云端 Runner(本地定时任务已有)
- App Store 上架(走 GitHub Releases 分发)
- Windows x64 已在 v0.1.5 发布,但可见桌面最终截图受锁屏条件限制;后续 Windows 版本仍需真实 Windows 回归后再发布。Linux 打包配置存在但未完成发布验证,不承诺
- 移动端、自研/微调模型
- 插件市场(安装/治理做,"市场"不做)
- 写实游戏级 3D 自由漫游

# Risks

1. **零外部用户数据**:所有"可用"结论出自 E2E 与自测,N1 从未真人验证 —— 最大未知
2. **分发摩擦**:0.1.7 Intel x64 本地签名基线已通过，但它显式跳过公证且不是最终提交绑定资产；正式发布仍缺最终 clean artifact 的 notarize、staple、Gatekeeper、Apple Silicon arm64 与 Windows x64 证据
3. **外部凭据轮换状态不可由仓库验证**:疑似外泄 token 必须由持有人在对应平台撤销/重建;仓库只保留占位符、环境变量名和脱敏状态
4. **长会话膨胀**:~~chat 历史无压缩~~ 已加自动摘要压缩(超 48k token);OpenAI 引擎工具声明每请求固定开销仍在

# Success Criteria

- **下一次发布验收** = Release Gate Draft 中的阻塞项全部成立;P2-001/P2-004 按当前 macOS 窄发布边界不阻塞，N1 对 formal 1.0 stable 是硬门禁
- **长期成功** = 北极星 N1 由**非项目相关**的真实同类工具深度用户验证通过(30 分钟计时 + 资产零丢失 + 关键动作无需回退原工具)
