# CaoGen 项目状态

> 更新:2026-07-08(第 19 次)· 实测口径,非文档自评。此文件为活文档,Current Focus 随日更新。
>
> ⚠️ **未达发布标准**(第 2 轮外部验收)。已通过:DeepSeek 全链路、Codex CLI、32 并发 7/7、双架构打包、Intel x64 启动、npm audit 0 漏洞、窄屏响应式 Electron QA。未通过/条件性:Claude 真对话仅在有真实登录态时通过(无凭据环境须跳过,已修检测)、Gemini 装了 CLI 不等于可用(已修 available 探测)。阻塞:arm64 真机启动需 Apple Silicon(Intel 不可替代)。
>
> **状态纪律**(修正第 2 次犯的"未复现即声称"):凡真对话/可用性类结论必须写明**成立条件与复现环境**,不写环境无关的绝对断言。

# Context

国产原创**多厂商 AI 编码桌面工作室**(Electron + React + react-three-fiber,MIT 开源,[GitHub](https://github.com/ChaoYuZhang001/CaoGen)),对标 Codex Desktop / Claude Code / Gemini CLI。差异化站位:**不绑定厂商** —— 一把钥匙接入 DeepSeek/Qwen/Grok/网关/本地模型,任何模型都是带工具调用的真编码 Agent;多会话并行 + 消费真实 child session/task/worktree 状态 + 每 Agent 独立 Git worktree 隔离 + 跨厂商智能路由与故障切换。

# Current Status

- **v0.1.2 已公开发布**(2026-07-06,双架构 x64+arm64 DMG,含外部验收 3 阻塞修复;x64 打包 app 启动冒烟通过)——arm64 主二进制架构已验证,M 系真机启动待用户复验
- 已实测验证:原生编码 Agent(DeepSeek E2E 7/7)、跨厂商智能路由(6/6)、子代理编排闭环(6/6)、双协议对话(9/9×2)、**Codex CLI 引擎真对话(3/3)**、A3 子代理结果回传 + 3D 真实任务流(Electron mock E2E)、A4 开工建议真实渲染/交互(Electron mock E2E)、A5 记忆自动提议真实渲染/预填(Electron mock E2E)、回归 `test:deep` **65/65**(2026-07-08,`test-results/caogen-deep/2026-07-07T18-03-37-379Z/deep-test-report.md`)
- ✅ **32 并发压测:修复后 7/7 error=0**(连跑 3 次稳定)。根因=瞬时并发打爆 socket 层;修:并发闸门(默认 8 在途)+ 瞬时网络重试。压力脚本口径已修(idle/error 分统计、error=0 独立断言)
- ⚠️ **Claude 默认引擎真对话:仅在有真实登录态的环境通过(条件性)**。有 `ANTHROPIC_API_KEY` / 存在的 host-creds / `~/.claude/.credentials.json` 时 claude-real-e2e 3/3;**无凭据环境应干净跳过而非通过**(此前误把 `~/.claude.json` 配置文件当凭据,致外部验收环境 Not logged in)。已修:auth 检测只认真实凭据,无凭据时 E2E 跳过、产品给明确登录提示。**发布不得声称"Claude 开箱即用",须声明需登录。**
- ⚠️ **Gemini 引擎:装了 CLI ≠ 可用**。available() 现要求 CLI + 已配认证(GEMINI_API_KEY/GOOGLE_API_KEY 或 settings.json auth);无认证时如实报"不可用",不再误报可用
- P1 全部可做项收口(2026-07-06):全文搜索、冲突三栏+合并回执、插件安装/卸载/版本/权限、Codex 真验
- Work OS 第一波已进入 main:A1 Drive、A2 Quickbar、A3 Desktop Control、A4 Code Forge、A5 Skill Fabric、A6 Memory Loop、A7 Control Center、A8 Personal OS、A9 Genesis(计划层)。Genesis 只宣称编排/交付计划,不宣称真实外部子 Agent 执行、自动合并、推送或发布。
- P2 本地 smoke 已恢复全绿;P2-005 IDE integrations 已由 `test:p2-ide-build-and-vscode:required`、`test:jetbrains-recorder-e2e:required`、`test:jetbrains-ide-interaction:required` 证明。`npm run test:p2-audit -- --required` 仍失败,但当前失败范围已收敛为 P2-001 Windows GUI required evidence 与 P2-004 China external evidence。P2-002/P2-003 已由 `p2_default_smoke` 证明。提交/发布新增 `npm run secret:scan` / `npm run secret:scan:history` / `npm run test:github-release-audit` 门禁,用于阻止密钥、证书、签名材料、生成物和本地证据包进入公开仓库或公开 Release。
- GitHub Releases 公开资产审计已补齐:当前 v0.1.0/v0.1.1/v0.1.2 共 26 个公开资产通过 `npm run test:github-release-audit`,未发现需删除的敏感资产;发布 v0.2.0 后必须对目标 tag 再跑 required 审计。
- 五支柱实测达成:多厂商 ~95% · 调度 ~95% · 3D ~90% · 迁移级工作流 ~85% · 长期自主执行 ~80%
- 用户实测反馈已修 4 项(冗余"你"标注、矛盾错误文案、引擎×Provider 404、填 key 不生效)

# Current Focus

**Work OS Phase 2 发布收口**:Phase 1 A1-A9 已进 main 且 deep gate 全绿;下一阶段按 `docs/WORKOS-PHASE2-PARALLEL-PLAN.md` 并行推进。`npm run workos:release-doctor -- --refresh` 会先刷新 packaging/GitHub Release 轻量审计,再汇总发布停止条件。当前不能发布 `v0.2.0`:还缺最终 release packaging/version/update-source/public asset/secret hygiene 收口。Windows/VS Code GUI required evidence 交专门 Windows agent 后续补;真实 China network/tool-call parity 由用户配置;N1 真人 30 分钟迁移记录不作为本版发布阻塞。

# Goal

**北极星 N1**:任一主流 Agent(Codex/Claude Code/Gemini CLI/Cursor…)深度用户 **30 分钟内**跑通日常主链路(导入资产→建会话→@文件→改代码→审 diff→提交),资产零丢失。以五支柱代差做成"世界第一 / 中国首创"验收方向的桌面 AI 编码工作室。

# Next Milestone

**v0.2.0 "可日用"** — Definition of Done:

1. 规划方连续 7 天日常使用,新毛刺 ≤1/天且当天修复
2. ~~arm64 原生包发布~~ ✅ 2026-07-06(架构三重验证;M 系真机启动复验待用户)
3. Codex + Gemini 原生引擎各 ≥1 次真实对话验证 —— **Codex ✅ 2026-07-06(真对话 3/3,修 3 个适配 bug);Gemini 阻塞:等用户完成 `gemini` 登录**
4. N1 秒表实测 ≤30 分钟(真人,录屏留证)——北极星证据,不作为 v0.2.0 发布阻塞且未验证前不宣称通过
5. `test:deep` 全绿保持(现 56 项);新特性必配真实 E2E

# Priority Tasks

**P0**
- 用户反馈快修循环(常设)
- ~~arm64 / universal 打包~~ ✅ 已发布至 v0.1.1
- 凭据安全:所有疑似泄漏或曾经外发/公开上传的个人/仓库 token 必须在对应平台轮换或撤销;仓库和 GitHub Releases 内不得保存真实密钥、webhook、证书、keystore、provision profile、签名材料或本地证据包

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
- N1 迁移实测:向导映射✅、演练 fixture+计时脚本✅(docs/N1-MIGRATION-DRILL.md);真人 30 分钟计时仍未做,不作为 v0.2.0 发布阻塞,未验证前不做 N1 达标宣称

**Work OS Phase 2 并行任务**(2026-07-08 新排期)
- B0 Release Gate:保持 README/STATUS/release notes 与真实 gate 一致,审计公开 GitHub Release 资产,最后合并;草稿门禁见 `docs/RELEASE-GATE-v0.2.0-DRAFT.md`
- B1 Windows GUI Required:P2-001 strict VS Code GUI/cross-app/input evidence,由专门 Windows agent 后续补
- B2 IDE Build + VS Code Host:✅ P2-005 插件构建、VS Code extension host evidence 已通过
- B3 JetBrains Real IDE:✅ P2-005 JetBrains runIde recorder + interaction evidence 已通过
- B4 China External Evidence:P2-004 真实网络与 tool-call parity evidence,由用户按需配置

# Blockers

**发布级阻塞(2026-07-06 外部验收,优先修):**

| 阻碍 | 等级 | 状态 |
|---|---|---|
| ~~32 并发压测 5/6~~ | High | ✅ 已修:并发闸门(8 在途)+ 瞬时重试;连跑 3 次 7/7 error=0 |
| ~~最新 dist:mac 卡 Electron 下载~~ | Medium | ✅ 已修:.npmrc 配 npmmirror;双架构 DMG 完整产出 |
| ~~Claude auth 误判 / Gemini 可用性误报~~ | High | ✅ 已修:auth 检测只认真实凭据;Gemini available 加认证探测;无凭据干净跳过/明确提示 |
| ~~窄屏响应式布局未过人眼复核~~ | Medium | ✅ 已修:Electron 原生窗口 390/540px 侧栏抽屉、标题、controls、composer、overflow 全 PASS;证据:`test-results/caogen-responsive/2026-07-06T17-46-27-342Z/responsive-qa.json` |
| arm64 包真机启动 | — | 需真实 Apple Silicon 机器(Intel 不可替代) |
| Claude 真对话(无凭据环境) | — | 需用户提供 ANTHROPIC_API_KEY 或 claude 登录;有凭据时 3/3 |

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
3. **外部凭据轮换状态不可由仓库验证**:疑似外泄 token 必须由持有人在对应平台撤销/重建;仓库只保留占位符、环境变量名和脱敏状态
4. **长会话膨胀**:~~chat 历史无压缩~~ 已加自动摘要压缩(超 48k token);OpenAI 引擎工具声明每请求固定开销仍在
5. **Gemini 适配器未经真对话检验**(Codex 已实测通过);CLI schema 漂移风险仍在(已按 codex-cli 0.142 实测对齐)

# Success Criteria

- **v0.2.0 验收** = Release Gate Draft 中的阻塞项全部成立;P2-001/P2-004/N1 按当前边界不阻塞,但不得过度宣称
- **长期成功** = 北极星 N1 由**非项目相关**的真实竞品深度用户验证通过(30 分钟计时 + 资产零丢失 + 关键动作无需回退原工具)
