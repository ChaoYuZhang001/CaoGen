# 架构设计：D0 首任务引导集成

> 版本：v1.0；日期：2026-07-30
> 输入：`docs/PRD-D0-first-task-onboarding.md` 与当前工作树真实代码
> 边界：renderer/store 投影优先；复用 Provider、Session、Result、Workbench API；不改 main、IPC、preload、shared

## 1. 实现方案

D0 采用“既有真源 + renderer 纯投影 + 最小引导元数据”。

1. Provider、Session、Result、Acceptance 始终读取现有真源，不复制业务状态。
2. 新增 `components/experience/first-task-onboarding.ts`，集中实现六状态纯投影、成功谓词、版本化 `localStorage` codec、幂等里程碑和生命周期 hook。
3. `WelcomeView` 继续持有 prompt、项目、Provider/模型和 TaskStrategy 草稿，继续调用 `startSessionWithPrompt(options, prompt)` 原子创建并首发；`busy` 只投影 UI，跨组件重挂载的 module-level single-flight 负责提交互斥。
4. `WorkbenchRoot` 挂载生命周期 hook，观察候选 Session 终态并拉取现有 `getStudioResultSnapshot`；`ready` 时只调用一次 `openPanel('result')`。
5. `StudioResultPanel` 保持 Summary/Artifacts/Evidence/Timeline 和现有工具跳转，仅上报成功打开的 available Artifact，并在快照刷新后判定完成。
6. Acceptance 写入继续复用 `reviewWorkflowAcceptance`。结果面板当前仅只读展示 Acceptance；D0 若要求在结果工作台内闭环，必须复用现有 Evidence 选择、review decision 和 waiver reason 规则，不得创建第二套 Acceptance 状态。
7. 完成/跳过、候选 Session 和漏斗时间戳暂存 renderer `localStorage`。这是“不改 main/IPC/preload/shared”约束下的跨重启方案；未来迁入 `AppSettings` 必须单独走六环评审。

## 2. 真实代码基线

- `WelcomeView.tsx` 已有 `WELCOME_TOOLS` 四组原始 `promptKey/taskStrategy`、`hasAvailableCompute`、共享 Promise 的 `useLocalComputeActivation`、`welcomeValidationKey`、`welcomeSessionOptions` 和 `startSessionWithPrompt`；提交互斥由 onboarding module 的 single-flight gate 统一提供。
- `store.ts` 已有 Provider 刷新/激活、Session 创建与事件归并、`workbench.activePanelId/mountedPanels`、`openPanel/closePanel/togglePanel`。
- `WorkbenchRoot.tsx` 将 `result` 面板绑定 `activeId`；`panels.ts` 已注册 11 面板且全部 keep-alive。
- `StudioResultPanel.tsx` 已调用 `getStudioResultSnapshot`，并复用 Diff/Files/Preview/Browser/Terminal/Subagent action；Acceptance 当前为只读摘要。
- 可写验收 UI 在 `WorkflowAcceptanceRow.tsx`，最终调用既有 `window.agentDesk.reviewWorkflowAcceptance(...)`，waived 强制填写理由，passed/failed 强制每项 criterion 选择 Evidence。
- 实际 Settings 文件是 `src/renderer/src/components/SettingsModal.tsx`，不是任务描述中的 `components/settings/SettingsModal.tsx`。
- `App.tsx` 在 `showSettings` 时用 Settings 替换主界面，故 Welcome 会卸载；若要求 Settings 往返不丢草稿，必须使用 renderer 内存草稿，不能假设组件仍挂载，也不能将 prompt/cwd 落盘。
- `StudioView.tsx` 是 canonical Project/Goal/WorkItem 工作区，不应承载平行首任务 domain 状态。

## 3. 状态与数据结构

