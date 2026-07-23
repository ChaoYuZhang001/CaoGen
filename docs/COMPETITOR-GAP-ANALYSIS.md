# CaoGen 竞品差距与优化优先级

> 快照日期: 2026-07-11
> E1 凭据状态补记: 2026-07-17（未重新联网刷新竞品事实）
> C1 证据边界: 下文标注为历史快照的数字只记录当时的仓库状态；当前仓库最新 dirty-worktree Deep（2026-07-20）为 `123 total / 120 required pass / 3 optional skip / 0 blocked / 0 fail`（`test-results/caogen-deep/2026-07-20T14-04-52-427Z/deep-test-report.md`），独立 Electron 页面流为 `22/22 pass`（`test-results/caogen-deep/2026-07-20T14-22-20-382Z/page-operation-smoke.json`）。三个 optional 分别是 Claude real e2e、China real-network 和 China tool-call parity，不能算 pass；Release Doctor 仍为 `not_ready`（`test-results/workos-release-doctor/2026-07-19T16-29-57-170Z/report.md`），开放域仅为 release identity、clean-commit Deep、packaging 和 release notes。本地 unsigned macOS x64 资产审计与真实 packaged-app 启动已通过，但未绑定 clean release commit，因此上述结果不能替代 clean release candidate gate。
> CaoGen 功能代码基线: 本地 `main`（未推送远端）
> 核心对标: Codex Desktop / CLI、Claude Desktop / Code、Cursor / Windsurf
> 扩展参照: OpenClaw、Hermes Agent，以及 Devin / OpenHands 类长任务交付
> Cursor / Windsurf 仅采用仓库内迁移目标，本轮未联网刷新其最新版本，不把映射写成最新竞品事实。
> 结论口径: 竞品事实只采用官方文档、官方仓库或当前 Codex Desktop 可调用能力; CaoGen 事实只采用当前代码和测试产物。

## 结论

CaoGen 当前的主要问题不是功能少，而是已有能力还没有形成与功能规模匹配的信任平面。

CaoGen 已经具备真实差异化:

- 多 Provider、多 API Key、健康度、预算、路由解释和跨厂商故障切换。
- 真实 child session、DAG、worktree 隔离、自动合并和恢复快照。
- `write_file`、`search_replace`、普通 `edit_file` 与 Git commit/merge/push 已进入可恢复 Effect 路径；文件编辑具备内容与 inode CAS、本地写入后置校验和 Effect 执行边界强杀恢复证据。
- Git、Diff、终端、文件、浏览器、Office 预览和 3D 办公状态统一在一个桌面工作台。
- 任务事件身份、恢复游标、SQLite 快照和强杀恢复已经明显强于普通聊天桌面壳。

但以下五项会直接阻止 CaoGen 成为可信赖的长期 Agent Desktop:

1. Effect Ledger 核心已经落地，自动 Reconciler 已覆盖主要文件编辑、Git commit/merge/push、Renderer 文件保存/commit、Git stage/stageAll/unstage/accept hunk、文本 hunk 丢弃、managed-worktree create/remove/patch、DAG autoMerge 和 GitHub/GitLab PR/MR；Issue、消息、可查询 MCP、Code Forge patch、补偿执行和防篡改 evidence 链仍未闭环。
2. Docker 产品模式已删除，历史 strict 设置会进入 fail-closed 确认态；Claude SDK 自动放行、原生设置 hooks/statusLine、Git filter 和 ripgrep config 旁路已封。新 Provider Key 的可逆 Base64 fallback 也已移除；剩余问题是 GUI 五分钟授权仍对所有 GUI 工具全局生效，Credential Broker 尚未完成 project/session/operation/expiry 作用域。
3. MCP 模型入口已拒绝 `env/headers/configPath`，导入结果已脱敏，stdio/probe 已使用最小环境；剩余缺口是内置模板仍使用未锁版本的 `npx -y`，插件安装缺少来源、哈希、签名、能力清单和受管运行时隔离。
4. 本地 Deep 已完成 `pass / skip / blocked / fail` 四态；**历史快照（2026-07-17）**为 `92 total / 89 required pass / 3 optional skip / 0 blocked / 0 fail`。当前最新 dirty-worktree Deep 为 `123 total / 120 required pass / 3 optional skip / 0 blocked / 0 fail`（详见 `test-results/caogen-deep/2026-07-20T14-04-52-427Z/deep-test-report.md`），独立 Electron 页面流为 `22/22 pass`（`test-results/caogen-deep/2026-07-20T14-22-20-382Z/page-operation-smoke.json`）；Claude real e2e、China real-network 和 China tool-call parity 仍是 optional skip，不能算 pass。本地 unsigned macOS x64 资产审计和真实 packaged-app 启动已通过，但没有 clean-commit 绑定、签名、公证、SBOM、provenance、安装升级和失败回滚证据；Release Doctor 仍为 `not_ready`（`test-results/workos-release-doctor/2026-07-19T16-29-57-170Z/report.md`），开放域仅为 release identity、clean-commit Deep、packaging 和 release notes。
5. OpenAI Responses 的 `lastResponseId` 只在内存中，重启、换 Provider 或换 Key 会丢失服务端上下文链，尚无 Provider 无关的会话账本。

因此下一阶段不应继续追求更多可见功能。正确顺序是:

```text
扩展剩余 Effect / evidence / compensation
  -> 收紧审批作用域、凭据与插件/MCP 隔离
  -> 保持四态 required gate 与恶意配置回归
  -> 托管 CI、签名、SBOM 与回滚
  -> Provider 无关上下文与可检查恢复时间线
  -> Desktop observe-act-verify
  -> Memory/Skill 治理与 Team/Supervisor 控制面
```

总体判断信心: 高。竞品快速变化或官方材料内部冲突的地方已单独标注。

## 继续优化问题清单

