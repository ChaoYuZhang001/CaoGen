# CaoGen 1.0 产品需求说明书

> 文档状态：产品需求基线候选版 1.0
> 更新日期：2026-07-22
> 上位文档：[`PROJECT-CHARTER.md`](./PROJECT-CHARTER.md)
> 当前事实源：[`STATUS.md`](../STATUS.md)
> 配套技术：[`PRODUCT-TECHNICAL-REQUIREMENTS.md`](./PRODUCT-TECHNICAL-REQUIREMENTS.md) · [`HIGH-LEVEL-DESIGN.md`](./HIGH-LEVEL-DESIGN.md) · [`SECURITY-AND-RISK.md`](./SECURITY-AND-RISK.md)
> 适用对象：产品、设计、架构、开发、测试、发布和商业团队

## 1. 文档约定

### 1.1 状态标记

| 标记 | 定义 |
|---|---|
| **当前已验证** | 当前主分支已有实现，并有代码、测试、构建、运行或发布证据。 |
| **部分完成** | 已有可复验的实现切片和证据，但仍缺少一个或多个产品边界、入口、恢复场景或发布绑定；不得按完整需求对外宣称。 |
| **条件可用** | 已有实现，但依赖特定平台、Provider、账号、外部 CLI、权限、额度或运行条件。 |
| **立项目标** | CaoGen 1.0 必须实现并通过验收的能力。 |
| **后续规划** | 不阻塞 CaoGen 1.0，待产品验证后排期。 |
| **明确不做** | 本阶段主动排除或与产品定位冲突的能力。 |

### 1.2 优先级

| 优先级 | 定义 |
|---|---|
| **P0** | 1.0 发布阻塞；缺失时产品主张不成立，或存在数据、安全、恢复风险。 |
| **P1** | 1.0 黄金路径所需；可在受控降级下短暂缺失，但发布前必须有明确处置。 |
| **P2** | 增强体验或覆盖更多场景；不阻塞最小 1.0。 |

### 1.3 需求解释原则

- 本文描述目标产品，不得将“立项目标”改写成当前已实现。
- 当前能力发生变化时，以 `STATUS.md` 和最新测试工件为准。
- 需求冲突时，按“数据安全与真实性 > 可恢复与可审计 > 用户目标闭环 > 体验效率 > 视觉效果”排序。
- Provider、模型、协议和引擎均不得成为用户必须管理的顶层业务对象。

## 2. 产品定义

### 2.1 产品定位

**立项目标**：CaoGen 是本地优先、厂商中立、可恢复、可审计的 Agent Work OS。用户提交目标、约束、预算和验收标准；CaoGen 使用内部数字员工、模型算力和工具完成工作并交付证据。

### 2.2 核心边界

CaoGen 不是：

- 外部 Agent 或 Agent CLI 启动器。
- Claude Code、Codex、Gemini CLI、OpenCode 等产品的切换面板。
- 以外部 Agent 进程为员工的劳动力管理平台。
- 完整 Jira、飞书、Notion、CRM、ERP 或 HR 系统。
- 只提供聊天回答、无法持久执行和验收的对话壳。

CaoGen 是：

- 一个持有 Project、Goal、WorkItem、Run、Artifact、Evidence 和 Acceptance 的原生系统。
- 一个默认自动选择不同厂商和模型、用户可在专家模式检查原因的调度系统。
- 一个为普通任务提供 Assistant、为复杂任务提供 Studio 的双模式产品。
- 一个用内部岗位实例表达“数字员工”，用 CaoGen Runtime 执行工作的系统。

## 3. 当前能力基线

| 能力域 | 状态 | 当前事实 |
|---|---|---|
| 多厂商配置 | 当前已验证 | 多 Provider、多 Key、自定义 Base URL、OpenAI-compatible 路径和可选 Claude Agent SDK。 |
| 原生 Anthropic Messages | 部分完成（本地 targeted 验证） | 已注册生产 Engine 并覆盖工具循环、权限/Effect、Key/同协议 Provider failover 和图片重启恢复；真实 Provider、统一 Run/Context 契约与 clean release-bound parity 仍开放。 |
| 模型路由 | 当前已验证 | 支持任务类型、项目规则、用户规则、健康、预算、成本、质量、速度和 failover。 |
| 项目与会话 | 当前已验证 | 目录型项目、未关联项目会话、项目规则、归档/恢复/删除和项目记忆。 |
| 多任务 | 当前已验证 | 真实 child sessions、最多 33 个任务、DAG、重试、worktree、结果回传和可选自动合并。 |
| 工作台 | 当前已验证 | 终端、文件、编辑、Diff、Git、浏览器、预览、插件、Skill、MCP 和部分 Office 能力。 |
| Trust Kernel | 当前已验证 | Task Run、Effect Ledger、lease/fencing、部分文件/Git Reconciler 和强杀恢复。 |
| Routines | 当前已验证 | 本地定时、运行记录、通知、防休眠和开工建议。 |
| 3D 办公区 | 当前已验证 | 使用真实会话、任务、Provider、成本、审批、工具、worktree 和 Git 状态。 |
| Claude 专项 | 条件可用 | 需要有效 Anthropic 凭据、兼容网关或本机登录态；不是默认路径。 |
| PR/MR 和远端交付 | 条件可用 | 依赖远端账号、权限及 `gh`/`glab` 等外部条件。 |
| GUI 自动化 | 条件可用 | 默认关闭，需要显式权限，平台与应用覆盖不完整。 |
| Office 高保真 | 条件可用 | 支持结构提取和系统预览，不等价于原应用完整编辑与像素级一致。 |
| Goal/Workflow Ledger | 当前已验证（v8 recovery read-source foundation） | `task-snapshots.db` v8 已提供 Goal/WorkItem/Run/Artifact/Acceptance/Evidence Link、event chain、canonical recovery sessions、有限 API/IPC/UI 和 cursor 查询；Task Snapshot/TaskRun 恢复读取支持按数据库路径隔离的 `legacy / compare / canonical` 三态，mode flip 强制重新验证，未配置时默认 legacy。 |
| Assistant/Studio | 部分完成（dirty-worktree UI E2E） | 固定模式切换、运行中流连续性和 Assistant 首次启动 zero-choice 已有本地 required E2E；统一 Project/Goal/WorkItem/Run/Artifact 契约、Studio 直接启动和 clean release-bound 证据仍开放。 |
| DigitalWorker | 立项目标 | 当前子 Agent、固定角色和 persona 不等于数字员工。 |
| 水墨轻动漫人物 | 立项目标 | 当前 3D 机器人/角色资产不是目标视觉形态。 |

## 4. 用户和系统角色

### 4.1 最终用户角色

| 角色 | 主要目标 | 默认体验 |
|---|---|---|
| 白领/知识工作者 | 报告、邮件、会议、表格、演示、资料和周期性工作 | Assistant |
| 学生 | 学习计划、讲解、练习、研究、复盘和材料整理 | Assistant |
| 教师 | 教案、课件、题目、评分标准、课程项目和资料研究 | Assistant；复杂课程项目可切 Studio |
| 普通用户 | 文件、计划、总结、研究和个人自动化 | Assistant |
| 技术人员 | 项目理解、编码、测试、审查、Git 和交付 | Studio |
| OPC/一人公司 | 调研、产品、内容、开发、运营和长期自动化 | Studio |
| Vibe Coding 用户 | 从自然语言目标到可运行、可检查、可交付的应用 | Studio |

### 4.2 控制角色

- **Project Owner**：定义项目边界、预算、保留策略和最终验收人。
- **Approver**：批准高风险工具、外部副作用、预算超限和验收豁免；1.0 默认与 Project Owner 为同一用户。
- **DigitalWorker**：CaoGen 内部岗位实例，不是外部 Agent，也不是模型账号。
- **Supervisor**：持有任务 lease、heartbeat、恢复、暂停、取消、重试和审批等待状态的系统组件。
- **Router**：依据任务能力、质量、成本、速度、健康和预算选择 Model Attempt。
- **Verifier**：运行测试、检查来源、Diff、截图、远端状态或其他验收规则。

## 5. 核心用户旅程

### 5.1 Assistant：普通知识任务

