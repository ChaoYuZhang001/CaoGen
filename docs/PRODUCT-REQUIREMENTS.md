# CaoGen 1.0 产品需求说明书

> 文档状态：产品需求基线候选版 1.0
> 更新日期：2026-07-28
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
- 竞品能力只能转译为 CaoGen 原生需求；不得复制品牌、界面、封闭生态假设或未经核验的底层实现。

## 2. 产品定义

### 2.1 产品定位

**立项目标**：CaoGen 是本地优先、厂商中立、用户可自定义、可恢复、可审计的 Agent Work OS。它在一个产品中统一代码执行、办公成品、项目知识、自动化、任务协作和跨端接续；用户提交目标、约束、预算和验收标准，自主选择或自动路由任意受支持的 Provider、模型、协议 Adapter、本地模型、Skill、MCP、连接器与工具，CaoGen 使用内部数字员工完成工作并交付证据。

### 2.2 核心边界

CaoGen 不是：

- 只负责启动外部 Agent 或 Agent CLI、自己不持有任务和交付状态的启动器。
- 只在 Claude Code、Codex、Gemini CLI、OpenCode 等产品之间切换的配置面板。
- 未经 CaoGen Runtime、Trust、Artifact、Evidence 和 Acceptance 合同就把外部 Agent 进程登记成员工的劳动力管理平台。
- 完整 Jira、飞书、Notion、CRM、ERP 或 HR 系统。
- 只提供聊天回答、无法持久执行和验收的对话壳。

CaoGen 是：

- 一个持有 Project、Goal、WorkItem、Run、Artifact、Evidence 和 Acceptance 的原生系统。
- 一个默认自动选择不同厂商和模型、用户可在专家模式检查原因的调度系统。
- 一个为普通任务提供 Assistant、为复杂任务提供 Studio 的双模式产品。
- 一个用内部岗位实例表达“数字员工”，用 CaoGen Runtime 执行工作的系统。
- 一个把代码、办公、研究、设计、自动化、协作和远程接续纳入同一 Project/Goal/Artifact 生命周期的统一工作系统。
- 一个允许用户自定义 Provider、Base URL、协议、模型、Key、本地服务、Skill、MCP、连接器、工具和路由政策，且支持迁移与导出的开放系统。

### 2.3 正式竞品对标后的产品原则

Codex 和 Claude Code 直接争夺代码任务入口；WorkBuddy 证明办公 Agent 必须交付成品；Multica 把人和 Agent 的任务协作产品化；CC Switch 降低多工具和 Provider 配置门槛；Marvis 建立跨端常驻助手心智。CaoGen 的终极需求是把这些核心优势作为一个产品内的原生能力统一提供，而不是只选择其中一个方向；其边界约束的是锁定、套壳和不可治理的实现方式，不是能力范围：

- **直接竞品迁移是第一天留存能力**：Codex/Claude Code 用户的项目规则、Skill、MCP、Hook、命令和工作习惯必须可选择性导入、预览和回滚；不得要求用户先放弃原生态资产。
- **借鉴成品体验，不复制封闭生态**：任务结果必须聚合 Artifact、工作区文件、变更、预览、Evidence 和后续动作；连接器、模型与设计工具必须可替换。
- **三轴分离**：Assistant/Studio 是界面投影；查看/规划/执行是任务执行策略；权限、预算和数据外发是风险约束。三个轴不得互相隐式改写。
- **项目知识必须可追溯**：知识库或连接器检索结果必须带来源、版本、授权主体、检索时间和引用，不得把不透明 RAG 输出当作 Evidence。
- **远程控制不转移执行主权**：远程端可发起、续接、审批和查看结果，但本地文件、凭据、工具与高风险决策仍受绑定设备的 Trust Kernel 控制。
- **协作只扩展任务所有权**：支持分享、转交、评论和共享审批，不自建聊天、会议或多人 Office 套件。
- **办公、设计和代码使用同一交付合同**：Word/Excel/PPT/PDF、设计稿、代码、PR、报告和测试结果都进入统一 Artifact/Evidence/Acceptance 生命周期。
- **外部 Runtime 不等于内部员工**：CaoGen 1.0 的 DigitalWorker 由原生领域模型持有；外部 CLI/Agent 只能通过明确 Adapter 或迁移入口参与，不能绕过权限、Effect、Artifact、Evidence、Acceptance 和 Recovery。
- **默认路径必须少配置**：普通对话不要求创建 Project；导入已有工作只选择一个文件；可发现的本地算力、Provider 能力和模型由系统自动探测并给出可解释默认值。目录、Base URL、协议、模型、角色依赖和迁移冲突只在必要时渐进披露，专家设置不能成为首任务前置条件。
- **工作状态必须厂商中立且可移植**：Project 包不得依赖某一厂商账号或私有会话 ID 才能读回；依赖必须显式列出，缺失依赖可安全安装或明确阻止，绝不静默替换；更换 Provider 后继续使用同一 Goal、WorkItem、Run、Artifact、Evidence 和 Acceptance 身份。

### 2.4 统一集成的终极能力集合

| 能力来源 | CaoGen 必须原生提供的核心能力 | 厂商中立要求 |
|---|---|---|
| Codex / Claude Code | 项目理解、代码编辑、终端、Git、测试、审查、长任务、并行执行、Skill/MCP/Hook 和会话恢复 | 不绑定 OpenAI 或 Anthropic；相同 Goal、Run、Context 和 Artifact 可跨 Provider/协议延续 |
| WorkBuddy | 查看/规划/执行策略、办公文件、统一结果工作台、项目知识、连接器、专家协作、Routine 和远程接续 | Office/知识/设计工具可替换；本地文件、引用和权限不依赖单一云生态 |
| Multica | Issue 式 WorkItem、成员/Agent 派工、评论、转交、Squad、cron/webhook/manual 自动化和运行历史 | 外部 Runtime 通过 Adapter 接入；身份、权限、Effect 和审计由 CaoGen 持有 |
| CC Switch | Provider profile、预设、模型发现、健康、failover、MCP/Skill/Prompt 配置、导入导出、备份和回滚 | 用户自带 Key/Base URL/本地模型；配置原子可逆，导出不锁定、不默认携带凭据 |
| Marvis | 常驻助手、本地个人知识、PC/移动端接续、远程查看、审批和任务控制 | 设备绑定、本地执行优先、远程通道不托管本地凭据，支持用户选择同步与保留政策 |
| CaoGen 原生内核 | Goal、WorkItem、Run、Effect、Artifact、Evidence、Acceptance、Recovery、预算、权限和审计 | 所有上层能力复用同一合同；任何 Provider、模型或连接器均不可绕过 |

## 3. 当前能力基线

| 能力域 | 状态 | 当前事实 |
|---|---|---|
| 多厂商配置 | 当前已验证 | 多 Provider、多 Key、自定义 Base URL、OpenAI-compatible 与原生 Anthropic Messages。 |
| Provider Profile 可逆迁移 | 部分完成（Service/Store、强杀恢复与当前 Electron UI 已验证） | `test-results/provider-profile-smoke/2026-07-31T18-36-07-764Z/report.json` 的 135/135 覆盖无凭据导出、严格导入/规范化重复拒绝、URL 目标匹配、活动 Key 标签/数量、凭据绑定影响、IPv4/IPv6 loopback no-auth、远程 no-auth 网络前拒绝、冲突预览、目标变化凭据隔离/显式重绑、权威快照字段清除、配置漂移 CAS、脱敏私密备份、Key 真删除、journal 文件边界，以及 backup 文件名/内嵌 ID 不一致时回滚拒绝且 Store 不变；`test-results/provider-profile-restart/2026-07-31T18-36-15-308Z/report.json` 的 13/13 真实跨进程/`SIGKILL` 场景证明存活 owner 竞争返回 `LOCK_HELD`、失败 candidate 清理、同进程可重入、正常释放竞争、import/rollback checkpoint、死锁回收、零 replay/字节稳定、同进程对账收敛和 6 类 pending writer 阻断。safety/source backup 在 Store commit 前和 terminal 前复核 ID/digest，prepare 后或 Store commit 后篡改均 fail-closed；恢复冻结字节后才收敛并恢复普通写入。`test-results/provider-profile-e2e/2026-07-31T18-36-51-341Z/report.json` 的 54/54 通过真实 IPC/Renderer 和四张截图证明 Key 标签/凭据影响预览、应用、跨启动回滚、脱敏导出/备份、Key 删除确认/重新录入及 compact 布局。Provider Profile Service、operation journal、mutation lock 与 Store repository 均已登记于 `test-results/durable-write-inventory/2026-07-31T18-36-37-638Z/report.json`，但 Provider Store 顶层 schema 仍未版本化。报告绑定 dirty `8ba60148`；Windows ACL、真人、真实 Provider 发现/健康/failover 与 clean release 证据仍开放。 |
| 原生 Anthropic Messages | 部分完成（本地 targeted 验证） | 已注册生产 Engine 并覆盖工具循环、权限/Effect、Key/同协议 Provider failover 和图片重启恢复；真实 Provider、统一 Run/Context 契约与 clean release-bound parity 仍开放。 |
| 模型路由 | 当前已验证 | 支持任务类型、项目规则、用户规则、健康、预算、成本、质量、速度和 failover。 |
| 项目与会话 | 当前已验证 | canonical Workspace 与兼容旧目录 Project 共存；侧栏按 `workspaceId` 优先归组，只有无归属 Session 进入“对话”；项目提供展开/收起、更多和直达任务入口的 `+`，并保留项目规则、归档/恢复/删除和项目记忆。 |
| 多任务 | 当前已验证 | 真实 child sessions、最多 33 个任务、DAG、重试、worktree、结果回传和可选自动合并。 |
| 工作台 | 当前已验证 | 终端、文件、编辑、Diff、Git、浏览器、预览、插件、Skill、MCP 和部分 Office 能力。 |
| Trust Kernel | 当前已验证 | Task Run、Effect Ledger、lease/fencing、部分文件/Git Reconciler 和强杀恢复。 |
| Routines | 当前已验证 | 本地定时、运行记录、通知、防休眠和开工建议。 |
| 3D 办公区 | 当前已验证 | 使用真实会话、任务、Provider、成本、审批、工具、worktree 和 Git 状态。 |
| Claude 模型 | 条件可用 | 通过 Anthropic Messages Provider API Key 接入；不需要 Claude Code 登录或 CLI。 |
| PR/MR 和远端交付 | 条件可用 | 依赖远端账号、权限及 `gh`/`glab` 等外部条件。 |
| GUI 自动化 | 条件可用 | 默认关闭，需要显式权限，平台与应用覆盖不完整。 |
| Office 高保真 | 条件可用 | 支持结构提取和系统预览，不等价于原应用完整编辑与像素级一致。 |
| Goal/Workflow Ledger | 部分完成（v9 Workflow/Conversation recovery foundation） | `task-snapshots.db` v9 已提供 Goal/WorkItem/Run/Artifact/Acceptance/Evidence Link、event chain、canonical recovery sessions，以及按 generation 保留重写历史的 Conversation Ledger archive；Task Snapshot/TaskRun 恢复读取支持按数据库路径隔离的 `legacy / compare / canonical` 三态，mode flip 强制重新验证，未配置时默认 legacy。v9 新增部分当前仅完成类型检查，不计为行为验证。 |
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

