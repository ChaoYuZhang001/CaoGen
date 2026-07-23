# CaoGen 产品技术要求

> 文档状态：立项技术基线
>
> 事实基线：`main@21051cab` 是文档起点；当前实现与证据以 `STATUS.md` 2026-07-18 和最新 targeted artifacts 为准
>
> 上位需求：[`PROJECT-CHARTER.md`](./PROJECT-CHARTER.md) · [`PRODUCT-REQUIREMENTS.md`](./PRODUCT-REQUIREMENTS.md)
>
> 配套设计：[`HIGH-LEVEL-DESIGN.md`](./HIGH-LEVEL-DESIGN.md) · [`SECURITY-AND-RISK.md`](./SECURITY-AND-RISK.md)
>
> 适用范围：CaoGen Desktop、CaoGen Native Runtime、协议 Adapter、任务与交付内核、Assistant/Studio 两种工作台、3D 办公状态投影

## 1. 文档目的

本文定义 CaoGen 从当前多厂商 AI 工作桌面演进为目标驱动 Agent Work OS 所需的产品技术要求。本文不是当前功能宣传页，也不以规划替代实现证据。

本文使用以下强度词：

- **必须（MUST）**：进入对应里程碑或发布范围前不可缺少。
- **应该（SHOULD）**：默认应满足；偏离时必须留下书面原因和替代验证。
- **可以（MAY）**：不影响主链路的可选能力。

## 2. 统一状态口径

所有能力、界面文案、路线图和发布说明必须使用下列状态之一。

| 状态 | 定义 | 可对外表达 |
|---|---|---|
| **当前已验证** | 当前主分支已有实现，并存在本地 smoke、E2E、构建、发布或真实环境证据 | 可以说明成立条件和证据范围 |
| **部分完成** | 已有可复验的技术切片，但仍缺少完整边界、统一入口、恢复场景或发布绑定 | 只能说明已验证切片，并列出未覆盖边界 |
| **条件可用** | 已有实现，但依赖账号、Key、平台、外部 CLI、真实网络、签名材料或特定硬件 | 必须同时说明条件和未验证项 |
| **立项目标** | 本项目正式要求，尚未完整实现 | 只能表述为目标、要求或迁移方向 |
| **后续规划** | 不进入首个目标版本，保留接口或方向 | 不得写入当前版本承诺 |
| **明确不做** | 与 CaoGen 产品边界冲突，或当前周期主动排除 | 不进入架构核心和默认体验 |

状态不得通过营销文案、演示动画或静态计划报告隐式升级。

## 3. 产品定义

### 3.1 产品使命

CaoGen 是本地优先、多厂商、可恢复、可审计的目标执行系统。用户管理目标、边界、预算、审批和验收；CaoGen 管理模型算力、任务拆解、工具执行、上下文、恢复、验证和交付。

### 3.2 核心原则

1. **CaoGen 自己持有执行内核。** Provider、模型、Key 和协议只构成一次 `ModelAttempt`，不构成用户管理的顶层 Agent。
2. **不以厂商为角色。** “调研、策划、造物、校阅、验证、运营”等岗位属于 CaoGen；Claude、OpenAI、DeepSeek、Kimi、Qwen 等只提供底层算力。
3. **一个目标只有一条事实链。** 模型切换、应用重启、任务恢复和界面模式切换不得制造新的目标、上下文断层或重复副作用。
4. **验证优先于生成。** 没有证据、测试或人工验收的结果不得自动标记为完成。
5. **失败必须可见。** Provider 错误、产品错误、权限等待、用户中断和未知副作用是不同状态，不得互相掩盖。
6. **普通用户默认不管理算力。** Assistant 隐藏 Provider、模型、Token、DAG 和终端；Studio 提供可展开控制面，但默认仍为自动路由。

### 3.3 产品工作台

| 工作台 | 用户范围 | 默认信息密度 | 技术边界 |
|---|---|---|---|
| **Assistant** | 企业白领、学生、老师、普通用户，以及希望专注结果的技术用户 | 对话、文件、来源、任务进度、审批、产物和验收 | 不削弱内核能力，只隐藏实现细节 |
| **Studio** | 技术人员、OPC、一人公司、vibe coding 和工程团队 | 项目树、终端、Diff、Git、worktree、DAG、模型尝试、成本和权限 | 与 Assistant 共用同一 Goal、Ledger、Artifact 和 Runtime |

两种工作台是同一系统的不同投影，不是两个产品、两个 Agent 或两套数据。
Assistant/Studio 双工作台属于立项目标；当前界面尚未完成该模式分层。

## 4. 当前事实基线

### 4.1 当前已验证

