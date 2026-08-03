# CaoGen Agent Work OS 大规模重构执行计划

> 本文档从属于 [`docs/PLAN.md`](./PLAN.md)，不是新的产品路线图，也不改变
> [`STATUS.md`](../STATUS.md) 和 [`docs/1.0-ACCEPTANCE-MATRIX.md`](./1.0-ACCEPTANCE-MATRIX.md)
> 的事实口径。它只回答一个问题：如何从当前实现安全演进到厂商中立的统一 Agent Work OS。

- 计划基线：`35876bd8ab67b11d078b1c11dc299afdb795e1b9`
- 基线来源：Draft PR #10 的检查点及其 Claude Agent SDK 遗留清理提交
- 制定日期：2026-08-03
- 状态：执行草案，等待逐 PR 验证
- 发布边界：不是 release candidate；Release Doctor `not_ready` 和正式跨平台门禁不变

## 1. 重构结果

本轮重构不以“文件变小”或“目录更整齐”为完成条件。最终结果必须同时满足：

1. CaoGen Core 持有 Project、Goal、WorkItem、Run、Context、Effect、Artifact、Evidence、Acceptance、预算、权限和审计语义。
2. Provider、模型、协议、Base URL、Key、本地模型和路由策略均为可替换配置，不进入 DigitalWorker、Goal 或 WorkItem 身份。
3. OpenAI Responses、OpenAI Chat Completions、Anthropic Messages 和后续协议只通过 Protocol Adapter 接入，不拥有第二套任务、工具、恢复或交付语义。
4. 工具、Skill、MCP、Hook 和 Connector 复用同一 Tool Fabric、权限、Effect、Evidence 和审计合同。
5. Assistant、Studio、远程通道、自动化和外部连接器操作同一组 canonical 对象，不创建影子会话或影子任务。
6. 所有持久写入有版本、迁移、崩溃恢复和删除所有权；所有外部副作用有持久意图、对账或显式人工收敛。
7. Renderer 只消费 typed query/view model 并提交 typed command，不直接拥有凭据、文件系统、业务状态机或恢复真相。
8. 每个阶段都可迁移、可比较、可回退；不允许以一次整仓改写换取表面一致性。

## 2. 当前证据基线

| 项目 | 当前事实 | 对重构的约束 |
|---|---:|---|
| TS/TSX | 661 个文件，约 186,413 行 | 不能依靠一次性人工审查保证行为不变 |
| main 进程 | 约 133,000 行；`src/main/task` 约 36,500 行 | 领域切分必须先固定合同和表征测试 |
| 依赖图 | 2,397 条边，11 个循环 | 先解除 shared、migration、acceptance 和 renderer store 的 SCC |
| Durable writer | 76 个模块，432 个 sink calls | 统一 primitive 前必须保留现有 owner 和恢复语义 |
| Durable 状态 | 7 个 recovery/schema gap，46 个 `implemented_unverified` | gap 清零不等于 46 个未验证项自动关闭 |
| IPC | 166 个 main handler，164 个 preload invoke | 已超过现行总量硬限制 160，禁止继续手工复制 channel |
| 自动化 | 337 个脚本、384 个 package scripts、358 个 `test:*` | 需要 gate manifest 和 testkit，不能无限增加独立脚本 |
| 源码字符串测试 | 144 个脚本直接读取源码文本 | 逐步替换为行为、契约、AST 或运行时边界测试 |
| 最大热点 | `styles.css` 10,102；renderer `store.ts` 3,832；shared `types.ts` 2,443；`sessionManager.ts` 2,216 | UI、合同和 Runtime 必须分阶段拆，不做纯移动式 PR |

当前 `test-results/*/latest.json` 中仍有报告绑定旧 SHA 或 dirty worktree。重构分支上的任何
“已验证”升级都必须重新生成报告，并记录精确 SHA、工作树状态、平台和运行命令。

## 3. 能力真值与重构目标

下表中的“已验证”只表示当前仓库存在本地聚焦行为证据，不等于 Acceptance Matrix 或正式发布验收。

