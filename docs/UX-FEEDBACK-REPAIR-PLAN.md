# CaoGen 用户反馈修复计划

> 版本：2026-08-27
>
> 目的：把“没有竞品好用”和“操作混乱”转成可复验的用户结果、代码切片和发布门禁。

## 结论先行

当前不能通过继续增加面板来解决反馈。首要问题是五条黄金路径没有被同一套主流程串起来：用户需要在入口、配置、执行、结果和恢复之间反复寻找下一步。修复顺序必须是：先收敛信息架构，再补每条路径的最短可用闭环，最后用计时真人任务与故障恢复证据决定是否发布。

本计划不承诺 CaoGen 已经达到 WorkBuddy、Multica、即梦/有戏 AI、CC Switch、Codex、Claude Work 或 DeepSeek Harness 的整体体验。对标只用于固定相同目标、数据和机器后的操作测量；任何“超越竞品”的结论都需要独立证据。

## 2026-08-27 已实现的首轮修复

- Assistant：在首屏输入框旁提供可见的“设置可用服务”入口。用户无需先提交一次失败任务，便可直接进入 Provider 设置；自动本机检测仍保留。
- Video：快速开始和已有项目的制作创建都允许只填写脚本。标题留空时从脚本首行生成不超过 80 个字符的项目/制作标题，保留手动标题能力。
- Project：将执行面板放在验收交付之前，并移除执行操作栏对 `supervisor` 流程锚点的占用，流程条现在与页面顺序一致。
- 回归：`npm run test:ux-feedback-repair` 覆盖上述入口、必填字段和 DOM 流程顺序；它不替代五名用户计时黄金任务、竞品盲测或发布门禁。

> 安全边界：聊天中出现的 Provider Key 不属于测试输入，不能复制到源码、`.env`、报告、截图或 Git 历史。该 Key 必须在服务端吊销后重新生成；真实 Provider parity 只允许从本机私密配置注入。

## 五条反馈到修复目标

| 反馈 | 1.0 修复目标 | 必须看见的用户结果 | 关闭门禁 |
|---|---|---|---|
| Assistant 不如 WorkBuddy | 首次任务零项目、零内部术语、输入即开始 | 用户在 10 分钟内完成一次联网研究或写作，看到可验证来源，能追问/修订并复制或导出结果 | `UX-GOLDEN-001`、`SEARCH-001`；Assistant Electron 首任务成功记录 |
| Project 不如 Multica | 一句话目标到可交付代码/文件闭环 | 一次审批完成自动拆解、数字员工执行、逐 hunk Diff、Test、Undo、Commit、Delivery；重启后身份和结果仍在 | `UX-GOLDEN-002`；最终 clean SHA 记录 |
| Video 不如即梦/有戏 AI | 先交付诚实可用的基础链，不伪称生成质量平齐 | 脚本/大纲 → 可编辑分镜 → 素材版本 → 非空可解码预览 → 修改/重排 → 可追溯导出 | `VID-MVP-001`、`UX-GOLDEN-003`；远程质量与计费仍是 post-1.0 |
| Provider 配置不如 CC Switch | 配置、发现、健康、默认、故障切换、迁移回滚在一页内可完成 | 15 分钟内导入/添加 Provider、发现模型、健康检查、切换默认、模拟失败 failover、导出或回滚；日志和截图无凭据 | `UX-GOLDEN-004`、Provider failover/CC Switch required gates |
| 整体比 Codex/Claude Work/WorkBuddy/DSH 混乱 | 一个入口模型、一个状态链、一个返回路径 | Assistant、Project、Video 共享 Session/Goal/Run/Artifact/Evidence/Acceptance；控制室只投影状态，返回原入口 | `UX-GOLDEN-005`、`CONTROL-ROOM-009`、跨入口恢复记录 |

## 设计和实现原则

1. **Assistant 是默认入口。** 主输入框不要求 Project、Provider、模型或 Agent；复杂任务再渐进披露 Studio。
2. **每个表面只保留一个主动作。** Assistant 的主动作是开始任务，Project 是提交一句话目标，Video 是创建制作，Provider 是验证并设为默认。
3. **流程条必须是真导航。** 点击“执行”“验收交付”“生成”“预览/导出”应打开对应真实面板，而不是只改变文案或填充输入框。
4. **技术对象不成为用户前置条件。** Goal、WorkItem、Run、Provider、Evidence、Acceptance 只在必要位置渐进显示；它们仍必须写入同一 canonical ledger。
5. **失败状态不可伪装成功。** 搜索无结果、超时、无凭据、出口拒绝、Provider 失败和未知结果必须分别显示，并阻止错误的完成标记。
6. **远程媒体调用必须诚实。** `grok-imagine-video` 与 `grok-imagine-video-1.5` 只作为 OpenAI 视频兼容 Provider 的模型预设；凭据只来自本地私密配置，不能进入源码、日志、报告或截图。
7. **所有修复都要能回退。** Provider 导入、项目迁移、视频结构修订和任务恢复都必须保留旧版本/检查点，并能在重启后读回。

