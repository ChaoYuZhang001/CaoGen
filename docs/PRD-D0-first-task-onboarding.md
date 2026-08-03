# 增量 PRD：D0 首任务引导集成

> 文档版本：v1.0
> 编写日期：2026-07-30
> 前置依赖：WB-P0 TaskStrategy 收编（commit `d0b86c52`）、WB-P1 统一结果工作台（commit `86c0b218`）
> PRD 类型：增量 PRD，仅描述现有能力上的变更

---

## 1. 产品目标

### 1.1 问题 → 方案 → 效果

| 问题 | 增量方案 | 预期效果 |
|---|---|---|
| 新用户首次打开时不知道是否已有可用算力，也不理解 Provider、模型、策略和项目目录之间的关系 | 将现有算力检测、本地算力激活、Provider 设置入口组织为单一路径；默认隐藏非必要配置，失败时给出唯一下一步 | 用户无需先理解配置体系即可开始；无可用算力时不进入无反馈死路 |
| 欢迎页已有预设任务，但“选预设、建会话、执行、看结果”仍是分散动作 | 增加“首任务”状态投影，复用现有预设 prompt 与 TaskStrategy，一次点击即携带项目、算力与策略创建会话并发送首条消息 | 新用户在首次会话中完成一个真实、可验证的任务，而不是停留在试聊 |
| Agent 输出结束不等于任务真正完成，用户不知道产物在哪里、是否通过验收 | 首任务结束后自动打开 WB-P1 结果工作台，首屏聚焦 Artifact 与 Acceptance；缺失产物或验收未通过时明确下一步 | 用户形成“任务 → 产物 → 证据 → 验收”的完整心智，首个成功可被核验 |
| 现有 WB-P0/WB-P1、Goal Task、Routine 等能力已经形成稳定边界，新增引导容易重复造状态或改变执行语义 | 引导只做 UI/store 投影和路径编排，复用现有 Provider、Session、TaskStrategy、Result Snapshot 与 Panel API | 低改动面接入，可独立关闭和回归，不破坏既有任务内核与六环链路 |

### 1.2 成功定义

- **北极星指标**：新用户首次打开后 30 分钟内，完成至少 1 个绑定真实工作区或明确产物位置的任务，并在结果工作台看到至少 1 个 Artifact 以及可判定的 Acceptance 状态。
- **任务成功口径**：会话停止输出不是成功；仅当结果快照为 `ready`，Artifact 可定位，且 Acceptance 为 `passed` 或用户明确 `waived` 时记为首任务完成。
- **漏斗事件**：`onboarding_viewed` → `compute_ready` → `first_task_started` → `first_result_opened` → `first_artifact_opened` → `first_acceptance_resolved`。
- **非目标**：本期不重做 Provider 编辑器、不新增模型路由策略、不改变任务执行内核、不创建独立教学中心、不替代 Goal Task 或 Routine。

---

## 2. 用户故事

| # | 用户与场景 | 期望行为 | 用户价值 |
|---|---|---|---|
| US-1 无 Provider | 新用户首次打开，Provider 列表中没有 `ready && models.length > 0` 的项，本机也无法激活本地算力 | 欢迎页说明需要算力；自动检测失败后只显示“配置 Provider”主按钮，打开现有 Settings Provider 编辑区；保存可用 Provider 后回到原首任务草稿并继续 | 不丢输入、不猜配置位置，不会创建无法运行的会话 |
| US-2 有本地算力 | 新用户未配置云 Provider，但本机存在可自动激活的本地算力 | 进入欢迎页后沿用 `activateLocalCompute()` 自动激活；成功后选择该 Provider、模型使用 `AUTO_MODEL`，首任务入口直接可用 | 零配置开始，不要求用户先理解 Provider/模型 |
| US-3 已配置 Provider | 用户已有至少一个 ready Provider，且可能设置了默认 Provider | 默认选择 `settings.defaultProviderId` 对应 ready Provider；默认项不可用时由现有全局自动路由选择可用算力；用户可直接选择预设任务或输入真实任务 | 老用户不被重复教育，新用户最少点击开始 |
| US-4 任务完成 | 用户执行首任务，Agent 已产出文件、报告、Diff 或其他可定位结果 | 系统打开 `openPanel('result')`；结果工作台默认展示任务摘要，并突出 Artifact 与 Acceptance；用户可打开产物、查看证据，完成验收或继续修复 | 第一次使用就理解交付物和完成标准，而非只看到聊天文本 |
| US-5 任务未通过 | Agent 回合结束，但结果快照无 Artifact、Acceptance 为 pending/failed，或结果仍 unbound | 不写入“首任务完成”；结果工作台展示缺口，提供返回会话继续、打开 Diff/Files/Terminal 等现有入口 | 避免虚假完成，支持在 30 分钟窗口内闭环修正 |