| 能力族 | 本地聚焦已验证 | `implemented_unverified` | 已确认缺口 |
|---|---|---|---|
| Codex / Claude Code 工程能力 | 项目理解、编辑、终端、Git、测试、审查、多 Agent、Skill、MCP | 完整会话恢复阶梯 | 用户可配置 Hook runtime、统一 Tool Fabric、跨协议恢复、真实工程黄金路径 |
| WorkBuddy 成品工作流 | Office 成品、项目本地知识、查看/规划/执行、Result Workbench、本地 Routine | 无独立项 | 外部知识源及撤权、Routine→canonical WorkItem/Run、真实 Office 打开、远程接续和真人任务 |
| Multica WorkItem 协作 | WorkItem、派工、DigitalWorker、单用户转交、运行历史和审计 | Squad、评论和 mention 的 shared→store→IPC→preload→Studio UI 链 | 真实多主体身份、共享审批、幂等入站 Webhook、统一 retention/export/delete |
| CC Switch Provider 管理 | Profile、模型发现、健康记录、failover、导入导出、备份和回滚 | 真实 Provider 和 Windows ACL 边界 | Provider Store 顶层 schema、显式协议、Model Catalog 和 clean evidence binding |
| Marvis 常驻与跨端 | 本地个人知识 | Tray/常驻助手基础 | 设备身份、跨设备续接、离线队列、远程查看/审批/控制、解绑和可选远程 Runner |
| CaoGen Trust / Delivery Core | 路由、主要 Effect、Artifact、Evidence、Acceptance 和审计时间线 | Recovery、预算和权限 | canonical cutover、统一 Effect descriptor、7 个 recovery/schema gap 和全入口一致性 |

“有完整调用链但没有独立行为证据”不得继续写成“未实现”，也不得升级为“已验证”。Squad 和评论
是当前第一个需要纠正的事实漂移；`implemented_unverified` 只能由当前 SHA 的相应行为门禁关闭。

## 4. 目标架构和依赖方向

```text
CaoGen Experience
  Assistant | Studio | Result Workbench | Remote Clients | 3D Projection
                |
                v
CaoGen Application Core
  Project | Goal | WorkItem | Collaboration | Routine | Approval
                |
                v
CaoGen Native Runtime
  RunExecutor | CanonicalContext | ModelAttempt | Supervisor | ToolLoop
       |                     |                         |
       v                     v                         v
Protocol Adapters       Route/Health Core          Tool Fabric
OpenAI Responses        Provider Profile           Builtin Tools
OpenAI Chat             Model Catalog              Skill/MCP/Hook
Anthropic Messages      Credential Broker          Connectors
       |                     |                         |
       +---------------------+-------------------------+
                             |
                             v
CaoGen Trust and Data Kernel
Workflow Ledger | Effect Ledger | Artifact Graph | Evidence | Acceptance
Durable Store | Migration Registry | Audit Timeline | Data Lifecycle
```

依赖只能向下。以下反向依赖必须由架构门禁禁止：

- Protocol Adapter 依赖 Project Store、Electron、Renderer 或 Acceptance UI。
- Tool executor 自行决定权限、直接绕过 Effect，或写入第二份 Provider history。
- Renderer 直接访问 Node、凭据、文件系统或 durable writer。
- shared contract 反向依赖 main、renderer、Electron 或另一个聚合 barrel。
- migration 模块导入业务 facade 后再由业务 facade 导回 migration。
- 3D 或 Result UI 创建 Run、Attempt、Artifact 或完成状态事实。

## 5. 不可破坏的不变量

1. Provider、模型和协议切换不得改变 Project、Goal、WorkItem、DigitalWorker、Assignment 或 Run 身份。
2. Provider server-side conversation id 只是缓存指针，Canonical Context 是唯一可恢复历史。
3. `completed` 必须同时满足：无 unresolved Effect、required verification 通过、Acceptance 未失败。
4. 外部副作用 outcome unknown 时禁止自动重放；queryable 先对账，opaque 进入人工处理。
5. Key 只在 main/Broker 解密；renderer、日志、Artifact、Evidence、导出和 crash report 不出现明文。
6. 迁移前必须备份；中断后可恢复；future/corrupt input fail-closed；回滚不得覆盖未知新状态。
7. Canonical 写源切换前必须完成 backfill 和 compare；切换后 legacy 只能是可重建投影或只读墓碑。
8. Compatibility facade 有明确删除条件和截止阶段，不允许永久双写。
9. 任何行为门禁不得把 optional skip、旧报告或 dirty pass 当作当前 commit 的 required pass。
10. 删除 Claude Agent SDK/CLI 的产品决策保持不变；能力通过 CaoGen Native Runtime 和协议 Adapter 实现。

