# CaoGen V2 设计:深度用户丝滑迁移计划

> 2026-07-04 · 目标升级:第一纪元(M0–M7)证明了"拥有"三支柱;第二纪元(M8–M15)要求**好用**——让 Codex CLI / Claude Code 的深度用户迁移后第一天不丢肌肉记忆、第一周工作流不倒退、第一个月离不开。

## 0. 设计总纲

### 0.1 迁移漏斗(排期的依据)

深度用户换工具的流失点是分层的,对应三个承诺:

| 阶段 | 用户在想什么 | 我们必须给出 | 对应能力域 |
|---|---|---|---|
| 第一天 | "我的手感还在吗?" | 肌肉记忆 1:1:`@` 文件、`/` 命令、图片粘贴、`Esc Esc` 回溯、快捷键 | D1 高频交互 · D2 检查点 |
| 第一周 | "它会搞坏我的仓库吗?" | 工程可信:worktree 隔离、重做的 diff、终端、Hooks、后台任务 | D3 Worktree · D4 工作台 · D8 Hooks |
| 第一月 | "它比 CLI 多给我什么?" | 编排与自动化:真子代理、浏览器批注、记忆/主动建议、云端 Routines、插件与产物 | D5 子代理 · D6 浏览器 · D7 记忆自动化 · D9 生态 |
| 全程 | "看着舒服吗?" | 写实 3D:信息密度与愉悦感,而非玩具 | D10 写实渲染 |

### 0.2 关键技术事实(实测 sdk.d.ts @0.3.199)

设计的最大变量是"哪些从零造、哪些接线即得"。实测本仓 SDK 已原生提供:

- **检查点**:`enableFileCheckpointing` 选项(写文件前自动备份)+ `query.rewindFiles(userMessageId)`;会话恢复支持 `resumeSessionAt`(回到任意消息点)与 `forkSession`(分叉)。→ D2 的核心是 UI,不是存储引擎。
- **斜杠命令**:`query.supportedCommands()` 返回全量 SlashCommand,且有 mid-session 推送(动态发现 skills 后更新)。→ D1 的 `/` 面板是接线。
- **子代理**:`options.agents`(AgentDefinition 注入)、`supportedAgents()`、Hook 事件 `SubagentStart/SubagentStop/TaskCreated/TaskCompleted`。→ D5 有真实事件流可驱动 3D。
- **Hooks**:30 种 HookEvent,含 `PreToolUse/PostToolUse/PermissionRequest/FileChanged/WorktreeCreate/WorktreeRemove/TeammateIdle`。→ D8 是配置面 + UI。
- **后台任务**:`query.backgroundTasks()` / `stopTask(taskId)`。
- **多模态**:`SDKUserMessage.content` 支持 image block。→ D1 图片输入是 UI + 文件编码。
- **上下文治理**:`getContextUsage()`、compact_boundary 消息。
- **没有的**:workspace diff API(diff 查看器基于 git 自研)、内置浏览器(Electron webview 自研)、云端执行(自研或对接托管)。

### 0.3 架构不变量(所有新功能必须遵守)

1. **事件溯源不破坏**:一切新交互都是新的 `AgentEvent` kind,主进程分配 seq,转录可回放。UI 状态 = reduce(events)。
2. **Engine 接口不旁路**:新能力若依赖 SDK 专有 API(checkpoint/hooks/agents),在 `Engine` 接口上以 capability 声明(`engine.capabilities.checkpoint?: boolean`),UI 按能力降级,为 M6 的 Codex/Gemini 适配器留路。
3. **安全边界不放松**:浏览器面板、终端、Hooks 脚本都是新攻击面;一律主进程执行 + 渲染进程只见视图数据;Hooks 脚本需用户显式启用。
4. **3D 是状态的投影**:任何"动画"必须由真实事件驱动(D5 子代理飞包 = 真 SubagentStart 事件),禁止装饰性假动画,这是可观测性产品的诚信底线。

---

## D1 · 高频交互:@文件 / 图片 / 斜杠命令(M8)

