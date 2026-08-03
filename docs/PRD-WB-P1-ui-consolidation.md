# 增量 PRD:WB-P1 — UI/结果工作台收编

> 文档版本:v1.0
> 编写日期:2026-07-30
> 前置依赖:WB-P0 TaskStrategy 收编(commit `d0b86c52`,已双重验证通过)
> 关联 gap 分析项:WB-P1(`docs/COMPETITOR-GAP-ANALYSIS.md` 第 153 行)
> 关联重构计划:`UI-REFACTOR-PLAN.md` 卡 I(P2.1 面板容器协议)前移
> PRD 类型:简单 PRD(增量)

---

## 1. 项目信息

- **Language**:简体中文
- **Programming Language**:Electron 40 + React 18 + TypeScript + Zustand(现有技术栈,无变更)
- **Project Name**:caogen_wb_p1_ui_consolidation
- **原始需求复述**:CaoGen 工作桌面当前由 `WorkbenchRoot.tsx` 管理 10 个独立面板(Diff/Browser/File/Preview/Worktree/Terminal/PluginRegistry/Subagent/Routine/Memory),每个面板有独立的 `*Open` 布尔值和 `open*/close*` 方法,共享 1 个 UI 槽位,互斥靠手动 `useEffect` + 10 行 `closeActiveSidePanel` 维护,渲染靠 75 行 if/else 链。新增面板需改 N 处样板代码,且面板切换会销毁已打开面板的运行时状态(终端会话丢失、浏览器导航历史丢失、文件编辑草稿丢失)。本次收编将 10 面板 + StudioResultPanel 统一为面板注册表 + 活动面板 ID 模型,实现切换不销毁(keep-alive),并为后续多槽位布局铺路。

---

## 2. 产品定义

### 2.1 产品目标

1. **统一面板模型**:用 `activePanelId: PanelId | null` 替换 10 个 `*Open` 布尔值 + `resultOpen` 本地 state,消灭手动互斥逻辑和 75 行 if/else 渲染链。新增面板成本从"改 N 处"降为"注册表 1 行 + 1 个组件"。
2. **切换不销毁(keep-alive)**:面板切换时已打开面板的运行时状态(终端会话、浏览器页面、文件草稿、预览渲染)保持存活,切回时无重载闪烁。这是当前用户最大的体感痛点——在 Terminal 跑测试时切去 Diff 看变更,切回 Terminal 发现会话已断。
3. **结果面板归一**:将 `StudioResultPanel` 从 `WorkbenchRoot` 的本地 `resultOpen` state 纳入统一面板系统,消除"10 个面板在 store、1 个面板在组件 state"的割裂。
4. **零功能回归**:DeskControlRail 的 6 个工具选项卡(review/terminal/browser/files/sideChat/memory)保持不变;WB-P0 的 TaskStrategy 控制(view/plan/execute)不受影响;Routine 自动化路径和 RoutineEditor 权限选择器不受影响;六环链路(主进程→IPC→preload→types→store→UI)不被破坏。

### 2.2 用户故事

| # | 角色 | 场景 | 价值 |
|---|------|------|------|
| US-1 | 开发者 | 在 Terminal 面板跑 `npm test` 时,切到 Diff 面板查看代码变更,再切回 Terminal——测试输出仍在,会话未断 | 多面板并行工作流不中断,无需重跑命令 |
| US-2 | 开发者 | 在 File 面板编辑了半个文件(未保存),切去 Browser 面板查文档,再切回 File——草稿还在光标位置 | 编辑上下文不丢失,减少重复劳动 |
| US-3 | 开发者 | Agent 执行完任务后,在结果面板查看产物摘要,点击"查看 Diff"直接切到 Diff 面板,再点"查看文件"切到 File 面板,来回切换无重载 | 高效审查执行结果,面板间无缝跳转 |
| US-4 | 贡献者 | 想给工作台加一个"Git Log 历史面板",只需在 `panels.ts` 注册 1 行 + 写 1 个组件文件,不需要改 store 的 10 个 open 方法 | 降低贡献门槛,面板生态可扩展 |
| US-5 | 开发者 | 打开 Preview 面板看渲染效果,同时想看 Terminal 的构建日志——两个面板的状态都保留,通过 DeskControlRail 一键切换 | 预览与日志并行查看,不需重新构建或重新打开 |

---