| 能力域 | 当前事实 |
|---|---|
| 桌面架构 | Electron 主进程、context-isolated preload、React renderer；主窗口 `nodeIntegration=false` |
| 正式运行时 | 默认 OpenAI-compatible 路径；可选 Claude Agent SDK 路径；已注册并可选择的原生 Anthropic Messages 路径 |
| OpenAI 协议 | Responses 与 Chat Completions；两条路径均已接工具循环 |
| 多厂商 | 多 Provider、多模型、多 Key、自定义 Base URL、中转站和本地兼容服务 |
| 自动调度 | fixed、Provider 内自动、跨 Provider 自动；按任务、策略、预算、健康、项目规则和历史统计选择 |
| Key 接管 | 鉴权、403、限流、余额/配额错误时先切同 Provider 备用 Key；5 分钟冷却并防止本轮循环 |
| Provider failover | 对可切换错误自动选择健康 Provider 和能力档接近模型；每轮最多 3 次 |
| 交叉验证 | Command/Genesis 可启动第二模型只读复核和第三模型仲裁；严格首行结论解析后，确认失败可进入 canonical Acceptance/Evidence repair 路径 |
| 任务执行 | 会话、真实 child session、最多 33 个子任务、DAG、重试、任务快照和恢复 |
| Acceptance repair/retest | failed Workflow Acceptance review 可确定性创建 canonical repair WorkItem/Acceptance，启动恢复缺失 repair，完成前阻止 retest，完成后进入新的 verifying revision；多 criterion 已要求逐项 Evidence、criterion-scoped `verifies` link 和不可变 kind/source policy。typed main-only failure ingress 已原子写入 Evidence/link/failed revision/audit；新 Run 首次投影会冻结 Acceptance ID/revision，结构化交叉验证与原生 `bash` 显式测试失败均携带该 Run 绑定，旧事件首次晚到新 revision 时零写入 fail-closed。测试失败 Evidence 只接受 `commandTermination === 'exited'`、`isError === true` 且非零安全整数 `exitCode`；repair-derived policy 传播已覆盖新建、重复恢复和启动恢复；policy authoring 与 review/evidence 选择 UI 已由真实 Electron required gate 覆盖创建、多 criterion kind/source、空 source 拒绝、按 criterion 匹配 Evidence、通过和重启一致性；其他工具/引擎测试生产者、自动测试编排、repair Run、repair/retest review UI 和 release-bound strong-kill 仍开放 |
| 工程隔离 | managed Git worktree、Diff、逐 hunk 操作、patch、commit 和冲突检查 |
| Trust Kernel 基础 | 稳定事件身份、恢复游标、TaskRun、Effect Ledger、lease/fencing、部分 Reconciler、v6 TaskRun Effect evidence 链，以及 v8 Workflow Ledger、canonical recovery sessions、`legacy / compare / canonical` 恢复读源和 identity/continuity migration 门禁 |
| 工作桌面 | 文件、终端、浏览器、预览、Git、插件、Skill、MCP 和 Quickbar |
| 文件预览 | HTML、Markdown、Text、CSV、JSON、图片、PDF、DOCX、XLSX、PPTX；Office 编辑和像素级一致性未完成 |
| 个人系统 | 分层记忆、记忆确认、开工建议、本地 Routine、通知和防休眠 |
| 3D 办公 | 当前 Unitree/机器人资产；从真实会话、路由、failover、审批、成本、任务和 Git 状态派生 |
| 发布证据 | macOS x64 v0.1.6 已发布；最新 dirty-worktree Deep 为 144 total / 141 required pass / 3 optional skip / 0 blocked / 0 fail，该 Deep 报告开始和结束均为 426 status entries（`test-results/caogen-deep/2026-07-21T18-07-34-707Z/deep-test-report.md`），不替代 clean release candidate gate |

### 4.2 条件可用

| 能力 | 条件或限制 |
|---|---|
| Claude Agent SDK | 用户显式选择；需要有效 Claude 登录态、Anthropic Key 或兼容网关；不是默认路径 |
| 真实中国 Provider parity | 需要用户提供真实 Provider 配置、网络和额度；当前 optional skip 不等于通过 |
| Windows GUI | v0.1.5 有 Windows x64 包，后续发布和完整可见证据仍需真实 Windows 环境 |
| Apple Silicon | 历史 v0.1.3 arm64 资产存在；当前 v0.1.6 未发布 arm64，且缺少本轮真机启动、升级和完整功能证明 |
| PR/MR | 依赖可用的 `gh` 或 `glab`、仓库权限和远端状态 |
| GUI 自动化 | 默认关闭；需要显式授权，且宿主机命令并非系统级沙箱 |

### 4.3 已知缺口

