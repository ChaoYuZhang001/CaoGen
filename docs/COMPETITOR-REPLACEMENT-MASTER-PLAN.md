# CaoGen 竞品替代主计划

> 版本：1.1-draft（2026-08-04 重新基线）  
> 代码基线：`main@374793c`；当前工作树含未提交增量，因此它只能用于开发探索，不能冒充测试候选或发布候选  
> 排期：2026-08-03 至 2027-07-02，共 48 周  
> 产品目标：用 CaoGen 原生 Runtime、可验证交付和水墨数字员工工作空间，替代用户对 CC Switch、Multica、Codex/Claude Desktop、Hermes、OpenClaw 和 WorkBuddy 桌面端的日常依赖。  
> 状态原则：本文是未来执行计划，不把任何计划项描述为当前已完成；当前事实仍以 `STATUS.md` 和 `1.0-ACCEPTANCE-MATRIX.md` 为准。

本次修订不扩大 1.0 范围，只纠正执行顺序：真人测试不再推迟到功能冻结后，所有用户可见能力从现在起必须通过安装包交付、真人使用、缺陷回流和重新打包复测。水墨人物仍是 1.0 硬门禁，不因提前测试功能包而降级为可选项。

## 1. 完成定义

“替代竞品”不是功能名称数量相同，而是同时满足以下结果：

1. 用户只打开 CaoGen，即可配置模型、管理项目、委派任务、执行工具、处理审批并验收交付。
2. OpenAI、Anthropic、Gemini、DeepSeek、Qwen、Kimi、GLM 和本地模型是 Provider，不是 CaoGen 工作状态的所有者。
3. Codex、Claude Code、Hermes、OpenClaw 仅可作为迁移或兼容适配器，不是 Native Runtime 的前置依赖。
4. 用户可一键迁移 Provider、MCP、Skills、Prompts、项目和可安全导入的历史资产。
5. 所有“完成”都绑定 Artifact、Evidence、Acceptance 和可审计的交付报告。
6. 水墨数字员工不是装饰：身份、位置、动作和状态全部来自持久化真实工作事件。
7. 20 个竞品黄金工作流成功率不低于 95%，30 天无静默丢任务、凭据泄漏或不可恢复数据损坏。
8. 迁移用户使用 30 天后，至少 70% 不再打开目标竞品桌面端。
9. 所有真人结论来自可安装包，而不是开发服务器、源码启动、测试 fixture 或开发者代操作。
10. 一个缺陷只有在修复后的新安装包上复现原步骤并通过，才能关闭；源码测试通过不等于用户问题关闭。

不在本计划内：训练基础大模型、复制厂商私有云服务、未经授权逆向复用闭源代码、承诺厂商未公开的专有能力。

## 2. 当前基线

| 项目 | 当前事实 | 计划出口 |
|---|---|---|
| Native Runtime | OpenAI-compatible、Anthropic Messages 与 Google Generative Language 三条原生路径已存在，Provider-neutral continuation、工具循环与 attempt ledger 已有基础 | 完成真实 Provider、完整能力协商和恢复闭环 |
| P0 | 64 项中 21 已验证，43 项仍开放 | 64/64 release-bound closure |
| 关键恢复 | 11 项中仅 1 项完整闭环 | 11/11 强杀、断网、重复、乱序和磁盘故障闭环 |
| Workflow Ledger | v8 与 canonical 基础已存在，默认仍有 legacy 路径 | canonical 成为唯一生产写入与默认读取来源 |
| Trust/Effect | 多类工具与 IPC 已接入，仍有 direct-user 入口未闭合 | 所有外部副作用可查询或显式 opaque，并可对账 |
| Artifact/Acceptance | 数据模型、失败修复和局部 UI 已存在 | 自动测试、完整 Artifact 生命周期和交付报告 |
| Acceptance Map | 当前存在 `VIS-002..007` 重复映射及 PRD/Matrix 状态文字不一致 | R0 前消除重复、遗漏和状态漂移 |
| 水墨人物 | 49/49 状态母版与正式透明运行时资产已生成、通过自动/QC 拼图门禁并注册；已审计 ASAR 构建输入逐文件 Digest 一致，安装后 Digest 与真人盲测仍开放 | 49/49 透明资产注册、状态映射、安装后 Digest 和真人盲测全部通过 |
| Windows 预览 | v0.1.8 x64 unsigned-preview 配置门禁 20/20、当前 FIX-000 D0 产物审计 40/40；当前 SHA 尚未替换安装，上一 D0 已有保留数据安装、启动、Office 对账与重启证据 | 安装、启动、任务、卸载、审计和真人复测均绑定同一 SHA-256 |
| 真人验证 | 上一 D0 SHA 已有安装/非黑屏/Office/重启的混合验收证据；当前 SHA 的替换安装、完整 installed smoke、首任务和 12 步 Owner required audit 尚未完成 | 本周完成产品 Owner 探索测；R0 前完成干净候选复测；后续逐级扩大用户数 |
| 发布 | 当前 `main@374793c` 与远端一致，但工作树不干净；当前公开版本不是 1.0 stable | 精确提交、跨平台、签名、公证、安装和回滚证据 |

## 3. 发布里程碑

| 里程碑 | 日期 | 对外能力边界 | 必须通过的出口 |
|---|---|---|---|
| R0 Truth + Owner Preview | 2026-08-14 | 内部开发基线与产品 Owner 安装包试用 | 计划/矩阵校准；至少完成一轮 Windows 安装包测试、问题回流、重打包和同场景复测 |
| R1 Trust Alpha | 2026-09-18 | 不对外宣称替代 | 关键写入、Effect、凭据和恢复主干可验证；每个 Sprint 有可安装测试候选 |
| R2 Config Replacement | 2026-10-09 | 可邀请 CC Switch 用户内测 | 配置迁移、Provider Gateway、Failover、用量和退回；至少 3 次真实迁移记录 |
| R3 Coding Replacement Alpha | 2026-10-23 | 内部替代多数编码客户端流程 | 原生任务、worktree、Diff、测试、Artifact 主链 |
| R4 Verified Delivery Alpha | 2026-11-20 | 可验证交付内测 | Goal 到 Acceptance、Repair、Retest 和报告闭环 |
| R5 Watercolor Beta | 2026-12-04 | 首个可评价水墨员工的安装包内测 | 49/49 运行时资产、角色、事件映射、动作、降级、性能和首轮盲测通过 |
| R6 Unified Private Beta | 2027-01-15 | 替代多 Agent 桌面端私测 | Worker、Automation、Remote、渠道与团队基础；不是第一次打包或第一次真人测试 |
| R7 Cross-platform RC | 2027-02-26 | Windows/macOS 候选 | 安装、升级、回滚、安全和关键工作流通过 |
| R8 Feature Complete RC | 2027-04-09 | 功能冻结 | 64/64 P0、指定 P1、20 个黄金工作流全部闭合 |
| R9 Adoption Candidate | 2027-05-21 | 30 名迁移用户 | 7 天 soak、缺陷收敛、支持和遥测边界通过 |
| R10 Public Replacement | 2027-07-02 | 可公开宣称桌面替代 | 30 天 soak、留存、签名发布和最终 Go Record |

## 4. 工作流与责任边界

| 轨道 | 范围 | 主责任 | 外部依赖 |
|---|---|---|---|
| L0 Program/Gates | 需求、任务、依赖、证据、Release Doctor | CaoGen 开发 | 产品冻结与发布授权 |
| L1 Trust/Recovery | Ledger、Effect、凭据、权限、迁移、恢复 | CaoGen 开发 | 故障环境与安全复核 |
| L2 Runtime/Provider | Native Runtime、Adapter、路由、Failover、Usage | CaoGen 开发 | Provider 测试账号和额度 |
| L3 Migration/Gateway | CC Switch 与其他竞品资产导入、代理和退回 | CaoGen 开发 | 本地真实安装样本 |
| L4 Work OS | Project、Goal、WorkItem、Worker、Supervisor、DAG | CaoGen 开发 | 产品规则确认 |
| L5 Verified Delivery | Artifact、Evidence、Acceptance、Repair、Report | CaoGen 开发 | 黄金任务与人工验收 |
| L6 Automation/Remote | Routine、Trigger、Remote Daemon、Team、Inbox | CaoGen 开发 | 测试设备和远程环境 |
| L7 Connectors/Office | MCP、Plugin、Browser、Office、GitHub、消息渠道 | CaoGen 开发 | OAuth 应用和测试组织 |
| L8 Watercolor/3D | 水墨角色、身份、动作、场景、降级、可访问性 | CaoGen 开发 + 视觉资产 | 美术方向和版权确认 |
| L9 UX/Release | Assistant/Studio、安装、升级、签名、性能 | CaoGen 开发 | Apple/Windows 证书与硬件 |
| L10 Human Adoption | 真人迁移、soak、留存、支持和 Go 决策 | 产品/测试用户 | 外部用户和时间门槛 |

关键路径：`L0 -> L1 -> L4 -> L5 -> L9 -> L10`。  
真人反馈回路：`L0 -> L9 可安装包 -> L10 真人测试 -> L0 缺陷回流` 从 W1 开始，每个 Sprint 至少闭环一次，不等待 R8 功能冻结。  
水墨路径：`L8` 从第一周并行；R5 前的功能探索包可以明确标注机器人回退，但不得用于水墨验收，`R5`、`R8` 和 `R10` 均不得绕过 `VIS-002..007`。

## 5. 当前优先执行窗口：2026-08-04 至 2026-08-14

这 10 天先证明“能交到人手里并产生有效反馈”，再继续扩张功能。执行顺序不可颠倒：

| 顺序 | 任务 | 交付物 | 通过条件 |
|---:|---|---|---|
| 1 | `TRUTH-000` 校准主计划、PRD、Acceptance Matrix 与 STATUS | 无重复映射的 Acceptance Map、精确基线和开放缺口 | 自动映射门禁通过，文档计数一致 |
| 2 | `PKG-000` 生成 Windows x64 未签名开发探索包 | EXE、大小、SHA-256、HEAD、`worktreeClean=false` 和审计报告 | 配置、build、native prepare、NSIS、安装后启动 smoke 完成；所有 dirty 限制明确披露 |
| 3 | `OWNER-TEST-000` 产品 Owner 在非开发入口完成探索测 | 私有测试记录、截图/录屏、阻断点、问题清单 | 只从 EXE 安装和启动，不运行源码，不由开发者代操作 |
| 4 | `FIX-000` 修复 Critical/High 与首任务阻断 | 每个问题的复现、原因、测试和回归证据 | Critical 为 0；High 已修复或有明确 No-Go，不以解释替代修复 |
| 5 | `PKG-001` 从精确干净提交重打 Windows 测试候选 | 新 EXE、新 SHA-256、完整 required audit 与 packaged smoke | provenance 为 clean，包名明确 unsigned-preview，不生成 stable update metadata |
| 6 | `OWNER-RETEST-001` 在新包复跑失败场景和首任务 | 与 `PKG-001` SHA-256 绑定的结果记录 | 原阻断全部复测；失败则返回步骤 4，不进入下一里程碑 |