| 优先级 | 问题 | 仓库证据 | 竞品基线 | 用户价值 | 完成判据 |
|---|---|---|---|---|---|
| P0-1B/C | 剩余外部副作用、evidence 与补偿未闭环 | `effect-reconciler.ts` 已覆盖主要文件编辑和 Git commit/merge/push，其他工具仍进入 `unsupported/opaque`；`TaskRecoveryModal.tsx` 主要提供目标、错误和人工确认 | Codex/Claude 已提供线程恢复、审批、checkpoint 与 PR/CI 工作流；CaoGen 应在“外部成功但本地未知”上形成领先能力 | 崩溃或断网后不会重复发 PR、消息、Issue 或复合交付动作 | 所有高风险入口经过 Effect Runtime；外部成功后强杀不重放；evidence 为 append-only 可验证链；补偿需审批且失败时 fail closed |
| P0-2 | 审批作用域与本地执行真相仍不完整 | Docker 产品模式已删除，历史 strict 设置 fail-closed；Claude/OpenAI 双闸门与 Git/rg 配置旁路已补 required smoke。`permission-manager.ts` 的五分钟 GUI grant 仍对所有 GUI 工具生效 | Codex sandbox/approval/Guardian 与 Claude permissions/OS sandbox 都把能力边界作为一等产品面 | 用户能准确知道“允许了什么、对哪个目标、持续多久” | 授权绑定 app/window/action/path/diff/postcondition，可随时撤销；UI、运行时和审计使用同一能力状态 |
| P0-3 | 凭据与 MCP/插件供应链隔离不足 | Provider 新 Key 已不再写 `b64:`；MCP 模型入口已移除 `env/headers/configPath`，导入结果脱敏，stdio/probe 使用最小环境；Broker 仍无完整作用域，安装仍缺来源、digest、签名和 capability diff | Claude Managed MCP/MCPB 强调受管配置；Codex 对 Skill/Hook 有启用与信任状态 | 一个插件或 MCP 出问题时，不会带走全部密钥、环境变量和项目数据 | safeStorage 不可用时不持久化新密钥；恶意 fixture 读不到未声明文件、环境或凭据；安装和内容变化都展示 provenance、digest 与 capability diff 并重新审批 |
| P0-4 | 四态本地门禁已完成，发布证据链仍缺 | `deep-test.mjs` 已区分 `pass/skip/blocked/fail`，required skip/blocked 会阻断；仍无 hosted CI、签名、SBOM/provenance、升级和回滚证据 | Claude 有 GitHub Actions/Code Review 交付面；成熟竞品用 CI、签名和制品证明建立发布信任 | 用户看到“通过”时可确信真实环境已验证，安装包可追溯、可升级、可回滚 | PR/main/release 有托管矩阵；每个制品绑定源码 SHA、哈希、签名、SBOM、provenance 与干净机安装/升级/回滚记录 |
| P0-5 | 恢复界面和会话账本不够可检查、不可跨 Provider | v8 已为 Task Snapshot/TaskRun 提供按数据库路径隔离的 `legacy / compare / canonical` 恢复读源、canonical recovery sessions、mode flip 复验和 committed identity/high-water continuity；但 `TaskRecoveryModal.tsx` 仍未展示 causation、lease、generation、evidence 和完整状态时间线，`openaiEngine.ts` 的 `lastResponseId` 仍只在内存中 | Codex 支持 thread resume/fork/list/goals；Claude checkpoint 明确展示恢复能力与边界 | 重启、换模型或换 Provider 后，用户仍能解释任务做过什么、为什么停在这里 | 在 v8 recovery cutover 基础上建立 Canonical Conversation Ledger；跨 Provider 恢复保持 tool-call 配对、附件和已确认 Effect；UI 展示 append-only 事件/effect 时间线和可恢复边界 |
| P1-10 | Desktop 自动化缺 observe-act-verify | `gui-tools.ts` 的 click/type/scroll/hotkey 返回即时执行结果，没有自动观察后置状态；GUI 工具仍是 opaque Effect | 桌面自动化的有效基线是“观察 → 操作 → 验证”；当前仓库只有动作回执，没有后置状态证据 | 减少“点了但没生效”“输入到了错误窗口”这类假成功 | 每个动作可声明 postcondition；执行后自动截图/读取可访问性状态并断言；失败可恢复；权限绑定具体 app/window；Windows/macOS 真实 E2E 进入 required gate |
| P1-11 | Existing-file writer 不是 crash-atomic | `search-replace.ts` 与本地 writer 仍原地 `truncate/write`；CAS 可拒绝漂移目标，但写入中强杀、断电或 ENOSPC 可能留下空文件或半文件 | 可信编辑器应把一次已批准写入收敛为完整 pre-state 或完整 expected-state，而不是中间字节状态 | 避免恢复后源码损坏、构建失败或用户只能手工找回内容 | 进程在 truncate 后任意点强杀或注入 ENOSPC，重启后目标只能是完整 pre-state 或 expected-state；硬链接语义、备份恢复与原子替换边界有明确测试 |
| P1-7 | Memory 与 Skill 自动学习缺统一治理 | `memory_add` 直接写入确认层；启用自动 Skill review 后，校验通过会直接写可执行 `SKILL.md` | Codex 的 Skill 启用与 Hook trust 强调显式信任；Claude 的受管扩展也强调策略边界 | 错误经验或提示注入不会静默变成长期记忆和可执行规则 | 所有自动学习先进入 draft，附来源、置信度、diff 和影响范围；人工批准后生效；支持版本、回滚、过期和按项目导出/删除 |
| P1-2/3/8 | 多会话已有执行能力，但缺 Team/Supervisor/交付控制面 | DAG 支持 33 tasks、重试、超时、worktree 和 auto-merge；`TaskDagGraph.tsx` 只展示状态、尝试、依赖、结果和 merge，缺 owner/lease/budget/permission/pause/cancel/artifact | Codex multi-agent + durable thread/goal，Claude Subagents/Agent View/Teams + PR/CI/Code Review 已形成可管理工作面 | 用户可管理长时间并行工作，而不是只能观看 Agent 自己跑 | 明确 `Subtask/Durable Session/Team/Deterministic Workflow`；每个 lane 展示 owner、lease、预算、权限、验证和交付物；可 pause/cancel/resume；PR/CI/review/artifact 状态统一 |
| P2-6 | Cursor/Windsurf 迁移价值缺真人证据，工具暴露仍可继续收敛 | `DESIGN-V2.md` 只有仓库定义的迁移矩阵；N1 fixture/计时脚本已准备，但没有非项目用户实测 | 仅把 Cursor/Windsurf 作为 IDE 内上下文、编辑、Diff、终端和 review 闭环的迁移目标，不宣称其当前版本事实 | 降低现有 IDE Agent 用户切换成本，避免工具过多挤占上下文 | 非项目相关重度用户在 30 分钟内完成主链路，资产零丢失并记录回退次数；大型插件集只渐进披露当前任务所需工具 |

