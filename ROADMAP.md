# CaoGen 目标与路线图

> 制定日期:2026-07-03 · 状态:2026-07-04 加速轮 —— M0–M5、M4.1 已完成;M6 架构落地,OpenAI Responses API 原生引擎第一版已接入,Codex/Gemini 适配器待实现;M7 打包链路完成(自动更新待补);M8.1 @文件、M8.2 检查点回溯核心+回溯面板、斜杠命令面板、图片粘贴/拖拽、通知/防休眠已落地;M9 worktree 隔离后端+管理面板+patch 导出/丢弃已落地,合并审查 helper 已落地;D11 迁移向导已落地;M10 Diff/Worktree/Terminal/File Editor/Preview 工作台第一版已落地,产物预览可发给 Agent;M11 WebContentsView 浏览器面板 + 选区批注保存 + 批注发给 Agent 第一版已接入;M12 真实 child session 派发后端/IPC/preload/store/面板第一版已落地,一次最多 33 个子 Agent,默认独立 worktree;M13 项目记忆、Routine 存储、开工建议 helper 已落地;M15 插件扫描 helper 已落地;迁移攻坚 M8–M15 设计定稿于 DESIGN-V2.md

## 终极产品目标

**让其他所有 Agent 的深度用户丝滑转用 CaoGen。以"世界第一 / 中国首创"作为产品愿景与验收方向,而非当前事实宣称。**

三个词各自落成可验收承诺:

**"所有 Agent"** —— 不只 Codex/Claude Code。Gemini CLI、Cursor、Windsurf、Cline/Roo、Aider、Copilot、通义灵码、Trae 等每类深度用户都有自己的肌肉记忆、配置资产与信任锚点;CaoGen 承诺**资产一键导入(rules/MCP/技能)、高频动作 1:1、核心工作流不倒退**(逐 Agent 依赖清单见 DESIGN-V2 迁移矩阵,D11 迁移向导负责执行)。

**"世界第一"** —— 作为产品目标,落到四项可验证承诺:迁移成本最低(任何主流 Agent 深度用户 30 分钟上手、资产零丢失)、并行工程可信度最高(worktree 隔离 + 检查点回溯 + 逐块 diff + 权限治理)、桌面可观测性最强(每轮模型/理由/成本/卡点,从聊天流到 3D 全透明)、长期自动化闭环最完整(记忆 + Routines + 子代理编排)。

**"中国首创"** —— 作为产品目标,把本土优势落成产品力:中文原生(zh 是母语不是翻译,en 完整)、国产模型一等公民(DeepSeek/Kimi/智谱 GLM 等官方 Anthropic 兼容端点内置直连预设,无须网关;能力表覆盖国产档位)、国内网络友好(镜像/更新通道可配,无强制境外依赖)、原创品类(写实 3D 办公区 + 多 Agent 编排可视化作为 CaoGen 要验证的交互范式,非海外产品复刻)。

## 北极星路径

做面向所有主流 Agent 深度用户的迁移终点:多模型、多 Agent、多工作区、多产物、多自动化都在一个可观测、可回退、可排期的桌面工作室里完成。

终极目标靠五根支柱建立代差:

1. **多厂商模型接入** — 不绑定单一厂商,Anthropic / OpenAI / Google / 国产模型皆可配置
2. **双模式模型调度** — 既可指定模型运行,也可由智能调度器自动为每个任务挑选最合适的模型
3. **写实 3D 办公区** — 并行 Agent 不再是列表,而是一间有空间感、材质感、状态动画和成本气泡的虚拟办公室:每个会话一个工位,一眼读出谁在写码、谁在等审批、谁在卡住
4. **迁移级深度工作流** — `@` 文件、图片输入、斜杠命令、检查点回溯、Git worktree 隔离、Hooks、后台任务、内置终端/编辑器/预览,让 Codex/Claude 深度用户不损失肌肉记忆
5. **长期自主执行** — 记忆、主动建议、本地/云端 Routines、90+ 插件生态和产物预览,让 Agent 能跨天续做长任务,不再只是一轮问答工具

### 竞争定位