## 6. 十二个重构域

### R1 Contract Spine 与依赖方向

**问题**：`src/shared/types.ts` 2,443 行、313 扇入；shared contracts 形成 8 文件循环，
Provider、Session、Task、Git、Preview、Routine 和 `AgentDeskApi` 通过同一 barrel 扩散。

**工作包**：

- R1.1 建立 `src/contracts/<domain>/`，每域只有 schema、command、query、event 和 DTO。
- R1.2 解除 shared 子模块对 `./types` 的回引，先消除 SCC，再迁移消费者。
- R1.3 `src/shared/types.ts` 降为带弃用清单的兼容导出，不再新增定义。
- R1.4 增加依赖方向门禁和 public API snapshot；禁止跨域深层导入。
- R1.5 所有 durable entity、event 和 IPC envelope 显式携带 schema version。

**退出门禁**：shared SCC=0；新增代码不导入聚合 barrel；typecheck/build/API snapshot 通过。

### R2 测试平台与重构表征层

**问题**：测试脚本约为产品源码体量的 72%；144 个脚本读取源码文本，行为、静态规则、
临时编译、Electron 拉起和报告生成混在独立脚本中。

**工作包**：

- R2.1 建立 `scripts/testkit/`：临时目录、故障注入、进程强杀、报告绑定、fixture 和 redaction。
- R2.2 建立 machine-readable gate manifest，现有 npm script 先保留 wrapper。
- R2.3 将高引用热点的源码字符串断言改为 AST、contract fixture 或真实行为测试。
- R2.4 统一 report envelope：command、SHA、dirty count、platform、startedAt、finishedAt、result。
- R2.5 把 synthetic、real-provider、human、platform 和 release gate 明确分级。

**退出门禁**：报告可重复、无时间/路径漂移；行为测试不靠实现字符串；旧命令保持兼容。

### R3 Durable Storage 与 Data Lifecycle

**问题**：116 个 main 模块直接依赖文件系统，72 个执行写入；存在多套 atomic write；
7 个明确 gap 和 46 个 `implemented_unverified` writer。

**工作包**：

- R3.1 收敛 durable primitives：append、atomic replace、directory fsync、SQLite transaction、lock 和 quarantine。
- R3.2 统一 versioned envelope、migration registry、owner、retention/export/purge contract。
- R3.3 依次关闭 Browser/Preview Annotation、legacy session purge、Indexer、Memory、Provider Store、Worktree receipt 七个 gap。
- R3.4 为每个 `implemented_unverified` writer 增加 short write、fsync、rename、ENOSPC 或 strong-kill 证据。
- R3.5 Windows ACL 和目录 durability 使用原生 Windows gate，不拿 POSIX 结果替代。

**退出门禁**：recovery gap=0、schema gap=0；direct-write、inventory、migration 和 platform gate 全绿。

### R4 Canonical Work OS Ledger Cutover

**问题**：workflow migration 形成 13 文件循环；ProjectWorkspace JSON、Workflow Ledger、
TaskSnapshot/TaskRun 仍有 legacy/compare/canonical 多状态与多源恢复。

**工作包**：

- R4.1 分离 migration reader/writer、canonical repository 和 projection builder，解除循环。
- R4.2 Workspace/Goal/WorkItem 完成 backfill→compare→write flip→read flip→legacy tombstone。
- R4.3 Run/Recovery、Assignment/Supervisor、Artifact/Evidence/Acceptance 依次执行同一流程。
- R4.4 JSON 和旧表降为可重建投影；删除 projection 后可从 Ledger 恢复。
- R4.5 最终删除默认 legacy read 和永久双写开关。

**退出门禁**：canonical-only 重启和删除投影恢复通过；无重复 event；migration continuity 全绿。

### R5 Effect / Recovery Trust Kernel

**问题**：341 个 effect entry 中 223 个 mutation；静态 registry、执行状态机、Reconciler、
领域 journal 和 checkpoint wrapper 仍不是同一注册源。

