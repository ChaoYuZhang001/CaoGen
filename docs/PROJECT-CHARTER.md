# CaoGen 1.0 项目立项书

> 文档状态：立项基线候选版 1.0
> 更新日期：2026-07-18
> 事实基线：以 [`STATUS.md`](../STATUS.md) 的当前实测口径为准
> 适用范围：CaoGen 产品、设计、架构、开发、测试、发布与商业决策

## 1. 状态标记

本文统一使用以下五种状态，任何产品、设计、销售或发布材料不得省略其成立条件：

| 标记 | 含义 |
|---|---|
| **当前已验证** | 已存在于当前主分支，并有代码、测试、构建、运行证据或发布证据支持。 |
| **条件可用** | 已有实现，但依赖特定平台、账号、Provider、外部 CLI、权限、额度或受限运行环境。 |
| **立项目标** | 本次 CaoGen 1.0 正式立项承诺建设并验收的能力，不得描述为当前已完成。 |
| **后续规划** | 不阻塞 1.0，可在产品验证后进入 2.0、团队版或企业版。 |
| **明确不做** | 与产品定位冲突、投入产出不成立，或在当前阶段主动排除。 |

## 2. 项目摘要

### 2.1 项目名称

**CaoGen 1.0：本地优先、厂商中立、可恢复、可审计的 Agent Work OS**

### 2.2 立项结论

**立项目标**：将现有“多厂商 AI 工作桌面”升级为目标驱动的 Agent Work OS。用户只需管理目标、边界、预算、审批与验收；CaoGen 负责组织模型算力、数字员工、任务、工具、上下文、恢复、证据和交付。

本项目不是把多个外部 Agent 或 CLI 放进一个启动器，也不是要求用户在 Gemini、Claude、Codex、OpenCode 等品牌之间手动接力。不同厂商和模型只作为 CaoGen 内部可替换的算力来源。

### 2.3 一句话定位

> **用户提交目标，CaoGen 组织数字员工、模型和工具，持续产出可恢复、可审查、可验收的结果。**

### 2.4 北极星

**立项目标**：每周每位活跃用户完成的“无需外部 Agent 接力、带有效验收证据的目标交付数”，即 `Weekly Verified Goal Deliveries`。

现有 N1“真实重度 AI 工作者 30 分钟内跑通日常主链路”继续作为激活和迁移指标，不作为产品使命本身。

## 3. 立项背景

### 3.1 原始问题

目标用户当前常见工作链路如下：

1. 使用研究型 Agent 或搜索产品做市场调研。
2. 切换模型完成需求分析和方案设计。
3. 切换设计工具生成界面或视觉稿。
4. 切换代码 Agent 实现功能。
5. 再切换模型或 Agent 做审查、修复和测试。
6. 因价格、额度、网络或能力差异，再切换其他海外或国内厂商模型。

每次切换迁移的并不只是提示词，而是项目文件、历史对话、规则、权限、工具状态、费用账户、产物、验证证据和未完成任务。用户的核心负担是上下文断裂和执行责任分散，而不是缺少更多 Agent 图标。

### 3.2 根因

- 厂商 Agent Desktop 通常围绕自家模型、账号、生态和算力建立默认路径。
- 不同产品拥有各自的会话、工具、记忆、权限和产物模型。
- 外部 Agent 聚合器能够减少启动成本，但仍把 Agent 品牌和运行时暴露给用户管理。
- 通用项目管理工具可以管理任务，却通常不持有模型执行、工具副作用、恢复和证据链。
- 单一聊天界面可以回答问题，但难以承载跨天、跨阶段、带审批和验收的复杂目标。

### 3.3 机会判断

**立项目标**：CaoGen 将“模型选择”“Agent 选择”“工具切换”和“项目交接”下沉为系统内部决策，将用户工作对象统一为 Project、Goal、WorkItem、DigitalWorker、Artifact、Evidence 和 Acceptance。

