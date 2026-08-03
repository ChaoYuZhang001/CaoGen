# CaoGen 项目计划(唯一执行纲领)

> 本文档是 CaoGen 当前唯一的项目计划。它取代并收敛此前三代规划文档
> (ROADMAP.md / MASTER-PLAN.md / PLAN-FOR-CODEX.md / docs/PROJECT-PLAN.md /
> docs/EXECUTION-PLAN.md / docs/DEV-AND-RELEASE-PLAN.md 等)。
> 愿景定义见 docs/PROJECT-CHARTER.md,实时完成状态见 STATUS.md。
> 旧文档移入 docs/archive/ 仅作历史存档,不再更新。

- 制定日期:2026-07-23
- 最近校正:2026-07-30(外部 Effect 批次与“集中开发、统一测试”节奏)
- 状态:已生效
- 决策人:创始人

---

## 1. 完整目标(最终愿景,不变)

**CaoGen:集成主流 Agent 核心能力、本地优先、厂商中立、用户可自定义、可恢复、可审计的 Agent Work OS。**

用户提交目标,CaoGen 在同一产品内组织代码、办公、知识、自动化、协作和跨端能力,调度数字员工、模型和工具,持续产出可恢复、可审查、可验收的结果。Provider、模型、Base URL、Key、本地服务、Skill、MCP、连接器、工具和路由政策均由用户选择或自定义。

### 1.1 最终功能体系(12 项立项目标,即 1.0 完成定义)

1. 统一 Project Workspace
2. Goal Contract(目标、边界、预算、审批、验收标准)
3. 轻量项目管理(WorkItem / Board)
4. 内部数字员工(模型只是可替换算力)
5. Assistant / Studio 双模式,无损切换
6. 自动跨厂商模型路由与故障恢复阶梯
7. 持久 Workflow Ledger
8. Native Runtime 统一执行语义 + 协议 Adapter
9. 可验证交付(Artifact / Evidence / Acceptance)
10. 本地 Supervisor(长期任务、桌面关闭前可恢复)
11. 水墨轻动漫 3D 数字团队(投影真实状态,不伪造工作)
12. 数据迁移、导出、删除与多客户端兼容

### 1.2 结构性差异化(对外只讲这 4 点)

| 维度 | ChatGPT / Claude Desktop | CaoGen |
|---|---|---|
| 厂商 | 锁自家模型 | 多厂商 BYOK + 跨厂商 failover |
| 数据 | 云端为主 | 本地优先 |
| 代码 | 闭源 | AGPL 开源 |
| 国产模型 | 非一等公民 | DeepSeek / Kimi / GLM 直连、中转站 |

双模式、agent 交付、定时任务、连接器是**入场券,不是差异化**——竞品已经免费送。
数字员工、水墨 3D、canonical ledger 是工程叙事,不作为获客卖点。

**正式竞品体系更新(2026-07):**Codex / Claude Code 是直接竞品;WorkBuddy 是办公场景
竞品;Multica 是协作平台竞品;CC Switch 是配置入口竞品;Marvis 是常驻助手心智竞品。
不做总排名,只回答每一层抢走用户的原因。CaoGen 的主动定位是**集各家核心优势于一体、
厂商中立、本地优先、用户可自定义的 Agent Work OS**。它原生提供直接竞品的工程执行、
WorkBuddy 的成品体验、Multica 的任务协作、CC Switch 的配置效率和 Marvis 的跨端接续;
Agent Execution Control Plane 是统一这些能力的内核,不是产品上限。CaoGen 不复制封闭生态
或生活陪伴定位,也不把未经 Runtime/Trust/Artifact/Acceptance 管理的外部 CLI 伪装成
DigitalWorker。
完整事实、证据边界和矩阵见 `docs/COMPETITOR-GAP-ANALYSIS.md`。

### 1.3 明确不做

- 不做外部 Agent 启动器(Codex / Claude Code / Gemini CLI 不是数字员工)
- 不自研基础模型
- 不复制 Jira / HR / CRM / ERP / Office / 聊天 / 会议产品
- 不用随机动画伪造工作状态
- 不以隐藏模型差价或强制特定厂商作为收入来源

---

## 2. 完成度口径(全项目统一,唯一)

废弃所有百分比口径(78%、9% 等)。统一使用三级状态,数字以 STATUS.md 实测为准,
README、官网、STATUS 三处必须一致:

- **已验证**:通过正式验收并绑定可追溯证据
- **部分完成**:有代码/界面/targeted evidence,但契约、恢复、跨 Provider 连续性或发布绑定未闭环
- **立项目标**:1.0 完成定义,不代表当前能力

当前基线(2026-07-31,以 STATUS.md 和机器验收映射为准):64 个 P0 中 21 个已验证、
43 个开放。最近 clean/public 快照把开放项分为 19 个部分完成、23 个立项目标和 1 个
仅达到基础；较新的 dirty-worktree 结构投影为 30 个部分完成、12 个立项目标和 1 个仅达到
基础。两者都不是版本完成率或发布绑定，最终分类须在冲突清理后的精确 clean 提交上重跑。
官网旧的"5 完成/17 部分/42 立项"口径已于 M1-T4 对齐并增加四分类总和门禁。

---

## 3. 阶段性里程碑

只有这一套里程碑编号。旧文档中的 M0-M15、M-A/B/C、立项 M0-M7 全部作废。

### M1:macOS 正式版 + Windows 预览版 v0.1.7(目标:2 周内)

**目标:把 macOS 正式签名/公证版与明确标注的 Windows unsigned preview 交到陌生人手里。**