**工作包**：

- R5.1 定义版本化 `EffectDescriptor`：target、risk、permission、idempotency、queryability、reconciler、compensation、evidence。
- R5.2 registry 成为可执行 contract，Effect Gateway 只接受已注册 descriptor。
- R5.3 builtin tools、IPC mutation、Provider/Connector、Git/terminal/GUI 依次迁移。
- R5.4 合并重复 checkpoint wrapper；保留领域 compensation，但由统一状态机调度。
- R5.5 对每一阶段注入 crash；unknown outcome 不重放，opaque 必须可见且可人工收敛。

**退出门禁**：effect inventory 一一覆盖；operation/effect/external recovery 和 close-race 全绿。

### R6 Native Runtime 与 Session 生命周期

**问题**：`sessionManager.ts` 2,216 行、56 扇出；OpenAI/Anthropic engine 各自持有 history、
routing、ModelAttempt 和 tool loop，Native Runtime 尚未完整拥有产品语义。

**工作包**：

- R6.1 提取 `CanonicalContextService` 和 `ModelAttemptService`，engine 不再写第二份历史。
- R6.2 提取 `RunExecutor`、turn loop、cancel/timeout/retry 和 child/DAG orchestration。
- R6.3 `SessionManager` 降为 composition/facade；生命周期由耐久 Run event 驱动。
- R6.4 OpenAI Responses、OpenAI Chat、Anthropic Messages 降为纯 Protocol Adapter。
- R6.5 统一工具调用、usage、错误分类、流事件和跨协议恢复 fixture。

**退出门禁**：Adapter 不依赖 Electron/Store/Tool；跨协议 Context、Attempt 和恢复身份一致。

### R7 Provider Profile、Model Catalog 与 Routing

**问题**：协议仍可能从 name/baseURL/model 推断；Provider Store 为无版本数组；配置、凭据、
能力、健康和路由没有完全解耦。

**工作包**：

- R7.1 Provider Store v1 envelope、严格 parser、备份、迁移、rollback 和 corrupt fail-closed。
- R7.2 引入显式 `protocolId`，删除商业名称和 URL 正则的协议决定权。
- R7.3 分离 ProviderProfile、CredentialRef、ModelCatalog、HealthObservation 和 RoutePolicy。
- R7.4 模型发现/健康分层缓存携带 source、timestamp、TTL 和 capability evidence。
- R7.5 路由按硬约束→用户覆盖→评分→理由→ModelAttempt 执行，保持商业中立。

**退出门禁**：旧配置可逆迁移；损坏不归零；真实 discovery/health/failover 与本地 Provider parity 通过。

### R8 Tool / Skill / MCP / Hook / Connector Fabric

**问题**：多份 ToolDefinition 和工具分类并存；OpenAI tool 定义被其他路径复用；权限、
幂等、Effect 和 Hook 生命周期没有同一描述源。

**工作包**：

- R8.1 定义单一 `ToolDescriptor`：schema、capability、risk、permission、effect、replay、executor。
- R8.2 Provider Adapter 只把 descriptor 编译成协议格式，不拥有 executor。
- R8.3 builtin code/terminal/Git/browser/Office 工具先迁移，再迁 Skill 和 MCP。
- R8.4 Hook 进入 before/after/error/recovery 生命周期，具备来源、digest、权限和超时。
- R8.5 Connector 作为 Project Resource/Knowledge Source/Tool 接入；写操作必须进入 Effect。

**退出门禁**：协议 schema parity；permission denial 零 Effect；Skill/MCP/Hook/Connector 重启和审计通过。

### R9 Work Coordination 与协作

**问题**：owner、Assignment、Supervisor、Project aggregate、import/delete 通过多个 Store 和专用
saga 对账；Squad/评论已有完整调用链但缺独立行为证据。

**工作包**：

- R9.1 建立 WorkCoordination application service 和统一 ownership read model。
- R9.2 Squad/评论先补 contract、store restart、IPC/preload 和 Electron 行为门禁，并修正文档状态。
- R9.3 assign/reassign/transfer、lease、runRefs 统一经 UoW/outbox，保持 actor 和 audit identity。
- R9.4 增加真实多主体、mention、共享审批和组织 policy，但不扩展成聊天/会议产品。
- R9.5 manual/cron/webhook 统一创建 canonical WorkItem/Run；Webhook 使用幂等事件身份。