## 3. 技术规范

### 3.1 现状基线(代码核实)

| 部位 | 位置 | 现状 | 问题 |
|------|------|------|------|
| **面板开关状态** | `store.ts:633-730`(`WorkbenchState`) | 10 个 `*Open: boolean` 字段(`diffOpen`/`browserOpen`/`filesOpen`/`previewOpen`/`worktreeOpen`/`terminalOpen`/`pluginRegistryOpen`/`subagentOpen`/`routineOpen`/`memoryOpen`) | 每加一个面板加一个字段,互斥靠每个 `open*` 方法手动 set 其余 9 个为 false |
| **结果面板开关** | `WorkbenchRoot.tsx:51` | `const [resultOpen, setResultOpen] = useState(false)` 本地 state | 不在 store 中,与其他 10 面板割裂;`useEffect`(L239-243)手动同步 |
| **互斥逻辑** | `store.ts:1821-1838` 等处 | 每个 `open*Panel` 方法内联 10 行 `...s.workbench, diffOpen: true, worktreeOpen: false, terminalOpen: false, ...` | 10 个方法 × 10 行 = 100 行样板;漏改一个就出 bug |
| **关闭逻辑** | `WorkbenchRoot.tsx:40-46` | `closeActiveSidePanel(candidates, fallback)` 遍历 10 个 `[isOpen, closeFn]` 元组 | 顺序敏感,新增面板需手动加入数组 |
| **渲染分发** | `WorkbenchRoot.tsx:282-357` | 75 行 if/else 链:`resultOpen ? <StudioResultPanel> : terminalOpen ? <TerminalPanel> : ...` | 优先级隐式;新增面板需插入链中;所有面板条件渲染,切换即卸载 |
| **面板数据** | `store.ts:633-730` | 每个面板的数据字段散落在 `WorkbenchState`(如 `terminal`/`terminalBuffer`/`browserState`/`fileEntries`/`preview`/`pluginRegistry`/`routines`/`memoryInitialForm` 等) | 缺乏统一组织,但字段本身功能正常,本次不改数据结构 |
| **DeskControlRail** | `WorkbenchRoot.tsx:191-237` | 6 个 `DeskToolItem`(review/terminal/browser/files/sideChat/memory),每个有 `active` 和 `onSelect` | 保留不动,但 `active` 和 `onSelect` 将映射到新的 `activePanelId` |
| **面板组件** | `src/renderer/src/components/workbench/*.tsx` | 10 个独立面板组件 + StudioResultPanel | 组件本身不变,只改挂载方式 |

**核心问题**:面板的"是否打开""是否激活""渲染哪个"三个关注点被分散在 10 个布尔值 + 1 个本地 state + 1 个 useEffect + 1 个 closeActiveSidePanel + 1 个 if/else 链中,且条件渲染导致切换即卸载、状态即丢失。

### 3.2 需求池

#### P0 — 必须完成(Must have)

**P0-1:面板注册表(Panel Registry)**

- 新建 `src/renderer/src/components/workbench/panels.ts`,定义面板注册表:

```typescript
export type PanelId =
  | 'result' | 'diff' | 'terminal' | 'browser' | 'files'
  | 'preview' | 'worktree' | 'pluginRegistry' | 'subagent'
  | 'routine' | 'memory'

export interface PanelDefinition {
  id: PanelId
  titleKey: string        // i18n key
  icon: HeaderIconName
  component: React.LazyExoticComponent<React.ComponentType<any>>
  keepAlive: boolean      // 是否在切换时保持挂载
  onActivate?: () => void // 打开时的副作用(如 refreshDiffPanel)
}
```

- 11 个面板(原 10 个 + StudioResultPanel)逐个注册,`keepAlive` 默认为 `true`。
- `component` 使用 `React.lazy()` 懒加载,首次打开才加载代码。

**P0-2:统一活动面板状态(activePanelId)**

- `WorkbenchState` 新增 `activePanelId: PanelId | null` 字段,初始值 `null`。
- 废弃 10 个 `*Open` 布尔值作为"当前活动面板"的判断依据;它们可保留为 `panels: Record<PanelId, { mounted: boolean }>` 中的 `mounted` 字段(用于 keep-alive),或直接由 `activePanelId` + keep-alive 集合推导。
- `resultOpen` 本地 state 移入 store:当 `activePanelId === 'result'` 时结果面板激活。