```ts
export type FirstTaskOnboardingStatus =
  | 'needs_compute'
  | 'activating_local'
  | 'ready_to_start'
  | 'running'
  | 'reviewing_result'
  | 'completed'

interface FirstTaskOnboardingRecordV1 {
  schemaVersion: 1
  skippedAt?: number
  completedAt?: number
  candidateSessionId?: string
  presetKey?: 'understand' | 'review' | 'report' | 'plan' | 'custom'
  computeSource?: 'local' | 'configured' | 'global_route'
  firstArtifactOpenedAt?: number
  openedArtifactLocationId?: string
  resultAutoOpenedForSessionId?: string
  milestones: Partial<Record<
    | 'onboarding_viewed'
    | 'compute_ready'
    | 'first_task_started'
    | 'first_result_opened'
    | 'first_artifact_opened'
    | 'first_acceptance_resolved', number>>
}

interface WelcomeDraft {
  text: string
  projectChoice: string
  cwd: string
  driveMode: CaoGenDriveMode
  routingMode: WelcomeRoutingMode
  providerId: string
  model: string
  taskStrategy: TaskStrategy
}

interface FirstTaskProjectionInput {
  providersHydrated: boolean
  providers: ProviderView[]
  localComputeStatus: 'idle' | 'checking' | 'ready' | 'unavailable'
  candidateSession?: SessionMeta
  snapshot?: StudioResultSnapshot
  activePanelId: PanelId | null
  record: FirstTaskOnboardingRecordV1
}
```

存储键：`caogen.first-task-onboarding.v1`。禁止持久化 prompt、cwd/path/URI、文件内容、token、Provider/模型副本、Session 状态、Snapshot、Artifact/Acceptance 副本。`WelcomeDraft` 仅在 Zustand 运行时内存保存，Settings 返回或首任务启动后清理。

状态优先级：

1. `completedAt` 或历史迁移命中成功口径 => `completed`。
2. candidate 为 `starting/running` => `running`。
3. candidate 已可审查且已取得快照，或 result 面板已打开 => `reviewing_result`。
4. Provider 未水合或本地激活中 => `activating_local`，文案为“检测算力”，不得误报无 Provider。
5. 水合完成且无可用算力 => `needs_compute`。
6. 其余 => `ready_to_start`。

`error/closed`、权限拒绝和中断不等于成功；保留候选供继续或重开。重启恢复绝不调用 `startSessionWithPrompt`。

## 4. 权威完成谓词

```ts
function isFirstTaskResultResolved(
  snapshot: StudioResultSnapshot,
  record: FirstTaskOnboardingRecordV1
): boolean {
  const openedAvailableArtifact = snapshot.artifacts.some((artifact) =>
    artifact.locations.some((location) =>
      location.availability === 'available' &&
      location.id === record.openedArtifactLocationId
    )
  )
  const acceptanceResolved = snapshot.acceptances.length > 0 &&
    snapshot.acceptances.every((item) =>
      item.status === 'passed' ||
      (item.status === 'waived' && Boolean(item.waiverReason && item.waivedBy))
    )
  return snapshot.state === 'ready' &&
    Boolean(record.firstArtifactOpenedAt) &&
    openedAvailableArtifact && acceptanceResolved
}
```

`unbound`、0 Artifact、无 available location、Artifact 未打开、0 Acceptance、pending/verifying/failed、无理由或无 `waivedBy` 的 waived 均不完成。无 Acceptance 是否允许完成列为待明确事项；默认按 PRD 严格口径禁止空集合通过。

## 5. 关键流程

### 5.1 Provider 与 Settings

`store.ts` 增 `providersHydrated:boolean`，初始 false，在 Provider 首次请求 settle 后置 true。它只是加载生命周期，不是 Provider 副本。Assistant 仅在水合完成且 `hasAvailableCompute(providers) === false` 后自动激活本地算力，继续复用当前共享 Promise。

激活成功设置返回 Provider 与 `AUTO_MODEL`；失败不建 Session，仅显示“重试检测 / 配置 Provider”。配置前把 Welcome 草稿放入 renderer 内存 store；扩展 `setShowSettings(true, 'providers')` 或等价一次性导航目标，Settings 只消费 Provider tab 深链，不改 ProviderEditor、测试、保存和密钥逻辑。保存/返回后 `refreshProviders()` 并恢复草稿。