### 5.6 通用办公成品

1. 用户以附件、工作区文件、项目知识或连接器内容作为输入，描述要交付的文档、表格、演示文稿、PDF 或报告。
2. CaoGen 在执行前确定输出格式、模板、来源要求、修改边界和最小 Acceptance。
3. 生成结果进入 canonical Artifact，而不是只在聊天中返回一个文件路径。
4. 用户在统一结果工作台查看产物、工作区文件、变更、预览、Evidence 和版本，并可批注、返工或导出交付包。
5. “文件已生成”不等于完成；结构、内容、引用、可打开性和用户指定格式必须通过自动或人工 Acceptance。

### 5.7 远程接续与协作

1. 用户通过已绑定的远程通道发起或续接现有 Goal/WorkItem，而不是创建脱离项目的影子会话。
2. 远程审批显示动作、目标、数据范围、成本和有效期；高风险审批不得降级为简单“同意”。
3. Desktop 离线、休眠、网络中断或绑定撤销时，远程端明确显示不可执行状态，不伪造已接收或已完成。
4. 分享和转交只改变显式访问权或 owner；Artifact、Evidence、审计和历史身份不复制、不丢失。
5. 远程控制和多人协作属于 P2 扩展，不阻塞最小 1.0，但其领域和安全合同必须在 1.0 数据模型中预留。

### 5.8 AI 视频创作(P2，非 1.0 阻塞)

1. 用户导入小说、剧本或故事大纲，CaoGen 在写入正式工程前展示 Episode / Scene / Shot
   解析结果、未确定项和修改入口。
2. 用户建立或复用角色、场景、道具和声线资产；每个镜头显式引用资产版本，不依赖提示词中
   隐含的人物身份维持一致性。
3. CaoGen 按镜头生成分镜和关键帧，用户选择版本后才进入视频生成；批量操作显示预计成本、
   Provider、数据外发范围和可取消边界。
4. 图片、视频和 TTS 的外部任务保存独立 MediaJob，应用重启后先按外部 job ID 对账，不把
   未知结果自动重新提交或误报为成功。
5. 生成的视频、对白、字幕和配乐进入本地合成；最终成片及其输入、版本选择、模型尝试、费用、
   Evidence 和 Acceptance 可从同一 Artifact 图追溯。
6. AI 视频工作室属于 post-1.0 扩展；它复用 CaoGen 的核心交付合同，但不把短剧能力加入当前
   64 个 P0 或 1.0 发布门禁。

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
| EXP-005 | P1 | 部分完成（canonical result surface foundation） | Studio 与 Assistant 已复用同一结果合同，按当前 Session 的 canonical Project/Goal/WorkItem 聚合 Run、Artifact 位置/版本/摘要、Evidence、Acceptance、测试、成本覆盖率、风险、未完成项、审批和审计时间线；未绑定 Project 时明确显示“对话分组”。持久不一致 fail-closed，瞬时 revision 冲突只做有上限稳定重读。自动化已覆盖三档视口、脱敏导出、变更/文件/预览/浏览器/终端/任务六个工具交接，以及两层真实 child-Session DAG；真人代码/Office 主链与 clean release 绑定仍开放。 |
| EXP-006 | P1 | 立项目标 | 用户偏好可持久化，但每个任务都允许临时切换。 |
| EXP-007 | P2 | 后续规划 | 根据用户习惯推荐默认模式和布局，不静默改变当前模式。 |

### 6.4 任务执行策略

任务执行策略独立于 Assistant/Studio 和 CaoGen Drive，统一为三种用户可理解的合同：

| 策略 | 合同 | 当前映射与缺口 |
|---|---|---|
| **查看** | 只读取和分析；不得写文件、执行命令、调用有副作用连接器或创建外部对象 | 部分完成：三条引擎工具门和手工终端/Git/文件/worktree 写入口已在 SessionManager/main IPC fail-closed；全部连接器、Routine 与全业务入口的端到端零副作用证明仍未完成 |
| **规划** | 生成版本化 Workflow/DAG、Acceptance、预计数据外发和成本；用户批准前不得执行计划步骤 | 部分完成：会话级结构化计划、Genesis 捕获、不可变版本、摘要、变更原因、精确审批、自动 supersede、重启/篡改门和计划工作台已实现；已绑定 Project 的批准步骤已投影为现有父 WorkItem 下的 canonical WorkItem/Workflow Ledger，未绑定对话不创建隐藏 Project；Studio 已支持一句自然语言目标幂等创建 canonical Goal/父 WorkItem/绑定 Session，无目录 Project 使用应用隔离执行目录；计划合同自身的 Ledger 历史仍开放 |
| **执行** | 按已批准目标直接执行；每个动作仍受权限、预算、隐私、Effect 和 Acceptance 约束 | 部分完成：无计划的既有执行会话保持可用；一旦存在计划，发送、子 Agent、DAG 首层/后续层及手工写入口必须命中当前 `version + digest` 审批；全连接器、远程入口和最终 Acceptance 仍待统一 |

验收边界：切换 Assistant/Studio 不改变执行策略；切换 Drive 不扩大权限；Full Access/`bypassPermissions` 不跳过预算、数据外发、凭据隔离、Effect、未知结果对账或最终 Acceptance。

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

**部分完成**：canonical ModelAttempt v1 已记录 Run/WorkItem 归属、逻辑 request/step、Provider/model/protocol、可读 route reason、usage、结果和不可变事件链；OpenAI-compatible 请求、模型 DAG 调用与原生 Anthropic Messages 每次底层 HTTP 请求已接入，未知结果在重启后进入显式 retry/cancel 对账，密钥只保留安全标签或摘要。

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

当前实现状态：`task-snapshots.db` v9 保留 v6 TaskRun Effect evidence 的本地 hash-chain foundation，并包含 Goal/WorkItem/Run/Artifact/Acceptance/Evidence Link、workflow event chain、canonical recovery sessions，以及 Conversation Ledger stream/generation/event archive。JSONL 是同步耐久源，DB archive 具有独立 hash chain；Checkpoint 或链前缀变化创建新 generation，旧代不覆盖。启动回填历史账本，恢复/分叉在 JSONL 缺失时从 DB 当前代重建，损坏文件 fail-closed；Project 永久删除同步清理 archive 并写授权计数。Artifact Graph edge/location、关系/归属完整性、邻域查询、脱敏 export 和只读 diagnose/repair 已有 targeted smoke。Task Snapshot/TaskRun 恢复读取支持 `legacy`、`compare`、`canonical` 三态：compare 在两侧漂移时 fail-closed，canonical 从 Workflow Run/recovery session 读取；mode 按数据库路径隔离，运行时切换在 mutation queue 中 fresh revalidate 后才提交，未配置时默认 legacy。所有 Task Store open 共享按数据库路径隔离的 single-flight readiness；legacy JSON/旧 SQLite 迁移覆盖精确备份与 journal/checkpoint、候选校验、原子替换、崩溃续做和回滚恢复，future/corrupt source fail-closed。持久 `workflow_store_identity` 与 committed 高水位连续性会拒绝未授权删除、截断、版本回退和同版本空库替换。Responses 服务端上下文已有 Provider/模型/协议/Key 约束的持久游标基础，身份不匹配时回退本地账本。v9 archive 已有独立 Conversation Ledger、跨进程 Provider fork 和 Checkpoint/Effect boundary required gate；完整 Artifact/blob/sourceRef/metadata 生命周期、所有入口与外部事件接入、真实 Provider 强杀/跨协议行为证据、统一 retention/export/import 和生产补偿仍未完成。

2026-07-30 开发增量：耐久转录现包含 init/status/meta、权限、Key/Provider 路由、
tool start/result、Checkpoint 和上下文压缩边界等语义事件；Responses 服务端链不可复用时，
会从这些事件生成有界的跨 Provider/协议输入，附件只携带 content-addressed 引用，工具调用与结果
按 ID 配对。恢复界面同步展示事件 causation/correlation、服务端 context generation、Checkpoint、
Effect lease/fence/evidence。`npm run test:conversation-ledger` 已覆盖首次 archive、增量 append、
Checkpoint rewrite 新 generation、旧 generation 保留、JSONL 缺失恢复、JSONL/DB 篡改 fail-closed、
附件引用、tool-call/result 配对和 portable replay 不重放副作用。该 archive 仍是同步 JSONL 的
canonical DB 副本，不代表所有业务入口、Artifact 或外部事件都已统一 canonical 化。

同日显式分叉增量：历史对话可从侧栏进入现有 Provider/模型选择器；新分叉保留源
Project/Goal/WorkItem 与本地语义账本，但生成新的 Session/SDK 身份，不继承 Responses response id、
Claude SDK resume id 或 Key 身份。OpenAI Responses/Chat、Anthropic Messages 和 Claude Agent SDK
分别使用同一 Provider-neutral 回放合同；来源没有 CaoGen 语义账本时 fail-closed，不伪装恢复隐藏
Provider 上下文。v9 canonical archive 已按 stream/generation/event 保存并可在 JSONL 缺失时恢复；
已有 JSONL 损坏时拒绝覆盖。`npm run test:provider-cross-resume` 通过两个独立 Node 进程证明：删除
OpenAI 来源 JSONL 后可从 DB 恢复并 fork 到新的 Anthropic Session/SDK/Provider；Project/Goal/WorkItem、
Run、request、step 和语义事件身份保持，ModelAttempt predecessor/successor 正确链接，附件和工具对可重建。
`npm run test:checkpoint-effect-boundary` 同时要求 chat/code/both 与兼容 file-rewind 的实际恢复在未决 Effect 前 fail-closed，
dry-run 只展示范围；组合 required gate 复用现有 Effect 强杀/close-race E2E。以上是 dirty-worktree
确定性本地证据，不是真实 Provider、完整恢复阶梯、clean full Deep 或发布绑定，因此
`TRUST-005`、`RUN-003/005/006` 与 `ROUTE-005` 均不关闭。

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

### 7.15 VideoProduction 和 MediaJob(P2)