1. 用户在统一输入框描述目标，并可附加文件、图片或资料。
2. CaoGen 推断任务类型、风险、所需产物和最小验收标准。
3. 简单任务直接执行；复杂任务在后台创建 Goal 和 WorkItems，但不强迫用户查看技术细节。
4. 系统自动选择 Provider/模型，必要时切换或复核。
5. 用户只看到进度、来源、待审批事项和最终产物。
6. 用户可在任何时刻切换 Studio 检查任务、模型、工具、成本和证据。

### 5.2 Studio：复杂项目交付

1. 用户创建或打开 Project Workspace。
2. 用户填写 Goal Contract：目标、背景、限制、预算、截止时间和 Acceptance。
3. CaoGen 生成 WorkItem/Workflow/DAG 和推荐数字团队。
4. 用户审查职责、权限、预算、依赖和交付物后启动。
5. DigitalWorkers 在隔离工作区或受控资源上执行，Provider/模型自动路由。
6. Supervisor 汇总运行、审批、阻塞、Artifact、Evidence 和成本。
7. Verifier 执行验收；失败时进入修复→复验循环。
8. 通过后生成交付清单，由用户接受、拒绝或要求返工。

### 5.3 组建数字团队

1. 用户描述目标或选择团队模板。
2. CaoGen 推荐岗位，例如研究、策划、写作、设计、开发、审查、测试和运营。
3. 每个岗位卡显示职责、可访问数据、工具权限、预算、并发、验收规则和升级路径。
4. 用户点击“加入团队”，创建项目内 DigitalWorker。
5. 用户不需要选择厂商、模型或外部 Agent。
6. 同一 DigitalWorker 可在不同任务和 Attempt 中使用不同模型，身份、记忆和产物保持连续。

### 5.4 故障恢复

1. Provider 失败、应用崩溃、网络中断或任务被暂停。
2. Supervisor 读取 Canonical Ledger、最后事件、lease、Effect、Evidence 和未完成 WorkItem。
3. 系统区分“未执行”“已执行”“结果未知”和“需要人工对账”。
4. 可安全重试时创建新 Attempt；不可证明安全时等待用户确认。
5. 恢复不得创建重复员工、重复 WorkItem 或重复高风险副作用。

### 5.5 周期工作

1. 用户将 Routine 绑定 Project、Goal 模板或 DigitalWorker。
2. 到期后 Supervisor 创建 WorkItem 和 Run，而不是创建脱离项目的孤立会话。
3. 执行结果进入项目 Inbox、Artifact 和 Evidence。
4. 失败、预算超限或待审批时通知用户并保持可恢复状态。

## 6. Assistant / Studio 双模式

### 6.1 模式定义

| 维度 | Assistant | Studio |
|---|---|---|
| 主要对象 | 对话、文件、来源、审批和产物 | Project、Goal、WorkItem、DigitalWorker、Run、Artifact 和 Evidence |
| 默认信息密度 | 低 | 高 |
| 模型信息 | 默认隐藏 | 默认显示摘要，详情可展开 |
| 工具信息 | 只显示必要审批和结果 | 显示工具、Effect、Diff、成本和日志 |
| 项目管理 | 自动生成并摘要展示 | List、Board、DAG、依赖和负责人 |
| 适用任务 | 问、写、学、整理、研究 | 计划、执行、验证、交付和持续运营 |

### 6.2 模式不变量

- `experienceMode` 只改变界面呈现和控制密度，不改变 Drive、预算、权限、Provider、模型或任务状态。
- 模式切换不得新建会话、复制 Goal、重复上传文件、重启 Run 或丢失草稿。
- Assistant 中不得隐藏待审批、失败、预算超限、未知副作用和验收失败。
- Studio 中修改的 Goal、WorkItem、Artifact 和 Acceptance 必须立即反映到 Assistant 摘要。
- 系统可以建议用户进入 Studio，但不得自动强制切换。

### 6.3 功能需求

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| EXP-001 | P0 | 当前已验证 | 固定且可访问的 Assistant/Studio 分段控件已通过真实 Electron 的指针、Space/Enter、唯一 pressed 状态、focus/draft/session/transcript 保持、响应式溢出和 overlay 层级验证。 |
| EXP-002 | P0 | 当前已验证 | 两种模式共用同一 canonical Project、Goal、WorkItem、Run 和 Artifact store；真实 Electron required gate 已用一次生产 SessionManager send、一次 Artifact 写入、十次 Assistant/Studio 往返和 renderer 重载证明身份、revision、归属、引用与 digest 不分叉，且源代码/构建新鲜度前后均通过。 |
| EXP-003 | P0 | 部分完成（running projection continuity foundation） | 模式切换期间正在运行的任务继续执行，权限请求和通知保持有效。当前已验证运行中流式任务、重复发送防绕过、模型切换 fail-closed 和可见错误；审批、通知、失败与恢复连续性仍待完成。 |
| EXP-004 | P1 | 立项目标 | Assistant 支持无目录的托管个人 Workspace。 |
| EXP-005 | P1 | 立项目标 | Studio 可展开文件、终端、Diff、浏览器、DAG、成本、Evidence 和审计时间线。 |
| EXP-006 | P1 | 立项目标 | 用户偏好可持久化，但每个任务都允许临时切换。 |
| EXP-007 | P2 | 后续规划 | 根据用户习惯推荐默认模式和布局，不静默改变当前模式。 |

## 7. 领域模型

### 7.1 聚合关系

```text
ProjectWorkspace
  ├─ Goal
  │   ├─ WorkItem / Workflow / DAG
  │   │   ├─ Assignment → DigitalWorker | Human
  │   │   └─ Run
  │   │       ├─ ModelAttempt
  │   │       ├─ ToolExecution / Effect / Evidence
  │   │       └─ Artifact
  │   └─ Acceptance
  ├─ RoleTemplate → DigitalWorker
  ├─ Routine
  ├─ Memory / Skill / Connector
  └─ Policy / Budget / Audit
```

### 7.2 ProjectWorkspace

**立项目标**：项目是代码、知识、资源、Goal、任务、员工、Artifact、预算、权限、记忆、保留和审计的统一边界。

建议字段：

```text
id, schemaVersion, name, kind, status, ownerId,
resources[], rulesRef, budgetPolicy, permissionPolicy,
retentionPolicy, createdAt, updatedAt, archivedAt
```

约束：

- `kind` 至少支持 `personal | office | education | research | software | opc | custom`。
- `resources` 可包含本地目录、文件集合、知识库和连接器；本地目录不得继续作为 Project 必选主键。
- 一个 Project 可没有代码仓库，也可以关联多个资源根。
- Project 删除和导出必须覆盖所有下属数据，不得只删除侧边栏记录。

### 7.3 Goal

**立项目标**：Goal 表达用户真正要完成的结果，而不是一条聊天消息。

建议字段：

```text
id, projectId, title, objective, background, constraints[],
successCriteria[], budget, dueAt, riskLevel, status,
createdBy, createdAt, updatedAt, completedAt
```

Goal 状态：

```text
draft → planned → running → waiting_approval | blocked | verifying
      → completed | failed | cancelled → archived
```

约束：

- `completed` 必须关联通过的 Acceptance 或显式 `waived`。
- Goal 的预算、限制和禁止事项向所有 WorkItem、DigitalWorker 和 Run 继承。
- Goal 不能以“所有子会话 idle”作为完成依据。

### 7.4 WorkItem

**立项目标**：WorkItem 是看板、依赖和执行的业务主对象；Session/Run 是执行明细。

建议字段：

```text
id, projectId, goalId, parentId, type, title, description,
dependencies[], priority, ownerRef, status, dueAt,
acceptanceSpec, artifactRefs[], runRefs[], createdAt, updatedAt
```

`type` 至少支持：

```text
research, analysis, planning, writing, design, coding,
review, testing, documentation, operations, delivery, custom
```

WorkItem 状态：

```text
backlog → ready → running → waiting_approval | blocked | verifying
        → done | failed | cancelled
```

约束：

- `done` 必须具有 Acceptance 结果。
- 依赖未满足的 WorkItem 不得进入 `running`。
- Board 状态必须由 WorkItem 状态驱动，不得由 SessionMeta 推断后永久保存。
- 一个 WorkItem 可有多个 Run 和 Attempt，但只能有一个当前有效执行 lease。