| 维度 | Codex / Claude Code / Gemini CLI / Marvis 等 | CaoGen |
|---|---|---|
| 厂商 | 各自绑定自家模型 | 多厂商配置 + 跨厂商故障切换 |
| 模型选择 | 手动指定为主 | 手动指定 + 智能自动调度 |
| 并行会话 | 终端多开,无统一视图 | 侧栏 + 写实 3D 办公区统一管理 |
| 工作区隔离 | 用户自己开分支/目录 | 每 Agent 默认 Git worktree 隔离 |
| 高频交互 | `@` / `/` / 图片 / 回退成熟 | 1:1 复刻并接入桌面工作台 |
| 子代理 | 部分 CLI 支持 | 主 Agent 派活 + 子 Agent worktree + 3D 协作状态 |
| 产物处理 | 依赖外部应用 | HTML/PDF/表格/PPT 内嵌预览与批注 |
| 长任务 | 主要依赖本机进程 | 本地 Routines + 云端定时执行 |
| 可观测性 | 文本日志 | 工具卡片 / Diff 视图 / 成本仪表盘 / 3D 状态动画 / 调度理由 |
| 权限治理 | 各自为政 | 逐条审批 + 四种模式,跨会话统一 |

### 成功标准(可验收)

- ✅ 核心开发链路已可在 CaoGen 内完成(M0/M1/M2:全链路 + 会话恢复)
- 🚧 打包链路已完成;自动更新和真实分发签名仍需补齐(M7:.app + 自动更新)
- ✅ 一个界面同时驾驭 ≥4 个并行 Agent 而不迷失(多会话架构 + 侧栏 + 写实 3D 办公区双视图)
- ✅ 任一厂商挂掉(余额/限流/模型下线)时自动切换,任务不中断(M4.1 故障切换)
- ✅ 打开 3D 办公区,3 秒内读出所有会话的状态与开销(M5:状态动画 + 悬浮标签 + 品牌色)
- 🚧 Codex/Claude 深度用户迁移首日可完成常用动作:`@` 文件、`/` 命令、图片粘贴/拖拽输入、检查点代码回溯、CaoGen 对话转录回溯、Diff 审查、终端、文件编辑器、产物预览已可用;图片标注/OCR、底层 SDK 上下文级对话回溯仍待补齐
- 🚧 每个 Agent 默认独立 worktree 后端与管理面板已接入;patch 导出/丢弃可用,直接合并/PR 路径仍需补齐
- 🚧 主 Agent 可通过 Subagent 面板真实派发 ≥3 个子 Agent,后端已验证 33 个上限、child session 关系、prompt 投递和默认独立 worktree;SDK `supportedAgents()` / `agents` 桥接、任务图、预算/权限闸门、回传归档、合并队列和 3D 编排视图仍需补齐
- ⬜ 笔记本关闭后,云端 Routines 仍能按计划触发任务,重新打开桌面端可接续上下文、产物和日志
- 🚧 插件/预览生态覆盖 90+ 常用能力仍未完成;插件 registry 扫描 helper 与 HTML/Markdown/Text/CSV/JSON/Image/PDF 预览识别/UI 已落地,PDF 深度渲染/表格/PPT/预览批注待接
- ⬜ 完成跨竞品迁移验收:Codex、Claude Code、Gemini CLI、Cursor、Cline、Aider 等各类深度用户用 CaoGen 完成一天真实工作流,关键动作无需回退原工具
- 🚧 迁移向导已支持扫描/导入多 Agent rules/MCP;新建会话自动提示和更完整资产映射待补(D11)
- ⬜ 国产模型直连:DeepSeek/Kimi/智谱 GLM 预设开箱即用,调度器能力表覆盖国产模型档位

### 当前进展 vs 终极目标差距

当前进展已经从"能聊天的桌面壳"推进到"多会话工程工作台底座",但离终极目标还不是一个量级的收尾工作,而是若干条必须闭环的产品链路:

- **Worktree 隔离**:自动创建、管理面板、patch 导出/丢弃与合并审查 helper 已落地;还缺直接合并/PR、冲突三栏审查、逐 hunk 接受/拒绝和合并后 checkpoint 验收。
- **内置浏览器批注**:WebContentsView 面板、导航、选区批注保存、页面高亮和批注发给 Agent 已落地;还缺 DOM 圈选、截图批注、控制台/网络摘要和 Agent 只读复验工具。
- **记忆/自动化/主动建议**:confirmed/draft memory store、Routine JSON store 与本地开工建议 helper 已落地;还缺确认 UI、本地调度器、Routine 收件箱、跨天续做和来源可追溯治理。
- **插件生态 + 产物预览**:registry 扫描 helper、HTML/Markdown/Text/CSV/JSON/Image/PDF 预览识别/UI、完成通知与 powerSaveBlocker 已落地;还缺插件浏览器、MCP 状态、安装/权限/版本治理、90+ 能力覆盖、PDF 深渲染、表格/PPT 和预览批注。
- **高频输入**:`@` 文件、斜杠命令、Composer 图片粘贴/拖拽和 SDK base64 image block 已落地;还缺多图标注/OCR、引用快照回显和插件/Routine 命令参数化。
- **Checkpoint 回溯**:rewindFiles 核心、Esc Esc 入口、代码/对话/两者面板和 CaoGen transcript 原子截断已落地;还缺底层 Claude SDK 上下文级重建、回退前 diff 解释和跨 worktree checkpoint 索引。
- **子代理编排**:真实 `dispatchSubagents` 已能从父会话创建 child sessions、记录 parent/orchestration/task 元数据、默认隔离 worktree、立即投递 prompt,渲染端已有 Subagent 面板和 `/subagents` 入口;还缺 SDK `supportedAgents()` / `agents` 桥接、TaskGraph、事件回传总线、预算/权限闸门、合并队列和由真实 child session 驱动的 3D 编排视图。
- **云端 Routines**:仍是规划,需要 Cloud Scheduler/Runner、加密上下文、仓库授权、预算闸门、日志/产物/checkpoint 回传。
- **分屏工作台**:已有 Diff/Worktree/Terminal/File Editor/Browser/Preview 六面板壳和首版 IPC/UI;还缺拖拽停靠、布局保存、逐 hunk accept/reject、预览到批注到修复闭环。
- **Hooks / 后台任务**:目前只有 SDK 能力识别和路线图设计;还需 hooks 事件桥接、权限/超时/日志策略、backgroundTasks 管理 UI、后台任务升格终端与输出回灌 Agent。

### 下一轮优先攻坚

- **P0 · checkpoint 深一致性 + worktree 合并/PR 打通**:在已接入"代码 / 对话 / 两者"与 CaoGen transcript 原子回溯的基础上,补底层 Claude SDK 上下文级重建,建立 message id、checkpoint、tool diff、worktree 路径的可索引链路;回退前必须解释将恢复/丢弃的代码 diff 与聊天范围;WorktreePanel 接上 `worktreeMerge` 的 apply-check、合并回主工作区、生成 PR、冲突三栏和合并后 checkpoint 验收,硬标准是主工作区零污染、任一 worktree 可回退/可丢弃/可 PR。
- **P0 · 子代理真实编排二期**:在已落地的父会话 `dispatchSubagents` / 33 child sessions / 默认独立 worktree 基础上,接 SDK `supportedAgents()` / `agents` 能力,落 TaskGraph、事件流回传、预算/权限/验收命令与合并队列;3D 办公区只消费真实 child session、task、worktree 状态,不再新增视觉假状态。
- **P1 · 云端 Routines 最小闭环**:先把本地调度器、Routine Inbox、run log、artifact、diff、checkpoint 回传做成可复验链路;云端以 GitHub Actions 桥接或最小 Cloud Scheduler/Runner 试点,强制加密上下文、仓库授权、Secrets 范围、预算闸门、最大运行时和 PR-only 默认策略。
- **P1 · 插件/Routine 面板接线**:把 `pluginRegistry` 扫描结果接入插件浏览器、MCP 状态面板、安装/启用/权限/版本治理;`/` 面板聚合插件命令与 Routine 模板,支持参数表单、最近使用、失败诊断和一键生成 Routine。
- **P2 · 预览深渲染与批注闭环**:把 PDF 从占位升级为页级渲染、搜索、缩略图和批注;CSV/表格补筛选、公式/图表识别,PPT 补缩略图与页批注;所有预览批注都能结构化发给 Agent,形成"看产物 → 批注 → 修复 → 复验"链路。

---

## 支柱设计要点

### 支柱一:多厂商模型接入(分两层落地)

