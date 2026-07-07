# CaoGen 通往终极目标的总计划

> 制定 2026-07-05。这是一页看清"从现在到终极目标"的全景图。
> 事实基础:10 路代码审计 + T1/T2 实测 + [REQUIREMENTS.md](./REQUIREMENTS.md)。
> 分工现状:规划方出计划 → Codex 执行 → 规划方逐条 E2E check。

## 终极目标(一句话)

**让 Codex/Claude Code/Gemini CLI/Cursor 等所有主流 Agent 的深度用户 30 分钟丝滑迁移到 CaoGen、资产零丢失**;以"世界第一 / 中国首创"为验收方向。靠五支柱建立代差:多厂商接入 · 双模式调度 · 写实 3D 办公区 · 迁移级深度工作流 · 长期自主执行。

## 当前位置(2026-07-05,基于实测)

| 支柱 | 完成度 | 说明 |
|---|---|---|
| 多厂商接入 | ✅ ~95% | Provider/网关/国产直连/自动拉模型/故障切换全通;仅 Codex/Gemini 原生引擎待装 CLI 验证 |
| 双模式调度 | ✅ ~90% | 手动+自动+健康度+故障切换全通;预算闸门缺(T8) |
| 写实 3D 办公区 | ✅ ~90% | 房间/家具/小人/漫游/厂商吉祥物/Bloom 全通;子代理真实任务流刚接(T3 待 check) |
| 迁移级工作流 | 🟡 ~80% | @文件/图片/终端/worktree/Git提交/逐块diff/预览全通;检查点chat上下文缺(T9) |
| 长期自主执行 | 🟡 ~75% | 记忆注入/Routine定时/记忆UI/开工建议/自动提议/子代理陆续接通;云端Routines缺 |

**加权"已验证可用" ≈ 78%**(T1/T2 已 check 实测;T3–T7 已提交待 check)。

## 从这里到终极目标:三段路

```
现在(78%) ──段A:收口验证──→ 85% ──段B:攻坚剩余真特性──→ 92% ──段C:产品化冲线──→ 可发布
```

### 段 A · 收口验证(78%→85%)—— 进行中,风险最低回报最高

Codex 已提交 T1–T6、在做 T7。这段的关键不是写新代码,而是**逐条 E2E 验证"接线了但可能运行时坏"**(历轮经验:并行产出约 1/3 藏运行时 bug)。

- **A1 check T1 应用内 Git 提交** —— ✅ 已完成(实测:stage/commit 落地、守卫齐全、防注入)
- **A2 check T2 逐块 diff** —— ✅ 已完成(实测:接受一 hunk 暂存、丢弃一 hunk 还原,精确)
- **A3 check T3 子代理结果回传 + 3D 真实任务流** —— ✅ 已完成(实测:Electron mock E2E 派发真实 parent/child sessions,父会话收到 2 个 subagent-result 与编排汇总,3D office 生成 Subagent packets 且 WebGL 非空;证据:`test-results/orchestration-mock-e2e/2026-07-06T18-19-20-667Z/orchestration-mock-e2e.json`,`test-results/caogen-deep/2026-07-06T18-19-39-919Z/deep-test-report.md`)。
- **A4 check T4 开工建议** —— ✅ 已完成(实测:Electron mock E2E 会话激活后渲染开工建议面板,memory/routine/history/worktree/git/package 来源映射正确,失败建议分支触发,忽略/发送建议写入真实 transcript;git timeout 降级由 smoke 覆盖;证据:`test-results/start-suggestions-e2e/2026-07-06T18-42-20-712Z/start-suggestions-e2e.json`,`test-results/caogen-deep/2026-07-06T18-40-44-540Z/deep-test-report.md`)。
- **A5 check T5 记忆自动提议** —— ✅ 已完成(实测:Electron mock E2E 发送含"记住/约定"消息后渲染"记住这条约定?"提示;同会话同文本 30s 内节流去重;接受后只打开 MemoryPanel 并预填 convention 表单,项目 drafts 仍为 0;证据:`test-results/memory-suggestion-e2e/2026-07-06T18-53-18-912Z/memory-suggestion-e2e.json`,`test-results/caogen-deep/2026-07-06T18-52-22-641Z/deep-test-report.md`)。
- **A6 check T6 浏览器批注截图** —— 待做。验收:网页批注 → screenshotPath 有真实 PNG;重点查 view 不可见时不截空白图。
- **A7 check T7 Routine 首帧下次运行** —— 待做(小改进)。
- **门槛**:每条 E2E 实测通过或修复;发现的 bug 记录并让 Codex(或规划方)修。段 A 完成 = T1–T7 全部实测可用。