**退出门禁**：每个 saga checkpoint crash；owner/assignment/run invariant；转交 exactly-once；Webhook 零影子任务。

### R10 Artifact / Evidence / Acceptance / Result Delivery

**问题**：Task/Workflow Evidence、Artifact lifecycle/graph、Acceptance repair 和 Studio Result 多源演进，
相关模块形成 7 文件循环。

**工作包**：

- R10.1 统一 Artifact/Evidence/Acceptance ID、ownership、revision 和 lineage contract。
- R10.2 BlobStore 保存内容；Ledger 保存元数据和关系；Result Workbench 只消费投影。
- R10.3 迁移 Office、code diff、test/review、research/citation 和 connector producers。
- R10.4 repair/retest、supersedes、export bundle、retention/purge 使用同一图关系。
- R10.5 unresolved Effect 或失败 Acceptance 必须阻断 terminal Goal 和对外交付。

**退出门禁**：digest/ownership/lineage、restart、repair/retest、export/purge 和 Studio snapshot 稳定。

### R11 Typed IPC / Preload Gateway

**问题**：main handler、preload invoke、共享 API 类型和 effect inventory 四处维护同一命令；
总量已达 166/164 并超过硬限制。

**工作包**：

- R11.1 分域定义 Command/Query/Event registry，包含 schema、permission、effect 和 error contract。
- R11.2 main 统一 runtime validation；preload client 由 registry 生成或静态一致性校验。
- R11.3 每个 renderer API 必须恰有一个 handler；禁止字符串 channel 漂移。
- R11.4 长任务返回 operation id，进度通过 typed event，不保持长 IPC 调用。
- R11.5 按 Provider→Project→Session→Workbench 垂直切片迁移，不做全量换名。

**退出门禁**：handler/invoke 一一对应；零未注册 channel；所有输入 runtime validation；架构门禁通过。

### R12 Renderer State 与统一 Workbench

**问题**：renderer `store.ts` 3,832 行并与 slice 成环；`window.agentDesk` 有 272 处直接引用；
styles、Settings、Workbench、Office/Result 组件存在千行热点。

**工作包**：

- R12.1 按 Provider、Project、Session、Workbench、Settings 建 domain client/query/action slices。
- R12.2 组件只使用 hook/view model，不直接调用 IPC；`useStore` 作为限时兼容 facade。
- R12.3 `styles.css` 按 token/base/layout/domain/feature 拆分，先建视觉回归再迁移。
- R12.4 Workbench、Office 和 Studio Result 消费同一 Delivery projection，禁止嵌套第二套结果状态。
- R12.5 Assistant/Studio、桌面/移动尺寸、键盘、焦点、reduced motion 和性能门禁持续通过。

**退出门禁**：renderer store SCC=0；组件无直接 IPC；最大文件/函数指标持续下降且行为 E2E 不回退。

## 7. 六个执行波次

| 波次 | 目标 | 并行工作 | 退出条件 | 预计 |
|---|---|---|---|---|
| W0 Truth Freeze | 检查点、报告和架构门禁可信 | R2 表征层、vendor runtime guard、Squad/评论事实修正 | PR #10 CI 绿；commit-bound inventory；首批架构 gate | 1-2 周 |
| W1 Contracts and Durability | 固定合同与持久化语义 | R1、R2、R3 | shared SCC 清理开始；7 gap 分 owner；Provider schema v1 | 3-4 周 |
| W2 Canonical and Trust | 唯一事实源和副作用内核 | R4、R5 | 首批 domain read/write flip；Effect descriptor 可执行 | 4-6 周 |
| W3 Runtime and Fabric | Native Runtime 真正持有执行语义 | R6、R7、R8 | 双协议 Adapter parity；Tool Fabric 首批切换 | 4-5 周 |
| W4 Work and Delivery | 协作、自动化和成品统一 | R9、R10 | Squad/comment verified；Routine/Webhook canonical；Delivery projection | 4-5 周 |
| W5 Gateway and Experience | IPC、UI 和远程接续收口 | R11、R12、Remote Device slice | typed gateway；store SCC=0；远程 AC-17 条件证据 | 3-5 周 |