**体验目标**:Claude Code 用户在 CaoGen 输入框里闭着眼打 `@src/ma` + Tab、`Cmd+V` 贴截图、`/compact`,行为与 CLI 完全一致,且比终端更好:有预览、有历史、全键盘可达。

**竞品基线**:Codex/Claude Code 的 `@` 补全是路径前缀 + 模糊匹配;图片经剪贴板/路径;`/` 命令即时过滤。终端的痛:补全无预览、图片要先存文件、命令记不全。

**方案**:
- **@文件引用**:Composer 监听 `@` 触发补全浮层。数据源:主进程 `files:search` IPC(cwd 下 fd/ripgrep 风格模糊搜索,尊重 .gitignore,缓存 5s);上下键选择、Tab 确认、Esc 关闭。选中后输入框内渲染为 token 胶囊;发送时展开为相对路径文本(与 CLI 语义一致),并在 user-message 事件上附 `refs: string[]` 供 UI 高亮与事后追溯。二进制文件禁选,>1MB 文件提示"将只引用路径"。
- **图片输入**:粘贴/拖拽 → 主进程存 `userData/attachments/<hash>.<ext>` → Composer 显示缩略图胶囊(可删)。发送时组装 content blocks:`[{type:'image', source:{base64}}, {type:'text'}]` 走现有 `pushUserMessage` 的消息体(SDK 原生支持)。`user-message` 事件加 `images?: {path, thumb}[]`,聊天流与转录可回显。上限 5 张/条,单张 ≤5MB(超限压缩)。
- **斜杠命令**:输入行首 `/` 唤起命令面板。数据源三合一:`supportedCommands()`(含 skills,监听 mid-session 推送替换缓存)+ CaoGen 内置命令(`/rewind`、`/worktree`、`/routine`、`/theme`)+ 最近使用置顶。带参命令(如 `/model opus`)在面板内联填参。
- **全局快捷键**:`Cmd+K` 命令面板(聚合所有动作)、`Cmd+T` 新会话、`Cmd+1..9` 切会话、`Esc` 中断当前轮(单击,与 CLI 一致)。

**好用细节**:补全浮层显示文件 mtime 与 git 状态点;`@` 后继续输入不匹配时自动降级为普通文本;图片粘贴失败(格式不支持)给 toast 而非静默。

**验收**:不碰鼠标完成"@引用两个文件 + 贴一张截图 + /compact + 发送 + Esc 中断";命令列表与 CLI `/help` 输出一致。

## D2 · 检查点回溯:Esc Esc / /rewind(M8)

**体验目标**:任何一次"agent 把代码改坏了"都能 10 秒内回到改坏之前——代码、对话、或两者,回退前先看清将丢弃什么。

**方案**(SDK 接线 + UI):
- 所有会话默认 `enableFileCheckpointing: true`。SDK 在每次文件写入前自动备份,颗粒度绑定 user message id。
- **检查点时间线**:每个 user-message 事件即一个检查点锚。ChatView 侧新增可折叠时间线(或消息 hover 出现"⏪ 回到此前"),显示每个锚点的:消息摘要、其后改动的文件数(从 tool-result 的 Edit/Write 统计)、成本。
- **`Esc Esc`** 唤起回退面板(与 CLI 肌肉记忆一致),`/rewind` 同效:选择锚点 → 选择范围:
  - **仅代码**:`query.rewindFiles(msgId)`,对话继续(适合"思路对但改砸了");
  - **仅对话**:`forkSession` + `resumeSessionAt(msgId)` 重建引擎(现有故障切换的 resume 重建路径复用),文件保留(适合"改对了但话题跑偏");
  - **两者**:先 rewindFiles 再 resumeSessionAt。
- 回退前预览:调用 rewindFiles 的 dry-run(SDK 返回 RewindFilesResult 文件清单;若无 dry-run 则用 git diff 快照对比)展示"将恢复 N 个文件 / 将丢弃 M 条消息"。
- 新 AgentEvent:`checkpoint-restore {anchorMsgId, scope, files}` 入转录,聊天流插入"⏪ 已回退到 …"标注——回退本身也可追溯。
- **Engine capability**:`checkpoint: true` 仅 ClaudeEngine;其他引擎 UI 隐藏该功能。