1. OpenAI Responses 使用服务端 `response_id` 续上下文；跨 Provider 后会清空该链，完整历史桥接尚未完成。
2. Chat Completions 从转录恢复时当前主要重建文本，不完整回放图片和全部工具历史。
3. 会话建立后的智能路由按当前执行引擎过滤，尚不是跨协议、跨引擎的统一热切换。
4. Claude Agent SDK 路径的 failover 候选需要进一步固化协议兼容过滤。
5. failed Workflow Acceptance review 已能阻止交付、创建 canonical repair WorkItem/Acceptance 并在修复完成后重新验证；多 criterion Acceptance 必须逐项绑定 Evidence 与匹配的 criterion-scoped `verifies` link。可选不可变 `criterionPolicies` 已支持完整 criterion ID/index、Workflow Evidence kind/source 约束、legacy 无 policy 兼容和 retest 保留；对带 policy 的 Acceptance，typed failure producer 在未显式提供 `criterionIndexes` 时必须恰好匹配一个语义兼容的 criterion 才自动绑定，零个或多个匹配均 fail-closed 且不写 Evidence。repair-derived Acceptance 会在新建、重复恢复和启动恢复时按 repair criterion ID 继承同一 kind/source 语义。终态 canonical gate 每次重新读取 live store，并把 Workflow Evidence 绑定到 `workflow.evidence.recorded` envelope/payload digest、把 Task Evidence 绑定到 `workflow.effect.evidence` 事件及 Run/Effect source；passed 后删除 Workflow Evidence、Task Evidence 或 Evidence Link 会在 ProjectWorkspace 源提交前拒绝，available 本地 ArtifactLocation 的常规文件字节还必须匹配 Artifact/Evidence digest 与 checksum/size。Command/Genesis 交叉验证现以严格首行 parser 区分 review/arbitration 结论，只有 `BOTH_NEED_FIX` 或 reviewer 已判 `CONCERNS/BLOCKED` 后的 `REVIEWER_OK` 会写入结构化失败路径。原生 `bash` 显式测试命令的真实 `tool-result` 只有在 Session/TaskRun/ToolExecution/canonical testing WorkItem、事件摘要全部一致，并同时满足 `commandTermination === 'exited'`、`isError === true`、`exitCode` 为非零安全整数时才会生成测试失败 Evidence；`timed_out`、`aborted`、`output_limit`、`spawn_error`、`not_started` 等基础设施终止不会误报 Acceptance failure。该路径支持启动恢复；policy authoring 与 review/evidence 选择 UI 已由真实 Electron required gate 覆盖；remote/non-file Artifact trust、其他工具/引擎生产者、自动测试编排和 repair Run 仍未接通。
6. Provider 被判定不健康后缺少 half-open 探测和自动恢复策略。
7. 运行失败后缺少“同 Provider 换模型”这一层，当前备用 Key 耗尽后主要进入跨 Provider failover。
8. 模型可靠性统计按模型名聚合，同名模型在不同 Provider 上的表现可能混合。
9. 模型能力和价格仍含静态名称规则与保守估算，缺少完整 capability probe 和可更新价格源。
10. 新 Provider Key 的可逆 `b64:` 写入 fallback 已移除并接入 Provider Broker 基础；历史迁移演练、完整作用域、子进程最小环境和全出口 canary 仍是 P0 未完成项。
11. PR、Issue、消息、可查询 MCP、Code Forge 和部分 renderer Git/patch 入口尚未全部接入专用 Reconciler。
12. `task-snapshots.db` v8 已落地 Goal、WorkItem、Run、Artifact、Acceptance、Evidence Link、eventId/causation/correlation、canonical recovery sessions 和 cursor 查询；Goal/WorkItem 生产命令已在 JSON CAS 锁内先提交 Ledger、再写 JSON 恢复投影，并通过三个强杀检查点。Task Snapshot/TaskRun 恢复读取支持按数据库路径隔离的 `legacy / compare / canonical` 三态，跨 mode 首次 open 共享 single-flight readiness，mode flip 在 mutation queue 内强制复验后才发布。未显式配置时仍默认 legacy；结构化交叉验证仲裁失败与原生 `bash` 显式测试失败已接入，Routine、DigitalWorker/Assignment、其他工具/引擎测试、预览/patch/报告等外部事件仍未全部进入 canonical command/event path。
13. 独立 `task_evidence` 仍只覆盖 TaskRun Effect evidence；Artifact Graph edge/location、关系/归属校验、邻域查询、脱敏 export 和只读 diagnose/repair 已有基础实现。Acceptance repair/retest 的确定性创建、幂等、启动恢复和完成前门禁已落地，typed failure ingress 还会在一个 SQLite 事务内写 immutable Evidence、criterion links、失败 revision 和 system audit，并以 source kind + native event ID 保持幂等。原生测试失败生产者只持久化摘要与输出 SHA-256；Snapshot barrier 固定为 `capture -> flush -> persist -> delete`，flush 受 per-session failure latch 约束，之后才通过 ProjectWorkspace command/CAS 绑定 canonical WorkItem。启动恢复会补齐已持久化 Snapshot/Run 遗漏的 ingress/绑定，并在 replay conflict 时 fail-closed。完整 Artifact Graph/blob/sourceRef/metadata 生命周期、独立 Verification、其余测试生产者与自动编排、全量审计关联、统一 retention/delete 和生产补偿执行模型仍未完成。
14. Genesis 当前只生成结构化编排计划，不等同于自动执行、自动合并、推送或发布。
15. 当前 3D 角色仍是机器人资产；水墨数字员工是立项目标，不是当前实现。

## 5. 目标技术架构要求

### 5.1 总体架构

目标架构必须收敛为：

```text
CaoGen Experience
  -> CaoGen Application Core
  -> CaoGen Native Runtime
  -> Protocol Adapters
  -> Provider / Model APIs

CaoGen Application Core
  -> Workflow Ledger
  -> Canonical Context Ledger
  -> Artifact Graph
  -> Trust Kernel / Effect Ledger
  -> Tool Fabric
  -> Supervisor
```

Claude Agent SDK 在迁移期间继续作为可选正式兼容路径。只有当 Native Runtime、Anthropic Messages Adapter、上下文恢复、工具语义、检查点、Hook 迁移和旧数据读取全部通过验收后，才可以提出删除 SDK；在此之前不得宣称已删除或已完全替代。

## 6. Native Runtime 要求

### 6.1 Runtime 所有权

`CaoGen Native Runtime` 必须拥有下列能力，协议 Adapter 不得自行拥有第二套产品语义：

- Run 生命周期和 Attempt 生命周期；
- 标准消息、流式事件和工具调用循环；
- Canonical Context Ledger、压缩、fork、恢复和 checkpoint；
- 工具注册、参数校验、权限、审计和 Effect Ledger；
- 预算、超时、取消、重试、路由和故障恢复；
- 子任务、DAG、验证、仲裁和结果回灌；
- Artifact/Evidence 生成和 Acceptance gate；
- 结构化 telemetry 和错误分类。

### 6.2 Runtime 状态

Native Runtime 的 `Run` 必须支持：

```text
queued
-> planning
-> executing
-> waiting_approval
-> waiting_reconciliation
-> verifying
-> recovering
-> completed | failed | cancelled
```