### 7.5 RoleTemplate

**立项目标**：RoleTemplate 是可复用岗位定义，不是模型配置。

建议字段：

```text
id, name, purpose, instructions, capabilityRefs[], skillRefs[],
toolPolicy, memoryPolicy, routingRequirements,
verificationPolicy, escalationPolicy, version, source
```

1.0 内置岗位模板至少覆盖：研究、策划、写作/编辑、数据分析、教学/课程、设计、开发、审查/测试和运营。

### 7.6 DigitalWorker

**立项目标**：DigitalWorker 是 RoleTemplate 在某个 Project 中的内部岗位实例。

建议字段：

```text
id, projectId, roleTemplateId, roleTemplateVersion,
displayName, avatarProfile, status, responsibilityScope,
capabilityOverrides, toolPolicy, memoryNamespace,
budgetPolicy, concurrencyLimit, schedulePolicy,
escalationPolicy, performanceProfile, createdAt, retiredAt
```

DigitalWorker 状态：

```text
proposed → active → paused → retired
```

硬性不变量：

- DigitalWorker 主键、名称和记忆不得包含 Provider/model 绑定语义。
- DigitalWorker 删除或退休不得删除 WorkItem、Run、Artifact、Evidence 或 Audit。
- Provider 被删除、禁用或故障时，DigitalWorker 必须保持存在。
- 头像、性格和显示名称只是体验属性，不得代替职责、权限、预算、记忆和验收模型。

### 7.7 Assignment

建议字段：

```text
id, workItemId, assigneeKind, assigneeId, scope,
assignedBy, assignedAt, releasedAt, reason
```

约束：

- `assigneeKind` 为 `digital_worker | human`。
- 1.0 以单用户 Project Owner 和 DigitalWorker 为主，多人协作属于后续规划。
- Assignment 改变负责人时保留历史，不覆盖旧记录。

### 7.8 Run

**当前已验证**：已有 TaskRun 状态、步骤、工具执行、Effect 和快照基础。

**立项目标**：扩展为统一执行记录：

```text
id, projectId, goalId, workItemId, digitalWorkerId,
sessionId, workflowId, status, revision, attemptCount,
lease, steps[], effects[], evidenceRefs[], artifactRefs[],
createdAt, startedAt, updatedAt, finishedAt, error
```

Run 状态沿用并统一：

```text
queued, planning, executing, waiting_approval,
waiting_reconciliation, verifying, recovering,
completed, failed, cancelled
```

### 7.9 ModelAttempt

**部分完成**：canonical ModelAttempt v1 已记录 Run/WorkItem 归属、逻辑 request/step、Provider/model/protocol、可读 route reason、usage、结果和不可变事件链；OpenAI-compatible 请求、模型 DAG 调用、Claude Agent SDK turn 与原生 Anthropic Messages 每次底层 HTTP 请求已接入，未知结果在重启后进入显式 retry/cancel 对账，密钥只保留安全标签或摘要。

**仍待完成**：真实 Provider 和 clean release-bound 证据、完整跨协议恢复阶梯，以及“每个正式运行时的每次底层 Provider 请求”与统一 Run/Context 契约的完整覆盖。

建议字段：

```text
id, runId, sequence, providerId, keyIdHash, model, protocol,
routeReason, capabilitySnapshot, budgetSnapshot,
status, usage, cost, latency, startedAt, finishedAt, failureClass
```

约束：

- Provider/model 切换只创建新的 ModelAttempt，不创建新员工、WorkItem 或 Goal。
- 路由原因必须可读，密钥值不得进入记录。
- 高风险任务发生能力降级时必须等待确认或启用独立复核，不得静默换成不满足能力的模型。

### 7.10 Artifact

Artifact 类型至少包括：

```text
report, source, requirement, design, document, spreadsheet,
presentation, code, patch, diff, test_report, screenshot,
pull_request, issue, release_package, custom
```

建议字段：

```text
id, projectId, goalId, workItemId, runId, kind, title,
uri, version, digest, mediaType, provenance,
createdAt, updatedAt, supersedesId
```

### 7.11 Evidence

Evidence 类型至少包括：

```text
source_citation, test_result, build_result, diff_review,
screenshot, remote_state, tool_result, reconciliation,
manual_confirmation, cost_record, custom
```

建议字段：

```text
id, projectId, runId, artifactId, kind, digest,
sourceRef, verifier, observedAt, generation, metadata
```

约束：Evidence 对高风险执行采用 append-only 语义；更正必须新增记录并引用被更正项。

当前实现状态：`task-snapshots.db` v8 保留 v6 TaskRun Effect evidence 的本地 hash-chain foundation，并包含 Goal/WorkItem/Run/Artifact/Acceptance/Evidence Link、workflow event chain、canonical recovery sessions、有限 API/IPC/UI 和 cursor 分页。Artifact Graph edge/location、关系/归属完整性、邻域查询、脱敏 export 和只读 diagnose/repair 已有 targeted smoke。Task Snapshot/TaskRun 恢复读取支持 `legacy`、`compare`、`canonical` 三态：compare 在两侧漂移时 fail-closed，canonical 从 Workflow Run/recovery session 读取；mode 按数据库路径隔离，运行时切换在 mutation queue 中 fresh revalidate 后才提交，未配置时默认 legacy。所有 Task Store open 共享按数据库路径隔离的 single-flight readiness；legacy JSON/旧 SQLite 迁移覆盖精确备份与 journal/checkpoint、候选校验、原子替换、崩溃续做和回滚恢复，future/corrupt source fail-closed。持久 `workflow_store_identity` 与 committed 高水位连续性会拒绝目标删除、截断、版本回退和同版本空库替换。该 cutover 只覆盖恢复读源；完整 Artifact Graph/blob/sourceRef/metadata 生命周期、所有入口与外部事件接入、Canonical Conversation Ledger、统一 retention/delete 和生产补偿仍未完成。

### 7.12 Acceptance

建议字段：

```text
id, goalId, workItemId, criteria[], status,
evidenceRefs[], verifier, verifiedAt,
waiverReason, waivedBy, notes
```

状态：

```text
pending → verifying → passed | failed
failed → verifying
pending → waived
```

`waived` 必须由用户显式操作并记录原因，不能由模型自动决定。

当前实现状态：failed Workflow Acceptance review 会按 Acceptance ID 与失败 revision 确定性创建同 Project/Goal/parent/owner 的 canonical repair WorkItem 和 Acceptance；并发重试幂等、绑定冲突 fail-closed，启动时会恢复已提交失败但缺失的 repair。repair 未进入 `done` 且未具备 `passed/waived` Acceptance 前禁止 retest；完成后原 Acceptance 清空本轮 Evidence/Verifier 并进入新的 `verifying` revision。结构化交叉验证失败与原生 `bash` 显式测试命令的非零退出失败已在严格 Session/Run/WorkItem/事件绑定下自动接入，并支持启动恢复；Acceptance policy authoring 与 review/evidence 选择 UI 已有真实 Electron required gate（创建、空 source 拒绝、按 criterion 匹配 Evidence、通过、重启一致性）；其他工具/引擎测试生产者、自动测试编排、自动 repair Run、独立 Verification 实体、repair/retest review UI、strong-kill 和最终交付关闭仍开放。

### 7.13 Approval

Approval 至少覆盖：工具权限、外部副作用、预算超限、能力降级、数据外发、验收豁免和持久交付。

建议字段：

```text
id, projectId, goalId, workItemId, runId, kind,
requestDigest, risk, status, requestedAt,
resolvedAt, resolvedBy, decision, scope, expiresAt
```

### 7.14 Routine

**当前已验证**：已有本地 Routine、cron、预算、Provider/model、权限和运行记录。

**立项目标**：Routine 改为引用 `projectId + digitalWorkerId? + goalTemplateId?`，到期后创建 WorkItem/Run；`projectCwd` 仅作为可选执行资源根，不再是业务归属主键。

## 8. 功能需求

