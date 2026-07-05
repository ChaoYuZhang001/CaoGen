# CaoGen 体验升级计划(对标 Codex/Claude Desktop)

> 基于 6 维度对标审计(2026-07-05,真实读码)。用户反馈"没有 Codex/Claude Desktop 好用:功能不够强、3D 形象太 low、视觉/性能/交互/关键能力都有差距"。
> 分工:此计划交 Codex 执行;规划方逐条 E2E check。每任务:typecheck+build 过、六环链路齐、独立提交、E2E 可验。

## 两条根因(先看清)

1. **3D 形象 low 的根因不是没能力,是"做了没接"**:线上 `OfficeView→Workstation` 的小人是胶囊身+**空白球头、无脸无腿无脚**;而更精致的 `WorkstationPro/AvatarRig`(有分段肢体/表情位)+ `OfficeSceneRoot/PostFX/CameraRig` 整套**已存在于 kit/ 却未接入**,是组织性死代码。
2. **不如 Codex 好用的根因是缺桌面灵魂交互**:全仓无 `Cmd+K 命令面板`、无 `globalShortcut/setApplicationMenu`、无标准加速键(Cmd+N/F/,)。全靠鼠标点侧栏。

---

## 组 U1 · 桌面灵魂交互(影响最高,成本低-中)—— 最优先

### U1.1 全局快捷键 + 原生应用菜单 [impact high · cost low]
- `src/main/index.ts` 用 `Menu.buildFromTemplate + app.setApplicationMenu` 建标准菜单,accelerator 绑定发 IPC(`menu:new-session`/`menu:command-palette`/`menu:open-search`/`menu:settings`)
- `preload` 暴露 `onMenuCommand` 订阅;`store` 对应触发已有 action
- 补:Cmd+N 新建、Cmd+, 设置、Cmd+1..9 切会话、Cmd+F 聚焦侧栏搜索、Cmd+K 命令面板
- 验收:菜单栏出现、各快捷键生效

### U1.2 命令面板 Cmd+K [impact high · cost medium]
- 新建 `src/renderer/src/components/CommandPalette.tsx`:全局 Cmd/Ctrl+K 打开的 overlay
- 把 Composer 的 slashCommands + buildPluginSlashCommands 抽到 `src/renderer/src/commands.ts` 共享;聚合命令 + 会话列表(order+history)做模糊搜索,Enter 执行/切换
- App.tsx 挂全局 keydown
- 验收:Cmd+K 打开、输入过滤命令/会话、Enter 执行

### U1.3 NewSessionModal 键盘友好 [impact medium · cost low]
- `.modal` 容器 onKeyDown:Enter 提交 create()、Esc 关闭;主 CTA 用 form+onSubmit
- 验收:填完敲回车即建会话、Esc 关闭

---

## 组 U2 · 3D 形象提质(用户点名"太 low")

### U2.1 接入已有的精致小人,删死代码 [impact high · cost medium]
- 决策:让 `OfficeView` 改用 kit 里更完整的 `WorkstationPro/AvatarRig`(有分段肢体、可加脸),把线上 Workstation 的 MessagePackets/VendorMascot/task 标签/漫游迁移过去;或反向把精致件并入线上 Workstation。二选一并删掉另一套 dead 组件,避免两套发散。
- 验收:办公区小人有头/脸/躯干/四肢,不再是空白球头

### U2.2 小人细节与材质提质 [impact medium · cost medium]
- 几何:capsule capSegments 6→8、关节 sphere 12→20、脚 boxGeometry 换 RoundedBox;头加简单五官(眼/眉几何)
- 材质:皮肤用 meshPhysicalMaterial(微 clearcoat/sheen),身体哑光布料感,关节金属件吃反射
- 动画:activity 切换时关节 rotation 做 lerp(0.1) 消除硬跳(现在是直接 set 完整姿态)
- 验收:近景无明显棱角、切状态平滑过渡

### U2.3 场景光影提质 [impact medium · cost medium]
- 后处理加 N8AO/SSAO(桌腿/椅子/脚下自然暗部,AO 在 Bloom 前)
- 收敛 Bloom:dark 下 intensity 1.3→0.8、luminanceThreshold 0.25→0.45,发光件 emissiveIntensity 降,避免过曝糊成光斑
- 吉祥物提质:鲸鱼 body 用 LatheGeometry 流线剖面替代压扁球、鳍加段数、差异化动作(俯仰摆尾)
- 验收:画面从"到处发光"回到"克制点睛",立体感增强