状态转换必须由耐久事件驱动并校验合法性。`completed` 必须同时满足：无未收敛 Effect、Required Verification 已通过、Acceptance 未失败。

### 6.3 Attempt

每次模型请求或故障接管必须形成独立 `ModelAttempt`，至少记录：

- `attemptId`、`runId`、`stepId`；
- Provider、模型、协议、Adapter 版本和 Key 标签（不得记录密钥值）；
- 输入上下文快照摘要、能力要求和路由理由；
- 开始/结束时间、Token、估算成本、实际可得成本和延迟；
- 成功、失败、超时、取消、failover、validation 等结果；
- 错误分类、重试来源和后续 Attempt；
- 相关 ToolExecution、Effect、Evidence 和 Artifact。

Provider 或模型切换不得改变数字员工、Assignment、WorkItem 或 Goal 身份。

## 7. 协议 Adapter 要求

### 7.1 Adapter 边界

每个 Adapter 只负责：

1. Provider 请求鉴权和 endpoint 组装；
2. Canonical Message 与协议消息的双向映射；
3. 流式事件解析和规范化；
4. 工具定义、tool call 和 tool result 格式转换；
5. usage、finish reason 和错误归一化；
6. 协议能力声明和探测。

Adapter 不得直接写项目文件、管理用户审批、持有长期记忆、决定 Goal 完成或绕过 Effect Ledger。

### 7.2 首批 Adapter

| Adapter | 状态 | 要求 |
|---|---|---|
| OpenAI Responses Adapter | 立项目标 | 复用现有 OpenAIEngine，补齐完整历史桥接、恢复、图片和工具上下文 |
| OpenAI Chat Completions Adapter | 立项目标 | 复用现有已验证路径，统一工具、压缩、usage、错误和恢复语义 |
| Anthropic Messages Adapter | 部分完成（本地 targeted 验证） | 已独立注册生产 Engine，覆盖 Messages 流/usage/error、工具循环、NativeToolRuntime 权限与 Effect、Key/同协议 Provider failover 和图片重启恢复；真实 Provider、跨协议统一契约与 clean release-bound parity 仍开放 |
| Claude Agent SDK Compatibility Bridge | 条件可用 | 迁移期只作为兼容执行器，不继续增加 SDK 独占产品能力 |
| Gemini 原生协议 Adapter | 后续规划 | 只有出现明确用户需求和协议测试矩阵时进入实现 |

不重新引入 Codex CLI、Gemini CLI 或其他外部 Agent CLI 作为正式运行时。

### 7.3 Capability Manifest

Provider/模型必须声明或探测：

- 支持的协议和协议版本；
- tools、vision、stream、structured output、reasoning、context window；
- 最大输入/输出、并发、速率、区域和数据保留选项；
- 已验证模型列表、价格时间戳和能力证据；
- 是否支持 server-side conversation、prompt caching 和 tool choice。

未知能力必须按 fail-closed 或明确的保守默认处理，不得因为模型名相似就宣称已验证。

## 8. 自动路由、Key 与故障恢复

### 8.1 默认体验

- Assistant 新任务必须默认 `global auto + Core + failover on`。
- Studio 默认仍为自动路由，但可显式选择 fixed、Provider 内自动或跨 Provider 自动。
- 普通用户首屏不得要求选择 Provider、模型或 Agent 品牌。
- 自动提升模型质量和验证深度不得静默突破预算、权限、数据区域或 Provider 白名单。

### 8.2 路由顺序

路由必须按下列顺序执行：

1. 读取 Goal、项目规则、任务阶段、输入模态、预算和权限约束；
2. 过滤协议、工具、视觉、上下文、区域、白名单、Key 和健康状态不满足的候选；
3. 应用项目规则和用户显式覆盖；
4. 按质量、可靠性、延迟、成本、Provider 粘性和剩余预算评分；
5. 生成可读理由、候选摘要和验证计划；
6. 创建 ModelAttempt 后执行。

### 8.3 故障恢复阶梯

```text
瞬时网络重试
-> 同 Provider 备用 Key
-> 同 Provider 兼容模型
-> 同协议健康 Provider
-> 跨协议 Adapter 接管
-> 降级、暂停或请求人工处理
```

任何自动重放前必须检查未决 Effect。存在 `executing` 或 `waiting_reconciliation` Effect 时必须暂停并先对账。

### 8.4 Key 管理

Key 管理必须满足：

- 密钥只在主进程或独立凭据 Broker 中解密；
- renderer、转录、日志、3D 状态和 Artifact 不得出现密钥值；
- 删除可逆 `b64:` fallback；系统安全存储不可用时拒绝持久化或要求用户选择会话级临时凭据；
- 支持 disabled、冷却、失败分类、活动 Key、最后使用、轮换证据；
- 后续可增加额度和权重，但不得在缺少真实额度数据时伪造“最优 Key”。

## 9. Canonical Context Ledger

### 9.1 目标

Context Ledger 必须成为跨 Provider、跨协议、跨重启的唯一上下文事实源。Provider server-side conversation id 只能是缓存指针，不能是唯一历史。

### 9.2 Canonical Context Item

至少支持：

- system/project/user/assistant message；
- image、file、document unit、browser selection 和 IDE selection；
- tool call、tool result、permission、Effect 和 verification；
- routing、failover、checkpoint、compression summary；
- child result、review、arbitration 和 acceptance decision。

每项必须含稳定 ID、顺序、时间、因果 ID、相关 Goal/WorkItem/Run/Attempt、内容摘要和敏感级别。