### 5.2 开始与运行

- `understand` 仅标记推荐，不自动发送；四个预设仍直接读取 `WELCOME_TOOLS`，不能复制 prompt 或策略表。
- 推荐任务必须真实 cwd；自定义 unassigned 可启动，但必须由结果提供可定位 Artifact 才可能完成。
- renderer `createSession/startSessionWithPrompt` 返回实际创建的 `sessionId`，首发显式绑定该 ID；Welcome 直接用返回值首写 `candidateSessionId/first_task_started`，禁止在 `await` 后读取可变的全局 `activeId`；失败不登记候选。
- controller 只观察 `candidateSessionId` 对应 Session，不只观察当前 `activeId`。运行中仅显示轻量四步进度，不覆盖聊天、TaskStrategyControl、权限、TaskPlan 审批和中断能力。

### 5.3 终态、结果与幂等

首次观察到 candidate `running -> idle`（重启后直接 idle 也可）拉取快照。若 `state === 'ready'`：确保候选 Session 成为 active，再调用 `openPanel('result')`，首写 `resultAutoOpenedForSessionId/first_result_opened`。effect 内 ref 防 StrictMode 重入，持久化 compare-and-set 防重新挂载；快照返回后再次核对 candidate。用户切走后不再抢焦点。

candidate 为 `error` 时保留原 Session，允许用户在同一 Composer 继续。用户显式选择重新开始时，仅对仍匹配该 candidate 且尚未完成的 onboarding record 做 compare-and-reset，再调用现有 `setShowNewSession(true)`；不得关闭、删除或自动重发原 Session。

`StudioResultPanel` 增可选 `onSnapshot/onArtifactOpened` 或直接调用 onboarding module。`openLocation()` 的现有 panel action resolve 后才记录 available Artifact，失败不记录。每次首次取数、手动 refresh、Acceptance review refresh 后使用最新快照判定。

### 5.4 Acceptance 复用

Result Evidence tab 当前没有 review 操作。P0 推荐抽取现有 `WorkflowAcceptanceRow` 的 Evidence 选择与 review 表单，在 Result 中复用；或者提取无 domain 状态的共享 controller。必须保持：

- passed/failed 每项 criterion 都有 Evidence；
- waived 必须用户明确操作并填写理由；
- 最终写入仍为 `reviewWorkflowAcceptance`；
- review 后重新拉 `StudioResultSnapshot` 再判定；
- selected Evidence、waiver reason 只是 React 瞬时草稿，不进入 onboarding record。

### 5.5 历史升级与 Studio

首次无记录时，在 renderer 空闲阶段有限并发扫描最近顶层 Session 的快照。任一历史结果满足 `ready + available Artifact + Acceptance 全 passed/合法 waived`，即可写 `completedAt` 以避免打扰成熟用户；旧版本无法证明 Artifact 曾打开，因此不补造漏斗事件。

Assistant 通过 `openPanel('result')` 联动。Studio 保留显式 Provider/路由控件和独立 Result surface；D0 不直接篡改 `studioSurface`，仍先遵守 WB-P1 的 `activePanelId`。`StudioView` P0 无需修改，若展示进度只读同一投影。

## 6. 完整文件清单与改动边界

### 必改