## 分阶段执行

### 阶段 A：信息架构收敛（当前）

- 保持 Assistant、Project、Video 三个业务入口；控制室只做真实状态投影。
- 将模式切换固定在侧栏顶部，保留会话/草稿/运行状态，不因切换创建第二份任务。
- 为 Project 固定“目标 → 任务 → 执行 → 验收交付”流程，为 Video 固定“剧本 → 分镜 → 生成 → 预览/导出”流程。
- Provider 首屏只展示模板、凭据、验证/默认三步；高级字段折叠。
- 每个入口补来源返回动作、空状态、失败状态、键盘焦点和紧凑桌面布局。

阶段出口：`test:assistant-studio-ui:required`、`test:first-task-onboarding`、`test:coding-standards`、`npm run typecheck`、`npm run build` 均通过；不得出现遮挡、截断或失焦。

### 阶段 B：Assistant 首任务和搜索闭环

- 欢迎页的联网研究入口直接启动任务；读项目/审查改动不强制绑定 Project。
- `web_search` 统一走 CaoGen Search Broker，支持 `model_native` 和 `byok_search_adapter`。
- 成功结果展示 URL、摘要、抓取时间、内容 SHA-256、引用和 Evidence ID，并支持追问/修订/复制或导出。
- 逐一演练 `no_results`、`timeout`、`no_credentials`、`egress_denied`、`provider_failure`、`unknown_result`；失败不得创建“已完成来源”假象。
- 验证幂等、重启、Evidence 持久化和 Artifact 绑定。

阶段出口：`SEARCH-001` 的五个 required gates 全部有运行记录；再做 5 名用户的 `UX-GOLDEN-001` 计时任务。

### 阶段 C：Project 交付闭环

- 一句话目标创建 Goal，并显示自动计划、路由理由和一次审批。
- 将数字员工、WorkItem、Run、worktree、文件、终端、逐 hunk Diff、Test、Undo、Commit、Delivery 放进同一任务上下文。
- “执行”和“验收交付”流程按钮必须定位到真实可操作面板；交付前回读 Artifact/Evidence/Acceptance。
- 在干净 Electron 环境重跑完整 Project 黄金任务，包含一次撤销和一次重启恢复；失败时先清理残留 Electron/端口，再记录环境原因。

阶段出口：`UX-GOLDEN-002` 在固定机器、固定数据集下完成，且每个身份、digest、Acceptance 和恢复检查点可回读。

### 阶段 D：Video 基础 MVP 和媒体适配器

- 保持本地基础链为 1.0 P0：脚本/大纲、可编辑分镜、素材导入与版本、非空可解码预览、修改/重排、可追溯导出。
- 远程 `/v1/videos` 只通过 Provider Adapter 接入；提交后立即进入队列，轮询中的任务显示进行中，取消/失败/未知结果不能标记完成。
- 预填 `grok-imagine-video` 和 `grok-imagine-video-1.5`，但不在代码或测试报告中保存任何 API key。
- 对 OpenAI 视频兼容 Provider，提交固定为 `POST /v1/videos`；默认轮询 `GET /v1/videos/{id}`、下载 `GET /v1/videos/{id}/content`、取消 `DELETE /v1/videos/{id}`。`200` 只代表 Provider 接收任务，不代表成片已完成；必须继续轮询到 `succeeded` 并完成下载校验。
- `https://ciyuan2api.com` 只作为用户可自行配置的 Base URL 示例，不在发布包中内置凭据，也不把该服务的可用性、额度、延迟或成片质量写成 CaoGen 的发布承诺。
- 记录真实 Provider 的成功、失败、取消、超时、重启、未知结果和下载恢复；质量、延迟、额度与计费对账作为 post-1.0 证据，不提前宣传。

阶段出口：本地 `VID-MVP-001` 六个 gates 通过；远程 Provider 只在私密配置下做可选 parity 记录，不改变 1.0 P0 边界。

当前 parity 回归：`npm run test:video-provider-parity` 使用本地回环 Provider，已验证 `grok-imagine-video` 和 `grok-imagine-video-1.5` 均通过 multipart `POST /v1/videos`、轮询、下载、HTTP 失败和取消状态机。该报告分类为 `local_targeted_not_release`，不证明 `ciyuan2api.com` 生产凭据、额度、延迟或成片质量；真实凭据只能从本机私密配置注入，不能从聊天内容或源码读取。

### 阶段 E：Provider 配置和 CC Switch 迁移

