# 增量 PRD:WB-P0 — TaskStrategy 任务策略收编

> 文档版本:v1.0
> 编写日期:2026-07-28
> 关联 gap 分析项:WB-P0(`docs/COMPETITOR-GAP-ANALYSIS.md` 第 150 行)
> PRD 类型:简单 PRD(增量)

---

## 1. 项目信息

- **Language**:简体中文
- **Programming Language**:Electron + TypeScript(现有技术栈,无变更)
- **Project Name**:caogen_wb_p0_task_strategy
- **原始需求复述**:CaoGen 当前存在四套并列的任务控制概念(TaskStrategy / PermissionModeId / CaoGenDriveMode / ExperienceMode),语义重叠且同时暴露给用户,导致心智混乱和误操作风险。本次收编让 TaskStrategy 成为唯一用户任务策略入口,PermissionMode 降级为内部派生值,DriveMode 保留为设置项但不再与策略并列。

---

## 2. 产品定义

### 2.1 产品目标

1. **单一策略入口**:用户在会话中只需通过 view / plan / execute 三档控制"当前做什么任务",不再并列面对 PermissionMode 四档选择器和 DriveMode 五档选择器。
2. **语义无歧义**:消除 PermissionMode 的 `'plan'` 与 TaskStrategy 的 `'plan'` 同名但语义不完全等同的混乱;用户看到的"规划"就是 TaskStrategy.plan,不存在第二个"规划模式"。
3. **内核不变**:TaskPlan 版本/digest/审批生命周期、Effect Ledger、恢复快照、权限策略引擎和 Drive 运行时策略全部保持不变;收编只改"用户暴露的策略入口和派生关系"。

### 2.2 用户故事

| # | 角色 | 场景 | 价值 |
|---|------|------|------|
| US-1 | 开发者 | 打开一个陌生项目,选 **view** 让 Agent 读取代码结构和依赖,不产生任何文件修改 | 安全探索,零误操作风险 |
| US-2 | 开发者 | 在 view 读完代码后,切到 **plan** 让 Agent 产出版本化 TaskPlan(步骤、依赖、预计产物、风险),批准前不执行任何写操作 | 先看计划再决定,控制执行节奏 |
| US-3 | 开发者 | 批准 TaskPlan 后切到 **execute**,Agent 在权限和预算约束下执行;编辑类工具自动放行,高危操作仍逐次询问 | 高效执行但保留安全护栏 |
| US-4 | 老用户(迁移) | 升级后打开会话,发现原来的"权限模式"四档下拉框消失了,只剩 view/plan/execute 三按钮;原来选 `acceptEdits` 的行为现在等价于 execute 默认行为 | 无感迁移,不丢失原有能力 |
| US-5 | 高级用户 | 在设置里调整 DriveMode(如 forge/command/genesis)来改变算力预算和验证深度,但不影响任务策略选择;策略条上永远只有三按钮 | 算力与策略分离,各管各的 |

---

## 3. 技术规范

### 3.1 现状基线(代码核实)

| 概念 | 类型定义 | 用户暴露入口 | 实际作用 |
|------|---------|-------------|---------|
| **TaskStrategy** | `'view' \| 'plan' \| 'execute'`(`task-plan-types.ts:3`) | 三按钮控件 `TaskStrategyControl.tsx` | `decideTaskStrategyTool()` 在 preflight 阶段按策略拦截工具:view 只放行只读工具;plan 放行只读 + 计划生成 + dry_run;execute 全放行 |
| **PermissionModeId** | `'default' \| 'acceptEdits' \| 'plan' \| 'bypassPermissions'`(`types.ts:59`) | 四档下拉框(`ChatView.tsx:222-234`、`WelcomeView.tsx`) | `native-tool-runtime.ts` 在 gateTool 阶段按模式放行:bypassPermissions 全放行;acceptEdits 放行编辑工具;plan 只放行只读(与 TaskStrategy.plan 重复);default 逐次询问 |
| **CaoGenDriveMode** | `'spark' \| 'core' \| 'forge' \| 'command' \| 'genesis'`(`types.ts:102`) | 设置页选择器(`SettingsModal.tsx:402`) | 通过 `settingsForCaoGenDrive()` 生效:控制 schedulerStrategy、defaultModel、sessionBudgetUsd、validationDepth、crossValidation、sandboxMode、guiAutomationEnabled、defaultPermissionMode、permissionAllowlist/Denylist |
| **ExperienceMode** | `'assistant' \| 'studio'`(`experience-mode.ts`) | 界面投影切换 | 展示态,不是执行策略,本次不收编 |