| 文件 | 允许改动 | 禁止改动 |
|---|---|---|
| `src/renderer/src/components/experience/first-task-onboarding.ts`（新增） | 纯投影、codec/merge、成功谓词、幂等 hook | IPC、业务数据副本、敏感草稿落盘 |
| `src/renderer/src/store.ts` | `providersHydrated`、一次性 Settings tab、内存 WelcomeDraft 所需最小字段/action | Provider/Session/Workbench 执行语义和路由算法 |
| `src/renderer/src/components/WelcomeView.tsx` | 推荐态、水合门、进度、candidate 登记、Provider 深链、草稿恢复 | 四 preset promptKey/策略、权限派生、自动发送 |
| `src/renderer/src/components/workbench/WorkbenchRoot.tsx` | 挂 lifecycle hook、轻量运行进度、自动 `openPanel('result')` | 注册表/keep-alive、聊天和审批控制 |
| `src/renderer/src/components/workbench/StudioResultPanel.tsx` | 首任务摘要、Artifact 上报、snapshot 完成检查、Acceptance 复用入口 | Result 真源、独立 open 状态、伪造 Acceptance |
| `src/renderer/src/components/SettingsModal.tsx` | 消费 Provider tab 导航目标；关闭/保存触发刷新/草稿返回 | ProviderEditor、测试、保存、密钥逻辑 |
| `src/renderer/src/styles.css` | 推荐、四步进度、结果强调响应式样式 | 无关视觉重构 |
| `src/renderer/src/i18n.ts` 或现有 assistant 翻译模块 | D0 必要文案键 | 改写四 preset prompt 文本 |
| `scripts/first-task-onboarding-e2e.mjs`（新增） | AC-1~AC-9 Electron E2E | 生产契约 |
| `package.json` | 增 `test:first-task-onboarding` | 依赖升级、无关脚本 |

### 条件改动

| 文件 | 条件与边界 |
|---|---|
| `src/renderer/src/components/WorkflowAcceptanceRow.tsx` | 仅为 Result 抽可复用 review UI/controller；API 与校验语义不变 |
| `src/renderer/src/components/AppListView.tsx` | 若 hook 需跨 Assistant/Studio surface 常驻，可挂此处；不得新建 Result surface |
| `src/renderer/src/components/studio/StudioView.tsx` | 仅可只读同一进度投影；P0 默认不改 |
| `scripts/assistant-studio-ui-e2e.mjs` | 补四 preset 与草稿回归时改，保留现有覆盖 |
| `scripts/studio-result-surface-e2e.mjs` | 补 Artifact/Acceptance 回归时改，不重写 fixture |

## 7. T01~T12 任务与依赖

| ID | 任务 | 依赖 | 完成标准 |
|---|---|---|---|
| T01 | 建立纯投影、codec 与成功谓词 | 无 | 六状态、损坏回退、无敏感持久化 |
| T02 | 增 Provider 水合与最小 renderer 字段 | T01 | 未水合不误报；既有 action 语义不变 |
| T03 | Settings Provider 深链与内存草稿 | T02 | Settings 往返 prompt/项目/策略不丢 |
| T04 | Welcome 首任务入口 | T02,T03 | understand 推荐；四映射原样；单次首发 |
| T05 | candidate Session observer 与自动 Result | T01,T02,T04 | running 可恢复；idle+ready 自动开一次；error 不完成 |
| T06 | Result Artifact/摘要反馈 | T05 | available Artifact 打开成功才记里程碑 |
| T07 | Result 复用 Acceptance review | T06 | passed 有 evidence；waived 有理由；刷新真源判定 |
| T08 | 历史用户有限迁移 | T01,T02 | 历史成功不强制引导；不伪造漏斗 |
| T09 | Assistant/Studio 一致性适配 | T05,T06 | 同一完成口径；Studio 控件不变 |
| T10 | 新增 D0 E2E/静态契约 | T04~T09 | 覆盖 AC-1~AC-9、双击、重载、隐私 |
| T11 | 回归与修复 | T10 | typecheck/build 和既有相关 suite 全绿 |
| T12 | 人工验收与 diff 边界审计 | T11 | AC-10 与不修改清单通过 |

关键路径：`T01 -> T02 -> T03/T04 -> T05 -> T06 -> T07 -> T10 -> T11 -> T12`；T08/T09 可在 T05 后并行。

## 8. 跨文件约定