---

## 组 U3 · 视觉精致度(低成本高回报,优先做前两条)

### U3.1 侧栏空状态收拢 [impact high · cost low]
- `Sidebar.tsx`:全空且无搜索词时,隐藏所有分区标题,只渲染一个居中空态(◆图标+"还没有会话"+"新建会话"CTA);分区标题仅在该区有内容时显示;归档默认折叠不渲染占位
- 验收:首屏不再堆 3-4 个空标题,像 Codex 单一引导

### U3.2 全站微交互过渡 [impact high · cost low]
- `styles.css`:给 .btn/.session-card/.project-chip/.settings-tab/.tool-header/.file-row/.ctx-menu-item 统一加 `transition: background/border-color/color .14s, transform .1s`;主按钮 :active scale(.98);末尾加 `@media (prefers-reduced-motion: reduce)` 兜底
- 验收:hover/点击有平滑过渡,不再瞬跳

### U3.3 聊天头工具栏图标化 [impact high · cost medium]
- `ChatView.tsx`:头部 10 个纯文字 btn-ghost(Worktree/Subagents/Files/Plugins/Routines/Memory/Browser/Terminal…)改为 28×28 图标按钮 + tooltip,低频项收进"⋯ 更多"下拉;model/permission select 单独左置
- 验收:头部不再拥挤换行,图标可扫读

### U3.4 设计 token 化 + 焦点环 + 骨架屏 [impact medium · cost medium]
- token:--fs-*/--radius-*/--shadow-*/--space-* 归并碎值(字号 17 种→5 档、圆角 11→4、语义色统一)
- 焦点环:.btn/.session-card/.file-row 等加 :focus-visible outline
- 骨架屏:FilePanel/PluginRegistry/Diff/StartSuggestions loading 用 shimmer 占位替代空白
- 验收:键盘 Tab 可见落点、加载不跳版

---

## 组 U4 · 性能/响应(流式顺滑 + 3D 省电)

### U4.1 流式 rAF 合帧 [impact high · cost low] —— 最该先做
- `store.ts`:text-delta/thinking-delta 不再每 chunk 一次 set;用模块级 buffer 累积,requestAnimationFrame 每帧最多 flush 一次到 store
- ChatView scroll 副作用随之每帧最多一次 reflow
- 验收:快速流式不掉帧(对标 Claude Desktop 丝滑)

### U4.2 3D 失焦暂停 + 降配 [impact high · cost medium]
- OfficeView `<Canvas>`:监听 visibilitychange/blur,隐藏时 frameloop='never';dpr 1.75→[1,1.35];shadow-mapSize 2048→1024;settings.office 加质量档(低档关 EffectComposer/Sparkles)
- 验收:办公区不可见时 CPU/GPU 占用降到近 0

### U4.3 列表虚拟化 [impact medium · cost medium]
- 引入 @tanstack/react-virtual 对 ChatView items + Sidebar 历史窗口化;配合 stickToBottom
- 验收:数百条消息/长历史滚动不卡、切会话首帧快

---

## 组 U5 · 关键能力补齐(桌面级)

- **U5.1 会话全文搜索** [high·medium]:主进程 transcriptSearch.ts 搜消息正文/代码,IPC 暴露,侧栏搜索结果扩展为"会话命中+片段高亮"直达锚点
- **U5.2 @统一唤起** [medium·medium]:Composer getMention 支持 @file/@agent/@mem/@sess 前缀分流,先加 @mem/@agent(复用现成数据)
- **U5.3 会话标签栏** [medium·medium]:主区顶部 Tabs(基于 order[]),切换不销毁其它会话状态(WorkbenchRoot 去掉 key={activeId} 重挂)
- **U5.4 应用内通知中心** [medium·low]:store 加 notifications;routine 触发/会话完成/预算触顶推入;标题栏铃铛开合
- **U5.5 键盘全操作** [medium·low]:结合 U1.1 菜单,App.tsx 集中注册 Cmd+1..9/Ctrl+Tab/Cmd+B/Cmd+/

---

## 执行顺序(建议)

