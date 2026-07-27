# CaoGen 项目计划(唯一执行纲领)

> 本文档是 CaoGen 当前唯一的项目计划。它取代并收敛此前三代规划文档
> (ROADMAP.md / MASTER-PLAN.md / PLAN-FOR-CODEX.md / docs/PROJECT-PLAN.md /
> docs/EXECUTION-PLAN.md / docs/DEV-AND-RELEASE-PLAN.md 等)。
> 愿景定义见 docs/PROJECT-CHARTER.md,实时完成状态见 STATUS.md。
> 旧文档移入 docs/archive/ 仅作历史存档,不再更新。

- 制定日期:2026-07-23
- 状态:已生效
- 决策人:创始人

---

## 1. 完整目标(最终愿景,不变)

**CaoGen:本地优先、厂商中立、可恢复、可审计的 Agent Work OS。**

用户提交目标,CaoGen 组织数字员工、模型和工具,持续产出可恢复、可审查、可验收的结果。

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

当前基线(2026-07-25,以 STATUS.md 和机器验收映射为准):64 个 P0 中 21 个已验证、
18 个部分完成、24 个立项目标、1 个仅达到基础。官网旧的"5 完成/17 部分/42 立项"
口径已于 M1-T4 对齐并增加四分类总和门禁。

---

## 3. 阶段性里程碑

只有这一套里程碑编号。旧文档中的 M0-M15、M-A/B/C、立项 M0-M7 全部作废。

### M1:签名楔子版 v0.1.7(目标:2 周内)

**目标:把一个已签名、可安装、当前能力真实可用的版本交到陌生人手里。**