**P0-3:通用 openPanel / closePanel / togglePanel API**

- 新增三个通用方法替换 10 对 open/close:

```typescript
openPanel(id: PanelId): void    // 设 activePanelId = id;触发 onActivate
closePanel(): void               // 设 activePanelId = null(keep-alive 面板保持 mounted)
togglePanel(id: PanelId): void   // activePanelId === id ? closePanel() : openPanel(id)
```

- 旧的 `openDiffPanel`/`closeDiffPanel`/`openBrowserPanel` 等方法保留为**薄包装**(deprecation 过渡),内部调用 `openPanel('diff')` / `closePanel()` 等,确保调用方平滑迁移。
- `closeActiveSidePanel` 简化为 `closePanel()`(不再需要遍历 10 个候选)。

**P0-4:keep-alive 渲染策略**

- `WorkbenchRoot` 的 if/else 链替换为注册表遍历:

```tsx
{PANEL_REGISTRY.map(def => {
  const isActive = activePanelId === def.id
  const isMounted = mountedPanels.has(def.id)  // keep-alive 集合
  if (!isActive && !isMounted) return null
  return (
    <div
      key={def.id}
      className="workbench-panel"
      style={{ display: isActive ? 'flex' : 'none' }}
      aria-hidden={!isActive}
    >
      <def.component {...panelProps[def.id]} />
    </div>
  )
})}
```

- `mountedPanels: Set<PanelId>` 跟踪已挂载面板;面板首次激活时加入集合,`closePanel` 时 keep-alive 面板不从集合移除(保持挂载),非 keep-alive 面板移除。
- 提供显式 `unmountPanel(id)` 方法供特殊场景(如"重置终端")主动销毁面板状态。
- 首次渲染时仅挂载 `activePanelId` 对应组件;切换面板时旧面板 `display: none`、新面板 `display: flex`(若未挂载则挂载)。

**P0-5:StudioResultPanel 纳入注册表**

- `resultOpen` 本地 state 删除,`StudioResultPanel` 作为 `PanelId = 'result'` 注册到面板注册表。
- `toggleSummaryPanel`(WorkbenchRoot.tsx:167-174)改为 `togglePanel('result')`。
- `useEffect`(L239-243,手动同步 resultOpen 与其他面板)删除——统一模型下互斥由 `activePanelId` 单值保证。

**P0-6:DeskControlRail 映射更新**

- DeskControlRail 的 6 个工具选项卡保留不变(不改 UI、不改图标、不改文案)。
- 内部映射更新:`active` 判断从 `diffOpen || worktreeOpen` 改为 `activePanelId === 'diff' || activePanelId === 'worktree'`;`onSelect` 从 `openDiffPanel()` 改为 `openPanel('diff')`。
- review 选项卡:激活条件 = `activePanelId === 'diff' || activePanelId === 'worktree'`,点击行为 = 打开 diff(保持现有行为)。
- files 选项卡:激活条件 = `activePanelId === 'files' || activePanelId === 'preview'`,点击行为 = 打开 files(保持现有行为)。

**P0-7:面板属性传递机制**

- 每个面板组件需要不同的 props(如 `PluginRegistryPanel` 需要 15+ props,`SubagentPanel` 需要 8 props)。
- 定义 `panelProps: Record<PanelId, Record<string, unknown>>`,由 `WorkbenchRoot` 统一从 store 选取并组装。
- 或更优:每个面板组件内部自行 `useStore` 选取所需状态(部分面板已是如此,如 `DiffPanel`/`TerminalPanel`/`WorktreePanel`),`WorkbenchRoot` 只传 `sessionId` 等最小公共 props。**推荐后者**——减少 `WorkbenchRoot` 的 selector 膨胀(当前已有 60+ `useStore` 调用)。

#### P1 — 应该完成(Should have)

- **P1-1:面板级数据组织**:将 `WorkbenchState` 中每个面板的散落数据字段(`terminal`/`terminalBuffer`/`browserState`/`fileEntries`/`preview`/`pluginRegistry`/`routines` 等)归组到 `panels: Record<PanelId, PanelData>` 下,如 `panels.terminal.terminal`/`panels.terminal.buffer`。纯数据搬家,不改语义。降低 `WorkbenchState` 的认知负担(当前 97 个字段)。

