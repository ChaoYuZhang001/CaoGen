# CaoGen UI 重构计划(四阶段任务卡)

> 2026-07-25 · 基于真实读码体检。目标:**不动事件溯源 spine,只重塑 UI 的形状**——设计基座 → 状态切片 → 组件重组 → 布局壳。
> 与 `UX-UPGRADE-PLAN.md` 的关系:该计划管"体验对标",本计划管"代码结构";其遗留项 U3.3 / U3.4 / U4.3 / U5.3 由本计划 P2/P3 消化。

## 体检数据(重构的依据)

| 部位 | 现状 | 问题 |
|---|---|---|
| `src/renderer/src/styles.css` | 8387 行单文件,`main.tsx` 单点引入 | 字号硬编码 14 种(11px×64、12px×69…)、圆角 12 种、~996 处 var 引用但无分层纪律 |
| `src/renderer/src/store.ts` | 4016 行单文件 zustand | 会话/设置/项目/10 个面板/3D/弹窗全在一起,改动相互踩踏 |
| `SettingsModal.tsx` | 1393 行,9 个 tab(control/general/permissions/project/persona/office/providers/plugins/migrate) | 全量渲染,无懒加载 |
| `Sidebar.tsx` | 880 行 | 导航/项目分组/置顶/恢复/归档/底栏揉在一起 |
| `ChatView.tsx` | 769 行 | 内部已长出 IconButton/MenuItem/VirtualMessageList 等应公共化的组件 |
| `WorkbenchRoot.tsx` | 10 个面板 × 各自 open/close action | 每加一个面板要改 N 处,纯样板 |
| `components/` 根目录 | 近 40 个 tsx 平铺 | 无 ui/ 原语层,每个面板自创按钮与卡片 |

## 总原则与红线

1. **事件溯源不破坏**:`UI 状态 = reduce(events)` 一行不动;store 切片只是"分文件",不改 action 语义与事件流。
2. **技术栈不换**:React 18 + zustand + 手写 CSS;不引重型组件库(MUI/AntD 等),原语全部自实现(对齐"不搬竞品代码"仓规)。
3. **3D 是状态的投影**:office/ 只在 P2 接面板协议,动画仍由真实事件驱动。
4. **每卡独立可回滚**:typecheck + build 过、E2E 截图对比、独立提交、提交信息写"做了什么 + 怎么验证"。

## 执行顺序

```
P0 设计基座(卡 A→B→C→D)  →  P1 巨石手术(卡 E→F→G→H)  →  P2 布局统一(卡 I→J→K)  →  P3 打磨(卡 L→M→N)
   不动业务逻辑,视觉零变化      逐文件拆、逐文件过            消化 U3.3 / U5.3           消化 U3.4 / U4.3
```

P0 全部完成后才进 P1(基座不立,拆出来的组件会再造轮子);P1 内 E/F/G 可并行,H(store)最后做;P2 的 I 是 J/K 的前置。

---

## P0 · 设计基座

### 卡 A(P0.1)· Token 三层体系落地 [impact high · cost low] —— 最先做
- 新建 `src/renderer/src/styles/tokens.css`,三层注释分明:
  - **L1 Primitive**:`--c-{name}-{50..900}` 色阶、间距 4px 基(`--space-1..8`)、字号 5 档(`--fs-xs:11 / --fs-sm:12 / --fs-md:13 / --fs-lg:15 / --fs-xl:20`)、圆角 4 档(`--radius-sm:6 / --radius-md:8 / --radius-lg:12 / --radius-full:999`)、阴影 2 档。
  - **L2 Semantic**:`--bg-primary/--bg-surface/--bg-elevated`、`--text-primary/secondary/tertiary`、`--border-default/strong`、`--accent/--accent-hover`、`--success/--danger/--warning/--info`;`[data-theme='dark']` 全量覆盖一份。
  - **L3 Component**:`--btn-bg-hover`、`--panel-border`、`--composer-radius`、`--tab-active-bg`、`--sidebar-bg` 等,从 styles.css 现有高频模式归纳,不新设计。
- `main.tsx` 改引 `./styles/index.css`(index 只做 @import 聚合,顺序:tokens → base → 各域)。
- 本卡**只新增 token、不改任何旧规则**,视觉必须零变化。
- 验收:build 过;`grep -c "var(--fs-" styles/tokens.css` ≥ 0 且三层注释齐全;E2E 截图与 main 逐像素对比无差异。