- Provider 列表显示健康、默认状态、能力/模型数量和失败原因；一键设为默认必须更新路由并显示结果。
- 保持 CC Switch 扫描 → 预览 → 选择 → 原子应用 → 备份 → 回滚；源数据库只读，冲突和漂移 fail-closed。
- 补模型发现、健康检测、同 Provider 换 Key、跨 Provider failover、身份/成本/审计连续性真人演练。
- 导出默认不带凭据；重启后只验证凭据引用、配置 digest 和默认 Provider，不验证或展示秘密值。

阶段出口：`UX-GOLDEN-004` 在 15 分钟内完成，`test:cc-switch-import:required`、Provider profile/restart、failover required gates 绑定同一 clean SHA。

### 阶段 F：统一验收和发布决策

- 五名目标用户不接受产品讲解，分别完成五个计时黄金任务；记录耗时、点击、键盘输入、确认框、帮助请求、错误、恢复动作和盲测评分。
- 以“同目标、同数据、同机器、固定竞品版本”为比较条件；CaoGen 必须不增加最佳竞品的必需步骤，或明确标记差距和延期。
- 重跑 P0 `64/64`、关键恢复 `11/11`、Deep、Acceptance Map、秘密/历史扫描、Release Doctor、签名/公证/隔离安装/升级/回滚和发布资产审计。
- 任一门禁缺失，保持 `no-go`；不能以 UI 入口数量、模型数量或面板数量替代交付证据。

### 五名用户与固定竞品盲测执行表

每名用户都要完成五项任务；执行前先在 [`COMPETITIVE-PARITY-EVIDENCE-SCHEMA.md`](./COMPETITIVE-PARITY-EVIDENCE-SCHEMA.md) 冻结 CaoGen SHA、竞品版本、机器、输入夹具 digest 和随机展示顺序。竞品版本尚未冻结时，任务状态只能是 `open`。

| 任务 | 时间上限 | 固定可比产品 | 完成定义 |
|---|---:|---|---|
| `UX-GOLDEN-001` Assistant 首次有用任务 | 10 分钟 | WorkBuddy | 不理解内部实体也能开始，得到可验证结果，完成一次追问/修订并复制或导出 |
| `UX-GOLDEN-002` Project 从目标到交付 | 30 分钟 | Multica、Codex、Claude Work | 一句话目标、一次审批、hunk Diff、Test、Undo、Commit、Delivery 和重启恢复全部完成 |
| `UX-GOLDEN-003` 视频基础 MVP | 30 分钟 | 即梦、有戏 AI | 脚本/大纲、分镜编辑、素材版本、非空可解码预览、修改/重排和可追溯导出完成；不比较 1.0 范围外的远程生成质量 |
| `UX-GOLDEN-004` Provider 配置和恢复 | 15 分钟 | CC Switch | 导入/添加、模型发现、健康检查、默认切换、模拟 failover、导出/回滚和重启引用复核完成，零秘密暴露 |
| `UX-GOLDEN-005` 跨入口连续性 | 20 分钟 | Codex、Claude Work、WorkBuddy、DeepSeek Harness | Assistant 发起、Project/Video 继续、控制室投影、返回来源、定位结果/审计并重启恢复；事实链不分叉 |

每次运行必须记录 `durationMs`、点击、键盘输入、必填字段、模式切换、确认框、恢复动作、求助、错误和完成状态。盲评分固定为层级、可读性、信息密度、可发现性、错误清晰度和完成感六项。CaoGen 的必需步骤不得多于该任务最少的可比产品；五名用户的评分中位数不得低于最强可比产品。缺少任一原始记录、版本、SHA 或 digest 时，不得汇总为通过。

## 当前状态和下一动作

截至 2026-08-27（Asia/Shanghai），当前 1.0 集成 clean SHA 为 `8968dd022cf99269714c40f0b4260f5b79bb6679`；下列 UX 报告按各自分类记录，未明确绑定该 SHA 的均为 `local_targeted_not_release`：