- **P1-2:面板头标准化**:每个面板顶部统一 `<PanelHeader title={...} onClose={closePanel} actions={...} />`(对齐 UI-REFACTOR-PLAN 卡 C 的 `Panel` 原语)。当前各面板自行实现关闭按钮和标题,样式不统一。

- **P1-3:会话级面板记忆**:`activePanelId` 和 `mountedPanels` 按 sessionId 隔离,切换会话时恢复该会话上次打开的面板。当前面板状态是全局的,切会话后面板状态不随会话走。

- **P1-4:键盘快捷键**:`Cmd+Shift+1..9` 快速切换面板(对齐 UI-REFACTOR-PLAN 卡 K 的 `Cmd+1..9` 会话切换,面板快捷键用 `Cmd+Shift` 前缀区分)。

- **P1-5:旧方法标记废弃**:在 `openDiffPanel`/`closeDiffPanel` 等薄包装方法上加 `@deprecated use openPanel('diff') instead`,配合 lint 规则在后续 PR 中清理调用方。

#### P2 — 可选(Nice to have)

- **P2-1:多槽位布局**:允许用户将面板拖拽到第 2 个槽位(如左 Dock + 右 Dock),实现两个面板并排显示。对齐 UI-REFACTOR-PLAN 卡 J(AppShell Dock 区 2×2 槽位)。需评估布局引擎自研成本。

- **P2-2:面板拖出独立窗口**:面板可拖出为独立 Electron 窗口(如终端独立窗),对齐竞品的多窗口工作流。需评估多窗口 IPC 复杂度。

- **P2-3:面板状态持久化**:`activePanelId` 和 `mountedPanels` 持久化到 settings,应用重启后恢复上次面板布局。

- **P2-4:面板尺寸记忆**:每个面板独立记忆宽度(当前所有面板共享 `workbenchSideWidth`),切换面板时恢复该面板上次宽度。

---

### 3.3 关键交互流

以下描述用户"在 Terminal 跑测试 → 切 Diff 看变更 → 切回 Terminal 继续看输出 → 打开结果面板查看产物"的完整路径,验证 keep-alive 和统一面板模型:

**步骤 1 — 打开 Terminal 面板**
- 用户点击 DeskControlRail 的 Terminal 选项卡。
- 系统:`openPanel('terminal')` → `activePanelId = 'terminal'`,`mountedPanels.add('terminal')`。
- UI:workbench-side 区域显示 `<TerminalPanel>`,`display: flex`。
- Terminal 面板初始化,用户输入 `npm test`,测试开始运行,输出流式显示。

**步骤 2 — 切到 Diff 面板(keep-alive 验证)**
- 用户点击 DeskControlRail 的 Review 选项卡。
- 系统:`openPanel('diff')` → `activePanelId = 'diff'`,`mountedPanels.add('diff')`(terminal 仍在集合中)。
- UI:
  - Terminal 面板 `display: none`(**不卸载**,终端会话保持连接,`npm test` 继续运行)。
  - Diff 面板 `display: flex`(首次打开,触发 `onActivate` → `refreshDiffPanel() + refreshGitStatus()`)。
- 用户查看代码变更。Terminal 的 `npm test` 在后台继续运行。

**步骤 3 — 切回 Terminal(状态保留验证)**
- 用户点击 DeskControlRail 的 Terminal 选项卡。
- 系统:`openPanel('terminal')` → `activePanelId = 'terminal'`(diff 仍在 mountedPanels 中)。
- UI:
  - Diff 面板 `display: none`(不卸载,diff 数据保留)。
  - Terminal 面板 `display: flex`(已挂载,无重载,**`npm test` 输出连续,会话未断**)。
- 用户看到测试在后台已跑完,输出完整可见。**无闪烁、无重连**。

**步骤 4 — 打开结果面板**
- 用户点击 DeskControlRail 顶部的 Summary 按钮(`toggleSummaryPanel`)。
- 系统:`togglePanel('result')` → `activePanelId = 'result'`,`mountedPanels.add('result')`。
- UI:Terminal 和 Diff 面板均 `display: none`(均保持挂载),结果面板 `display: flex`。
- 用户在结果面板查看产物摘要、artifacts、evidence、timeline。