当前这轮 `OWNER-TEST-000` 建议按 60 分钟时间盒执行：全新安装/自定义目录、首次启动、Provider 配置、打开本地项目、完成只读首任务、招聘数字员工、观察真实任务状态、生成一个 Office 产物、重启恢复、卸载。FIX-000 新 SHA 的精确人工步骤见 [`OWNER-FIX-000-RETEST.md`](OWNER-FIX-000-RETEST.md)。CC Switch/Codex/Hermes 迁移只在测试者愿意使用脱敏副本时执行；不得读取或记录真实 API Key。正式水墨运行时资产已达到 49/49，本轮可以评价包内水墨视觉与状态映射，但不能替代独立的无标签盲测。

截至 2026-08-06，本窗口仍为 **No-Go**。最新 FIX-000 D0 `unsigned-preview` 安装器大小为 220,748,412 bytes，SHA-256 为 `8da0d31fe2de689dd321a5f72da292a830e7386246cd78015d80c33a0b1b7a44`，artifact-set SHA-256 为 `04c098f9f16d96fa17cd81b14917557197740574cc495d24cac6b67557c07832`；产物审计 40/40 通过，确认 x64、app/installer 均未签名、无 stable update metadata、dirty provenance，以及自定义 NSIS 卸载确认与失败恢复钩子均已打入安装器。49/49 水墨运行时资产与该 artifact-set 绑定并通过 packaged-build-input 审计。当前本机仍安装上一 D0，当前精确 SHA 尚未完成保留数据替换安装、automated packaged smoke、首任务复跑或独立卸载；该包仍是 dirty D0，不能冒充 C1。

旧 D0 的 unsigned NSIS 安装曾在通过 SmartScreen 后报 `Failed to uninstall old application files...: 2`，未产生隔离安装文件。只读预检当时确认本机存在 all-users CaoGen 0.1.8 卸载项；同一产品的 NSIS 升级语义会先调用旧卸载器，不能把 `/D` 当作隔离保证。默认 smoke 因此在启动 EXE 前明确返回 `installation.status=blocked`，没有再次启动安装器。Owner 后续移除了既有安装；空计划目录、卸载注册与进程检查均恢复为干净状态，随后才执行新的 SHA 绑定 smoke 和人工预检。

最新 unpacked 构建在隔离用户目录的首次启动和重启分别于 1064 ms、1023 ms 达到可交互状态；两次均有非空 React 根节点、ready preload、欢迎/首任务输入区，且 `documentLanguage=zh-CN`、设置语言为 `zh`。Provider Profile 对账失败现在保留可诊断外壳并继续 fail-closed，而不是退出整个应用。该 `development_diagnostic` 只缩小 S1/S2 的源码/打包定位范围，不能关闭 installed S1/S2，也不能替代 Owner 复测。已审计 ASAR 构建输入的 49 张水墨资产逐文件大小与 SHA-256 全部一致；这仍不是安装后 Digest 或真人视觉验收。

FIX-000 有两个独立机器门禁：installed smoke 与 12 步 Owner required audit。为保持“非开发入口”，当前 SHA 已生成不依赖源码、Git、npm 或系统 Node 的 Windows x64 便携复测包；ZIP 为 253,989,974 bytes，SHA-256 `eb12a7fd12667f07a70ede967e23367bb83081bcbf821f208654c9ae18175758`，十文件 manifest SHA-256 `20a7fbf70decc55747f036f3c64962931c964a9d4976c9d76ae47ab5b52ea9b7`，content-set SHA-256 `9660960cc159dbffe5b9190015899bcbb422fa483d24bbf77f922b37e908371b`。包内预检在安装前验证精确 D0、交互桌面、无运行进程/既有卸载注册和计划安装目录；installed smoke 只有 Owner 输入确认词后才启动，并要求 Owner 亲自处理 SmartScreen/UAC，失败时保留现场。上一 SHA 的仓库 required audit 与失败 Owner 观察仍保留为缺陷发现证据，均不满足当前 SHA。当前 installed smoke 与 Owner required audit 仍待执行，仍禁止整理 clean commit 或进入 `PKG-001`。

同一保留安装在 Owner 继续观察时新增 `S3 High`：真实 OpenAI-compatible Provider 保存成功，凭据仍以 `enc:` envelope 持久化，Provider health 的最近结果为成功，但任意首任务都无法创建会话。原生窗口再次确认可见错误为 `WorkflowLedgerMigrationError: Committed migration target durable history regressed`；根因是旧 committed v8 journal 尚无 Conversation Ledger 证据，而 v9 readiness 在新投影表缺失时丢弃了已经成功验证的 Workflow Ledger / task-evidence 子项，continuity 因而把可加法修复的 schema gap 误判为历史回退；Provider 请求并非阻断点。FIX-000 源码现保留 partial verification、继续严格比较已有高水位，并加入“旧 committed v8 -> 新增 Conversation Ledger -> v9”回归。`test:workflow-ledger-migration`、`typecheck`、production build、40/40 package audit 与 `git diff --check` 通过，修复已绑定当前 D0 SHA。另一个脱敏真实数据副本诊断只复制数据库与迁移证据，并把绝对路径绑定重写到临时副本；该副本从 v8 升到 v9、Conversation Ledger 表建立、既有受检表行数保持、两个原失败 IPC 恢复且源文件聚合摘要前后相同。该诊断仍不能关闭 installed High；当前安装是旧二进制，S3 必须在当前 SHA 安装后复跑原步骤才能关闭。

安装目标偏移的只读归因也已收敛到测试入口缺口：旧 manual-flow preflight 只验证 Owner 提供的计划目录，随后由 Owner 另行启动安装器，工具从未把该目录作为 `/D` 参数传给同一次 NSIS 调用，也没有安装后 registry/path binding 证明。因此现有证据无法在“人工选择偏差”和“安装器忽略选择”之间作事实归因。FIX-000 现新增 `RUN-FIX-000-ASSISTED-INSTALL.cmd`：同一 Owner 触发入口先执行 clean-host preflight，再以最后且唯一的 `/D=<planned>` 参数启动交互安装器，结束后仅验证应用文件、卸载器、交互/静默卸载注册命令均绑定预检目录；成功安装保留给后续人工测试，不自动启动、卸载或清理。合同 smoke 已通过，且在当前仍有安装注册项的主机上负向实测正确 fail-closed、`installerInvoked=false`。该 runner 已进入当前 SHA 绑定 kit，安装 High 仍需 clean-host 正向安装与 Owner 复测后关闭。

2026-08-05 的 Section 5 installed continuation 已把上一 D0 推进到真实界面：本次使用 SHA-256 `593b91eaca02381a5006e6dae49fe2ad499ba4626126d42468df66e609038e7a` 的安装器静默替换并保留既有用户数据，安装退出码为 0。当前安装的 `CaoGen.exe` 为 0.1.8、213,968,384 bytes、SHA-256 `38acc48809786e96d3a2445348e5b598b17844bba21769d7266ab020f03863d6`，与该旧包的 `win-unpacked` EXE 逐字节摘要一致。替换前后 8 个关键状态文件 SHA-256 不变；5 个 Provider、3 个项目、1 个数字员工、1 个 assignment、62 个会话均保留，10/10 持久化凭据仍为 `enc:`。重启后的离屏窗口捕获显示中文菜单、会话列表和恢复界面均非黑屏，私有截图 SHA-256 为 `7a7cdf0af6fc6856d16e06c635b14aaadb426a178046c88c0e5e50f504509983`；截图含本地路径，只保留在私有证据目录。该证据不能满足当前 `8da0d31f…` SHA 的 installed smoke 或 12 步 Owner required audit。

前一 D0 已验证 Provider token 全部以 `enc:` envelope 持久化，错误界面的 Provider URL 显示为 `[provider-url-redacted]`；一条槽位 2 的原生 Anthropic 历史会话通过 `list_dir`、两次 `read_file` 与 `git_status` 在约 25.1 秒内完成，只读任务结果 `isError=false`，源项目与隔离 worktree 均无 Git 改动，两个受控文件的 SHA-256 前后一致。Studio 已招聘并持久化 1 名只读数字员工，创建并分配 1 个真实 WorkItem 后，界面与状态文件均显示 `active` assignment；最终 D0 第二次启动后数字员工、assignment、会话历史、目标 worktree、`backups/` 与 62 份 `event-receipts/` 均存在。由于最终 D0 在 Office 修复后重新打包，前一 D0 的真实首任务不能替代最终 SHA 的首任务复跑。

本轮新增 `S4 High`：设置页能把默认 Provider 槽位 2 和具体模型写入 `settings.json`，但新会话仍保存为其他槽位的 `model=auto` 并进入全局自动路由。该缺陷已在源码层修复：欢迎草稿持久化 schema 升级到 v2，并区分默认来源与用户明确选择；旧 v1 `global + auto` 迁移为默认来源，默认来源始终跟随 `defaultProviderId/defaultModel`，明确选择则保持固定。`test:provider-default-session-routing` 包含精确旧状态迁移和真实主进程临时 Provider 合同测试，并与 `test:model-router`、`test:model-failover`、`test:first-task-onboarding` 15/15、`test:anthropic-engine-registration`、`typecheck`、production build 一并通过；最终 D0 产物审计 40/40 通过。前一 D0 的真实只读首任务已通过，但最终 SHA 仍需在真实界面复跑，因此 S4 暂不关闭。