---

## 3. 需求池

### P0 — 必须完成

**P0-1：首任务状态投影**

- 在 renderer 侧新增可推导的 onboarding 状态：`needs_compute`、`activating_local`、`ready_to_start`、`running`、`reviewing_result`、`completed`。
- 状态优先从现有 `providers`、`sessions`、`activeId`、会话状态、结果快照和 `workbench.activePanelId` 推导；仅持久化“是否已完成/跳过首任务引导”和漏斗时间戳，禁止复制 Provider/Session/Task 状态。
- 已存在历史真实任务且结果满足成功口径的用户，首次升级后直接视为完成，不强制进入新手路径。

**P0-2：算力就绪单一路径**

- 复用 `hasAvailableCompute(providers)` 判定可用算力。
- Assistant 投影下无可用算力时，沿用 `useLocalComputeActivation` 自动调用 `activateLocalCompute()`，避免并发重复激活。
- 激活成功：设置返回的 Provider、`AUTO_MODEL`，状态进入 `ready_to_start`。
- 激活失败：不创建会话；显示现有安全错误，并提供“重试检测”和“配置 Provider”两个动作；配置入口调用现有 `setShowSettings(true)`。
- 从 Settings 返回后刷新 Provider；首任务 prompt、项目选择和 TaskStrategy 草稿必须保留。

**P0-3：一个推荐首任务与现有预设任务**

- 首屏将“理解项目”作为默认推荐首任务：有项目目录时使用现有 `welcomeUnderstandProjectPrompt`，TaskStrategy 固定为 `view`；无项目目录时引导选择真实目录，不以空工作区闲聊计入完成。
- 现有“审查变更 / 整理报告 / 规划任务”仍可选；必须原样复用 `WELCOME_TOOLS` 的 `promptKey` 与 `taskStrategy`，不得改写 prompt、改变 view/plan/execute 映射或另建首任务 prompt 分支。
- 自定义输入仍可直接开始；进入首任务漏斗时必须绑定真实目录，或由结果快照提供明确可定位 Artifact。
- 开始动作继续调用 `startSessionWithPrompt(options, prompt)`，保持“创建会话后立即发送首条消息”的原子路径。

**P0-4：首任务进行态**

- 会话创建成功后进入 `running`，欢迎页草稿清理沿用现有创建会话行为。
- 进行态仅显示轻量进度“正在执行首个任务”，不得覆盖聊天区、TaskStrategyControl、权限确认、TaskPlan 审批或中断能力。
- 首任务失败、被中断或权限被拒后不得标记完成；用户可修改输入后继续同一会话，或返回欢迎页重新开始。

**P0-5：完成后联动结果工作台**

- 当首任务候选会话从运行态进入可审查终态后，拉取现有 `getStudioResultSnapshot(sessionId)`。
- 快照为 `ready` 时调用 WB-P1 的 `openPanel('result')`，不得新建结果页面或旁路 `activePanelId`。
- 结果工作台默认保留现有 Summary/Artifacts/Evidence/Timeline；首任务场景需突出：Artifact 数量与可打开位置、Acceptance 的通过/总数、未覆盖 criterion、测试与 evidence。
- 用户至少打开一个可用 Artifact，并将 Acceptance 处理为 `passed` 或明确 `waived` 后，记录 `completed`；pending/failed/unbound 不算完成。