**步骤 5 — 从结果面板跳转到 Diff**
- 用户在结果面板点击"查看 Diff"按钮。
- 系统:`openPanel('diff')` → `activePanelId = 'diff'`。
- UI:结果面板 `display: none`,Diff 面板 `display: flex`(已挂载,**diff 数据无需重新加载**)。
- 用户查看 diff,切回结果面板(`togglePanel('result')`),结果面板数据也在。
- 全程无网络请求、无重载、无闪烁。

**步骤 6 — 关闭所有面板**
- 用户点击 workbench-side-gutter 的折叠按钮(`collapseSidePanel`)。
- 系统:`closePanel()` → `activePanelId = null`。
- UI:workbench-side 区域隐藏(`sideOpen = false`)。所有 keep-alive 面板保持 mounted(`display: none`),状态保留。
- 下次打开任意面板时,若该面板在 mountedPanels 中,直接 `display: flex` 恢复。

---

### 3.4 与现有能力的关系(不破坏清单)

本次收编**只改 UI 面板调度层**,以下能力保持不变:

| 现有能力 | 保持不变的原因 |
|---------|--------------|
| **WB-P0 TaskStrategy 控制** | TaskStrategy(view/plan/execute)的 `decideTaskStrategyTool()` preflight 拦截、PermissionMode 派生映射、`TaskStrategyControl` 三按钮均不变。面板收编不触及策略层 |
| **Routine 自动化路径** | `Routine` 类型、`RoutineEditor.tsx` 的 PermissionMode 选择器、Routine 定时执行、`markRoutineRun`/`toggleRoutine`/`deleteRoutine` API 不变。RoutinePanel 只是改挂载方式,不改 Routine 逻辑 |
| **DeskControlRail 工具选项卡** | 6 个选项卡(review/terminal/browser/files/sideChat/memory)的 UI、图标、文案、快捷行为不变。仅内部 `active` 判断和 `onSelect` 调用从 `*Open`/`open*Panel` 映射到 `activePanelId`/`openPanel(id)` |
| **六环链路铁律** | 本次改动在 store → UI 环(第 5-6 环),不新增跨进程能力,不触及主进程 → IPC → preload → types 环。`WorkbenchState` 类型变更属于 store 内部重组,不新增 IPC 通道 |
| **面板组件内部逻辑** | 10 个面板组件(TerminalPanel/BrowserPanel/DiffPanel/FilePanel/PreviewPanel/WorktreePanel/PluginRegistryPanel/SubagentPanel/RoutinePanel/MemoryPanel)和 StudioResultPanel 的内部逻辑不变。只改它们的挂载和卸载方式 |
| **面板数据字段** | `WorkbenchState` 中每个面板的数据字段(terminal/browserState/fileEntries/preview/pluginRegistry/routines 等)功能不变。P0 不搬移数据字段(留到 P1-1) |
| **Effect Ledger / TaskPlan 生命周期** | 不变。面板收编不触及执行层 |
| **事件溯源 spine** | `UI 状态 = reduce(events)` 不变。面板开关状态变更不产生新事件类型,仅是 store 内部字段重组 |
| **面板间跳转调用** | `StudioResultPanel.openTool()` 调用 `openDiffPanel()`/`openFilesPanel()` 等——这些方法保留为薄包装,内部转发到 `openPanel(id)`,调用方零改动 |
| **布局设置** | `workbenchSideWidth`/`SIDE_MIN_WIDTH`/`SIDE_MAX_WIDTH` 和拖拽调整逻辑不变 |

**收编只改三处**:
1. **状态层**:`WorkbenchState` 新增 `activePanelId` + `mountedPanels`,废弃 10 个 `*Open` 作为活动判断依据(P0-2)。
2. **方法层**:新增 `openPanel`/`closePanel`/`togglePanel` 通用 API,旧 `open*Panel`/`close*Panel` 降级为薄包装(P0-3)。
3. **渲染层**:`WorkbenchRoot` 的 if/else 链替换为注册表遍历 + `display: none` keep-alive(P0-4)。

---

## 4. 待确认问题

以下问题需要主理人/用户拍板,PRD 暂以建议默认值推进:

| # | 问题 | 建议默认 | 影响范围 | 理由 |
|---|------|---------|---------|------|
| **Q-1** | keep-alive 是否应用于**所有** 11 个面板,还是仅限有状态面板(Terminal/Browser/File/Preview/Result)?无状态面板(Diff/Worktree/PluginRegistry/Subagent/Routine/Memory)每次打开重新加载数据即可,keep-alive 意义不大且占内存。 | **全部 keep-alive**,但提供 `unmountPanel(id)` 供用户主动重置。理由:统一行为降低认知成本;内存占用在桌面应用场景可接受(11 个面板组件多为轻量);Diff/PluginRegistry 等面板虽无运行时会话,但保留滚动位置和选中项也有价值。 | P0-4 | 若仅部分 keep-alive,需为每个面板单独配置 `keepAlive: boolean`,增加注册表复杂度;且用户无法预期"切回哪个面板状态会保留" |
| **Q-2** | 旧的 `open*Panel`/`close*Panel` 方法是保留为薄包装(deprecation 过渡),还是直接删除并修改所有调用方?当前 store.ts 中有约 30 处调用 `open*Panel`/`close*Panel`(含 StudioResultPanel 的 `openTool`、WorkbenchRoot 的 deskTools、各面板的跳转回调)。 | **保留为薄包装**,在 P1-5 标记 `@deprecated`,后续 PR 统一清理。理由:P0 范围控制——直接删除需修改 30+ 处调用方,增加回归风险;薄包装保证调用方零改动,可独立验证 keep-alive 和注册表机制。 | P0-3、P1-5 | 若直接删除,P0 改动面从 3 处扩大到 30+ 处,且与 keep-alive 验证耦合,不利于回滚 |
| **Q-3** | `mountedPanels` 集合是否需要上限?极端情况下用户依次打开所有 11 个面板,全部保持挂载,内存和渲染压力如何? | **不设上限**。理由:11 个面板中重量级组件(Terminal/Browser/Preview)最多 3 个,其余为列表/表单类轻量组件;React.lazy 已保证未打开的面板代码不加载;若未来面板数超过 20+ 可引入 LRU 淘汰策略。 | P0-4 | 设上限会增加复杂度(淘汰策略、用户预期管理);当前 11 个面板的内存占用在 Electron 桌面环境可接受 |
| **Q-4** | 面板数据字段(terminal/browserState/fileEntries 等)是否在 P0 内搬移到 `panels: Record<PanelId, PanelData>` 下?当前 `WorkbenchState` 有 97 个字段,搬移可显著改善组织,但触及所有面板组件的 `useStore` selector。 | **P0 不搬移**,留到 P1-1。理由:P0 聚焦"开关模型 + keep-alive"这一核心价值;数据搬移是纯重构,无用户可见收益,但触及面广(每个面板组件的 selector 都要改),应独立 PR 验证。 | P0-2、P1-1 | P0 改动面已包含状态层 + 方法层 + 渲染层三处,再加数据搬移会导致单 PR 过大、回归风险高 |
| **Q-5** | `activePanelId` 和 `mountedPanels` 是否按会话隔离?当前面板状态是全局的(切会话不切面板),P1-3 建议按会话隔离。 | **P0 全局,P1 按会话隔离**。理由:P0 保持与当前行为一致(全局面板状态),降低回归风险;会话级隔离涉及 `SessionState` 结构变更和会话切换时的面板恢复逻辑,应在 P0 验证通过后独立推进。 | P0-2、P1-3 | 若 P0 即引入会话级隔离,需改 `SessionState` 类型和会话切换 reducer,与面板收编核心目标耦合 |
| **Q-6** | StudioResultPanel 的 `standalone` 和 `onOpenSessionSurface` props 在纳入注册表后如何处理?当前 `standalone` 用于独立窗口模式,注册表渲染时传 `standalone={false}` 即可? | **注册表渲染时传 `standalone={false}`**,`onOpenSessionSurface` 保留为可选回调(注册表模式下可传 `undefined`——关闭结果面板即回到聊天区,无需额外回调)。standalone 模式(独立窗口)不受面板注册表影响,继续直接渲染 `<StudioResultPanel standalone />`。 | P0-1、P0-5 | standalone 模式是独立窗口渲染路径,不走 WorkbenchRoot 的面板槽位,无需纳入注册表 |

---

## 5. 验收标准