## 产品类别校正

这些产品不能只按“有没有某个按钮”比较。

| 产品 | 实际产品形态 | 最值得对标的部分 | 不能直接类比的部分 |
|---|---|---|---|
| Codex Desktop | 软件工程 Agent Desktop，连接本地、worktree 和托管任务能力 | 多 Agent、线程/目标持久化、浏览器/Computer Use、插件与连接器、审批治理 | OpenAI 官方手册本次抓取被 403 阻断；部分结论来自同日官方源码和当前安装环境，不能外推到所有账号 |
| Claude Desktop / Code | `Chat + Cowork + Code` 桌面工作面，Code 另含本地/云端/SSH、worktree、PR/CI | MCPB、权限与 OS 沙箱、Subagent/Agent View、Checkpoint、桌面 PR 生命周期 | Agent Teams 仍是实验能力；桌面计算机操作的可用范围需以当前官方文档和账号权限为准 |
| Cursor / Windsurf | IDE 内 Agent 与代码交付工作流，本轮只作为迁移参照 | 编辑器内上下文、文件编辑、Diff、终端、review 的短路径闭环 | 未联网刷新最新公开能力；只使用 `DESIGN-V2.md` 的仓库定义目标，不作为外部事实依据 |
| OpenClaw | 本地常驻 Gateway + Agent runtime + 多渠道/多设备，Desktop 是控制和设备伴侣层 | Task Flow、长期自动化、Gateway/UI 解耦、插件供应链、跨平台发布 | 不是纯软件工程 Desktop；默认 sandbox 为 off，不支持敌对多租户 |
| Hermes Agent | 开源单租户 Agent 平台，含 Electron Desktop、TUI、Web、Gateway、Cron、Kanban | SQLite durable Kanban、工具搜索、Skills/MCP、远程 backend、Agent 运维面 | Kanban 明确是单机；默认本地 backend 和进程内插件不是强隔离 |
| CaoGen | 多厂商 AI 工作桌面，面向工程、文件、浏览器、Office、自动化和多 Agent | Provider 开放性、路由与成本透明、工作台统一、3D 状态可视化 | 安全、供应链、持续交付和长期任务证据尚未达到功能广度 |

## 当前能力矩阵

| 维度 | CaoGen 当前状态 | 竞品基线 | 判断 |
|---|---|---|---|
| Agent 执行内核 | Claude Agent SDK + OpenAI-compatible API；Effect Ledger、资源级 lease/fencing、强杀恢复、主要文件编辑与 Git commit/merge/push Reconciler 已接 | Codex/Claude 有成熟线程与后台会话；OpenClaw Task Flow、Hermes Kanban 有持久状态机 | 内部恢复和有限外部对账较强；仍缺完整副作用覆盖、补偿和统一 Supervisor |
| 多 Agent | 33 child sessions、DAG、worktree、结果回传、自动合并 | Codex multi-agent 已标 stable；Claude 有 Subagent/Agent View/实验 Teams；OpenClaw/Hermes 有隔离 Agent | 强项；下一步应区分临时子任务、持久会话、Team 和确定性 Workflow |
| Provider 开放性 | 多厂商、多 Key、健康度、预算、跨厂商 failover | 竞品通常围绕自家模型或单一 Gateway | CaoGen 领先，但上下文和成本账本仍不够耐久 |
| 权限治理 | 风险分类、审批模式、资源级副作用门禁、文件边界、GUI 权限检查、审计 metadata/hash 和权限输入脱敏已接 | Claude 有宿主权限 + OS sandbox；Codex 有 sandbox/approval/Guardian；OpenClaw/Hermes 提供策略但默认姿态不总是安全 | 中等；缺凭证代理、统一保留策略和更强 OS 隔离 |
| MCP / 插件 / Skills | 扫描、启停、安装、调用、Slash 入口已接 | 竞品已进入 manifest、精确版本、来源、digest、权限预览、组织策略和市场治理 | 明显落后在供应链信任，不是落后在“能不能装” |
| 记忆与自动化 | 分层记忆、建议、Routine scheduler、run history 已接 | OpenClaw/Hermes 长期自动化更完整；Codex/Claude 有后台/计划任务 | 功能可用，但生命周期分散，关闭桌面后的远程续跑未闭环 |
| 桌面工作台 | Git、Diff、终端、文件、浏览器、Office、3D、控制中心 | Codex/Claude/Hermes 的 Agent 树、Artifacts、PR/CI 状态更一体化 | CaoGen 表面广度强，交付控制面仍弱 |
| 恢复与 Checkpoint | 事件回执、游标、快照、文件/聊天回退、worktree | Claude 自动 checkpoint；Hermes shadow-git；OpenClaw/Hermes durable task | 内部恢复强；外部系统和跨 Provider 恢复弱 |
| 可观测性 | 路由、Provider/Key、成本、预算、工具、审批、worktree、3D 状态 | OpenClaw audit、Hermes Command Center、Codex/Claude 任务/Agent 面板 | CaoGen 强项；应把可观测数据升级为可执行控制面 |
| 持续交付 | 本地测试和发布审计脚本很多 | OpenClaw 有跨 OS、安装/升级、签名、公证、SBOM/provenance；Hermes 有较强 CI 和 Sigstore 发布 | CaoGen 明显落后，当前是最高风险之一 |
| 工程可维护性 | 核心热点文件继续膨胀 | 成熟项目通常按协议、状态、平台和 UI 边界拆分 | 已成为安全审计和交付速度阻碍 |