## 4. 当前基础与事实边界

### 4.1 当前已验证

依据 [`STATUS.md`](../STATUS.md)、[`README.md`](../README.md) 与当前测试门禁，CaoGen 已具备以下基础：

- 多 Provider、多 API Key、自定义 Base URL、OpenAI-compatible 协议和可选 Claude Agent SDK 路径。
- 按任务、项目规则、预算、健康状态、成本、质量和速度进行模型路由，并支持同 Provider 密钥切换与跨 Provider failover。
- 项目和未关联项目会话收纳、项目规则、项目记忆、历史会话和会话恢复。
- 真实 child sessions、最多 33 个子任务、DAG、重试、worktree 隔离、结果回传与可选自动合并。
- 终端、文件、Diff、Git、浏览器、预览、Office 结构提取、插件、Skill、MCP 和 IDE Bridge 基础能力。
- 持久 Task Run、Effect Ledger、资源 lease/fencing、部分文件和 Git 副作用对账及强杀恢复；`task-snapshots.db` v8 保留 v6 TaskRun Effect evidence append-only hash-chain foundation，并包含 Goal/WorkItem/Run/Artifact/Acceptance/Evidence Link、workflow event chain、canonical recovery sessions 和持久 `workflow_store_identity`。Task Snapshot/TaskRun 恢复读取支持按数据库路径隔离的 `legacy / compare / canonical` 三态，mode flip 强制重新验证，committed journal 校验 store identity 与历史高水位。显式对象已有有限 main API、IPC/preload、Control Center 查询/校验和 cursor 分页，并由 targeted smoke 覆盖。
- 本地 Routine、运行记录、通知、防休眠、开工建议和分层记忆。
- 3D 办公区能够消费真实会话、任务、Provider、成本、审批、工具、worktree 和 Git 状态。

### 4.2 条件可用

- Claude 专项能力依赖有效 Anthropic 凭据、兼容网关或本机登录态；Claude 不是默认必需项。
- PR/MR、远程仓库和部分交付动作依赖 `gh`、`glab`、账号登录和远端权限。
- GUI 自动化默认关闭，且需要明确权限；平台覆盖和真实应用兼容性仍需分别验证。
- Office 文档当前以结构提取、系统预览和 best-effort 渲染为主，不等价于原应用像素级编辑能力。
- 正式签名、公证、Apple Silicon 真机启动、部分真实 Provider 和中国网络证据受外部条件限制。

### 4.3 当前未完成

- v8 已具备 Task Snapshot/TaskRun 的 canonical recovery-session/read-mode cutover，但未显式配置时仍默认 legacy，且该 cutover 只覆盖恢复查询面。所有业务入口和外部事件尚未统一进入 canonical command/event path；完整 Goal/WorkItem/Artifact 生命周期、Artifact Graph/blob/sourceRef、Routine 与 DigitalWorker/Assignment、Canonical Conversation Ledger、保留/导出/修复和生产补偿仍未闭环。
- 当前 Project 仍主要是目录与会话容器，不是通用 Project Workspace。
- 当前任务看板主要展示会话和 DAG 执行，不是完整项目任务控制面。
- 没有 CaoGen 原生的 DigitalWorker 生命周期、招聘、职责、权限、绩效和岗位记忆模型。
- 没有完整的“调研→需求→设计→实现→审查→修复→测试→交付”持久阶段状态机。
- 跨 Provider 的 Canonical Conversation Ledger、完整后台 Supervisor 和关闭桌面后的持续执行尚未闭环。
- 外部 PR、Issue、消息、MCP、Code Forge 等副作用仍未全部接入专用 Reconciler。
- 3D 角色当前不是本立项要求的水墨轻动漫人物；水墨视觉属于目标，不属于现状。

## 5. 产品愿景与原则

### 5.1 愿景

让个人和小团队拥有一套不依赖单一模型厂商的 AI 工作操作系统：它可以理解目标、组建内部数字团队、自动选择算力、执行工具、跨阶段保留上下文，并以证据完成交付。