`VideoProduction` 是 Project 内的视频创作聚合，不替代 Goal/WorkItem。它至少包含：

```text
VideoProduction -> Episode -> Scene -> Shot
Shot -> MediaAssetBinding -> canonical Artifact
Shot -> MediaJob -> external generation attempt
VideoProduction -> final Artifact / Evidence / Acceptance
```

- `Episode / Scene / Shot` 保存创作结构、稳定身份、顺序、时长意图和当前采用版本；Provider、
  模型及其私有请求字段不得成为这些领域对象的身份。
- `MediaAssetBinding` 绑定角色、服装、场景、道具、关键帧、声线、字幕或音轨的明确版本，
  实际内容和派生关系仍由 canonical Artifact Graph 管理。
- `MediaJob` 表示一次外部图片、视频、TTS 或本地合成尝试，建议字段为：

```text
id, projectId, productionId, shotId?, runId, providerProfileId,
capability, adapterVersion, idempotencyKey, externalJobId?, status,
inputDigest, outputArtifactIds, estimatedCost, actualCost,
submittedAt?, observedAt?, finishedAt?, errorCode?, reconciliation
```

- MediaJob 与 ModelAttempt 分离。TaskRun 可以监督多个 MediaJob，但不能用一次聊天响应的状态
  代替外部媒体任务的提交、轮询、下载、校验和对账状态。
- MediaJob 的未知结果必须进入 `waiting_reconciliation` 或等价媒体状态；没有外部只读查询或
  人工确认时不得自动重放。

## 8. 功能需求

### 8.1 Project Workspace

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| PROJ-001 | P0 | 当前已验证 | 可创建不要求本地目录的托管 Project Workspace，并经真实 Electron 验证编辑、归档、重启、恢复、导出、软删除和永久删除后的身份连续性。侧栏同时投影 canonical Workspace 和兼容旧目录 Project，按 `workspaceId` 优先保存活动/历史 Session 归属；项目级展开、更多、任务 `+`、顶层新建项目和移动端布局已纳入 5 次启动回归。最新报告：`test-results/project-workspace-lifecycle-ui/2026-07-29T14-57-44-777Z/report.json`。 |
| PROJ-002 | P0 | 当前已验证 | 本地目录、文件集合、仓库、知识库和连接器均可注册为可选 first-class Resource，支持 Studio 增删、重启持久化、digest manifest 导出且删除关联不删除源。该状态只证明 Resource 生命周期，不证明通用 RAG 检索、连接器执行或外部授权已实现；后者由 `CONN-002/003` 验收。 |
| PROJ-003 | P0 | 当前已验证 | 稳定 Project ID 已成为跨 Store sealed aggregate 的统一身份；查询、授权、校验、导出、并发 seal、跨 Project 拒绝、重启、缺失/篡改、torn snapshot、Project-ID Memory IPC cutover 以及 ProjectWorkspace、DigitalWorker、Workflow Ledger、Memory 生产 mutation ingress 均由 27 项 required checks 覆盖，最新报告 `notProved=[]`。 |
| PROJ-004 | P0 | 部分完成（完整导出 + 当前参与者可恢复导入/删除） | Studio 已输出包含 18 类对象和显式 RoleTemplate 依赖的 sealed/sanitized Project Aggregate canonical JSON，并提供不要求先创建空 Project 的单文件导入。导入校验 export/aggregate/credential/ownership，保存 `0600` 私密源副本，以 durable journal 分阶段合并 Workspace、Workforce、完整 TaskRun、Artifact Graph、Evidence、Acceptance 和 canonical Learning；缺失且匹配的 RoleTemplate 自动安装，同 ID 不同内容不覆盖，Workflow 先 dry-run、目标链坐标重建，阶段写入后可启动续做，最终重新封存并验证语义等价。永久删除仍强制私密备份、durable delete journal、授权删除连续性账本、零残留 proof 和外部 Resource 保留；同 Project 的删除墓碑可由已验证备份恢复。专项与真实 Electron gate 已覆盖删除后导入、无关 Project 保留、Run 读回、重复/篡改拒绝和重启持久化。全 28 Store owner proof、Artifact blob、Session/transcript/snapshot/ModelAttempt、旧路径 Memory、connector 和全 inventory 删除证明仍未关闭。 |
| PROJ-005 | P1 | 立项目标 | 提供 `personal/office/education/research/software/opc/custom` 项目模板；模板包含最少必要的任务预设、Artifact 类型、Acceptance 草案和 Resource 建议，不静默授予工具或数据权限。 |
| PROJ-006 | P1 | 当前已验证 | 项目规则、背景、技术栈、命令、禁止路径、调度和验收可通过 `caogen.md` 编辑。Codex `AGENTS.md`、Claude `CLAUDE.md` 等外部规则的选择性导入、来源标注、冲突预览、备份和回滚属于迁移黄金路径，不由当前状态证明。 |
| PROJ-007 | P2 | 后续规划 | 多 Project Portfolio、跨项目依赖和资源计划。 |

### 8.2 Goal 和轻量项目管理

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| GOAL-001 | P0 | 当前已验证 | Goal Contract 已通过可信 Studio→preload→main→canonical command/event 全链路完成创建、编辑、终态归档、重启读回和恢复；主进程拒绝非法预算且无部分写入，stale revision 不能覆盖并发更新。 |
| GOAL-002 | P0 | 部分完成（production canonical read/write foundation） | Goal 必须支持目标、限制、预算、期限、风险和 Acceptance；生产 Goal list/get 已默认从 hash-chain verified rich view 读取，生产命令在保持 JSON 锁时先提交 Workflow Ledger、再投影 JSON，并可在三个强杀检查点恢复。完整策略执行与 UI 校验尚未闭环。 |
| WORK-001 | P0 | 部分完成（production canonical read/write foundation） | 支持 WorkItem 父子关系、依赖、优先级、状态、owner 和截止时间；生产 WorkItem list/get 已默认读取 verified rich view，生产命令已 canonical-first 并校验实体闭包、关系环和 Run 归属。List/Board 已由 WORK-002 单独闭环，完整控制语义和全业务入口 canonical 化仍开放。 |
| WORK-002 | P0 | 当前已验证 | canonical WorkItem List/Board 共用同一排序与筛选投影，支持 revision-guarded 持久重排、按 Project 保存视图/筛选、1,000 项固定尺寸虚拟化和重启一致性；required gate 已通过真实 Electron 两次启动验证。 |
| WORK-003 | P0 | 部分完成（canonical multi-Run invariant） | Run/session 只作为 WorkItem 明细展示，不得直接替代任务。当前本地 required smoke 已证明两个独立 Session Run 幂等共享一个 canonical WorkItem、启动重放不重复、Run 不可跨 WorkItem 漂移；完整 renderer→IPC→SessionManager 多入口 E2E 与 clean release 绑定仍开放。 |
| WORK-004 | P0 | 部分完成（repair/retest + WorkItem/Supervisor control slices） | Workflow Acceptance 失败会确定性创建 canonical repair WorkItem 与 Acceptance；Studio 已覆盖 WorkItem transition/lease。受信 main-process SessionManager 切片已把 Supervisor pause/cancel/resume/retry/reassign 接到同一 canonical TaskRun，并覆盖强 revision/lease/fencing 校验、retry 快照预检、发送门禁、stale revision、failed-resume blocking 与重启后门禁重建。TaskRun-owned control 在 runtime 缺失时不再回落直写，其他 renderer mutation 和手工过期租约恢复仅限 manual Run；Goal maxRuns/maxConcurrentRuns/maxTokens/USD cost 已进入 canonical send/turn/retry 本地门禁。Studio Supervisor UI、真实 Provider parity、所有执行入口的一致 enforcement、自动 repair、跨文件事务补偿与跨域强杀仍开放。 |
| WORK-005 | P1 | 部分完成（Goal Task + session plan + canonical step projection） | 从自然语言 Goal 生成可审查、版本化的 Workflow/DAG、依赖、预计产物、数据外发、成本和 Acceptance 草案；规划策略下用户批准前不得执行。当前 Studio 一句目标会幂等创建 canonical Goal/父 WorkItem、自动路由并启动精确绑定 Session；无目录 Project 使用应用隔离执行目录，普通对话仍不要求 Project，部分写入重试可恢复且冲突 fail-closed。canonical Project 侧栏 `+` 直达选中项目的该入口，活动 Session 与重启后的历史记录继续按 `workspaceId` 留在项目内。会话级计划工作台和 Genesis→计划版本捕获已接通，发送、子 Agent、DAG 与手工写入口均受审批门保护。已绑定 Project 的审批步骤会按稳定 step ID 幂等投影到现有父 WorkItem 下，依赖和预期产物 AcceptanceSpec 进入 canonical command/Workflow Ledger；增改删、重启、冲突 fail-closed 和无 Project 对话边界均有自动回归。自然语言 Goal 到完整 Workflow/DAG 草案仍需进入计划策略链。 |
| WORK-006 | P1 | 部分完成（immutable versions + projection receipt） | 手工编辑或模型修订计划后保留原计划版本、变更原因和批准主体；批准只覆盖所见版本，后续实质变更必须重新确认。当前本地私有存储保留不可变版本、SHA-256 摘要、变更原因、append-only 批准/撤销/superseded 事件，并为审批保留可校验的 conversation/canonical 投影回执，在重启、篡改、绑定冲突或运行中重写时 fail-closed；计划合同自身的 canonical Ledger 历史、真实多主体审批和统一 retention/export/delete 仍开放。 |
| WORK-007 | P2 | 后续规划 | 里程碑、Timeline、Gantt、Portfolio 和跨项目报表。 |