- [x] M1-T1 提交并整理本地未提交的全部工作(约一周量),git 历史恢复连续(PR #7)
- [x] M1-T2 版本号定为 0.1.7(package.json 从 1.0.0 回退,延续 0.1.x 发布线);1.0 版本号预留给完整 Work OS
- [ ] M1-T3 发布范围后续门禁：保留已完成的 v0.1.7 macOS Intel x64 正式签名、公证与安装启动证据；当前目标为 macOS 正式签名/公证交付与明确标注的 Windows x64 `unsigned preview`。Windows 正式跨平台门禁在取得 Authenticode 证据前保持 blocked
  - [x] Intel x64 本地签名基线:Developer ID、Hardened Runtime、45/45 Mach-O、DMG/ZIP 内签名和真实 renderer 启动已验证;该基线未公证,不得发布
  - [x] 0.1.7+ 发布门禁硬化:未通过 required macOS audit、公证/staple 或包内 clean-commit provenance 绑定时,Release Doctor 必须保持 `packaging_release` open
  - [x] 0.1.7+ 正式跨平台矩阵门禁保持 fail-closed:macOS x64、macOS arm64、Windows x64 必须各自通过正式签名/公证审计、clean-commit provenance、原生安装和 renderer 启动;最终 packaging audit 必须同时绑定 12 项正式发布资产
  - [x] macOS 签名只对 Apple 时间戳服务瞬时错误执行最多 5 次有界重试;证书、entitlement、Keychain 与其他签名错误立即失败
  - [x] 手动候选管线已固化:`workflow_dispatch` 只接受已在 `main` 的完整 commit SHA;支持 Intel-only 或完整三平台范围;只上传未发布候选证据包,不自动建 tag/Release
  - [x] `main@7a0a4babb9fae90b68c8deef63e185bd44527b5c` 的 Intel-only 候选在 GitHub run `30130085556` 完成 exact-commit Deep、Developer ID 签名、notarize、staple、Gatekeeper、required release audit、DMG 安装和真实 renderer 启动
  - [x] 运行时收口为 OpenAI-compatible + 原生 Anthropic Messages，删除 Claude Agent SDK、Claude CLI、SDK 专属会话/检查点/Hook/UI 与打包规则；基础发行包必须审计为不含 SDK/CLI
  - [x] 删除 Claude Runtime 后的本地 unsigned Intel x64 实测：DMG `125,638,991 B`、ZIP `125,002,021 B`、`.app` `311,931,918 B`、`app.asar` `61,630,882 B`；package audit 证明 SDK/CLI 不在 ASAR 或 unpacked files，预算收紧为 `160 MB / 160 MB / 400 MB / 80 MB`
  - [x] `main@ee13fffe5ca0e8576ea448fd3253e7cd9cfa9fb8` 的 Intel-only 候选在 GitHub run `30148489031` 完成 clean exact-commit Deep（`154/154` required，2 optional skip）、Developer ID 签名、公证/staple、Gatekeeper、`106/106` required audit、DMG 隔离安装/干净 detach、真实 renderer 与最终资产绑定；签名 DMG `127,703,488 B`，ZIP `127,016,797 B`
  - [x] `main@e8f617f822be458065dabe7f2440d1f5a33ee2b3` 的 Intel-only 最终候选 run `30150795350` 成功：Deep `155/155` required、2 optional skip，`120/120` required macOS audit，五资产 `latest-mac.yml` 元数据、签名/公证/安装/renderer 与 clean provenance 全部绑定；资产集 `0fc626d9ccc3038ca5b3e574b87692f5ec7778c0670b2a6a4139fd804dba216d`
  - [x] `main@bbec526554aea9785291edf4d8164084145347ae` 的当前 Intel-only 最终候选 run `30162696430` 成功：Deep `157/157` required、2 optional skip，`120/120` required macOS audit，Developer ID 签名、公证/staple、Gatekeeper、DMG 隔离安装/干净 detach、真实 renderer 和五资产 clean provenance 全部绑定；资产集 `7553d1ef33ec44d69e7b95c74aee8fcb7500a68daf008ed343e66ae3345a036c`
  - [x] 正式跨平台候选管线已固化:`workflow_dispatch` 只接受已在 `main` 的完整 commit SHA;macOS Intel、Apple Silicon、Windows x64 三条原生 lane 并行生成正式签名/安装/启动证据。Windows 正式证书采购前该管线与 Release Doctor 必须保持 blocked,不得把 preview 证据塞入正式矩阵
  - [x] Windows preview 独立配置与审计:强制关闭证书自动发现/签名,安装包文件名固定包含 `windows-x64-unsigned-preview`,不生成稳定更新元数据,并要求 Windows x64 原生安装、renderer 启动与卸载证据
  - [ ] 在新的最终 clean commit 上刷新 macOS x64 notarize、staple、Gatekeeper 与 required release audit；历史 v0.1.7 证据不自动绑定后续源码
  - [ ] 在 Apple Silicon 真机完成 arm64 原生签名、公证、安装和启动证据
  - [ ] 在 Windows x64 生成 unsigned preview,完成安装、启动、卸载证据并验证 SmartScreen/安装说明
- [x] M1-T4 三处口径对齐:README、官网、STATUS.md 的完成度数字与措辞一致
- [x] M1-T5 文档收敛:旧规划文档移入 docs/archive/,README 增加对比表与可见 Roadmap
- [x] M1-T6 发布 v0.1.7,Release Notes 只写当前真实能力,不写路线图功能
  - [x] Intel-only final gate 已支持精确五资产与四类候选报告绑定，不再错误要求暂停的 Apple Silicon/Windows 证据
  - [x] run `30150795350` 的最终候选五资产与四类报告已下载并独立核验；Release Notes 已按实算 SHA256 定稿，并在 clean 后继提交上通过 scoped final audit（全候选绑定检查 true，0 warning / 0 failure）
  - [x] 新增只读、fail-closed 的发布交接预检，绑定候选证据、精确五资产、Release Notes、publication-only 后继提交、远端 `main` 及 tag/Release 不存在状态；仅在全绿后输出需明确授权的手工命令，不产生发布副作用
  - [x] 公开 GitHub Release 资产审计升级为逐文件名称、大小与 SHA-256 digest 对本地候选资产精确绑定，并以回归测试覆盖篡改、缺失 digest 和额外文件
  - [x] 发布自动化源码变化使 run `30150795350` 只保留为历史证据；`bd26eaa3` 的 run `30159248949` 暴露 ModelAttempt crash E2E 测试夹具竞态后，worker keepalive 修复本地 targeted 连续 `20/20` 通过。修复提交 `cfce9372` 的 run `30160236851` 已通过主链；PR #8 合并使远端 `main` 前进后，`bbec5265` 的 Intel-only run `30162696430` 重新通过同一 exact-commit Deep、签名/公证/安装与 renderer 主链
  - [x] run `30162696430` 的候选五资产和四类报告已下载并独立核验，Release Notes 已更新为新 SHA-256；创始人明确授权后，clean、已推送的 publication-only 后继提交 `d8e883a2` 通过 fail-closed 发布交接预检
  - [x] 创建 annotated tag `v0.1.7` 和正式 GitHub Release，上传精确五项 Intel 资产；公开资产审计 `5/5`、0 warning / 0 failure，官网中英文首页与文档入口已同步
  - [x] 发布完整性门禁补强：`docs/RELEASE-NOTES-FINAL.md` 现在作为远端正文、精确资产名称集合和 SHA-256 digest 的版本控制合同；GitHub Actions 每 6 小时及手动执行只读审计。Windows unsigned 工作流只上传显式 `unsigned-preview` Actions artifact，不再携带 `latest.yml`，手动运行必须确认 preview-only
  - [ ] 修复 2026-07-26 远端发布回归：v0.1.7 在原五资产发布后被追加 3 个 Windows 资产，Release 正文也改为八资产/Windows unsigned；当前 Notes 合同审计按设计失败。Windows build run `30192957144` 只有只读权限并未发布，3 个资产是在 run 完成后单独上传。删除资产与恢复正文等待创始人明确授权，未恢复前不得重新标记公开发布审计通过
    - [x] 关闭与当前暂停 Windows 范围冲突的旧 [PR #6](https://github.com/ChaoYuZhang001/CaoGen/pull/6)；该 PR 试图把 v0.1.6 Windows 八资产文档合入 `main`，现保留分支但不会误合并
  - [x] 按用户问题 patch 规则刷新 v0.1.8 macOS Intel-only 候选：`main@9591c20bde2330a6f57951e7381b5e7e9d642091` 的只读 run `30215660873` 已覆盖 v0.1.7 tag 后的首用引导、Provider 恢复、删除项目草稿解绑、首任务重启恢复与异步目录 hydration 修复，并完成 exact-commit Deep `163 total / 161 required pass / 2 optional skip / 0 fail`、`120/120` macOS audit、签名、公证、安装、renderer、packaged-app 与五资产绑定；资产集 digest `b5e03719796ea3236fab617c8e1493a238e3a07e48552daa1dc74b04f7d27252`。五项资产已独立下载并复算一致；`837f8f90 / 30212121353` 降为更早历史证据。Apple Silicon/Windows 继续暂停；本项只证明该精确提交，不授权创建 tag/Release
  - [x] 等待期功能修复收口后重跑 v0.1.8 clean Intel 候选：`main@03c3fee2837d120fce43f4b7d11bd25488be4d36` 的只读 run `30243108279` 已覆盖 Browser/Preview 发送可靠性后继，完成 exact-commit Deep `163 total / 161 required pass / 2 optional skip / 0 fail`、P2、`120/120` macOS audit、Developer ID 签名、应用公证/staple、Gatekeeper、DMG 隔离安装/干净 detach、真实 renderer 与 packaged-app smoke。Actions artifact `8644829708` 的 `255,552,267 B` ZIP 已用可续传 Range 独立重组，SHA-256 `ec343fe823c5e3a3502c4b6176d23dd59b46dd3e15c2338b06eab98f7384c16a` 与 GitHub 一致；五资产、四类报告、更新元数据、纯 x86_64、provenance、codesign、应用票据及 Claude SDK/CLI 缺失均独立核验，资产集 digest `2abe8622e3b37873e69abdd5deb1f16c8739336181688eeb2e665c601792ff52`。精确 Final Notes 和四类报告曾在 clean、已推送的 publication-only 后继上通过 scoped notes/handoff preflight，结论当时为 `ready_for_owner_decision` 且 tag/Release/upload 副作用均为 false；后续产品源码已继续前进，因此本项整体降为历史证据，不再授权或支持当前发布
- [ ] M1 退出验收:首位陌生用户从官网下载、无安全绕过安装并按 Quick Start 完成第一个只读任务
  - [x] 固化独立于 N1 迁移的五步演练指南、私有结果模板和 fail-closed 机器审计；绑定 `v0.1.7`、候选提交、公开 DMG SHA-256、Intel 架构、30 分钟、零修改与四份独立证据
  - [x] 失败演练支持 `--observation` 保存 `observed_failed`，不冒充通过；负向 smoke 覆盖超时/卡点、required 拒绝、错误哈希、安全绕过、arm64、敏感字段和重复/符号链接证据
  - [x] 私有证据准备命令已创建 `0700` 目录和 `0600` 模板/清单，拒绝仓库内路径、符号链接、非空目录与覆盖；中英文 README、[Discussion #9](https://github.com/ChaoYuZhang001/CaoGen/discussions/9) 与 `CaoGen-Website@f8e8c50` 生产下载区均已公开招募入口；GitHub About 已补官网链接，原招募帖已从 General 原地移到 Announcements，未新建重复渠道
  - [x] 私有结果 schema v2 与机器审计已强制绑定录屏前明确同意、唯一证据用途、最长 30 天保留、`deleteBy`、脱敏复核和真实删除状态；文件仍存在或审计未完成时不得声称已删除，招募帖同时接受不含敏感信息的候补名单
  - [x] clean `main@d424d6c2be8ce4b0c0b3237d7255a9740495a3c1` 完整 Deep 为 `163 total / 161 required pass / 2 optional skip / 0 blocked / 0 fail`，开始/结束均为 clean 且 Git 状态未变；两个 M1 smoke 均在 required 集合中
  - [x] 社区 SLA 修复与证据治理合并后的 clean `main@0874f5a71f890403c008100889c5eb339eb57f98` 完整 Deep 仍为 `163 total / 161 required pass / 2 optional skip / 0 blocked / 0 fail`；报告 `2026-07-26T06-11-06-988Z` 起止均绑定该提交、clean 且 Git 状态未变，远端 `discussion_comment` Actions run `30190540484` 同时通过
  - [x] 等待测试者期间修复新会话草稿的失效项目绑定：项目被删除或归档后立即切到“未关联项目”，输入原目录不会静默重建已删项目。clean 功能候选 `7ed1b5fb4e7d414587734f8c660aca8b8c40bad9` 的完整 Deep 报告 `2026-07-26T15-42-01-402Z` 为 `163 total / 161 required pass / 2 optional skip / 0 blocked / 0 fail`，起止均绑定该提交、clean 且 Git 状态未变；其中 page operations 为 `22/22`。该工程修复不替代陌生用户真人结果或公开 Release 完整性恢复
  - [x] 等待测试者期间修复首任务持久草稿的异步目录 hydration：Project/Provider 尚未加载时保留绑定，加载完成后才判断删除、归档、无密钥、无模型或固定模型失效；失效 Provider fail-closed 解绑且不静默切换，用户通过真实 Provider 编辑器重建配置时其余草稿保持。真实 Electron `2026-07-26T18-41-31-736Z` 为 `11/11`、8 张截图，页面操作 `2026-07-26T18-42-00-814Z` 为 `22/22`；clean `main@9591c20b` 的 run `30215660873` 已把该修复纳入 exact-commit Deep、签名、公证、安装与 renderer 候选证据。工程通过仍不能替代真人 M1 或 v0.1.7 Release 完整性恢复
  - [x] 等待测试者期间修复固定模型切换 Drive 被错误清空：有效 Provider/模型继续保留，只在模型真实失效时 fail-closed；新 Drive 的默认权限仍同步更新。真实 Electron `2026-07-26T20-07-47-489Z` 为 `12/12`、9 张截图，页面操作 `2026-07-26T20-08-40-109Z` 为 `22/22`，build/typecheck 通过；该修复已进入 `03c3fee2 / 30243108279` 的 clean Deep 与签名分发候选，仍不能替代真人 M1 或 v0.1.7 Release 完整性恢复
  - [x] 等待测试者期间修复运行中重复发送导致的草稿丢失与假排队：Composer 运行中可继续起草但发送被禁用，Browser 批注和产物 Preview 也遵守同一忙碌门禁；主进程未确认接受前不清空文本/附件，拒绝时撤回乐观消息、恢复原状态，IPC/IDE Bridge 如实返回失败，记忆建议与自动提取不再由被拒消息触发。真实 Electron live-switch `2026-07-27T03-28-37-915Z` 为 `6/6`，页面操作 `2026-07-27T03-26-54-546Z` 为 `22/22`；clean Deep `2026-07-27T03-30-22-412Z` 与候选 run `30235833246` 已绑定 `1707a999`，候选资产也已独立核验。工程通过仍不替代真人 M1 或 v0.1.7 Release 完整性恢复
  - [x] 等待测试者期间修复 Browser 批注发送失败被吞掉：发送入口显示发送中/成功/失败，只有 `idle/error` 会话可发，`starting/running/closed/undefined` 全部禁用，Preview 共用门禁同步收紧。真实 Electron 页面操作 `2026-07-27T05-08-28-234Z` 为 `22/22`，成功回执截图人工复核无溢出/重叠；Preview required smoke 覆盖状态矩阵，build/typecheck/编码标准 required 通过，`BrowserPanel` 主函数由 184 行/复杂度 15 降至 170 行/复杂度 11。该修复已由 clean `03c3fee2` 的本地 Deep 与 run `30243108279` 的 Intel 签名候选完整绑定
  - [x] 等待测试者期间修复 IDE/Routine/开工建议发送假成功：IDE 创建结果等待并暴露 `initialMessageAccepted`，Routine 拒绝提示词时记失败并清理空会话，建议拒绝时保留入口并显示错误，异步结果绑定原会话。IDE/Routine/建议负向 smoke、P1/default P2、真实 VS Code Extension Host、Assistant/Studio live-switch、build/typecheck/编码标准 required 已通过；完整 P2 release-scope 因本机缺 Gradle/JetBrains 插件产物和真人 IDE 交互证据而失败。两条新负向 smoke 已加入 Deep 清单
  - [x] 为本次发送可靠性后继完成 clean Deep：`main@3229c7af0ed05fd99f82c79ce5e7fd81f04e3506` 的 `2026-07-27T08-45-57-258Z` 报告为 `165 total / 163 required pass / 2 optional skip / 0 blocked / 0 fail`，起止均为同一提交、工作树 clean 且 Git 状态未变；新增 Routine/建议发送 smoke 均为 required pass
  - [x] 等待测试者期间修复快照多步骤续跑静默拒绝：自动恢复与 Supervisor 显式恢复共用顺序协调器，一次只发一步，只有成功 `turn-result`、引擎回到 `idle` 且 ModelAttempt 门禁刷新通过后才继续；恢复期间普通发送不可插队，拒绝、失败、门禁刷新失败或关闭均停止后续自动续跑并留下明确事件。负向/竞态 smoke 已加入 `test:task-run` 和 Deep required 清单
  - [x] 为快照顺序恢复后继完成 clean Deep：`main@3fb95befa8566bfd90890a51abe279350b3225f7` 的 `2026-07-27T14-37-45-555Z` 报告为 `166 total / 164 required pass / 2 optional skip / 0 blocked / 0 fail`，起止均为该提交、工作树 clean 且 Git 状态未变；新增快照回放 smoke 为 required pass
  - [x] 等待测试者期间修复自由子代理编排静默拒绝：child 首条任务被拒绝时立即记为失败并发出结果/hook，不再永久 pending；父汇总只有 `send()` 明确接受后才释放状态，忙碌时等待、拒绝时保留并在后续恢复事件重试，不重复已接受消息。专项负向 smoke 已加入 `test:task-run` 与 Deep，真实 Electron 编排 E2E 通过；`sessionManager.ts` 同时由 1851 行降到 1798 行
  - [x] 为自由编排可靠性后继完成 clean Deep：`main@b2f967d6b642c79877bd5a3ce1ac83b402608368` 的 `2026-07-27T15-51-27-833Z` 报告为 `167 total / 165 required pass / 2 optional skip / 0 blocked / 0 fail`，起止均为该提交、工作树 clean 且 Git 状态未变；新增编排可靠性 smoke 为 required pass
  - [x] 等待测试者期间修复模型交叉验证静默拒绝：第二模型复核/第三模型仲裁的首条指令只有在 `send()` 明确接受后才报告启动；拒绝或同步异常会清理 child 关联并向父会话发出带原因的 hook，避免假启动与永久 pending。专项 smoke 覆盖接受、拒绝和同步异常，完整 P2、build、typecheck 与编码标准 required 通过
  - [x] 为模型交叉验证可靠性后继完成 clean Deep：`main@85daf906a917cf1ab44a5f2ce5586e63c4072763` 的 `2026-07-27T16-31-50-392Z` 报告为 `167 total / 165 required pass / 2 optional skip / 0 blocked / 0 fail`，起止均为该提交、工作树 clean 且 Git 状态未变；`modelCrossValidation` smoke 为 required pass
  - [x] 将 `attachments:copyImage` 与 `attachments:saveImageBytes` 接入 opaque `attachment_write` Effect：图片在进入 Gateway 前冻结并校验，Effect 只记录 `contentSha256`、`bytes`、`mime`、`source`，不记录 Base64、二进制或源路径；落盘前再次校验摘要、大小、MIME 与 5 MiB 上限，未知结果进入 `waiting_reconciliation` 且禁止自动重放。强杀 E2E 覆盖 durable-before-write、成功、失败、SIGKILL、人工对账和 SQLite 敏感输入缺失
  - [x] 将 `projectContext:write` 接入 queryable `file_content` Effect：持久化屏障先于 `caogen.md` 原子写入，项目规则正文不进入任务数据库，符号链接目标 fail-closed；SIGKILL 后按精确摘要确认，用户后续改写时保持 `waiting_reconciliation`，确认/分歧恢复都不重放写回调
  - [x] 为项目规则 Effect 后继完成 clean Deep：`main@2dc74a4105f345a69d2599032e32da2dae8d1eb8` 的 `2026-07-27T20-17-23-998Z` 报告为 `170 total / 168 required pass / 2 optional skip / 0 blocked / 0 fail`，起止均绑定该提交、工作树 clean 且 Git 状态未变；inventory v3 仍锁定 156 IPC、52 Agent 工具、79 嵌套动作，并把 direct-user 外部 IPC 从 23 收敛到 22
  - [x] 将 `plugins:probeMcp` 接入 opaque `mcp_probe` Effect：持久化屏障先于 stdio 子进程或 HTTP 探测，Effect 只保存 `idDigest`、`configDigest` 和 transport，不保存 URL、命令、参数、环境变量、Header、凭据或服务错误正文；服务不可达仍作为已完成探测结果，未知结果进入 `waiting_reconciliation`，禁止自动重放，两个 Renderer 入口都会刷新恢复面板
  - [x] 为 MCP 探测 Effect 后继完成 clean Deep：`main@04e1d29a1abd1e23c917a64d5eae8225736391e7` 的 `2026-07-27T21-34-21-748Z` 报告为 `171 total / 169 required pass / 2 optional skip / 0 blocked / 0 fail`，起止均绑定该提交、工作树 clean 且 Git 状态未变；inventory v4 锁定 156 IPC、52 Agent 工具、79 嵌套动作，IPC policy 为 11 queryable、3 opaque、21 direct-user、6 delegated
  - [x] 将 `plugins:installLocal` 与 `plugins:uninstall` 接入 queryable managed-plugin Effect：执行前冻结插件名、根/锚点身份、源/旧版本 SHA-256、文件数、字节数和同根 staging/trash 相对路径，Ledger 不保存源路径、源内容或原始错误；安装经 staging 摘要复核后原子切换，覆盖/卸载把旧版本原子移入冻结回收站。递归源、符号链接、特殊文件、超过 50,000 条目或 200 MiB fail-closed，且插件根聚合体积不误套单插件限制；完整强杀结果只读确认、不重放，部分 checkpoint 保持 `waiting_reconciliation`
  - [x] 为本地插件 Effect 后继完成 clean Deep：`main@6e48c974f7b0b7c3f2223b4cd1d359a3a107e97a` 的 `2026-07-28T00-47-46-977Z` 报告为 `173 total / 171 required pass / 2 optional skip / 0 blocked / 0 fail`，起止均绑定该提交、工作树 clean 且 Git 状态未变；插件强杀与真实 Electron IPC E2E 均为 required pass，inventory v5 锁定 156 IPC、52 Agent 工具、79 嵌套动作，IPC policy 为 13 queryable、3 opaque、19 direct-user、6 delegated
  - [x] 将 `terminals:start`、`terminals:write`、`terminals:resize` 与 `terminals:close` 接入 opaque `terminal_action` Effect：每次动作先越过 durable barrier；Terminal/Session/CWD 只保存摘要，write 只保存输入 SHA-256 与字节数，不持久化命令文本；未知结果进入 `waiting_reconciliation`、刷新 Renderer 恢复面板且进程重启后禁止自动重放。强杀 E2E 已覆盖 durable-before-execute、成功、失败、SIGKILL、人工对账及 SQLite 中敏感输入缺失
  - [x] 为终端 Effect 与 Assistant/Studio 输入门禁后继完成 clean Deep：`3d5de20ca9e73545e488f3155bdb3ba9af16f594` 的 `2026-07-28T03-21-03-602Z` 报告为 `173 total / 171 required pass / 2 optional skip / 0 blocked / 0 fail`，起止均绑定该提交、工作树 clean 且 Git 状态未变；inventory v6 仍锁定 156 IPC、52 Agent 工具、79 嵌套动作，IPC policy 为 13 queryable、7 opaque、15 direct-user、6 delegated。1.0 acceptance map 结构通过但 strict closure 仍失败：P0 21/64 verified、43 open，130 项 closure failure，critical recovery 1/11
  - [x] 将 `browser:open`、`browser:navigate`、`browser:back`、`browser:forward` 与 `browser:reload` 接入 opaque `browser_navigation` Effect：页面动作前必须先持久化 `executing`；durable target 只保存协议、host/target SHA-256 和 query/fragment 存在位，不保存完整 URL、查询、片段、页面标题或原始网络错误。失败与 SIGKILL 未知结果进入 `waiting_reconciliation`，Renderer 刷新恢复面板且重启后禁止自动导航；`browser:bounds` 与 `browser:close` 保持本地无 Effect
  - [x] 为 Browser Effect 与性能门禁后继完成 clean Deep：`1675eb506eff99b55699bc3a2f5f88b99b5d5ff4` 的 `2026-07-28T05-20-06-681Z` 报告为 `173 total / 171 required pass / 2 optional skip / 0 blocked / 0 fail`，起止均绑定同一 SHA、工作树 clean 且 Git 状态未变；inventory v7 锁定 156 IPC、52 Agent 工具、79 嵌套动作，IPC policy 为 13 queryable、12 opaque、8 direct-user、6 delegated。同一 clean SHA 的 Browser crash targeted E2E 通过；Deep 内性能报告 `2026-07-28T05-20-41-787Z` 为 cold P95 `31.4ms`、warm P95 `32.4ms`，保持 `<300ms`，且 fresh-renderer 重试只允许首个调度污染、Studio 数据就绪超时或有效 cold 超阈值，失败 phase 必须保留、连续失败仍阻断。acceptance map 仍为 P0 21/64 verified、43 open、130 项 closure failure、critical recovery 1/11
  - [x] 将 `migration:import` 接入 opaque `migration_import` Effect：导入回调只能在 durable `executing` 屏障后运行；Ledger 仅保存资产数量、类型计数和选择 SHA-256，不保存源资产路径、源内容或原始错误。失败与 SIGKILL 未知结果进入 `waiting_reconciliation`，Renderer 刷新恢复面板且禁止自动重放；专项 E2E 覆盖成功、失败隐私、同资源 lease、强杀恢复、SQLite canary 缺失和人工确认未应用后的收敛
  - [x] 为 Migration Import Effect 后继完成 clean Deep：`c9e9c2a2a001ad0a6aac7f1c202d48aa0992f501` 的 `2026-07-28T07-08-00-218Z` 报告为 `174 total / 172 required pass / 2 optional skip / 0 blocked / 0 fail`，起止均绑定同一 SHA、工作树 clean 且 Git 状态未变；inventory v8 锁定 156 IPC、52 Agent 工具、79 嵌套动作，IPC policy 为 13 queryable、13 opaque、7 direct-user、6 delegated。acceptance map 结构仍为 102/102，114 个声明命令中 85 个已实现，但 P0 仍有 43 个开放、130 项 closure failure、critical recovery 仅 1/11。完整迁移预检、备份、跨文件原子回滚、幂等重跑和统一 `test:all-migrations:required` 仍属于开放的 `NFR-REC-005`，不能把本增量写成完整迁移闭环
  - [ ] 仅在继续准备 v0.1.8 发布时刷新 macOS Intel-only 签名候选、独立资产核验与 scoped publication preflight；Apple Silicon/Windows 继续暂停，且没有新的明确发布授权
  - [ ] 获得 1 名合格非项目参与者，在真实 Intel Mac 上完成私有实测；只有 `test:m1-first-user-onboarding:required` 输出 `passed` 才关闭 M1
  - [ ] v0.1.7 公开 Release 恢复为批准的 Intel 五资产与仓库最终正文，并由定时完整性审计重新输出 `passed`；恢复前可收集 `observed_failed`/观察记录，但不得关闭 M1

**完成判据**:陌生人从官网下载后,macOS 无安全拦截地完成安装;Windows 下载页、
文件名和 Release Notes 均明确写明 `unsigned preview` 与可能出现的 SmartScreen 提示;
两个平台都能按 Quick Start 三步跑通第一个只读任务。正式跨平台 Release Gate 仍为 blocked。

**当前状态**:原始五资产发布动作已完成，但公开 Release 后续发生未批准的 Windows 资产/正文漂移，完整性门禁重新开放；陌生用户 Quick Start 实测也尚未完成。等待测试者期间继续修复 onboarding、恢复、稳定性、安全与发布保护，不新增 1.0 愿景范围。

### M2:前 10 个真实用户(目标:M1 后 1-2 个月)

**目标:10 个非熟人用户完成一次真实任务,且至少 3 个下周还回来。**

- [ ] M2-T1 N1 真人实测:3 名 Codex/Claude Code 真实用户 30 分钟迁移计时,记录卡点；M1 单人只读 Quick Start 结果只提供 onboarding 基线，不替代本项 3 人完整迁移证据
- [ ] M2-T2 onboarding 打磨:首个任务模板、Provider 配置向导、失败时的引导文案
  - [x] v0.1.7 后续源码已把公开 Quick Start 只读提示词放入欢迎页，并为 Assistant/Expert 的无可用 Provider 状态提供配置/重试恢复；恢复入口在无可用 Provider 时直接打开真实新增/修复表单，缺 API Key 或缺模型会保留表单、显示双语明确错误且不创建半成品 Provider，只有密钥与模型齐全的保存结果才自动回到首任务。提示词、目录、Drive、权限、固定/Provider/全局路由和 Studio 子页跨设置保留，保存前后均不误建会话；真实 Electron E2E `2026-07-26T14-44-18-900Z` 为 `9/9`、6 张截图，通过 UI 验证缺 Key、缺模型、有效保存并走真实 Router/流式响应，不再绕过 UI 调用 IPC 创建 Provider
  - [x] 首任务草稿增加版本化本地持久化：renderer reload / 应用重启后恢复提示词、项目、目录、Drive、权限、路由、Provider 与模型，成功发送后自动清除；不保存 API Key、Base URL 或响应内容，损坏/超限记录 fail-safe 丢弃。异步资源目录未加载时保留已有绑定，加载后对删除、无密钥、无模型或失效固定模型严格解绑，不静默替换 Provider，并支持从真实编辑器恢复而不丢其他字段。真实 Electron `2026-07-26T18-41-31-736Z` 为 `11/11`、8 张截图，页面操作 `2026-07-26T18-42-00-814Z` 为 `22/22`
  - [x] D0 renderer 安全增量：首任务六态投影先识别运行候选，不被 Provider 水合覆盖；失败候选有显式重开入口。module 级提交锁覆盖并发丢弃和失败释放；`startSessionWithPrompt` 返回确定 Session ID，首条消息与 onboarding 候选均绑定该 ID，不再 await 后读取全局 `activeId`。完成判定绑定候选 Session，用户重开后到达的旧 Result 快照不会污染新的空 onboarding 记录。dirty-worktree Node 行为门禁以 `15/15` 覆盖双提交、失败重试、running reload 零 create/send、四步进度、失败重开、跨 Session/陈旧 Result 隔离、完成谓词和隐私 canary（`test-results/first-task-onboarding/2026-07-31T08-31-41-212Z/report.json`，绑定 `b37c17cf8dea`、421 项 dirty worktree）。
  - [ ] 当前 Electron 双击/Enter/reload、失败恢复可用性、真人首任务和 clean release 绑定仍开放，因此 M2-T2 不关闭。
  - [ ] 用 M1 首位陌生用户和 M2-T1 三人 N1 记录验证文案可理解性、Provider 配置成功率及失败恢复时长，再按真实卡点继续打磨
- [x] M2-T3 建立反馈通道(GitHub Discussions 或微信群),每个反馈 48 小时内回应
  - [x] GitHub Discussions 已启用，General/Ideas/Q&A 双语表单、Issue/README 导流和 `SUPPORT.md` 已建立；只读 GitHub Actions 每 6 小时审计公开 Issue、PR 与 Discussion 的 48 小时首次回应 SLA，两项 required gate 已纳入 `test:deep`，最新完整运行 `162 total / 160 required pass / 2 optional skip / 0 fail`
  - [x] [Discussion #9 首条外部评论](https://github.com/ChaoYuZhang001/CaoGen/discussions/9#discussioncomment-17784426) 暴露“维护者发帖下的外部评论被漏算”缺陷；`main@b98acd11` 已把外部顶层评论作为独立 SLA 线程并覆盖 pending/on-time/overdue，维护者在 51 分钟内回复后 live audit 为 `1 responded_on_time / 0 pending / 0 overdue / 0 late`。该评论是设计建议，不是 M1 报名或真人结果
- [ ] M2-T4 每周发布一个 patch 版本,只修真实用户撞到的问题,不加新功能
- [x] M2-T5 官网增加 30 秒演示视频(配 key → 下任务 → failover → Diff 审查)
  - [x] `CaoGen-Website@e5be292` 已推送 `main`；中文/英文首页均包含原生 MP4 播放器、poster、下载入口与移动端单列布局，官网 `npm run check` 全部通过
  - [x] 生产 `https://caogen.dev/`、`https://caogen.dev/en/` 已出现 `#demo`；`https://caogen.dev/demo/caogen-website-demo.mp4` 返回 `200 video/mp4`，3,369,296 B，SHA-256 `bdb93198b35db545a6af0fd5530b0eb598eb4c5680085f48e3b88810711a553f`
- [ ] M2-T6 零配置试用路径——新用户在掏自己 key 之前,先能 60 秒看到产品真能干活:内置一键接本地 Ollama 预设,或一个试用额度入口。BYOK 仍是默认,只是不让它当冷启动的墙。**先给价值,再要承诺。**〔借鉴 WorkBuddy「开箱即用」,属 onboarding 打磨,不算新愿景功能〕
  - [x] 本地算力自动发现增量：首次进入 Assistant 会自动探测仅限固定 loopback 地址的 Ollama（`127.0.0.1:11434`）、LM Studio（`127.0.0.1:1234`）和 vLLM（`127.0.0.1:8000`），发现后自动激活，不扫描局域网、不要求 API Key、不发送 `Authorization`，也不要求先创建 Project；设置页仍提供“使用本机模型”作为可见恢复入口。无鉴权只允许 loopback OpenAI-compatible Provider，远端无鉴权配置 fail-closed，重复发现不会创建重复 Provider。当前 dirty worktree 的真实 Electron required gate `5/5` 通过，并覆盖 `360px` 无横向溢出（`test-results/local-compute-zero-config/2026-07-29T05-28-17-080Z/report.json`）；零选择路由 required gate `7/7` 通过（`test-results/routing-zero-choice/2026-07-29T05-30-38-811Z/report.json`）。
  - [ ] 完整零前置试用仍开放：机器上没有已安装且正在运行的兼容本地服务、也没有用户 Key 时，仍缺可执行的试用算力；在该路径补齐并完成真人 60 秒首任务前，M2-T6 不关闭，也不宣称所有新用户均可零前置启动。
- [x] M2-T7 3-5 个开箱即用预设任务——杀掉空白页:如「读懂这个项目」「审查我的改动」「把这批文件整理成报告」,一键起步。只做预设模板,不做完整数字员工招聘系统〔借鉴 WorkBuddy Expert,扩展 M2-T2 的"首个任务模板"〕
  - [x] Assistant 首屏提供“读懂这个项目”“审查当前改动”“整理文件成报告”“规划复杂任务”四个预设任务，覆盖代码与办公场景；预设分别绑定 `view / execute / plan` 策略。按 D0 架构，“读懂项目”在没有真实目录时只填入原始 prompt 并聚焦输入框，用户确认后提交；其余三个预设点击直接创建“对话”并发送，不要求 Project。结构化 Prompt 明确输出、来源引用、不可臆测和无输入时的恢复方式；报告预设保留原文件并生成/增量更新 `CaoGen-report.md`。同步提交锁阻止双击生成重复 Session/请求。历史真实 Electron gate `5/5` 证明四预设清单/策略、报告请求、报告预设无 Project 双击仅一个 Session/模型请求，以及 `1320x860 / 360x520` 无横向溢出且移动端 Composer 同屏可达；它没有逐个点击执行另外三个预设（`test-results/local-compute-zero-config/2026-07-29T05-28-17-080Z/report.json`）。
- [ ] M2-T8 用首批真人任务验证统一结果工作台:至少覆盖一个代码交付和一个 Office 成品任务,用户能在一个入口找到产物、工作区文件、变更、预览、Evidence 和导出;本阶段优先修断点,不扩建连接器市场
  - [x] 产品实现与自动化证据：Studio 新增统一“结果”入口，Assistant 侧结果入口复用同一合同，Memory 保持独立工具；结果按当前 Session 的 canonical `workspaceId/goalId/workItemId` 聚合 Project、Goal、WorkItem、历史 Run、Artifact 位置/版本/摘要、Evidence、Acceptance、测试、成本覆盖率、风险、未完成项、审批和审计时间线。未绑定 Project 时明确显示“对话分组”，不伪造 Goal；持久 ownership/aggregate 冲突继续 fail-closed，瞬时跨存储 revision 冲突只在有上限的稳定重读内恢复。交付导出仅使用 canonical JSON 与 SHA-256 摘要，不包含 Provider、模型响应或原始 Run 错误。结果快捷栏已复用现有变更、文件、预览、浏览器、终端和任务/DAG 六个工具面板；两层、两节点真实 DAG、两个 child Session 和主 Agent 汇总均通过本地 mock Provider。最新 `npm run test:audit-timeline:required` 已通过审计合同 `9/9`、结果合同 `28/28`、production build 与真实 Electron `6/6`；按 Run 筛选、opaque cursor、陈旧游标拒绝、缺失引用完整性行和 renderer 脱敏均纳入门禁。`1320x860 / 760x700 / 360x520` 共生成 14 张截图，页面和结果面板横向溢出均为 `0px`，报告为 `test-results/audit-timeline-required/2026-07-31T17-10-36-501Z/report.json` 与 `test-results/studio-result-surface/2026-07-31T17-10-54-389Z/report.json`；模型请求全部命中本机 mock，不调用真实 Provider，证据绑定 dirty merge commit `8ba60148`。
  - [ ] 真人结果钻取：由真实用户分别完成一个 30 分钟代码交付和一个 Office 成品任务，验证产物打开/预览/导出、Diff、Evidence、Acceptance、返工与恢复，并记录找结果耗时和回退聊天次数；完成前 M2-T8、W1、`EXP-005` 与 `ART-005` 保持开放。
- [ ] M2-T9 Codex / Claude Code 深度用户迁移钻取:先用当前迁移能力选择性导入项目规则、Skill、MCP 和 Hook,30 分钟内完成修改/测试/Diff/Artifact/Acceptance,记录回退原工具次数;本阶段只修真人阻塞点,不通过不宣称可迁移
  - [x] 产品实现与自动化证据：项目目录改为可选，留空即可扫描用户级资产并按“对话”入口使用，不要求先创建项目；Codex `config.toml` 采用 TOML 结构化解析，项目规则、Skill、MCP 与 Hook 分项预览，Provider、模型、认证和其他通用配置不会混入规则。Hook 只提示风险、不自动启用；MCP 的环境变量、Header、凭据参数、URL userinfo/query/fragment 与未知字段均剥离。每项绑定来源、作用域、目标、SHA-256、风险、冲突与忽略字段；高风险、用户级和同名冲突项不默认导入，覆盖必须显式选择。Apply 会重验扫描摘要和目标前置条件，拒绝来源/目标符号链接，原子批量写入失败自动恢复，成功后可一键回滚且回滚前再备份。主集成 T15 随 `43/43` 通过；当前 dirty worktree 的真实 Electron required gate `15/15` 通过，覆盖清空默认项目后进入对话迁移、敏感预览、安全默认、选择性导入、一键回滚及 `1320x860 / 760x700 / 360x520` 三档迁移页无横向溢出（`test-results/assistant-studio-ui/2026-07-29T02-15-06-692Z/report.json`）。
  - [ ] 真人迁移钻取：由 Codex / Claude Code 深度用户在 30 分钟内完成资产导入、修改、测试、Diff、Artifact 与 Acceptance，记录计时、卡点和回退原工具次数；此项通过前 M2-T9、W1 与 AC-19/20 保持未完成。
- [ ] M2-T10 Provider profile 可逆迁移钻取:先验证当前导入/Provider 路径能否预览 Base URL/协议/目标/冲突、Key 只进 Broker、原配置备份、无凭据导出和一键回滚;缺口进入 W3,本阶段只修首批用户阻塞〔防止 CaoGen 在 CC Switch 的入口层失分〕
  - [x] 产品实现、持久 journal 与无 GUI 自动化证据：无凭据导出，导入前展示 Base URL/协议/目标/冲突并允许逐项新建/更新/跳过，凭据字段忽略；只有目标绑定身份未变化时才保留 Broker 凭据，Base URL、引擎、协议、自定义路由头或凭据头变化会进入 `credentialMigrationRequired` 隔离，显式替换凭据后才重绑。新 Provider 不携带 Key；`authMode:none` 仅允许 IPv4/IPv6 loopback，保存、模型发现和运行均不发送凭据，切换时清除 Broker/磁盘 Key，编辑器清空隐藏草稿并对已有 Key 永久删除确认。应用前生成脱敏私密备份，一键回滚前再备份；跨进程 mutation lock、锁内 CAS 和 fsync/rename 持久边界阻止旁路写入。schema v2 operation journal 绑定前后 Store digest 以及 safety/source backup ID + digest，以 `prepared / waiting_reconciliation / committed / aborted` 对 import/rollback 分类，不自动 replay。最新 `135/135` smoke 新增活动 Key 标签/数量与目标凭据绑定变化断言，并保留文件、凭据、备份、journal malformed/篡改/symlink/超限及 backup 文件名/内嵌 ID 不一致拒绝（`test-results/provider-profile-smoke/2026-07-31T18-36-07-764Z/report.json`）。`13/13` 真实跨进程/`SIGKILL` gate 继续覆盖存活 owner 的 `LOCK_HELD` 竞争、失败 candidate 清理、同进程可重入、正常释放竞争、import/rollback 两个 checkpoint、死锁回收、重复恢复字节稳定、同进程对账收敛和 6 类 pending writer 阻断（`test-results/provider-profile-restart/2026-07-31T18-36-15-308Z/report.json`）。该 restart gate 还证明 safety/source backup 在 Store commit 前和 terminal 前复核 ID/digest，prepare 后或 Store commit 后篡改均 fail-closed；恢复冻结字节后才收敛并重新开放普通写入。Provider Profile Service、operation journal、mutation lock 与 Store repository 已进入 durable writer inventory；最新 dirty inventory `test-results/durable-write-inventory/2026-08-03T14-22-17-696Z/report.json` 通过 `13/13`、登记 76 个模块和 432 个 sink call，Permission Audit 与 Conversation Ledger 均已转为 `implemented_unverified`，全局降至 7 个 recovery gap 和 7 个显式 schema gap。Conversation Ledger 的 canonical append/replace/copy 已覆盖文件 fsync、原子 rename、POSIX 目录 fsync、严格损坏拒绝和 fault matrix；Windows 目录 durability/ACL 与 Provider Store 顶层 schema 仍未闭环。以上报告绑定 dirty merge commit `8ba60148`，不是 clean release 证据；本地真实 Provider 测试只显式读取权限收紧的 `~/.caogen-private/provider-parity.json`，生产模式拒绝自定义路径和内联 JSON，普通回归使用合成凭据且不自动付费，私有文件和派生明文不得进入 Git、日志、报告或公开资产。
  - [x] 当前源码 Electron required gate：`54/54` 通过真实主进程 IPC、Renderer 和四张截图验证危险 URL 在预览前拒绝、导入预览/应用、跨启动回滚、脱敏备份/导出、活动 Key 标签与保留绑定说明、Key 删除取消/确认/重新录入，以及 `760x700` 无水平溢出（`test-results/provider-profile-e2e/2026-07-31T18-36-51-341Z/report.json`）。备份文案已明确 API Key 不进入 Profile 备份、回滚后可能需要重新录入。
  - [x] 当前 merge 后源码的 Provider Profile 三阶段 Electron gate 已重跑并通过 `54/54`（`test-results/provider-profile-e2e/2026-08-01T02-08-04-853Z/report.json`），绑定 dirty worktree count `444`；仍不替代 clean release、Windows ACL、真人迁移和真实 Provider 发现/健康/failover 证据。
  - [ ] 真人迁移钻取：由首批真实用户导入两个日常 Profile，完成模型发现、健康检查、默认切换、故障切换、导出和回滚，记录计时、卡点和回退原工具次数；此项通过前 M2-T10 保持未完成。

**完成判据**:10 个真实用户完成 ≥1 次真实任务;周留存 ≥3 人;
产出一份《前 10 个用户学到了什么》公开复盘。

### M3:社区与 100 周活(目标:M2 后 2-3 个月)

**目标:从单人项目变成有外部贡献者的开源项目。**

- [ ] M3-T1 good first issues 上线 ≥10 个,标注难度与所需上下文
- [ ] M3-T2 明确招募方向:Windows 打包验证、Provider 适配、文档翻译、UI 打磨
- [ ] M3-T3 英文 README 与英文官网页面(厂商中立 + BYOK 在海外有市场)
- [ ] M3-T4 达到 100 周活跃用户;北极星指标 Weekly Verified Goal Deliveries 开始周报
- [ ] M3-T5 ≥3 名外部贡献者合并过 PR

**完成判据**:100 周活;≥3 名外部贡献者;社区渠道有非创始人发起的讨论。

### M4:1.0 Beta —— 主链闭环(目标:波次 A 启动后约 5 个月,逐项排期见 §8)

**目标:打通 Goal → WorkItem → Run → Artifact → Acceptance 主链,
Assistant/Studio 双模式无损切换可用。**

- [ ] M4-T1 Goal Contract 与验收标准生产可用
- [ ] M4-T2 Workflow Ledger 持久化与断点恢复
- [ ] M4-T3 Evidence / Acceptance 闭环:模型自称完成不算完成
- [ ] M4-T4 Assistant / Studio 无损切换(不重启任务、不丢上下文)
- [ ] M4-T5 数字员工基础组队(不做水墨 3D,机器人办公区继续演进)

**完成判据**:一个真实项目从 Goal 到 Diff/PR/交付包全程在 CaoGen 内完成,
中途崩溃可恢复,交付物带证据链。64 个 P0 全部达到"已验证"。

### M5:1.0 Stable 与商业化准备(目标:M4 后)

- [ ] 水墨轻动漫 3D 团队(仅在主链闭环之后投入美术资源)
- [ ] 正式签名/公证/SBOM/发布资产验证全链路
- [ ] 商业化后购买 SSL.com IV Code Signing + eSigner,启用 Windows Authenticode 与时间戳,补齐正式矩阵证据后才可关闭跨平台 Release Gate
- [ ] 7 天 soak 与 Apple Silicon 真机验证
- [ ] 牵引力数据包:周活、留存、Weekly Verified Goal Deliveries 曲线
- [ ] 启动投资接触:叙事为"厂商中立 + 本地优先 + 信创/数据不出境",对标 Dify 路径

**完成判据**:CaoGen 1.0 stable 发布;有可展示的牵引力曲线。

### 2.0(远期,不在当前计划内排期)

远程 Supervisor、云 Runner、桌面关闭后续跑、跨设备接管、多用户与组织策略、
业务连接器、模板市场、SSO/SCIM、私有部署。

---

## 4. 执行规则

1. **范围纪律**:M1-M3 期间不开发 12 项立项目标中的新功能,只做已验证能力的
   签名、打磨、文档和用户问题修复。两个例外:(a) 用户反复撞到且阻塞留存的缺陷;
   (b) M2 完成判据达标后,可启动 M4 波次 A(数据与恢复基座,见 §8)——
   可靠性直接服务留存,不算愿景功能。(2026-07-23 修订)
2. **文档纪律**:规划只改本文档;状态只更新 STATUS.md;愿景只改 PROJECT-CHARTER.md。
   新增任何规划文档前,先删除一份旧文档。
3. **口径纪律**:对外(README、官网、Release Notes)只说"已验证"能力;
   愿景内容必须带"建设中"标注。
4. **节奏**:每周一个 patch 或一个明确交付物;每周五更新 STATUS.md 并提交。
   同一功能批次先连续完成数据结构、主进程运行时、IPC/preload、UI、权限、恢复与文档接线；批次未收口前不重复执行 Deep、E2E、真实 Provider 或全量回归。代码收口后先统一执行一次 TypeScript 编译并集中修错，再进入 scoped 系统测试与全量回归。该节奏只减少碎片化等待，不降低任何验收或发布门禁。
5. **北极星**:Weekly Verified Goal Deliveries(周度被真实用户验收的目标交付数)。
   激活指标:N1 30 分钟迁移。两者每周记录,哪怕数字是 0。

## 5. 当前最大风险

| 风险 | 缓解 |
|---|---|
| 单人项目,范围再次膨胀 | 执行规则 1;里程碑完成判据不写"尽量" |
| 0 用户时投入美术/愿景功能 | 水墨 3D 冻结至 M5;创始人每周自问"这周有用户吗" |
| Windows unsigned preview 损失首批用户信任 | 文件名、下载页与 Release Notes 三处显式标注;不进入稳定更新通道;正式 Windows 签名延后到商业化后采购 SSL.com IV + eSigner |
| 一周未提交的工作丢失 | M1-T1 立即执行 |
| 完成度口径再次漂移 | 口径只认 §2,改口径必须改本文档并注明日期 |

---

## 6. M1 每日日程(2026-07-23 → 08-06)

规则:每天结束必须 commit + push,不留未提交工作过夜;每天只认一个交付物,做完才碰别的。

| 日期 | 交付物 | 对应任务 |
|---|---|---|
| 07-23 四 | 本地一周未提交工作分批 commit + push;`package.json` 改为 0.1.7 | M1-T1 / T2 |
| 07-24 五 | 旧规划文档移入 `docs/archive/`;PLAN.md 链接生效;STATUS.md 更新并提交(第一个"周五 STATUS"例行) | M1-T5 |
| 07-25 六 | README 改写:加对比表、可见 Roadmap 段落(3-5 行) | M1-T5 |
| 07-27 一 | macOS Intel x64 签名 + 公证走通,干净用户环境验证安装无拦截 | M1-T3 |
| 07-28 二 | Intel 安装包瘦身,执行 Intel-only 手动候选管线并下载未发布证据包;Apple Silicon/Windows 暂停 | M1-T3 |
| 07-29 三 | 三处口径对齐:README / 官网 / STATUS.md 完成度数字一致(统一用 §2 口径) | M1-T4 |
| 07-30 四 | 官网首页收敛:1.0 愿景内容折叠到独立 Vision 页,首页只放当前能力 + 截图 + 下载 | M1-T4 |
| 07-31 五 | v0.1.7 Intel 候选包安装自测;Release Notes 起草(只写已验证能力);STATUS 例行更新 | M1-T6 |
| 08-01 六 | 缓冲日:修自测发现的问题;录 30 秒演示视频(配 key → 下任务 → failover → Diff) | M2-T5 提前 |
| 08-03 一 | 演示视频上官网 + README;Release Notes 定稿 | M1-T6 |
| 08-04 二 | **发布 v0.1.7**:GitHub Release + 官网更新 + 社区渠道公告 | M1-T6 |
| 08-05 三 | 发布后观察:收集安装/使用问题,当天 hotfix 或记录 | — |
| 08-06 四 | M1 复盘(半页,写进 STATUS.md);启动 M2:起草 N1 真人迁移测试招募文案 | M2-T1 |

如果某天交付物没做完,顺延并写在当天 commit message 里,不悄悄跳过。

## 7. 每周固定节奏(M1 之后长期执行)

| 时间 | 动作 |
|---|---|
| 周一 | 定本周唯一交付物(一句话写进 STATUS.md 顶部) |
| 周二~周四 | 只做与本周交付物相关的事;用户反馈 48 小时内回应 |
| 周五 | 发布(patch 版本或交付物)+ 更新 STATUS.md + commit/push |
| 每天 | 结束即 commit + push;记录北极星指标(Weekly Verified Goal Deliveries,哪怕是 0) |

版本号规则:用户问题修复发 patch(0.1.7 → 0.1.8);M4 主链闭环才升 0.2.0;1.0 留给完整 Work OS。

---

## 8. 功能排期(64 个 P0 × 当前进展)

当前基线(2026-07-31,STATUS.md):64 个 P0 = **21 已验证 + 43 开放**。最近
clean/public 分类为 **19 部分完成 + 23 立项目标 + 1 仅基础**；较新的 dirty-worktree
结构投影为 **26 部分完成 + 16 立项目标 + 1 仅基础**，最终分类等待 clean 重新绑定。
已验证、无需排期的 21 项:EXP-001/002、PROJ-001/002/003、GOAL-001、WORK-002、
TEAM-001/002、ROUTE-001/002/003、RUN-001、TRUST-001、AUTO-003/004、VIS-001、
NFR-PRIV-004、NFR-NEUTRAL-001/003、NFR-ENG-003。

剩余 **43 项**全部落在 M4,按依赖排为 5 个波次。排序依据:TRUST/RUN 是恢复与
交付链的底层;ROUTE/TEAM 依赖 RUN 统一契约;ART/NFR-AUD 依赖 Effect/Evidence
基座;EXP/NFR-UX 最后收尾。

### 波次 A:数据与恢复基座(6-8 周,M2 达标后即启动,与 M3 并行)

| ID | 内容 | 当前状态 |
|---|---|---|
| TRUST-005 | v9 Workflow/Conversation Ledger 全入口闭环 | 部分完成 |
| TRUST-002 | 所有高风险入口注册 Effect 或 fail-closed；339 项静态入口清单与 required gate 已覆盖已知工具、IPC、IPC action 和显式外部入口，附件写入、MCP probe、迁移导入、终端动作与 Browser 导航已进入 opaque Effect，项目规则与本地插件安装/卸载已进入 queryable Effect | 部分完成 |
| TRUST-003 | PR/Issue/MCP/消息等入口专用对账 | 部分完成（本地合成强杀/重启已验证，真实远端待验） |
| TRUST-004 | 未知结果不自动重放,只读对账或人工确认 | 部分完成（注册策略与重点路径已验证，全入口运行时证明待补） |
| TRUST-006 | 密钥 Broker 的 record、fresh-process session-only 隔离、单一 DAG raw resolver consumer、scoped Provider credential lease、全 IPC/preload/Renderer 脱敏投影与七个 Provider channel 精确根委托/恰好一次调用/可达性审计已通过 97/97；provider/project/session/operation/expiry 作用域、全部子进程最小环境和全输出 canary 仍开放 | 仅基础 |
| RUN-002 | 协议 Adapter 完全隔离原始 stream parsing | 部分完成 |
| RUN-003 | 三条协议统一契约(不止 Anthropic 本地闭环) | 部分完成 |
| RUN-005 | 重启恢复所有非终态 Run,区分可重试/待对账 | 部分完成（canonical cross-domain strong-kill foundation） |
| NFR-REC-003 | Board/Run/Effect/Approval/Artifact/Acceptance 重启一致 | 部分完成（Project/Goal/WorkItem/TaskRun/Supervisor/opaque Effect 单链） |
| NFR-REC-001/005 | 崩溃不丢已确认写入；迁移可回滚 | 立项目标 |
| NFR-REC-002 | durable writer inventory 已登记 76 个模块 / 432 个写入调用并通过 13/13；Permission Audit 与 Conversation Ledger 均已转为 implemented-unverified，仍有 7 个 recovery gap、7 个显式 schema gap，继续逐 Store 关闭（`test-results/durable-write-inventory/2026-08-03T14-22-17-696Z/report.json`） | 部分完成 |
| NFR-REC-004 | WorkItem lease 全入口唯一 | 部分完成 |
| NFR-ENG-001/002 | 分层落地;所有 schema 版本化 + 迁移测试 | 立项目标 |

当前开发增量（2026-07-30）：Responses 服务端上下文已从进程内 `lastResponseId`
提升为会话历史/Task Snapshot 可恢复的受限游标，恢复时必须匹配 Provider、模型、协议和
Key，切换时 fail-closed。服务端链不可复用时，Runtime 会从耐久事件构造有界的跨协议上下文，
保留附件引用和 tool-call/result 配对；恢复 UI 已显示 causation/correlation、Checkpoint、
context generation 与 Effect lease/fence/evidence。显式分叉现在会沿用源 Project/Goal/WorkItem 和
本地语义账本，但新建 Session/SDK 身份、清除旧 Provider 服务端上下文，并通过既有新会话选择器
让用户更换 Provider/模型；OpenAI Responses/Chat、Anthropic Messages 和 Claude Agent SDK 三条
路径均已接入，Claude SDK 首轮显式注入可移植账本而不伪称 opaque resume。`task-snapshots.db`
已升级到 v9：JSONL 继续作为同步耐久源，DB 按 SDK conversation 保存 stream、不可覆盖的 generation
和逐事件 archive hash chain；正常写入增量追加，Checkpoint/链前缀变化创建新 generation 并保留旧链。
启动会回填现有历史，恢复/分叉在 JSONL 缺失时可从当前 DB generation 重建，已有 JSONL 损坏时
fail-closed；Project 永久删除已同步清理并记录授权移除计数。`test:provider-neutral-recovery:required`
已覆盖独立恢复、强杀边界、DB fallback、防篡改和双进程 OpenAI→Anthropic portable replay；真实 Provider、
完整 recovery ladder、全入口 runtime parity 与 clean release 绑定仍未执行。该 Provider-neutral 增量本身不关闭
`TRUST-005`、`RUN-003`、`RUN-005` 或 `ROUTE-005`。

2026-07-31 新增 `test:domain-restart-parity:required` 并接入 Deep：在 canonical
Project→Goal→WorkItem→TaskRun→Supervisor→opaque Effect 链上，Effect 进入 `executing` 且记录一次
外部执行后实际 `SIGKILL`，由全新 Node 进程恢复。最新报告
`test-results/domain-restart-parity/2026-07-31T02-56-08-707Z/report.json` 以 `9/9` 证明
`waiting_reconciliation`、零自动 replay、lease 到期与旧 fence 拒绝、ID/ownership/revision/`runRefs`
稳定和重复恢复幂等。该单链不覆盖所有非终态、Board、Approval、Artifact、Acceptance、真实 Provider 或
clean release，故 RUN-005/NFR-REC-003 仅推进为部分完成。

同批次的外部 Effect 源码增量已加入 GitHub/GitLab Issue、带只读查询契约的 MCP tool call，以及
飞书/钉钉/企业微信安全消息连接器。Issue 通过唯一 marker 查询；MCP 冻结 discovery digest，只有
声明 `readOnlyHint=true` 的专用查询工具可自动确认；Webhook 无可靠只读查询，因此未知结果永不
自动重发。连接器凭据只由主进程 Broker 解析，Renderer/Agent/Effect 只持有 ID、revision 和 digest，
并作为全局用户配置排除于 Project 导出/删除。本地合成 `external-effect-recovery` 已以 15 项检查覆盖
Issue/MCP 强杀后只读对账和零自动 replay，`notification-effect` 以 22 项检查覆盖三种消息通道、未知结果
零自动重发和凭据脱敏；`test:operation-effect`、typecheck 与 build 均通过。新增 AST 入口门禁还登记 339 项
当前工具/IPC/action/external surface，并对 queryable、opaque、durable-local 与 no-Effect 合同 fail-closed。
真实外部平台、动态入口完备性、逐入口运行时 enforcement、完整 Deep 与 clean release 仍开放，因此
`TRUST-002/003/004` 只推进为部分完成；叠加 NFR-PRIV-002/ROUTE-006 出站策略 foundation 后，P0 已验证仍为 21/64、开放仍为 43，当前分类为 `21 + 26 + 16 + 1`。

波次判据:崩溃恢复 E2E 全绿(杀掉进程重启后 Board/Run/Effect/Approval/Artifact 一致)。

### 波次 B:路由与数字员工连续性(4 周)

| ID | 内容 | 当前状态 |
|---|---|---|
| ROUTE-004 | 每次路由形成 ModelAttempt,全 Provider 统一契约 | 部分完成 |
| ROUTE-005 | 跨 Provider 切换保持 Goal/WorkItem/Run/上下文连续 | 立项目标 |
| ROUTE-006 | Project Resource 的 `deny/S3/local_only` 已在 Provider Attempt 前 fail-closed，`local_only` 冻结原 Provider 并过滤 failover；SessionManager DAG 直连也已在 Attempt/network 前复核实际 request-body digest。region/domain/capability/permission/budget、初始统一候选过滤、其他直连入口和完整 request manifest 仍开放 | 部分完成 |
| ROUTE-010 | 六级故障恢复阶梯,重放前检查未决 Effect | 立项目标 |
| TEAM-003 | 员工策略执行,堵五类 P0 绕过 | 部分完成 |
| TEAM-004 | 员工身份与 Provider/model 解耦 | 立项目标 |
| TEAM-005 | 退休保留完整 Assignment/Run/Artifact/Evidence 历史 | 部分完成 |
| NFR-NEUTRAL-002 | 路由仅以用户设定为依据 | 立项目标 |

### 波次 C:交付链与审计(5 周)

| ID | 内容 | 当前状态 |
|---|---|---|
| GOAL-002 | Goal 策略执行与 UI 校验闭环 | 部分完成 |
| WORK-001/003/004 | WorkItem 契约闭环;多入口 E2E;repair 全链路 | 部分完成 |
| ART-001 | Artifact 生命周期接入全部 producer(不止 Code Forge) | 部分完成 |
| ART-002 | done 门禁:不可变交付链 | 部分完成 |
| ART-003 | 调研→需求→设计→实现→审查→修复→测试→交付阶段传递 | 立项目标 |
| ART-004 | 审查失败→repair/retest 跨阶段闭环 | 部分完成 |
| NFR-AUD-001/002/003 | 审计六问可答;按 Run 查看路由/成本/审批/证据;日志脱敏 | 部分完成（NFR-AUD-001/002 canonical timeline foundation；NFR-AUD-003 仍为立项目标） |

### 波次 D:体验与隐私收尾(3 周)

| ID | 内容 | 当前状态 |
|---|---|---|
| EXP-003 | 双模式切换的审批/通知/恢复连续性 | 部分完成 |
| PROJ-004 | owner-scoped 完整脱敏导出、当前参与者集合的 crash-recoverable 单文件语义导入、首批跨 Store 永久删除、授权删除连续性账本、备份读回和 deletion proof 已接入；全 inventory owner proof、Artifact blob/Session/ModelAttempt 等完整可移植包和全量证明仍开放 | 部分完成 |
| NFR-UX-001/002 | Assistant 无技术术语;待审批/失败两模式可见 | 立项目标 |
| NFR-PRIV-001 | 32 个数据条目 / 53 路径 / 17 类顶层 Project aggregate 对象已进入机器 inventory；最新 required report `716/716` 且 `unregisteredSources=[]`，但仍为 29 个 `partial` + 3 个 `inventory_only`、0 个 `enforced`。sealed/sanitized export、私密导入源、durable import/delete journal、RoleTemplate 依赖自动解析、备份/proof 读回、启动续做和参与者 residual scan 已完成；消息连接器已明确为全局用户配置且排除于 Project 导出/删除；继续补齐全 Store owner proof、统一 retention、Artifact blob/Session/ModelAttempt/旧 Memory 可移植性（`test-results/local-data-map/2026-07-31T08-31-42-062Z/report.json`） | 部分完成 |
| NFR-PRIV-002 | Studio 可配置 Resource 数据等级与 `allow/local_only/deny`，Composer 显示接收方、数据等级、排除项及 `部分范围`；两份 21/21 required gate 覆盖策略、篡改/漂移、重启、`@文件` canonical containment、DAG 和 Attempt 前零网络拒绝。完整 system/Skill/tool/history/MCP/自动入口预览与持久 request binding 仍开放 | 部分完成 |
| NFR-PRIV-003 | 凭据不进 Renderer/日志及全部输出面的 canary 证明 | 立项目标 |

当前进入顺序：actor 权限重算、旧 owner 撤权、WorkItem 本地单用户转交、owner-scoped 完整脱敏导出、当前参与者集合的单文件 import/readback，以及首批强制私密备份、durable journal、跨 Store cascade、crash resume 和 residual scan 已完成；下一步扩展到全 inventory owner proof、Artifact blob 与 Session/ModelAttempt 可移植包、统一 retention，再增加真实多用户身份、评论、共享审批和 Webhook。后续协作入口必须复用现有 WorkItem/Assignment ownership、journal/audit 与数据生命周期合同，不能建立第二套协作数据孤岛。

### 波次 E:验收冲线(2 周)

- acceptance map 报告中的全部 closure failures 清零；strict closure 通过
- 64 个 P0 全部"已验证" → 升 0.2.0,即 1.0 Beta

### 时间线汇总

| 阶段 | 时间 | 交付 |
|---|---|---|
| M1 | 2026-07-23 → 08-06 | v0.1.7 签名发布 |
| M2 | 08-07 → 09 月底 | 前 10 个真实用户 |
| 波次 A(与 M3 并行) | 10 月 → 11 月 | 数据与恢复基座 |
| 波次 B | 12 月 | 路由与数字员工连续性 |
| 波次 C | 2027 年 1 月 | 交付链与审计 |
| 波次 D | 2027 年 2 月上 | 体验与隐私收尾 |
| 波次 E | 2027 年 2 月下 | **1.0 Beta(0.2.0)** |
| M5 | 2027 Q2 | 1.0 stable + 牵引力数据包 + 投资接触 |

说明与风险:

- 若严格等 M3(100 周活)达标才启动波次 A,整体顺延 2-3 个月,1.0 Beta 推到
  2027 年 5 月——不推荐,可靠性工作本身就是留存的先决条件,故 §4 规则 1 已修订。
- 波次 A 的 15 项是最重的一波。若 6 周做不完,优先保 TRUST-005 / RUN-005 /
  NFR-REC-001~003(用户可感知的"不丢数据"),其余顺延进波次 B,不砍范围只挪顺序。
- P1 不进当前排期。例外:VIS-002~007(水墨 3D)是 M5 的 1.0 stable 发布门禁。

## 9. 正式竞品优势转化计划

本节只调整产品优先级，不改变 M1 的唯一焦点，也不把 P2 能力塞入 1.0 发布门禁。
W0~W5 是实现顺序，不是终极产品范围裁剪；终局必须完成各类竞品核心优势的统一集成。
事实和完整差距矩阵见 `docs/COMPETITOR-GAP-ANALYSIS.md`，需求合同见
`docs/PRODUCT-REQUIREMENTS.md` §2.3~2.4、§5.6~5.7、§6.4 和 AC-15~20。

| 顺序 | 交付 | 需求映射 | 启动条件 | 退出判据 |
|---|---|---|---|---|
| W0 当前 | 完成 M1 分发与 M2 首批真人验证 | Release Gate、N1、M2-T1~T10 | 立即 | macOS 正式证据、Windows unsigned preview 原生证据、真实用户完成办公/代码/迁移任务；不以新增功能代替验证 |
| W1 M2 | Codex/Claude Code 迁移 + 统一“查看/规划/执行”策略与结果工作台 | `PROJ-006`、`RUN-007`、`EXP-003/005/006`、`WORK-005/006`、`ART-005`、AC-19/20 | M1 发布后 | 真实深度用户 30 分钟完成主链；导入可预览/回滚；查看零副作用；规划批准前不执行；结果集中可验收 |
| W2 波次 C | Office 成品和跨阶段 Artifact 主链 | `ART-001/003/004/005`、AC-15 | Artifact lifecycle 与 Acceptance 基座稳定 | Word/Excel/PPT/PDF 黄金路径可打开、可预览、可追溯、可返工、可导出，失败不完成 Goal |
| W3 1.0 P1 | Provider profile 完整闭环、项目知识和连接器合同 | `PROJ-002`、`CONN-002/003`、`ROUTE-005/006`、AC-16/20 | Trust/权限/retention 与 Artifact 引用合同稳定 | Provider 迁移在真实网络下完成发现/健康/切换并取得真人与 clean release 证据；本地+外部知识源引用、刷新、撤销、个人/共享授权和跨项目隔离通过 required gate |
| W4 post-1.0 | Routine canonical 化后增加 Webhook 与远程接续 | `AUTO-002/005`、AC-17 | 非终态 Run 恢复、远程身份、审批、幂等触发和设备绑定威胁模型关闭 | 远程/事件发起复用同一任务，不上传本地凭据，断线/重复 webhook 不重复副作用 |
| W5 post-1.0 | 最小团队协作和设计连接器 | `COLLAB-001/002`、`ART-003`、`CONN-003`、AC-18 | 单用户权限/导出/删除闭环且有团队需求证据 | 可分享/转交/共享审批；设计 Artifact 可替换接入；不自建聊天、会议、Office 或设计平台 |

W5 前置增量（2026-07-29）：已完成本地单用户 WorkItem 转交 foundation。它复用 canonical
WorkItem owner 与 Assignment 协调链，覆盖可信 actor、旧 owner 撤权、新 owner 授权、lease
撤销、历史保留、原因/audit、CAS、幂等和重启读回，并提供 Studio 入口与真实 Electron
回归。真实多成员身份、分享、评论、提及、共享审批、组织策略、Webhook，以及统一
retention/export/delete 仍开放，因此不提前关闭 `COLLAB-001` 或 AC-18。

数据生命周期当前增量（2026-07-29）：Studio 导出复用 `ProjectAggregateService`，在稳定读取后以
expected aggregate revision 封存，返回 canonical JSON、SHA-256 `exportDigest`、`sanitized/sealed`
verification、owner-scoped 聚合对象和显式 RoleTemplate 依赖。单文件导入不要求先建空 Project：验证
export/aggregate/credential/ownership，保存 `0600` 私密源，先在 disposable Workflow DB 上 dry-run，
再以 durable journal 合并 Workspace、Workforce、完整 TaskRun、Artifact Graph、Evidence、Acceptance 和
canonical Learning；缺失 RoleTemplate 自动安装，同 ID 不同内容 fail-closed，目标端链坐标重建，阶段写入
可启动续做，最终重新封存并验证语义等价。删除后的 `workspace.purged` 墓碑可被同 Project 的已验证备份
恢复，不影响无关 Project。`npm run test:project-import` 和类型检查通过；真实 Electron 生命周期 gate 跨
6 次启动 `19/19` 通过，报告为
`test-results/project-workspace-lifecycle-ui/2026-07-29T16-07-10-846Z/report.json`，覆盖删除后 UI 导入、
Run 读回、无关 Project 保留、重复/篡改拒绝和重启持久化。`npm run test:project-permanent-deletion` 继续
证明私密备份、durable delete journal/proof、授权删除连续性、residual scan 和外部源保留。
全 29 Store owner proof、Artifact blob、Session/transcript/snapshot/ModelAttempt、旧路径 Memory 映射、
其他 connector 合同和超出当前参与者集合的删除证明仍开放；消息连接器已登记为 Project 边界外的
全局用户配置，因此
`PROJ-004 / NFR-PRIV-001 / NFR-AUD-004` 保持部分完成。

W1 当前增量（2026-07-29）：已完成会话级“查看/规划/执行”合同、结构化计划工作台、
不可变版本与 SHA-256 摘要、精确版本审批、后续版本自动废止旧审批、Genesis 计划捕获，
并把 send、子 Agent、DAG 后续层和手工终端/Git/文件/worktree 写入口接到同一门禁；
统一结果工作台也已按 canonical Session ownership 聚合 Run、Artifact、Evidence、Acceptance、
成本、风险、未完成项、审批和审计，并提供集中查看与脱敏导出。
`npm run test:audit-timeline:required` 已通过审计合同 `9/9`、结果合同 `28/28`、production build 与结果 UI 真实 Electron `6/6`。
已绑定 Project 的计划在批准时会以稳定 step ID 投影为现有父 WorkItem 下的 canonical 子 WorkItem，
通过 canonical command service 写入 Workflow Ledger 并持久投影回执；新版本的未启动步骤可幂等增改删，
运行中/终态冲突会 fail-closed。未绑定 Project 的计划仍只属于对话，不创建隐藏 Project。
`npm run test:task-plan-contract:required` 现包含专用 canonical 投影回归；计划 UI 最新真实 Electron gate 为 `15/15`，
报告 `test-results/assistant-studio-ui/2026-07-29T06-04-08-795Z/report.json`。Studio 现可在选中的 active Project 内只输入一句目标，
幂等创建 canonical Goal 与父 WorkItem，自动选择 Provider、建立精确绑定的 Session 并发送首条目标；无目录 Project 使用
`userData` 下按 Workspace 隔离的执行目录，不降级为“对话”，也不创建隐藏的旧目录型 Project。部分写入可用同一
`requestId` 恢复，目标冲突和终态冲突 fail-closed，同步提交锁阻止双击重复 Session。侧栏现以 canonical `workspaceId`
优先归组，同时保留旧目录 Project；有项目归属的活动会话和历史记录不再进入“对话”。项目级展开/收起、更多、`+`
以及顶层新建项目入口均已接到 canonical Studio，且移动端隐藏不可用的拖拽手柄。最新真实 Electron gate 为 `16/16`，
跨 5 次启动并包含 `1320x860 / 390x844` 共 11 张截图：`test-results/project-workspace-lifecycle-ui/2026-07-29T07-20-26-251Z/report.json`。
这些证据来自 dirty worktree；计划合同自身的 Ledger 历史与多主体审批仍开放，且结果工作台尚未完成真人代码/Office
30 分钟主链和 clean release 绑定，因此 W1、`WORK-005/006`、
`EXP-005` 与 `ART-005` 均未关闭，也不改变 W0 发布阻塞状态。

Provider-neutral Recovery 当前增量（2026-07-30）：新增 `Conversation Ledger archive and recovery`、
`Provider cross-resume restart`、`checkpoint Effect boundary` 三项 Deep required gate，并以
`npm run test:provider-neutral-recovery:required` 组合复用既有 Effect 强杀/close-race E2E。当前本地证据
覆盖 archive 增量与 generation rewrite、损坏 fail-closed、DB 恢复、OpenAI 来源到 Anthropic 目标的
双进程 fork、canonical Project/Goal/WorkItem/Run/request/step 连续性，以及新 Session/SDK/Provider 和
ModelAttempt 链；Checkpoint 的 chat/code/both 及兼容 file-rewind 实际 apply 均不得跨越未决 Effect，dry-run 只作只读预览。
三项 Deep 子集 `3/3`、类型检查和 build 已通过。下一步不是继续扩 UI，而是补真实 Provider 条件证据、
完整 retry/key/model/provider/protocol/manual recovery ladder、所有非终态 canonical domain 的强杀矩阵，
最后在合并后的 clean commit 运行完整 Deep。未完成这些前不关闭 `TRUST-005`、`RUN-003/005/006`、
`ROUTE-005/010`，也不改变 Release Doctor `not_ready`。

合并后 recovery 收口（2026-08-01）：`origin/main@79e54ae5` 已进入当前 dirty merge commit `8ba60148`，
autostash 保留未删除。DAG summary receipt crash 的恢复对账改为严格读取耐久 transcript，并在更新快照时同步重算、
验证 `conversationLedger`，没有放宽损坏账本的 fail-closed 检查；`test:dag-finalization`、Conversation Ledger 12 项、
transcript restore、完整 provider-neutral recovery 与迁移到 v9 event identity 的 DAG recovery 均通过。Node/Web typecheck、
production build 和全树 `git diff --check` 通过。非 required acceptance map 为 `102/102` structural pass，但仍有
`116` 项 closure failure、P0 `21/64 verified` / `43 open`、critical recovery `1/11`，release binding 因 dirty worktree
失败。下一步仍是精确 clean candidate 上的完整 Deep、正式验收和 Release Doctor，而不是把本轮 targeted pass 提升为发布结论。

Office 交付当前增量（2026-07-31）：Word/Excel/PowerPoint/PDF 四种 production tool 已统一经过
durable Effect、只读对账、canonical Artifact/Evidence/Acceptance 和跨阶段 handoff。批准时冻结
结构化输入、输出 Project 路径、来源文件 identity/bytes/SHA-256，以及由 `title + specDigest` 对应的
确定性输出字节 SHA-256/长度；执行和恢复对账必须精确匹配该身份，旧 Effect 缺少冻结摘要时重新审批，
同格式但内容不同的有效文件保持 unresolved。失败自检只保留可审计 Artifact 与
failed Acceptance，不进入 producing WorkItem 或本轮 dependency handoff。OpenAI Responses/Chat、Anthropic Messages
和 Claude Agent SDK 三条生产路径都会向后续 WorkItem 注入当前 resolver 选中的上游 Artifact，而不是要求用户
重复上传或复述；resolver 现在要求至少一个 Acceptance link，且所有关联 Acceptance 都存在并为
`passed/waived`，所以 Artifact 已持久化但 Acceptance 尚未提交的窗口在当前进程与 fresh-process readback 中
都不会进入 handoff；缺少 v1 output-binding metadata 的旧 passed Office Artifact 同样隔离。旧 confirmed Effect
保持可读但 producer 不创建 Artifact，旧 waiting Effect 的 `confirmed_applied` 在持久化前拒绝，用户确认未应用后
可转为 `abandoned` 再显式生成。`npm run test:office-delivery:required` 最新以 40 项检查覆盖四格式、25 条负向路径、
5 个 v1 output-bound confirmed Effect、1 个旧版 confirmed Effect 隔离、7 个 canonical Artifact、5 passed +
1 failed Acceptance（仅 4 个 passed 具备 handoff 资格）、伪造 Effect、有效异内容文件、缺失 Acceptance、三时区
确定性和独立 Node 进程重启；Artifact lifecycle/Graph、类型检查、build 与 plan contract 通过。当前门禁只证明同一
生成器输入的确定字节，不代表任意语义等价 OOXML ZIP 已完全规范化。当前源码完整 Deep、
真实 Provider、原生 Office 应用打开、真人 30 分钟任务、统一结果工作台钻取、所有 producer/Acceptance ingress、
完整强杀 checkpoint 矩阵、返工/导出与 clean release 绑定仍开放，因此 `ART-001/003/005` 和 AC-15
只推进 foundation，不关闭验收。最新 required acceptance map 报告
`test-results/product-1.0-acceptance-map/2026-08-01T02-01-48-074Z/report.json` 为 `102/102` 结构通过、
21/64 P0 已验证、43 项开放、120 个声明 gate command 中 100 个已实现、80 个 requirement 具备
implemented gate、116 项 strict closure failure，Release Doctor 仍为 `not_ready`。

优先级纪律:

1. W0 未完成时，W1 只允许修复首批用户直接撞到的结果发现和任务策略问题。
2. W2 先接 canonical Artifact producer，再做漂亮的结果 UI；文件路径或聊天链接不算交付闭环。
3. W3 必须先定义授权、引用、刷新、撤销、删除和跨项目隔离，不先堆连接器数量。
4. W4/W5 必须有真实用户需求和安全合同，不因竞品已有就提前膨胀范围。
5. Codex/Claude Code 的每项“兼容”都必须由真实深度用户迁移证明；扫描到文件、能导入配置或存在相似按钮都不算迁移完成。