**核心冲突**:TaskStrategy 已在 preflight 层拦截工具(优先于 permissionMode),但 permissionMode 的 `'plan'` 仍在 gateTool 层做重复拦截,且两者同名。DriveMode 的 `defaultPermissionMode` 字段又会覆盖 permissionMode,导致三者交叉影响。

### 3.2 需求池

#### P0 — 必须完成(Must have)

**P0-1:TaskStrategy 成为唯一用户任务策略入口**

- 会话控制条上只保留 `TaskStrategyControl`(view / plan / execute 三按钮)。
- 从会话控制条移除 PermissionMode 四档下拉框(`ChatView.tsx:222-234`)。
- 从 WelcomeView 移除 PermissionMode 选择器;新会话默认 TaskStrategy = `execute`(与现有 `DEFAULT_TASK_STRATEGY` 一致)。
- SessionMeta 保留 `permissionMode` 字段,但改为只读派生值(由 TaskStrategy + DriveMode 计算),不再接受用户直接设置。

**P0-2:TaskStrategy → PermissionMode 派生映射**

当用户选择 TaskStrategy 时,系统自动派生内部 PermissionModeId:

| TaskStrategy | 派生 PermissionModeId | 理由 |
|---|---|---|
| `view` | `default` | TaskStrategy preflight 已拦截所有非只读工具,permissionMode 此时实际不生效(所有到达 gateTool 的调用都是只读的,`default` 对只读工具也放行)。派生为 `default` 仅为保持类型合法,无行为差异。 |
| `plan` | `default` | 同理,TaskStrategy preflight 已拦截所有写操作和命令,只放行只读 + dry_run;permissionMode 的 `'plan'` 旧分支做的是同样的事,收编后该分支删除。 |
| `execute` | `acceptEdits` | 编辑类工具自动放行(等价于旧 `acceptEdits`),高危工具(命令、GUI、Git push、发布类)仍逐次询问(等价于旧 `default` 对高危的行为)。这是大多数开发任务的合理默认。 |

**P0-3:bypassPermissions 不作为独立用户档**

- `bypassPermissions` 不出现在任何用户控制面。
- 它仍作为内部类型保留,仅在以下场景可用:
  - Routine(自动化任务)的显式配置项(高级用户在 Routine 编辑器里选择,不在会话控制条上)。
  - TaskPlan 步骤级别声明的受限授权(如果未来 plan step 支持 `executionAuthorization.required = true` 且用户在批准时显式选择 bypass,需在 plan 批准 UI 上单独确认)。
- P0 范围内:bypassPermissions 仅保留给 Routine,会话内不暴露。

**P0-4:删除 PermissionMode `'plan'` 分支**

- `native-tool-runtime.ts:252-265` 中 `if (mode === 'plan' && !readOnlyCall)` 分支删除:该逻辑已被 `decideTaskStrategyTool()` 在 preflight 层覆盖,是重复代码。
- PermissionModeId 类型中 `'plan'` 值保留(向后兼容已持久化的会话 meta),但不再派生给任何 TaskStrategy,也不出现在用户选择器中。会话恢复时若读到旧 `permissionMode: 'plan'`,按 TaskStrategy 重新派生覆盖。

**P0-5:DriveMode 定位为执行 profile,与 TaskStrategy 正交**

- DriveMode 保留在设置页(`SettingsModal.tsx`),不移动到会话控制条。
- 明确正交关系:
  - **TaskStrategy = 做什么 / 做到哪一步**(view 只看 → plan 出计划 → execute 执行)
  - **DriveMode = 用什么算力 / 多严**(模型路由、预算、验证深度、工具风险策略、sandbox 强度)
- DriveMode 的 `defaultPermissionMode` 字段含义变更:不再作为会话 permissionMode 的默认值(会话 permissionMode 改由 TaskStrategy 派生),而是作为 DriveMode 的"风险偏好描述"保留(仅供设置页展示和 Routine 创建时参考)。
- 在设置页 DriveMode 选择器下方增加一行提示文案:"驱动档位控制模型、预算和验证深度;任务策略(查看/规划/执行)在会话中单独选择。"

**P0-6:退役清单**

从用户主路径移除的控制面:

| 移除项 | 位置 | 替代 |
|--------|------|------|
| PermissionMode 四档下拉框 | `ChatView.tsx:222-234` | TaskStrategy 三按钮(已有) |
| PermissionMode 选择器 | `WelcomeView.tsx:106, 399` | 新会话默认 execute,用户进入会话后可切 |
| `PERMISSION_OPTIONS` 常量的用户引用 | `store.ts:3855-3859` | 仅供 Routine 编辑器内部使用,不在会话控制面引用 |

