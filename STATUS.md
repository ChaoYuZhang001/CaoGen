# CaoGen 项目状态报告

> 更新:2026-07-06 · 基于实测数据,非文档自评。上一份全景见 [MASTER-PLAN.md](./MASTER-PLAN.md)(已部分过时)。

## Context(上下文)

CaoGen 是国产原创的**多厂商 AI 编码桌面工作室**(Electron + React + react-three-fiber,MIT 开源,[GitHub](https://github.com/ChaoYuZhang001/CaoGen)),对标 Codex Desktop / Claude Code / Gemini CLI。核心站位:**不绑定任何单一厂商** —— 一把钥匙接入 DeepSeek/Qwen/Grok/网关/本地模型,任何模型都是真编码 Agent;多会话并行以写实 3D 办公区呈现;每个 Agent 独立 Git worktree 隔离。分工模式:规划方(用户)实测反馈 → Claude 实现并 E2E 验证 → 逐条提交推送。

## Current Status(当前状态)

**v0.1.1 已公开发布**(DMG 5 产物齐全,含自动更新元数据),距 v0.1.0 首发不到 24 小时。已实测验证的核心能力:

| 能力 | 验证 |
|---|---|
| 原生编码 Agent(任何 Chat 协议模型,零外部 CLI) | DeepSeek 真实 E2E 7/7(创建/编辑文件、跑命令) |
| 跨厂商智能路由(全厂商×全模型,auto 切家续上下文) | E2E 6/6 |
| 真子代理编排闭环(结果自动回灌父 Agent) | E2E 6/6;32 并发压测 6/6(2s 全完,$0.0018) |
| Chat/Responses 双协议 + 多轮上下文 + 跨厂商故障切换 | DeepSeek 9/9、网关 Gemini 9/9 |
| 工程工作流:worktree PR、检查点即时回退、逐块 diff、预算闸门 | 深测覆盖 |
| DOM 圈选批注、OCR(macOS Vision)、Hooks、MCP 运行态探测 | 各自真实验证 |
| 3D 办公区(精致小人+光影+失焦省电) | 朝向/主题 bug 已修 |
| 回归体系 | `test:deep` 21/21 全绿 |

五支柱达成度(实测口径):多厂商接入 ~95% · 调度 ~95% · 3D ~90% · 迁移级工作流 ~85% · 长期自主执行 ~80%。

## Goal(目标)

**北极星 N1**:任一主流 Agent(Codex/Claude Code/Gemini CLI/Cursor…)深度用户 **30 分钟内**在 CaoGen 跑通日常主链路,资产零丢失;以五支柱建立代差,做成"世界第一 / 中国首创"验收方向的桌面 AI 编码工作室。

## Next Milestone(下一阶段目标)

**v0.2.0 —— "可日用"(daily-drivable)**:从"功能齐、E2E 过"到"真实用户每天用不弃坑"。判据是真人(先是规划方自己)连续一周日常使用,毛刺清零;而非再堆新特性。

## Action Items(执行事项)

**需要用户的(阻塞项)**
- [ ] 撤销已泄漏的 GitHub token(安全,立即)
- [ ] 日常真用 CaoGen,毛刺截图即报(最高价值输入)
- [ ] `codex login` / `gemini` 登录一次 → 解锁两个原生引擎的真对话验证
- [ ] (可选)Apple Developer 账号 → 签名公证,用户免右键
- [ ] (可选)Grok/OpenAI 充值 → 补这两家的真实 E2E

**Claude 侧(按序)**
- [ ] 用户反馈快修循环(常设,当天修)
- [ ] arm64/universal 打包(当前仅 x64,M 系芯片走 Rosetta)
- [ ] 插件治理下半场:安装 / 版本锁定 / 权限声明
- [ ] 会话全文搜索(U5.1)、聊天头工具栏图标化(U3.3)
- [ ] worktree 冲突三栏审查 + 合并后 checkpoint 验收
- [ ] N1 迁移实测:真人计时走"导入资产→建会话→@文件→改代码→审 diff→提交"

## Risks / Issues(问题)

1. **零真实用户数据**:所有"可用"结论出自 E2E 与自测;N1 从未真人验证 —— 最大的未知
2. **未签名分发摩擦**:macOS 首开需右键绕行,非技术用户流失点(等 Apple 凭据)
3. **仅 x64 打包**:M 系 Mac 用户跑 Rosetta,性能/口碑双损
4. **Codex/Gemini 引擎适配器未经真对话验证**(CLI 已装、探测通过,登录后才能验)
5. **泄漏 token 未确认撤销**(对话记录里有仓库写权限凭据)
6. **插件治理半块**(MCP 探测✅;安装/版本/权限⬜)、**云端 Routines 无**(按约排除)
7. 长会话隐患:chat 协议历史无压缩,超长会话上下文膨胀;OpenAI 引擎工具声明每请求 ~700 token 固定开销

## Optimization Opportunities(优化机会)

- **路由能力表静态**:CAP_TABLE 靠正则档位,可引入按实际质量/延迟/成本的自学习修正(ROADMAP 里的 v2)
- **chat 历史压缩**:超阈值自动摘要旧轮次,保上下文不爆
- **工具声明按需裁剪**:纯问答轮不带 tools,省固定开销
- **3D 规模化**:32+ 工位时实例化渲染/LOD(当前 32 工位可跑但无降级)
- **Responses 协议也接工具循环**(当前仅 chat 协议是编码 Agent)
- **迁移向导深化**:Cursor/Cline/Aider 资产映射矩阵补全

## Success Criteria(成功标准)

v0.2.0 达成 = 以下全部成立:

1. 规划方连续 7 天日常使用,新报毛刺 ≤1 个/天且当天修复
2. arm64 原生包发布,M 系 Mac 免 Rosetta
3. Codex + Gemini 原生引擎各完成 ≥1 次真实对话验证
4. N1 实测:≥1 名真人(可为规划方)按秒表 ≤30 分钟完成迁移主链路,过程录屏留证
5. `test:deep` 保持全绿;每个新特性配真实 E2E,不"编译过即完成"
6. (若凭据到位)签名公证 DMG 上线,首开零警告

—— 长期成功 = 北极星 N1 由**非项目相关**的真实竞品深度用户验证通过。