1. Provider 可用判定唯一入口为 `hasAvailableCompute(providers)`。
2. 本地激活唯一入口为 `activateLocalCompute()`，同时请求共享 Promise。
3. Session 首发唯一入口为 `startSessionWithPrompt(options,prompt)`；它返回实际创建并接收首发的 `sessionId`，恢复绝不重发。
4. `candidateSessionId` 是引导关联键；observer/result callback 先核对它。
5. 结果唯一 Workbench 入口为 `openPanel('result')`；每 candidate 至多自动打开一次。
6. 完成事实只来自最新 `StudioResultSnapshot`；Artifact “打开过”仅在 open action resolve 后记录。
7. milestone 使用 epoch milliseconds、first-write-wins；record 更新为字段级 merge。
8. preset key 只允许现有四 key 或 custom；prompt/策略始终从 `WELCOME_TOOLS` 读取。
9. 日志、埋点、localStorage 不含 prompt、文件内容、token、cwd/path/URI 明文。
10. 实现前逐文件重读当前工作树并做最小 patch，保留用户全部未提交改动。

## 9. 不修改清单

- `src/main/**`、`src/preload/**`、`src/shared/**`、所有 IPC handler/channel。
- Provider 编辑器、凭据、健康探测、模型发现及路由算法。
- `AUTO_PROVIDER_ID/AUTO_MODEL`、routingScope、DriveMode 行为。
- main/IPC 的 Session 创建与发送执行语义；renderer 只允许返回实际 `sessionId` 并将首发显式绑定该 ID。
- TaskStrategy view/plan/execute、PermissionMode 派生、TaskPlan/权限/停止能力。
- `panels.ts` 的 11 面板、`mountedPanels` 与 keep-alive 语义。
- Studio Result service、Workflow Ledger、Goal/WorkItem/Run/Artifact/Evidence/Acceptance 生命周期。
- Routine、Digital Worker 生命周期。
- 四个 welcome preset 的 prompt 文本和策略映射。
- 用户已有未提交改动及无关文件。

## 10. 验证矩阵

`npm run typecheck`、`npm run build`、`npm run test:first-task-onboarding`、`npm run test:local-compute-zero-config:required`、`npm run test:task-strategy:required`、`npm run test:studio-surface:required`、`npm run test:acceptance-policy-ui:required`、`npm run test:assistant-studio-consistency:required`。

D0 必测：Provider 延迟水合；local activated/unavailable/throw；Settings 往返草稿；default Provider ready/unready；四 preset 映射；双击/Enter；running 重载不重发；ready 自动开一次；unbound/零或不可用 Artifact/pending/failed；Artifact 打开 + passed/合法 waived；localStorage 不含 prompt/path/token。

## 11. 待明确事项

| # | 问题 | 默认建议 |
|---|---|---|
| Q1 | 禁止 shared/AppSettings 变更时是否接受 `localStorage`？ | 接受版本化 renderer 存储；否则 P0-6 与“不改 IPC”无法同时满足 |
| Q2 | 0 Acceptance 能否完成？ | 不能；至少一条且全部 resolved |
| Q3 | 历史迁移扫描上限？ | 最近 20 个顶层 Session，空闲阶段并发 2 |
| Q4 | `closed` Session 的 ready 快照能否 review？ | 可 review，不自动完成，仍需双门槛 |
| Q5 | 是否接受 renderer 内存暂存 Welcome 敏感草稿？ | 接受，不落盘，返回/开始后清理 |
| Q6 | Result Evidence tab 是否必须直接 review Acceptance？ | P0 建议必须，否则结果工作台无法闭环 |
| Q7 | Artifact URL “打开成功”如何定义？ | 现有 panel action Promise resolve，不验证外部内容加载 |
| Q8 | Studio 是否自动切独立 Result tab？ | 本期不直接切，统一 `openPanel('result')`；如需切换另加显式导航 action |
| Q9 | 跳过入口是否进入 P0？ | 默认 P1；若提供只写 `skippedAt` |

类图：`docs/class-diagram-d0-first-task-onboarding.mermaid`。
时序图：`docs/sequence-diagram-d0-first-task-onboarding.mermaid`。