1. **先 U1.1 + U1.2 + U4.1 + U3.1 + U3.2**(全是 high impact,大多 low cost)—— 一轮下来"顺手度 + 流式顺滑 + 首屏干净"立竿见影,直击"不如 Codex 好用"
2. **再 U2.1 + U2.2 + U2.3**(3D 提质,直击"太 low")
3. **再 U3.3/U4.2/U5.1**(工具栏、3D 省电、全文搜索)
4. **最后 U3.4/U4.3/U5.2-5.5**(打磨与补齐)

每组独立提交,规划方逐条 E2E check。所有改动不搬竞品代码,纯自实现。

---

## 给 Codex 的任务卡(第一轮,按此顺序做)

> 前置:T11/T12 已完成并经规划方 E2E check 通过(预算跨引擎闸门 + 检查点锚点持久化)。
> 通用约束:每张卡 typecheck+build 通过、六环链路齐、独立提交、提交信息写"做了什么+怎么验证"。不搬竞品代码。

### 卡 A(U1.1)· 全局快捷键 + 原生菜单 [先做,cost low]
- `src/main/index.ts`:`Menu.buildFromTemplate` + `app.setApplicationMenu`;各项 accelerator 的 click 里 `win.webContents.send('menu:<cmd>')`
- `src/preload/index.ts`:暴露 `onMenuCommand(cb)`(参照现有 onBrowserEvent/onTerminalEvent 订阅模式)
- `src/renderer/src/App.tsx`:订阅 onMenuCommand,分发到 store 已有 action;并加全局 keydown 兜底(渲染层内 Cmd+N/Cmd+,/Cmd+K/Cmd+1..9/Cmd+F)
- 命令:new-session→setShowNewSession、settings→setShowSettings、command-palette→(卡B)、切会话→selectSession(order[n-1])、search→聚焦 .sidebar-search
- 验收:菜单栏出现;Cmd+N 弹新建、Cmd+, 开设置、Cmd+1/2 切会话、Cmd+F 聚焦搜索

### 卡 B(U1.2)· 命令面板 Cmd+K [cost medium]
- 抽 `src/renderer/src/commands.ts`:把 Composer 的内置斜杠命令 + buildPluginSlashCommands 提取为共享 registry
- 新建 `src/renderer/src/components/CommandPalette.tsx`:overlay,输入框 + 模糊搜索(命令 + 会话 order/history),↑↓ 选、Enter 执行、Esc 关
- App.tsx:Cmd+K 开合(与卡A的 menu:command-palette 复用)
- 验收:Cmd+K 打开→输"设置"能过滤到→Enter 打开设置;输会话标题→Enter 切过去

### 卡 C(U4.1)· 流式 rAF 合帧 [cost low,体感最直接]
- `src/renderer/src/store.ts`:text-delta/thinking-delta 不再每 chunk `set`;模块级 buffer(Map<sessionId,{text,thinking}>)累积,requestAnimationFrame 每帧 flush 一次;会话结束/turn-result 时强制 flush 清 buffer
- 验收:长回答快速流式时不掉帧、CPU 占用降;文本不丢字、不错序

### 卡 D(U3.1)· 侧栏空态收拢 [cost low]
- `src/renderer/src/components/Sidebar.tsx`:全空且无搜索词 → 隐藏所有分区标题,只渲染居中空态(◆+"还没有会话"+新建 CTA);分区标题移入 `length>0` 分支;归档空则不渲染
- `styles.css`:加 `.sidebar-empty-hero`
- 验收:首启侧栏只见一个引导,不再堆"进行中/最近/归档"空标题

### 卡 E(U3.2)· 全站微交互过渡 [cost low]
- `styles.css`:给 .btn/.session-card/.project-chip/.settings-tab/.tool-header/.file-row/.ctx-menu-item/.sidebar-group-head 加 `transition: background .14s, border-color .14s, color .14s, transform .1s`;主按钮 :active `transform:scale(.98)`;末尾加 `@media (prefers-reduced-motion: reduce){*{transition:none!important;animation:none!important}}`
- 验收:hover/点击平滑,无瞬跳;系统开"减少动态效果"时动画关闭

**第一轮 = 卡 A→B→C→D→E**(全高影响、多数低成本,一轮直击"不如 Codex 好用")。完成交规划方 E2E check,再发第二轮(U2 三维提质 + U3.3/U4.2/U5)。