## CaoGen 已验证事实

以下是当前可依赖的实现，不应在后续重构中回退:

- `src/main/engine.ts` 和 `src/main/engines.ts` 已固定两条正式运行时路径。Codex CLI / Gemini CLI Adapter 已移除，不再作为未来方向。
- `src/main/task/task-recovery.ts`、`src/main/task/task-snapshot.ts` 和 `src/main/task/task-runtime-registry.ts` 已形成事件回执、恢复游标、快照和幂等防重底座。
- `task-snapshots.db` v8 已增加 canonical recovery sessions 和持久 `workflow_store_identity`；Task Snapshot/TaskRun 恢复读取支持按数据库路径隔离的 `legacy / compare / canonical` 三态，compare 漂移 fail-closed，mode flip 强制复验，committed journal 校验 store identity 与历史高水位。未配置时仍默认 legacy；这不等于跨 Provider 的 Canonical Conversation Ledger、全入口 canonical workflow 或完整 Artifact 生命周期。
- `src/main/task/effect-ledger.ts`、`effect-runtime.ts` 和 `effect-reconciler.ts` 已形成持久 EffectRecord、资源级 lease/fencing、字段级并发合并、自动/人工对账和 fail-closed 恢复底座。
- `write_file`、`search_replace`、OpenAI `edit_file`、Claude 原生 `Edit`、`git_commit`、`git_merge`、`git_push`、Agent 原生 `git_stage` / `git_stage_all` 和 Renderer Git stage/stageAll/unstage/accept hunk 已有只读 Reconciler；`search_replace dry_run=true` 不建立 Effect，Claude `MultiEdit/NotebookEdit` 仍为 opaque；Git Index 操作使用临时 Index/ODB 冻结 exact bytes 与 entries digest，通过真实 `index.lock` 和 HEAD/Index CAS 发布，并隔离 hooks/filter/父进程 Git 环境；`git_merge` 固化 repo/ref/source SHA 与文件系统身份，在隔离 ODB 预检，并用 trusted reference-transaction hook 原子校验 old SHA、exact parents 和 expected tree。
- Code Forge 动作面已收敛到 `report` / `patch`；内嵌 shell 与复合 commit/PR 请求 fail closed，`patch` 的专用可查询 Effect 仍是后续工作。
- `src/main/sessionManager.ts` 与 `src/main/agent/dag-scheduler.ts` 已支持真实 child session、DAG 和 worktree 编排。
- `src/main/providers.ts`、`src/main/providerKeyRouting.ts` 和 `src/main/model/session-routing.ts` 已支持 Provider/Key 选择、健康、预算和故障切换。
- `src/main/permission/tool-permission.ts`、`src/main/permission/audit-log.ts` 和沙箱相关模块已形成权限治理基础；审计输入默认保存 metadata/hash，权限卡展示完整但递归脱敏的审批输入。
- `src/main/skill`、`src/main/mcp`、`src/main/pluginInstall.ts` 已形成扩展生态底座。
- `src/renderer/src/components/office` 已消费真实会话、审批、工具、路由、成本、worktree 和 checkpoint 状态。
- **历史 Deep 快照（2026-07-17）**为 `92 total / 89 required pass / 3 optional skip / 0 blocked / 0 fail`（不可变报告: `test-results/caogen-deep/2026-07-17T15-15-55-522Z/deep-test-report.md`）。当前最新 dirty-worktree Deep 为 `123 total / 120 required pass / 3 optional skip / 0 blocked / 0 fail`（`test-results/caogen-deep/2026-07-20T14-04-52-427Z/deep-test-report.md`；滚动入口: `test-results/caogen-deep/latest.md`），独立 Electron 页面流为 `22/22 pass`（`test-results/caogen-deep/2026-07-20T14-22-20-382Z/page-operation-smoke.json`）。Claude real e2e、China real-network 和 China tool-call parity 保留为 optional skip，不能算真实外部环境通过；Release Doctor 仍为 `not_ready`（`test-results/workos-release-doctor/2026-07-19T16-29-57-170Z/report.md`），开放域仅为 release identity、clean-commit Deep、packaging 和 release notes，DAG finalization 与 P2 release scope 已为 ready。本地 unsigned macOS x64 资产审计和真实 packaged-app 启动已通过，但 packaging_release 仍因未绑定 clean release commit 而 open。

## P0: 必须先解决

### P0-1 外部副作用对账内核（核心 MVP 已完成，Epic 部分完成）

已完成:

- 持久 `EffectRecord` 已包含 `effectKey`、独立 `resourceKey`、generation/revision、lease、fencing token、状态、目标摘要和 evidence digest。
- SQLite barrier 会跨会话阻止同一资源的并发 lease，并持久化每个资源的最大 fencing token。
- `write_file`、`search_replace`、OpenAI `edit_file`、Claude 原生 `Edit`、`git_commit`、`git_merge`、`git_push` 已支持只读回读；不可查询操作在结果未知时 fail closed 并进入人工 CAS 处置。
- 文件编辑 planner 与执行器共享冻结结果，保留原始字节/BOM，并用 root/file device+inode、内容摘要和预期摘要判断三态；同一路径或同一 inode 的硬链接别名不能并发获得 lease。
- OpenAI 文件编辑的本地 writer 执行 identity/hash CAS；absent 写入还绑定审批时 root/parent 身份并用 hardlink 原子发布，再复验原路径身份和内容。
- `git_merge` 已冻结目标 ref、审批前 HEAD/tree、来源 ref/SHA 和 repo/common-dir/worktree-dir 身份；执行时只合并冻结 SHA，拒绝目录身份漂移、隐藏 index 状态、ignored/local path 覆盖和不安全 merge/filter 配置。
- merge-tree 只在临时 ODB 中运行；真实 ref transaction 会在 prepared 阶段验证 old SHA、两父节点和 expected tree，失败后保持目标 ref、index 与 worktree 不变。
- OpenAI-compatible 与 Claude SDK 两条正式工具执行路径均接入 prepare → persist barrier → execute → reconcile。
- 强杀、关闭、中断、普通事件与 Effect 并发写、目标漂移、路径替换、FIFO、超限 fail-closed、BOM、同内容换 inode、硬链接冲突、Claude prepared 恢复和空 staged commit 已有回归测试。
- UI 会显示 `waiting_reconciliation`，阻止自动恢复、继续发送和删除恢复入口。