**好用细节**:回退面板默认选中"上一个检查点"(最常见场景零思考);回退后 3D 工位小人播放"倒带"动画(事件驱动);连续回退可再"前进"(fork 链不删除,保留 24h)。

**验收**:让 agent 改坏 3 个文件后,Esc Esc → 选"仅代码" → 文件内容逐字节恢复,对话继续可用;转录重放含回退标注。

## D3 · Git worktree 隔离(M9)

**体验目标**:并行 4 个 agent 改同一个仓库,主工作区永远干净;每个 agent 的成果可一键合并或整体丢弃。这是"敢并行"的前提,也是 3D 办公区从"好看"变"必需"的一步。

**方案**(自研,git 原语):
- 新建会话勾选"隔离工作区"(检测到 cwd 是 git 仓库时默认勾选):主进程 `git worktree add <userData>/worktrees/<sessionId> -b caogen/<sessionId> HEAD`,会话 cwd 指向 worktree,`SessionMeta` 记录 `{repoRoot, worktreePath, branch, isolated: true}`。
- **状态可见**:ChatView 头部显示分支徽章;3D 工位地台颜色按 worktree 分组;侧栏会话项标 ⎇。
- **合并路径**(会话内 `/worktree` 或头部按钮):
  - `查看改动`:worktree vs 基点分支的 diff(接 D4 diff 查看器);
  - `合并回主分支`:squash merge(默认,信息 = 会话标题)或 rebase 可选;冲突时打开 D4 三栏解决器;
  - `丢弃`:确认后 `git worktree remove --force` + 删分支;
  - `导出 patch`:`git format-patch` 到用户选定目录。
- **生命周期**:关闭会话不自动删 worktree(防误删成果),侧栏"最近会话"标注遗留 worktree,7 天未动提示清理;`worktrees:list` IPC 供设置页统一管理。
- 与 D2 的关系:worktree 是"空间隔离"(agent 间),checkpoint 是"时间隔离"(同 agent 内),正交叠加。
- SDK 的 `WorktreeCreate/WorktreeRemove` hook 事件桥接为 AgentEvent,3D 播放"搬进新工位"动画。

**验收**:同仓库开 3 个隔离会话并行改同一文件,主工作区 `git status` 始终干净;其一合并、其一导出 patch、其一丢弃,互不影响。

## D4 · 工作台:分屏 / 终端 / 编辑器 / Diff / 产物预览(M10)

**体验目标**:一个前端 bug 从"agent 改码 → 跑 dev server → 浏览器复现 → diff 审查 → 合并"全程不离开 CaoGen。CLI 用户失去的(伴随终端),桌面端必须原生给回来。

**方案**:
- **布局引擎**:自研轻量 dock(避免引重库):主区可垂直/水平二分,面板(聊天/3D/终端/编辑器/Diff/浏览器/预览)可拖到任意槽位;布局存 settings,按会话记忆。第一版限制:最多 2×2,杜绝 IDE 化失控。
- **内置终端**:xterm.js + node-pty(主进程 spawn,cwd = 会话 worktree)。每会话至多 2 个终端;`终端输出 → 发给 Agent` 按钮把最近 N 行作为引用文本入 Composer——打通"人工验证 → 喂回 agent"环路。SDK `backgroundTasks()` 列出 agent 自己起的后台任务(dev server 等),可升格为终端面板旁观其输出、`stopTask` 终止。
- **文件编辑器**:CodeMirror 6(比 Monaco 轻 ~10×,够用):打开 worktree 文件、语法高亮、保存。定位是"顺手改一行",不做 LSP;agent 正在编辑的文件只读锁 + 顶部提示。
- **重做 Diff 查看器**:数据源 `git diff`(worktree vs 基点 / 未暂存),按文件树分组;hunk 级"保留/丢弃"(丢弃 = `git checkout -p` 语义,主进程执行);行内高亮沿用现有 DiffView 样式语言。Edit/Write 工具卡的"查看 diff"跳转到此面板并定位到 hunk。
- **产物预览**:统一 `preview:open {path}` 入口(工具卡/文件树/编辑器右键):HTML→沙箱 webview(禁 Node、禁外网可选);PDF→pdf.js;CSV/XLSX→轻量表格(虚拟滚动);PPTX→每页缩略图(主进程转图);Markdown→现有渲染器。预览面板带"批注后发给 Agent"(截图 + 文字,复用 D6 的批注数据结构)。

