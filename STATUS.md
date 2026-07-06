# CaoGen 项目状态

> 更新:2026-07-06(第 8 次)· 实测口径,非文档自评。此文件为活文档,Current Focus 随日更新。
>
> ⚠️ 发布未达标(2026-07-06 外部验收):3 个真实阻塞 —— Claude 真对话 180s 超时、32 并发压测 t7 抽查失败(5/6)、最新 dist:mac 卡 Electron 下载。详见 # Blockers。

# Context

国产原创**多厂商 AI 编码桌面工作室**(Electron + React + react-three-fiber,MIT 开源,[GitHub](https://github.com/ChaoYuZhang001/CaoGen)),对标 Codex Desktop / Claude Code / Gemini CLI。差异化站位:**不绑定厂商** —— 一把钥匙接入 DeepSeek/Qwen/Grok/网关/本地模型,任何模型都是带工具调用的真编码 Agent;多会话并行 + 写实 3D 办公区 + 每 Agent 独立 Git worktree 隔离 + 跨厂商智能路由与故障切换。

# Current Status

- **v0.1.1 已公开发布**(2026-07-06,**双架构 x64 + arm64** DMG/zip + 自动更新元数据,未签名)——arm64 主二进制/claude/node-pty 架构均已验证,M 系真机启动待用户复验
- 已实测验证:原生编码 Agent(DeepSeek E2E 7/7)、跨厂商智能路由(6/6)、子代理编排闭环(6/6)、双协议对话(9/9×2)、**Codex CLI 引擎真对话(3/3)**、回归 `test:deep` **23/23**
- ⚠️ **32 并发压测:实测 5/6**(t7 抽查 7×3=21 失败;根因待查——压力脚本曾把 idle+error 都算完成掩盖了失败,统计口径正在修)。此前 STATUS 写"6/6"不实,已更正。
- ⚠️ **Claude 默认引擎真对话:超时未通过**(最小提示 180s 无 turn-result,根因未确认)
- P1 全部可做项收口(2026-07-06):全文搜索、冲突三栏+合并回执、插件安装/卸载/版本/权限、Codex 真验
- 五支柱实测达成:多厂商 ~95% · 调度 ~95% · 3D ~90% · 迁移级工作流 ~85% · 长期自主执行 ~80%
- 用户实测反馈已修 4 项(冗余"你"标注、矛盾错误文案、引擎×Provider 404、填 key 不生效)

# Current Focus

**修外部验收的 3 个发布级阻塞**(按序):① 压力脚本统计口径→复跑 32 并发须 6/6 且 error=0 ② Claude 真对话超时诊断+正式 E2E ③ Electron mirror 重跑 dist:mac。arm64 真机启动需用户 Apple Silicon 机器。

# Goal

**北极星 N1**:任一主流 Agent(Codex/Claude Code/Gemini CLI/Cursor…)深度用户 **30 分钟内**跑通日常主链路(导入资产→建会话→@文件→改代码→审 diff→提交),资产零丢失。以五支柱代差做成"世界第一 / 中国首创"验收方向的桌面 AI 编码工作室。

# Next Milestone

**v0.2.0 "可日用"** — Definition of Done:

1. 规划方连续 7 天日常使用,新毛刺 ≤1/天且当天修复
2. ~~arm64 原生包发布~~ ✅ 2026-07-06(架构三重验证;M 系真机启动复验待用户)
3. Codex + Gemini 原生引擎各 ≥1 次真实对话验证 —— **Codex ✅ 2026-07-06(真对话 3/3,修 3 个适配 bug);Gemini 阻塞:等用户完成 `gemini` 登录**
4. N1 秒表实测 ≤30 分钟(真人,录屏留证)
5. `test:deep` 全绿保持(现 27 项);新特性必配真实 E2E

# Priority Tasks

**P0**
- 用户反馈快修循环(常设)
- ~~arm64 / universal 打包~~ ✅ 已发布至 v0.1.1
- 撤销泄漏的 GitHub token(用户,安全)——**仍未撤销,token 实测仍有效**

**P1**(2026-07-06 收口:4/4 可做项全完,唯 Gemini 等用户登录)
- ~~Codex 引擎真对话验证~~ ✅ 3/3(修 3 个适配 bug);Gemini 等用户登录
- ~~插件治理下半场:安装 / 卸载 / 版本 / 权限声明~~ ✅(本地安装+回收站卸载+
  路径牢笼,7 断言冒烟;版本锁定降级为版本展示,市场分发本版不做)
- ~~会话全文搜索(U5.1)~~ ✅(侧栏消息内容命中直达会话)
- ~~worktree 冲突三栏 + 合并回执~~ ✅(三栏对照+patchSha256 回执)

**P2**(2026-07-06 推进:3/5 已推送)
- ~~聊天头工具栏图标化(U3.3)~~ ✅ 8 按钮→图标+⋯更多下拉;page-smoke 按 aria-label 适配全绿
- ~~chat 历史自动压缩~~ ✅ 超 48k token 摘要旧段,不切断 tool_call 配对(e2e 4/4)
- ~~Responses 协议接工具循环~~ ✅ 官方 OpenAI 模型也成真编码 Agent(e2e 5/5)
- ~~路由能力表自学习~~ ✅ 按实测成败/延迟给同档模型打平降权(集成 T17 验证)
- N1 迁移实测:向导映射✅、演练 fixture+计时脚本✅(docs/N1-MIGRATION-DRILL.md);仅剩**真人 30 分钟计时**(不可脚本替代,阻塞)

# Blockers

**发布级阻塞(2026-07-06 外部验收,优先修):**

| 阻碍 | 等级 | 状态 |
|---|---|---|
| Claude 真对话 180s 超时 | High | 修复中:固化 claude-real-e2e + AgentSession 暴露 SDK stderr/exit/timeout 诊断 |
| 32 并发压测 5/6(t7 抽查失败) | High | 修复中:压力脚本统计口径(idle vs error 分开、error=0 独立断言)后复跑 |
| 最新 dist:mac 卡 Electron 下载 | Medium | 修复中:配 Electron mirror/预热缓存后重跑;之前 npmmirror 走通过 |
| arm64 包真机启动 | — | 需真实 Apple Silicon 机器(Intel 不可替代) |

**需用户的外部阻塞:**

| 阻碍 | 等什么 |
|---|---|
| Gemini 真验(Codex 已✅) | 用户本机 `gemini` 登录(沙箱连不到 Google API,须在用户机跑) |
| 签名公证 DMG | 用户 Apple Developer 账号($99/年) |
| Grok / OpenAI 官方真实 E2E | 两家 key 均无额度,等充值 |
| N1 30 分钟计时 | 备好 fixture+脚本(docs/N1-MIGRATION-DRILL.md);需真人按秒表跑并留证 |

# Decisions

不会改变的原则:

1. **实测才算完成**:每个特性配真实 E2E(真进程/真 IPC/真模型调用),"编译过"不算数;状态如实标注,不虚标
2. **六环链路**:新能力必须主进程 → IPC → preload → types → store → UI 全通才算接通
3. **不搬竞品代码**:只借鉴信息架构与交互,纯自实现
4. **安全边界**:密钥加密落盘不出主进程;文件工具路径牢笼;权限审批不可绕过(bypass 需显式选择);发布物不含任何凭据
5. **中英双语**:所有 UI 文案 zh/en 齐备,zh 为母语级
6. **每任务独立提交**,提交信息写"做了什么 + 怎么验证"
7. **诚实降级**:能力不可用时如实报告(如 OCR 无引擎、PR 无 gh/glab),绝不伪造结果

# Out of Scope

本版本(v0.2.0)明确不做:

- 云端 Routines / 云端 Runner(本地定时任务已有)
- App Store 上架(走 GitHub Releases 分发)
- Windows / Linux 打包验证(配置在,未测,不承诺)
- 移动端、自研/微调模型
- 插件市场(安装/治理做,"市场"不做)
- 写实游戏级 3D 自由漫游

# Risks

1. **零外部用户数据**:所有"可用"结论出自 E2E 与自测,N1 从未真人验证 —— 最大未知
2. **分发摩擦**:未签名(首开需右键);~~仅 x64~~ 双架构已解决
3. **泄漏 token 未确认撤销**(对话记录含仓库写权限凭据)
4. **长会话膨胀**:~~chat 历史无压缩~~ 已加自动摘要压缩(超 48k token);OpenAI 引擎工具声明每请求固定开销仍在
5. **Gemini 适配器未经真对话检验**(Codex 已实测通过);CLI schema 漂移风险仍在(已按 codex-cli 0.142 实测对齐)

# Success Criteria

- **v0.2.0 验收** = Next Milestone 五条全部成立
- **长期成功** = 北极星 N1 由**非项目相关**的真实竞品深度用户验证通过(30 分钟计时 + 资产零丢失 + 关键动作无需回退原工具)