本轮随后发现 `S5 High`：普通本地项目只有 legacy `projectId`、没有同 ID `ProjectWorkspace` 时，`create_document` 已写出文件，但 Artifact 登记因 `ProjectWorkspace not found` 失败，Effect 留在 `effect-unknown`，Evidence 与 Acceptance 均缺失。修复后，只有 Workflow Ledger 明确投影为 `legacy-derived`，且 Project/WorkItem/Run 所有权完全一致时，才允许使用 `projectRevision=0` 登记 Office Artifact；存在 ProjectWorkspace 时仍执行原严格校验，跨项目登记仍拒绝，legacy Artifact 也不会伪造不存在的 stage handoff。`test:office-delivery:required` 41/41 通过，其中 25 个负向路径；上一 D0 首次启动后把原 unresolved Effect 幂等对账为 `confirmed`，并补齐 `legacy-derived` Artifact、delivery Evidence、`verifies` link 和 `passed` Acceptance。真实 DOCX 为 8,593 bytes，SHA-256 `7bbfe7d9defc86504e35cd6447087429a7748906ef3c6b647e2c6425936b5688`，ZIP 含 22 个部件，必需 OOXML 部件齐全且 `word/document.xml` 可解析；第二次完整重启后上述链条与文件摘要保持不变。原 Run 继续保留 `failed` 历史，不篡改旧失败事实。本机没有 LibreOffice 或 Microsoft Word，因此 DOCX 逐页视觉渲染未执行，只能判定结构有效。当前 SHA 首任务复跑与独立卸载仍开放；在此之前继续保持 `FIX-000 / No-Go`，不得进入 `PKG-001`。

2026-08-06 对当前精确 D0 的保留数据替换安装首次尝试未完成：安装器等待 120 秒后显示 `Failed to uninstall old application files. Please try running the installer again.: 2`。旧 CaoGen 进程已退出且活动会话为 `idle`；独占锁扫描只发现旧安装的 `resources/app.asar` 被 WorkBuddy 后台进程持有，Windows Restart Manager 给出同一归因。失败后旧 EXE/卸载器完整，8/8 关键用户状态文件摘要不变，当前 D0 未安装。证据见 `test-results/fix-000-replacement-install/2026-08-06T00-46-40Z/report.json`。关闭 WorkBuddy 超出 CaoGen 安装的既有授权，需 Owner 操作或明确授权后才能重试；该结果继续保持 `FIX-000 / No-Go`。

同日外部 WorkBuddy 锁清除后，当前精确 D0 已以退出码 0 完成保留数据替换安装；安装 EXE SHA-256 为 `e02013702d1bc778b9314c51ea8b098c371ab2e1c3dedbfeb44251ab5160b6b6`，与该包 `win-unpacked` EXE 一致。真实只读首任务按保存的具体 Provider/model 创建 `routingScope=fixed` 的 Anthropic 会话，执行 `list_dir` 与两次 `read_file`，3/3 工具结果无错，`turn-result=success`，会话最终 `idle`。源项目 Git 用户条目为 0；隔离 worktree 只有 1 条 `.caogen` 审计日志、用户条目为 0；10/10 凭据仍为 `enc:`。证据见 `test-results/fix-000-first-task/2026-08-06T-installed/success-summary.json`。这关闭了当前 SHA 的 S4 首任务路由与只读项目改动复测，但不等于 installed smoke 或 12 步 Owner required audit 通过；卸载两步仍未执行，继续保持 `FIX-000 / No-Go`。

随后 Owner 在当前 D0 卸载确认中选择 **Yes**。只读核查确认安装目录、CaoGen 卸载注册和 CaoGen 进程均已清除；Roaming 用户数据仍存在，`providers.json` 可解析且保留 5 个 Provider、5 个 API-key 记录和 10/10 `enc:` 凭据，`backups/` 与 `event-receipts/` 仍有内容。`Local/caogen-updater` 保留 1 份 SHA-256 为 `8da0d31fe2de689dd321a5f72da292a830e7386246cd78015d80c33a0b1b7a44` 的安装器缓存，桌面还保留安装器文件；它们作为残留单独记录，不是已安装应用或应用快捷方式。证据见 `test-results/fix-000-uninstall/2026-08-06T13-09-47+08-00/report.json`。Owner 第 11 步后置条件通过，但第 10 步“选择 No 并验证仍可启动”被跳过；要严格完成 12 步流程，仍须用同一 SHA 重装后先取消卸载、验证重启，再次确认卸载。installed packaged smoke 和完整 Owner required audit 仍开放，继续保持 `FIX-000 / No-Go`。

当前 D0 随后通过了隔离 packaged smoke：精确安装器、未签名状态、preload-ready 非空 Renderer、静默卸载、安装目录/注册清除和隔离用户数据保留均通过；私有 smoke record SHA-256 为 `8e72cb6bc7b35840cd342b1b58a5280ee42502ce834cc7c32a6374f51de68840`。路径绑定的交互安装也已通过，`D:\app\CaoGen` 中的应用、直接卸载器和两条卸载注册命令均指向计划目录；已安装 EXE SHA-256 为 `e02013702d1bc778b9314c51ea8b098c371ab2e1c3dedbfeb44251ab5160b6b6`，私有 assisted-install 结果 SHA-256 为 `120747e8739228f400567d39c6be139f21ecf10960b337d057c0f57ba3eb95c7`。这些关闭了当前 SHA 的 packaged/path-binding 门禁，但不关闭 Owner 12 步流程；当前安装保留给人工复测，仍保持 `FIX-000 / No-Go`。

Owner 随后选择卸载确认 **No**。安装目录、卸载注册和当前 D0 EXE 均保留；按授权执行重新启动后，响应正常的 `CaoGen` 主窗口出现，用户数据仍为 5 个 Provider、5 个 API-key 记录和 10/10 `enc:` 凭据。证据见 `test-results/fix-000-owner-step10/2026-08-06T13-41-41+08-00/report.json`。这关闭了取消卸载/重启后置条件，但最终选择 **Yes** 的卸载仍需执行，Owner 12 步审计尚未闭环。

Owner 最终选择卸载确认 **Yes** 后，CaoGen 进程、卸载注册和所有应用文件均已清除，Roaming 用户数据仍保留且 10/10 凭据为 `enc:`；但 `D:\app\CaoGen` 本身留下了空目录。该结果不满足“安装目录消失”的清洁卸载条件，证据见 `test-results/fix-000-owner-step11/2026-08-06T13-44-42+08-00/report.json`，按 `Low` 记录为卸载清洁度缺陷。不得用手工删除空目录掩盖安装器缺陷；当前 Owner 审计失败，回到 `FIX-000 / No-Go`，修复并重新生成精确 SHA 后才能进入 `PKG-001`。

## 6. 安装包与真人测试协议

### 6.1 三类包必须分开

| 层级 | 工作树与签名 | 允许用途 | 不允许的结论 |
|---|---|---|---|
| D0 开发探索包 | 可为 dirty；Windows 可未签名，但必须显式标注并记录 provenance | 产品 Owner 快速发现安装、启动、流程和 UI 问题 | 不计入 release gate、跨平台 ready、正式水墨验收或“可替代竞品” |
| C1 测试候选 | 必须绑定精确 clean commit；预览签名策略可按平台明确披露 | 目标用户、迁移、黄金工作流和缺陷复测 | 未通过 required audit 不得对外分发或累计稳定性证据 |
| RC/正式包 | clean commit、冻结版本与资产、目标平台正式签名/公证 | 7/30 天 soak、留存、最终发布 | 任一平台预览证据不得冒充正式平台通过 |

### 6.2 每轮测试的最小证据

1. 包名、版本、平台、架构、文件大小、SHA-256、HEAD、工作树状态和签名状态。
2. 打包配置审计、产物审计、安装后启动 smoke，以及没有意外 update metadata 的证明。
3. 测试者环境、开始/结束时间、是否需要主持人帮助、完成/失败步骤和主观阻力。
4. 每个问题的严重度、最短复现、期望/实际、截图或录屏位置，以及是否涉及数据/凭据风险。
5. 修复提交、新包 SHA-256 和原场景复测结果；旧包上的“看起来修了”不能关闭问题。
6. API Key、Provider URL、私有项目名/路径、通知和个人信息只保留在受控私有记录中，公开报告必须脱敏。

### 6.3 严重度与停止规则

- `Critical`：数据丢失、凭据泄漏、权限逃逸、不可恢复损坏或重复外部副作用。立即停止该包测试并 No-Go。
- `High`：无法安装/启动/配置 Provider/完成首任务，或主要流程无可用恢复路径。本轮不得判定通过。
- `Medium`：有明确绕行但显著影响效率、理解或迁移完整性。进入当前或下一 Sprint，必须指定 owner。
- `Low`：不阻断任务的视觉、文案或轻微交互问题。可排队，但水墨辨识、状态误导和布局溢出不得降为 Low。

## 7. 48 周详细排期

### Sprint 01：W1-W2，2026-08-03 至 2026-08-14

执行基线与唯一映射见 [`SPRINT-01-GATE-BASELINE.md`](SPRINT-01-GATE-BASELINE.md)，可重复检查命令为 `npm run test:sprint-01-gates`。该文档记录当前 D0 包与 Owner 人工证据的真实状态；它不把 dirty preview 或源码 smoke 升级为 C1/正式验收。

- [ ] `GATE-001` 冻结“替代”的用户、产品和技术边界。
- [ ] `GATE-002` 定义 20 个黄金工作流及竞品基准数据。
- [ ] `GATE-003` 将 64 个 P0、38 个 P1 与本计划任务建立唯一映射。
- [ ] `ARCH-001` 冻结 Domain、Adapter、Runtime、Trust、Persistence、UI 分层规则。
- [ ] `VIS-001` 完成水墨风格圣经、角色清单、动作词典和版权来源规范。
- [ ] `QA-001` 建立每项任务的自动、人工、时间、硬件和外部凭据证据分类。
- [ ] `PKG-000/OWNER-TEST-000/FIX-000/PKG-001/OWNER-RETEST-001` 完成当前优先执行窗口的一次开发探索包和一次干净候选闭环。

出口：Acceptance Map 无遗漏/重复；黄金工作流、依赖图和首批 Gate 命令经过评审；Windows 包至少完成“安装测试 -> 缺陷回流 -> 新包复测”闭环。

### Sprint 02：W3-W4，2026-08-17 至 2026-08-28

- [ ] `REC-001` 建立全部 durable writer 清单、schema/version 和原子策略。
- [ ] `REC-002` 为短写、ENOSPC、强杀、fsync/rename 建立统一故障注入框架。
- [ ] `TRUST-001` 冻结 Effect 类型、Target、lease、postcondition 和对账契约。
- [ ] `CRED-001` 冻结 credential project/session/operation/expiry 作用域。
- [ ] `VIS-002` 产出研究、策划、写作、设计、开发、测试、运维七类人物概念稿。
- [ ] `UX-001` 冻结 Assistant 与 Studio 对同一 canonical 状态的投影契约。

出口：所有持久写入和外部副作用均有明确 owner；未知入口默认 fail-closed；至少 1 名非开发参与者在 C1 包完成首任务，无 Critical/High 阻断。