- [x] M1-T1 提交并整理本地未提交的全部工作(约一周量),git 历史恢复连续(PR #7)
- [x] M1-T2 版本号定为 0.1.7(package.json 从 1.0.0 回退,延续 0.1.x 发布线);1.0 版本号预留给完整 Work OS
- [x] M1-T3 macOS Intel x64 签名 + 公证 + 安装启动证据;Apple Silicon 与 Windows 按创始人决定暂停
  - [x] Intel x64 本地签名基线:Developer ID、Hardened Runtime、45/45 Mach-O、DMG/ZIP 内签名和真实 renderer 启动已验证;该基线未公证,不得发布
  - [x] 0.1.7+ 发布门禁硬化:未通过 required macOS audit、公证/staple 或包内 clean-commit provenance 绑定时,Release Doctor 必须保持 `packaging_release` open
  - [x] 0.1.7+ 三平台发布矩阵门禁:macOS x64、macOS arm64、Windows x64 必须各自通过签名/公证审计、clean-commit provenance、原生安装和 renderer 启动;最终 packaging audit 必须同时绑定 12 项发布资产
  - [x] macOS 签名只对 Apple 时间戳服务瞬时错误执行最多 5 次有界重试;证书、entitlement、Keychain 与其他签名错误立即失败
  - [x] 手动候选管线已固化:`workflow_dispatch` 只接受已在 `main` 的完整 commit SHA;支持 Intel-only 或完整三平台范围;只上传未发布候选证据包,不自动建 tag/Release
  - [x] `main@7a0a4babb9fae90b68c8deef63e185bd44527b5c` 的 Intel-only 候选在 GitHub run `30130085556` 完成 exact-commit Deep、Developer ID 签名、notarize、staple、Gatekeeper、required release audit、DMG 安装和真实 renderer 启动
  - [x] 运行时收口为 OpenAI-compatible + 原生 Anthropic Messages，删除 Claude Agent SDK、Claude CLI、SDK 专属会话/检查点/Hook/UI 与打包规则；基础发行包必须审计为不含 SDK/CLI
  - [x] 删除 Claude Runtime 后的本地 unsigned Intel x64 实测：DMG `125,638,991 B`、ZIP `125,002,021 B`、`.app` `311,931,918 B`、`app.asar` `61,630,882 B`；package audit 证明 SDK/CLI 不在 ASAR 或 unpacked files，预算收紧为 `160 MB / 160 MB / 400 MB / 80 MB`
  - [x] `main@ee13fffe5ca0e8576ea448fd3253e7cd9cfa9fb8` 的 Intel-only 候选在 GitHub run `30148489031` 完成 clean exact-commit Deep（`154/154` required，2 optional skip）、Developer ID 签名、公证/staple、Gatekeeper、`106/106` required audit、DMG 隔离安装/干净 detach、真实 renderer 与最终资产绑定；签名 DMG `127,703,488 B`，ZIP `127,016,797 B`
  - [x] `main@e8f617f822be458065dabe7f2440d1f5a33ee2b3` 的 Intel-only 最终候选 run `30150795350` 成功：Deep `155/155` required、2 optional skip，`120/120` required macOS audit，五资产 `latest-mac.yml` 元数据、签名/公证/安装/renderer 与 clean provenance 全部绑定；资产集 `0fc626d9ccc3038ca5b3e574b87692f5ec7778c0670b2a6a4139fd804dba216d`
  - [x] `main@bbec526554aea9785291edf4d8164084145347ae` 的当前 Intel-only 最终候选 run `30162696430` 成功：Deep `157/157` required、2 optional skip，`120/120` required macOS audit，Developer ID 签名、公证/staple、Gatekeeper、DMG 隔离安装/干净 detach、真实 renderer 和五资产 clean provenance 全部绑定；资产集 `7553d1ef33ec44d69e7b95c74aee8fcb7500a68daf008ed343e66ae3345a036c`
  - [ ] Apple Silicon arm64 原生证据(暂停,不计入当前 M1 完成判据)
  - [ ] Windows x64 签名/安装证据(暂停,不计入当前 M1 完成判据)
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
  - [x] 等待期功能修复收口后重跑 v0.1.8 clean Intel 候选：`main@03c3fee2837d120fce43f4b7d11bd25488be4d36` 的只读 run `30243108279` 已覆盖 Browser/Preview 发送可靠性后继，完成 exact-commit Deep `163 total / 161 required pass / 2 optional skip / 0 fail`、P2、`120/120` macOS audit、Developer ID 签名、应用公证/staple、Gatekeeper、DMG 隔离安装/干净 detach、真实 renderer 与 packaged-app smoke。Actions artifact `8644829708` 的 `255,552,267 B` ZIP 已用可续传 Range 独立重组，SHA-256 `ec343fe823c5e3a3502c4b6176d23dd59b46dd3e15c2338b06eab98f7384c16a` 与 GitHub 一致；五资产、四类报告、更新元数据、纯 x86_64、provenance、codesign、应用票据及 Claude SDK/CLI 缺失均独立核验，资产集 digest `2abe8622e3b37873e69abdd5deb1f16c8739336181688eeb2e665c601792ff52`。精确 Final Notes 和四类报告已在 clean、已推送的 publication-only 后继上通过 scoped notes/handoff preflight，结论 `ready_for_owner_decision` 且 tag/Release/upload 副作用均为 false；`1707a999 / 30235833246` 降为历史签名证据。获得创始人针对 v0.1.8 的新授权后才可创建 tag/Release
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
  - [ ] 获得 1 名合格非项目参与者，在真实 Intel Mac 上完成私有实测；只有 `test:m1-first-user-onboarding:required` 输出 `passed` 才关闭 M1
  - [ ] v0.1.7 公开 Release 恢复为批准的 Intel 五资产与仓库最终正文，并由定时完整性审计重新输出 `passed`；恢复前可收集 `observed_failed`/观察记录，但不得关闭 M1

**完成判据**:陌生人从官网下载 macOS Intel x64 安装包,无安全拦截地完成安装,
按 Quick Start 三步跑通第一个只读任务。

**当前状态**:原始五资产发布动作已完成，但公开 Release 后续发生未批准的 Windows 资产/正文漂移，完整性门禁重新开放；陌生用户 Quick Start 实测也尚未完成。等待测试者期间继续修复 onboarding、恢复、稳定性、安全与发布保护，不新增 1.0 愿景范围。

### M2:前 10 个真实用户(目标:M1 后 1-2 个月)

**目标:10 个非熟人用户完成一次真实任务,且至少 3 个下周还回来。**

- [ ] M2-T1 N1 真人实测:3 名 Codex/Claude Code 真实用户 30 分钟迁移计时,记录卡点；M1 单人只读 Quick Start 结果只提供 onboarding 基线，不替代本项 3 人完整迁移证据
- [ ] M2-T2 onboarding 打磨:首个任务模板、Provider 配置向导、失败时的引导文案
  - [x] v0.1.7 后续源码已把公开 Quick Start 只读提示词放入欢迎页，并为 Assistant/Expert 的无可用 Provider 状态提供配置/重试恢复；恢复入口在无可用 Provider 时直接打开真实新增/修复表单，缺 API Key 或缺模型会保留表单、显示双语明确错误且不创建半成品 Provider，只有密钥与模型齐全的保存结果才自动回到首任务。提示词、目录、Drive、权限、固定/Provider/全局路由和 Studio 子页跨设置保留，保存前后均不误建会话；真实 Electron E2E `2026-07-26T14-44-18-900Z` 为 `9/9`、6 张截图，通过 UI 验证缺 Key、缺模型、有效保存并走真实 Router/流式响应，不再绕过 UI 调用 IPC 创建 Provider
  - [x] 首任务草稿增加版本化本地持久化：renderer reload / 应用重启后恢复提示词、项目、目录、Drive、权限、路由、Provider 与模型，成功发送后自动清除；不保存 API Key、Base URL 或响应内容，损坏/超限记录 fail-safe 丢弃。异步资源目录未加载时保留已有绑定，加载后对删除、无密钥、无模型或失效固定模型严格解绑，不静默替换 Provider，并支持从真实编辑器恢复而不丢其他字段。真实 Electron `2026-07-26T18-41-31-736Z` 为 `11/11`、8 张截图，页面操作 `2026-07-26T18-42-00-814Z` 为 `22/22`
  - [ ] 用 M1 首位陌生用户和 M2-T1 三人 N1 记录验证文案可理解性、Provider 配置成功率及失败恢复时长，再按真实卡点继续打磨
- [x] M2-T3 建立反馈通道(GitHub Discussions 或微信群),每个反馈 48 小时内回应
  - [x] GitHub Discussions 已启用，General/Ideas/Q&A 双语表单、Issue/README 导流和 `SUPPORT.md` 已建立；只读 GitHub Actions 每 6 小时审计公开 Issue、PR 与 Discussion 的 48 小时首次回应 SLA，两项 required gate 已纳入 `test:deep`，最新完整运行 `162 total / 160 required pass / 2 optional skip / 0 fail`
  - [x] [Discussion #9 首条外部评论](https://github.com/ChaoYuZhang001/CaoGen/discussions/9#discussioncomment-17784426) 暴露“维护者发帖下的外部评论被漏算”缺陷；`main@b98acd11` 已把外部顶层评论作为独立 SLA 线程并覆盖 pending/on-time/overdue，维护者在 51 分钟内回复后 live audit 为 `1 responded_on_time / 0 pending / 0 overdue / 0 late`。该评论是设计建议，不是 M1 报名或真人结果
- [ ] M2-T4 每周发布一个 patch 版本,只修真实用户撞到的问题,不加新功能
- [x] M2-T5 官网增加 30 秒演示视频(配 key → 下任务 → failover → Diff 审查)
  - [x] `CaoGen-Website@e5be292` 已推送 `main`；中文/英文首页均包含原生 MP4 播放器、poster、下载入口与移动端单列布局，官网 `npm run check` 全部通过
  - [x] 生产 `https://caogen.dev/`、`https://caogen.dev/en/` 已出现 `#demo`；`https://caogen.dev/demo/caogen-website-demo.mp4` 返回 `200 video/mp4`，3,369,296 B，SHA-256 `bdb93198b35db545a6af0fd5530b0eb598eb4c5680085f48e3b88810711a553f`

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
5. **北极星**:Weekly Verified Goal Deliveries(周度被真实用户验收的目标交付数)。
   激活指标:N1 30 分钟迁移。两者每周记录,哪怕数字是 0。

## 5. 当前最大风险

| 风险 | 缓解 |
|---|---|
| 单人项目,范围再次膨胀 | 执行规则 1;里程碑完成判据不写"尽量" |
| 0 用户时投入美术/愿景功能 | 水墨 3D 冻结至 M5;创始人每周自问"这周有用户吗" |
| 未签名安装包损失首批用户信任 | M1-T3 是最高优先级,先于一切功能工作 |
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

基线(2026-07-25,STATUS.md):64 个 P0 = **21 已验证 + 18 部分完成 + 24 立项目标 + 1 仅基础**。
已验证、无需排期的 21 项:EXP-001/002、PROJ-001/002/003、GOAL-001、WORK-002、
TEAM-001/002、ROUTE-001/002/003、RUN-001、TRUST-001、AUTO-003/004、VIS-001、
NFR-PRIV-004、NFR-NEUTRAL-001/003、NFR-ENG-003。

剩余 **43 项**全部落在 M4,按依赖排为 5 个波次。排序依据:TRUST/RUN 是恢复与
交付链的底层;ROUTE/TEAM 依赖 RUN 统一契约;ART/NFR-AUD 依赖 Effect/Evidence
基座;EXP/NFR-UX 最后收尾。

### 波次 A:数据与恢复基座(6-8 周,M2 达标后即启动,与 M3 并行)

| ID | 内容 | 当前状态 |
|---|---|---|
| TRUST-005 | v8 Workflow Ledger 全入口闭环 | 部分完成 |
| TRUST-002 | 所有高风险入口注册 Effect 或 fail-closed | 立项目标 |
| TRUST-003 | PR/Issue/MCP 等入口专用对账 | 立项目标 |
| TRUST-004 | 未知结果不自动重放,只读对账或人工确认 | 立项目标 |
| TRUST-006 | 密钥 Broker 完整化(作用域、子进程最小环境) | 仅基础 |
| RUN-002 | 协议 Adapter 完全隔离原始 stream parsing | 部分完成 |
| RUN-003 | 三条协议统一契约(不止 Anthropic 本地闭环) | 部分完成 |
| RUN-005 | 重启恢复所有非终态 Run,区分可重试/待对账 | 立项目标 |
| NFR-REC-001/002/003/005 | 崩溃不丢已确认写入;写入原子可恢复;重启一致;迁移可回滚 | 立项目标 |
| NFR-REC-004 | WorkItem lease 全入口唯一 | 部分完成 |
| NFR-ENG-001/002 | 分层落地;所有 schema 版本化 + 迁移测试 | 立项目标 |

波次判据:崩溃恢复 E2E 全绿(杀掉进程重启后 Board/Run/Effect/Approval/Artifact 一致)。

### 波次 B:路由与数字员工连续性(4 周)

| ID | 内容 | 当前状态 |
|---|---|---|
| ROUTE-004 | 每次路由形成 ModelAttempt,全 Provider 统一契约 | 部分完成 |
| ROUTE-005 | 跨 Provider 切换保持 Goal/WorkItem/Run/上下文连续 | 立项目标 |
| ROUTE-006 | 预算/权限/隐私/能力硬条件高于成本速度偏好 | 立项目标 |
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
| NFR-AUD-001/002/003 | 审计六问可答;按 Run 查看路由/成本/审批/证据;日志脱敏 | 立项目标 |

### 波次 D:体验与隐私收尾(3 周)

| ID | 内容 | 当前状态 |
|---|---|---|
| EXP-003 | 双模式切换的审批/通知/恢复连续性 | 部分完成 |
| PROJ-004 | 项目导出/删除/归档/恢复覆盖所有下属对象 | 部分完成 |
| NFR-UX-001/002 | Assistant 无技术术语;待审批/失败两模式可见 | 立项目标 |
| NFR-PRIV-001/002/003 | 数据默认本地;外发上下文可见可禁;凭据不进 Renderer/日志 | 立项目标 |

### 波次 E:验收冲线(2 周)

- 134 项 closure failure 清零;acceptance map strict closure 通过
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