- Assistant：当前 SHA 的 Search Golden `4/4`（`test-results/assistant-search-golden/latest.json`），完整 Deep 中首次任务、Assistant/Studio UI 和 live switch 门均通过；这些仍是 `local_targeted_not_release`，真人首任务尚未完成。
- Project：当前 SHA 的 Golden Delivery `7/7`（`test-results/project-golden-delivery/latest.json`），完整 Deep 中 Project lifecycle、hunk/Diff/Test/Git 和恢复门均通过；真人 Multica/Codex/Claude Work 盲测尚未完成。
- Video：当前 SHA 的 Provider parity `4/4`（`test-results/video-provider-parity/latest.json`）；Media Store Recovery `4/4` 仍绑定前一 clean SHA。现有证据只证明本地回环 `/v1/videos` 状态机，未调用聊天中暴露的 Key，也不证明商业成片质量、额度、延迟或计费。
- Provider：当前 SHA 的 CC Switch 导入/原子应用/回滚 `13/13`、Profile Electron/重启、Key failover、target failover 和 Anthropic failover 均在完整 Deep 中通过；仍需绑定发布账本并完成 15 分钟真人 CC Switch 盲测。
- Cross-entry Continuity：当前 SHA 的 targeted 一轮 `5/5`（`test-results/cross-entry-continuity/latest.json`）。它验证了控制室独立路由返回后，Project 仍恢复同一 Session/Run/Artifact/Evidence/Acceptance 和交付面板，并验证 9 工位上限与来源入口返回；Video 跨入口真人路径仍开放。
- 可信交付恢复：Session deletion journal 与 Artifact content publication 新增独立四类 fault E2E；Artifact 内容改为 no-replace commit、digest readback、死亡临时文件回收和目录 durability。既有 Artifact lifecycle `18` checks、Artifact graph 和 Project permanent deletion 回归通过。
- 基础质量：前一 clean SHA 的完整 Deep 已通过 `228/228`（`226/226 required pass`、`2 optional skip`、`0 blocked`、`0 fail`）；本轮 UX 提交后的当前 SHA 已通过 `npm run typecheck`、`npm run build`、UX smoke 和 Provider preset smoke，但尚未重跑完整 Deep。此前 Office 性能门的单次失败已由独立复跑和第二次 Deep 稳定通过，仍保留性能趋势观察。当前 SHA 的 `npm run secret:scan` 与 `npm run secret:scan:history` 尚未因本轮 UI 提交重跑；Electron runner 使用独立临时目录和端口，并全部等待退出。

这些结果不能替代真人验收或发布门禁。当前 durable writer inventory 为 `109 modules / 612 sink calls / 19 verified / 66 implemented_unverified / 24 exempt`，状态仍是 `inventory_closed_unverified`（`test-results/durable-write-inventory/latest.json`）。Critical Recovery evidence bundle 已在当前 SHA 重跑，为 `40/44 verified`；四个缺口全部是 `NFR-REC-002` 的 66 个 writer 尚无四类运行时证据（`test-results/critical-recovery-evidence/latest.json`）。Acceptance Map 已重新绑定但仍为 `P0 26/64`、`P1 4/38`、关键恢复 `2/11`、88 个 closure failure，不能作为发布通过证据（`test-results/product-1.0-acceptance-map/latest.json`）。

当前硬 blocker：五名真人计时黄金任务、固定竞品版本与首轮盲测、N1 真人迁移记录、`NFR-REC-002`、统一 provenance bundle、签名/公证/隔离安装/升级回滚、发布资产审计均未闭合。跨入口、Project delivery、Assistant Search、Video Provider parity 已绑定当前 clean SHA；Acceptance Map 仍为 `P0 26/64`、`P1 4/38`、关键恢复 `2/11`、88 个 closure failure，且仍绑定前一 clean SHA；Recovery bundle 最新仍为 `40/44 verified`，四个缺口全部来自 `NFR-REC-002`，也仍绑定前一 clean SHA。Deep 尚未针对当前 UX 提交重跑，且不等价于产品验收或发布准备。Release Doctor 最新仍为 `not_ready`（`test-results/workos-release-doctor/latest.json`，绑定 `9fc10b58`），包版本仍为 `0.1.9`，不能视为 1.0 发布。

下一执行顺序固定为：

1. 继续关闭 `NFR-REC-002`：优先补 Supervisor state、Task Snapshot/SQLite 和交付 manifest 等高风险 writer，再覆盖剩余 migration backup、derived index 和 audit log；每个 Store 必须有强杀、未知结果、重复和乱序的实际运行时证据，不能用 inventory/结构报告替代。
2. 在 writer 证据覆盖足够后，对 `40/44` 动态证据逐格做合同审核；只有同时满足七个 continuity fields 且报告绑定同一 clean SHA，才能把静态 fault matrix 从 open/partial 提升为 verified。
3. 在新的 clean SHA 上重跑跨入口、Assistant、Project、Video、Provider 主链；随后完成五名目标用户的五个计时黄金任务和首轮固定竞品对比，记录步骤、耗时、求助、失败、恢复与盲评，不以自动化替代真人证据。
4. 在功能冻结后的 clean SHA 上重跑 `test:1.0-acceptance-map:required`、Deep、秘密/历史扫描、Provider/Recovery gates 和 Release Doctor；再做签名、公证、staple、Gatekeeper、升级/回滚、SBOM、provenance、哈希和发布审计。
5. 只有所有硬门禁全绿且获得显式授权，才进入 `09-29 Go/No-Go` 和 `10-01` 发布；日期本身不是承诺。
