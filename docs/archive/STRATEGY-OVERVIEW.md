# CaoGen 战略总览

> 制定日期：2026-07-22
> 性质：把"项目是什么、最终功能、竞品定位、官网/README 诊断、规划问题、可达路径"连成一份总纲。
> 详细执行见 [`EXECUTION-PLAN.md`](./EXECUTION-PLAN.md)（GTM）与 [`DEV-AND-RELEASE-PLAN.md`](./DEV-AND-RELEASE-PLAN.md)（工程/发布）。
> 事实基线以 [`STATUS.md`](../STATUS.md) 为准；本文件是分析与决策，不是能力宣称。

---

## 1. 目标 · 里程碑 · 进展（一页速览）

**定位（愿景）：** 本地优先、厂商中立、可恢复、可审计的 **Agent Work OS**——用户提交目标/约束/预算/验收，CaoGen 组织数字员工、模型、工具完成工作并交付证据。

**现状（实测口径）：** v0.1.6 macOS x64 已发布（未签名）；本地候选 1.0.0 非 stable。PRD 64 个 P0 中约 **5 完成 / 17 部分 / 42 立项目标**。Deep 测试 `150 total / 147 required pass / 3 optional skip / 0 fail`。

**里程碑：** M0 事实重基线 ✅ / M1 Trust 与数据基座 🟡 / M2 原生运行时 🎯 / M3 Workflow+数字员工+Supervisor 🎯 / M4 双模式+项目管理+水墨 3D 🎯 / M5 可验证交付 Beta 🎯 / M6 1.0 🎯 / M7 Team/Cloud（后续）。

**已验证的真差异化：** 多厂商+多 Key+健康+预算+跨厂商 failover；真实 child session+DAG+worktree 隔离+恢复快照；Effect Ledger+强杀恢复；统一工作台+3D 状态可视化。

---

## 2. 最终功能全集（愿景 = 一条数据主链）

最终产品不是功能清单，是一条主链，所有功能挂在上面：

```
ProjectWorkspace → Goal → WorkItem → Assignment(DigitalWorker|Human)
→ Run → ModelAttempt → ToolExecution/Effect/Evidence → Artifact → Acceptance
```

**13 个需求家族（P0/P1 全集，带 ID）：**

1. **双模式** EXP-001~007：Assistant/Studio 共享同一 store，无损切换
2. **统一项目** PROJ-001~007：本地目录从必选主键降为可选资源根
3. **Goal + 轻量项目管理** GOAL/WORK-001~007：Goal 契约、WorkItem 看板/依赖、自然语言生成 DAG
4. **数字员工** TEAM-001~009：CaoGen 内部岗位实例，身份与模型解耦，招聘/职责/预算/绩效
5. **自动跨厂商路由** ROUTE-001~010：默认人工选模型=0，完整故障阶梯
6. **Native Runtime + Supervisor** RUN-001~009：收归执行语义，协议 Adapter 只处理厂商差异
7. **Trust/Effect/审批** TRUST-001~007：高风险副作用登记 Effect 或 fail-closed，未知结果不自动重放
8. **Artifact/Evidence/交付** ART-001~007：完成必须有证据，阶段 Artifact 传递
9. **Routines/记忆/Skill** AUTO-001~005：draft→审批→生效
10. **水墨轻动漫 3D** VIS-001~008：换原创人物表达岗位（现为机器人）
11. **连接器/协作** CONN/COLLAB
12-13. **非功能**：本地优先隐私、可恢复一致性、可审计、厂商中立、性能、可用性

**明确不做：** 外部 Agent CLI 启动器；把模型/Provider 当数字员工；完整 Jira/HR/CRM/ERP；多人实时协作套件；用装饰动画伪造工作；未验证就宣称 Office 像素级编辑/exactly-once。

---

## 3. 双模式 + 竞品定位（关键，已因 2026-07 竞品动态改变）

### 3.1 主流 Agent 有双模式吗？——两周前起，有了

- **ChatGPT Work（2026-07-09 上线）**：把 Chat + Work + Codex 合进一个桌面 App，**不同模式服务不同人群**——Codex 模式露技术细节，Work 模式抽象掉；agent 后台跑几小时**交付成品**（表格/PPT/报告/小 web app）；连 Slack/Gmail/Drive/Salesforce；**定时任务**；GPT-5.6（Sol/Terra/Luna）。
- **Claude Desktop 2026**：Chat + **Cowork**(自主 agent) + Code 三标签；MCP + 一键 `.mcpb` Desktop Extensions；computer use；Opus 4.8/Sonnet 4.6。

**结论（残酷但重要）：** CaoGen 当作"立项目标/差异化"在做的**双模式、agent 交付成品、定时任务、连接器**——OpenAI 和 Anthropic 在**两周前免费/捆绑**上线了。这些已从"差异化"变成"入场券"。

### 3.2 跟 ChatGPT/Claude Desktop 到底差在哪——只有 4 点是结构性护城河

它们绑死自家模型（ChatGPT=OpenAI，Claude=Anthropic）。CaoGen 结构上能做、它们做不了的：

| 维度 | ChatGPT/Claude Desktop | CaoGen |
|---|---|---|
| **厂商** | 锁自家模型 | **多厂商配置 + 跨厂商 failover** |
| **数据** | 云端为主 | **本地优先** |
| **代码** | 闭源 | **开源（AGPL）** |
| **国产模型** | 无一等公民 | **DeepSeek/Kimi/GLM 直连、BYOK** |