### 8.1 Project Workspace

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| PROJ-001 | P0 | 当前已验证 | 可创建不要求本地目录的托管 Project Workspace，并经真实 Electron 验证编辑、归档、重启、恢复、导出、软删除和永久删除后的身份连续性。 |
| PROJ-002 | P0 | 当前已验证 | 本地目录、文件集合、仓库和连接器均为可选 first-class Resource，支持 Studio 增删、重启持久化、digest manifest 导出且删除关联不删除源。 |
| PROJ-003 | P0 | 当前已验证 | 稳定 Project ID 已成为跨 Store sealed aggregate 的统一身份；查询、授权、校验、导出、并发 seal、跨 Project 拒绝、重启、缺失/篡改、torn snapshot、Project-ID Memory IPC cutover 以及 ProjectWorkspace、DigitalWorker、Workflow Ledger、Memory 生产 mutation ingress 均由 27 项 required checks 覆盖，最新报告 `notProved=[]`。 |
| PROJ-004 | P0 | 部分完成（Workspace/Goal/WorkItem lifecycle foundation） | 项目导出、删除、归档和恢复覆盖所有下属对象。 |
| PROJ-005 | P1 | 立项目标 | 提供 `personal/office/education/research/software/opc/custom` 项目模板。 |
| PROJ-006 | P1 | 当前已验证 | 项目规则、背景、技术栈、命令、禁止路径、调度和验收可通过 `caogen.md` 编辑。 |
| PROJ-007 | P2 | 后续规划 | 多 Project Portfolio、跨项目依赖和资源计划。 |

### 8.2 Goal 和轻量项目管理

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| GOAL-001 | P0 | 当前已验证 | Goal Contract 已通过可信 Studio→preload→main→canonical command/event 全链路完成创建、编辑、终态归档、重启读回和恢复；主进程拒绝非法预算且无部分写入，stale revision 不能覆盖并发更新。 |
| GOAL-002 | P0 | 部分完成（production canonical read/write foundation） | Goal 必须支持目标、限制、预算、期限、风险和 Acceptance；生产 Goal list/get 已默认从 hash-chain verified rich view 读取，生产命令在保持 JSON 锁时先提交 Workflow Ledger、再投影 JSON，并可在三个强杀检查点恢复。完整策略执行与 UI 校验尚未闭环。 |
| WORK-001 | P0 | 部分完成（production canonical read/write foundation） | 支持 WorkItem 父子关系、依赖、优先级、状态、owner 和截止时间；生产 WorkItem list/get 已默认读取 verified rich view，生产命令已 canonical-first 并校验实体闭包、关系环和 Run 归属。List/Board 已由 WORK-002 单独闭环，完整控制语义和全业务入口 canonical 化仍开放。 |
| WORK-002 | P0 | 当前已验证 | canonical WorkItem List/Board 共用同一排序与筛选投影，支持 revision-guarded 持久重排、按 Project 保存视图/筛选、1,000 项固定尺寸虚拟化和重启一致性；required gate 已通过真实 Electron 两次启动验证。 |
| WORK-003 | P0 | 部分完成（canonical multi-Run invariant） | Run/session 只作为 WorkItem 明细展示，不得直接替代任务。当前本地 required smoke 已证明两个独立 Session Run 幂等共享一个 canonical WorkItem、启动重放不重复、Run 不可跨 WorkItem 漂移；完整 renderer→IPC→SessionManager 多入口 E2E 与 clean release 绑定仍开放。 |
| WORK-004 | P0 | 部分完成（repair/retest + WorkItem/Supervisor control slices） | Workflow Acceptance 失败会确定性创建 canonical repair WorkItem 与 Acceptance；Studio 已覆盖 WorkItem transition/lease。受信 main-process SessionManager 切片已把 Supervisor pause/cancel/resume/retry/reassign 接到同一 canonical TaskRun，并覆盖强 revision/lease/fencing 校验、retry 快照预检、发送门禁、stale revision、failed-resume blocking 与重启后门禁重建；Studio Supervisor UI、真实 Provider parity、预算/并发 enforcement、自动 repair、跨文件事务补偿与跨域强杀仍开放。 |
| WORK-005 | P1 | 立项目标 | 从自然语言 Goal 生成可审查 Workflow/DAG、依赖和 Acceptance 草案。 |
| WORK-006 | P1 | 立项目标 | 手工编辑计划后保留原计划版本和变更原因。 |
| WORK-007 | P2 | 后续规划 | 里程碑、Timeline、Gantt、Portfolio 和跨项目报表。 |

### 8.3 数字员工

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| TEAM-001 | P0 | 当前已验证 | RoleTemplate、DigitalWorker 和 Assignment 已具备原生持久模型、revision、Project scope、生命周期/历史、lease/fencing、重启恢复、跨 Project fail-closed 和 Assignment→WorkItem owner 协调。 |
| TEAM-002 | P0 | 当前已验证 | “招聘/加入团队”已通过当前 dirty checkout 的真实 Electron UI E2E 创建 CaoGen 原生 RoleTemplate/DigitalWorker、录入完整策略、分配 WorkItem，并跨重启证明无重复记录；招聘路径的外部 Agent CLI sentinel 为零调用，Provider/session/engine registry 保持不变。该结果不等于 clean release binding 或真实 Agent Run。 |
| TEAM-003 | P0 | 部分完成（policy persistence + execution guards） | 员工职责、权限、数据范围、预算、并发、验收和升级策略已持久化并进入 Studio；35 项 required checks 已覆盖 provider send、native tool、Claude tool authorization、Supervisor control 与 Assignment owner 的前置拒绝、重启恢复和拒绝时无 durable mutation。仍有五类 P0 绕过：Session/Run 未冻结 immutable workerId+assignmentId；OpenAI/Anthropic tool loop 后续请求与 Claude queued turn dispatch 不重检 Provider policy；`bash`、`gui_*`、`mcp_call_tool` 存在 composite capability 逃逸；Claude 仅靠 `canUseTool`，`bypassPermissions`/`allowedTools` 与未强制的 `PreToolUse` 仍可能绕过；monthly budget 依赖可截断/删除的 `sessions.json` 累计且漏算跨月 active session 与历史不可计费引擎。 |
| TEAM-004 | P0 | 立项目标 | 员工身份与 Provider/model 解耦，同一员工允许多个 ModelAttempt。 |
| TEAM-005 | P0 | 部分完成（retirement and Assignment history） | 退休员工不删除历史 Assignment、Run、Artifact、Evidence 和 Audit。 |
| TEAM-006 | P1 | 立项目标 | 根据 Goal 推荐 1 至 8 个必要岗位，默认避免无价值的多 Agent 扩张。 |
| TEAM-007 | P1 | 立项目标 | 提供岗位记忆命名空间、项目记忆读取范围和用户确认式学习。 |
| TEAM-008 | P1 | 立项目标 | 绩效以 Acceptance 通过率、返工、成本、时效和可靠性计算。 |
| TEAM-009 | P2 | 后续规划 | 团队模板市场、岗位版本共享和组织级岗位策略。 |

### 8.4 自动跨厂商模型路由

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| ROUTE-001 | P0 | 当前已验证 | 基于任务、规则、健康、预算、成本、质量和速度进行模型选择。 |
| ROUTE-002 | P0 | 当前已验证 | 同 Provider 多 Key failover 和跨 Provider failover。 |
| ROUTE-003 | P0 | 当前已验证 | Assistant 首次启动不显示 Provider/model/engine 选择；无计算资源时提供非技术可恢复状态，重试可零选择发现本地 Responses Provider，经真实 Router/stream path 完成发送，并无损切换 Studio 后返回同一 canonical session 与 draft。 |
| ROUTE-004 | P0 | 部分完成（Anthropic production-path local closure） | 每次路由形成 ModelAttempt 和可读 route reason；原生 Anthropic Messages 已接入可选 Engine/UI、每个 HTTP 请求独立 durable Attempt、NativeToolRuntime 工具循环、同 Provider Key/同协议 Provider failover 和图片重启恢复。真实 Provider、完整恢复阶梯、统一 Run/Context 契约与 clean release-bound 证据仍开放。 |
| ROUTE-005 | P0 | 立项目标 | Provider 切换保持 Goal、WorkItem、DigitalWorker、Run、上下文和 Artifact 连续。 |
| ROUTE-006 | P0 | 立项目标 | 预算、权限、隐私和能力要求高于成本/速度偏好，禁止不满足硬条件的候选。 |
| ROUTE-010 | P0 | 立项目标 | 故障恢复按“瞬时重试 → 同 Provider 换 Key → 同 Provider 换兼容模型 → 同协议健康 Provider → 跨协议 Adapter → 降级或人工处理”执行；每次请求形成可追踪 ModelAttempt，重放前检查未决 Effect。 |
| ROUTE-007 | P1 | 立项目标 | 高风险或低置信度任务可自动交叉验证并记录独立 Evidence。 |
| ROUTE-008 | P1 | 立项目标 | 专家模式允许固定模型、限制厂商、设置本地优先或禁止数据外发。 |
| ROUTE-009 | P2 | 后续规划 | 基于长期接受率和真实质量反馈优化路由，不以厂商毛利作为隐藏因素。 |