### 9.3 恢复和压缩

- 所有 Adapter 必须从 Canonical Context 重建可接受的协议历史；
- 压缩必须保留用户约束、未完成任务、工具配对、审批、Effect 和 Artifact 引用；
- 图片和二进制不重复内嵌，使用内容寻址 Blob 和受控引用；
- checkpoint 必须声明回退的是 code、chat、workflow 还是组合；
- fork 必须保留来源和分叉点，不修改原始历史。

## 10. Workflow Ledger

### 10.1 领域层级

```text
ProjectWorkspace
-> Goal
-> WorkItem
-> Assignment (assignee = DigitalWorker | Human)
-> Run
-> ModelAttempt
-> ToolExecution / Effect
-> Artifact / Evidence
-> Acceptance
```

### 10.2 数字员工

数字员工是 CaoGen 内部岗位实例，不是外部 CLI 或厂商 Agent。

`DigitalWorker` 必须包含：岗位模板、名称、水墨人物身份、职责、能力、权限、记忆命名空间、预算、并发和生命周期。`Assignment` 把 WorkItem 交给数字员工；真正执行由 Native Runtime 创建 Run。

Provider、模型和协议只记录在 ModelAttempt。删除 Provider 不得删除数字员工；退休数字员工不得删除任务、产物和审计记录。

### 10.3 状态要求

| 对象 | 状态 |
|---|---|
| Goal | draft / planned / running / blocked / waiting_approval / verifying / completed / failed / cancelled / archived |
| WorkItem | backlog / ready / running / waiting_approval / blocked / verifying / done / failed / cancelled |
| DigitalWorker | proposed / active / paused / retired |
| Assignment | proposed / assigned / running / completed / failed / cancelled |
| Acceptance | pending / verifying / passed / failed / waived |

所有状态变化必须记录操作者、原因、前后状态和因果事件。`waived` 必须由用户或授权策略显式产生。

### 10.4 Supervisor

立项目标 Supervisor 必须支持：

- 持久队列、lease、heartbeat、取消和超时；
- 审批等待和恢复；
- Desktop 隐藏时继续本地执行；
- 应用异常退出后的 orphan Run 检测；
- 对可恢复 Attempt 重建，对未知 Effect 停止重放；
- 并发、资源、预算和 Provider 限流；
- 本地 Routine 统一进入 Workflow Ledger。

当前实现只达到以下部分完成切片，不改变上面的目标要求：

| 需求 | 当前状态 | 已验证边界 | 尚未覆盖 |
|---|---|---|---|
| `RUN-004` | 部分完成（Supervisor foundation + identity/control bridge） | `npm run test:supervisor-state:required` 覆盖持久 store/CAS、heartbeat、lease/fencing、可信 actor、TaskRun→WorkItem/Supervisor snapshot/startup binding，以及受控 SessionManager pause/cancel/resume/retry/reassign；canonical 控制强制 expected revision，lease 动作强制 lease ID/fencing token，retry 先预检 durable snapshot，stale revision 在运行时动作前 fail-closed，failed resume 转 blocked，SessionManager 重建后 paused Run 继续阻止普通发送与自动 replay。最新控制报告为 `test-results/supervisor-session-control-smoke/2026-07-22T07-08-50-631Z/report.json`。 | Studio UI、预算/并发 enforcement、自动编排、真实 Provider parity、跨文件事务补偿、全入口 canonical execution 与跨域强杀 retry/reconciliation。 |
| `NFR-REC-004` | 部分完成（Supervisor lease/fencing foundation） | Supervisor 记录层覆盖并发 CAS、过期接管、陈旧 writer 拒绝和单调 fencing token。 | 所有 canonical WorkItem 执行入口的单一 lease ownership/release、跨入口重启 parity 和 release-bound 证据。 |

该切片不构成 `RUN-005` 的重启恢复验收；IPC 重启读回不能替代逐非终态 strong-kill、retry/reconciliation 分类门禁。

Desktop 完全关闭后继续运行的独立 Supervisor 属于后续规划；当前进程内常驻和本地 Routine 不得被描述为独立后台服务。

## 11. Artifact Graph

### 11.1 目标

Artifact Graph 必须统一管理过程产物和交付产物，替代分散在转录、附件、预览、worktree、Routine、patch 和报告中的弱关联。

### 11.2 Artifact 类型

- source file、generated file、document、spreadsheet、presentation、PDF；
- image、screenshot、browser capture、annotation；
- code diff、patch、commit、branch、PR/MR；
- test report、build report、review report、routing report；
- research note、citation set、decision memo；
- exported bundle、release asset 和 checksum。

### 11.3 图关系

至少支持：

- `derived_from`：由哪些输入生成；
- `produced_by`：由哪个 Run/Attempt/Tool 产生；
- `verified_by`：由哪些 Evidence 验证；
- `supersedes`：替代哪个版本；
- `references`：引用来源；
- `delivers`：服务于哪个 Goal/Acceptance；
- `contains`：文档、工作表、幻灯片、bundle 的层级。

Artifact 内容应使用 SHA-256 内容寻址；元数据进入数据库，较大内容进入受控 Blob Store。删除策略必须区分软删除、引用保留、用户导出和审计保留。

## 12. Effect Ledger 与交付可信度

### 12.1 当前基础