**唯一该喊的定位就是这 4 点。** 数字员工、水墨 3D、canonical ledger 这些宏大叙事,不是让用户选择你的理由——**"不锁厂商 + 本地 + 开源 + 国产直连"才是。**

---

## 4. 官网 + README 优化建议（要点）

**共同问题：把"立项目标"和"已发布能力"混在一起讲，容易被读成过度宣称；楔子（厂商中立）没在第一屏喊够。**

- **第一屏 10 秒讲清楚**："不锁厂商的本地 AI 工作桌面——用你自己的 key 跑任意模型，一个挂了自动换。"
- **顶部放 demo GIF**（加 3 家 key → 一个挂了自动切 → 出结果），一个画面胜过所有文案。
- **已发布 vs 长期愿景清晰隔离**：当前能力标 beta，Agent Work OS 愿景单独一段、明确标"建设中"。
- **英文 README**（`README.en.md`）——全球贡献者入口，招人杠杆最高。
- **诚实是招牌，别为 star 吹大**（这是最大风险）。

> 官网源码在 `caogen-website/`，文案集中在 `src/site-config.json`；README 改造细节见 EXECUTION-PLAN §4 任务 1-2。

---

## 5. 规划的问题 + 战略重定位

### 5.1 四个核心问题

- **A. 范围 = 十年愿景，不是可发布产品。** ~100 需求、12 项"1.0 必交付"，是 20-50 人做 2-3 年的量，而你基本一个人。P0 完成度约 9%。按此定义 1.0 可能永远发不出。
- **B. 顺序反了。** 0 用户时把最多工程投在崩溃恢复/账本一致性（成熟产品才需要），把"有没有人要"一推再推。最大风险（零外部验证）被自己点名，却没有一个里程碑是"把 beta 塞给真人"。
- **C. 护城河实时流失。** 大量路线图预算花在竞品刚免费送的东西（双模式/agent 交付），真正独占的（厂商中立/本地/开源/国产）反而在宏大架构里占比小。
- **D. 没有近期用户/收入路径。** 北极星"Weekly Verified Goal Deliveries"在 0 用户时恒为 0，指导不了近期决策；变现依赖被推到 1.0 之后的功能。

### 5.2 你原本的顺序会让四个目标全落空

你的目标：**全功能上线 → 用户 → 志同道合者 → 投资**。
问题：**"全功能才上线"是唯一同时挡住这三个下游目标的事。** 用户要楔子不要全功能；贡献者是造功能的手段不是造完的奖励；投资投牵引力+团队+楔子不是功能完整度。**正确顺序是它的反面。**

---

## 6. 可达路径（你的四个目标怎么真正拿到）

```
发楔子（签名 beta）→ 拿真实用户 + 同时开放贡献 → 牵引力 → 投资 → 带团队做全功能
```

- **全功能**：不是放弃，是**推迟到有人有钱之后**带团队做。
- **用户**：楔子（已能用）+ 签名下载（管线已通，只是被门禁锁住）+ 去 r/LocalLLaMA/HN/V2EX 发。
- **贡献者**：拆大文件 + 英文 README + 10 个 good-first-issue + 快合并——**这就是招人的动作本身，不是有用户之后才做**。
- **投资**：用牵引力数字谈，参照 Dify（中国人开源 AI，靠用户+star 拿融资）；楔子贴信创/国产化/数据不出境主题。

**详细执行：**
- **GTM 6 阶段**（切楔子→能装→能懂→能贡献→发布获客→牵引力→投资）→ [`EXECUTION-PLAN.md`](./EXECUTION-PLAN.md)
- **开发+发布**（版本策略、Beta 门禁降级、发布 runbook、周节奏）→ [`DEV-AND-RELEASE-PLAN.md`](./DEV-AND-RELEASE-PLAN.md)

---

## 7. 现在就能做的三件最高杠杆的事

1. **解锁签名版**：把"发签名 beta"从"全功能 1.0 门禁"里拆出来，用现有脚本跑轻量 Beta 门禁，本周发 0.2.0 签名版（DEV-AND-RELEASE §3）。
2. **仓库改造招人**：让 Sol 执行 README/英文/CONTRIBUTING/good-first-issues（EXECUTION-PLAN §4）；你合并前扫一遍别夸大。
3. **暂停过早优化**：ledger v9/native runtime/水墨美术先停，时间全投"让人用上"。

> **一句话：功能是终点不是起点。先把一小片"不锁厂商"的楔子推出门，让世界看到它活着——用户、同好、投资都从这里开始，不从"全做完"开始。**

---

## 来源（竞品事实，2026-07 联网核对）

- ChatGPT Work / GPT-5.6：[OpenAI 官方](https://openai.com/index/introducing-chatgpt-agent/) · [9to5Mac 报道](https://9to5mac.com/2026/07/09/openai-announcing-the-next-chapter-for-chatgpt-today-watch-here/)
- Claude Desktop 2026（Chat/Cowork/Code + MCP）：[Suprmind 汇总](https://suprmind.ai/hub/claude/features/) · [a2a-mcp](https://a2a-mcp.org/entry/claude-desktop)