### 8.5 Native Runtime 和 Supervisor

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| RUN-001 | P0 | 当前已验证 | CaoGen 以冻结、Provider-neutral 的 `caogen.native-runtime.v1` 统一持有 Session、Run、Context、Tool、Permission、usage、error、checkpoint、hook 和 recovery；三内置引擎生产创建路径均强制套 runtime guard，TaskRun/事件/序列/stream/snapshot 身份与重启恢复 fail-closed。 |
| RUN-002 | P0 | 部分完成（adapter factories + boundary guards） | 三条生产 engine factory 已绑定独立协议 Adapter，请求/事件边界、resume sequence、runtime identity、Anthropic 请求/流/tool/usage/error normalization 与畸形 tool input fail-closed 已通过 required gate；原始 provider stream parsing 和 fragmented tool-call assembly 仍位于 `agentSession.ts`、`anthropicEngine.ts`、`openaiEngine.ts`，尚未达到纯协议 Adapter 隔离。 |
| RUN-003 | P0 | 部分完成（Anthropic production-path local closure） | 原生 Anthropic Messages 已注册到生产 SessionManager，并由本地门禁覆盖请求/流/用量/错误/取消、`tool_use/tool_result`、NativeToolRuntime 权限与 Effect、历史/图片重启恢复和保守 failover；OpenAI Responses、Chat Completions 与 Anthropic Messages 的统一 Run/Context/Checkpoint/Hook 契约、真实 Provider 和 clean release-bound parity 仍未整体关闭。 |
| RUN-004 | P0 | 部分完成（Supervisor foundation + identity/control bridge） | 本地 required gates 已覆盖持久 heartbeat、lease 过期接管、fencing、controls、approval/reconciliation、审计、重启读回、TaskRun→WorkItem/Supervisor 身份绑定，以及受控 SessionManager pause/cancel/resume/retry/reassign；canonical 控制强制 expected revision，lease 动作强制 lease ID/fencing token，retry 在状态提交前预检 durable snapshot，paused Run 在 SessionManager 重建后仍阻止普通发送/自动 replay，failed resume 转 blocked 并保持发送门禁。Studio UI、预算/并发 enforcement、自动编排、真实 Provider parity、跨文件事务补偿和跨域强杀恢复仍开放。 |
| RUN-005 | P0 | 立项目标 | Desktop 重启后恢复所有非终态 Run，并区分可重试和待对账；Supervisor IPC 的重启读回不等于强杀后全域恢复，仍需逐状态 strong-kill 门禁。 |
| RUN-006 | P0 | 立项目标 | 旧 Claude SDK 会话在迁移期可读、可导出、可从 CaoGen transcript fork，不伪称恢复隐藏上下文。 |
| RUN-007 | P1 | 立项目标 | 完成 Claude Agent SDK 退出门禁评估：Anthropic Adapter 等价、旧数据可读/可 fork/可回滚、兼容 Plugin/Skill/MCP 资产迁入 CaoGen 自有 store、真实条件验证和收益量化，并产出 Go/No-Go 结论。 |
| RUN-008 | P2 | 后续规划 | 独立后台服务、远程 Runner 和 Desktop 关闭后继续执行。 |
| RUN-009 | P2 | 后续规划 | 只有 RUN-007 给出 Go 且经过独立发布决策后，才分阶段移除 Claude Agent SDK；1.0 不预先承诺实际删除。 |

### 8.6 Trust、Effect 和审批

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| TRUST-001 | P0 | 当前已验证 | 主要文件编辑和 Git commit/merge/push 已有 Effect/Reconciler 基础。 |
| TRUST-002 | P0 | 立项目标 | 所有高风险入口必须注册 Effect 或明确 fail-closed。 |
| TRUST-003 | P0 | 立项目标 | PR、Issue、消息、可查询 MCP、Code Forge 和 Renderer 直接入口具备专用对账策略。 |
| TRUST-004 | P0 | 立项目标 | 未知结果不得自动重放；必须只读对账或等待人工确认。 |
| TRUST-005 | P0 | 部分完成（v8 recovery + production canonical Goal/WorkItem read/write foundation） | `task-snapshots.db` v8 保留 TaskRun Effect evidence append-only hash-chain，并包含 Goal/WorkItem/Run/Artifact/Acceptance/Evidence Link、workflow event chain、canonical recovery sessions、有限 API/IPC/UI、cursor 查询和 fail-closed 校验；生产 Goal/WorkItem list/get 已默认从 verified rich view 读取，生产命令已切为 Ledger-first、JSON 投影，并覆盖提交顺序、死进程锁回收与三个强杀恢复点。未配置时 Task Snapshot/Run 恢复仍默认 legacy；其他业务入口、完整 Artifact/blob/sourceRef 生命周期、Canonical Conversation Ledger、统一 retention/delete 和生产补偿计划/审批/执行仍待完成。 |
| TRUST-006 | P0 | 当前已验证（基础） | 新密钥的可逆 `b64:` 持久化 fallback 已移除并由主进程 Broker 提供；模型发现使用已存 Key 时已强制绑定保存的 Base URL、路由头、鉴权头名和协议，拒绝 renderer 替换网络目标。仍需完成 provider/project/session/operation/expiry 作用域和子进程最小环境。 |
| TRUST-007 | P1 | 立项目标 | 插件/MCP 安装、版本变化和能力扩大显示 provenance、digest 和 capability diff。 |

### 8.7 Artifact、Evidence 和交付

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| ART-001 | P0 | 部分完成（lifecycle contract + Code Forge producer） | canonical Artifact 生命周期已覆盖 16 种 required kind、digest/provenance/version/creating Run、supersession、blob/sourceRef、retention/purge、重启、字节篡改与跨 Project fail-closed；生产 Code Forge patch 已从 Effect confirmation 接入 Artifact lifecycle。report、document、screenshot、test、release、PR 及其他重要生产者仍未全部接入，不能视为“所有重要产物”闭环。 |
| ART-002 | P0 | 部分完成（Acceptance identity and evidence hardening） | `done/completed` 门禁已要求 Acceptance/Evidence，支持逐 criterion Evidence link、可选不可变 kind/source policy、live-store/event/source/Artifact byte 复核，以及冻结 Run 所属 Acceptance ID/revision 的受限 failure ingress；旧 Run 首次晚到不得漂移到新 revision。repair-derived policy 传播已覆盖新建、重复恢复和启动恢复；policy authoring 与 review/evidence 选择 UI 已由真实 Electron required gate 覆盖多 criterion kind/source、空 source 拒绝、按 criterion 匹配 Evidence、通过和重启一致性；其余生产者、repair/retest review 和不可变端到端交付链仍开放。 |
| ART-003 | P0 | 立项目标 | 支持调研→需求→设计输入→实现→审查→修复→测试→交付的阶段 Artifact 传递。 |
| ART-004 | P0 | 部分完成（repair/retest 本地基础闭环） | 审查失败已幂等创建 canonical repair WorkItem/Acceptance，启动时恢复缺失 repair，完成后清空本轮 Evidence/Verifier 并进入新的 verifying revision；repair Acceptance 现在继承并按 repair criterion ID 重新绑定原 policy 的 kind/source 约束。跨阶段 Artifact 交付、不可变端到端 Evidence 链、UI 和 release-bound 强杀证据仍开放。 |
| ART-005 | P1 | 立项目标 | 生成统一交付报告：目标、范围、改动、产物、测试、成本、风险、未完成项和审批。 |
| ART-006 | P1 | 条件可用 | GitHub/GitLab PR/MR 依赖 `gh`/`glab`、远端账号和权限；失败时保留 patch 或本地交付包。 |
| ART-007 | P2 | 立项目标 | 通用远端 Issue/Release 连接器必须具备明确账号范围、Effect/Reconciler 和失败恢复后再进入正式交付链；现有局部入口不等于通用支持。 |