**验收**:改一个 React 组件的任务全程不切出 CaoGen:agent 改码 → 终端跑 dev → 浏览器面板验收 → diff 逐 hunk 审查丢弃一处 → 合并 worktree。

## D5 · 真子代理编排(M11)

**体验目标**:"重构这个模块,前端后端测试并行"——主 agent 真的把活拆给 3 个子 agent 同时跑,3D 办公区呈现的是**真实任务流**;现有"协作消息包"动画退役,换成真编排的可视化。

**方案**(SDK 编排原语 + CaoGen 资源管理):
- **两层编排**:
  1. **SDK 内建层**(单引擎内):注入 `options.agents`(AgentDefinition:frontend-dev/backend-dev/test-writer 等预设 + 用户自定义存 settings),主 agent 经 Task 工具派活。桥接 `SubagentStart/SubagentStop/TaskCreated/TaskCompleted` hooks 为新 AgentEvent `subagent-update {taskId, agentName, phase, summary}`。
  2. **CaoGen 会话层**(跨会话):`/dispatch` 或主 agent 经自定义 MCP 工具 `caogen_spawn_session` 请求开新会话(独立 worktree + 指定 provider/model)——把现有多会话并行升格为可编程资源。子会话 turn-result 回传父会话作为 user message(带来源标注)。
- **编排面板**:会话内新增"任务图"标签:节点 = 子任务(名称/负责 agent/状态/成本),边 = 依赖;数据全部来自事件流,可回放。
- **3D 呈现**:子代理 = 主工位旁生成的小工位(SubagentStart 事件驱动入职动画),完成后消息包飞回主工位(TaskCompleted 驱动)+ 小工位收起。**删除现有装饰性 MessagePackets 随机动画**,改为事件驱动——诚信底线。
- **资源闸门**:并发子代理数上限(默认 4)、单任务预算上限(继承 M4 健康度/预算信号),超限时主 agent 收到工具错误而非静默排队。

**验收**:一个"前端 + 后端 + 测试"任务,任务图显示 3 节点并行→汇合;3D 中 3 个子工位真实起落;关闭其一子会话,主 agent 收到失败回传并能重派。

## D6 · 内置浏览器 + 网页批注(M11)

**体验目标**:"这个按钮在移动端溢出了"——用户直接在页面上圈出按钮打字,agent 收到截图 + DOM 线索 + 控制台错误,改完自己复验。设计/前端用户的杀手锏。

**方案**:
- **浏览器面板**:Electron `WebContentsView`(webview 已废弃):多标签、地址栏、移动/桌面视口切换、每会话独立 session 分区(登录态隔离);检测到终端/后台任务里 dev server 的 localhost URL 时提示一键打开。
- **批注模式**:工具条开启后注入 preload 脚本:hover 高亮 DOM、点击锁定元素、框选区域截图、文字/箭头标注。产出结构化 `BrowserAnnotation`:`{url, title, selector, boundingBox, screenshotPath, note, consoleErrors[], viewport}`——主进程采集 console 消息环形缓冲(最近 200 条)。
- **喂给 agent**:批注作为图片 + 结构化文本(selector、console 摘要)组装进 user message(复用 D1 图片通道);聊天流渲染批注卡片(缩略图 + 元素路径)。
- **Agent 驱动浏览**(权限门槛后):暴露 MCP 工具 `browser_navigate/browser_screenshot/browser_read_console`,走现有 canUseTool 审批流——形成"看见 → 修 → 复验"闭环。第一版不给点击/填表(注入风险),只读观测。

**验收**:在浏览器面板圈出错位按钮 + 备注,agent 定位到组件文件并修复,然后自行截图复验,全程审批可见。

## D7 · 记忆 + 自动化 + 主动建议 + Routines(M12)

**体验目标**:CaoGen 记得"这个仓库用 pnpm、测试要 --runInBand";周一早上打开,它说"上周五 flaky 测试修到一半,继续?";每晚自动跑依赖审计,笔记本合盖也不断。