继续问题:

- Issue、消息、可查询 MCP 和 Code Forge patch 尚无专用 Reconciler 或未统一经过 Effect Runtime。
- Existing-file writer 仍原地 `truncate/write`，不具备 writer 内部 crash-atomic；当前强杀 E2E 证明的是 Effect 执行边界恢复，不能证明写入中断后文件一定完整。
- Claude `MultiEdit/NotebookEdit` 尚无可信 planner；Claude AgentSession 的真实外部 `Edit` 全链仍缺有条件环境集成测试，不能把 mock/模块 smoke 写成真实外部执行证明。
- `markEffectCompensated` 只有账本状态能力，没有生产级补偿计划、审批和执行器。
- evidence digest 尚未形成 append-only 哈希链、独立 Effect 表或审计事件关联，不能宣称防篡改不可变账本。
- Effect Runtime 强杀 E2E 已覆盖文件写入、`search_replace/edit_file` 三态和 effect-bound `git_merge`；Git commit/push、PR、消息、MCP，以及 OpenAIEngine/Claude AgentSession 的完整工具链仍需独立系统测试。

竞品信号:

- OpenClaw Task Flow 和 Hermes Kanban 都有 revision、重试、heartbeat 和 durable event，但官方材料同样没有证明它们能通用处理外部 `unknown_outcome`。
- Claude checkpoint 明确不覆盖 Bash、外部系统和并发会话。

这不是追平项，而是 CaoGen 可以建立领先优势的内核项。

下一纵切要求:

- 把所有高风险入口统一接入 Effect Runtime，下一纵切继续完成 Issue、消息、可查询 MCP 和 Code Forge patch。
- 建立独立 Effect 持久表、append-only evidence 链和审计事件 ID，避免 evidence 只存在 TaskRun JSON 中。
- 定义补偿动作的生成、审批、执行、失败恢复和二次补偿边界。
- 对每类可查询副作用补真实强杀 E2E；无外部回读能力的操作继续禁止自动重试。

验收标准:

- 在外部成功、内部 `tool-result` 落盘前强杀进程，重启后能自动确认成功且不重复执行。
- 同一 `resourceKey` 同时只能有一个有效 lease，跨进程 fencing token 单调递增。
- 每次确认、重试、补偿都有可验证的 append-only evidence 和审计关联。
- UI 明确展示 `waiting_reconciliation`，不能把它渲染成失败或成功。

建议验证:

```bash
npm run test:task-run
node scripts/effect-reconciliation-smoke.mjs
node scripts/effect-crash-recovery-e2e.mjs
node scripts/effect-close-race-smoke.mjs
```

Owner: Runtime / Task Kernel。

### P0-2 凭据、审批、沙箱与本地数据安全

当前问题:

- 新 Provider Key 的 `b64:` 写入 fallback 已移除；安全存储不可用时只保留主进程 session-only Key。历史 `b64:` 仍需完成真实迁移演练，Broker 仍缺 project/session/operation/expiry 作用域。
- 审计日志已经停止保存 command/content/JSON 原文，改为 metadata、长度和 SHA-256；权限卡也会完整展示但递归脱敏输入。该纵切仍未覆盖所有日志、转录、插件和 MCP 数据出口。
- GUI 五分钟临时授权只记录到期时间，对所有 GUI 工具全局放行，没有绑定 app、window、action 或 postcondition。
- Docker 产品模式和旧降级开关已删除；历史 strict 用户进入 `disabled` 确认态。剩余工作是把这一能力状态与 GUI 临时授权、凭据和数据保留统一到同一控制面。
- `providers.json`、会话转录、记忆、Routine、审计和插件配置缺少统一的保留、权限和加密策略。

实现要求:

- 已实现 `safeStorage` 不可用时不持久化新密钥，并提供仅本次运行状态；后续补完整作用域、恢复引导和企业凭据后端。
- 迁移并删除现有 `b64:` 密钥，迁移失败时要求用户重新输入。
- 把现有审计 metadata/hash 规则抽成统一数据分类与递归脱敏组件，覆盖日志、转录、插件、MCP 和错误回传。
- MCP/工具凭据通过 scoped broker 注入，避免把主进程完整环境传给子进程。
- 把审批授权绑定到 capability、资源、目标应用/窗口、动作、diff/postcondition 和到期时间，并支持即时撤销。
- UI 必须展示实际采用的 sandbox mode、是否降级及原因；设置文案不能承诺运行时默认不会发生的行为。
- 为会话、记忆、Routine 和审计定义保留周期、导出和删除策略。

验收标准:

- 生产写入路径和新产生的运行数据中不存在可逆编码密钥；旧数据与测试迁移 fixture 只作为只读输入存在。
- 包含 `Authorization`、API Key、JWT、cookie、密码和私钥片段的输入不会出现在审计日志。
- 渲染层、插件和 MCP 只能获得声明过的凭据范围。
- GUI 临时授权不能跨 app/window/action 复用；严格沙箱未运行时不得显示为已隔离。
- 权限不足或安全存储不可用时 fail closed，并给出可恢复提示。

建议验证:

```bash
npm run secret:scan
npm run secret:scan:history
node scripts/credential-storage-smoke.mjs
node scripts/audit-redaction-smoke.mjs
```

Owner: Security / Runtime。

### P0-3 MCP、插件与 Skill 供应链

当前问题:

- MCP stdio/probe 已使用最小环境，模型入口也已禁止直接提供 `env/headers/configPath`；尚未完成 digest-bound trust、Capability Manifest、scoped credential broker 和受管隔离 Runner。
- 内置 MCP 模板使用未锁版本的 `npx -y`。
- `src/main/pluginInstall.ts` 只检查目录形状、大小和路径，没有来源、digest、签名、依赖、能力或兼容性验证。
- 插件、Skill、MCP 和 Hooks 尚未形成一致的信任模型。

竞品基线:

- Claude MCPB 显示权限和配置，敏感值进入系统凭据存储；组织策略可按精确 URL 或完整命令 allow/deny。
- Codex 官方 app-server 对 Hook 记录 `currentHash` 和 `trustStatus`，只有受信任的非托管 Hook 才能运行。
- OpenClaw 使用 manifest、JSON Schema、capability contracts、版本和 digest；Hermes 支持 MCP 白/黑名单、OAuth、mTLS 和动态能力刷新。

实现要求:

- 统一 `CapabilityManifest`: 文件、进程、网络域、凭据、MCP 工具、Hook 事件、GUI 和数据保留范围。
- 本地包记录来源、精确版本、content digest、许可证、SBOM 和兼容版本。
- 远程目录与本地侧载分轨；默认禁止未知侧载，更新前展示权限 diff。
- MCP 使用最小环境变量、独立工作目录、网络 allowlist 和进程/容器隔离。
- 不允许 `npx -y package` 无版本运行；首次安装和升级必须固定版本及 digest。

验收标准:

- 未声明能力的插件/MCP 访问文件、网络或凭据会被阻止。
- 包内容或 manifest 改变后信任状态失效，必须重新批准。
- 安装、升级、禁用和卸载均留下来源和哈希可审计记录。
- 恶意插件 fixture 不能读取无关环境变量或越过工作区。

建议验证:

```bash
node scripts/plugin-provenance-smoke.mjs
node scripts/mcp-env-isolation-smoke.mjs
node scripts/plugin-capability-sandbox-e2e.mjs
```

Owner: Security / Ecosystem。

### P0-4 真实测试状态与持续交付

已完成:

- `scripts/deep-test.mjs` 已采用结构化 `pass / skip / blocked / fail` 协议；required skip/blocked 会阻断，进程崩溃和信号终止仍为 fail。
- China required 缺目标/凭据/合法阈值会报告 blocked；真实请求或断言失败才报告 fail。

当前问题:

- 当前没有 `.github/workflows` 托管门禁。
- `package.json` 的 macOS `identity` 为 `null`。
- 没有统一的安装、升级、回滚、SBOM、provenance、attestation 和发布后启动验证。

竞品基线:

- OpenClaw 官方 CI 覆盖跨 OS、安装包验收、升级存活、签名、公证、校验和以及 Docker SBOM/provenance/attestation。
- Hermes 有分区测试、Desktop build、Docker 多架构、OSV、供应链扫描和 OIDC + Sigstore 发布，但其 Desktop 打包矩阵仍不完整。
- Claude 有 GitHub Action、托管 Code Review 和桌面 PR/CI 流程，但托管 Review 仍是 best-effort。

实现要求:

- 保持四态协议、required 清单和 partial-config 回归为发布门禁，新增外部脚本不得只靠退出码表达状态。
- 新增 Linux/Windows/macOS CI，缓存不能改变测试语义。
- macOS 签名、公证，Windows 签名；生成 SPDX/CycloneDX SBOM 和构建 provenance。
- 对全新安装、旧版升级、失败回滚、自动更新源和包内架构做真实验证。
- 发布必须绑定源码 SHA、依赖锁、测试报告、签名、制品哈希和回滚版本。

验收标准:

- `SKIP` 不再出现在 pass 计数中；required check 为 skip/blocked 时发布必须失败。
- PR 和 main 都执行最小确定性门禁；release tag 执行完整跨平台门禁。
- 已签名安装包可在干净机器安装、启动、升级和回滚。
- 每个公开制品有 SHA256、SBOM、provenance 和签名验证记录。

建议验证:

```bash
npm run test:deep
npm run test:release-packaging-audit:required
npm run test:github-release-audit:required
npm run workos:release-doctor -- --refresh
```

Owner: Platform / Release。

### P0-5 Provider 无关的会话与 Checkpoint 账本

当前问题:

- `src/main/openaiEngine.ts` 的 `lastResponseId` 只在内存中。
- 跨 Provider 或跨 Key failover 会清空 response id，然后重新发本轮请求。
- Responses 服务端状态、Chat 本地历史和 Claude SDK session/checkpoint 仍是三套语义。

实现要求:

- 建立 Canonical Conversation Ledger，持久化 user/assistant/tool-call/tool-result、附件引用、模型路由、checkpoint 和上下文压缩边界。
- Provider 的 response/session id 只是可丢失优化，不能成为唯一上下文来源。
- 重启、跨 Provider 和跨协议时从 Canonical Ledger 重建合法输入，保持 tool-call 配对和附件引用。
- Checkpoint 必须同时说明代码、对话、外部效果和 worktree 的恢复范围。

验收标准:

- Responses 会话在进程重启后继续，不丢已确认工具结果。
- 从 OpenAI-compatible Provider 切换到另一 Provider 后，任务语义和工具状态连续。
- 回退前 UI 显示将恢复/保留/无法撤销的范围。
- Canonical Ledger 可重放生成确定性的上下文摘要和验证证据。

建议验证:

```bash
node scripts/conversation-ledger-smoke.mjs
node scripts/provider-cross-resume-e2e.mjs
node scripts/checkpoint-effect-boundary-smoke.mjs
```

Owner: Runtime / Session。

## P1: P0 稳定后推进