**P0-6：可恢复与幂等**

- 应用刷新或重启后，根据持久化 onboarding 标记与现有会话/结果数据恢复到 `ready_to_start`、`running` 或 `reviewing_result`，不得自动重复发送 prompt。
- 本地算力激活、创建会话、打开结果面板、完成埋点均需幂等；双击预设或回车连发只能创建一个首任务会话，延续现有 `submitPending` 防重入。

### P1 — 应该完成

- **P1-1：30 分钟进度反馈**：显示“算力已就绪 / 任务进行中 / 查看产物 / 完成验收”四步轻量进度，不展示倒计时压迫用户。
- **P1-2：断点续引导**：再次打开时直接定位上次未完成的首任务会话或结果面板，并允许“重新开始”。
- **P1-3：结果缺口行动建议**：无 Artifact 时建议回会话明确交付物；Acceptance pending/failed 时建议补证据、重测或修复；动作复用结果工作台现有工具跳转。
- **P1-4：首任务漏斗分析**：记录各状态进入时间、算力来源（local/configured/global route）、预设类型、失败原因枚举；不得采集 prompt 正文、文件内容、密钥或路径明文。
- **P1-5：Studio 投影适配**：Studio 用户保留显式 Provider/路由控件，但首任务完成口径与 Assistant 一致。

### P2 — 可选

- **P2-1：基于工作区信号推荐预设**：有 Git 变更推荐“审查变更”，空项目推荐“理解项目”，有结构化目标推荐“规划任务”；推荐只改变排序，不改变 prompt/策略。
- **P2-2：首任务模板扩展**：在保持预设契约的前提下，由插件提供可验证的首任务模板。
- **P2-3：引导效果实验**：对推荐首任务文案与排序做实验，但不得实验 TaskStrategy、权限或验收口径。
- **P2-4：跨设备同步进度**：在账号体系成熟后同步 onboarding 完成标记；当前版本仅本机持久化。

---

## 4. 关键流程

### 流程 A：首次打开，无 Provider → 引导 → 首任务

1. `init()` 完成 settings 与 sessions 首帧水合，Provider 列表随后独立水合；引导等待 Provider 检测结果，避免把“尚未加载”误判成“无 Provider”。
2. 系统判断无 `ready && models.length > 0` 的 Provider，先尝试本地算力激活。
3. 本地激活失败，欢迎页进入 `needs_compute`，保留项目、prompt 与 TaskStrategy 草稿，不创建会话。
4. 用户点击“配置 Provider”，打开现有 Settings Provider 编辑区；新增或修复 Provider 后保存。
5. 返回欢迎页并 `refreshProviders()`；检测到可用 Provider 后进入 `ready_to_start`，恢复原草稿。
6. 用户选择真实项目目录，点击推荐首任务或发送自定义任务。
7. 系统通过现有校验后调用 `startSessionWithPrompt`，只创建一个会话并发送一次 prompt，进入 `running`。
8. 任务达到可审查终态后进入流程 C。

### 流程 B：本地算力自动激活

1. 用户首次打开且无已配置可用 Provider。
2. Assistant 投影自动执行 `activateLocalCompute()`；同一时刻多处请求共享同一 Promise。
3. 返回 `activated + provider`：设置 `providerId = result.provider.id`、`model = AUTO_MODEL`，状态显示算力可用。
4. 推荐首任务按钮解锁；用户选项目后直接开始，无需打开 Settings。
5. 返回 unavailable 或异常：转入流程 A 的配置/重试分支；禁止静默降级为不可运行会话。

### 流程 C：完成 → 结果工作台 → Artifact / Acceptance