### Sprint 03：W5-W6，2026-08-31 至 2026-09-11

- [ ] `LEDGER-001` 将 Project/Goal/WorkItem/Run/Artifact/Acceptance 写入统一 canonical ingress。
- [ ] `LEDGER-002` 完成 legacy/compare/canonical cutover、回滚和连续性验证。
- [ ] `EFFECT-001` 接入剩余 direct-user 外部 IPC。
- [ ] `EFFECT-002` 为 queryable 与 opaque Effect 建立强杀对账和人工处置 UI。
- [ ] `CRED-002` 完成 Keychain、旧凭据迁移和进程内降级。
- [ ] `VIS-003` 完成首批人物资产管线和 DigitalWorker identity prototype。

出口：默认读写可切换到 canonical；任何未决 Effect 阻止自动重放。

### Sprint 04：W7-W8，2026-09-14 至 2026-09-25

- [ ] `REC-003` 完成 Snapshot/Run/Effect/Board/Approval/Artifact/Acceptance 重启一致性。
- [ ] `REC-004` 完成 WorkItem 级唯一执行 lease、fencing 和过期写拒绝。
- [ ] `PERM-001` 统一文件、命令、网络、GUI、MCP 和复合工具语义权限。
- [ ] `SECRET-001` 建立 renderer/log/transcript/export/crash-report 全出口 secret canary。
- [ ] `RUNTIME-001` 冻结 ModelProviderAdapter 与 Native Runtime capability contract v1。
- [ ] `VIS-004` 将人物身份、Role、Assignment 与 Compute Badge 分离。

出口：R1 Trust Alpha；所有高风险入口有执行前记录、执行后结果和恢复决策。

### Sprint 05：W9-W10，2026-09-28 至 2026-10-09

- [ ] `PROVIDER-001` 完成 OpenAI Responses/Chat 与 Anthropic Messages 契约一致性。
  - [x] Gateway 转换子切片已支持 Anthropic `/v1/messages` 到 OpenAI Chat Completions：system、文本/受限图片、stop、tools/tool_choice、tool_use/tool_result、非流式 Message、流式 SSE、x-api-key 和有界上游错误包络均已接通；真实 Electron Gateway `35/35` 通过，最新 unsigned preview SHA-256 为 `B382BE3C86AD07604843B7EA6206F10B71CF6C4832594A4EEA6FE44388FA0676`。
  - [x] 原生 Anthropic 结构化运行配置已接入 Messages Engine：`max_tokens`、temperature/top_p/top_k、Thinking 的 disabled/adaptive/enabled 与预算/显示模式、Prompt Cache 的 automatic/system/tools/last-user 和 5m/1h TTL 均由类型化配置驱动；Thinking replay 缺签名时 fail-closed，旧 `request.body` 继续兼容。Messages `19/19`、Tool Loop `10/10 + 1 环境跳过`、Failover `10/10`、配置 `43/43 + 26/26`、真实 Electron UI `8/8` 通过。
  - [ ] 原生 Anthropic 多模态完整覆盖、真实 Provider 交接和 clean candidate 绑定仍开放，故 `PROVIDER-001` 总项不关闭。
- [ ] `PROVIDER-002` 增加 Gemini 原生 Adapter，并保留厂商扩展能力。
  - [x] 本地生产路径已接入 Google Generative Language `streamGenerateContent`：原生 `x-goog-api-key` 租约、system/text/image、tools/functionCall/functionResponse、SSE/JSON、usage、Provider 计价和有界错误均不经过 OpenAI 协议伪装。
  - [x] Provider 高级配置已加入 Gemini 独立 `topK`、Thinking level/budget/includeThoughts；thought/function signature 在流式聚合、持久 transcript、重启恢复和工具结果回放中保留，缺失或中途变化时 fail-closed。
  - [x] 合同 smoke `7/7` 与隔离真实 Electron 本地 mock `6/6` 通过，覆盖图像、工具循环、Google 凭据头、无 Authorization、配置到实际 wire body、计费、`760x700` 和进程重启；统一 Adapter parity 同时通过 OpenAI、Anthropic 与 Gemini。
  - [x] 本地 Gateway 已增加 Google Generative Language `/v1beta/models`、`:generateContent` 与 `:streamGenerateContent?alt=sse` 原生入口；请求/响应不翻译，保留 inlineData、functionCall/functionResponse 与 thoughtSignature，入口 `x-goog-api-key` 不向上游传播，目标 Gemini Provider 凭据通过 lease 独立注入。usageMetadata、Thinking token、缓存 token 与配置计价进入统一账本。
  - [ ] 真实 Google 付费账号、完整 Gemini 多模态/模型能力矩阵、跨月账单准确性和 clean candidate 绑定仍开放，因此 `PROVIDER-002` 总项不关闭。
- [ ] `ROUTE-001` 完成 capability、privacy、region、local-only、budget 硬策略。
- [x] `FAILOVER-001` 完成 Key、Provider、模型分层切换和幂等重试边界。OpenAI-compatible 与原生 Anthropic 当前均按“瞬时重试 -> Key/OAuth 账号 -> 同 Provider 模型 -> 同协议 Provider”恢复，并以同一逻辑 requestId、Attempt predecessor、未决 Effect 与部分输出门禁阻止不安全重放；Responses -> Chat Completions 会话级降级、自动恢复耗尽后的人工接管入口和三类恢复事件的耐久账本也已接通。本地真实 Electron OpenAI mock、Anthropic 10/10、ModelAttempt 15/15、Native Runtime 20-event 合同及统一六级 required gate 已通过。真实 Provider 交接与 clean release 绑定仍由 `ROUTE-010` 收口。
- [x] `MIG-001` 完成 CC Switch Provider/MCP/Skill/Prompt 导入、校验和退回。
  - [x] Provider 批量迁移切片：只读扫描 CC Switch SQLite，按 Codex/Claude 正确映射 OpenAI Responses、Chat Completions 与 Anthropic Messages，预览名称/Base URL/模型/定价/倍率/月预算/端点，凭据只在主进程导入；支持逐项新建/更新/跳过、来源与目标漂移拒绝、脱敏批次备份和一键回滚。合同 smoke `29/29`、真实 Electron E2E `13/13`，本机真实库只读兼容预览确认 6 个记录中 5 个可导入且数据库前后 SHA 不变。
  - [x] MCP/Prompt/Skill 资产迁移切片：只读扫描同一 SQLite，MCP 仅映射安全字段并剥离 `env`，Prompt 转为 CaoGen prompt-only Skill，Skill 复制到 CaoGen 全局 Skill 根目录；敏感内容在 Renderer 前阻断，应用前重读数据库/目录并核对目标指纹，批次私有备份支持故障恢复和一键回滚。
  - [x] 历史用量迁移切片：从 `usage_daily_rollups` 生成独立、带摘要的外部日汇总账本，合并请求/成功数、四类 Token、成本、加权延迟、趋势及 Provider/模型统计，不复制逐请求内容、不伪造 ModelAttempt、不声称外部凭据归属。Provider/资产/Usage 合同与 UI 门禁分别达到 `30/30`、`22/22`、`43/43 + 25/25`、`13/13 + 18/18 + 35/35`；本机真实库只读预览识别 MCP、Prompt、Usage 三项且均可迁移，数据库前后 SHA 不变。
  - [x] Provider 可靠性策略迁移切片：只读读取 `proxy_config`，按 Claude/Codex 独立迁入自动切换、最大恢复次数、五项熔断参数和首字节/流空闲/非流式超时；运行时以 Provider 配置覆盖全局策略。首字节计时从 fetch 前开始并在首个非空响应块后切换为空闲计时，非流式总超时覆盖网络与响应消费；Provider 超时与用户取消保持独立语义。Provider smoke `37/37`、超时 smoke `15/15`、熔断 smoke `11/11`、完整 CC Switch required gate 和真实库只读预览通过，数据库前后 SHA 不变。代理监听/接管/日志不导入并显式告警。
  - [x] Provider 批次 apply/rollback 强杀恢复：备份状态机与 Provider operation journal 绑定同一 operation ID；启动和读取时只按精确 before/desired Store digest 对账，不自动重放。真实跨进程 `SIGKILL` gate `12/12` 覆盖 journal prepare 后、apply Store commit 后和 rollback Store commit 后强杀，以及凭据保留、备份无明文和来源 CC Switch 数据库字节不变。
  - [x] Provider 本地同步目录切片完成：支持 OneDrive/Dropbox/iCloud/NAS 文件夹、版本包络、远端历史、三方关系判断、冲突预览、原子发布、凭据排除和启动对账；`26/26` 专项 smoke、`145/145 + 13/13 + 67/67` Provider 回归通过。
  - [x] Provider WebDAV 切片完成：原生 `PROPFIND / MKCOL / GET / PUT`、Basic Auth、不可变历史、ETag CAS、系统加密密码和公网 HTTPS 门禁；安全自动发布只处理远端缺失或本机领先，显式自动拉取只应用远端单方新版本。WebDAV `35/35`、Electron UI `70/70` 通过。
  - [x] Provider S3/S3-compatible 切片完成：AWS SigV4、Region/Bucket/Prefix、自定义 HTTPS 端点、path-style、临时 Session Token、不可变历史、ETag 条件写入和系统加密凭据；安全自动发布/拉取沿用 WebDAV 的非覆盖冲突策略。S3 `36/36`、Electron UI `70/70`、durable inventory `13/13` 通过。
  - [x] 远端历史恢复 UI：WebDAV/S3 均有最近 20 个版本的有界列表、逐项预览和恢复，应用前复核 revision/内容摘要并复用私密备份与 operation journal；不因浏览或本机恢复改写远端 current。
  - [x] 本机真实样本隔离 apply：Provider 直接只读真实库并在临时 CaoGen 用户目录完成 apply/rollback `16/16`；MCP/Prompt/Skill/Usage 从真实源副本写入临时 home 并完成批次 apply/rollback `12/12`。目标无明文凭据、rollback 恢复初始状态、源数据库字节身份不变。
  - [ ] R2 仍等待至少 3 次真人正式 UI 迁移记录及 10 分钟出口计时；隔离自动化证据不替代真人使用证据。