### 8.3 数字员工

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| TEAM-001 | P0 | 当前已验证 | RoleTemplate、DigitalWorker 和 Assignment 已具备原生持久模型、revision、Project scope、生命周期/历史、lease/fencing、重启恢复、跨 Project fail-closed 和 Assignment→WorkItem owner 协调。 |
| TEAM-002 | P0 | 当前已验证 | “招聘/加入团队”已通过当前 dirty checkout 的真实 Electron UI E2E 创建 CaoGen 原生 RoleTemplate/DigitalWorker、录入完整策略、分配 WorkItem，并跨重启证明无重复记录；招聘路径的外部 Agent CLI sentinel 为零调用，Provider/session/engine registry 保持不变。该结果不等于 clean release binding 或真实 Agent Run。 |
| TEAM-003 | P0 | 部分完成（policy persistence + execution guards） | 员工职责、权限、数据范围、预算、并发、验收和升级策略已持久化并进入 Studio；35 项 required checks 已覆盖 provider send、native tool、Claude tool authorization、Supervisor control 与 Assignment owner 的前置拒绝、重启恢复和拒绝时无 durable mutation。仍有五类 P0 绕过：Session/Run 未冻结 immutable workerId+assignmentId；OpenAI/Anthropic tool loop 后续请求与 Claude queued turn dispatch 不重检 Provider policy；`bash`、`gui_*`、`mcp_call_tool` 存在 composite capability 逃逸；Claude 仅靠 `canUseTool`，`bypassPermissions`/`allowedTools` 与未强制的 `PreToolUse` 仍可能绕过；monthly budget 依赖可截断/删除的 `sessions.json` 累计且漏算跨月 active session 与历史不可计费引擎。 |
| TEAM-004 | P0 | 立项目标 | 员工身份与 Provider/model 解耦，同一员工允许多个 ModelAttempt。 |
| TEAM-005 | P0 | 部分完成（retirement and Assignment history） | 退休员工不删除历史 Assignment、Run、Artifact、Evidence 和 Audit。 |
| TEAM-006 | P1 | 立项目标 | 根据 Goal 推荐 1 至 8 个必要岗位并由负责人汇总；每个岗位必须声明方法、工具、数据、预算、输出和 Acceptance，默认避免仅靠人设命名的无价值多 Agent 扩张。 |
| TEAM-007 | P1 | 立项目标 | 提供岗位记忆命名空间、项目记忆读取范围和用户确认式学习。 |
| TEAM-008 | P1 | 立项目标 | 绩效以 Acceptance 通过率、返工、成本、时效和可靠性计算。 |
| TEAM-009 | P2 | 后续规划 | 团队模板市场、岗位版本共享和组织级岗位策略。 |

### 8.4 自动跨厂商模型路由

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| ROUTE-001 | P0 | 当前已验证 | 基于任务、规则、健康、预算、成本、质量和速度进行模型选择。 |
| ROUTE-002 | P0 | 当前已验证 | 同 Provider 多 Key/多授权账号 failover 和跨 Provider failover；API Key 已支持手动/首选/自动模式、优先级、真实月度计费预算、已知 USD 余额底线与失败冷却；OAuth 账号已支持同三种模式、优先级、最低剩余配额、已知配额要求与失败冷却，应用显式账号绑定保持最高优先级。 |
| ROUTE-003 | P0 | 当前已验证 | Assistant 首次启动不显示 Provider/model/engine 选择；自动发现并激活固定 loopback 地址上正在运行的 Ollama、LM Studio 或 vLLM，无需 API Key 或 Project 即可经真实 Router/stream path 发送。无计算资源时提供非技术可恢复状态和“使用本机模型”入口，并可无损切换 Studio 后返回同一 canonical session 与 draft；不得将“已运行本地服务时零 Key”扩大为通用零前置试用。 |
| ROUTE-004 | P0 | 部分完成（two-native-engine local closure） | 每次路由形成 ModelAttempt 和可读 route reason；原生 Anthropic Messages 已接入可选 Engine/UI、每个 HTTP 请求独立 durable Attempt、NativeToolRuntime 工具循环、同 Provider Key/同协议 Provider failover 和图片重启恢复。真实 Provider、完整恢复阶梯、统一 Run/Context 契约与 clean release-bound 证据仍开放。 |
| ROUTE-005 | P0 | 立项目标 | Provider 切换保持 Goal、WorkItem、DigitalWorker、Run、上下文和 Artifact 连续。 |
| ROUTE-006 | P0 | 部分完成（resource privacy hard-policy foundation） | 预算、权限、隐私和能力要求必须高于成本/速度偏好，禁止不满足硬条件的候选。当前 Project Resource `deny/S3/local_only` 已在 Provider Attempt 前 fail-closed，`local_only` 冻结原 Provider 并禁止跨 Provider failover，SessionManager DAG 直连也在 Attempt/network 前复核实际 request-body digest；region/domain/capability/permission/budget、初始统一候选过滤、其他 adapter/direct-fetch 入口与完整 request manifest 仍开放。 |
| ROUTE-010 | P0 | 部分完成（canonical six-rung local recovery） | OpenAI-compatible 已接通“瞬时重试 → API Key/OAuth 账号 → 同 Provider 兼容模型 → 同协议健康 Provider → 会话级 Responses-to-Chat 协议降级 → 人工接管”的本地六级恢复阶梯；原生 Anthropic 在适用层级恢复并在耗尽后进入同一人工接管状态。安全重放保持同一逻辑 requestId 与 Attempt 前驱关系，未决 Effect 和部分输出会阻止重放；真实 Provider 交接与 clean release 绑定仍开放。 |
| ROUTE-007 | P1 | 立项目标 | 高风险或低置信度任务可自动交叉验证并记录独立 Evidence。 |
| ROUTE-008 | P1 | 立项目标 | 专家模式允许固定模型、限制厂商、设置本地优先或禁止数据外发。 |
| ROUTE-009 | P2 | 后续规划 | 基于长期接受率和真实质量反馈优化路由，不以厂商毛利作为隐藏因素。 |

### 8.5 Native Runtime 和 Supervisor

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| RUN-001 | P0 | 当前已验证 | CaoGen 以冻结、Provider-neutral 的 `caogen.native-runtime.v1` 统一持有 Session、Run、Context、Tool、Permission、usage、error、checkpoint、hook 和 recovery；Anthropic/OpenAI 两内置引擎生产创建路径均强制套 runtime guard。 |
| RUN-002 | P0 | 部分完成（adapter factories + boundary guards） | 两条生产 engine factory 已绑定 `anthropic.messages` 与 `openai.compatible` Adapter；原始 stream parsing 和 fragmented tool-call assembly 仍位于 `anthropicEngine.ts`、`openaiEngine.ts`，尚未达到纯协议 Adapter 隔离。 |
| RUN-003 | P0 | 部分完成（Anthropic production-path local closure） | 原生 Anthropic Messages 已注册到生产 SessionManager，并由本地门禁覆盖请求/流/用量/错误/取消、`tool_use/tool_result`、NativeToolRuntime 权限与 Effect、历史/图片重启恢复和保守 failover；OpenAI Responses、Chat Completions 与 Anthropic Messages 的统一 Run/Context/Checkpoint/Hook 契约、真实 Provider 和 clean release-bound parity 仍未整体关闭。 |
| RUN-004 | P0 | 部分完成（Supervisor foundation + identity/control bridge） | 本地 gates 已覆盖持久 heartbeat、lease 过期接管、fencing、controls、approval/reconciliation、审计、重启读回、TaskRun→WorkItem/Supervisor 身份绑定，以及受控 SessionManager pause/cancel/resume/retry/reassign；canonical 控制强制 expected revision，lease 动作强制 lease ID/fencing token，retry 在状态提交前预检 durable snapshot，paused Run 在 SessionManager 重建后仍阻止普通发送/自动 replay，failed resume 转 blocked 并保持发送门禁。`authorizeTurn` 仅允许 queued/running；renderer 的 direct store mutation/recovery 仅限 manual Run，TaskRun-owned control 缺少 active canonical runtime 时 fail-closed。Goal aggregate run/concurrency/token/USD limits 已在 canonical send reservation/turn/retry 覆盖。当前构建的 live Electron IPC 新负向因本轮端口审批失败未执行；Studio UI、所有执行入口 policy parity、自动编排、真实 Provider parity、跨文件事务补偿和跨域强杀恢复仍开放。 |
| RUN-005 | P0 | 部分完成（canonical cross-domain strong-kill recovery foundation） | `test:domain-restart-parity:required` 在 Project→Goal→WorkItem→TaskRun→Supervisor→opaque Effect 单链上，于 Effect `executing` 且发生一次外部执行后实际 `SIGKILL`，全新进程恢复为 `waiting_reconciliation`，拒绝自动续跑，过期 lease/旧 fence 被拒绝，ID/ownership/revision/`runRefs` 稳定，重复恢复幂等且自动 replay 为 0。所有非终态、Board、Approval、Artifact、Acceptance、真实 Provider 和 clean release 仍未覆盖，故不关闭本项。 |
| RUN-006 | P0 | 部分完成（legacy metadata migration） | 旧 `engine: claude` Provider/会话元数据迁移为 `anthropic`；CaoGen transcript 可读/可 fork，不伪称恢复 SDK 隐藏上下文。 |
| RUN-007 | P1 | 部分完成（runtime removed） | Claude Agent SDK/CLI/AgentSession 已删除，本地 unsigned Intel 包体和真实 renderer 已复验；待完成精确提交 Deep、签名候选绑定和兼容资产边界审核。 |
| RUN-008 | P2 | 后续规划 | 独立后台服务、远程 Runner 和 Desktop 关闭后继续执行。 |
| RUN-009 | P2 | 已取消 | 不再计划恢复 Claude Agent SDK 兼容运行时。 |