### 卡 B(P0.2)· styles.css 按域拆 8 文件 [impact high · cost medium]
- 纯**剪切搬运**,不改选择器、不改值,拆为 `styles/` 下:`base.css`(reset/滚动条/焦点环/全局)、`layout.css`(App 壳/主区)、`sidebar.css`、`chat.css`(消息流/工具卡/Composer)、`workbench.css`(全部面板)、`office.css`(3D 工位)、`settings.css`、`components.css`(btn/modal/toast/tooltip 等跨域小件)。
- `styles/index.css` 按原先后顺序 @import 聚合;`main.tsx` 只引 index。
- 正确性验证:脚本把 8 文件按序拼接后与拆前 `styles.css` 做 diff,只允许注释/空行差异。
- 验收:build 过;拼接 diff 为零;E2E 截图对比无差异;`git mv` 语义保留 blame。

### 卡 C(P0.3)· ui/ 原语 ×12 [impact high · cost medium]
- 新建 `src/renderer/src/components/ui/`:`Button`、`IconButton`(从 `ChatView.tsx` 内部 IconButton 提取)、`MenuItem`(同提取)、`Tooltip`、`Modal`、`Tabs`、`Panel`(头+体+关闭按钮,为 P2 面板协议铺垫)、`EmptyState`、`Skeleton`、`Badge`、`Toast`、`Select`。
- 样式放 `styles/components.css`,全部走 L3 token;每个原语 ≤120 行,API 最小化(variant/size 两个维度封顶)。
- 替换试点:ChatView、Sidebar、SettingsModal 各选 2-3 处换用原语,验证视觉一致。
- 验收:原语单测/渲染冒烟过;试点处截图对比无差异;`grep "function IconButton"` 全仓只剩 ui/ 一处。

### 卡 D(P0.4)· 硬编码收敛 codemod [impact medium · cost medium]
- 新建 `scripts/ui-token-codemod.mjs`(dry-run 默认):把 14 种 `font-size: Npx` → 对应 `var(--fs-*)`,12 种 `border-radius: Npx` → `var(--radius-*)`;映射表外的一律不动并列入报告。
- **一次一域、一域一提交**(sidebar → chat → workbench → settings → office),每域跑完截图对比。
- 验收:完成后 `grep -oE "font-size: [0-9]+px" styles/*.css | wc -l` ≤ 20(仅特例);全站字号/圆角视觉无漂移。

---

## P1 · 巨石手术

### 卡 E(P1.1)· SettingsModal 按 tab 拆分 [impact high · cost medium]
- 1393 行 → `components/settings/` 下每 tab 一个文件:`ControlTab / GeneralTab / PermissionsTab / ProjectTab / PersonaTab / OfficeTab / ProvidersTab / PluginsTab / MigrateTab`;壳组件只保留 tab 路由与 modal 框架;非激活 tab `React.lazy` 懒加载。
- 共享子件(ProviderEditor 等)同目录沉淀;样式归 `styles/settings.css`。
- 验收:单文件 ≤400 行;9 个 tab 功能逐项手测(重点:Provider 编辑保存、权限模式切换);设置打开首帧渲染量下降(React Profiler 前后对比)。

### 卡 F(P1.2)· Sidebar 拆分 [impact high · cost medium]
- 880 行 → `components/sidebar/`:`SidebarNav`(图标导航,对齐 UX-UPGRADE-PLAN 卡 J)、`SessionGroupList`(项目分组/折叠)、`SessionCard`、`PinnedSection`、`RecoverySection`、`ArchiveSection`、`SidebarFooter`(设置 + 引擎状态行)。
- 交互(折叠/右键菜单/拖拽)原样迁移,不改行为。
- 验收:单文件 ≤400 行;分组折叠、会话右键菜单、归档展开手测过;空态(卡 D 已收拢)不回归。

### 卡 G(P1.3)· ChatView 拆分 [impact high · cost medium-high]
- 769 行 → `components/chat/`:`ChatHeader`(工具栏,P2 图标化的落点)、`MessageList` + `VirtualMessageList` + `VirtualMessageRow`(已存在,移出单文件)、`ComposerDock`、`RewindDock`。
- `SessionModelSelect`、`errorText`、虚拟滚动 offsets 算法随迁;**流式 rAF 合帧与 stickToBottom 行为零改动**。
- 验收:`npm run test:chat-virtual-list` 过;长会话滚动/流式/审批条/Rewind 入口手测过。

### 卡 H(P1.4)· store 切 6 slice [impact high · cost medium-high] —— P1 收尾
- `store.ts` 4016 行 → `store/` 下 zustand 标准 slice 模式合并:
  - `sessionSlice`:sessions/order/activeId/history + 流式 buffer(Map<sessionId,{text,thinking}>);
  - `settingsSlice`:settings/providers;
  - `projectsSlice`:projects;
  - `workbenchSlice`:10 个面板的 open/loading/data(为卡 I 协议化铺垫,本卡只做搬运);
  - `officeSlice`:3D 工位状态;
  - `uiSlice`:view/showNewSession/rewindPanel/各 modal 开关。