**第一层 · Provider Profile(已完成 M3/M3.5)**
现有引擎(Claude Agent SDK)只讲 **Anthropic Messages API 协议**(`/v1/messages`),支持 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_CUSTOM_HEADERS` 覆写。因此:

- 设置页维护 Provider 列表:`{ name, baseUrl, token(加密), models[], customHeaders, 备注 }`
- 每个会话创建时选 Provider + Model,`AgentSession.buildEnv` 按会话注入对应 env;选定 Provider 时剥离宿主 host 托管鉴权,避免被盖过
- 密钥存 safeStorage(Electron 加密),不落明文;渲染进程只见 `hasToken` 标记

**关于 OpenAI / Gemini / 国产模型**:OpenAI 已有原生 Responses API 引擎第一版,可选择 `OpenAI Responses API` 直接使用官方或兼容端点。Claude Agent SDK 引擎仍不直接讲 OpenAI 的 `/v1/chat/completions`/Responses 协议;在 Claude 引擎下接 OpenAI/Gemini 仍需 **Anthropic 兼容网关**(one-api、new-api、LiteLLM、claude-code-router 等)转译。M3.5 已提供网关预设模板 + 自定义请求头,OpenAI 模板则配合 OpenAI 引擎直连使用。

**第二层 · EngineAdapter(架构已落地)**
`src/main/engine.ts` 定义 `Engine` 接口(start/send/interrupt/permission/transcript/events)与注册表;`AgentSession implements Engine` 即 ClaudeEngine,经 `engines.ts` 注册为默认引擎;`OpenAIEngine` 已接 OpenAI Responses API,支持文本/图片输入、流式输出、中断、转录和模型切换;`sessionManager.create` 走 `createEngine(kind)` 工厂,`SessionMeta.engine` 记录会话引擎,新建会话 UI 提供引擎下拉(`engines:list` IPC)。Codex CLI / Gemini CLI 探测本机安装情况如实上报,适配器实现为 M6 剩余工作——各自把 CLI 的流式输出翻译成 `AgentEvent` 即可,事件模型已与引擎解耦。

### 支柱二:模型调度(手动 + 智能)

- **固定模式**:会话/单轮指定 Provider+Model(现有 setModel 扩展)
- **自动模式**:调度器按信号路由 —
  - 信号:消息意图与复杂度(规划/编码/问答/大重构)、上下文规模、预算余量、Provider 健康度(近期错误率、余额 403、限流)、模型能力表(质量/速度/上下文窗/单价)
  - 策略:质量优先 / 成本优先 / 均衡,三档可选
  - 故障切换(M4.1 已落地):按错误文本分类(余额/配额、限流/过载、模型不可用、鉴权、5xx、网络、引擎崩溃)判定"可切换";挑健康且模型能力档最接近的替代厂商,终止旧引擎 → resume 延续上下文 → 重发本轮消息;每轮最多切 3 次防打转;用户中断不触发;切换过程以 failover 事件插入聊天流并持久化
  - **透明性红线**:每轮实际用了什么模型、为何路由,必须在 UI 可见可追溯
- v2:根据用户手动改判与结果质量回评,持续修正路由表

### 支柱三:写实 3D 办公区

- **技术**:`@react-three/fiber` + `@react-three/drei` 起步,逐步升级到 PBR 材质、环境光/烘焙光照、GLTF 资产、LOD、实例化渲染、按需帧率;写实目标必须服从状态可读性和功耗约束
- **场景语义**:每会话 = 一个工位 + 一个 Agent 小人;状态机驱动动画:
  - `idle` 待命 / `streaming` 打字 / 工具运行时走向对应设备(终端=Bash、文件柜=Edit、浏览器=Web、档案柜=PDF/表格/PPT)/ `等待授权` 举手亮红灯 / `error` 工位警示
  - 工位上方浮动 token/费用气泡;新会话 = 员工入职动画
- **交互**:点击工位聚焦该会话(切到聊天视图);办公区视图与现有列表视图一键切换
- **v1 范围收敛**:固定等轴测摄像机、5 种状态动画、点击聚焦;后续再做自由漫游/装修
- **写实升级路径**:
  - M5R.1:统一材质、阴影、景深、环境光、抗锯齿,让场景从"玩具感"升级为"可信办公室"
  - M5R.2:替换核心资产为轻量 GLTF,保留程序化 fallback
  - M5R.3:子代理、浏览器、后台任务、Routine 都映射为真实空间对象,动画必须表达真实状态
- **性能**:视图不激活时降帧至 ≤10fps,WebGL 上下文全局单例;活跃视图目标 60fps,低配模式可关闭后处理

---

## 里程碑

| # | 里程碑 | 内容 | 状态 |
|---|---|---|---|
| M0 | 骨架 | Electron + SDK 多会话架构,六大基础能力 | ✅ 已完成 |
| M1 | 端到端可用 | 全链路实测 + 7 处缺陷修复 | ✅ 已完成 |
| M2 | 会话内容持久化 | ChatItem 转录落盘(JSONL),重载回填;恢复聊天记录 | ✅ 已完成(冷启动 resume 回放缺陷已修:createSession 后主动补拉转录) |
| M3 | 多厂商 Provider | Provider Profile 配置页 + 会话级 env 注入 + safeStorage 密钥 | ✅ 已完成 |
| M4 | 智能调度 v1 | 规则路由(意图分级 + 健康度)+ 路由透明面板 | ✅ 已完成 |
| M4.1 | 跨厂商故障切换 | 错误分类(余额/限流/模型下线/网络)→ 自动切健康厂商 resume 重试,任务不中断;聊天流透明标注;可设置开关 | ✅ 已完成 |
| M5 | 3D 办公区 v1 | R3F 场景、工位状态动画、点击聚焦、双视图切换 | ✅ 已完成 |
| M6 | 原生多引擎 | EngineAdapter 抽象,接入 OpenAI / Codex CLI / Gemini CLI | 🚧 架构已落地;OpenAI Responses API 引擎第一版已接入;Codex/Gemini 适配器待实现 |
| M7 | 打包分发 | electron-builder、图标、自动更新 | 🚧 打包链路已完成;自动更新待实现 |
| M8 | 肌肉记忆层 | `@`文件 / 图片输入 / 斜杠命令 / 快捷键 + 通知防休眠 + 3D 材质光影(D1/D9/D10.1) | 🚧 `@`文件、`/`命令面板、Esc Esc、通知/防休眠、图片附件复制/base64 content block helper 与 Composer 粘贴/拖拽 UI 已完成;图片标注/OCR 与材质光影待实现 |
| M9 | 检查点 + Worktree | `Esc Esc`//rewind 回溯(代码/对话/两者)+ 每 Agent worktree 隔离与合并路径(D2/D3/D10.2) | 🚧 checkpoint rewindFiles 核心 + 回溯面板 + worktree 自动隔离/管理面板/patch 导出/丢弃 + 合并审查/patch apply-check helper 已完成;对话回溯/直接合并 UI/PR 待实现 |
| M10 | 工作台化 | 拖拽分屏 + 内置终端/编辑器 + 重做 Diff + HTML/PDF/表格/PPT 预览(D4) | 🚧 分屏壳 + 工作区 Diff 面板 + Worktree 面板 + 终端后端/API/UI 第一版 + 安全文件编辑器 IPC/preload/store/UI 第一版 + PreviewPanel/PreviewRenderer 第一版已完成;预览内容可一键发给 Agent;拖拽布局/逐 hunk accept/PDF 深度渲染/表格/PPT 待实现 |
| M11 | 浏览器批注 | 内置浏览器 + DOM 圈选批注喂给 Agent + Agent 只读观测复验(D6) | 🚧 WebContentsView 浏览器面板、导航、后退/前进/刷新、选区批注保存、页面高亮、批注发给 Agent 第一版已接入;DOM 圈选/截图批注/Agent 只读观测工具待实现 |
| M12 | 真子代理 + Hooks | SDK agents/hooks 桥接 + 跨会话派活 + 任务图 + 3D 真实任务流(假动画退役)(D5/D8/D10.3) | 🚧 `dispatchSubagents` 后端/IPC/preload/store/面板入口已落地,可从父会话派发真实 child sessions,默认独立 worktree,一次最多 33 个;SDK agents/hooks 桥接、TaskGraph、事件回传、预算/权限闸门、合并队列待实现 |
| M13 | 记忆 + 本地 Routines | 项目记忆(确认制)+ 开工建议 + 本地 cron + 跨天续做(D7) | 🚧 项目记忆 confirmed/draft store + Routine JSON store helper + 开工建议 helper 已完成;确认 UI、本地调度器、收件箱、跨天续做 UI 待实现 |
| M14 | 云端 Routines | GitHub Actions 桥接先行,自建 Runner 视反馈评估(D7 云端) | 规划 |
| M15 | 插件生态 | 插件浏览器 + MCP 面板 + 90+ 覆盖与治理(D9) | 🚧 skills/agents/MCP registry 扫描 helper 已完成;插件浏览器、MCP 状态面板、安装/权限/版本治理待实现 |
| — | 持续打磨 | Markdown 渲染、"已中断"标签、工具级白名单、标题重命名 | 穿插进行 |

**依赖关系**:M2 是 M5 的前置(3D 状态机要靠可靠的事件/状态流);M3 是 M4 的前置(先有多厂商才谈跨厂商调度);M6 不阻塞 M4/M5(第一层网关方案已可多厂商)。

## 迁移攻坚(M8–M15):让 Codex/Claude 深度用户丝滑转入

> **完整规划设计见 [DESIGN-V2.md](./DESIGN-V2.md)**:按"第一天(肌肉记忆)→ 第一周(工程可信)→ 第一月(编排自动化)"迁移漏斗组织十大能力域(D1–D10),每域含体验目标、落到现有架构的技术方案、好用细节与可验收标准,并实测了 SDK@0.3.199 的原生能力面(checkpoint/rewind/hooks/agents/背景任务/图片输入均已内建,多数功能是"接线"而非"从零造")。

目标不止"拥有",而是"好用"。迁移用户的判断非常残酷:少一个高频动作、回退不可靠、并发污染工作区、不能看产物,就会退回 CLI。因此 M8–M15 的设计原则是:

- **肌肉记忆优先**:`@`、`/`、图片、`Esc Esc`、快捷键、命令面板必须 1:1 可用,并且全键盘可达
- **工程可信优先**:每个 Agent 默认 worktree 隔离;每次写入前有 checkpoint;每个合并动作可审查、可丢弃、可回退
- **真实编排优先**:3D 协作动画必须由真实子代理任务驱动,不能只是"协作消息包"的视觉包装
- **产物闭环优先**:浏览器、终端、编辑器、Diff、HTML/PDF/表格/PPT 预览在同一工作台完成,不用跳外部应用
- **长期任务优先**:记忆、自动化、主动建议、云端定时要服务跨天任务,不是提醒事项皮肤

**关键发现(实测 sdk.d.ts)**:Claude Agent SDK 已原生提供大部分底层能力,多数功能是"接 UI + 状态管理 + 安全边界"而非"从零造":
- `enableFileCheckpointing` + `query.rewindFiles(msgId)` → 检查点回溯
- `query.supportedCommands()` → 斜杠命令面板;`supportedAgents()` / `agents` 选项 → 子代理编排
- `hooks` 选项 → Hooks;`query.backgroundTasks()` / `stopTask()` → 后台任务
- `query.getContextUsage()` → 上下文压缩提示;工作区 diff 需 CaoGen 自研 `git diff` helper(已开工)
- `query.readFile()` + 自列 cwd 文件 → @文件引用;image content block → 图片输入
- `mcpServers` + `reloadPlugins/reloadSkills` → 插件/MCP 管理

### M8 肌肉记忆层

- **`@` 文件引用**:输入 `@` 唤起 cwd 文件补全;支持最近文件、模糊搜索、目录过滤、二进制禁选、大文件摘要预览;发送时记录引用快照,保证事后可追溯
- **图片输入**:拖拽/粘贴截图或文件;支持多图、局部裁剪、标注、OCR 摘要;图片作为 message content block 进入引擎
- **已落地底座**:`attachmentOps` 支持图片复制到附件区、content-hash 命名、5MB 上限、签名校验与 base64 image block 生成;下一步接 Composer 粘贴/拖拽与聊天回显
- **斜杠命令**:`/` 唤起命令面板,聚合 SDK supportedCommands、CaoGen 内置命令、插件命令、Routine 模板;支持参数表单与最近使用
- **完成通知 + 防休眠**:长任务运行时 `powerSaveBlocker`;完成/等待审批/失败时 Electron Notification;通知点击回到对应会话
- **验收**:不碰鼠标可完成"引用文件 → 贴图 → 运行命令 → 中断/继续 → 收到完成通知"

### M9 检查点回溯 + Worktree 隔离

- **自动 checkpoint**:每次文件写入前保存 checkpoint;绑定 message id、tool id、diff、模型、provider、时间、worktree 路径
- **`Esc Esc` / `/rewind`**:弹出回退面板,可选恢复"代码 / 对话 / 两者";回退前预览将恢复和将丢弃的 diff
- **每 Agent 独立 worktree**:同仓库并发会话默认 `git worktree add` 到 CaoGen 管理目录;每个子代理也可拥有独立 worktree
- **合并路径**:提供"应用到主工作区 / 开 PR / 生成 patch / 丢弃 worktree";冲突时进入三栏 diff
- **清理策略**:任务完成、取消、失败、长时间闲置都进入可恢复垃圾箱,避免偷偷删用户工作
- **已落地底座**:`worktreeMerge` 已支持合并审查、squash patch 生成与 `git apply --check` 风险判断;下一步接 WorktreePanel 的"合并回主工作区/开 PR" UI
- **验收**:4 个 Agent 同时改同仓库,主工作区保持干净;任一 Agent 可一键回退到任意 checkpoint

### M10 工作台化:分屏、终端、编辑器、预览、Diff

- **拖拽分屏布局**:聊天、3D、浏览器、终端、编辑器、Diff、预览都可停靠/拆分/保存布局
- **内置终端**:xterm + pty;按会话绑定 cwd/worktree;后台任务可升格为终端面板;命令输出可一键发给 Agent
- **内置编辑器**:Monaco;只打开当前 worktree 文件;保存触发 checkpoint;支持 Agent 修改高亮
- **重做 Diff 查看器**:基于 `getWorkspaceDiff`;逐块 accept/reject;支持文件级、hunk 级、行级处理;接受后写回目标 worktree
- **产物预览**:HTML 内嵌浏览器预览;PDF 渲染与页级批注;表格预览含公式/筛选/图表;PPT 预览含缩略图和页批注
- **已落地底座**:工作台侧栏已支持 Diff/Worktree/Terminal/File Editor/Browser/Preview 六面板切换;`files:list/read/write` IPC 与安全原子写入已接 UI;`previewOps` 已能识别 HTML/Markdown/Text/CSV/JSON/Image/PDF 并返回安全预览元数据;`PreviewRenderer` 可渲染 text/markdown/json/csv/html/image/pdf 占位;PreviewPanel 已接真实 IPC,预览内容可一键发给 Agent
- **验收**:一个前端任务可在 CaoGen 内完成代码、运行、浏览器验收、截图批注、Diff 审查,无需切外部工具

### M11 内置浏览器批注

- **浏览器面板**:Electron webview/BrowserView;支持多标签、登录态隔离、dev server 快捷打开、移动/桌面视口切换
- **网页批注**:框选 DOM、区域截图、文字批注、箭头/高亮;生成结构化 `BrowserAnnotation`:{ url, title, selector, boundingBox, screenshot, note, consoleErrors, networkSummary }
- **给 Agent 的上下文**:批注作为消息附件进入当前会话;Agent 能定位对应文件、组件或 API
- **Agent 驱动浏览器**:在权限允许时可打开 URL、点击、填写、截图、读取控制台/网络错误,形成"看见问题 → 修改 → 复验"闭环
- **已落地底座**:`browserAnnotations` 已支持 BrowserAnnotation 规范化、按 session 安全保存/读取/list、console errors 截断与原子写入;`browserViewManager` 已用 Electron `WebContentsView` 接入原生浏览器、导航、bounds 定位、选区批注保存与页面高亮;BrowserPanel 批注可一键发给 Agent;DOM 圈选、截图批注 UI 与 Agent 只读观测工具待接
- **验收**:用户在页面上圈出错位按钮并写"这里移动端溢出",Agent 能收到截图+DOM 线索并修复

### M12 真子代理编排 + Hooks / 后台任务

- **任务图模型**:主 Agent 把目标拆成 TaskGraph,每个子任务有 owner、worktree、依赖、预算、验收命令、输出产物
- **子代理运行**:前端、后端、测试、文档等子 Agent 并行;每个子 Agent 事件流进入统一时间线;3D 办公区显示真实派活、等待、冲突、回传
- **结果合并**:主 Agent 汇总子 Agent diff、测试结果和产物;冲突进入合并队列;用户可逐块接受
- **Hooks**:pre-send、post-edit、post-command、pre-commit、on-failure、on-complete;支持项目级和全局级;每个 hook 有权限、超时、日志和失败策略
- **后台任务**:dev server、watch test、lint、long-running build 独立管理;可暂停/恢复/发输出给 Agent;不阻塞聊天
- **已落地底座**:3D `MessagePackets` 已移除随机假协作动画,改由 `buildOfficeModel` 从真实 `tool_use`、运行中工具、工具结果、权限请求派生任务包与当前任务;`dispatchSubagents` 已能创建真实 child sessions、写入 parent/orchestration/task 元数据、默认独立 worktree 并立即投递 prompt,Subagent 面板和 `/subagents` 入口已接入;SDK agents/hooks 桥接、TaskGraph、事件回传总线和合并队列仍待实现
- **验收**:一个"前后端同时做"任务能拆给 ≥3 个子 Agent,独立执行并最终合并成可审查结果

### M13 记忆 + 主动建议 + 本地 Routines

- **记忆分层**:用户偏好、项目事实、决策记录、常用命令、失败教训、长期任务状态分开存储;敏感值只存引用不存明文
- **开工建议**:打开项目时主动提示"上次卡在什么、可继续什么、建议先跑什么检查";必须可关闭、可追溯来源
- **本地 Routines**:应用运行时按计划执行:每日构建检查、每周依赖升级、PR 评论跟进、测试失败重试、文档同步
- **跨天续做**:Routine 产生日志、产物、checkpoint 和下一步计划;第二天打开能继续,不是重新开始
- **已落地底座**:`memoryStore` 已支持 confirmed/draft 项目记忆、原子写入和 system-prompt markdown 聚合;`routineStore` 已支持 Routine create/list/update/delete/markRun 持久化;`startSuggestions` 已能从 README/TODO/package/lockfile/git dirty/记忆与 Routine 摘要生成本地开工建议;调度器、确认 UI、Routine 收件箱待接
- **验收**:关闭会话再打开,能基于记忆提出 3 条具体且有证据的继续建议

### M14 云端 Routines:cron for AI

- **定位**:不是云端协作套件,而是最小云端定时执行层;目标是笔记本关机后仍可按计划触发任务
- **架构**:Cloud Scheduler 保存加密任务计划、触发器、最小上下文摘要和仓库连接;Cloud Runner 拉起沙箱执行 Agent/CLI,产物和日志回传桌面端
- **权限模型**:每个 Routine 显式授权仓库、分支、Secrets、预算、最大运行时、可执行工具;高风险动作默认产出 PR/patch,不直接改主分支
- **状态同步**:桌面端重连后拉取云端 run logs、diff、artifact、checkpoint;可继续、取消、重跑、转本地
- **验收**:电脑关机期间云端完成一次计划任务,重新打开 CaoGen 能看到完整日志、diff、费用、产物和下一步建议

### M15 90+ 插件生态

- **插件形态**:MCP server、技能/模板、斜杠命令、预览器、Hook、Routine 模板、Provider 模板统一进 Plugin Registry
- **90+ 覆盖方向**:GitHub/GitLab/Jira/Linear/Notion/Figma/Slack/Chrome/浏览器自动化/数据库/云服务/包管理/测试框架/文档/表格/PPT/PDF/设计资产/监控告警/安全扫描
- **安装与治理**:插件市场、版本锁定、权限声明、项目级启用、日志审计、失败隔离、更新回滚
- **插件即工作流**:插件命令出现在 `/` 面板;插件产物进入预览面板;插件任务可被 Routine 调度;插件状态可进 3D 办公区
- **已落地底座**:`pluginRegistry` 已只读扫描 skills、agents 与 MCP 配置,返回统一 registry view 与 diagnostics;插件浏览器/MCP 连接状态/安装治理待接
- **验收**:安装 90+ 插件后启动时间、命令搜索、权限提示和失败隔离仍可控;用户能在 30 秒内找到并运行目标插件

**迁移友好度排序**:先做 M8/M9,因为它们决定深度用户是否愿意留下;再做 M10/M11,把桌面端优势打出来;然后 M12 让 3D 协作从动画变成真实编排;最后 M13–M15 建立长期任务和生态壁垒。



## 非目标

- 不自研/微调模型
- 不做完整云端协作套件;但会做最小云端 Routines/Scheduler,只服务定时执行与跨设备续做
- 不做移动端
- 不做写实游戏级自由漫游;但 3D 办公区追求高质感写实渲染,前提是状态可读、性能可控

## 已知风险

- **网关兼容性**:各家 Anthropic 兼容端点对 haiku 等别名解析不一(本机代理已实测踩坑)→ 调度器健康度机制必须覆盖"模型不存在"这类错误
- **子代理配额**:大规模并发烧余额会 403(实测)→ 调度器要有预算闸门
- **3D 性能**:多会话 + WebGL 在低配机器上的功耗 → 降帧与按需渲染是硬要求