当前 Effect Ledger 已有 intent/effect/resource key、generation/revision、lease/fencing、evidence digest 和部分自动对账，属于当前已验证基础。`task-snapshots.db` v8 保留 v6 TaskRun Effect evidence 的 global `seq/prevDigest/recordDigest` hash-chain，并包含 Workflow Ledger 表/event chain、canonical `workflow_recovery_sessions` 与持久 `workflow_store_identity`；v8 提供有限 API、IPC/UI 查询、校验、cursor 分页，以及 Artifact Graph edge/location 的 fail-closed verification、脱敏 export 和只读 repair plan。Task Snapshot/TaskRun 恢复读取支持 `legacy / compare / canonical`：compare 对两侧结果做 fail-closed parity，canonical 读取 Workflow Run/recovery session；mode 按数据库路径隔离，mode flip 在 mutation queue 内 fresh revalidate 后才提交，未配置时默认 legacy。所有 Task Store open 共享按数据库路径隔离的 single-flight readiness；legacy JSON/旧 SQLite 升级使用精确备份、durable journal/checkpoint、校验后的内存 candidate、原子替换和可恢复回滚，future/corrupt source fail-closed。committed journal 以 store identity 和历史高水位阻止目标删除、截断、版本回退或同版本空库替换。这是本地 tamper-evident 一致性与 recovery read-source cutover 基础，不是完整 Trust Kernel、外部不可变审计账本、全入口 canonical workflow、Canonical Conversation Ledger 或完整 Goal/Artifact 生命周期。

### 12.2 目标覆盖

所有可观察外部副作用必须进入 Effect Ledger，包括：

- 文件写入、替换、删除和移动；
- Git commit、merge、push、tag 和 branch mutation；
- PR、Issue、评论和 Release；
- 邮件、消息、日历、表单和网页提交；
- GUI 点击、输入、快捷键和应用操作；
- 可写 MCP、数据库、云资源和部署操作。

每类 Effect 必须声明：目标、前置状态、意图摘要、幂等键、是否可查询、Reconciler、补偿能力、权限范围和后置条件。

### 12.3 Exactly-once 口径

CaoGen 不得宣称任意外部系统事务级 exactly-once。只有当特定 Effect 有可验证前置状态、持久意图、资源 fencing、可查询结果和对账证据时，才可以对该 Effect 声明受限的重放安全。

## 13. 权限与安全要求

### 13.1 权限模型

权限决策必须同时考虑：

- 工作台和 Drive 策略；
- Goal/项目规则；
- 工具风险和输入参数；
- app、window、action、path、diff、remote、ref 和后置条件；
- 用户一次性、会话级、限时和持久授权；
- 数字员工 RoleTemplate 的能力上限。

Critical 风险动作默认拒绝。`bypassPermissions` 必须显式选择、可见、可审计，不得成为隐藏 fallback。

### 13.2 进程边界

- renderer 不得直接访问 Node、文件系统、凭据和外部命令；
- preload 只暴露窄、类型化、可版本化 API；
- main 校验所有 ID、路径、URL、命令、枚举和对象结构；
- 外部页面使用隔离 BrowserView 或 sandbox iframe；
- 本地主窗口当前 `sandbox=false` 必须如实记录，不能把 restrictedLocal 描述为 OS 沙箱。

### 13.3 数据保护

- 规定数据分类：公开、项目内部、敏感、凭据；
- 所有日志和错误必须脱敏；
- 项目数据默认本地保存；
- 同步或远程执行必须单独授权，并提供数据边界和删除策略；
- 支持用户导出、保留、删除和审计记录策略。

## 14. 数据模型要求

所有核心实体必须具有：

- 稳定 UUID；
- `schemaVersion`；
- `createdAt`、`updatedAt`；
- 乐观并发 `revision`；
- 软删除或归档状态；
- 可选 `correlationId`、`causationId`；
- 迁移来源和兼容版本。

数据库必须支持原子事务、索引、外键或等价完整性校验。事件顺序、Effect revision 和 Artifact digest 不得依赖 renderer 内存状态。

## 15. IPC 与内部 API 要求

### 15.1 调用模型

IPC/API 分为：

- **Command**：改变状态，必须有 command id、调用者、权限和幂等语义；
- **Query**：只读，必须有分页、范围和脱敏规则；
- **Event**：不可变状态变化，必须有 schema version、seq、event id、correlation id。

### 15.2 契约要求

- 所有 renderer 可调用接口必须有共享类型；
- 输入必须在 main 边界运行时校验，不能只依赖 TypeScript；
- 长任务返回 operation id，通过事件订阅进度，避免长时间 IPC 阻塞；
- 破坏性变更使用新版本 channel 或兼容 envelope；
- 错误返回稳定 code、用户信息、诊断信息和是否可重试；
- UI 不得根据字符串错误猜测产品状态。

## 16. 性能与容量要求

以下均为立项目标，不代表当前所有平台已达到。

| 指标 | 目标 |
|---|---|
| 主窗口可交互 | 参考硬件冷启动 P95 不高于 3 秒 |
| 本地路由决策 | 100 个候选内 P95 不高于 100ms，不含网络探测 |
| Command 入队确认 | P95 不高于 150ms |
| 耐久事件到 UI | 本机 P95 不高于 250ms |
| 并发模型请求 | 默认全局上限 8，可按 Provider 限制；不得打爆 socket 或额度 |
| 子任务 | 支持现有 33 child session 上限，但默认并发由资源策略控制 |
| 转录首屏 | 只回放必要窗口；长历史后台分页，不阻塞交互 |
| Artifact | 大文件流式读写，renderer 不持有无上限二进制副本 |
| 3D 12 人物 | 保持 `1 Full + 11 Low`，不可因状态更新重置相机或角色身份 |