### 8.8 Routines、记忆和 Skill

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| AUTO-001 | P1 | 当前已验证 | 本地 Routine、cron、运行记录、通知和防休眠。 |
| AUTO-002 | P1 | 立项目标 | Routine 到期后创建 WorkItem/Run，并关联 DigitalWorker 和 Project Inbox。 |
| AUTO-003 | P0 | 当前已验证 | 自动/模型 Memory、自动 Skill review 与 `optimize_skill` 统一先写入 project-scoped draft，记录来源、置信度、payload digest、完整 before/after diff 和目标路径；未批准草稿不会进入有效 Memory、prompt 或写入 `SKILL.md`。 |
| AUTO-004 | P0 | 当前已验证 | 仅主进程签发的可信用户决定可使 Memory/Skill 生效；统一生命周期支持 approve/reject、单调版本、revoke、rollback、expiry、delete、审计和重启恢复，Skill 物化采用 fail-closed journal；仅已批准且未过期的 Memory 进入 Anthropic、OpenAI Chat/Responses prompt。 |
| AUTO-005 | P2 | 后续规划 | 远程 Routine、跨设备通知和云端持续执行。 |

### 8.9 水墨轻动漫 3D 团队

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| VIS-001 | P0 | 当前已验证 | 3D 场景已消费真实会话、任务、审批、成本、Provider、worktree 和 Git 状态。 |
| VIS-002 | P1 | 立项目标 | 移除面向用户的机器人主角色，替换为原创或授权明确的水墨轻动漫人物。 |
| VIS-003 | P1 | 立项目标 | 角色身份表达岗位和 DigitalWorker，不表达厂商模型品牌。 |
| VIS-004 | P1 | 立项目标 | 角色动作、表情、工位和消息只由真实 WorkItem/Run/Approval/Artifact 事件驱动。 |
| VIS-005 | P1 | 立项目标 | 至少提供研究、策划、写作、设计、开发、审查/测试和运营的可区分人物形象。 |
| VIS-006 | P1 | 立项目标 | 保留状态色、图标、文字和形状多通道编码，水墨风格不得降低可读性。 |
| VIS-007 | P1 | 立项目标 | 支持自动 LOD、低性能模式和非 3D 列表回退；视觉不阻塞核心任务操作。 |
| VIS-008 | P2 | 后续规划 | 用户自定义服装、发型、空间主题和团队合影，不引入受版权保护的现有动漫 IP。 |

### 8.10 连接器和协作

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| CONN-001 | P1 | 当前已验证 | 插件、Skill、MCP 扫描、调用和基础治理。 |
| CONN-002 | P1 | 立项目标 | 连接器作为 Project Resource 或 Tool 接入，不成为外部 Agent 员工。 |
| CONN-003 | P2 | 后续规划 | Jira、Linear、Notion、飞书、Slack、Teams 等双向同步。 |
| COLLAB-001 | P2 | 后续规划 | 多用户、评论、提及、共享审批和组织策略。 |
| COLLAB-002 | P2 | 明确不做 | 1.0 不自建团队聊天、会议和完整协同办公套件。 |

## 9. 非功能需求

### 9.1 本地优先和隐私

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| NFR-PRIV-001 | P0 | 立项目标 | Project、Goal、WorkItem、Run、Artifact、Memory 和 Audit 默认本地保存。 |
| NFR-PRIV-002 | P0 | 立项目标 | UI 必须显示将发送给 Provider 的上下文范围；敏感资源可配置禁止外发。 |
| NFR-PRIV-003 | P0 | 立项目标 | API Key、访问令牌和证书不得进入 Renderer、转录、Artifact、Memory、导出包或普通日志。 |
| NFR-PRIV-004 | P0 | 当前已验证 | 本地模型和内网网关按与远端 Provider 相同的能力、预算、健康和 failover 规则参与自动/手动路由与交叉验证，不因位置或协议标签被降分；本地 Responses Provider 还通过真实 Electron 零选择发现、真实 Router/stream path 和 canonical session/draft 往返验证。 |

### 9.2 可恢复性和一致性

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| NFR-REC-001 | P0 | 立项目标 | 已向用户确认成功的数据写入不得因应用崩溃丢失。 |
| NFR-REC-002 | P0 | 立项目标 | 所有领域写入必须版本化、原子提交或具备事务/日志恢复。 |
| NFR-REC-003 | P0 | 立项目标 | 重启后 Board、Run、Effect、Approval、Artifact 和 Acceptance 状态一致。 |
| NFR-REC-004 | P0 | 部分完成（Supervisor lease/fencing foundation） | Supervisor 记录已证明并发 CAS、过期接管、陈旧 writer 拒绝和单调 fencing token；canonical WorkItem 的所有执行入口尚未共用同一 lease ownership/release 约束，不能宣称完整 WorkItem 执行 lease 保证。 |
| NFR-REC-005 | P0 | 立项目标 | 所有迁移支持预检、备份、幂等重跑和回滚。 |

### 9.3 可审计性

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| NFR-AUD-001 | P0 | 立项目标 | 用户能够回答“谁/哪个岗位、何时、为何、用什么模型、调用什么工具、产生什么结果”。 |
| NFR-AUD-002 | P0 | 立项目标 | Provider/model、路由原因、成本、审批、Effect 和 Evidence 可按 Run 查看。 |
| NFR-AUD-003 | P0 | 立项目标 | 日志显示 Key 标签或哈希标识，不显示明文凭据。 |
| NFR-AUD-004 | P1 | 立项目标 | 项目导出包含机器可读 manifest 和每个 Artifact/Evidence 的 digest。 |

### 9.4 性能和资源

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| NFR-PERF-001 | P1 | 当前已验证 | 参考设备上的真实 Electron required gate 覆盖 desktop/tablet/mobile 三种视口：3 个 fresh-process cold shell 样本 P95 `33.5ms`，60 个 warm 样本 P95 `34.1ms`。cold shell 必须首次可见、可聚焦、无遮挡且可真实操作；切换期间 Provider 响应保持挂起，Session/runtime/canonical Run/请求保持唯一且身份不变。Project/Goal/WorkItem 完整 hydration 仍为独立诊断 `1184.7–1478.6ms`，不属于 `<300ms` 声明；360px 项目操作区已由新截图确认无重叠。证据：`test-results/assistant-studio-performance/2026-07-22T14-12-03-432Z/report.json`。 |
| NFR-PERF-002 | P1 | 部分完成（1,000-item virtualization foundation） | 1,000 个 WorkItem 的 List/Board 已采用固定尺寸虚拟化并通过真实 Electron 有界 DOM 验证；参考设备上的初次可交互 P95 <1s 仍待独立测量。 |
| NFR-PERF-003 | P1 | 立项目标 | 路由本地决策目标小于 500ms，不含 Provider 网络请求。 |
| NFR-PERF-004 | P1 | 立项目标 | 3D 在定义的参考设备和 12 个可见员工场景保持可交互；不达标时自动降级 LOD 或列表。 |
| NFR-PERF-005 | P1 | 立项目标 | 3D 未激活时限制帧率和资源占用，不得影响正在执行的任务。 |

### 9.5 可用性和可访问性

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| NFR-UX-001 | P0 | 立项目标 | Assistant 不暴露 Provider、Token、MCP、Git、DAG 等非必要术语。 |
| NFR-UX-002 | P0 | 立项目标 | 待审批、失败、未知副作用和验收失败在两种模式均可见。 |
| NFR-UX-003 | P1 | 立项目标 | 核心流程全键盘可达，图标按钮具备名称和 tooltip。 |
| NFR-UX-004 | P1 | 立项目标 | 状态不能只依赖颜色，必须同时使用文字、图标或形状。 |
| NFR-UX-005 | P1 | 立项目标 | 中文和英文文案不得溢出、遮挡或改变固定控制布局。 |

