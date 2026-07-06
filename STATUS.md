# CaoGen 项目状态

> 更新:2026-07-06(第 2 次)· 实测口径,非文档自评。此文件为活文档,Current Focus 随日更新。

# Context

国产原创**多厂商 AI 编码桌面工作室**(Electron + React + react-three-fiber,MIT 开源,[GitHub](https://github.com/ChaoYuZhang001/CaoGen)),对标 Codex Desktop / Claude Code / Gemini CLI。差异化站位:**不绑定厂商** —— 一把钥匙接入 DeepSeek/Qwen/Grok/网关/本地模型,任何模型都是带工具调用的真编码 Agent;多会话并行 + 写实 3D 办公区 + 每 Agent 独立 Git worktree 隔离 + 跨厂商智能路由与故障切换。

# Current Status

- **v0.1.1 已公开发布**(2026-07-06,**双架构 x64 + arm64** DMG/zip + 自动更新元数据,未签名)——arm64 主二进制/claude/node-pty 架构均已验证,M 系真机启动待用户复验
- 已实测验证:原生编码 Agent(DeepSeek E2E 7/7)、跨厂商智能路由(6/6)、子代理编排闭环(6/6)、32 并发压测(6/6,2s 全完)、双协议对话(DeepSeek 9/9、网关 Gemini 9/9)、回归 `test:deep` 21/21
- 五支柱实测达成:多厂商 ~95% · 调度 ~95% · 3D ~90% · 迁移级工作流 ~85% · 长期自主执行 ~80%
- 用户实测反馈已修 4 项(冗余"你"标注、矛盾错误文案、引擎×Provider 404、填 key 不生效)

# Current Focus

**用户日常真用 → 毛刺当天修。**(arm64 打包已完成并发布)

# Goal

**北极星 N1**:任一主流 Agent(Codex/Claude Code/Gemini CLI/Cursor…)深度用户 **30 分钟内**跑通日常主链路(导入资产→建会话→@文件→改代码→审 diff→提交),资产零丢失。以五支柱代差做成"世界第一 / 中国首创"验收方向的桌面 AI 编码工作室。

# Next Milestone

**v0.2.0 "可日用"** — Definition of Done:

1. 规划方连续 7 天日常使用,新毛刺 ≤1/天且当天修复
2. ~~arm64 原生包发布~~ ✅ 2026-07-06(架构三重验证;M 系真机启动复验待用户)
3. Codex + Gemini 原生引擎各 ≥1 次真实对话验证
4. N1 秒表实测 ≤30 分钟(真人,录屏留证)
5. `test:deep` 全绿保持;新特性必配真实 E2E

# Priority Tasks

**P0**
- 用户反馈快修循环(常设)
- ~~arm64 / universal 打包~~ ✅ 已发布至 v0.1.1
- 撤销泄漏的 GitHub token(用户,安全)——**仍未撤销,token 实测仍有效**

**P1**
- Codex/Gemini 引擎真对话验证(等用户登录 CLI)
- 插件治理下半场:安装 / 版本锁定 / 权限声明
- 会话全文搜索(U5.1)
- worktree 冲突三栏 + 合并后 checkpoint 验收

**P2**
- 聊天头工具栏图标化(U3.3)
- chat 历史自动压缩(长会话上下文膨胀)
- Responses 协议接工具循环(当前仅 chat 协议是编码 Agent)
- 路由能力表自学习(按实际质量/延迟/成本修正)
- N1 迁移实测 + 迁移向导补 Cursor/Cline/Aider 资产映射

# Blockers

| 阻碍 | 等什么 |
|---|---|
| Codex/Gemini 真验 | 用户 `codex login` / `gemini` 登录一次 |
| 签名公证 DMG | 用户 Apple Developer 账号($99/年) |
| Grok / OpenAI 官方真实 E2E | 两家 key 均无额度,等充值 |
| N1 外部验证 | 需要非项目相关的真实竞品用户 |

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
4. **长会话膨胀**:chat 历史无压缩;OpenAI 引擎工具声明每请求 ~700 token 固定开销
5. **Codex/Gemini 适配器未经真对话检验**,协议漂移风险(CLI 版本迭代快)

# Success Criteria

- **v0.2.0 验收** = Next Milestone 五条全部成立
- **长期成功** = 北极星 N1 由**非项目相关**的真实竞品深度用户验证通过(30 分钟计时 + 资产零丢失 + 关键动作无需回退原工具)