### 段 B · 攻坚剩余真特性(85%→92%)—— 需新建,非纯接线

- **B1 T8 预算闸门** — 会话累计 costUsd 超预算时 send 前拦截;settings/provider/routine 三级预算。补齐"长期自动化不失控"这一可信度承诺。
- **B2 T9 检查点 chat/both 回退 SDK 上下文** — 用 SDK `resumeSessionAt` 让回退真正影响 agent 记忆(现仅截断 CaoGen 转录)。补齐迁移级工作流最后短板。
- **B3 子代理编排深化** — T3 打通回传后,把"主 Agent 自然语言派活 → 自动拆解 → 并行 → 汇总"做成一条顺畅工作流(现需手动在 SubagentPanel 填);3D 协作动画绑真实任务流。
- **B4 国产模型一等公民收尾** — 核对 DeepSeek/Kimi/智谱官方直连预设(baseUrl/模型名/端点已修 DeepSeek),补全其余;能力表覆盖国产档位。
- **门槛**:五支柱各自的"可验收标准"(见 REQUIREMENTS P1–P5)逐条打勾。

### 段 C · 产品化冲线(92%→可发布)

- **C1 T10 打包签名 + 自动更新** — electron-updater + publish 配置 + macOS 签名/公证(需 Apple 证书,规划方/用户提供凭据)+ 更新链路接 UI。产出可分发、能自更新的签名 DMG。
- **C2 迁移向导实测** — 找一个真实 Codex/Claude 用户资产(rules/MCP/技能)走一遍导入,验证 N1"30 分钟迁移、资产零丢失"。
- **C3 全链路回归** — 打包版跑一轮完整冒烟(建会话→编码→审 diff→提交→合并→检查点→记忆→routine),确认无回归。
- **C4 云端 Routines(可选,视需求)** — GitHub Actions 桥接先行,自建 Runner 视反馈评估。
- **门槛**:签名 DMG 可安装运行、自动更新验证到位、迁移向导实测达标 = 可对外发布第一版。

## 里程碑

| 里程碑 | 内容 | 判据 |
|---|---|---|
| **M-A 收口完成** | T1–T7 全部 E2E 验证可用 | 段 A 门槛 |
| **M-B 支柱达标** | 五支柱可验收标准全打勾 | 段 B 门槛 |
| **M-C 可发布** | 签名 DMG + 自更新 + 迁移实测 | 段 C 门槛 |
| **M-终极** | 真实竞品用户 30 分钟迁移成功 | 北极星 N1 |

## 不变的执行纪律(每个任务)

1. `npm run typecheck` + `npm run build` 必须通过。
2. 六环链路(主进程→ipc→preload→types→store→UI)齐全才算接通。
3. 每个功能 **E2E 实测**(CDP 驱动真机),不靠"编译过"下结论。
4. 状态如实标注(✅/🟡/🧩/⬜),不宣称未验证的功能。
5. 热点文件串行改;每任务独立提交,说明做了什么+怎么验证。

## 现在的下一步

Codex 做完 T7 后,规划方执行**段 A 剩余 check(A6–A7)** —— 这是当前投入产出比最高的动作:把"已提交 78%"坐实为"已验证 85%",同时揪出并修掉并行产出的运行时隐患。之后进入段 B(T8/T9)。