总历时按 4-6 个独立 owner 并发估算约 19-27 周。该估算不是发布日期；真实 Provider、真人、
设备、平台签名和发布 evidence 取决于外部条件，不能通过增加本地 Agent 数量压缩。

## 8. 迁移五阶段

每个持久或跨进程合同必须使用同一迁移模式：

1. **Expand**：添加新 schema/repository/adapter；旧读写保持不变。
2. **Backfill**：幂等迁移历史；记录 count、digest、source version 和 journal。
3. **Compare**：双读比较，任何 identity/ownership/state 差异 fail-closed；不静默修复。
4. **Cutover**：先 write flip，再 read flip；每次 flip 有独立开关、报告和 rollback 条件。
5. **Contract**：停止 legacy 写入，保留只读期限；完成删除演练后移除 facade 和旧 schema。

禁止以下做法：

- 同一 PR 同时 backfill、write flip、read flip 和删除旧源。
- compare 失败时自动选择“看起来更新”的一侧。
- 用 renderer state 或文件 mtime 决定 canonical 胜者。
- 迁移失败后覆盖原备份，或用空数组/空对象代替损坏数据。
- 在没有 rollback rehearsal 时删除 compatibility facade。

## 9. PR 与所有权规则

每个 PR 只能有一个主架构意图，并提供：

- baseline SHA、目标不变量、owned files 和 forbidden files；
- before/after dependency 或 persistence evidence；
- migration/compatibility/rollback 说明；
- targeted tests、相关 required gate 和 `git diff --check`；
- 未证明项及其下一 owner，不把 targeted pass 写成完整 closure。

建议每个实现 PR 控制在 5-25 个生产文件。超过 40 个生产文件必须先拆 contract/fixture PR；纯机械
rename 必须独立提交，禁止与行为变化混合。热点文件采用临时 owner lock：

| 热点 | 唯一 owner 波次 | 其他 lane 规则 |
|---|---|---|
| `src/shared/types.ts` | R1 | 只可消费新 contract，不直接新增定义 |
| `src/main/sessionManager.ts` | R6 | 先通过 support/facade 扩展，不并行改核心生命周期 |
| `src/renderer/src/store.ts` | R12 | feature lane 写新 slice，统一由 R12 接 facade |
| `src/main/ipc.ts` / `src/preload/index.ts` | R11 | 新 channel 必须先登记 contract registry |
| Workflow migration SCC | R4 | Store/Artifact lane 不直接改迁移状态机 |
| Acceptance/Artifact SCC | R10 | producer lane 只调用 Delivery facade |

## 10. 验证阶梯

每个 PR 按风险逐层执行，不得用高层大测试替代缺失的低层断言：

1. 静态：format/diff、typecheck、architecture imports、schema/API snapshot。
2. 单元/属性：状态机、digest、parser、route policy、permission、migration decision。
3. 合约：Protocol Adapter、ToolDescriptor、IPC、EffectDescriptor、Artifact/Evidence/Acceptance。
4. 持久化：short write、fsync、rename、ENOSPC、strong kill、restart、idempotent recovery。
5. 集成：Project→WorkItem→Run→Attempt→Tool/Effect→Artifact→Acceptance。
6. Electron：main→IPC→preload→store/hook→UI，覆盖桌面和紧凑尺寸。
7. 条件真实证据：real Provider、Office native open、connector、remote device、Windows/macOS 平台。
8. Release：clean exact commit Deep、签名、公证、安装启动、资产 digest 和公开审计。

架构重构日常 required bundle 至少包含：

```bash
npm run typecheck
npm run build
npm run test:coding-standards:required
npm run test:package-size-policy
npm run test:durable-write-inventory:required
npm run test:confirmed-write-durability:required
npm run test:domain-restart-parity:required
npm run test:private-provider-config
npm run secret:scan:history
git diff --check
```

领域 PR 只增加与其 blast radius 对应的专项 gate；完整 Deep 在波次集成点和候选冻结点运行。

## 11. 首批十二个 PR