### 8.6 Trust、Effect 和审批

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| TRUST-001 | P0 | 当前已验证 | 主要文件编辑和 Git commit/merge/push 已有 Effect/Reconciler 基础。 |
| TRUST-002 | P0 | 部分完成（static entrance inventory foundation） | Required AST gate 当前发现并登记 339 个工具、IPC、IPC action 与显式外部入口：117 read-only、222 mutation；123 `none`、46 `opaque/manual_only`、143 `durable_local/idempotent_resume`、27 `queryable/reconcile_before_retry`。15 种 EffectTarget 均有 Reconciler，漏登记入口、mutation 伪装只读、缺失 Reconciler 和 opaque 自动 replay 均 fail-closed；Acceptance review 还被显式锁定为 durable mutation。动态注册之外的入口完备性、注册表与运行时 enforcement 一致性，以及逐 mutation 权限/预算/强杀/恢复仍开放。 |
| TRUST-003 | P0 | 部分完成（local external-effect recovery foundation） | PR、Issue、消息、可查询 MCP、Code Forge 和 Renderer 直接入口具备专用对账策略。GitHub/GitLab Issue 使用 marker 查询；MCP 只接受显式 `readOnlyHint=true` 查询器的后置条件；飞书/钉钉/企业微信未知结果永不自动重发。本地合成 external recovery `15/15` 与 notification `22/22` 已覆盖强杀、重启、零自动 replay/resend 和凭据脱敏；真实远端 readback、网络分区/限流矩阵、所有 connector parity 与 clean release 绑定仍开放。 |
| TRUST-004 | P0 | 部分完成（registered replay-policy foundation） | 入口清单要求 queryable mutation `reconcile_before_retry`、opaque mutation `manual_only`、durable local mutation `idempotent_resume`；现有文件/Git/Issue/MCP/消息重点路径已通过强杀/重启 gate。该元数据规则尚未证明所有 222 个 mutation 的生产执行器都在每个重放入口复核策略，未知动态入口、跨域补偿和逐入口 strong-kill 仍开放。 |
| TRUST-005 | P0 | 部分完成（v9 Workflow/Conversation recovery foundation） | `task-snapshots.db` v9 保留 TaskRun Effect evidence append-only hash-chain，并包含 Goal/WorkItem/Run/Artifact/Acceptance/Evidence Link、workflow event chain、canonical recovery sessions 与按 generation 保留改写历史的 Conversation Ledger archive；JSONL 缺失可从 DB 当前代恢复，损坏文件 fail-closed，Project 永久删除同步清理并记录授权计数。生产 Goal/WorkItem list/get 已默认从 verified rich view 读取，生产命令已切为 Ledger-first、JSON 投影。Responses 服务端上下文持久游标已接入会话历史和快照；`test:provider-neutral-recovery:required` 已覆盖 archive/generation、防篡改、DB fallback、无副作用 portable replay、双进程 OpenAI→Anthropic fork 和 Checkpoint/Effect boundary。未配置时 Task Snapshot/Run 恢复仍默认 legacy；其他业务入口、完整 Artifact/blob/sourceRef 生命周期、真实 Provider 强杀/跨协议证据、统一 retention/export/import 和生产补偿计划/审批/执行仍待完成。 |
| TRUST-006 | P0 | 当前已验证（基础） | 新密钥的可逆 `b64:` 持久化 fallback 已移除并由主进程 Broker 提供；模型发现使用已存 Key 时已强制绑定保存的 Base URL、路由头、鉴权头名和协议，拒绝 renderer 替换网络目标。`test-results/provider-runtime-containment/2026-08-01T01-58-13-107Z/report.json` 以 97/97 通过 Broker record、fresh-process session-only 隔离、单一 DAG raw resolver consumer、OpenAI/Anthropic scoped credential lease、动态 import/require 拒绝、全 IPC/preload/Renderer server-only 类型隔离、`ProviderView` 精确投影，以及七个 Provider channel 的目标函数、返回类型、恰好一次根委托调用与可达性审计；对抗性 AST/语义负例拒绝嵌套、序列、部分控制流、TypeScript 可报告的不可达、重复或非最终目标调用。该门禁使用确定性加密 backend test double，不证明平台密码学强度；provider/project/session/operation/expiry 作用域、所有子进程最小环境和全输出 secret canary 仍开放。 |
| TRUST-007 | P1 | 立项目标 | 插件/MCP 安装、版本变化和能力扩大显示 provenance、digest 和 capability diff。 |

### 8.7 Artifact、Evidence 和交付

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| ART-001 | P0 | 部分完成（lifecycle contract + Code Forge/Office producers） | canonical Artifact 生命周期当前覆盖 17 种 required kind、digest/provenance/version/creating Run、supersession、blob/sourceRef、retention/purge、重启、字节篡改与跨 Project fail-closed；生产 Code Forge patch 与 Word/Excel/PowerPoint/PDF 已从 confirmed Effect 接入 Artifact/Evidence/Acceptance。Office Effect 在批准时冻结来源 identity/bytes/digest 和确定性输出 SHA-256/长度；执行与恢复对账精确验证真实字节，拒绝同格式异内容文件，旧 target 缺少冻结输出身份时要求重新审批。Artifact→Acceptance 缺口状态也由 handoff fail-closed，但完整强杀 checkpoint 矩阵尚未证明。report、design、screenshot、test、release、PR 及其他重要生产者仍未全部接入，不能视为“所有重要产物”闭环。 |
| ART-002 | P0 | 部分完成（Acceptance identity and evidence hardening） | `done/completed` 门禁已要求 Acceptance/Evidence，支持逐 criterion Evidence link、可选不可变 kind/source policy、live-store/event/source/Artifact byte 复核，以及冻结 Run 所属 Acceptance ID/revision 的受限 failure ingress；旧 Run 首次晚到不得漂移到新 revision。repair-derived policy 传播已覆盖新建、重复恢复和启动恢复；policy authoring 与 review/evidence 选择 UI 已由真实 Electron required gate 覆盖多 criterion kind/source、空 source 拒绝、按 criterion 匹配 Evidence、通过和重启一致性；其余生产者、repair/retest review 和不可变端到端交付链仍开放。 |
| ART-003 | P0 | 部分完成（Office/Code Forge + local verified staged-flow foundation） | 生产 Code Forge 与通过验收的 Office Artifact 会附加到 producing WorkItem，并按显式引用、dependency、parent 或同 Goal prior-stage 选择最多 24 个上游 Artifact；三条内置引擎都会注入 artifactId/digest/location handoff，自动 lineage 排除同 Run 兄弟输出。resolver 现在要求 Artifact 至少有一个 Acceptance link、每个链接都能解析到 Acceptance，且全部为 `passed/waived`；failed、missing 或无 link 的 Artifact 均不交接。Artifact 已持久化而 Acceptance/Evidence/Link 未完成的窗口已由当前进程与独立进程 readback 负向 gate 覆盖；完整调研→需求→设计→实现→审查→修复→测试→交付状态机、真实 Provider/用户、返工和逐 checkpoint 强杀矩阵仍开放。 |
| ART-004 | P0 | 部分完成（repair/retest + repaired Artifact byte-flow local closure） | 审查失败已幂等创建 canonical repair WorkItem/Acceptance，启动时恢复缺失 repair，完成后清空本轮 Evidence/Verifier 并进入新的 verifying revision；repair Acceptance 现在继承并按 repair criterion ID 重新绑定原 policy 的 kind/source 约束。跨阶段 Artifact 交付、不可变端到端 Evidence 链、UI 和 release-bound 强杀证据仍开放。 |
| ART-005 | P1 | 部分完成（canonical delivery report + Office/staged handoff foundation） | 已从 verified canonical records 生成 renderer-safe 统一结果与机器可读交付报告，覆盖目标/范围、WorkItem、Run、Artifact 位置/版本/摘要、Evidence、Acceptance、测试、已知成本覆盖率、风险、未完成项、审批和审计；JSON 导出绑定 SHA-256 且排除 Provider/模型响应与原始 Run 错误。最新自动化已证明两层 DAG、六个工具交接和四种真实文件字节的本地 Office producer/handoff 保持 Artifact/Evidence/Acceptance 身份；真实代码/Office 用户主链、原生应用打开、完整历史成本、返工/下载真人验收与 clean release 绑定仍开放。 |
| ART-006 | P1 | 条件可用 | GitHub/GitLab PR/MR 依赖 `gh`/`glab`、远端账号和权限；失败时保留 patch 或本地交付包。 |
| ART-007 | P2 | 立项目标 | 通用远端 Issue/Release 连接器必须具备明确账号范围、Effect/Reconciler 和失败恢复后再进入正式交付链；现有局部入口不等于通用支持。 |

### 8.8 Routines、记忆和 Skill

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| AUTO-001 | P1 | 当前已验证 | 本地 Routine、cron、运行记录、通知和防休眠。 |
| AUTO-002 | P1 | 立项目标 | Routine 到期后创建 WorkItem/Run，并关联 DigitalWorker 和 Project Inbox；结果、失败、预算超限和待审批进入同一 Artifact/Evidence/通知链。 |
| AUTO-003 | P0 | 当前已验证 | 自动/模型 Memory、自动 Skill review 与 `optimize_skill` 统一先写入 project-scoped draft，记录来源、置信度、payload digest、完整 before/after diff 和目标路径；未批准草稿不会进入有效 Memory、prompt 或写入 `SKILL.md`。 |
| AUTO-004 | P0 | 当前已验证 | 仅主进程签发的可信用户决定可使 Memory/Skill 生效；统一生命周期支持 approve/reject、单调版本、revoke、rollback、expiry、delete、审计和重启恢复，Skill 物化采用 fail-closed journal；仅已批准且未过期的 Memory 进入 Anthropic、OpenAI Chat/Responses prompt。 |
| AUTO-005 | P2 | 后续规划 | 提供设备绑定的远程任务发起、续接、审批、结果查看、跨设备通知、幂等 Webhook 触发和可选远程 Runner；默认仍由用户绑定设备执行，本地文件与凭据不上传到远程控制通道，离线/休眠/解绑状态必须明确且可审计。 |

### 8.9 水墨轻动漫 3D 团队

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| VIS-001 | P0 | 当前已验证 | 3D 场景已消费真实会话、任务、审批、成本、Provider、worktree 和 Git 状态。 |
| VIS-002 | P1 | 立项目标 | 移除面向用户的机器人主角色，替换为原创或授权明确的水墨轻动漫人物。 |
| VIS-003 | P1 | 部分完成（身份合同、招聘与 Office 绑定） | 七岗位身份写入 Provider-neutral `DigitalWorker.avatarProfile.watercolorRole`；RoleTemplate 语义和稳定 ID 只作回退。真实 Electron 已验证显式选择与重启持久化；Office 通过不可变 DigitalWorkerBinding 解析人物身份并接入透明资产 Rig，最终资产尚未登记。 |
| VIS-004 | P1 | 部分完成（真实 Session + canonical repair 状态投影） | OfficeModel 已从真实 Session 派生 idle/thinking/tool-running/awaiting-approval/blocked/delivering；活动 Session 仅在绑定规范 `workflow-repair:<SHA-256>` WorkItem 时进入 `repairing`，审批与失败状态保持更高优先级。Artifact 合成和最终渲染 E2E 尚未完成。 |
| VIS-005 | P1 | 部分完成（49/49 正式运行时资产；真人盲测开放） | 七个标准角色与七种状态均已有 prompt/hash 记录和透明运行时派生资产；required gate 已验证 49/49 个 1024x1536 RGBA PNG 及明暗背景、96px/48px 灰度 contact sheet。外部真人盲测的角色/状态辨识证据仍开放。 |
| VIS-006 | P1 | 部分完成（96px/48px 专家 QC） | 现有三状态已做彩色、96px 与 48px 灰度检查；状态文字/图标/形状的真实界面合成与至少 10 人盲测尚未完成。 |
| VIS-007 | P1 | 部分完成（49/49 透明资产已接入） | 透明 2.5D Sprite Rig 已区分 full/compact 尺寸、遵守 reduced-motion，并通过显式文件门禁接入全部 49 个登记资产；损坏或缺失文件仍回退机器人，现有 Office 质量档和非 3D 列表回退继续有效。最终 49 资产的显存、draw-call、包内摘要、目标硬件与自动降级证据尚未完成。 |
| VIS-008 | P2 | 后续规划 | 用户自定义服装、发型、空间主题和团队合影，不引入受版权保护的现有动漫 IP。 |