- [x] `GATEWAY-001` 完成本地代理、健康检查、熔断、用量与精确成本基础。Gateway 仅绑定 `127.0.0.1`，提供 OpenAI-compatible `/v1/models`、`/v1/chat/completions`、`/v1/responses`，Anthropic `/v1/messages`，以及 Google Generative Language `/v1beta/models`、`:generateContent`、`:streamGenerateContent?alt=sse`。网关 Token 由系统加密且不返回 Renderer，Provider 凭据只通过一次性 lease 注入。模型歧义、重定向、端口冲突和超限请求均 fail-closed；流式转发遵守背压，并复用 Provider 超时、熔断、Key 健康、usage 与计价账本。真实 Electron Gateway `46/46`、Provider usage `48/48`、Dashboard `34/34` 和统一三引擎 Adapter parity 通过。
  - [x] Anthropic Messages 到 OpenAI Gateway 的协议转换已完成并由真实 Electron `35/35` 覆盖。
  - [x] Gemini Gateway 原生入口已完成：Google JSON/SSE、图像、签名函数调用/结果回放、模型歧义与 namespaced 路由、凭据隔离、有界 Google 错误包络、usage/Thinking/cache token 和配置计价均由真实 Electron `46/46` 覆盖；设置页同时显示 OpenAI `/v1` 与 Google `/v1beta` 地址及模型协议。
  - [x] 网关内请求级跨 Provider 自动 failover 已完成：仅在下游响应未提交前对网络/超时、401/403、429 和选定 5xx 做同引擎同线协议切换；每次尝试独立租赁凭据并写入共享 requestId/序号/前驱的 usage/pricing 记录。
  - [ ] 真实付费账号与跨月成本准确性仍开放；本项完成不关闭 `PROVIDER-001`、`PROVIDER-002` 或 `ROUTE-001`，也不代表 clean candidate、安装器或 1.0 已完成。

出口：R2 Config Replacement；真实 CC Switch 样本可在 10 分钟内迁移并回退。

### Sprint 06：W11-W12，2026-10-12 至 2026-10-23

- [ ] `RUNTIME-002` 完成流式 Tool Call、Thinking、缓存、多模态、取消和上下文压力。
- [ ] `RUNTIME-003` 完成每次 HTTP attempt 的持久化、恢复授权和 predecessor 链。
- [ ] `CODE-001` 收口 worktree、Diff、文件编辑、终端、Git 和 Preview 主链。
- [x] `CODE-002` 完成测试命令识别、结构化退出和失败证据。
- [ ] `IDE-001` 建成 CaoGen 内建代码工作台：项目树、全文/符号搜索、多标签编辑、LSP 跳转/补全/诊断、Diff、终端、Git、测试和调试入口；不依赖 VS Code/JetBrains 插件。
- [ ] `IDE-002` 建立内建工作台黄金门禁：大型仓库索引、跨文件修改、诊断修复、测试失败定位、断点调试、Git 审查、崩溃恢复和键盘可达；旧 IDE 插件不得作为通过证据。

2026-08-10 增量：Code 工作区现以“文件 / 测试 / 调试 / 重构”一级标签提供受限开发入口。测试入口只从项目清单和固定约定发现 npm/pnpm/yarn/bun、pytest、Cargo、Go 与 Gradle 测试，Renderer 不能传入可执行文件、参数或工作路径。调试入口从 package main/bin、受限 node/tsx 脚本和有界工作区入口发现目标，目标 ID 绑定 manifest 与入口文件身份；主进程使用 Node Inspector 提供断点、继续、暂停、单步、停止、调用栈、局部变量和对象展开，Renderer 只传 Session、目标 ID、项目相对断点。专项调试 smoke 为 `16/16`，可见 Electron 调试 UI 为 `13/13`，测试工作台回归仍为 `26/26` 与 `11/11`。`CODE-002` 技术关闭；`IDE-001/002` 仍需代表性 50,000 文件混合语言、网络文件系统/持续 watcher storm 和真人重度任务黄金证据。
- [ ] `MIG-002` 完成 Codex/Claude/Hermes/OpenClaw 项目与安全资产索引导入。
- [ ] `VIS-005` 完成待命、思考、工具执行、等待审批、失败和完成的首版动作。

出口：R3 Coding Replacement Alpha；编码黄金工作流无需打开外部 IDE，也不安装任何 IDE 专用插件。

### Sprint 07：W13-W14，2026-10-26 至 2026-11-06

- [ ] `GOAL-001` 完成 Goal Contract、范围、约束、预算、期限和验收标准编辑。
- [ ] `PLAN-001` 完成 Goal 到可审查 WorkItem/Acceptance 草案，不自动冒充执行完成。
- [ ] `WORK-001` 完成 WorkItem 状态机、依赖、owner、lease、重试与人工控制。
- [ ] `ART-001` 完成 Artifact blob/sourceRef、版本、位置、校验和生命周期。
- [ ] `EVID-001` 完成 Evidence 来源、Digest、Run/Effect/Artifact/criterion 绑定。
- [ ] `VIS-006` 把 WorkItem/Run/Approval/Artifact 事件映射到水墨人物和场景。

出口：从一句目标可以生成可编辑计划，并以 canonical 对象开始执行。

### Sprint 08：W15-W16，2026-11-09 至 2026-11-20

- [ ] `ACCEPT-001` 完成 criterion policy、验证者、证据下限和用户批准。
- [ ] `VERIFY-001` 完成测试、构建、Diff、截图、引用和远端状态验证器。
- [ ] `REPAIR-001` 完成失败到 Repair WorkItem、修复、Retest 和新版 Acceptance。
- [ ] `REPORT-001` 生成目标、范围、改动、产物、测试、成本、风险和批准报告。
- [ ] `AUDIT-001` 建立 actor/role/time/reason/model/tool/result 完整时间线。
- [ ] `QA-002` 跑通首批 10 个本地黄金工作流和故障注入。

出口：R4 Verified Delivery Alpha；“完成”只能来自 Acceptance 终态门禁。

### Sprint 09：W17-W18，2026-11-23 至 2026-12-04

- [ ] `VIS-007` 完成七类角色正式资产、统一轮廓和角色辨识度测试。
- [ ] `VIS-008` 完成审批、协作、交接、返工、交付和异常动作。
- [ ] `VIS-009` 完成 Full、Low、Silhouette、List 四级降级。
- [ ] `VIS-010` 完成 Reduced Motion、非颜色状态编码和键盘可达替代视图。
- [ ] `VIS-011` 完成 12 人同场、后台降频、CPU/GPU/任务延迟门禁。
- [ ] `VIS-012` 删除发布 UI 中机器人主角色和机器人默认回退。

出口：R5 Watercolor Beta；`VIS-002..007` 的本地自动门禁与首轮人工门禁通过。

### Sprint 10：W19-W20，2026-12-07 至 2026-12-18

- [ ] `WORKER-001` 冻结每个 Session/Run 的 workerId、assignmentId 和策略版本。
- [ ] `WORKER-002` 完成职责、数据范围、工具、预算、并发和升级策略执行。
- [ ] `SUP-001` 完成 pause/resume/cancel/retry/reassign 与真实 Provider parity。
- [ ] `DAG-001` 完成多 Worker DAG、隔离目录、交付汇聚和冲突处理。
- [ ] `MEM-001` 完成 Worker memory namespace、项目隔离和退休行为。
- [ ] `PERF-001` 建立基于 Acceptance、返工、成本、延迟的 Worker 性能记录。

出口：重启或转派不会改变旧 Run 的身份、权限和归属。

### Sprint 11：W21-W22，2026-12-21 至 2027-01-01

- [ ] `AUTO-001` 将 Routine/Cron 规范化为 Project/WorkItem/Run/Worker 事件。
- [ ] `AUTO-002` 完成 webhook/API/manual/schedule 触发和幂等触发键。
- [ ] `AUTO-003` 完成 skip/queue/replace 并发策略、失败率暂停和通知。
- [ ] `REMOTE-001` 完成 Remote Daemon 设备身份、双向认证和心跳。
- [ ] `REMOTE-002` 完成远程任务 lease、断线恢复、日志和 Artifact 回传。
- [ ] `TEAM-001` 完成 Workspace、成员、角色、Inbox 和审批基础。

出口：自动化和远程任务在断网、重启和重复触发下保持单一结果。

### Sprint 12：W23-W24，2027-01-04 至 2027-01-15

- [ ] `TEAM-002` 完成团队权限、Agent 调用 Agent 权限和 deny-by-default。
- [ ] `TEAM-003` 完成项目活动、评论、依赖、通知和责任追踪。
- [ ] `REMOTE-003` 完成本地/远程 Runtime 调度、容量和版本兼容。
- [ ] `IMPORT-001` 完成 Hermes/OpenClaw Skills、Memory、Cron 和 channel 导入报告。
- [ ] `QA-003` 完成多设备、断线、崩溃和权限变更压力测试。
- [ ] `BETA-001` 打包第一版功能范围统一的私测候选，不发布公开稳定声明；该任务不是第一次打包或第一次真人测试。

出口：R6 Unified Private Beta；内部团队可连续完成跨设备目标交付。

### Sprint 13：W25-W26，2027-01-18 至 2027-01-29

- [ ] `PLUGIN-001` 完成 Plugin/MCP provenance、版本、Digest 和 Capability Manifest。
- [ ] `PLUGIN-002` 完成能力扩张重新批准、恶意 fixture、回滚和最小环境。
- [ ] `CONN-001` 统一 Connector 为 Project Resource/Tool，不创建伪 Agent 员工。
- [ ] `CONN-002` 完成 GitHub Issue/PR/Review/Actions 黄金链路。
- [ ] `BROWSER-001` 完成受控浏览、下载、上传、引用和研究证据。
- [ ] `OFFICE-001` 完成 DOCX/XLSX/PPTX/PDF 读取、定位、批注和安全预览闭环。

出口：不可信插件和连接器不能绕过权限、凭据、项目和 Artifact 边界。

### Sprint 14：W27-W28，2027-02-01 至 2027-02-12

- [ ] `OFFICE-002` 完成高频 Office 编辑、导出、视觉 QA 和原文件保护。
- [ ] `CHANNEL-001` 完成飞书/企业微信/Slack/Telegram 首发通道。
- [ ] `CHANNEL-002` 完成消息身份、会话路由、审批、附件和审计。
- [ ] `MEDIA-001` 完成图片生成/理解与 Artifact 交付。
- [ ] `MEDIA-002` 完成语音输入、转写、播放和隐私边界。
- [ ] `RESEARCH-001` 完成多源检索、引用、冲突识别和研究报告。

出口：办公、研究和消息渠道均至少有一条真实端到端交付路径。

### Sprint 15：W29-W30，2027-02-15 至 2027-02-26