| 顺序 | PR | 状态 | 目标 | 主要门禁 |
|---:|---|---|---|---|
| 0 | Checkpoint CI repair | 已完成：`35876bd8` | 删除无调用 Claude SDK 类型桥，恢复 clean `npm ci` | Windows preview CI、typecheck、package policy |
| 1 | Vendor runtime source guard | 当前分支 | 禁止源码重新 import Claude Agent SDK/CLI | package-size policy、负向 fixture |
| 2 | Capability truth refresh | 待派工 | Squad/评论改为 `implemented_unverified`，建立缺口矩阵 | acceptance map structure、docs audit |
| 3 | Squad/comment behavior gate | 待派工 | store/actor/CAS/restart/IPC/Electron/retention 边界 | 新 `test:collaboration:required` |
| 4 | Contract dependency gate | 待派工 | 建依赖规则、SCC report 和 shared barrel freeze | architecture gate、typecheck/build |
| 5 | Contract Spine slice 1 | 待 PR 4 | 拆 Provider/Session/Run envelope，保持兼容导出 | API snapshot、双协议 fixtures |
| 6 | Durable primitives contract | 待 PR 4 | 统一 append/replace/fsync/lock API，不迁 owner | durability fault injection |
| 7 | Provider Store schema v1 | 待 PR 6 | 严格读取、备份、迁移、rollback、corrupt fail-closed | provider profile/restart/Electron |
| 8 | Canonical migration cycle break | 待 PR 4 | 只解除 migration/repository 循环，不 flip | migration continuity、dependency gate |
| 9 | Effect descriptor registry | 待 PR 6/8 | 统一静态/执行 contract，先兼容现有 gateway | effect inventory、operation effect |
| 10 | Canonical Context service | 待 PR 8/9 | 从 engine 提取历史/Attempt 写入 facade | conversation ledger、protocol parity |
| 11 | ToolDescriptor builtin slice | 待 PR 9/10 | 迁 read/edit/test 三类工具，Adapter 只编译 schema | tool parity、permission/effect negative |

PR 1-4 属于 W0/W1，可在独立文件 owner 下并行；PR 5 以后严格按依赖顺序堆叠。

## 12. 远程接续专项

远程接续不应先做“手机聊天 UI”，必须先实现以下 core contracts：

1. DeviceIdentity：设备公钥、用户绑定、能力、最后在线、撤销和 audit。
2. RemoteCommandEnvelope：command id、Goal/WorkItem/Run、revision、scope、expiry、signature。
3. OfflineQueue：幂等入站、明确 pending/offline/expired/rejected，不制造执行成功。
4. RemoteApproval：动作、目标、数据范围、成本、有效期和 revision 全绑定。
5. ResultProjection：只读 Artifact/Evidence/Acceptance 摘要，不同步本地 Key 或无限原文。
6. RunnerLease：本机优先；可选远程 Runner 有独立权限、Effect 和 device fencing。
7. Unbind：撤销后立即失去控制权；历史审计保留但密钥/通道材料删除。

Webhook、Routine、桌面 UI 和移动端都复用 RemoteCommandEnvelope。AC-17 的离线/恢复/不重复副作用
测试通过前，不宣称跨设备接续完成。

## 13. 完成定义

本计划只有在以下全部成立时才可归档：

- 12 个重构域均达到各自退出门禁，compatibility facade 有明确保留或删除记录；
- 依赖图无目标层反向边，shared/migration/acceptance/renderer store 的目标 SCC 清零；
- durable inventory recovery/schema gap 为 0，所有 required writer 有当前 SHA 的 crash evidence；
- Runtime/Adapter/Tool/Provider/Effect 的所有权符合本文架构，双协议和 failover 保持 canonical 身份；
- Squad、评论、Webhook、Routine、Artifact delivery、Provider Profile 和远程接续状态与证据一致；
- 64 个 P0 和指定 P1 golden path 按 Acceptance Matrix 逐项关闭；
- exact clean commit 的 Deep、真实 Provider、人类/设备/平台和发布证据完整；
- Release Doctor 输出 `ready`，并且最终 Go Record 绑定签名资产和公开审计。

在此之前，只能报告具体域的 implemented、verified 或 blocked 状态，不能把重构进度等同于
Agent Work OS 目标完成，也不能把 PR #10 或本计划分支称为 release-ready。