| ID | 问题 | 优化方向 | 验收标准 | Owner |
|---|---|---|---|---|
| P1-1 | Genesis 仍只生成计划 | 把 Genesis 升级为权限门控的执行协议，复用 DAG、worktree、预算、验证和 Code Forge | 每个 lane 有 owner、lease、权限、预算、验证和交付状态；高风险点必须确认 | Orchestration |
| P1-2 | Agent 原语过于统一 | 明确定义 `Subtask / Durable Session / Team / Deterministic Workflow` 四类生命周期 | UI、恢复、消息、预算和隔离规则不再依赖隐含约定 | Runtime |
| P1-3 | Routine、后台任务和任务恢复分散 | 建立统一 Supervisor，支持本地常驻、远程 runner、断线重连和关闭桌面后续跑 | 同一任务可跨 Desktop 重启或远程 worker 继续，状态无缺口 | Runtime / Cloud |
| P1-4 | Project 数据分散 | 统一代码、知识、记忆、任务、连接器、Artifact、预算和审计的 Project Workspace | 导入、导出、删除和权限都以项目为边界 | Product / Data |
| P1-5 | 路由仍依赖结构化规则 | 增加自然语言策略编译、按 Key 配额/权重、跨月精确成本账本和趋势 | 路由决策可重放，账单能与 Provider 对账 | Model Routing |
| P1-6 | 工具 schema 可能挤占上下文 | 增加 Tool Search、capability catalog、动态能力刷新和渐进披露 | 大型插件集下只暴露当前任务需要的工具 | Ecosystem |
| P1-7 | 记忆/Skill 自动变化治理不足 | 所有自动学习先进入暂存，附来源、置信度、diff、审批和撤销 | 未批准变更不能成为稳定规则或执行代码 | Memory / Security |
| P1-8 | 桌面交付状态不完整 | 把 Diff 评论、Artifact、验证、CI、PR、review、merge 和 release 状态接入统一控制面 | 用户不离开 CaoGen 即可判断是否可交付 | Desktop / Delivery |
| P1-9 | 架构热点阻碍迭代 | 拆分 `store.ts`、`sessionManager.ts`、`ipc.ts` 和 shared types | 严格标准审计通过，新增功能不再进入超大聚合文件 | Architecture |
| P1-10 | GUI 动作只有执行回执，没有 observe-act-verify | 为 click/type/scroll/hotkey 增加 app/window 作用域、postcondition、执行后截图/可访问性断言和恢复策略 | 假成功率可度量下降，真实 Windows/macOS required E2E 覆盖主链路 | Desktop Automation |
| P1-11 | Existing-file writer 非 crash-atomic | 用原子替换、写前日志或可验证恢复协议消除 truncate/write 中间态，并明确硬链接策略 | 强杀/ENOSPC 后只能恢复为完整 pre-state 或 expected-state | Runtime / Files |

## P2: 差异化扩张

| ID | 优化方向 | 边界 |
|---|---|---|
| P2-1 | 3D 办公性能、镜头、资产和状态交互继续优化 | 只消费真实状态；P0 未完成前不再把视觉精修当主线 |
| P2-2 | Office 文档高保真、编辑、公式、动画和协作批注 | 必须继续区分结构预览、系统渲染和原应用像素级一致性 |
| P2-3 | 跨设备、移动节点、语音、Canvas 和多渠道入口 | 这是 OpenClaw 类扩张面，不是当前 Codex Desktop 对标阻塞项 |
| P2-4 | 公共插件市场、评分、共享和组织目录 | 先完成供应链与隔离，再扩大数量 |
| P2-5 | 跨主机 worker 和分布式 lease | 目标是超越 Hermes 单机 Kanban，而不是先复制其全部 UI |
| P2-6 | Cursor/Windsurf 迁移实测、Tool Search 和长期用户研究 | 只用仓库迁移目标，不宣称未核验竞品事实；必须用真人计时、录屏、失败点、工具暴露量和回退次数作为证据 |

## 推荐实施顺序

| 批次 | 范围 | 估算 | 完成判据 |
|---|---|---:|---|
| A0 今晚真相收口 | 删除 Docker 产品依赖；Claude 改为可选；Deep 四态；封 Claude/Git/rg 旁路；整理状态和排期 | 已完成 | 历史里程碑快照为 `87 / 84 pass / 3 optional skip / 0 blocked / 0 fail`；不代表当前 Deep 或当前工作树洁净度 |
| A1 Trust Kernel | 剩余 Reconciler、append-only evidence、补偿执行、crash-atomic writer、GUI capability 授权 | 6-10 agent-days | 强杀、重复执行、目标漂移和补偿失败全部 fail closed，所有高风险入口进 required gate |
| A2 安全与插件/MCP 隔离 | Provider Base64 新写 fallback 与 MCP stdio/probe 最小环境已完成；继续 scoped credential broker、Capability Manifest、版本/digest、managed runner 和恶意 fixture | 6-10 agent-days | 插件/MCP 不能读取未声明文件、环境或凭据；内容变化会失去信任并重新审批 |
| A3 发布链 | Hosted CI、签名/公证、SBOM、provenance、安装/升级/回滚、发布后审计 | 4-7 agent-days + 外部等待 | 每个制品绑定源码 SHA、测试报告、签名、哈希、SBOM 和干净机证据 |
| A4 持久会话账本 | Canonical Conversation Ledger、跨 Provider resume、可检查 checkpoint/effect 时间线 | 5-8 agent-days | 重启、换 Provider/Key 后保持 tool-call 配对、附件和已确认 Effect 连续 |
| A5 Agent Control Plane | 四类 Agent 原语、Supervisor、pause/cancel/resume、observe-act-verify、PR/CI/Artifact 控制面、Genesis 执行化 | 15-25 agent-days | 长任务可恢复、可审批、可验证、可交付，不依赖桌面 UI 进程一直存活 |
| A6 差异化滚动 | 3D 性能、Office 高保真、跨设备、市场、跨主机 worker、真人迁移研究 | 15-30 agent-days | 只消费真实状态；每项有用户证据和独立发布边界，不挤占 P0/P1 |

总量约 `51-90 agent-days`。按 Runtime/Security、Release/Data、Desktop/Product 三路并行，日历时间约 `5-9 周`；外部签名、机器、Provider 审核或真人排期可能额外延长。估算信心: 中等。

## 用户参与边界