### 8.10 连接器和协作

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| CONN-001 | P1 | 当前已验证 | 插件、Skill、MCP 扫描、调用和基础治理。 |
| CONN-002 | P1 | 立项目标 | 连接器作为 Project Resource、Knowledge Source 或 Tool 接入，不成为外部 Agent 员工；必须声明 capability、数据方向、个人/共享授权主体、作用域、版本和撤销行为，读取结果保留 source/version/retrievedAt 引用，写操作进入 Effect/Reconciler。 |
| CONN-003 | P2 | 后续规划 | Jira、Linear、Notion、飞书、Slack、Teams、Figma/Ardot 等双向连接器和知识检索；统一支持个人授权与管理员共享授权、增量刷新、权限变化、引用、删除和跨 Project 隔离。 |
| COLLAB-001 | P2 | 部分完成（本地单用户转交基础） | 多用户、任务分享/转交、评论、提及、共享审批和组织策略；转交保持 Goal/WorkItem/Artifact/Evidence 身份和不可变审计。当前 Studio 已支持将 WorkItem 转交给同 Project 的人员或 active DigitalWorker；main-owned actor、WorkItem owner/active Assignment 原子协调、旧 lease 撤销、旧/新 owner 权限重算、原因/audit、CAS、幂等和重启读回已通过本地 required gate 与真实 Electron E2E。真实多用户身份、分享、评论、提及、共享审批、组织策略、Webhook 和统一 retention/export/delete 仍未实现。 |
| COLLAB-002 | P2 | 明确不做 | 1.0 不自建团队聊天、会议和完整协同办公套件。 |

### 8.11 AI 视频工作室(post-1.0)

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| VID-001 | P2 | 后续规划 | 从小说、剧本或大纲生成可编辑的 VideoProduction / Episode / Scene / Shot 结构；解析结果必须版本化，用户修订不得被下一次生成静默覆盖。 |
| VID-002 | P2 | 后续规划 | 提供角色、服装、场景、道具、声线、关键帧、字幕和音轨资产库；Shot 显式绑定资产版本，所有二进制内容进入 canonical Artifact Graph。 |
| VID-003 | P2 | 后续规划 | 提供角色 Bible、资产锁定、参考图和跨镜头/跨集一致性约束；一致性是可检查的目标和 Evidence，不得仅以复用同一段提示词宣称已经保证。 |
| VID-004 | P2 | 后续规划 | 新增独立于聊天 Engine 的 Media Provider Adapter，统一声明 `image.generate/edit`、`video.text/image/reference-to-video`、`speech.synthesize/voice-clone` 和 `media.compose` capability；领域模型不包含厂商品牌。 |
| VID-005 | P2 | 后续规划 | 每次外部生成创建持久 MediaJob，保存幂等键、外部 job ID、输入摘要、Adapter 版本、轮询观察、成本和输出摘要；断网、限流、崩溃和未知结果必须先对账后重试。 |
| VID-006 | P2 | 后续规划 | Video Studio 提供剧本结构、资产库、分镜表/Storyboard Grid、镜头参数、版本采用、批量生成和任务队列；无限画布和完整专业时间轴不是 MVP 前置条件。 |
| VID-007 | P2 | 后续规划 | 支持多角色声线绑定、TTS、对白时序、字幕编辑和可替换音轨；声音克隆必须显示来源、授权状态和 Provider 数据外发范围。 |
| VID-008 | P2 | 后续规划 | 使用受控本地 FFmpeg 或等价 Adapter 合成镜头、对白、字幕和音轨；记录二进制来源、版本、codec、命令摘要和输出 digest，失败合成不得覆盖已采用成片。 |
| VID-009 | P2 | 后续规划 | 图片、音频和视频采用流式下载/写入、增量 SHA-256、磁盘配额和可恢复临时文件；视频/音频预览支持 Range 或受控本地协议，Renderer 不承载无上限 data URL。 |
| VID-010 | P2 | 后续规划 | 每个镜头和最终成片可追溯到剧本版本、资产版本、提示词/参数摘要、MediaJob、Provider、成本、人工采用决定、Evidence 和 Acceptance；提交任务、生成完成和成片验收必须是三个不同状态。 |
| VID-011 | P2 | 后续规划 | 第三方视频项目默认只作产品/协议研究；可选本地 sidecar 或 MCP/HTTP 连接器必须由用户安装和授权，声明版本、capability、数据方向、许可证与撤销行为，且不得绕过 CaoGen Effect、凭据、Artifact 和恢复合同。 |

## 9. 非功能需求

### 9.1 本地优先和隐私

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| NFR-PRIV-001 | P0 | 部分完成（inventory + 完整导出 + 当前参与者可恢复导入/删除） | `local-data-map.ts` 已机器登记 32 个数据条目、53 条路径和 17 类顶层 Project 对象；最新 required report `716/716` 且 `unregisteredSources=[]`，但仍为 29 个 `partial` + 3 个 `inventory_only`、0 个 `enforced`；sealed/sanitized export 按精细类型覆盖 18 类。`0600` 私密导入源/删除备份、durable import/delete journal、启动续做、RoleTemplate 依赖解析、当前 Project/Session 参与者清理、全局 hash-chain 重建、授权删除完整性账本、proof 和 residual scan 已实现。消息连接器作为全局用户配置排除于 Project export/delete；统一 retention 时钟、其余 inventory owner proof、Artifact blob、Session/transcript/snapshot/ModelAttempt、旧路径 Memory、其他 connector 合同和全 inventory 证明尚未关闭。证据：`test-results/local-data-map/2026-07-31T08-31-42-062Z/report.json`。 |
| NFR-PRIV-002 | P0 | 部分完成（partial preview + resource no-egress foundation） | UI 必须显示将发送给 Provider 的完整上下文范围，敏感资源可配置禁止外发。当前 Studio 已提供 S0-S4 与 `allow/local_only/deny`，Composer 显示接收方、数据等级、排除项并明确标记“部分范围”，Provider Attempt 前会复核 Resource 策略；Claude `@文件` 已做 canonical containment，DAG 直连绑定实际 request-body digest。完整 system/Skill/tool/history/MCP/connector/自动入口预览、强制预览时序、持久 request binding 和 Claude SDK 内部请求仍开放。 |
| NFR-PRIV-003 | P0 | 立项目标 | API Key、访问令牌和证书不得进入 Renderer、转录、Artifact、Memory、导出包或普通日志。 |
| NFR-PRIV-004 | P0 | 当前已验证 | 本地模型和内网网关按与远端 Provider 相同的能力、预算、健康和 failover 规则参与自动/手动路由与交叉验证，不因位置或协议标签被降分；自动发现只访问固定 loopback HTTP 地址，不扫描 LAN。无鉴权只允许 loopback OpenAI-compatible Provider，不保存伪造 Key、不发送 `Authorization`，远端无鉴权目标必须 fail-closed；重复激活必须幂等。 |

### 9.2 可恢复性和一致性

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| NFR-REC-001 | P0 | 立项目标 | 已向用户确认成功的数据写入不得因应用崩溃丢失。 |
| NFR-REC-002 | P0 | 部分完成（durable writer inventory foundation） | `test-results/durable-write-inventory/2026-08-03T14-22-17-696Z/report.json` 以 13/13 登记 76 个模块和 432 个写入调用，并要求每个 writer 声明 schema/version 与 atomic/transaction/log/delegated/direct/exempt 策略；Permission Audit 与 Conversation Ledger 已推进为 implemented-unverified，当前仍有 7 个 recovery gap、7 个显式 schema gap。Conversation Ledger 已覆盖 canonical append 文件 fsync、replace/copy candidate fsync、原子 rename、POSIX 目录 fsync、严格损坏拒绝和故障注入；Windows 目录 durability/ACL 仍未形成同等级证据，不能据此声称所有领域写入已版本化或可恢复。 |
| NFR-REC-003 | P0 | 部分完成（canonical cross-domain and Provider Profile strong-kill foundations） | 当前 9/9 门禁证明一个 canonical Project/Goal/WorkItem/TaskRun/Supervisor/opaque Effect 链跨实际 `SIGKILL` 的一致恢复、待对账分类、fencing 和幂等；Provider Profile 的独立 13/13 跨进程/强杀门禁（`test-results/provider-profile-restart/2026-07-31T18-36-15-308Z/report.json`）覆盖存活 owner 的 `LOCK_HELD` 竞争、失败 candidate 清理、同进程可重入、正常释放竞争、import/rollback checkpoint、死锁回收、备份绑定篡改拒绝、pending writer 阻断、同进程收敛与重复恢复字节稳定。Board、Approval、Artifact、Acceptance、其他非终态、真实 Provider、Windows ACL 与 clean release 仍未证明；当前 Provider Profile Electron UI 由独立 54/54 gate 覆盖。 |
| NFR-REC-004 | P0 | 部分完成（Supervisor lease/fencing foundation） | Supervisor 记录已证明并发 CAS、过期接管、陈旧 writer 拒绝和单调 fencing token；canonical WorkItem 的所有执行入口尚未共用同一 lease ownership/release 约束，不能宣称完整 WorkItem 执行 lease 保证。 |
| NFR-REC-005 | P0 | 立项目标 | 所有迁移支持预检、备份、幂等重跑和回滚。 |

### 9.3 可审计性

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| NFR-AUD-001 | P0 | 部分完成（canonical audit timeline foundation） | 用户能够回答“谁/哪个岗位、何时、为何、用什么模型、调用什么工具、产生什么结果”。 |
| NFR-AUD-002 | P0 | 部分完成（canonical audit timeline foundation） | Provider/model、路由原因、成本、审批、Effect 和 Evidence 可按 Run 查看。 |
| NFR-AUD-003 | P0 | 部分完成（credential-attributed Provider ledger foundation） | Canonical ModelAttempt 记录安全 `label:`/`sha256:` Key 标识；Provider 请求账单可按凭据筛选和聚合成本、成功率与 Token，并在请求明细和 CSV 中显示安全标识。已保存的非敏感 Key 名称仅在能由哈希反向关联且通过凭据值检查时展示，否则降级为截断 SHA-256；明文凭据不进入 Usage 契约。所有其他日志、事件、导出和子进程输出的全局 canary 证明仍开放。 |
| NFR-AUD-004 | P1 | 部分完成（Project aggregate export/import + 当前删除证明） | 项目导出已包含 schema-versioned、封存、脱敏的机器可读 Project Aggregate、显式依赖和可复算 SHA-256 `exportDigest`；当前参与者集合可从私密源经 durable journal 导入并做语义等价、重新封存和重启读回。私密删除备份可严格读回，当前 Project/Session 删除参与者生成绑定授权删除记录和零残留扫描的可复算 proof。每个 Artifact/Evidence blob 文件级 digest package、Session/ModelAttempt 等全量可移植包和全 inventory 删除证明仍开放。 |