- action 名与签名保持不变(组件零改动);事件桥接/IPC 订阅层原样。
- 验收:typecheck 过;会话生命周期 E2E(新建→发送→中断→Esc Esc 回退→恢复);每 slice 可独立单测(构造初始态 + 调 action 断言)。

---

## P2 · 布局统一

### 卡 I(P2.1)· 面板容器协议 [impact high · cost medium] —— P2 前置
- 消灭 `WorkbenchRoot` 的 10 对 open/close 样板:定义 `PanelDefinition { id, title, icon, component, defaultSize, onOpen?, onClose? }`,集中在 `workbench/panels.ts` 注册;store 泛化为 `openPanel(id)` / `closePanel(id)` + `panels: Record<PanelId, PanelState>`。
- 10 个现有面板(Terminal/Browser/Diff/Files/Preview/Worktree/PluginRegistry/Subagent/Routine/Memory)逐个改注册,行为不变。
- 验收:新增一个 dummy 面板 = 注册表 1 行 + 1 个组件文件即可上线;10 面板开/关/刷新/折叠手测过。

### 卡 J(P2.2)· AppShell 布局壳 [impact high · cost medium-high]
- `App.tsx`(173 行)重构为 `AppShell`:左 46px 图标导航栏(新对话/搜索/Routines/插件 + 底部设置)、会话列表列(`Cmd+B` 折叠)、主区、右 Dock 区(最多 2×2 槽位,面板可拖拽换位,布局存 settings、按会话记忆)。
- Dock 布局引擎自研轻量实现,不引 dockview/golden-layout 等重库(对齐 D4"杜绝 IDE 化失控")。
- 验收:`Cmd+B` 折叠/展开;Dock 面板拖换位且重启后还原;3D 工位作为 Dock 面板接入后事件驱动动画不回归(office-status-recheck 过)。

### 卡 K(P2.3)· 会话标签栏 + 聊天头图标化 [impact medium · cost medium](消化 U5.3 + U3.3)
- 主区顶部会话 Tabs(基于 `order[]`),切换不销毁会话状态(`WorkbenchRoot` 去掉 `key={activeId}` 重挂);`Cmd+1..9` 直达。
- `ChatHeader` 的 10 个纯文字 btn-ghost → 28×28 `ui/IconButton` + Tooltip;低频项收"⋯ 更多"下拉;model/权限下拉左置。
- 验收:标签切换时流式输出不中断、滚动位置保留;头部单行不换行;图标可扫读。

---

## P3 · 打磨抛光

### 卡 L(P3.1)· 骨架屏 + 空态统一 [impact medium · cost low]
- FilePanel / PluginRegistryPanel / DiffPanel / StartSuggestionsPanel 的 loading 全部换 `ui/Skeleton`(shimmer);全站空态走 `ui/EmptyState`(图标 + 一句口语化文案 + CTA),对齐 UX-UPGRADE-PLAN 卡 K 的文案语气。
- 验收:加载不跳版;空态走查清单(侧栏/面板/搜索无结果/历史为空)全过。

### 卡 M(P3.2)· 焦点环 + reduced-motion + 色弱编码 [impact medium · cost low]
- `:focus-visible` 覆盖所有可交互元素(btn/session-card/file-row/tab/panel 头);`@media (prefers-reduced-motion: reduce)` 兜底补全遗漏处;office 状态色之外的第二通道:形状/图标编码(运行=▶、等待=⏸、错误=✖ 头顶标识)。
- 验收:纯键盘 Tab 全程可见落点;系统开"减少动态效果"后动画关闭;色弱模拟下 3 秒读出全部工位状态。

### 卡 N(P3.3)· 主题体系收口 [impact medium · cost medium]
- light/dark 全量走 L2 semantic(卡 D 后剩余硬编码颜色清零);设置页加主题预览;品牌渐变光晕(UX-UPGRADE-PLAN 卡 K)落为 token(`--brand-glow`),reduced-motion 下静态化。
- 验收:两主题截图走查(侧栏/聊天/面板/设置/3D);`grep -E "#[0-9a-fA-F]{3,6}" styles/*.css`(tokens.css 除外)≈ 0。

---

## 验收总表(重构完成的定义)

1. `styles.css` 单文件消失,`styles/` 8 域 + tokens.css 三层;字号 ≤5 档、圆角 ≤4 档、硬编码色值 ≈0。
2. `store.ts` 消失,`store/` 6 slice,单文件 ≤600 行;事件 reduce 路径 diff 为空。
3. 三大巨石(SettingsModal/Sidebar/ChatView)全部 ≤400 行/文件;`components/ui/` 12 原语被 ≥10 处复用。
4. 新增面板成本 = 注册表 1 行 + 1 组件;`Cmd+B`/`Cmd+1..9`/标签栏/Dock 换位全部可用。
5. 每卡 typecheck + build 过、E2E 截图对比、独立提交;全程视觉回归为零(除 P2/P3 有意为之的布局改进)。