### 5.2 不可改变的原则

1. **CaoGen 拥有工作状态**：Goal、任务、上下文、产物、权限、记忆、成本、证据和验收归 CaoGen 管理。
2. **模型只是算力**：Provider、模型和协议属于 Run 内部的 Model Attempt，不成为顶层员工或用户工作对象。
3. **一个内核，两种体验**：Assistant 和 Studio 共享同一数据、会话、任务和运行状态。
4. **本地优先**：代码、文件、项目数据和执行账本默认保存在本地；外发内容必须可解释。
5. **恢复优先**：崩溃、断网、Provider 故障和人工暂停后，系统必须知道做过什么、下一步是什么、哪些副作用未知。
6. **证据优先**：完成不能只依赖模型自述；测试、来源、Diff、截图、远端状态或用户验收必须形成证据。
7. **渐进披露**：普通用户默认看目标和结果，技术用户可展开任务、模型、工具、Diff、成本和审计细节。
8. **真实可视化**：3D 场景只展示真实状态，不制造虚假协作、虚假员工或虚假完成动画。

## 6. 目标用户

### 6.1 用户群 A：企业白领、学生、教师和普通用户

主要任务：

- 报告、邮件、会议纪要、表格分析、演示文稿和资料整理。
- 学习计划、教材讲解、练习、错题复盘、教案、课件和评分标准。
- 带来源的研究、文件问答、决策备忘录和周期性信息整理。

默认体验：Assistant。界面隐藏 Provider、Token、MCP、Git、终端和 DAG，只展示目标、进度、审批、来源和产物。

### 6.2 用户群 B：技术人员、OPC、一人公司和 Vibe Coding 用户

主要任务：

- 从市场调研、需求、设计输入到代码、测试、部署准备的产品闭环。
- 多任务并行、worktree 隔离、Diff 审查、Git、PR/MR 和自动化。
- 一人公司的网站、产品、内容、运营、客户资料和周期性业务工作。

默认体验：Studio。界面提供 Goal、Board、文件、终端、Diff、浏览器、DAG、数字员工、成本、证据和审批控制面。

### 6.3 模式不是用户等级

Assistant 与 Studio 按当前任务切换，不按职业永久锁定。教师可以为复杂课程项目进入 Studio，技术用户也可以用 Assistant 快速写邮件。模式切换不得复制会话、重启任务或丢失状态。

## 7. 核心价值主张

| 用户问题 | CaoGen 价值 |
|---|---|
| 多个 Agent 和 Desktop 反复切换 | 一个 CaoGen 入口和统一工作状态。 |
| 不同模型各有所长且费用差异大 | 自动跨厂商路由、预算控制、健康检测和故障切换。 |
| 长任务中断后不知道做到哪里 | 持久 Goal/Run/Effect/Evidence 账本和可恢复 Supervisor。 |
| 多 Agent 并行后难以合并和验收 | 内部数字员工、DAG、隔离工作区、Artifact 和 Acceptance。 |
| 普通用户看不懂开发者控制项 | Assistant 渐进披露；复杂任务可无损切换 Studio。 |
| Agent 自称完成但没有证据 | 所有完成状态绑定 Evidence、Artifact 和验收规则。 |
| 3D 场景好看但不能管理工作 | 水墨轻动漫角色承载真实岗位、任务、审批、阻塞和交付状态。 |

## 8. 竞品差异