保留不变的控制面:

| 保留项 | 位置 | 理由 |
|--------|------|------|
| DriveMode 选择器 | `SettingsModal.tsx:402` | 执行 profile,与策略正交 |
| TaskStrategy 三按钮 | `TaskStrategyControl.tsx` | 收编后的唯一策略入口 |
| ExperienceMode 切换 | `experience-mode.ts` | 展示投影,不在本次收编范围 |
| Routine 编辑器的 PermissionMode 选择 | `RoutineEditor.tsx:271` | 自动化任务需要独立配置执行权限,与会话策略不同 |

#### P1 — 应该完成(Should have)

- **P1-1:策略切换引导提示**:用户从 view/plan 切到 execute 时,如果存在未批准的 TaskPlan,弹出轻量提示"当前有未批准的计划,是否先批准再执行?"(不强制阻断,用户可跳过)。
- **P1-2:会话控制条 tooltip 增强**:TaskStrategyControl 每个按钮的 title 增加派生权限说明,如 execute 按钮提示"执行:自动接受编辑,高危操作仍需确认"。
- **P1-3:旧会话迁移提示**:恢复历史会话时,如果旧 meta 中 permissionMode 为用户手设值(非派生),在会话顶部显示一次性提示"任务策略已升级,权限模式已自动调整为派生值"。
- **P1-4:DriveMode `defaultPermissionMode` 字段重命名**:将 `CaoGenDrivePolicyView.defaultPermissionMode` 重命名为 `riskPreferenceLabel` 或类似,消除"它会设置会话权限"的歧义。需同步更新 `settingsForCaoGenDrive()` 中对该字段的引用。

#### P2 — 可选(Nice to have)

- **P2-1:DriveMode 是否也并入任务策略**:评估是否将 DriveMode 的 spark/core/forge/command/genesis 重新归类为"执行强度"子档,在 execute 内提供 fast/balanced/thorough 三档快捷切换。需用户调研后决定。
- **P2-2:迁移引导动画**:首次升级后,用一个 3 步动画引导用户理解 view → plan → execute 的新工作流。
- **P2-3:plan 批准后自动切 execute**:当前 PRD 默认为"批准后等用户手动切 execute"(见待确认问题 Q-2);若用户调研支持自动切换,可作为 P2 增强。
- **P2-4:TaskPlan step 级 executionAuthorization UI**:在 plan 批准界面为每个 step 提供独立的执行授权选择(如某步允许 bypass、某步要求逐次确认)。

---

### 3.3 关键交互流

以下描述用户从"打开会话 → 选 view 读项目 → 切 plan 出计划 → 批准 → 切 execute 执行 → 看结果"的完整路径:

**步骤 1 — 打开会话**
- 用户从 WelcomeView 创建新会话,选择项目目录。
- 会话默认 TaskStrategy = `execute`(与现有 `DEFAULT_TASK_STRATEGY` 一致)。
- UI:会话控制条显示三按钮 `[查看] [规划] [**执行**]`,执行按钮高亮。不再有权限模式下拉框。
- DriveMode 继承设置页全局值(默认 core),用户看不到它在控制条上。

**步骤 2 — 切到 view 读项目**
- 用户点击"查看"按钮。TaskStrategy 切换为 `view`。
- UI:三按钮变为 `[**查看**] [规划] [执行]`。
- 用户输入"帮我读一下这个项目的结构和主要依赖"。
- Agent 调用 `read_file`、`list_dir`、`search_code` 等只读工具 → `decideTaskStrategyTool('view', ...)` 放行 → `gateTool` 中 permissionMode(派生为 `default`)对只读调用也放行 → 工具执行。
- Agent 回复项目结构分析。无任何文件被修改。
- 如果 Agent 尝试调用 `write_file` → `decideTaskStrategyTool('view', ...)` 拒绝,返回"查看策略只允许读取和分析,已阻止写入、命令、外部创建和其他持久副作用。"