### 9.4 性能和资源

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| NFR-PERF-001 | P1 | 当前已验证（clean baseline + dirty-worktree targeted regression） | clean `1675eb50` 的真实 Electron required gate 覆盖 desktop/tablet/mobile：3 个 fresh-process cold shell 样本 P95 `31.4ms`，60 个 warm 样本 P95 `32.4ms`，阈值保持 `<300ms`；证据为 `test-results/assistant-studio-performance/2026-07-28T05-20-41-787Z/report.json`。较新的 dirty-worktree targeted gate 为 cold P95 `156.9ms`、warm P95 `238.1ms`，各视口仍严格 `<300ms`，并保持 Provider 响应挂起、Session/runtime/canonical Run/请求身份不变；证据为 `test-results/assistant-studio-performance/2026-07-28T19-59-33-903Z/report.json`。Project/Goal/WorkItem hydration `1204.5–1516.9ms` 是独立诊断，不属于切换延迟声明；dirty targeted pass 不替代 clean candidate、其他硬件或系统高负载下的 release 性能证据。 |
| NFR-PERF-002 | P1 | 部分完成（1,000-item virtualization foundation） | 1,000 个 WorkItem 的 List/Board 已采用固定尺寸虚拟化并通过真实 Electron 有界 DOM 验证；参考设备上的初次可交互 P95 <1s 仍待独立测量。 |
| NFR-PERF-003 | P1 | 立项目标 | 路由本地决策目标小于 500ms，不含 Provider 网络请求。 |
| NFR-PERF-004 | P1 | 立项目标 | 3D 在定义的参考设备和 12 个可见员工场景保持可交互；不达标时自动降级 LOD 或列表。 |
| NFR-PERF-005 | P1 | 立项目标 | 3D 未激活时限制帧率和资源占用，不得影响正在执行的任务。 |

### 9.5 可用性和可访问性

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| NFR-UX-001 | P0 | 立项目标 | Assistant 不暴露 Provider、Token、MCP、Git、DAG 等非必要术语；首屏应提供 3-5 个覆盖代码与办公场景的一键任务，预设必须绑定 `view / plan / execute` 策略、明确产物与恢复方式，不要求先创建 Project，也不得因双击产生重复 Session 或模型请求。 |
| NFR-UX-002 | P0 | 立项目标 | 待审批、失败、未知副作用和验收失败在两种模式均可见。 |
| NFR-UX-003 | P1 | 立项目标 | 核心流程全键盘可达，图标按钮具备名称和 tooltip。 |
| NFR-UX-004 | P1 | 立项目标 | 状态不能只依赖颜色，必须同时使用文字、图标或形状。 |
| NFR-UX-005 | P1 | 立项目标 | 中文和英文文案不得溢出、遮挡或改变固定控制布局。 |

### 9.6 厂商中立

| ID | 优先级 | 状态 | 需求 |
|---|---|---|---|
| NFR-NEUTRAL-001 | P0 | 当前已验证 | DigitalWorker、Goal 和 WorkItem 的 schema 不含 Provider/model/engine 身份字段；DigitalWorker create/update 与 v1/v2 read/migration 对嵌套厂商身份污染 fail-closed，拒绝时 Store/Worker revision 不变。 |
| NFR-NEUTRAL-002 | P0 | 部分完成（credential user policy foundation） | API Key 路由已按用户设置的优先级、月度预算、已知余额底线与失败冷却执行；OAuth 账号路由已按用户模式、优先级、最低剩余配额、已知配额要求与失败冷却执行。能力、质量、速度、隐私及完整跨模型/Provider 恢复阶梯仍开放。 |
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

**当前基础**：`src/main/data-lifecycle/local-data-map.ts` 是本机持久化数据的机器可校验 inventory。它覆盖 32 个数据条目、53 条路径和 17 类顶层 Project aggregate 对象，并把每个条目标为 `enforced / partial / inventory_only`；当前 required report 明确显示 29 个条目仍为 `partial`、3 个仍为 `inventory_only`，没有 `enforced` 条目。Studio 已接入完整、脱敏、封存的 owner-scoped Project Aggregate 导出，但这不替代下列目标策略，也不证明统一 retention/delete 已执行。

**立项目标**：

- Project、Goal、WorkItem、Artifact、Acceptance 和关键 Audit 默认保留至用户显式删除。
- 转录、Run、Effect 和 Evidence 默认随 Project 保留，允许项目级策略缩短周期。
- 可再生缓存、缩略图和临时预览使用可配置 TTL，默认 30 天。
- worktree 不得因归档或超时被静默强制删除；只提示清理并要求确认。
- 自动学习的 draft 可设置过期时间，过期不自动进入确认层。

### 11.3 导出

**当前基础**：生产 Project Aggregate 服务在稳定读取后以 expected revision 封存，生成 schema-versioned canonical JSON、SHA-256 `exportDigest` 与 `sanitized/sealed` verification；Studio 支持复制和下载该完整 bundle。Provider 凭据被排除，敏感字段由 aggregate codec 脱敏并校验。当前基础不包含导入/readback，也不等于 Artifact/Evidence 文件内容打包。

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

- “对话”分组中的会话继续保持内部 `unassigned` 状态，或在用户确认后关联到系统 Personal Workspace。
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
- 旧 `engine: claude` 会话元数据迁移为 `anthropic`。
- 旧会话允许只读、导出和从 CaoGen transcript fork；不得伪称恢复 SDK 未记录的隐藏上下文。

### 12.7 Project 可移植包

**终极要求**：用户只需选择一个 Project 包即可在另一 CaoGen 环境读回并继续工作，不需要先创建空 Project、手工复制角色模板、绑定原 Provider 或填写额外路径。包必须声明 schema、Project 身份、对象计数、依赖、文件摘要、脱敏状态和导出摘要；导入必须先预检，再以 durable journal 执行，应用强杀后可继续或安全阻止。

导入规则：

- 保留 Project、Goal、WorkItem、Run、Artifact、Evidence、Acceptance、Memory、DigitalWorker、Assignment 和 Lease 的 canonical 身份与 revision；目标环境专用的 hash-chain 坐标允许重建，但语义摘要必须等价。
- RoleTemplate、Skill、MCP、连接器和其他全局依赖必须形成显式 manifest；缺失且内容匹配的依赖可安装，已存在的等价依赖可复用，同 ID/版本但内容冲突时必须在任何 Project 写入前 fail-closed。
- Artifact/Evidence blob 必须按内容摘要打包并复验真实字节；外部 Resource 只保留引用和边界，除非用户明确选择并授权复制。
- Provider Key、认证、Cookie、Header、URL 凭据和原始敏感错误不得进入包；Provider/model 只作为可选历史观测，不成为继续工作的硬绑定。
- Session/transcript/snapshot/ModelAttempt、旧路径 Memory 和 connector 状态必须有明确导入、只读兼容或“不包含”清单，不能静默丢失。
- 重复导入、篡改、身份冲突、依赖冲突和部分写入均不得破坏已有 Project；成功后必须重新封存、逐类计数、语义读回并在重启后复验。

**当前实现基础**：单个 JSON 已覆盖当前 Project Aggregate 参与者集合、完整 TaskRun、Artifact Graph 元数据、两类 Evidence、Acceptance、DigitalWorker/Assignment/Lease、canonical Learning 和 RoleTemplate 自动依赖；私密源、阶段 journal、Workflow dry-run、写前/写后故障恢复、链重建、重新封存、语义读回、删除墓碑恢复、无关 Project 保留、重复/篡改拒绝及真实 Electron 重启已通过本地自动化。Artifact blob、Session/transcript/snapshot/ModelAttempt、旧路径 Memory、Skill/MCP/connector 依赖和全 inventory owner proof仍开放，因此本节目标与 `PROJ-004` 继续保持部分完成。

### 12.7 视觉设置迁移

- 当前机器人/角色外观设置映射到新的默认水墨人物配置。
- 用户的画质、Badge、动效强度和布局偏好尽量保留。
- 旧资产仅在迁移和回滚窗口内保留，不再作为 1.0 用户主视觉。

### 12.8 Provider Profile 可逆迁移

- 导出文档必须版本化，默认排除 API Key、Token、加密凭据和活动 Key 引用；导入文件即使含凭据字段也必须忽略并明确警告。
- 应用前必须预览 Provider 名称、Base URL、引擎/协议、匹配目标、冲突类型和变更字段，允许用户逐项选择新建、更新或跳过；多义匹配默认跳过。
- 只有名称和目标绑定身份都精确匹配，且 Base URL、引擎、协议、自定义路由头、凭据头均未变化时，更新现有 Provider 才可保留 Broker 凭据；任一目标绑定变化必须隔离旧凭据并要求显式替换后重绑。新 Provider 不得从可移植 Profile 获得 Key；切换 `authMode:none` 必须删除旧 Key，切回时重新录入。
- 应用前自动生成本机私密备份，备份需有完整性 digest；批量变更只能全部提交或全部回滚。一键回滚前再备份当前状态，使回滚本身可逆。
- Import/rollback 写入必须共享跨进程 mutation lock，并在锁内复核预览 CAS。Durable journal 必须绑定前后 Store digest 以及 safety/source backup ID + digest；强杀恢复只允许把已发生结果分类为 committed/aborted，第三 digest 或备份替换必须进入 `waiting_reconciliation`，不得自动 replay。
- 当前无 GUI Service/Store 自动化以 `135/135` 覆盖上述安全切片、活动 Key 标签/数量、目标凭据绑定变化、权威快照语义、journal malformed/篡改/symlink/超限及文件读取边界，并证明 backup 文件名/内嵌 ID 不一致时回滚失败且 Store 不变（`test-results/provider-profile-smoke/2026-07-31T18-36-07-764Z/report.json`）；真实跨进程/`SIGKILL` gate 以 `13/13` 覆盖存活 owner 的 `LOCK_HELD` 竞争、失败 candidate 清理、同进程可重入、正常释放竞争、import/rollback checkpoint、死进程锁回收、重复恢复字节稳定、同进程对账收敛和 6 类 pending writer 阻断（`test-results/provider-profile-restart/2026-07-31T18-36-15-308Z/report.json`）。该 gate 精确断言 `prepared`/waiting 期间普通 writer 与伪造 operation ID 都不能旁路冲突；第三 Store digest 先持久进入 `waiting_reconciliation`，Store 修复为 before/desired 后分别收敛为 `aborted`/`committed` 并恢复普通写入。safety/source backup 在 Store commit 前和 terminal 前复核 ID/digest，prepare 后或 Store commit 后篡改均 fail-closed，恢复冻结字节后才收敛并恢复写入。死 owner 回收按设计保留一个有 5 分钟保护期的 bounded recovered tombstone。当前 Electron required gate 以 `54/54` 通过真实主进程 IPC、Renderer 与四张截图覆盖危险 URL 拒绝、预览/应用、跨启动回滚、脱敏备份/导出、活动 Key 标签与凭据影响说明、Key 删除取消/确认/重新录入及 `760x700` 布局（`test-results/provider-profile-e2e/2026-07-31T18-36-51-341Z/report.json`）。Windows ACL 和 Provider Store 顶层 schema 版本化仍未验证；最终关闭还必须在真实 Provider 下完成模型发现、健康检查、默认切换和故障切换，并由真实用户完成计时迁移及 clean release 绑定。

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