- [ ] `WIN-001` 完成 Windows 安装、升级、回滚、GUI、终端和打包验证。
- [ ] `MAC-001` 完成 Intel/Apple Silicon 安装、签名、公证、升级和回滚验证。
- [ ] `UX-002` 完成 Assistant/Studio、审批、失败、未知 Effect 和修复入口。
- [ ] `A11Y-001` 完成键盘、读屏、accessible name、tooltip 和非颜色编码。
- [ ] `I18N-001` 完成中英文最长文本、三档 viewport 和无重叠门禁。
- [ ] `PERF-002` 完成启动、Board、Router、3D 后台预算和大历史性能门禁。

出口：R7 Cross-platform RC；只对真实验证的平台生成和宣称发布资产。

### Sprint 16：W31-W32，2027-03-01 至 2027-03-12

- [ ] `SEC-001` 完成威胁模型复核、依赖/SBOM、插件、更新和供应链审计。
- [ ] `PRIV-001` 完成数据地图、保留、导出、删除和 no-egress 策略。
- [ ] `MIG-003` 完成所有 schema 的预检、备份、幂等恢复、回滚和 Digest 对比。
- [ ] `AUDIT-002` 完成 Project manifest、Artifact/Evidence 包和隐私过滤。
- [ ] `LOAD-001` 完成多项目、多会话、多 Worker 和大 Artifact 压力测试。
- [ ] `BUG-001` 关闭 Alpha/Beta 的 Critical/High 缺陷。

出口：安全、隐私、迁移和审计不存在未分配的 P0 缺口。

### Sprint 17：W33-W34，2027-03-15 至 2027-03-26

- [ ] `FLOW-001` 完成全部 20 个黄金工作流的自动与人工混合执行。
- [ ] `FLOW-002` 对每个竞品建立导入、执行、交付和退回对比报告。
- [ ] `CHAOS-001` 完成强杀、断网、限流、磁盘满、时钟回拨和重复消息矩阵。
- [ ] `REC-005` 收口 11/11 critical recovery requirements。
- [ ] `P0-001` 收口全部剩余 P0 自动门禁。
- [ ] `P1-001` 冻结指定 P1，确认水墨 `VIS-002..007` 不可延期。

出口：所有重大缺陷都有修复、降级或正式 No-Go；不以 waiver 代替数据安全。

### Sprint 18：W35-W36，2027-03-29 至 2027-04-09

- [ ] `P0-002` 达到 64/64 P0 release-bound closure。
- [ ] `P1-002` 完成冻结 P1 或记录有期限、非安全类延期决策。
- [ ] `DEEP-001` 精确干净提交运行全部 required gates。
- [ ] `DOC-001` 校准 README、STATUS、用户手册、安全和迁移说明。
- [ ] `RC-001` 生成版本、提交、SBOM、签名和资产 Digest 一致的候选。
- [ ] `DOCTOR-001` Release Doctor 在功能冻结提交上通过。

出口：R8 Feature Complete RC；功能冻结，后续只接受缺陷、证据和发布修复。

### Sprint 19：W37-W38，2027-04-12 至 2027-04-23

- [ ] `USER-001` 招募并完成 10 名目标用户迁移。
- [ ] `N1-001` 运行 30 分钟迁移演练，记录时间、失败点和资产完整性。
- [ ] `HUMAN-001` 完成办公/教育真实工作流。
- [ ] `HUMAN-002` 完成技术/OPC 真实工作流。
- [ ] `VIS-H1` 完成角色盲测、状态理解和水墨可读性访谈。
- [ ] `FIX-001` 关闭首轮真人测试 Critical/High 问题。

出口：首批用户能在没有开发者代操作的情况下完成迁移和交付。

### Sprint 20：W39-W40，2027-04-26 至 2027-05-07

- [ ] `USER-002` 扩展至 30 名迁移用户和至少两类核心人群。
- [ ] `SOAK-001` 启动 7 天每日使用和无人值守自动化 soak。
- [ ] `SUPPORT-001` 建立崩溃报告、诊断导出、支持 SLA 和隐私过滤。
- [ ] `METRIC-001` 建立本地优先、可关闭的激活/成功/恢复指标。
- [ ] `FIX-002` 关闭第二轮 Critical/High 问题并跑回归。
- [ ] `DOC-002` 依据真实失败更新 onboarding、迁移和恢复指导。

出口：7 天无静默丢任务、泄密、不可恢复损坏或重复副作用。

### Sprint 21：W41-W42，2027-05-10 至 2027-05-21

- [ ] `SOAK-002` 完成 7 天结果审计和环境/版本绑定。
- [ ] `RET-001` 建立 30 天留存 cohort，不提前宣称结果。
- [ ] `PERF-003` 在真实用户数据规模上重新跑性能与资源门禁。
- [ ] `SEC-002` 完成候选渗透复核、secret scan 和发布资产检查。
- [ ] `RC-002` 生成 Adoption Candidate 并验证升级/降级。
- [ ] `GO-001` 完成 R9 Go/No-Go 评审。

出口：R9 Adoption Candidate；候选稳定，进入 30 天不可压缩观察期。

### Sprint 22：W43-W44，2027-05-24 至 2027-06-04

- [ ] `SOAK-003` 持续 30 天观察，不变更数据模型和核心执行语义。
- [ ] `FIX-003` 只处理影响发布的缺陷，并对每项执行全链回归。
- [ ] `REL-001` 冻结发布资产、平台、架构、版本和 Release Notes。
- [ ] `REL-002` 完成全新安装、覆盖升级、回滚和离线恢复演练。
- [ ] `VIS-F1` 在最终资产和设备上重跑水墨性能、降级和可访问性。
- [ ] `COMP-001` 更新竞品对比，只使用已验证能力和真实指标。

出口：发布候选除证据积累外不再发生功能漂移。

### Sprint 23：W45-W46，2027-06-07 至 2027-06-18

- [ ] `RET-002` 审计迁移用户是否仍需打开原竞品及具体原因。
- [ ] `FLOW-003` 在最终候选重跑 20 个黄金工作流。
- [ ] `DEEP-002` 在精确发布提交重跑 clean Deep、SBOM 和 secret history。
- [ ] `SIGN-001` 完成最终签名、公证、staple 和 Windows 签名。
- [ ] `REL-003` 完成最终安装包、SHA-256 和 Artifact Set Digest。
- [ ] `GO-002` 预审最终 Go Record，缺项一律阻断。

出口：所有自动、人工、时间、硬件和外部凭据证据指向同一候选。

### Sprint 24：W47-W48，2027-06-21 至 2027-07-02

- [ ] `RET-003` 完成 30 天留存：目标用户中至少 70% 不再打开目标竞品。
- [ ] `SOAK-004` 完成 30 天稳定性审计。
- [ ] `GO-003` 签署最终 Go Record 和残余风险清单。
- [ ] `PUB-001` 经授权创建 tag、Release 和正式资产。
- [ ] `PUB-002` 发布后重新审计公开正文、资产、Digest、签名和下载。
- [ ] `OPS-001` 启动发布监控、快速回滚和首周支持值守。

出口：R10 Public Replacement；否则按 No-Go 继续 RC，不以日期替代验收。

## 8. 黄金工作流

| ID | 工作流 | 主要替代对象 | 核心证据 |
|---|---|---|---|
| GF-01 | 导入 Provider/Key 并切换模型 | CC Switch | Keychain、连通性、切换和退回 |
| GF-02 | Provider 限流后安全 Failover | CC Switch | Attempt、幂等、Usage、无重复 Effect |
| GF-03 | 导入 MCP/Skills/Prompts | CC Switch/OpenClaw/Hermes | 来源、Digest、能力和导入报告 |
| GF-04 | 读取陌生代码库并生成审计 | Codex/Claude | 引用、文件范围、无修改证据 |
| GF-05 | 隔离 worktree 修复 Bug | Codex/Claude/Multica | Diff、测试、冲突和 Patch |
| GF-06 | 生成并审查 Pull Request | Codex/Claude | Commit、PR、Review 和批准 |
| GF-07 | 崩溃后恢复工具循环 | Codex/Multica | Snapshot、Attempt、Effect 对账 |
| GF-08 | 多 Agent 并行开发并合并 | Multica/Codex | DAG、worktree、review、finalizer |
| GF-09 | 一句话目标到交付报告 | Claude Cowork/WorkBuddy | Goal、WorkItem、Artifact、Acceptance |
| GF-10 | 测试失败自动返修再验收 | CaoGen 差异化 | Failure Evidence、Repair、Retest |
| GF-11 | 浏览器研究并生成带引用报告 | ChatGPT/Claude/WorkBuddy | 来源、引用、冲突和 Artifact |
| GF-12 | 处理 PDF/DOCX/XLSX/PPTX | Claude/WorkBuddy | 原文件保护、预览、编辑和导出 |
| GF-13 | GUI 操作等待敏感审批 | Claude/WorkBuddy | 权限、窗口、动作、截图和审计 |
| GF-14 | Cron 定时任务与失败恢复 | Hermes/OpenClaw/WorkBuddy | Trigger、幂等、通知和历史 |
| GF-15 | 从消息平台创建任务并收产物 | OpenClaw/Hermes | 身份、附件、审批、交付链接 |
| GF-16 | Remote Daemon 执行长任务 | Multica/Hermes | 设备、lease、断线恢复和产物 |
| GF-17 | 团队成员委派数字员工 | Multica | 权限、Assignment、Inbox、审计 |
| GF-18 | 本地模型 no-egress 任务 | Marvis/WorkBuddy | 数据预览、策略、网络拒绝和证据 |
| GF-19 | 图像/语音参与多模态任务 | ChatGPT/WorkBuddy | 输入授权、Usage、Artifact 和隐私 |
| GF-20 | 水墨办公室观察并干预任务 | CaoGen 差异化 | 真实事件、身份稳定、审批和降级 |

## 9. 水墨人物硬门禁

当前基线必须如实显示为：`49/49` 源图存在、`49/49` 正式透明运行时资产通过自动门禁与暗底/亮底/96px/48px QC 并注册。生产链已完成到“运行时注册”；仍需继续“安装包核验 -> 真人盲测”，不能用开发环境门禁替代这两项发布证据。