| 项目 | 是否必须 | 说明 |
|---|---|---|
| Docker | 否 | 产品模式、资源和运行分支已删除，不需要安装或启动 Docker |
| Claude 登录 | 否 | 默认 OpenAI-compatible 路径、本地启动和发布门禁都不依赖 Claude；只有显式选择 Claude 专项时需要兼容凭据 |
| Apple Developer / 签名材料 | 条件必须 | 仅签名、公证和正式分发需要，必须由账号持有人提供或操作 |
| Apple Silicon 真机 | 条件必须 | 只有要宣称 arm64 真机启动时需要，Intel 机器不能替代 |
| Provider key / 额度 | 条件必须 | 只有要补对应真实 Provider、中国网络或 tool-call parity 证据时需要 |
| 凭据轮换 | 必须由用户做 | 仓库只能清理和扫描；撤销、重建真实 token 必须由凭据持有人在平台操作 |
| N1 真人计时 | 仅阻塞 N1 宣称 | 不阻塞无 N1 宣称的本地版本或普通发布 |
| push / Release | 需要最终授权 | 本轮只合入本地 `main`，不自动推送或发布 |

## 明确不做

- 不重新引入 Codex CLI Adapter 或 Gemini CLI Adapter。相关产品只作为迁移资产来源和能力参考。
- 不复制竞品代码、品牌、界面或不可验证的营销声明。
- 不把 Hook、Prompt 或模型自律当作权限和沙箱的替代品。
- 不把退出码 0 的 skip 当成通过。
- 不在没有签名、安装、升级和回滚证据时宣称“可发布”。
- 不在没有外部回读证据时宣称 exactly-once。
- 不让 3D 视觉精修继续挤占内核安全、恢复和交付优先级。

## 官方来源

### Codex

- [OpenAI Codex official repository](https://github.com/openai/codex/tree/6138909d6ec58b2fbe635ef973e02caecad5a5aa)
- [Codex Desktop entry in official README](https://github.com/openai/codex/blob/6138909d6ec58b2fbe635ef973e02caecad5a5aa/README.md#L1-L8)
- [Feature stages: multi-agent, apps, plugins, browser, computer use, goals and approvals](https://github.com/openai/codex/blob/6138909d6ec58b2fbe635ef973e02caecad5a5aa/codex-rs/features/src/lib.rs#L1031-L1269)
- [Thread resume, fork, list, goals and archive protocol](https://github.com/openai/codex/blob/6138909d6ec58b2fbe635ef973e02caecad5a5aa/codex-rs/app-server/README.md#L333-L648)
- [Skill enablement and Hook trust model](https://github.com/openai/codex/blob/6138909d6ec58b2fbe635ef973e02caecad5a5aa/codex-rs/app-server/README.md#L1691-L1725)

说明: `developers.openai.com/codex/codex-manual.md` 在本次核验中返回 HTTP 403，当前会话已配置的 OpenAI docs MCP 也未暴露为可调用工具。因此未用缓存或第三方摘要替代；补充采用同日官方仓库和当前 Codex Desktop 实际工具面。公开可用性仍以 OpenAI 正式文档和账号权限为准。

### Claude

- [Claude Desktop application](https://code.claude.com/docs/en/desktop)
- [Desktop scheduled tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks)
- [MCP Bundles](https://claude.com/docs/connectors/building/mcpb)
- [Managed MCP](https://code.claude.com/docs/en/managed-mcp)
- [Subagents](https://code.claude.com/docs/en/sub-agents)
- [Agent View](https://code.claude.com/docs/en/agent-view)
- [Agent Teams](https://code.claude.com/docs/en/agent-teams)
- [Permissions](https://code.claude.com/docs/en/permissions)
- [Sandboxing](https://code.claude.com/docs/en/sandboxing)
- [Checkpointing](https://code.claude.com/docs/en/checkpointing)
- [Hooks](https://code.claude.com/docs/en/hooks)
- [GitHub Actions](https://code.claude.com/docs/en/github-actions)
- [Code Review](https://code.claude.com/docs/en/code-review)

### Cursor / Windsurf 迁移参照

- 仓库定义目标: `DESIGN-V2.md` 的迁移矩阵与 IDE 内主链路要求。
- 本轮未联网刷新 Cursor / Windsurf 官方材料；相关内容只作为待验证的迁移假设，信心为中等，不能作为当前竞品功能事实。

### OpenClaw

- [Official repository](https://github.com/openclaw/openclaw)
- [Architecture](https://docs.openclaw.ai/concepts/architecture)
- [Background Tasks](https://docs.openclaw.ai/automation/tasks)
- [Task Flow](https://docs.openclaw.ai/automation/taskflow)
- [Multi-Agent](https://docs.openclaw.ai/concepts/multi-agent)
- [Memory](https://docs.openclaw.ai/concepts/memory)
- [Plugin Manifest](https://docs.openclaw.ai/plugins/manifest)
- [Security](https://docs.openclaw.ai/gateway/security)
- [Sandboxing](https://docs.openclaw.ai/gateway/sandboxing)
- [CI Pipeline](https://docs.openclaw.ai/ci)
- [Full Release Validation](https://docs.openclaw.ai/reference/full-release-validation)

### Hermes Agent

- [Official repository](https://github.com/NousResearch/hermes-agent/tree/8727e6729512ef6415768e1980b1aadc19084abe)
- [Desktop architecture](https://hermes-agent.nousresearch.com/docs/user-guide/desktop)
- [Agent loop](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop)
- [Durable Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban)
- [Delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation)
- [Cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)
- [MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)
- [Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
- [Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- [Security Policy](https://github.com/NousResearch/hermes-agent/blob/8727e6729512ef6415768e1980b1aadc19084abe/SECURITY.md)
- [CI Orchestrator](https://github.com/NousResearch/hermes-agent/blob/8727e6729512ef6415768e1980b1aadc19084abe/.github/workflows/ci.yml)

Hermes 官方材料存在 Linux Desktop 支持和版本号漂移，相关结论信心为中等；其 Kanban、Agent loop 和安全边界结论信心为高。