**当前证据边界**：完整脱敏封存导出和当前参与者集合导入已由真实 Electron `19/19` gate 覆盖删除后单文件恢复、无关 Project 保留、Run 读回、重复/篡改拒绝和重启持久化；`test:project-import` 另覆盖私密源、RoleTemplate 自动依赖/冲突、Workflow 写前 journal 故障续做、语义读回和重新封存。`test:project-permanent-deletion` 覆盖删除前私密备份、durable journal、首批跨 Store 与 Session/Workflow 物理清理、双 Project hash-chain 隔离、deletion proof、篡改拒绝、residual scan 和外部源保留。全 inventory owner proof、Artifact/Evidence blob、Session/transcript/snapshot/ModelAttempt、旧路径 Memory 和 connector 包仍开放，因此 AC-13 未关闭。

### AC-14 水墨数字团队

**操作**：打开包含至少 12 个员工及运行、审批、失败、完成状态的 3D 场景。
**通过条件**：用户可通过人物、文字、图标和形状识别岗位与状态；动作来自真实事件；无机器人主角色；性能不足时自动降级且核心操作可用。

### AC-15 通用办公成品（P1 黄金路径）

**操作**：用户提供会议材料和数据表，要求生成带来源的决策纪要、可计算表格和演示文稿。
**通过条件**：三个文件均可在目标应用打开；进入同一 Project 的 canonical Artifact；统一结果工作台可查看工作区、变更、结构/视觉预览、引用和版本；导出包包含 manifest/digest；格式或来源验收失败时不得标记 Goal 完成。

**当前证据边界**：`npm run test:office-delivery:required` 最新以 40 项本地检查证明 Word/Excel/PowerPoint/PDF 四种 production tool 统一经过 durable Effect、Artifact、Evidence、Acceptance 与 dependency handoff；结构化输入、输出竞态、来源文件 identity/bytes/SHA-256、批准输出字节身份、失败自检、跨 Project、伪造 confirmed Effect、同格式异内容文件、重复执行、缺失 Acceptance、三时区确定性和独立 Node 进程重启均 fail-closed。6 个 confirmed Effect 中 5 个具备 v1 output binding，1 个旧 confirmed Effect 保持可读但被 producer 隔离；旧 waiting Effect 禁止确认已应用，可在确认未应用后 abandoned 并显式重新生成。7 个 canonical Artifact 对应 5 passed + 1 failed Acceptance，但旧 passed Artifact 和 Acceptance 未提交窗口均被隔离，只有 4 个 v1 passed Office Artifact 具备 handoff 资格。该门禁只证明当前生成器同输入的确定字节，不代表任意语义等价 OOXML ZIP 已完全规范化。保留文件已经结构解析和渲染目检，但尚无真实 Provider、Word/Excel/PowerPoint 原生应用打开、统一结果工作台真人钻取、30 分钟真实用户任务、完整强杀 checkpoint 矩阵、返工/导出和 clean release 绑定，因此 AC-15 仍开放。

### AC-16 项目知识与连接器（P1 黄金路径）

**操作**：项目同时接入本地资料和一个外部知识源，执行带引用的研究任务后撤销外部授权。
**通过条件**：每条结论可追溯到 source/version/retrievedAt；个人与共享授权不混用；跨 Project 查询不召回；撤销后新 Run 无法读取该源，历史 Evidence 保留必要摘要但不泄露已撤销凭据或原文。

### AC-17 远程接续（P2，非 1.0 阻塞）

**操作**：用户从绑定移动端续接桌面上的 WorkItem、批准一个限定文件修改并查看最终 Artifact，期间令 Desktop 离线后恢复。
**通过条件**：远程消息复用同一 Goal/WorkItem/Run；审批绑定动作、目标、有效期和 revision；离线期间明确不可执行且不丢消息身份；恢复后不重复副作用；解绑后远程端立即失去控制权。

### AC-18 任务转交（P2，非 1.0 阻塞）

**操作**：Project Owner 将一个进行中的 WorkItem 转交给另一成员，并保留原审批和 Artifact 历史。
**通过条件**：新 owner 权限重新计算；旧 owner 不能继续写入；Goal/WorkItem/Artifact/Evidence ID 不变；转交原因和双方身份进入审计；系统没有内建聊天或会议依赖。

**当前自动化基础**：本地可信用户已可在 Studio 将 WorkItem 转交给同 Project 的人员或 active DigitalWorker；`npm run test:work-item-transfer:required` 验证 owner/Assignment 协调、旧 lease 撤销、旧 owner 失权、新 owner 授权、历史保留、原因/audit、CAS、幂等、跨 Project/停用 Worker/策略拒绝零副作用和重启读回，`npm run test:work-item-transfer:e2e` 验证真实 Electron UI 与移动端布局。AC-18 仍开放，因为尚无两个真实成员身份、共享审批和完整 Artifact/Evidence 多主体保留验收。

### AC-19 Codex / Claude Code 用户迁移（P1 黄金路径）

**操作**：一名真实 Codex 或 Claude Code 深度用户在 30 分钟内导入现有项目规则、一个 Skill、一个 MCP 和一个 Hook，完成“理解项目→修改→测试→审查 Diff→交付”的真实任务。
**通过条件**：导入前显示来源、目标、冲突和完整 diff；原文件有可恢复备份且可一键回滚；未选择资产不导入；敏感字段不进入 Renderer/日志；任务产生 canonical Artifact/Evidence/Acceptance；记录回退原工具次数和未迁移习惯，未通过不得宣称迁移完成。

### AC-20 Provider Profile 迁移（P1 黄金路径）

**操作**：从受支持配置源导入两个 Provider profile，完成模型发现、健康检查、默认切换、故障切换、导出和回滚。
**通过条件**：Base URL、协议、鉴权目标和 Key 标签可预览；Key 只进入主进程 Broker；配置写入原子且有版本/备份；导出默认不含凭据；故障切换保持同一 Goal/WorkItem/Run/Context，route reason 和成本可见。

**当前证据边界**：无 GUI Service/Store smoke 以 135/135 覆盖无凭据导出、冲突预览、逐项决策、凭据排除、活动 Key 标签/数量、目标凭据绑定变化、规范化重复/URL path 大小写、IPv4/IPv6 loopback no-auth、远程 no-auth 网络前拒绝、目标变化凭据隔离与显式重绑、权威快照字段清除、锁内配置漂移 CAS、脱敏备份、Key 真删除、journal 文件边界和 backup 文件名/内嵌 ID 绑定（`test-results/provider-profile-smoke/2026-07-31T18-36-07-764Z/report.json`）。独立 restart gate 以 13/13 真实跨进程/`SIGKILL` 场景证明存活 owner 竞争返回 `LOCK_HELD`、失败 candidate 清理、同进程可重入、正常释放竞争、import/rollback checkpoint、死进程锁回收、重复恢复零 replay/字节稳定、同进程对账收敛和 6 类 pending writer 阻断（`test-results/provider-profile-restart/2026-07-31T18-36-15-308Z/report.json`）。未知 Store digest 会持久进入 `waiting_reconciliation`，修复为 before/desired digest 后分别收敛为 `aborted`/`committed` 并恢复普通写入；safety/source backup 在 Store commit 前和 terminal 前复核 ID/digest，prepare 后或 Store commit 后篡改均 fail-closed，恢复冻结字节后才收敛。死 owner 回收按设计保留一个有 5 分钟保护期的 bounded recovered tombstone。真实 Electron gate 以 54/54 覆盖危险 URL 拒绝、导入预览/应用、跨启动回滚、脱敏备份/导出、活动 Key 标签与“保留/需重新录入/删除/无需密钥”影响说明、Key 删除取消/确认/重新录入及 `760x700` 无水平溢出（`test-results/provider-profile-e2e/2026-07-31T18-36-51-341Z/report.json`）。以上证据均绑定 dirty merge commit `8ba60148`，不构成 release binding；Windows ACL、Provider Store 顶层 schema 版本化、真人迁移、真实 Provider 发现/健康/failover 与 clean release 仍未验证，因此 AC-20 保持开放。

### AC-21 AI 视频垂直链路(P2，非 1.0 阻塞)

**操作**：用户导入一个包含 1~3 个场景、最多 8 个镜头的短剧本，配置或选择一个图片、
视频和 TTS capability，完成角色/场景资产、分镜、关键帧、逐镜头视频、对白、字幕、本地合成
和 30~60 秒 MP4 导出。

**通过条件**：

- Episode / Scene / Shot 和所有采用版本在重启前后身份稳定，角色/场景/声线绑定可检查。
- 在 MediaJob `submitting`、`running` 和 `downloading` 三个检查点强杀应用，恢复后使用同一
  external job ID 对账，未产生重复外部任务或重复计费。
- 最终 MP4 可在 CaoGen 和至少一个系统播放器中播放；时长、分辨率、音轨、字幕和文件
  SHA-256 与 Artifact 元数据一致。
- 任一 Provider 不可用时，用户可在保持 Shot 和上游 Artifact 身份的前提下切换兼容 Adapter；
  降级、费用变化和数据外发范围明确可见。
- 从最终 Artifact 可以追溯剧本版本、资产、关键帧、镜头视频、对白、字幕、MediaJob、成本、
  人工采用决定、Evidence 和 Acceptance；失败或未知任务不计入完成。

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
- **明确不做**：为了兼容 Claude Code 重新嵌入 SDK/CLI；旧数据必须显式迁移并保留诚实恢复边界。
- **明确不做**：未验证前宣称 Office 像素级编辑、任意外部系统 exactly-once 或完全自治交付。
- **明确不做**：在 1.0 内交付完整 AI 短剧平台；post-1.0 视频工作室不自研基础视频模型，
  不复制许可证不兼容项目的代码/提示词/素材，也不以提交外部任务冒充成片完成。

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
- post-1.0 AI 视频工作室的 Media Provider/MediaJob ADR、许可清单、大文件存储方案和 AC-21 验收脚本。

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