**步骤 3 — 切到 plan 出计划**
- 用户点击"规划"按钮。TaskStrategy 切换为 `plan`。
- UI:三按钮变为 `[查看] [**规划**] [执行]`。
- 用户输入"帮我规划一个重构方案,把数据库访问层从回调改成 async/await"。
- Agent 调用只读工具分析代码 + `task_decompose` 生成步骤 → `decideTaskStrategyTool('plan', ...)` 放行(PLAN_TOOLS 包含 task_decompose)。
- Agent 产出 TaskPlan 版本(含 objective、steps、expectedArtifacts、riskLevel、acceptanceCriteria),通过 `createTaskPlanVersion()` 写入。
- UI:计划面板显示版本号、digest、步骤列表、风险等级。审批状态 = `pending`。
- 如果 Agent 尝试调用 `write_file` 执行某步骤 → `decideTaskStrategyTool('plan', ...)` 拒绝,返回"规划策略只允许读取和生成可审查计划,批准并切换到执行前不得运行计划步骤。"

**步骤 4 — 审批计划**
- 用户审查 TaskPlan 内容,确认步骤、产物、风险可接受。
- 用户点击"批准"按钮 → `approveTaskPlan()` 写入 approvalEvent(kind=approved, version, digest)。
- UI:计划面板审批状态变为 `approved`,显示批准版本号和 digest。
- 此时 TaskStrategy 仍为 `plan`,用户尚未切换到 execute。

**步骤 5 — 切到 execute 执行**
- 用户点击"执行"按钮。TaskStrategy 切换为 `execute`。
- UI:三按钮变为 `[查看] [规划] [**执行**]`。
- 系统派生 permissionMode = `acceptEdits`(编辑类工具自动放行)。
- Agent 按 TaskPlan 步骤执行:
  - `write_file` / `search_replace` → `decideTaskStrategyTool('execute', ...)` 放行 → `gateTool` 中 `acceptEdits` 分支放行编辑工具 → Effect Ledger 记录 → 执行。
  - `run_command`(如运行测试)→ `decideTaskStrategyTool('execute', ...)` 放行 → `gateTool` 中 `acceptEdits` 不包含命令工具 → 弹出权限确认弹窗 → 用户确认 → 执行。
  - `git_push` / 发布类 → 同上,逐次询问。
- 所有写操作进入 Effect Ledger,可通过恢复快照回滚。

**步骤 6 — 查看结果**
- 执行完成后,用户在结果侧栏查看文件变更、Diff、Git 状态。
- 如果结果不满意,可通过 Effect Ledger 回滚到执行前快照。
- 用户可随时切回 view 重新审视,或切回 plan 修订计划(创建新版本,旧版本 superseded)。

---

### 3.4 与现有能力的关系(不破坏清单)

本次收编**不改内核**,以下能力保持不变:

| 现有能力 | 保持不变的原因 |
|---------|--------------|
| **TaskPlan 版本/digest/审批生命周期** | `TaskPlanVersion`、`TaskPlanApprovalEvent`、`TaskPlanStateView` 类型和方法全部不变;`createTaskPlanVersion`、`approveTaskPlan`、`revokeTaskPlanApproval` API 不变 |
| **TaskPlan 投影(projection)** | `TaskPlanProjectionReceipt` 和投影逻辑不变 |
| **执行授权(execution authorization)** | `TaskPlanExecutionAuthorization` 结构不变;收编只影响"用户如何选策略",不影响 plan 批准后的授权链 |
| **Effect Ledger** | `prepareEffectExecution`、`markEffectExecutionStarted`、`completeEffectExecution`、`cancelEffectExecution` 全部不变;Effect 记录、恢复快照、Reconciler 不变 |
| **工具权限策略引擎** | `evaluateToolPermission()`、`decideGuiPermission()`、`taskRuntimeRegistry.evaluateTool()` 不变;DriveMode 的 `permissionAllowlistRules` / `permissionDenylistRules` 仍通过 `settingsForCaoGenDrive()` 生效 |
| **Drive 运行时策略** | `getCaoGenDrivePolicy()`、`driveRouteTuning()`、`driveDefaultModel()`、`driveSessionBudgetUsd()` 不变;DriveMode 仍控制模型路由、预算、验证深度、sandbox、GUI 自动化 |
| **工具幂等性** | `taskRuntimeRegistry.evaluateTool()` 和 `ToolIdempotencyDecision` 不变 |
| **审计日志** | `writeSessionAuditLog()` 不变;gate 决策仍记录 action/source/toolName |
| **Routine 权限模式** | `RoutinePermissionMode` 类型和 `RoutineEditor.tsx` 的选择器不变;Routine 是离线自动化,需要独立权限配置 |

**收编只改三处**:
1. UI 层:移除会话控制条和 WelcomeView 的 PermissionMode 选择器(P0-1)。
2. 派生层:新增 TaskStrategy → PermissionMode 派生函数(P0-2),替换用户直接设置。
3. gate 层:删除 `native-tool-runtime.ts` 中 `mode === 'plan'` 的重复分支(P0-4)。