1. 发布版本不得以机器人作为主要人物或默认回退人物。
2. 七类核心岗位盲测辨识率不低于 80%。
3. Provider、模型和 Key 切换只影响 Compute Badge，不改变 DigitalWorker 身份。
4. 所有动作必须映射到 canonical WorkItem/Run/Tool/Approval/Artifact 事件。
5. 未通过 Acceptance 时不得出现完成或庆祝状态。
6. Full、Low、Silhouette、List 四级显示必须保持同一真实状态。
7. 状态同时使用姿态、动作、图标或文字，不只依赖颜色。
8. 支持 Reduced Motion；持续动画可暂停，不阻断后台任务。
9. 12 人同场时满足冻结的 CPU/GPU、帧率和任务延迟预算。
10. `1320x860`、`760x700`、`360x520` 的中英文界面无重叠和溢出。
11. 资产来源、作者、授权、版本和 Digest 可审计。
12. 最终签名包内资产与验收资产完全一致。
13. 49 张角色/状态资产必须全部通过透明边缘、接触阴影、纸底残留、裁切、轮廓和小尺寸可读性 QC，并以 Digest 注册；48/49 仍为失败。
14. R5 及之后的候选包不得出现机器人主角色或机器人默认回退；资产缺失时必须阻断候选生成，不能静默降级。
15. 水墨人工验收只能在包内 49/49 资产与自动门禁同一 Digest 时进行，并记录岗位辨识、状态辨识、误判项和设备性能。

## 10. 每项工程任务的 Definition of Done

一项任务只有同时满足以下条件才可标记完成：

- 实现接入生产入口，不只存在孤立模块或测试 fixture。
- 正向、负向、边界、重启和权限测试通过。
- 持久化变更包含 schema/version、迁移、回滚和损坏处理。
- 外部副作用包含 Effect、idempotency、reconciliation 和 audit。
- 错误、日志、导出和诊断不泄露 Secret 或敏感正文。
- UI 展示 loading、empty、blocked、approval、failed、recovery 和 success 状态。
- 用户可见任务必须在目标平台安装包中验证；开发服务器或 `electron-vite dev` 只算工程预检。
- 真人发现的问题必须绑定原包 SHA-256，并在修复后的新包上复跑原步骤。
- 文档描述与已验证能力一致，不把条件能力写成无条件支持。
- 测试报告绑定精确提交、运行环境和输入 fixture Digest。
- 相关 Acceptance Matrix 行更新，但不得仅靠更新状态文本宣称完成。

## 11. 质量指标

| 指标 | Alpha | Beta | Public Replacement |
|---|---:|---:|---:|
| 目标平台安装/启动/卸载 | 每候选 100% | 每候选 100% | 每正式资产 100% |
| 真人问题修复后新包复测 | 100% Critical/High | 100% Critical/High | 100% Critical/High/Medium |
| 20 个黄金工作流成功率 | >= 80% | >= 90% | >= 95% |
| 关键恢复闭环 | >= 6/11 | 11/11 | 11/11 |
| Critical/High 已知缺陷 | 0/<=5 | 0/0 | 0/0 |
| 静默丢任务 | 0 | 0 | 0 |
| 重复非幂等副作用 | 0 | 0 | 0 |
| Secret canary 泄漏 | 0 | 0 | 0 |
| 新用户首任务 | <= 20 分钟 | <= 15 分钟 | <= 10 分钟 |
| 迁移资产丢失 | 0 | 0 | 0 |
| 水墨角色辨识率 | >= 70% | >= 80% | >= 80% |
| 水墨正式运行时资产 | R5 前达到 49/49 | 49/49 | 49/49 且包内 Digest 一致 |
| 不再打开目标竞品 | 不统计 | 观察 | >= 70%/30 天 |

## 12. 计划缓冲与变更规则

- W31-W34 含约 15% 工程缓冲，只用于恢复、安全、迁移和跨平台缺陷，不用于新增功能。
- W43-W48 是时间证据与发布缓冲，不允许压缩 30 天观察期。
- 任一数据丢失、权限逃逸、凭据泄漏或重复副作用缺陷自动触发 No-Go。
- 新增 Provider、Connector 或视觉资产必须先补 Acceptance 和威胁模型，再进入排期。
- 范围变更必须说明替代哪个现有任务、影响哪个里程碑，不允许只追加工期不可见的需求。
- 水墨人物不可从 1.0 移除；如视觉路径延期，正式发布同步延期。
- 外部凭据、签名、硬件和真人门禁无法由 mock 或开发者自测替代。
- D0 dirty 探索包只用于尽早发现问题；任何发布、稳定性、留存、正式迁移或水墨结论必须在 C1/RC 的精确 clean 包上重跑。
- 用户测试不得因计划内功能尚未齐全而继续后移；未实现能力应明确显示 unavailable/blocked，并把真实理解成本纳入测试结果。

## 13. 用户/外部输入清单

| 最晚时间 | 需要的输入 | 缺失影响 |
|---|---|---|
| 2026-08-04 | 产品 Owner 作为首轮 Windows 探索测试者 | 已确认；待安装包 SHA-256 与测试记录 |
| W2 | 目标用户优先级、首发平台和 P1 冻结决策 | R0 阻塞 |
| W4 | 水墨美术方向与资产版权策略 | R5 阻塞 |
| W6 | 脱敏竞品配置和迁移样本 | R2 阻塞 |
| W8 | OpenAI/Anthropic/Gemini 真实测试账号 | R3 阻塞 |
| W18 | Windows、Intel Mac、Apple Silicon 测试设备 | R7 阻塞 |
| W22 | GitHub/飞书/企业微信等 OAuth 测试环境 | 相关 Connector 不得宣称 |
| W28 | Apple Developer、Windows 签名材料和发布授权 | 正式资产阻塞 |
| W34 | 10 至 30 名真实竞品用户 | R9/R10 阻塞 |

## 14. 执行节奏

- 每日：实现、专项测试、工作树和 Secret 检查。
- 每周一：确认本周任务、依赖、风险和目标 Gate。
- 每周五：运行专项 required gates，更新证据和风险，不批量虚假勾选。
- 每双周：至少生成一个目标平台 C1 安装包并完成一次真人回路；只在 Sprint 出口全部满足后进入下一里程碑。
- 每月：跑 clean Deep、Acceptance Map、Recovery Map、SBOM 和竞品工作流回归。
- 每个候选：绑定精确 Git SHA、版本、平台、签名、测试报告和资产 Digest。
- 每个真人问题：绑定原包 -> 复现 -> 修复 -> 新包 -> 原场景复测；缺少任一环节保持开放。

## 15. 最终 Go Record

正式宣称“CaoGen 可替代主流竞品”前，必须存在一份不可缺项的 Go Record：

1. 精确 commit、tag、package/lockfile 版本和 clean worktree 证明。
2. 64/64 P0 与冻结 P1 的关闭记录。
3. 11/11 关键恢复、20/20 黄金工作流和全部安全门禁。
4. Windows/macOS 实际发布平台的安装、升级、回滚和签名证据。
5. 水墨 `VIS-002..007`、49/49 运行时资产、包内 Digest 和真人盲测的自动与人工验收记录。
6. 真实 Provider、办公/教育、技术/OPC 和 N1 迁移记录。
7. 30 天 soak 与 30 天用户留存结果。
8. 最终 Artifact 名称、大小、SHA-256、架构和资产集 Digest。
9. Release Notes、已知限制、残余风险、支持与回滚方案。
10. 发布负责人明确签署 Go；任一硬门禁不满足则保持 RC。

FIX-000 current D0 binding: installer SHA-256 `938bc5c13ead77cb4dc592cbfa66ad3a4e93c44dbca7758c48f820815d4619c2`, artifact-set SHA-256 `898e778c976e1f2552854b244b4197b2b5d68123785718bf967acd4d0722bb13`. This D0 includes the Provider authentication-header fix, restored in-process NSIS install-root removal, bundled TypeScript/JavaScript semantic runtime, compatibility handling for quarantined historical Runs without replay Snapshots, repeated legacy Run ownership ordering, complete canonical ownership propagation for managed-worktree Operations, aggregate compatibility for historical ledger-only Operations, Artifact lifecycle ownership rooted in the active Electron user-data store, confirmed-side-effect replay suppression across Provider failover, Windows ProjectWorkspace lock-contention recovery, and no-egress page validation. It passes the 45/45 preview audit and the isolated installed-app smoke. The prior D0 evidence remains historical and was not overwritten or manually repaired. The required private portable audit, path-bound assisted install, installed Provider/session/Office retest, complete 12-step Owner run, default-No cancel/relaunch, restart recovery, and confirmed clean uninstall must be regenerated against this exact SHA before `FIX-000` advances to `PKG-001`; this dirty D0 is not itself C1 or release acceptance.

The SHA-bound Owner kit is ZIP `d8486f5751a4e2d1f62fd486ef06e72bf2ee1ecc81165383e3d6d017ee5cf284`, manifest `7fdcf56c40bb7dbeea214edf7219467d24e6350419e844c525bfed10ac821eb3`, and content-set `0445ee1cfbab283bf18fa12e9e26e5caee7372a5f37eba75914baa6953fcad6d`.

Owner product feedback on the current D0 is negative even though the technical checks above pass: conversation workflow is not yet as effective as the locally installed ChatGPT or WorkBuddy, and Provider/model configuration, authorization, billing visibility, and configuration flexibility remain materially behind the locally installed CC Switch. This is a product-gap input, not a release pass. The next implementation slice must be derived from verified CC Switch source behavior and must improve the actual repeated configuration workflow rather than adding isolated settings fields.

2026-08-10 code-workbench increment: the native Code workspace now includes a cross-file TypeScript refactor preview/apply/rollback loop backed by the official TypeScript Language Service, per-file SHA-256 CAS, session binding, project mutexes, opaque operation IDs and a restart-safe private operation journal. The journal is persisted before mutation, bounds each operation to 200 files and the store to 50 records/250 MB, removes stale temporary records after 24 hours, retains completed rollback across a fresh main process, compensates interrupted apply/rollback only from frozen before/after digests, rechecks each digest immediately before a transition write, retries a previously blocked recovery after external drift is repaired, expires completed rollback windows after ordinary later edits, and fails closed without overwriting unknown file states. Corrupt private records no longer abort all startup reconciliation but still block new refactors; terminal/completed capacity is pruned while unresolved or corrupt saturation remains fail-closed. Renderer recovery data is limited to relative file names, opaque IDs, counts and generic messages rather than source snapshots or absolute workspace paths. Final gates are green for refactor smoke `36/36`, refactor Electron `12/12`, debugger `16/16 + 13/13`, project tests `26/26 + 11/11`, file editor `31/31 + 29/29`, diagnostics/language intelligence and typecheck. The crash-recovery foundation is locally covered; `IDE-001` and `IDE-002` remain open for representative 50,000-file/multi-language monorepo performance, network-filesystem/sustained-watcher evidence and a real heavy-user golden workflow. This is a development increment and does not change the release or 1.0 Go Record.