**方案**(分四级,由稳到进取):
1. **项目记忆**:`userData/memory/<projectHash>.md`,结构化条目(构建命令/坑/约定)。写入时机:turn-result 后启发式抽取(工具失败后成功的命令、用户纠正)存草稿区,**用户确认后生效**(避免记错毒化);会话启动经 systemPrompt append 注入(persona 通道复用)。设置页可查看/编辑/删除。
2. **主动建议**:新会话创建时后台扫描:未完成 todo(转录尾部)、失败的上轮、遗留 worktree、README 里的 TODO——生成"开工建议"卡片(可一键采纳为首条消息)。纯本地启发式,不额外花 token。
3. **本地 Routines**:`{name, prompt, schedule(cron), project, provider/model, permissionMode(默认 plan), budget}`;主进程调度器到点自动开会话执行,结果进"Routine 收件箱"(侧栏新区,未读徽标);防休眠用 `powerSaveBlocker`(仅执行中);完成/失败发系统通知(Notification API,点击跳会话)。
4. **云端 Routines**(笔记本关机也跑):自研服务端过重,第一版做**桥接架构**:Routine 可标记"云端",导出为 GitHub Actions workflow(schedule cron + 在 runner 上跑 headless agent,凭据走仓库 secrets),结果以 PR/issue 回流,CaoGen 拉取展示。诚实标注"经 GitHub Actions"而非假装自有云。v2 再评估自建。

**验收**:记忆:纠正 agent 一次用 pnpm,下个会话它直接用 pnpm;Routine:设一个 5 分钟后的本地任务,合盖前收到通知、收件箱有结果;云端:导出的 workflow 在 GitHub 上按时跑通并回流 PR 链接。

## D8 · Hooks / 后台任务深度集成(M12,随 D5/D7 落)

**体验目标**:团队规范自动执行(每次 Edit 后跑 lint、危险命令二次确认),Claude Code 用户的 hooks 配置搬过来就能用,且有 UI 不用手写 JSON。

**方案**:
- **兼容层**:读取项目 `.claude/settings.json` 的 hooks 配置直接生效(SDK 原生消化),CaoGen 不另造格式。
- **Hooks 面板**(设置页):列出 30 种事件,常用五种(PreToolUse/PostToolUse/PermissionRequest/SessionStart/Stop)给表单化配置(matcher + 命令),高级模式直接编 JSON;来源标注(用户级/项目级)。
- **可观测**:hook 触发/阻断以浅色系统事件行进聊天流(可折叠),被 hook 拒绝的工具调用显示拒因——调试 hooks 不再靠猜。
- **后台任务面板**:`backgroundTasks()` 轮询 + Hook 事件驱动,侧栏"后台任务"区:名称/所属会话/运行时长/CPU 概况,可停止、可升格为终端面板(D4)。

**验收**:配置"每次 Edit 后自动 prettier"经表单完成并生效;agent 起的 dev server 在面板可见、可停、可看输出。

## D9 · 插件生态 + 完成通知(M13 收束)

**体验目标**:Claude Code 的 skills/MCP/子代理生态**零成本继承**(90+ 能力不是自建 90 个,是打通生态);长任务不用盯——完成会叫你。

**方案**:
- **生态继承**:现有 `~/.claude` 继承已工作;新增**插件浏览器**:列出已装 skills/MCP servers/agents(来源、版本、启停),支持从 git URL / 本地目录安装到 `~/.claude`;每会话可禁用特定插件(注入时过滤)。
- **MCP 面板**:mcpServers 连接状态、工具清单、调用统计(从 tool-start 事件聚合);连不上给诊断(命令是否存在/端口占用)。
- **完成通知**:统一通知策略(设置页):轮次完成/需要审批/出错/Routine 完成 × 系统通知/声音/仅徽标;焦点在当前会话时抑制;通知点击深链到对应会话。配套 Dock/任务栏徽标计数(待审批数)。
- **防休眠**:任何会话 running 或 Routine 执行中 → `powerSaveBlocker.start('prevent-app-suspension')`,空闲即释放,状态栏显示 ☕ 图标(可点击临时关闭)。