性能门禁必须记录测试硬件、场景、样本和警告阈值，不把单机毫秒数写成全平台保证。

## 17. 兼容性要求

### 17.1 平台

| 平台 | 状态要求 |
|---|---|
| macOS x64 | 当前已验证发布基线 |
| macOS arm64 | 条件可用；仅有历史 v0.1.3 资产，当前 v0.1.6 未发布，正式宣称需本轮真机启动、功能和升级验证 |
| Windows x64 | 条件可用；每次发布需真实 Windows GUI 和安装验证 |
| Linux AppImage | 后续规划；配置存在不等于已发布 |

### 17.2 数据兼容

- 现有 `sessions.json`、transcript JSONL、Task Snapshot SQLite/JSON、Provider、项目、记忆、Routine 和插件设置必须有迁移器；
- 迁移必须先备份、可重复、可中断恢复、可回滚；
- 旧 Claude SDK 会话必须至少可读取和从 CaoGen transcript fork；不能伪称恢复 SDK 隐藏上下文；
- 当前 `~/.claude/plugins` 只作为显式兼容导入源；插件、Skill、MCP 的托管目录、启用状态、来源和 digest 必须迁移到 CaoGen 自有 registry/store；
- 删除或退休 Provider 不得破坏历史 Attempt 和 Artifact 的显示。

## 18. 可观测性要求

### 18.1 三类可观测数据

1. **用户可见时间线**：路由、工具、审批、failover、验证、产物和交付。
2. **审计证据**：命令、权限、Effect、Reconciler、Artifact digest、Acceptance。
3. **诊断 telemetry**：性能、错误率、延迟、队列、内存、Provider 健康和 Adapter 解析错误。

### 18.2 约束

- 日志必须结构化、可关联、默认脱敏；
- Provider 错误和产品错误必须分开；
- UI 显示用户可操作信息，诊断详情放入可展开区域；
- 3D 办公只消费真实状态投影，不创建新的执行事实；
- telemetry 默认不得上传项目内容或凭据。

## 19. 3D 水墨数字员工要求

### 19.1 状态口径

- **当前已验证**：当前 3D 办公使用 Unitree/机器人资产，并消费真实 SessionState。
- **立项目标**：以原创或授权明确的中国水墨轻动漫人物完整替换面向用户的机器人主角色。
- **明确不做**：按厂商人格化角色、把动画当作执行证据、写实游戏级自由漫游。
- **明确不做**：CaoGen 1.0 以机器人作为加载失败、低性能或资源缺失时的运行时 fallback；应降级到水墨 Low、程序化水墨剪影或列表视图。

### 19.2 三层身份

1. `CharacterIdentity`：DigitalWorker、岗位、姓名、水墨形象和长期身份；切任务或模型时不变。
2. `ComputeBadge`：Provider、模型、Key 标签和 Attempt；以印章、腰牌或桌面标识短暂展示。
3. `RuntimeState`：idle、working、awaiting、error、completed、walking、reviewing、failover；由真实 Ledger 事件驱动。

自动切换 Provider 时，角色 ID、位置、任务和动作连续性不得重置；只更新 ComputeBadge 和 failover 动画。

## 20. 发布与升级要求

- 发布必须绑定精确 commit、版本、干净工作树、构建产物和 SHA-256；
- required gate 不得以 skip 或 blocked 通过；
- 外部真实 Key、China 网络、Windows GUI、Apple Silicon、签名和公证必须按条件状态记录；
- 自动更新只有在用户可见并明确确认后才能下载/安装，失败必须可回退到上一可启动版本；当前完整 UI/IPC 更新链未验证；
- 数据迁移必须在应用升级前备份，并记录 migration journal；
- 当前 beta/GitHub 预览包可以在醒目警告和 SHA-256 核验下保持未签名；任何标记为 CaoGen 1.0 stable 的正式平台必须完成对应代码签名，macOS 还必须完成公证与 stapling，并验证升级回滚。

## 21. 测试要求

### 21.1 测试层级

| 层级 | 必测内容 |
|---|---|
| 单元/属性测试 | 状态机、路由评分、错误分类、Adapter parser、digest、权限规则 |
| 合约测试 | Adapter 请求/响应、IPC schema、Tool schema、Artifact/Effect schema |
| Smoke | Provider、Key、路由、Context、Workflow、Artifact、Effect、3D projection |
| Electron E2E | main → IPC → preload → store → UI 完整链路 |
| Crash E2E | 强杀、重启、截断写入、未知 Effect、恢复和防重复 |
| 真实 Provider | 至少一条 OpenAI-compatible 必需路径，由 `npm run test:real-provider-release:required -- --record /private/path/result.json` 校验私有脱敏记录；其他外部路径按条件分级 |
| 发布测试 | 打包启动、资源完整性、升级、回滚、签名、公证和公开资产审计 |

### 21.2 关键验收矩阵

| 场景 | 必须结果 |
|---|---|
| Key A 401 | 切 Key B，密钥不出主进程，不重复用户消息 |
| 模型不可用 | 先尝试同 Provider 兼容模型，再按策略切 Provider |
| Provider 503 | 同一 Goal/Run 内接管，Context、预算和权限不丢失 |
| Responses 跨 Provider | 新 Adapter 从 Canonical Context 重建历史，不依赖旧 response id |
| 未决 Effect | 禁止自动重放，进入 waiting_reconciliation |
| 复核 BLOCKED | 交付被阻止，产生修复 WorkItem 或请求人工处置 |
| failed Acceptance | 确定性创建同 Project/Goal/parent/owner 的 repair WorkItem 和 Acceptance；未完成时拒绝 retest，完成后原 Acceptance 进入新 verifying revision |
| 应用强杀 | 重启后恢复状态；未知副作用不自动重做 |
| Assistant/Studio 切换 | Goal、对话、附件、任务、审批、产物和预算完全一致 |
| Provider 删除 | 历史 Attempt 仍可读，数字员工和 Goal 不被删除 |
| 3D failover | 人物身份不变，只更新算力印章和真实状态 |