### 9.6 厂商中立

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| NFR-NEUTRAL-001 | P0 | 当前已验证 | DigitalWorker、Goal 和 WorkItem 的 schema 不含 Provider/model/engine 身份字段；DigitalWorker create/update 与 v1/v2 read/migration 对嵌套厂商身份污染 fail-closed，拒绝时 Store/Worker revision 不变。 |
| NFR-NEUTRAL-002 | P0 | 立项目标 | 路由策略以用户设定的能力、质量、成本、速度、健康、隐私和预算为依据。 |
| NFR-NEUTRAL-003 | P0 | 当前已验证 | Provider 商业名称、Provider 身份、Base URL、预算元数据和创建时间不得改变 Router 评分或选择；完全同分时以稳定 `providerId + model` 决胜，输入顺序不能影响自动路由、model-only override、cross-validation 或 hard-budget fallback。 |
| NFR-NEUTRAL-004 | P1 | 立项目标 | Provider Adapter 可独立增加、禁用和测试，不修改领域模型。 |

### 9.7 可维护性和测试性

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| NFR-ENG-001 | P0 | 立项目标 | 领域模型、协议 Adapter、Runtime、Trust、Persistence 和 UI 状态分层。 |
| NFR-ENG-002 | P0 | 立项目标 | 所有 schema 具有版本号和迁移测试。 |
| NFR-ENG-003 | P0 | 当前已验证 | Required 测试不得通过 skip/blocked 伪装为 pass。 |
| NFR-ENG-004 | P1 | 部分完成（102/102 structure map） | 每个 P0/P1 需求至少映射一个自动测试或明确的真人验收脚本。 |
| NFR-ENG-005 | P1 | 立项目标 | 关键恢复和副作用测试必须包含强杀、断网、重复事件和乱序事件。 |

## 10. 异常与边界处理

### 10.1 无可用 Provider

- Assistant：明确显示“当前没有可执行模型”，提供添加 Provider、本地模型或稍后重试入口。
- Studio：显示所有候选被排除的原因，包括健康、能力、预算、隐私和权限。
- 不得自动创建空白员工或伪造已执行结果。

### 10.2 全部 Provider 不健康

- Router 可在用户策略允许时选择最可执行候选，但必须显示警告和 route reason。
- 高风险任务不得在能力未知或明显不足的模型上静默继续。
- 失败切换创建新 Attempt，不改变员工和任务身份。

### 10.3 预算超限

- 阻止新的高成本 Attempt。
- 提供降低质量、缩小范围、增加预算或取消任务的明确选择。
- 已执行成本保留在 Run/Audit，不因取消而消失。

### 10.4 权限被拒绝

- WorkItem 进入 `waiting_approval` 或 `blocked`，记录拒绝原因和影响范围。
- 系统可提出无副作用替代方案，但不能绕过用户拒绝。

### 10.5 崩溃发生在副作用期间

- Effect 进入 `waiting_reconciliation` 或等价未知状态。
- 重启后先只读检查外部状态，再决定确认、补偿或人工处理。
- 不得将“没有收到返回值”视为“没有执行”。

### 10.6 Project Resource 不存在

- Project 仍可打开，缺失资源标记为 unavailable。
- 不删除 Goal、WorkItem、Artifact 索引、员工或历史。
- 提供重新定位、移除资源引用和只读查看历史的选项。

### 10.7 DigitalWorker 被暂停或退休

- 未开始 Assignment 可重派。
- 正在运行的 Run 必须由用户选择继续、暂停、取消或转交，不得静默接管。
- 历史数据保持不变。

### 10.8 Assistant/Studio 切换失败

- 当前任务继续运行。
- UI 回退到切换前模式，并显示可重试错误。
- 领域 store 不回滚或复制。

### 10.9 连接器或外部 CLI 不可用

- 保留本地 Artifact 和待交付动作。
- 提供导出文件、复制 URL/命令或稍后重试方式。
- 不得将远端失败标记为整体 Goal 完成。

### 10.10 验收无法自动执行

- Acceptance 保持 `pending`，请求用户人工确认。
- 用户可通过或豁免，但必须记录 Evidence 或 waiver reason。

## 11. 数据保留、导出和删除

### 11.1 数据所有权

- Project 是 Goal、WorkItem、DigitalWorker、Run、Artifact、Evidence、Acceptance、Memory 和 Audit 的所有权边界。
- RoleTemplate 可为全局模板，但 DigitalWorker 和其绩效属于 Project。
- Provider 凭据属于本机安全配置，不属于任何项目导出。

### 11.2 默认保留

**立项目标**：

- Project、Goal、WorkItem、Artifact、Acceptance 和关键 Audit 默认保留至用户显式删除。
- 转录、Run、Effect 和 Evidence 默认随 Project 保留，允许项目级策略缩短周期。
- 可再生缓存、缩略图和临时预览使用可配置 TTL，默认 30 天。
- worktree 不得因归档或超时被静默强制删除；只提示清理并要求确认。
- 自动学习的 draft 可设置过期时间，过期不自动进入确认层。

### 11.3 导出

项目导出至少包含：

- Project manifest 和 schemaVersion。
- Goal、WorkItem、Assignment、DigitalWorker、Run 摘要和状态。
- Artifact、Evidence、Acceptance、Memory 和 Audit。
- 文件相对路径、媒体类型、digest、版本和来源。
- 不包含 API Key、Token、系统凭据、外部账号 Cookie 和无关环境变量。

### 11.4 删除

- 普通删除先进入本地回收状态，默认保留 30 天；用户可立即永久删除。
- 永久删除前显示对象数量、Artifact 大小、外部资源不会被删除的边界和不可逆提示。
- 删除 Project 不得删除用户原始本地目录、Git 仓库或外部 SaaS 数据，除非另有明确、逐项审批的删除操作。
- 审计保留与隐私删除冲突时，以用户选择和适用部署策略为准，并记录删除证明。

## 12. 迁移与兼容

### 12.1 迁移原则

- 所有迁移有 `fromVersion/toVersion`、预检、备份、迁移日志和 rollback plan。
- 迁移必须幂等；应用被强杀后可继续或安全回滚。
- 不识别的旧字段保留在兼容区，不能静默丢弃。
- 迁移结果必须有数量、digest 和失败清单。

### 12.2 当前 Project 迁移

当前目录型 `Project { id, name, path, lastUsedAt, archived }` 迁移为：

- `ProjectWorkspace.kind = software`。
- `path` 转为 `resources[{ kind: local_folder, path }]`。
- 原 `id/name/archived/lastUsedAt` 保持。
- 原项目规则、记忆和会话通过 `projectId` 继续关联。

### 12.3 未关联会话迁移

- 未关联会话继续保持 `unassigned`，或在用户确认后关联到系统 Personal Workspace。
- 不得自动猜测并写入错误项目。

### 12.4 DAG 和角色迁移

- 旧 `TaskDagRole` 映射到内置 RoleTemplate。
- 新任务使用 `taskKind + roleProfileId`，保留旧 `role` 作为兼容字段。
- 旧 DAG Execution 可只读查看，并允许生成新的 WorkItem/Run 继续执行。

### 12.5 Routine 迁移

- `Routine.projectCwd` 匹配已迁移 Project Resource 时写入 `projectId/resourceId`。
- 无法匹配时保留原路径并标记 `needs_project_assignment`。
- 原 schedule、预算、权限、Provider/model 和运行历史保持；Provider/model 逐步转为 routing preference，不再作为员工身份。

### 12.6 Session、Run 和历史引擎迁移

- 原 SessionMeta、HistoryEntry、TaskRun 和 Snapshot 保持可读。
- 新 WorkItem/Run 关联可采用惰性迁移，不强迫一次性重写全部大文件。
- 旧 `engine: claude` 会话在 Claude SDK 退出前继续按兼容策略处理。
- SDK 被移除后，旧会话允许只读、导出和从 CaoGen transcript fork；不得伪称恢复 SDK 未记录的隐藏上下文。

### 12.7 视觉设置迁移

- 当前机器人/角色外观设置映射到新的默认水墨人物配置。
- 用户的画质、Badge、动效强度和布局偏好尽量保留。
- 旧资产仅在迁移和回滚窗口内保留，不再作为 1.0 用户主视觉。