| # | 验收项 | 验证方法 |
|---|--------|---------|
| AC-1 | `WorkbenchState` 中存在 `activePanelId: PanelId \| null` 字段,初始值为 `null`;不再依赖 10 个 `*Open` 布尔值判断当前活动面板 | 代码检查:`grep "activePanelId" store.ts` 有结果;`openPanel(id)` 方法存在且设置 `activePanelId` |
| AC-2 | 面板注册表 `panels.ts` 中注册了 11 个面板(result/diff/terminal/browser/files/preview/worktree/pluginRegistry/subagent/routine/memory),每个有 `id`/`titleKey`/`icon`/`component`/`keepAlive` | 代码检查:`PANEL_REGISTRY` 数组长度 === 11;每个 `PanelDefinition` 字段完整 |
| AC-3 | `WorkbenchRoot.tsx` 中不再存在 75 行 if/else 渲染链(L282-357),替换为注册表遍历 + `display: none` 控制可见性 | 代码检查:`grep -n "resultOpen ?\|terminalOpen ?\|browserOpen ?" WorkbenchRoot.tsx` 无结果;存在 `PANEL_REGISTRY.map` 遍历 |
| AC-4 | 在 Terminal 面板执行 `echo test` → 切到 Diff 面板 → 切回 Terminal:终端会话未断,`echo test` 输出仍在(keep-alive 验证) | 手动测试:打开 Terminal → 输入命令 → 切 Diff → 切回 Terminal,确认输出连续 |
| AC-5 | 在 File 面板编辑文件(不保存)→ 切到 Browser 面板 → 切回 File:草稿内容和光标位置保留(keep-alive 验证) | 手动测试:打开 Files → 编辑 → 切 Browser → 切回 Files,确认草稿未丢 |
| AC-6 | `resultOpen` 本地 state 已从 `WorkbenchRoot.tsx` 删除,结果面板通过 `activePanelId === 'result'` 控制;`useEffect`(L239-243)已删除 | 代码检查:`grep "resultOpen\|setResultOpen" WorkbenchRoot.tsx` 无结果;`grep "useEffect" WorkbenchRoot.tsx` 不含面板互斥同步逻辑 |
| AC-7 | DeskControlRail 的 6 个选项卡 UI 不变(图标/文案/布局),点击行为正确:review → openPanel('diff'),terminal → openPanel('terminal'),browser → openPanel('browser'),files → openPanel('files'),sideChat → openPanel('subagent'),memory → openPanel('memory') | 手动测试:逐个点击 6 个选项卡,确认对应面板打开;`active` 高亮状态正确 |
| AC-8 | 旧的 `openDiffPanel()`/`closeDiffPanel()` 等方法仍可调用(薄包装),内部转发到 `openPanel(id)`/`closePanel()`;StudioResultPanel 的 `openTool()` 调用不报错 | 手动测试:在结果面板点击"查看 Diff"/"查看文件"等跳转按钮,确认对应面板打开 |
| AC-9 | WB-P0 TaskStrategy 控制(view/plan/execute 三按钮)功能不受影响:view 档下 Agent 无法执行写操作;execute 档下编辑工具自动放行 | 回归测试:在 view 档触发 write_file 被拒;在 execute 档触发 write_file 无弹窗 |
| AC-10 | Routine 自动化路径不受影响:RoutineEditor 的 PermissionMode 选择器可选四档;Routine 可创建/编辑/启用/删除/手动运行 | 回归测试:打开 Routine 面板 → 新建 Routine → 选择权限模式 → 保存 → 启用 → 手动运行 |
| AC-11 | 新增一个 dummy 面板只需:① 在 `panels.ts` 注册 1 行;② 创建 1 个组件文件。不需要修改 store 的 open/close 方法、不需要修改 `closeActiveSidePanel`、不需要修改 if/else 链 | 验证:创建 `DummyPanel.tsx` + 在 `panels.ts` 添加 1 行注册 → 面板可打开/关闭/切换 |
| AC-12 | `closePanel()` 设置 `activePanelId = null` 后,workbench-side 区域隐藏;所有 keep-alive 面板保持 mounted(`display: none`),重新打开时无重载 | 手动测试:打开 Terminal → 输入命令 → 关闭侧栏 → 重新打开 Terminal,确认会话未断 |
| AC-13 | 六环链路不被破坏:无新增 IPC 通道、无 `shared/types.ts` 的 `AgentDeskApi` 变更、无 preload 暴露变更 | 代码检查:`git diff shared/types.ts` 无新增 API;`git diff preload/` 无变更;`git diff src/main/` 无变更 |