## 22. 可维护性要求

- Native Runtime、Adapter、Router、Context、Workflow、Artifact、Trust、Tool 和 Presentation 必须分模块；
- `sessionManager.ts` 保留 facade，编排、恢复、预算和通知继续下沉到专用服务；
- `ipc.ts` 按领域拆分注册器；共享类型只保留跨进程契约；
- 超过 800 行的新模块必须说明原因，超过 1200 行优先拆分，超过 2000 行不得继续吸收新职责；
- 所有持久实体、事件和 IPC envelope 必须版本化；
- 新能力必须同步具备实现、测试、状态文档和迁移说明；
- 不复制第三方 Agent 产品代码，只复用合法协议、SDK、库和公开接口。

## 23. 技术实施轨道

产品里程碑以项目立项书的 `M0-M7` 为唯一编号。本文只使用 `T0-T6` 表示技术子阶段，避免与产品里程碑和需求优先级 `P0/P1/P2` 混用。

| 技术阶段 | 映射产品里程碑 | 状态 | 主要出口条件 |
|---|---|---|---|
| T0 Trust 与迁移准备 | M1 | 部分完成 | Provider 新 Key 的 `b64:` fallback 已删除；v6 Effect evidence、v8 Workflow Ledger、canonical recovery sessions、`legacy / compare / canonical` 恢复读源、可逆 migration 和 committed identity/high-water continuity 已接入；仍需完整 scoped Broker、统一入口/外部事件 canonical 接入、完整 Artifact Graph/blob/sourceRef 生命周期、Canonical Conversation Ledger、扩大 Reconciler、统一 retention/delete、补偿闭环、权限作用域化和兼容插件根盘点 |
| T1 Native Runtime 骨架 | M2 | 立项目标 | Run/Attempt/Tool/Effect 统一；OpenAI 两协议进入 Adapter 契约 |
| T2 Canonical Context | M2 | 立项目标 | 跨 Provider/协议/重启恢复；Responses 历史缺口关闭 |
| T3 Anthropic Messages Adapter | M2 | 部分完成（原生路径本地闭环） | 工具、流、usage、错误、保守 failover 和图片重启恢复已通过 targeted required 门禁；跨协议统一 Context/Checkpoint/Hook、真实 Provider 与 clean release evidence 仍开放 |
| T4 Workflow、Artifact 与数字员工 | M3 | 部分完成（domain、repair/retest 与 structured failure ingress foundations） | Goal、WorkItem、DigitalWorker、Assignment、Artifact Graph、Acceptance 已有持久化基础，failed Acceptance 的 repair/retest、结构化交叉验证失败和原生 `bash` 显式测试失败 producer 已接通；其他测试执行路径与自动编排、完整 WorkItem controls、跨阶段 Artifact/Verification 链、UI/strong-kill 和扩展资产迁入仍开放 |
| T5 双模式、Supervisor 与 3D 投影 | M3-M4 | 立项目标 | 同一 Goal 无损切换；本地任务可恢复；水墨人物只消费真实状态 |
| T6 Claude SDK 退出门禁评估 | M6 | 立项目标 | 完成 parity、旧数据与插件迁移、真实条件验证、收益量化并输出 Go/No-Go；不直接等于删除 |

M5 是 T0-T5 的集成、修复、真人验收和默认连续 7 天 soak gate，不新增技术编号。精确 `1.0.0` 采用 `docs/1.0-SOAK-WAIVER.json` 中的 owner 风险接受：该域只能报告 `waived/non-blocking`，不得报告 `passed`，不得继承至其他版本，也不改变其余 M5/M6/T6 门禁。

实际移除 Claude Agent SDK 属于 T6 给出 Go 之后的独立发布决策和后续规划，不预设日期。

## 24. 明确不做

- 不做外部 Agent CLI 启动器或切换器；
- 不把 Codex、Claude Code、Gemini CLI、OpenCode 等作为数字员工实体；
- 不自研、训练或微调基础模型；
- 不把模型差价或特定厂商算力销量作为路由目标；
- 不做 Jira、HR、CRM、邮件客户端或完整 Office 套件的全面替代；
- 当前周期不做云端 Routine、公共云 Runner、移动端和插件市场；
- 不恢复 Docker 产品运行模式；
- 不做写实游戏级 3D 自由漫游；
- 不在缺少真实证据时自动发布、自动推送或宣称 exactly-once。

## 25. 产品技术完成定义

某项能力只有同时满足以下条件才可从“立项目标”升级为“当前已验证”：

1. 责任边界和数据模型已稳定；
2. main、IPC、preload、shared type、store、UI 所需链路全部接通；
3. 状态机、权限和失败路径有专项测试；
4. 至少一条真实或高保真 Electron E2E 证明用户链路；
5. 崩溃、恢复、重复执行和数据迁移按风险完成测试；
6. 当前限制和外部条件已写入 `STATUS.md`；
7. 对外文案不超过证据范围；
8. 未引入无迁移路径的 SDK 专属产品语义。