## 13. 端到端验收场景

### AC-01 Assistant 普通知识任务

**前置**：用户已配置任一可用 Provider。
**操作**：在 Assistant 输入“基于附件生成一份带来源的会议决策纪要”。
**通过条件**：用户无需选择模型；系统生成 Artifact、来源 Evidence 和可修改结果；未暴露不必要的技术配置。

### AC-02 教育项目

**操作**：教师创建无目录 Project，提交“设计四周课程并生成教案、练习和评分标准”。
**通过条件**：形成 Goal、WorkItems、至少三类 Artifact 和 Acceptance；可在 Assistant 查看摘要，在 Studio 查看完整任务和证据。

### AC-03 OPC 产品目标

**操作**：用户提交“调研市场、形成需求、实现网站、测试并准备发布”。
**通过条件**：阶段 Artifact 自动交接；实现、审查、修复和复验形成闭环；最终交付报告列出成本、风险和未完成项。

### AC-04 数字团队招聘

**操作**：为一个 Goal 接受研究员、策划、开发和测试岗位。
**通过条件**：创建四个 DigitalWorker；每个员工有职责、权限、预算和验收；没有安装或启动外部 Agent CLI。

### AC-05 员工跨 Provider 连续性

**操作**：同一 DigitalWorker 先执行调研，再执行写作；路由使用两个不同 Provider。
**通过条件**：DigitalWorker ID、记忆和 Assignment 连续；仅新增 ModelAttempt；Board 没有重复任务。

### AC-06 Provider 故障切换

**操作**：在同一 Run 依次注入瞬时网络错误、Key 鉴权失败、模型不可用、Provider 5xx，并提供可用的同协议与跨协议候选。
**通过条件**：严格按“重试 → 换 Key → 同 Provider 换模型 → 同协议换 Provider → 跨协议接管 → 人工处理”推进；每次请求有独立 ModelAttempt 和 route reason；Goal、WorkItem、Run、员工身份和 Canonical Context 不变；不会重复已确认或结果未知的 Effect。

### AC-07 双模式无损切换

**操作**：Run 执行中在 Assistant 和 Studio 间往返切换。
**通过条件**：没有新会话、新 Goal、新上传或任务重启；审批和实时输出连续；两种模式最终状态一致。

### AC-08 崩溃恢复

**操作**：在文件写入、Git 或外部动作边界强杀应用并重启。
**通过条件**：系统恢复 Run；已确认动作不重复；未知动作进入 reconciliation；用户可查看 Evidence 和恢复决定。

### AC-09 Acceptance 门禁

**操作**：子任务自述完成，但测试失败。
**通过条件**：WorkItem 进入 `failed` 或重新修复，不得进入 `done`；通过复验后才完成。

### AC-10 Routine 任务化

**操作**：创建每日研究 Routine 并绑定研究员。
**通过条件**：到期生成 WorkItem/Run；结果进入 Project Inbox 和 Artifact；失败或待审批有通知；运行记录可恢复。

### AC-11 员工退休

**操作**：退休已有历史工作的 DigitalWorker。
**通过条件**：不能再接受新 Assignment；历史 Goal、WorkItem、Run、Artifact、Evidence 和绩效仍可查看和导出。

### AC-12 旧数据迁移

**操作**：使用包含项目、会话、Routine、DAG、记忆和旧 Claude 会话的真实用户数据升级。
**通过条件**：迁移前后数量和关联可核对；失败可回滚；旧会话至少可读/可导出；原目录未被修改或删除。

### AC-13 项目导出与删除

**操作**：导出 Project 后执行永久删除。
**通过条件**：导出包包含 manifest/digest 和完整业务对象，不含凭据；删除只清除 CaoGen 数据，不删除原始目录或外部系统数据。

### AC-14 水墨数字团队

**操作**：打开包含至少 12 个员工及运行、审批、失败、完成状态的 3D 场景。
**通过条件**：用户可通过人物、文字、图标和形状识别岗位与状态；动作来自真实事件；无机器人主角色；性能不足时自动降级且核心操作可用。

## 14. 1.0 发布验收总表

| 验收项 | 门槛 |
|---|---|
| 产品定位 | 黄金路径不要求启动、切换或管理外部 Agent CLI。 |
| 双模式 | Assistant/Studio 使用同一状态，专项一致性测试 100% 通过。 |
| 数字员工 | 身份与模型解耦；跨 Provider、退休、恢复测试通过。 |
| 项目管理 | Goal/WorkItem/List/Board/Assignment/Acceptance 可完成真实项目。 |
| 自动路由 | 默认人工选模型次数为 0；路由原因、预算和 failover 可审计。 |
| 可恢复 | 崩溃、断网、Provider 故障和未知副作用测试通过。 |
| 可验证 | 所有完成项有 Evidence/Acceptance 或显式 waiver。 |
| 数据 | 迁移、导出、删除、回滚和凭据排除测试通过。 |
| 视觉 | `VIS-002` 至 `VIS-007` 为指定 P1 发布门禁：水墨轻动漫角色消费真实状态；可读性、性能和回退测试通过，机器人不再作为面向用户的主角色。 |
| 真人验证 | 办公/教育与技术/OPC 至少各一条真实端到端流程通过。 |
| N1 | 真人 30 分钟主链路证据完成；未完成前不得宣称达标。 |
| 测试纪律 | Required 不得以 skip/blocked 通过；所有条件能力明确标注环境。 |

## 15. 明确不做

- **明确不做**：外部 Agent/CLI 招聘、安装、进程调度和 daemon 运行平台。
- **明确不做**：把模型、Provider 或引擎等同于数字员工。
- **明确不做**：1.0 完整人力资源、工资、考勤、合同和组织编制。
- **明确不做**：1.0 完整 Jira/Linear/飞书/Notion 替代品。
- **明确不做**：1.0 多人实时文档、聊天、会议和协同办公套件。
- **明确不做**：通过隐藏模型差价或路由偏置锁定用户。
- **明确不做**：没有 Evidence 的自动完成、没有用户操作的验收豁免。
- **明确不做**：用随机动画、装饰消息或静态头像伪造数字员工工作。
- **明确不做**：未经等价能力、数据迁移和恢复验证直接硬删 Claude Agent SDK。
- **明确不做**：未验证前宣称 Office 像素级编辑、任意外部系统 exactly-once 或完全自治交付。

## 16. 追踪与派生文档

实现阶段应从本文派生并维护：

- 领域模型与持久化 schema。
- Native Runtime 与协议 Adapter 架构。
- Project/Session/Routine/DAG/Claude 历史迁移方案。
- Assistant/Studio 信息架构和交互原型。
- 数字员工岗位模板、权限和绩效规则。
- 水墨轻动漫角色视觉规范、资产授权和性能预算。
- Trust Kernel、Effect/Reconciler 和恢复测试矩阵。
- 1.0 Roadmap、发布 Gate、真人验收脚本和商业验证计划。

相关当前文档：

- [`STATUS.md`](../STATUS.md)：当前事实与阻塞。
- [`README.md`](../README.md)：当前公开能力。
- [`PRODUCT-TECHNICAL-REQUIREMENTS.md`](./PRODUCT-TECHNICAL-REQUIREMENTS.md)：产品技术约束和完成定义。
- [`SECURITY-AND-RISK.md`](./SECURITY-AND-RISK.md)：安全边界、风险登记和发布门禁。
- [`HIGH-LEVEL-DESIGN.md`](./HIGH-LEVEL-DESIGN.md)：组件、数据、状态机、迁移和恢复设计。
- [`ROADMAP.md`](../ROADMAP.md)：现有路线，应按本需求重新校正。
- [`DESIGN-V2.md`](../DESIGN-V2.md)：现有深度用户迁移设计，部分 SDK 假设需重新评估。
- [`docs/COMPETITOR-GAP-ANALYSIS.md`](./COMPETITOR-GAP-ANALYSIS.md)：当前竞品与系统缺口。
- [`docs/AGENT-WORK-OS-PARALLEL-PLAN.md`](./AGENT-WORK-OS-PARALLEL-PLAN.md)：现有 Work OS 阶段实施基础。