1. 首任务会话结束当前运行回合，系统拉取该 session 的 `StudioResultSnapshot`。
2. 快照 `ready`：调用 `openPanel('result')`，进入 `reviewing_result`；`result` 继续由 WB-P1 注册表和 keep-alive 管理。
3. 用户在 Summary 查看任务范围与状态，在 Artifacts 打开至少一个 `availability = available` 的位置，可跳转 Diff/Files/Preview/Browser。
4. 用户在 Evidence 查看 Acceptance、evidence 与 tests；Acceptance pending/failed 时继续补证据、重测或回会话修复。
5. Artifact 已查看且所有需处理 Acceptance 为 `passed`，或用户提供理由明确 `waived`，状态进入 `completed`。
6. 若快照 `unbound`、无 Artifact 或验收未解决，保持 `reviewing_result`，不展示“首任务完成”。

---

## 5. 不破坏清单

| 既有能力 | 本期约束 |
|---|---|
| **WB-P0 TaskStrategy** | view/plan/execute 是唯一任务策略入口；PermissionMode 继续由 TaskStrategy 派生；引导不得新增权限档或直接调用 `setPermissionMode` |
| **WB-P1 统一结果工作台** | 结果只通过 `openPanel('result')` 打开，保持注册表、`activePanelId`、mountedPanels 和 keep-alive；不恢复 `resultOpen` 本地状态，不新建结果页 |
| **预设任务 prompt / 策略** | `WELCOME_TOOLS` 的四个 `promptKey` 与对应 TaskStrategy 原样复用；推荐排序可变，内容和执行语义不可变 |
| **Settings Provider 编辑** | 继续使用现有 Provider 新增、编辑、测试、保存与刷新链路；引导仅深链/打开设置，不复制表单或持久化逻辑 |
| **Goal Task** | Goal、WorkItem、TaskPlan、Acceptance 的数据结构与生命周期不变；首任务可绑定但不替代 Goal Task，也不自动创建虚假 Goal |
| **Routine** | Routine 编辑器、定时执行、权限模式和运行记录不变；Routine 不计入交互式首任务漏斗 |
| **六环链路** | 主进程 → IPC → preload → shared types → store → UI 的契约保持完整；优先使用现有 API。若实现最终证明必须新增持久化字段或事件，须六环同步并独立评审，禁止 renderer 私造 IPC |
| **Provider/模型路由** | `AUTO_PROVIDER_ID`、`AUTO_MODEL`、global/provider/fixed routingScope 与 DriveMode 行为不变；引导不重写路由算法 |
| **Session 创建** | 继续使用 `createSession` / `startSessionWithPrompt`，保留 pending event drain、转录恢复与项目刷新行为 |
| **Artifact/Acceptance 真源** | 结果快照、Workflow Ledger、Acceptance review 是真源；引导不得用聊天文案或前端临时布尔值伪造产物/通过状态 |

---

## 6. 待确认问题

| # | 待确认问题 | 推荐方案 | 理由与影响 |
|---|---|---|---|
| Q-1 | “30 分钟完成”是否要求绑定项目目录？ | **默认要求真实项目目录；仅当结果快照存在可定位 Artifact 时允许 unassigned 任务计入。** | 防止用闲聊刷完成，同时兼容报告等非代码产物 |
| Q-2 | 首任务默认推荐哪个预设？ | **有项目时默认“理解项目”（view）；只推荐，不自动发送。** | 零写入风险、最容易成功，也符合 WB-P0 语义；自动发送会造成意外算力消耗 |
| Q-3 | 任务回合结束后是否自动打开结果工作台？ | **仅首任务候选会话且快照 ready 时自动打开一次；之后由用户手动切换。** | 首次建立闭环，避免后续每轮强抢焦点；需记录 session 级已自动打开标记 |
| Q-4 | Artifact 与 Acceptance 哪个是完成硬门槛？ | **两者都需要：至少一个可定位 Artifact 被打开，Acceptance passed 或明确 waived。** | 只有产物没有质量判断、只有验收没有可交付物都不构成真实完成 |
| Q-5 | 已有历史会话的升级用户是否展示引导？ | **若任一历史结果满足成功口径则直接完成；否则展示可跳过的增量引导。** | 避免打扰成熟用户，同时帮助只试聊过但未闭环的用户 |
| Q-6 | 本地算力激活失败后是否自动跳 Settings？ | **不自动跳；原地说明原因，用户点击“配置 Provider”后进入。** | 防止界面突变，并保留重试本地算力的机会 |
| Q-7 | `waived` 是否可直接算完成？ | **可以，但必须由用户明确操作并保留理由；系统不得自动豁免。** | 兼容无法自动验证的真实任务，同时保证审计性 |
| Q-8 | onboarding 标记存放在哪里？ | **优先放现有 settings 持久化域，记录 schemaVersion、completedAt、candidateSessionId、milestone timestamps；不复制任务数据。** | 可跨重启恢复且边界清晰；若 AppSettings 变更则需按六环链路独立评审 |