**验收**:装一个社区 MCP server 经 UI 完成且会话内可调用;后台跑 10 分钟任务,合盖不断,完成时通知点击直达。

## D10 · 写实 3D 渲染(M8→M15 持续)

**体验目标**:办公区从"可爱示意"升级为"愿意一直开着的第二屏"——写实材质光影下,状态信息密度反而更高:一眼谁在跑、谁卡住、谁烧钱。

**方案**(渐进,不推倒重来):
- **M8 · 材质光影**(纯升级现有程序化场景):PBR 材质(metalness/roughness 贴图)、环境贴图(drei Environment,室内 HDRI)、SoftShadows、SSAO(N≤6 工位时开)、地板反射(MeshReflectorMaterial)。保持几何体程序化——低成本先把"质感"提上来。
- **M9 · 资产升级**:引入轻量 GLTF 资产(桌椅/显示器/绿植,CC0 库如 Poly Pizza,单件 ≤50KB,Draco 压缩)替换盒子几何;小人升级为带骨骼的低模角色(mixamo 动画重定向:打字/举手/瘫倒/踱步),动画状态机对接现有 Activity。
- **M11 · 空间叙事**(随 D5):子代理小工位、会议桌(任务图的 3D 对应:派活时主小人走到白板前)、档案柜(产物:预览文件从柜中飞出)。
- **性能红线**(不可妥协):视图未激活 ≤10fps(现有 frameloop 控制扩展)、工位 >9 个自动降级(关 SSAO/反射)、低配模式一键回程序化几何;WebGL 上下文全局单例;显存预算 ≤300MB。
- **可读性红线**:写实不牺牲状态语义——状态色光环/头顶图标/悬浮标签三通道保留;色弱模式(状态加形状编码)。

**验收**:新老场景 A/B 截图对比"质感"明显提升;9 工位满载 M1 级 Mac 上激活视图 ≥50fps;3 秒读出全部状态的原验收继续成立。

---

## 排期与依赖(与 ROADMAP.md M8–M15 对齐)

| 里程碑 | 能力域 | 关键依赖与理由 |
|---|---|---|
| **M8 肌肉记忆层** | D1 高频交互 + D9 的通知/防休眠 + D10.1 材质光影 | SDK 已备,纯接线+UI,最快兑现"第一天承诺" |
| **M9 检查点 + Worktree** | D2 检查点回溯 + D3 Worktree 隔离 + D10.2 资产升级 | D2 复用故障切换的 resume 重建路径;D3 为 D5 子代理隔离打地基 |
| **M10 工作台化** | D4 分屏/终端/编辑器/Diff/预览 | xterm/node-pty/CodeMirror/pdf.js 选型引入 |
| **M11 浏览器批注** | D6 内置浏览器 + 批注 | 依赖 D1 图片通道、D4 面板系统 |
| **M12 真子代理 + Hooks** | D5 子代理编排 + D8 Hooks/后台任务 + D10.3 空间叙事 | D5 依赖 D3(子代理 worktree);3D 假动画退役 |
| **M13 记忆 + 本地 Routines** | D7 的记忆/主动建议/本地 Routines | 纯本地,不依赖云 |
| **M14 云端 Routines** | D7 的云端桥接(GitHub Actions 路线先行) | 自建 Runner 视 M13 反馈评估 |
| **M15 插件生态** | D9 插件浏览器/MCP 面板/90+ 覆盖 | 生态继承已通,重点是治理与可发现性 |

**迁移成功标准(第二纪元验收)**:
1. Claude Code 深度用户实测:前 30 分钟内完成 @文件/贴图//命令/回退四个动作,零文档求助;
2. 4 agent 并行改同仓库一天,主工作区零污染,合并全部走 UI;
3. 一个真实前端任务全程不离开 CaoGen(码/跑/看/审/并);
4. 主 agent 真实派活 3 子代理,3D 任务流与任务图一致可回放;
5. 关盖过夜,Routine 按时执行且通知到达;
6. `.claude` 生态(skills/MCP/hooks)零改动继承率 100%。