---

## 4. 待确认问题

以下问题需要主理人/用户拍板,PRD 暂以建议默认值推进:

| # | 问题 | 建议默认 | 影响范围 |
|---|------|---------|---------|
| **Q-1** | view 档是否允许终端只读命令(如 `git log`、`ls -la`)?当前 `VIEW_TOOLS` 不含 `run_command`,意味着 view 下完全不能跑终端命令。 | **不允许**。view = 纯零副作用,终端命令即使只读也有执行风险(如触发 hook)。只读需求由 `git_status`、`git_diff`、`list_dir` 等专用只读工具覆盖。 | `VIEW_TOOLS` 集合不变 |
| **Q-2** | plan 档批准后是否自动切 execute,还是等用户手动切? | **手动切**。自动切换会让用户失去"批准后再想想"的缓冲;且手动切可以让用户在批准后先调整 DriveMode 或预算再执行。 | 交互流步骤 4-5 |
| **Q-3** | DriveMode 的 `defaultPermissionMode` 字段是否在 P0 内重命名?重命名会触及 `CaoGenDrivePolicyView` 接口和 `settingsForCaoGenDrive()` 实现。 | **P0 不重命名**,仅改语义说明(设置页提示文案)。重命名放到 P1-4,避免 P0 改动面过大。 | P0-5、P1-4 |
| **Q-4** | DriveMode 的 spark / command / genesis 是否需要在 P0 内重新归类?当前 spark 的 `defaultPermissionMode = 'default'` 但 forge/genesis 的 `defaultPermissionMode = 'acceptEdits'`,收编后这些值不再直接设置会话 permissionMode,但仍影响 Routine 创建时的默认值。 | **P0 不重新归类**。DriveMode 的五档在收编后语义变为"执行 profile 偏好描述",具体值在 P1/P2 评估是否需要简化。 | P0-5、P2-1 |
| **Q-5** | 老会话恢复时,如果旧 meta 中 `permissionMode` 为用户手设的 `bypassPermissions`,如何迁移? | **降级为 `acceptEdits`**(即 execute 派生值),并在会话顶部提示"检测到旧版跳过权限设置,已降级为执行模式(自动接受编辑,高危仍确认)。如需跳过权限请在 Routine 中配置。" | P0-2、P1-3 |
| **Q-6** | execute 档派生 `acceptEdits` 是否应受 DriveMode 调节?例如 spark 档下 execute 是否应更保守(派生 `default` 而非 `acceptEdits`)? | **P0 不受 DriveMode 调节**。execute 统一派生 `acceptEdits`,保持策略语义纯粹;DriveMode 的风险控制通过 `permissionDenylistRules`(如 spark 阻止 `risk>=high`)实现,不通过改 permissionMode 实现。 | P0-2、P0-5 |

---

## 5. 验收标准

| # | 验收项 | 验证方法 |
|---|--------|---------|
| AC-1 | 会话控制条上只有 TaskStrategy 三按钮,无 PermissionMode 下拉框 | UI 检查 |
| AC-2 | view 档下 Agent 无法执行任何写操作或命令(包括 `write_file`、`run_command`、`git_commit`) | 在 view 档下触发写工具,确认被 `decideTaskStrategyTool` 拒绝 |
| AC-3 | plan 档下 Agent 可生成 TaskPlan 但无法执行写操作;批准后仍无法在 plan 档执行 | 在 plan 档创建 plan → 批准 → 尝试 write_file,确认被拒绝 |
| AC-4 | execute 档下编辑类工具自动放行(无权限弹窗),命令类工具弹出确认 | 在 execute 档触发 write_file(无弹窗)和 run_command(有弹窗) |
| AC-5 | `native-tool-runtime.ts` 中 `mode === 'plan'` 分支已删除,gateTool 仍正常工作 | 代码检查 + 回归测试 |
| AC-6 | DriveMode 选择器仍在设置页,切换 DriveMode 不影响 TaskStrategy 当前值 | 在设置页切 spark → core,确认会话 TaskStrategy 不变 |
| AC-7 | 老会话恢复后 permissionMode 被派生值覆盖,不保留旧手设值 | 恢复一个旧 `permissionMode: 'bypassPermissions'` 的会话,确认 meta.permissionMode 变为 `acceptEdits`(若 taskStrategy=execute) |
| AC-8 | Routine 编辑器的 PermissionMode 选择器仍可用 | 打开 Routine 编辑器,确认权限模式选择器存在且可选四档 |