---

## 7. 验收标准

| # | 可测试验收项 | 验证方法 |
|---|---|---|
| AC-1 | Provider 尚未完成水合时不显示“无 Provider”错误；水合完成且无可用 Provider时进入算力激活/配置路径 | 延迟 `listProviders()` 返回，确认 UI 先显示检测态；返回空数组后才显示下一步 |
| AC-2 | 无 Provider 且本地算力激活成功后，`providerId` 为返回 Provider、`model = AUTO_MODEL`，无需打开 Settings 即可开始首任务 | mock `activateLocalCompute()` 返回 activated，检查草稿与按钮状态 |
| AC-3 | 本地算力激活失败时不创建 Session；“重试检测”和“配置 Provider”可用，输入、项目与 TaskStrategy 草稿不丢失 | mock unavailable/throw，断言 `createSession` 未调用；打开并关闭 Settings 后检查草稿 |
| AC-4 | 已配置默认 Provider 且 ready 时直接选择该 Provider；默认 Provider 不可用时仍可通过现有全局自动路由使用其他可用算力 | 分别构造 ready/unready 默认 Provider，检查 `welcomeSessionOptions` 与校验结果 |
| AC-5 | 四个现有预设的 prompt 文本与 TaskStrategy 映射保持不变：understand=view、review=view、report=execute、plan=plan | 组件/单元测试读取 `data-welcome-preset` 与 `data-preset-strategy`，比对既有 i18n prompt |
| AC-6 | 双击预设或连续按 Enter 只创建 1 个 Session、发送 1 次首条 prompt；重启恢复 running 状态时不重复发送 | 并发触发 submit，断言 `startSessionWithPrompt` 一次；重载 store 后断言 sendMessage 未新增调用 |
| AC-7 | 首任务回合结束且结果快照为 ready 时，仅自动调用一次 `openPanel('result')`；WB-P1 的 `activePanelId='result'` 且 keep-alive 正常 | 模拟 session 终态与 ready snapshot，检查 store；切换到 Diff 再切回 result，状态不丢 |
| AC-8 | 快照 unbound、Artifact 为 0、Artifact 均不可用，或 Acceptance 为 pending/failed 时均不得标记 completed，并显示对应可执行下一步 | 用四组 snapshot fixture 验证状态保持 `reviewing_result` 及行动入口 |
| AC-9 | 至少打开一个 available Artifact，且 Acceptance 全部 passed 或由用户明确带理由 waived 后，记录 completed；刷新应用后不再强制展示首任务引导 | 模拟 Artifact open 与 Acceptance review，检查持久化完成标记和重启投影 |
| AC-10 | 回归不破坏 WB-P0、WB-P1、Provider Settings、Goal Task、Routine 与六环链路 | 执行现有回归：view 禁写、execute 编辑放行；11 面板切换/keep-alive；Provider 编辑保存；Goal/WorkItem/Acceptance；Routine CRUD/运行；确认无 renderer 私造 API |