| 类别/产品 | 核心对象 | 典型价值 | CaoGen 的区别 |
|---|---|---|---|
| 厂商 Agent Desktop | 自家模型、会话和工具生态 | 降低自家模型使用门槛 | CaoGen 不以销售单一厂商算力为产品目标，路由必须受用户质量、成本、速度和隐私策略约束。 |
| [Tutti](https://github.com/tutti-os/tutti) 类共享工作区 | 多个外部 Agent | 共享会话、文件和应用产物 | CaoGen 不要求用户管理多个外部 Agent；CaoGen 自己持有任务、上下文和交付状态。 |
| [Multica](https://multica.ai/) 类 Agent 管理平台 | 外部 Agent 员工、Issue 和 Runtime | 组织 Agent 劳动力与长期自动化 | CaoGen 的数字员工是内部岗位实例，不是 Claude Code、Codex、Gemini CLI 等外部进程。 |
| 通用项目管理 | 人、任务、看板、流程 | 组织协作和进度管理 | CaoGen 只建设与目标执行直接相关的轻量项目管理，并原生连接模型、工具、证据、恢复和交付。 |
| 单一聊天助手 | 对话和文件 | 快速问答与内容生成 | CaoGen 在保持 Assistant 简洁体验的同时，提供可持久执行和可检查交付的 Studio。 |

战略表达：

> Tutti 让多个 Agent 共享空间，Multica 管理多个 Agent 员工；CaoGen 的目标是让用户不必管理多个 Agent，只管理目标和验收。

以上用于说明立项类别边界，不代替对外部产品逐版本、逐功能的实时审计。

## 9. 产品范围

### 9.1 立项目标：CaoGen 1.0 必须交付

1. **统一 Project Workspace**：支持代码、办公、教育、研究和 OPC 项目；本地目录从必选主键变为可选资源根。
2. **Goal Contract**：记录目标、背景、约束、预算、期限、风险、审批和验收标准。
3. **轻量项目管理**：WorkItem、父子任务、依赖、优先级、负责人、状态、Board/List、Artifact 和 Acceptance。
4. **内部数字员工**：岗位模板、项目内员工实例、职责、能力、权限、记忆、预算、并发、调度和绩效证据。
5. **Assistant/Studio 双模式**：同一内核和状态，支持无损切换和渐进披露。
6. **自动跨厂商模型路由**：默认不要求用户选择 Provider、模型或引擎；专家模式可查看和覆盖。
7. **持久 Workflow Ledger**：统一 Goal、WorkItem、Run、Attempt、Effect、Artifact、Evidence、Approval 和 Acceptance。
8. **Native Runtime 统一语义**：逐步将会话、工具、权限、Hooks、Checkpoint 和恢复收归 CaoGen；协议 Adapter 只处理厂商 API 差异。
9. **可验证交付**：调研来源、需求、设计输入、代码、Diff、测试、PR/MR 和交付报告进入统一 Artifact/Evidence 体系。
10. **本地 Supervisor**：任务可暂停、取消、恢复、等待审批、重试和重启后继续。
11. **水墨轻动漫 3D 团队**：角色、岗位、表情、动作和场景状态由真实 DigitalWorker/WorkItem/Run 驱动。
12. **迁移与兼容**：现有项目、会话、Routine、DAG、历史引擎数据和项目规则可读取、迁移和回滚。

### 9.2 条件可用能力的收口目标

- 将依赖外部登录、CLI 或平台权限的功能明确标注条件，不允许静默失败。
- 为 PR、Issue、消息、MCP、Code Forge 和 Renderer 直接入口补齐 Effect/Reconciler 或 fail-closed 策略。
- 在系统安全存储不可用时停止持久化新密钥，移除可逆 `b64:` fallback。
- 把 Office、GUI 和远端交付的实际能力边界写入 UI 和验收报告。

### 9.3 后续规划

- 远程 Supervisor、云端 Runner、跨设备续做和桌面关闭后继续运行。
- 多用户团队、评论、提及、组织策略、共享预算和企业审批。
- Jira、Linear、Notion、飞书、Slack、Teams 等双向同步。
- Portfolio、里程碑、Gantt、跨项目资源计划和企业管理报表。
- 数字员工、团队和 Workflow 模板市场。
- 企业 SSO、SCIM、审计导出、私有部署和商业授权控制面。

### 9.4 明确不做

- 不做外部 Agent/CLI 启动器、切换器或本机 daemon 管理器。
- 不把 Claude Code、Codex、Gemini CLI、OpenCode、OpenClaw 等注册为 CaoGen 顶层数字员工。
- 不自研基础模型，不以隐藏模型差价或强制特定厂商作为核心收入。
- 1.0 不做完整 Jira、飞书、钉钉、Notion、CRM、ERP、HR、工资、考勤或客服系统。
- 1.0 不做多人实时文档协作、团队聊天和视频会议。
- 不宣称 Office 原生格式像素级编辑能力，除非有专项真实证据。
- 不用装饰动画伪造任务、员工、交付或 Agent 协作。
- 不允许 Provider 切换制造新的顶层员工、项目或上下文断层。

## 10. 目标产品结构

```text
Assistant / Studio
        ↓
Project Workspace + Goal Workspace
        ↓
Digital Workers + WorkItem / Workflow / DAG
        ↓
CaoGen Native Runtime + Supervisor
        ↓
Model Attempts + Tool Fabric + Protocol Adapters
        ↓
Trust Kernel + Effect Ledger + Evidence
        ↓
Artifact + Acceptance + Delivery
```

产品顶层数据链：

```text
ProjectWorkspace
→ Goal
→ WorkItem
→ Assignment（assignee = DigitalWorker | Human）
→ Run
→ ModelAttempt
→ ToolExecution / Effect
→ Artifact / Evidence
→ Acceptance
```

## 11. 商业模式

### 11.1 Community

**立项目标**：AGPL、本地优先、BYOK、Assistant/Studio、Native Runtime 基础能力、项目/目标/数字员工、基本工作台、本地 Routine 和本地数据导出。

### 11.2 Pro

**后续规划**：加密同步、跨设备恢复、远程 Supervisor、自动备份、高级成本分析、个人模板库和更高并发额度。

### 11.3 Team / Enterprise

**后续规划**：共享 Runner、组织策略、凭据 Broker、审批流、统一审计、SSO/SCIM、私有部署、商业授权和支持服务。

### 11.4 商业原则

- 模型路由必须忠于用户策略，不得因平台毛利静默偏向特定 Provider。
- BYOK 与本地模型始终是核心路径，而不是故意弱化的免费入口。
- 付费点优先围绕可靠持续执行、协作、同步、治理和服务，不围绕锁定模型。

## 12. 里程碑与退出门槛

| 阶段 | 状态 | 核心交付 | 退出门槛 |
|---|---|---|---|
| M0 事实重基线 | 当前已验证 | 现有多厂商、路由、DAG、worktree、Trust 基础、工作台、Routine 和 3D 状态能力 | `STATUS.md`、测试报告和公开文案一致；无现状过度宣称。 |
| M1 Trust 与数据基座 | 部分完成 | 本立项书、领域模型、迁移预检、凭据与 Effect 收口、Goal/WorkItem/Artifact 基础 | `task-snapshots.db` v8 三态恢复读源、可逆迁移、store identity/committed continuity 与 `b64:` 新写 fallback 移除已完成；仍需冻结完整模型/API/验收契约，补全 scoped Broker、全入口 canonical 接入、Artifact 生命周期和生产补偿。 |
| M2 原生运行时与统一上下文 | 立项目标 | Native Runtime、Canonical Context、OpenAI/Anthropic Adapter、Checkpoint 和跨协议恢复 | 跨 Provider/协议恢复不丢关键上下文；SDK 兼容路径继续可用；未知 Effect 不重放。 |
| M3 Workflow、数字员工与 Supervisor | 立项目标 | Workflow Ledger、RoleTemplate、DigitalWorker、Assignment、自动组队、路由恢复阶梯和持久 Supervisor | 同一员工可跨 Provider 工作且身份/记忆/产物连续；任务可暂停、恢复、对账；员工不依赖外部 CLI。 |
| M4 双模式、轻量项目管理与水墨 3D | 立项目标 | Assistant/Studio、Project Workspace、Board/List、Acceptance 和水墨数字员工投影 | 两种模式共享同一状态；普通用户无需选择 Provider；3D 人物身份不随模型切换。 |
| M5 可验证交付 Beta | 立项目标 | 调研→需求→设计输入→实现→审查→修复→测试→交付闭环 | 一句话目标生成可审查 Artifact、Evidence、验收报告；默认要求连续 7 天自用无数据丢失。精确 `1.0.0` 由 release owner 以版本限定 waiver 接受该时间风险，不改变其余出口门禁。 |
| M6 CaoGen 1.0 | 立项目标 | 迁移、性能、可访问性、发布、安全、用户验证和水墨角色目标形态 | N1 真人证据、Required gate 全通过、正式平台完成代码签名且 macOS 完成公证、Go 评审通过。 |
| M7 Team/Cloud | 后续规划 | 远程 Runner、多人协作、连接器、企业治理 | 由 1.0 留存、付费和长期任务数据决定是否启动。 |

## 13. 成功指标

### 13.1 北极星指标

- `Weekly Verified Goal Deliveries`：每周每活跃用户完成且带有效 Acceptance/Evidence 的 Goal 数。

### 13.2 激活与体验指标

- 新用户首次已验证目标完成时间。
- N1 主链路真人完成时间，目标不超过 30 分钟。
- Assistant 用户无需打开 Studio 即完成常规任务的比例。
- Assistant→Studio 无损切换成功率，目标 100%。
- 每个 Goal 的人工 Provider/模型选择次数，默认目标为 0。
- 外部 Agent 接力率，目标持续下降。

### 13.3 质量与信任指标

- 有 Evidence 的完成任务比例，1.0 必须达到 100%，除非用户显式豁免。
- 高风险副作用重复执行数量，目标为 0。
- 崩溃/断网/Provider 故障后的恢复成功率。
- 未知副作用进入人工对账而非自动重放的比例，目标 100%。
- 用户接受交付前平均返工轮数。
- Required gate 的 fail、blocked、skip 必须分开报告，禁止以 skip 代替 pass。

### 13.4 商业指标

- D7/D30 留存。
- 每周重复完成两个以上 Goal 的用户比例。
- 每个被接受交付的模型成本，而非单纯 Token 消耗。
- BYOK、国内 Provider、本地模型和托管路径的用户分布。
- Community→Pro 转化原因必须来自持续执行、同步和治理价值，而不是模型锁定。

## 14. 组织、资源与角色

以下为责任域，不预设具体人员数量；每个责任域必须有唯一 DRI：

| 责任域 | 主要职责 |
|---|---|
| Product Owner | 立项范围、用户价值、优先级、商业边界和 Go/No-Go 决策。 |
| Product/UX Research | 白领、教育、普通用户、技术人员和 OPC 的任务研究、原型和真人验收。 |
| Experience Design | Assistant/Studio、项目看板、数字员工、审批、Artifact 和水墨视觉体系。 |
| Runtime Architecture | Native Runtime、协议 Adapter、会话账本、上下文和模型工具循环。 |
| Agent Control Plane | Goal、WorkItem、Workflow、DigitalWorker、Assignment、Supervisor 和调度。 |
| Model Routing | Provider 健康、质量、成本、速度、预算、故障切换和路由解释。 |
| Trust & Security | 权限、Effect、Reconciler、Evidence、凭据、审计、数据保留和供应链。 |
| Workbench & Integration | 文件、终端、Git、浏览器、Office、GUI、MCP、Skill 和连接器。 |
| QA & Release | 契约测试、迁移、恢复、性能、跨平台、安装包、签名、公证和发布证据。 |
| Business & Community | AGPL/商业授权、定价验证、社区、模板生态和客户支持。 |

资源配置原则：Trust Kernel、统一数据模型和恢复能力优先于新增装饰功能；水墨角色改造必须与真实 DigitalWorker/WorkItem 状态接线，不得先做静态换皮后宣称完成。

## 15. 依赖与前置条件

- 稳定的 OpenAI-compatible API 与后续 Anthropic Messages 等协议 Adapter。
- Provider 凭据、额度、健康检测和能力元数据。
- SQLite/本地持久化、原子迁移、备份与回滚机制。
- Electron 主进程、React Renderer、react-three-fiber 和跨平台构建链。
- Git/worktree、浏览器、Office 解析、MCP、Skill 和可选外部交付 CLI。
- Apple Developer、Windows 签名、真实设备和特定网络证据属于发布条件，不属于产品内核依赖。
- 水墨轻动漫人物需要原创或授权明确的模型、动画、材质与性能预算。

## 16. 主要风险与应对

| 风险 | 后果 | 应对 |
|---|---|---|
| 功能面继续扩张 | 变成低完成度工具集合 | 用 Goal 主链和里程碑退出门槛冻结范围。 |
| 数字员工退化为头像+prompt | 产品价值虚假 | 必须具备职责、权限、预算、记忆、Assignment、Run、Evidence 和绩效。 |
| 项目管理退化为 Jira 克隆 | 偏离 Agent Work OS | 只保留与目标执行、证据、审批和交付直接相关的对象。 |
| 用户仍需手选模型 | 退化为切换器 | 自动路由为默认；手动覆盖只在专家设置中渐进披露。 |
| 双模式形成两套产品 | 数据分裂和维护成本 | 一个 store、一个领域模型、一个 runtime；模式只改变呈现和控制密度。 |
| SDK 厂商耦合 | 运行语义分叉 | 先补协议和恢复等价能力，再迁移旧数据，最后决定移除厂商 SDK。 |
| 自动化副作用重复 | 数据或外部系统损坏 | Effect Ledger、Reconciler、幂等键、人工对账和 fail-closed。 |
| 水墨 3D 性能或可读性下降 | 用户关闭核心界面 | 原创轻量资产、分级 LOD、状态多通道编码、像素和帧率门禁。 |
| 普通用户认知负担过重 | 激活失败 | Assistant 默认隐藏技术对象，通过结果、审批和产物驱动。 |
| 现状与宣传不一致 | 信任和合规风险 | 所有公开声明绑定状态标记、测试工件、平台和成立条件。 |

## 17. 治理机制

### 17.1 产品真相治理

- `STATUS.md` 是当前事实源；本立项书和需求说明书描述目标与边界。
- “当前已验证”必须链接测试、代码、运行或发布证据。
- “条件可用”必须在产品 UI、文档和验收报告中显示条件。
- 目标能力未通过验收前不得进入 README 的当前能力清单。

### 17.2 架构治理

- 新能力必须挂接 Project/Goal/WorkItem/Run/Artifact 主链，禁止形成第三套任务系统。
- Provider/模型信息只进入 Routing Policy 和 Model Attempt，不得进入 DigitalWorker 身份主键。
- Assistant 和 Studio 不得拥有不同的数据写入路径。
- 所有高风险外部效果必须登记 Effect 或明确 fail-closed。

### 17.3 数据与安全治理

- 项目是数据保留、导出、删除、权限和审计边界。
- 自动记忆和 Skill 学习先进入 draft，用户批准后生效。
- 密钥不可进入 Renderer、日志、Artifact、Memory 或项目导出包。
- 迁移必须支持备份、预检、幂等、版本化和失败回滚。

### 17.4 变更治理

- 任何扩大 1.0 范围的需求必须说明用户问题、指标、依赖、风险和被替换的既有工作。
- 里程碑仅在退出门槛全部满足时完成；预算或日期临近不能替代验收。
- 竞品功能只可转译为 CaoGen 原生能力，不可直接复制其顶层 Agent/Runtime 模型。

## 18. Go / No-Go 决策

### 18.1 立项 Go 条件

满足以下条件可进入 M1：

- 产品定位、目标用户、双模式、数字员工和项目管理边界获得确认。
- 领域模型与迁移策略完成评审。
- Trust Kernel、Native Runtime、Agent Control Plane 和 UX 有明确 DRI。
- 1.0 范围、明确不做和里程碑退出门槛被冻结。
- 现有测试与发布基线保持可重复。

### 18.2 开发阶段 No-Go 条件

出现任一情况应暂停新增功能并修正：

- 需要用户频繁选择 Agent、引擎、Provider 或模型才能完成黄金路径。
- Assistant 和 Studio 创建了两份会话、任务或项目状态。
- 数字员工绑定外部 CLI 或特定模型品牌。
- `Done` 状态没有 Artifact、Evidence、Acceptance 或用户显式豁免。
- 迁移会丢失现有项目、会话、Routine、记忆、DAG 或历史记录。
- 高风险副作用在未知结果后自动重放。
- 新 3D 场景只换外观，没有消费真实员工和任务状态。
- Required gate 依赖 skip、blocked 或外部条件伪装为 pass。

### 18.3 1.0 发布 Go 条件

- 所有 P0 需求和指定 P1 黄金路径通过。
- 水墨人物 `VIS-002` 至 `VIS-007` 属于 CaoGen 1.0 指定 P1 发布门禁，不得以“P1 可延期”为由保留机器人主角色。
- Assistant 与 Studio 的状态一致性专项测试通过。
- 跨 Provider 自动路由、故障切换和员工身份连续性通过。
- 崩溃恢复、Effect 对账、数据迁移和回滚通过。
- 至少覆盖办公/教育与技术/OPC 两类真实用户的端到端验收。
- N1 真人 30 分钟证据完成；未完成前不得宣称达标。
- 默认要求连续 7 天自用无数据丢失、无重复高风险副作用；精确 `1.0.0` 按 `docs/1.0-SOAK-WAIVER.json` 记为显式 owner waiver，不得记为通过或复用于后续版本。
- 当前 beta/GitHub 预览包可在明确警告和 SHA-256 核验下保持未签名；任何标记为 CaoGen 1.0 stable 的正式平台必须完成对应代码签名，macOS 还必须完成公证与 stapling，并通过安装和升级验证。

### 18.4 1.0 发布 No-Go 条件

- 任一 P0 数据丢失、权限逃逸、凭据泄漏或重复副作用问题未关闭。
- Goal 主链仍需外部 Agent 人工接力才能完成验收。
- 项目导出/删除不能覆盖 Goal、任务、员工、产物、记忆和审计。
- 水墨视觉导致状态不可读、文本重叠、关键操作不可达或性能门禁失败。
- 当前能力、条件能力和未来目标在产品或文档中无法区分。

## 19. 立项交付物

- 本文件：[`docs/PROJECT-CHARTER.md`](./PROJECT-CHARTER.md)。
- 产品需求：[`docs/PRODUCT-REQUIREMENTS.md`](./PRODUCT-REQUIREMENTS.md)。
- 产品技术要求：[`docs/PRODUCT-TECHNICAL-REQUIREMENTS.md`](./PRODUCT-TECHNICAL-REQUIREMENTS.md)。
- 网络安全与风险：[`docs/SECURITY-AND-RISK.md`](./SECURITY-AND-RISK.md)。
- 概要设计：[`docs/HIGH-LEVEL-DESIGN.md`](./HIGH-LEVEL-DESIGN.md)。
- 当前事实：[`STATUS.md`](../STATUS.md)。
- 当前公开能力：[`README.md`](../README.md)。
- 实施路线：后续以本立项书和需求说明书为上位约束重排 [`ROADMAP.md`](../ROADMAP.md)。
- 详细数据库 schema、数据迁移、视觉 Style Bible、测试矩阵和发布计划继续作为对应里程碑的派生文档维护。