2026-08-11 large-repository index increment: file lookup now queries the complete bounded index instead of filtering only the first 5,000 rows, with full-index fuzzy fill capped by the existing result limit. Directory discovery uses a cursor queue and 64-way bounded metadata batches; the 50,000-file ceiling is explicit in stats, and a truncated warm scan no longer deletes previously indexed rows it did not revisit. A successful empty ripgrep result no longer triggers a full fallback scan. Watcher persistence coalesces bursts, serializes snapshots, writes a private temporary file with `fsync`, atomically replaces `index.db`, waits for active updates on disposal and removes failed temporaries. The focused watcher gate proves 24 additions survive reopen with at most three snapshots. The latest 5,201-file/10,402-symbol Windows gate passes cold `3408.8ms`, warm `274.8ms`, substring `51.8ms`, fuzzy `26.8ms`, symbol `4.6ms`, and empty code search `61.2ms`; sanitized evidence is `test-results/indexer-large-repo/2026-08-10T16-27-09.676Z.json`, and the gate is registered in Deep. This closes the old 5,000-row blind spot and establishes a synthetic scaling baseline, not the final 50,000-file, mixed-language, network-filesystem, sustained-watcher or real-Electron heavy-user proof; `IDE-001/002` remain open.

2026-08-11 workbench-keyboard increment: all seven workbench tab groups now share roving focus with a single tabbable selected tab, Arrow-key cycling, Home/End jumps, focus-following activation and explicit tab/tabpanel ownership. A real Electron gate traverses Files, Tests, Debug and Refactor, file browser modes, open-file tabs and stdout/stderr while verifying visible panel and focused-tab identity; it passes `8/8` and is registered in Deep. Existing Electron regressions remain green for file editing `29/29`, tests `11/11`, debugging `13/13`, refactoring `12/12` and Studio results `7/7`, with Studio contract `28/28`, Office preview and worktree merge also passing. This closes the workbench tab-keyboard slice only; whole-product screen-reader/accessibility acceptance and the remaining IDE performance/heavy-user gates stay open.

2026-08-10 Provider configuration increment: the visual editor now covers provider-scoped failover, retry limits, first-byte/idle/request timeouts, circuit-breaker thresholds and endpoint priority. The saved values round-trip through the production Provider store and are consumed by the existing timeout, breaker, endpoint-selection and request-override runtimes. Electron save/reopen/compact UI passes `18/18`; targeted runtime gates pass `15/15 + 11/11 + 3/3 + 17/17`, and CC Switch import remains `37/37`. Real-provider authorization, external billing reconciliation and long-term usage accuracy remain open product gates.

2026-08-10 Provider billing-provenance increment: the usage summary now computes a complete-interval source ledger for Provider-reported cost, Provider-configured price estimates, built-in price estimates, imported historical cost and unpriced requests. Unpriced requests preserve request/Token evidence but add zero currency and surface a visible undercount warning. Backend/static gates pass `46/46 + 27/27`; real Electron desktop, restart, source-filter and compact-layout coverage passes `36/36` at `test-results/provider-usage-dashboard-e2e/2026-08-10T01-52-52-842Z`. The isolated unpacked preview `dist-preview-billing-provenance-20260810-101221/win-unpacked/CaoGen.exe` is bound to SHA-256 `69C27565207CA45DCB89FCA445C2FCD998BB36FB8AABC2E8708D68CD6AD66327` and passed renderer first-launch/restart diagnostics at `test-results/windows-unpacked-renderer-smoke/2026-08-10T02-36-29-539Z`. This closes the misleading mixed-total UI gap only; it does not substitute for external invoices, balance endpoints, monthly reconciliation or long-term paid-account accuracy, so those product gates remain open.

2026-08-10 Provider billing-reconciliation increment: CaoGen now accepts a bounded manual official-bill snapshot containing only Provider id, period, USD amount and a fixed source enum. The store is schema/revision/digest-bound, atomically fsynced, and rejects symbolic links or corruption. Comparison is fail-closed: only complete, untruncated, fully Provider-reported local usage can become `matched/mismatch`; missing data, truncation, unpriced requests, configured/builtin estimates and imported history remain `incomplete` with explicit reasons. Last non-secret OAuth quota observations now survive restart. Billing/authorization/usage/static gates pass `34/34 + 129/129 + 48/48 + 32/32`; real Electron add/reopen/reconcile/delete/compact coverage passes `42/42` at `test-results/provider-usage-dashboard-e2e/2026-08-10T03-07-19-468Z`. The isolated preview `dist-preview-billing-reconciliation-20260810-110846/win-unpacked/CaoGen.exe`, SHA-256 `AAC59991FA4DAF30253F1D44CCFA06CBBCBC127D123C883289F097D9A8DC9A67`, passed first-launch/restart diagnostics at `test-results/windows-unpacked-renderer-smoke/2026-08-10T03-10-14-779Z`. Automatic invoice/balance ingestion, real paid-account monthly evidence, and long-term accuracy remain open.

2026-08-10 Provider local-version increment: every ordinary Provider create/update/delete now creates a private credential-free before snapshot, while semantic no-op updates create none. The local history is bounded to 50 visible versions and uses a diff-first restore flow with create/update/delete/unchanged counts and changed field names; no backup body, endpoint value, credential or local path enters Renderer. Preview-to-apply Provider drift and backup digest substitution are rejected, and confirmed rollback continues through the existing Provider Store mutation lock, operation journal and reverse safety backup. Provider Profile smoke passes `155/155`, restart/recovery `13/13`, real Electron UI `80/80`, durable inventory `13/13`, Effect entry required audit `387 entries / 10 checks`, typecheck and production build. Isolated preview `dist-preview-provider-version-history-20260810-1138/win-unpacked/CaoGen.exe` is bound to SHA-256 `F4A7CED68B7CD0DE9BDEA1B3CA14EB53FFE4C05291D3D6D6738D5BFFAE9C50F9` and passes first-launch/restart diagnostics at `test-results/windows-unpacked-renderer-smoke/2026-08-10T03-51-26-811Z`. This closes one repeated-configuration workflow gap only; real paid-account evidence, automatic invoice ingestion, N1 workflow comparison and final 1.0 acceptance remain open.

2026-08-10 Provider official-billing-API increment: CaoGen now supports a generic same-origin official billing connector configured from the visual Provider editor. It supports GET/POST, Provider or no-auth credentials, an exact Key label, Query or nested JSON-Pointer period injection, Unix-second/Unix-millisecond/ISO formats, bounded non-secret request metadata, and JSON items/amount/currency/scale mappings. Main-process execution blocks redirects and cross-origin responses, caps the response at 512 KiB/2,000 items, accepts USD only, keeps credentials/URLs/bodies out of Renderer and Effect targets, and atomically upserts an idempotent `provider-api` statement before reconciliation. Targeted gates pass `62/62 + 9/9 + 34/34 + 25/25 + 48/48 + 34/34`; real Electron sync/idempotency/compact UI passes `46/46` at `test-results/provider-usage-dashboard-e2e/2026-08-10T04-20-56-249Z`; typecheck, production build, durable inventory `13/13` and Effect required audit `389 entries / 10 checks` pass. Isolated preview `dist-preview-provider-billing-api-20260810-122211/win-unpacked/CaoGen.exe`, SHA-256 `439B56EA0B60CA67F337782802514395722B6DC4CE4A340CDA47A80D3B12B9A3`, passes two cold renderer launches at `test-results/windows-unpacked-renderer-smoke/2026-08-10T04-26-11-454Z`. Real paid-account vendor endpoints, cross-month accuracy, clean-candidate binding, N1 comparison and final 1.0 acceptance remain open.

2026-08-10 Gateway request-level failover increment: CaoGen now keeps one immutable client request and performs bounded same-engine/same-wire-protocol Provider failover only before downstream output is committed. Network/provider-timeout, 401/403, 429 and selected 5xx failures are switchable; HTTP 400, redirects and failures after the first streamed byte are not replayed. Global and Provider-level failover controls, `maxRetries`, Provider-specific circuit breakers and isolated per-attempt credential leases are enforced. Each upstream attempt is independently written to usage/pricing with a shared request ID, ordinal and predecessor link, including usage returned by a failed Provider. Real Electron Gateway passes `58/58` at `test-results/provider-gateway-e2e/2026-08-10T11-14-26-348Z`; usage `48/48`, Dashboard `34/34`, timeout `15/15`, circuit breaker `11/11`, Gemini `7/7`, protocol boundary, typecheck and production build pass. Isolated preview `dist-preview-provider-gateway-failover-20260810-191523/win-unpacked/CaoGen.exe`, SHA-256 `67260273C6CD3AED3437C7FD63D7EA26C37C25F406F29C0B8213A5AF0332E60F`, passes two cold renderer launches at `test-results/windows-unpacked-renderer-smoke/2026-08-10T11-16-50-066Z`. These are isolated mock-Provider results and do not close paid-account, cross-month billing, clean-candidate, N1 or final 1.0 gates.

2026-08-10 local-compute startup recovery increment: automatic Assistant entry remains read-only, while an explicit first-task submission, retry or Settings action may locate an installed Ollama executable from bounded platform locations or `PATH`, start it without a Shell or visible console, wait at most eight seconds and continue the unchanged draft. Missing runtime, failed start and missing model remain distinct bounded states; Assistant uses non-technical wording, preserves the draft and exposes the matching official recovery entry. Real Electron gates pass running zero-config `6/6`, missing/stopped recovery `2/2` and zero-choice routing `12/12` at `test-results/local-compute-zero-config/2026-08-10T11-54-49-146Z`, `test-results/local-compute-runtime-recovery/2026-08-10T11-54-49-144Z` and `test-results/routing-zero-choice/2026-08-10T11-54-49-145Z`. Typecheck, production build, local-provider parity and onboarding smoke pass. Machines with no runtime and no user credential still lack immediate trial compute, so `M2-T6`, N1, clean-candidate and final 1.0 gates remain open.

The isolated Windows x64 unpacked preview for this increment is `dist-preview-local-compute-recovery-20260810-195945/win-unpacked/CaoGen.exe`, SHA-256 `55881D37143590483CB1BBBD003A78F3076CCDBD61D7532103E14D58959857C1`, Authenticode `NotSigned`, with no `latest.yml` or blockmap. Two isolated cold launches pass in 1715 ms and 1158 ms at `test-results/windows-unpacked-renderer-smoke/2026-08-10T12-00-59-488Z`; this is a development diagnostic, not installed-package or release evidence.
