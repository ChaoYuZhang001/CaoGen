# CaoGen 项目状态

> 更新:2026-07-26· 实测口径,非文档自评。此文件为活文档,Current Focus 随日更新。
>
> ⚠️ **v0.1.7 已发布，但当前公开 Release 完整性失败。** [GitHub Release](https://github.com/ChaoYuZhang001/CaoGen/releases/tag/v0.1.7) 于 2026-07-25 首次发布时，annotated tag 指向 `d8e883a21b64133b4ec18d20d0c77fd33c054718`，批准的五项 Intel x64 资产名称、大小与 SHA-256 digest 审计全部通过，`caogen.dev` 中英文首页与文档入口已同步。2026-07-26 远端随后增加 `CaoGen-Setup-0.1.7.exe`、其 blockmap 与 `latest.yml`，正文也从仓库内 macOS Intel 五资产合同改成八资产/Windows unsigned 声明；当前 Release 因此不再匹配 `docs/RELEASE-NOTES-FINAL.md`，不能继续宣称公开资产审计为通过。原五项 macOS digest 未变，候选 `main@bbec526554aea9785291edf4d8164084145347ae` 的签名、公证、staple、Gatekeeper、DMG 隔离安装与真实 renderer 证据仍有效。Apple Silicon 与 Windows 仍不属于批准的当前 M1 发布范围；正式运行时只保留 OpenAI-compatible 与原生 Anthropic Messages，不需要 Claude Code 登录、SDK 或 CLI。
> 当前源码仍在 `0.1.7` 发布线上，但 v0.1.7 不是正式 1.0 stable：PRD 64 个 P0 = 21 个已验证 + 18 个部分完成 + 24 个立项目标 + 1 个仅达到基础。执行边界见 `docs/1.0-ACCEPTANCE-MATRIX.md`；0.1.7 只发布已验证楔子能力，不把路线图能力写成已完成。
>
> **状态纪律**(修正第 2 次犯的"未复现即声称"):凡真对话/可用性类结论必须写明**成立条件与复现环境**,不写环境无关的绝对断言。

# Context

国产原创**多厂商 AI 工作桌面**(Electron + React + react-three-fiber,AGPL-3.0-only 开源并提供独立商业授权,[GitHub](https://github.com/ChaoYuZhang001/CaoGen))。差异化站位:**不绑定厂商** —— 支持多模型、多密钥、多厂商配置,接入中转站和本地兼容服务;每个项目可独立配置 AI 工作规则;内置代码执行、项目理解、任务拆解、自动调度、工作区隔离、插件扩展、项目记忆、文件预览和 3D 办公可视化。

# Current Status

- **[v0.1.7 macOS Intel x64 已发布](https://github.com/ChaoYuZhang001/CaoGen/releases/tag/v0.1.7)**(2026-07-25)——首次发布时五项 DMG、ZIP、blockmap 和更新元数据资产公开且 digest 审计 `5/5` 通过；主二进制为 `x86_64`，完成 Developer ID 签名、Apple 公证/staple、Gatekeeper、隔离安装和真实 renderer 启动验证。该历史通过状态已被 2026-07-26 的远端资产/正文追加回归打破，当前公开 Release 审计为失败。
- Release 完整性回归的实时证据：Windows Actions run [`30192957144`](https://github.com/ChaoYuZhang001/CaoGen/actions/runs/30192957144) 只有 `contents: read`，仅上传 Actions artifact，并未修改 Release；正式 Release 的 3 个 Windows 资产在该 run 完成后单独由仓库账号上传。新增 Notes 驱动审计会精确比较仓库最终正文、资产名称集合和每项 GitHub SHA-256 digest；当前失败包括正文不匹配、资产数 `8 != 5` 及两个未批准 Windows 文件名。删除资产或恢复远端正文属于外部发布变更，需创始人明确授权后执行。与当前暂停 Windows 范围冲突、试图记录旧 v0.1.6 Windows 八资产文档的 [PR #6](https://github.com/ChaoYuZhang001/CaoGen/pull/6) 已作为 obsolete 关闭并保留分支，不会误合入 `main`。
- v0.1.5 Windows x64 安装包继续保留；v0.1.7 不发布 Windows、macOS arm64 或 Linux 资产。
- v0.1.5 新增整页设置与 Provider 编辑、项目级会话收纳、未关联项目会话收纳、三种显式调度范围，以及调研/策划/开发/测试/文档的默认与自定义模型调度。
- `main@bbec526554aea9785291edf4d8164084145347ae` 的 Intel-only GitHub 最终候选 run [`30162696430`](https://github.com/ChaoYuZhang001/CaoGen/actions/runs/30162696430) 已成功：release-scope P2 gate 通过，exact-commit Deep 为 `159 total / 157 required pass / 2 optional skip / 0 blocked / 0 fail`，x64 完成 Developer ID 签名、公证、staple、Gatekeeper、`120/120` required release audit、DMG 隔离安装、干净 detach、真实 renderer 启动，以及 `latest-mac.yml` 对 x64 DMG/ZIP 的名称、版本、大小和 SHA-512 绑定。该 run 的 Apple Silicon、Windows 与完整矩阵汇总 job 均按输入范围跳过，因此只证明 Intel，不证明完整三平台。
- 仓库保留完整三平台矩阵门禁，只有选择完整矩阵范围或宣称三平台发布时才要求 macOS x64、macOS arm64、Windows x64 全部通过 required distribution audit、包内 clean-commit provenance、目标平台原生安装和真实 renderer 启动。创始人已把当前 0.1.7 M1 收窄为 Intel-only；该范围使用 x64 lane 的独立签名/公证/安装审计，不把跳过的 arm64/Windows 算成 pass。完整矩阵 Release Doctor 继续保持 `not_ready`，准确表达未完成的未来三平台能力。
- `.github/workflows/release-candidate-evidence.yml` 已把 M1-T3 固化为只读、手动、不可发布的候选证据管线：输入必须是已在 `main` 的完整 40 位 SHA 与精确版本；可选择 `macos-x64` 或完整三平台范围。run `30162696430` 已证明仓库中的 Intel 签名/公证 secrets 可用；这不证明 Apple Silicon/Windows secrets 或资产。workflow 不创建 tag/GitHub Release。
- 移除 Claude Code Runtime 前的本地 unsigned Intel 基线为 DMG `197,518,789 B`、ZIP `197,966,775 B`、`.app` 逻辑体积 `555,506,427 B`、`app.asar` `61,742,511 B`，其中 Claude CLI 为 `240,192,080 B`。移除后的本地 unsigned Intel 实测为 DMG `125,638,991 B`、ZIP `125,002,021 B`、`.app` 逻辑体积 `311,931,918 B`、`app.asar` `61,630,882 B`，分别减少 `36.39% / 36.86% / 43.85% / 0.18%`。当前 clean candidate 的签名公证资产为 DMG `127,702,230 B`（SHA-256 `a6b65ddd7d11bc8aab36cd800a7ddd9055b562d5aa85b39ef0296fb9c4f78a7b`）与 ZIP `127,016,670 B`（SHA-256 `5f3695fa24117145cd47ecf731660ea3423911ad7bc2de9108c3f786aa78f5e0`）；包含两项 blockmap 与 `latest-mac.yml` 的五文件资产集绑定 `7553d1ef33ec44d69e7b95c74aee8fcb7500a68daf008ed343e66ae3345a036c`。required audit 证明 SDK/CLI 在包内不存在，且 app、DMG、ZIP 的 `0.1.7`、clean worktree 与完整提交 provenance 一致。
- M1-T4 的仓库公开进度口径已更新为 `64 = 21 已验证 + 18 部分完成 + 24 立项目标 + 1 仅达到基础`。官网生产构建已同步 v0.1.7 下载、Intel-only、签名公证和运行时边界；该文档口径不改变 Release Doctor 的 `not_ready` 状态，也不替代暂停平台、真实 Provider、N1 或完整 1.0 验收证据。
- 正式运行时只有 OpenAI-compatible（Responses / Chat Completions）与原生 Anthropic Messages（`/v1/messages`）两条执行路径，均已注册到 Provider/SessionManager/UI。Claude Code Agent Runtime、Claude Agent SDK 与 Claude CLI 已从依赖、主进程、IPC/UI、测试宿主和打包规则删除；旧 `engine: claude` Provider/会话只迁移为 `anthropic`，不恢复 SDK 隐藏上下文。当前 Intel 候选 Deep 报告 `2026-07-25T15-06-42-357Z` 为 `159 total / 157 required pass / 2 optional skip / 0 blocked / 0 fail`，开始和结束均绑定 clean `bbec5265`；它只证明该精确提交的 Intel 候选和仓库 required gates，不替代暂停平台、真实 Provider、N1 或完整 1.0 验收证据。
- M1-T6 的原始发布动作已完成：只读、fail-closed 的 Intel 发布交接预检在 publication-only 后继提交 `d8e883a2` 上通过后，创始人授权创建 `v0.1.7` Tag/Release 并上传精确五项资产；当时公开资产审计为 `passed`。2026-07-26 的远端追加已使该发布后断言失效；仓库现增加每 6 小时及手动运行的只读 Release 完整性审计，并把 Windows unsigned 构建输出改成显式 `unsigned-preview` Actions artifact、排除 `latest.yml`、要求手动确认 preview-only。当前还需获得明确授权后恢复远端五资产/正文合同；该回归不关闭陌生用户 Quick Start、N1、真实 Provider 或 1.0 验收。
- M1 首位陌生用户验收工具链已就绪：`docs/M1-FIRST-USER-DRILL.md` 固定官网→Intel DMG→无安全绕过安装→Provider 配置→只读任务五步；私有结果 schema v2 和 `test:m1-first-user-onboarding:required` 绑定 `v0.1.7`、候选提交、公开 DMG SHA-256、Intel 架构、30 分钟、零修改及四份独立证据，并强制录屏前明确同意、唯一证据用途、最长 30 天保留、`deleteBy`、脱敏复核和真实删除状态。文件仍存在或审计未完成时不得声称已删除。失败演练可用 `--observation` 留下 `observed_failed`，但不会成为通过；负向 smoke 已覆盖原有发布/通过条件以及无同意、未复核、超期保留和虚假删除。当前仍没有非项目参与者真人结果，M1 整体完成判据保持开放。
- M1 招募已公开：`npm run prepare:m1-first-user-drill` 会在仓库外创建权限收紧的私有目录、记录模板和主持人清单，不下载 DMG、不创建假证据；中英文 README、[Discussion #9](https://github.com/ChaoYuZhang001/CaoGen/discussions/9) 和 `CaoGen-Website@f8e8c50` 生产下载区只征集 Intel 机型、时区和可参与时间，并明确禁止公开 Key、Provider URL、项目路径、录屏或证据。Discussion 已增加证据生命周期与候补名单规则，并从 General 原地移到 Announcements；GitHub 仓库 About 的空 homepage 字段已补为 `https://caogen.dev`，不修改或覆盖 v0.1.7 Release。首条外部评论是验收设计建议，不是报名；它暴露的 SLA 漏算已在 `main@b98acd11` 修复，live audit 现将其作为独立线程并记录 `1 responded_on_time / 0 pending / 0 overdue / 0 late`，维护者首次回复耗时 51 分钟。2026-07-26 调整入口时公开 DMG 下载计数为 1；当前合格参与者和真人记录仍为 0，不能关闭 M1。
- M1 招募增量已在 clean `main@d424d6c2be8ce4b0c0b3237d7255a9740495a3c1` 完成全量 Deep：时间戳报告 `test-results/caogen-deep/2026-07-26T03-24-20-655Z/deep-test-report.json` 为 `163 total / 161 required pass / 2 optional skip / 0 blocked / 0 fail`，开始和结束都绑定该提交、clean 且 Git 状态未变；新增私有准备 smoke 与原有首位用户审计 smoke 均为 required pass。该结果证明仓库回归稳定，不是陌生用户安装、Provider 配置或任务完成证据。
- 社区 SLA 修复与 M1 schema v2 证据治理合并后，clean `main@0874f5a71f890403c008100889c5eb339eb57f98` 的完整 Deep 报告 `test-results/caogen-deep/2026-07-26T06-11-06-988Z/deep-test-report.json` 仍为 `163 total / 161 required pass / 2 optional skip / 0 blocked / 0 fail`；起止均绑定该提交、clean 且 Git 状态未变。两项 M1 smoke、社区契约与 SLA smoke、typecheck、build、编码标准及共享 Electron/恢复链均为 required pass；两项中国真实外部检查继续是 optional skip，未计作通过。远端由维护者回复触发的 SLA Actions run [`30190540484`](https://github.com/ChaoYuZhang001/CaoGen/actions/runs/30190540484) 也在含修复的 `b98acd11` 上成功。该工程证据不替代陌生用户真人结果。
- M2-T2 onboarding 应用内基础已在 v0.1.7 后续源码继续收口：欢迎页首张卡精确注入公开 `quick_start_project_read_only_v1` 只读提示词；Assistant 无执行资源与 Expert 无 Provider 都提供可操作恢复。恢复动作现在携带首任务来源，无可用 Provider 时直接进入新增/修复 Provider 表单；恢复场景缺 API Key 或缺模型时会留在表单内给出双语明确错误，且不会创建半成品 Provider，普通设置场景仍可分步配置。只有保存出“已配置密钥且至少一个模型”的 Provider 才自动返回首任务，取消或不可用保存不会误关闭设置。首任务提示词、目录、Drive、权限、路由模式、Provider/模型和 Studio 子页均跨设置往返保留，恢复成功后旧错误自动消失且发送前仍为零会话。真实 Electron `routing-zero-choice` E2E `2026-07-26T14-44-18-900Z` 为 `9/9`、6 张截图，已通过真实 UI 验证缺 Key、缺模型、有效保存三段路径，不再用 IPC 直接创建 Provider；随后仍走真实 Router/流式响应及模式切换一致性。编码标准 ratchet 把 `WelcomeView` 从 296 行/复杂度 18 降到 222 行/复杂度 11，未新增硬债务。此前脏工作树完整 Deep `2026-07-25T18-20-19-937Z` 为 `160 total / 158 required pass / 2 optional skip / 0 blocked / 0 fail`；该结果和本次 targeted E2E 都不代表 clean release 绑定、M1 真人验收或 M2-T2 完成，仍需用首位陌生用户和三人 N1 记录验证配置成功率、文案理解与恢复时长。
- 首轮 clean Deep `2026-07-26T14-56-32-490Z` 在 required page operations 尾段真实发现：关闭最后会话并删除项目后，Welcome 草稿未固化推导出的项目选择，项目消失时会退回“新项目目录”，下一次发送会静默重建已删项目。功能候选 `7ed1b5fb4e7d414587734f8c660aca8b8c40bad9` 已把首个项目选择写入草稿，并在项目删除或归档后同步投影为“未关联项目”；最终 targeted page report `2026-07-26T15-39-17-535Z` 与完整 Deep 子报告 `2026-07-26T16-11-50-301Z` 均为 `22/22`。完整 Deep 报告 `test-results/caogen-deep/2026-07-26T15-42-01-402Z/deep-test-report.json` 为 `163 total / 161 required pass / 2 optional skip / 0 blocked / 0 fail`，起止均精确绑定该 SHA、clean 且 Git 状态未变。该结果证明现有 onboarding/恢复链回归稳定，不关闭真人 M1、公开 Release 完整性或 formal 1.0 门禁。
- Assistant/Studio 性能门禁在 M2-T3 集成时连续三次真实失败，失败点分别为 mobile warm `307ms`、tablet cold `393.4ms`、mobile warm `433.2ms`，均按失败保留。诊断确认 Studio chunk 首次点击才加载、已挂载的隐藏 Project/DigitalWorker 子树会随模式切换重复渲染，且宿主偶发 animation-frame 调度空洞会污染 wall-clock；现在使用可重试模块 Promise 后台预载、memoize 无模式 Context 依赖的 Studio 根节点，并要求每个正式样本前先建立 4 个连续 `<=50ms` 健康帧，5 秒内无法建立则 required 失败。完整脏工作树 Deep `2026-07-25T21-09-18-544Z` 为 `162 total / 160 required pass / 2 optional skip / 0 blocked / 0 fail`，同一 `3 cold + 60 warm`、原 `<300ms` 门禁 cold P95 `32.90ms`、warm P95 `32.60ms`；帧健康前置真实捕获到最长 `1908ms` 宿主调度空洞，正式样本最大值 `33.80ms`。live-switch `5/5`、canonical consistency `5/5`、required UI `9/9` 和 page operations 同时通过；该结果来自 dirty worktree，不冒充 clean release 绑定。
- Studio 新会话状态已按投影语义收口：`showNewSession` 会把 Studio 切到自己的会话面板，侧栏/菜单新建保留用户当前模式，3D Office 新建离开 Office 后显示可编辑 Composer，不再留下隐藏 Welcome DOM。macOS Tray 也从每 5 秒无条件重建菜单改为订阅 Session 事件，并只在 running 数量变化时更新；完整 Deep 内 page operations、Assistant/Studio required UI 和 macOS Tray icon smoke 均通过。
- M2-T3 反馈通道已完成首个真实闭环：公开 GitHub Discussions 保留 General、Ideas、Q&A 分类，仓库提供双语分类表单、Issue/README/SUPPORT 导流和 48 小时维护者首次回应口径；只读工作流每 6 小时及新评论事件扫描公开 Issue、PR、Discussion。SLA 审计现在把维护者 Discussion 下的外部顶层评论作为独立反馈线程，OWNER/MEMBER/COLLABORATOR 的直接回复才计数，自动回复不计数，当前逾期阻断、历史迟复告警。Discussion #9 的外部建议从修复前错误隐藏，变为修复后的 `pending`，并在维护者 51 分钟内回复后成为 `responded_on_time`；当前 `0 pending / 0 overdue / 0 late`。这证明反馈入口与首次响应闭环，不证明该评论者是产品测试者或 M1 已通过。
- M2-T5 官网演示视频已上线：独立 Remotion 工具源码已随 `main@16954790` 提交，官网仓库 `main@e5be292` 已部署到 Cloudflare Pages；中文/英文首页均实测包含 `#demo`、原生 MP4 播放器和移动端单列布局，生产 MP4 返回 `200 video/mp4`，大小 `3,369,296 B`，SHA-256 为 `bdb93198b35db545a6af0fd5530b0eb598eb4c5680085f48e3b88810711a553f`。该项只关闭 M2-T5，不代表 M2、M1 或 1.0 完成。
- Agent 恢复内核已升级为稳定事件身份 + 恢复游标 + 持久 Effect Ledger。`write_file`、`search_replace`、OpenAI/Anthropic 原生文件编辑、Git commit/merge/push、Renderer 文件与 Git Index 操作、文本 hunk 丢弃、managed-worktree create/remove/patch 和 GitHub/GitLab PR/MR 已接入专用只读对账；Operation Gateway、lease/fencing、强杀恢复、DAG autoMerge durable finalizer/receipt 已由 required E2E 覆盖。该边界不等于外部系统事务级 exactly-once，writer 仍可能在强杀/断电/ENOSPC 时留下半写文件。
- `task-snapshots.db` 当前为 v8：保留 v6 TaskRun Effect evidence append-only hash-chain foundation、Goal/WorkItem/Run/Artifact/Acceptance/Evidence Link 与全局 workflow event chain，并新增 canonical `workflow_recovery_sessions` 和持久 `workflow_store_identity`。显式对象的 main API、IPC/preload、Control Center 查询/校验和 cursor 分页已有 targeted smoke；Artifact Graph 的 edge/location、关系/归属校验、邻域查询、脱敏 export 与只读 diagnose/repair plan 也已接通。Task Snapshot/TaskRun 恢复读取现支持 `legacy`、`compare`、`canonical` 三态：`legacy` 读取旧 Snapshot/TaskRun 表，`compare` 同时读取 legacy 与 canonical 并在差异时 fail-closed，`canonical` 读取 Workflow Run 与 recovery session；未显式配置时仍默认 `legacy`。read mode 按解析后的数据库路径隔离，跨 mode 首次 open 共享同一路径的 single-flight readiness；运行时 mode flip 在数据库 mutation queue 中强制刷新 readiness，并实际读取 recovery sessions 与 Run 历史后才提交。legacy JSON/旧 SQLite 到 v8 的迁移仍使用 `prepared -> backup_verified -> migrated_verified -> committed`、`rollback_pending -> rolled_back`、精确备份/SHA-256/fsync/原子 rename、崩溃 checkpoint 续做和可恢复回滚；future/corrupt source 在 journal 前 fail-closed。committed journal 通过 `workflow_store_identity` 和 committed 高水位连续性阻止目标删除、截断、版本回退或同版本有效空库替换。Canonical-only 历史在后续双写和重启后仍可读取；同一 session 的连续 TaskRun、Snapshot freshness 和历史 Run ownership 已按精确 run/项目上下文收口。该能力完成的是 Task Snapshot/TaskRun 恢复读源的可验证 cutover，不代表所有业务入口已经 canonical，也不等于完整 1.0 Workflow OS。结构化交叉验证仲裁失败与原生 `bash` 显式测试命令的非零退出失败已有受限入口；Routine、DigitalWorker/Assignment、其他工具/引擎测试结果等外部事件仍未全部接入。完整 Artifact Graph 生命周期（blob/sourceRef、版本/保留/删除）、Canonical Conversation Ledger、统一 retention/delete 和生产补偿计划/审批/执行也未闭环。独立 `task_evidence` 子链没有直接 UI 或统一 retention/delete 通道。当前候选 159 项 Deep 已包含 migration、read source、shadow consistency、Workflow Ledger、Artifact Graph、security、maintenance、ModelAttempt crash reconciliation、Canonical Goal/WorkItem schema parity、canonical ProjectWorkspace write-source crash、Acceptance failure ingress、Artifact byte integrity、TEAM-002 真实 Electron 招聘、Provider credential target binding、Assistant/Studio live-switch、Anthropic 生产路径、Code Forge contract smoke 与 Intel 发布元数据证据；报告绑定 `bbec5265` 且开始和结束均为 clean，但仍不等于 1.0 release ready。
- Canonical ModelAttempt v1 已把 OpenAI-compatible 请求、模型 DAG 与原生 Anthropic Messages 每次底层 HTTP 请求接入 Run/WorkItem 归属、逻辑 request/step、Provider/model/protocol、route reason、usage 和不可变事件链；`started` Attempt 在强杀重启后会把 legacy TaskRun、canonical Run 和匹配 snapshot 原子投影为 `waiting_reconciliation`，普通发送/恢复/删除均 fail-closed。用户只能显式 `retry_authorized` 或 `cancelled_by_user`；授权本身不调用 Provider，successor 必须消费同一 requestId/stepId 并链接 predecessor，二次强杀不会复用旧授权。原生 Anthropic Messages 已注册独立 EngineKind 并接入 Provider/SessionManager/UI；saved Provider/Broker 目标绑定、`/v1/messages`、thinking/redacted thinking/text SSE、usage、HTTP/流错误、取消、`tool_use/tool_result` 多轮 NativeToolRuntime、权限/审计/Effect/幂等、40 请求上限、同 Provider Key 与仅限 Anthropic Engine 的 Provider failover，以及内容寻址图片重启恢复，分别由 `test:anthropic-messages:required` 17/17、`test:anthropic-tool-use-loop:required` 10/10、`test:anthropic-failover:required` 8/8、`test:anthropic-engine-registration:required` 和 `test:anthropic-image-restart:required` 覆盖。partial 输出、abort、账本失败或未决 Effect 会保守阻止重放；当前仍缺真实 Provider、clean release 绑定、完整恢复阶梯与统一 Run/Context 契约，因此 ROUTE-004/RUN-003 仍仅为部分完成。
- 2026-07-20 的 1.0 domain 增量已落地无目录 `ProjectWorkspace`、Goal Contract、WorkItem、Resource、归档/恢复/删除/manifest 导出，以及原生 RoleTemplate、DigitalWorker、Assignment、退休历史、lease/fencing 和 `done/completed` Evidence/waiver Acceptance Guard 基础；ProjectWorkspace、DigitalWorker 和 Acceptance targeted required smoke 均通过。Studio 已提供 Project/Goal/WorkItem 与数字员工基础 UI；固定 Assistant/Studio 控件在真实 Electron 中以鼠标、Space/Enter、唯一 `aria-pressed`、草稿/会话/转录不变、Office/搜索往返、遮罩层和 `1320x860 / 760x700 / 360x520` 六张截图完成 `9/9`。新增 running live-switch E2E 以单一 Responses 请求验证十次 Assistant/Studio 往返、流顺序/唯一性、重复发送防绕过、运行中模型切换 fail-closed、可见 UI 拒绝和 source/build 新鲜度。Goal/WorkItem 的生产 `list/get` 已默认切到 hash-chain verified rich view；生产命令现于持有 JSON CAS 锁期间先提交 Workflow Ledger，再把 JSON 作为 Workspace 可见性目录和恢复投影落盘。新 required smoke 已证明迁移时 JSON 仍是旧态、三个强杀检查点、死进程锁即时回收、重启 CAS 修复和无重复 replay；migration/digest/entity/compare 异常继续 fail-closed，只有显式 `legacy` 读模式才回滚读取。DigitalWorker 招聘已创建 CaoGen 原生岗位实例，v2 策略 schema 显式迁移并重启恢复；Assignment 加载、策略更新、lease 和 reassign preflight 会复核数据范围，拒绝发生在 owner 写入前；终态 Acceptance 还会执行 Evidence 下限和显式用户批准。新增真实 Electron required E2E 已以 `11/11` 跨三次启动验证 RoleTemplate 招聘、完整策略录入、WorkItem Assignment、重启无重复、UI 退休、拒绝新 Assignment、历史保留和外部 Agent CLI sentinel 零调用。tool/budget/concurrency/escalation 全动作执行、其他业务入口 canonical 化、Run/Artifact linkage、TEAM-005 完整保留/导出/删除策略和 clean release evidence 仍开放。
- Workflow Acceptance repair/retest 与结构化失败接入本地基础已接通：failed review 按 Acceptance ID + revision 确定性创建同 Project/Goal/parent/owner 的 canonical repair WorkItem 及其 Acceptance；并发/重复创建幂等，绑定冲突 fail-closed，启动时恢复已提交失败但缺失的 repair。repair 未 `done` 且 Acceptance 未 `passed/waived` 前拒绝 retest；完成后原 Acceptance 清空本轮 Evidence/Verifier 并进入新的 `verifying` revision。多 criterion Acceptance 已要求每项绑定非空 Evidence 和 criterion-scoped `verifies` link；可选且不可变的 `criterionPolicies` 一旦声明就必须全量覆盖 criteria、固定 criterion ID/index，并把每项限制为指定 Workflow Evidence kind 与允许 source，Task Effect origin 或 kind/source 不匹配均 fail-closed；无 policy 的旧记录继续兼容。review/retest 保留原 policy；repair-derived Acceptance 在新建、重复恢复和启动恢复时继承同一 kind/source 约束，并将 criterion ID 重新绑定到 repair WorkItem 的确定性 criterion。对带 policy 的 Acceptance，typed cross-validation/test failure 在未显式提供 `criterionIndexes` 时必须恰好匹配一个语义兼容的 review/test criterion 才能自动绑定，零个或多个匹配均 fail-closed 且不落 Evidence。终态 canonical gate 会重新解析 live store：Workflow Evidence 必须匹配 `workflow.evidence.recorded` envelope/payload digest，Task Evidence 必须匹配 `workflow.effect.evidence` 事件及 Run/Effect source；Acceptance passed 后删除 Workflow Evidence、Task Evidence 或 Evidence Link 会在 ProjectWorkspace 源提交前 fail-closed。passed Workflow Evidence 绑定 Artifact 时，门禁还要求 Artifact digest、Evidence content digest、available 本地 path 或 `file:` URI、声明 checksum/size 与稳定读取的真实常规文件字节一致；缺失、删除、篡改、符号链接、remote-only 或任一 available 本地副本异常都会在 ProjectWorkspace 源提交前 fail-closed。受信 main-only ingress 会把 typed cross-validation/test failure 原子写成 immutable Evidence、criterion links、failed Acceptance revision 与 audit event，并恢复缺失 repair；交叉验证生产者只接受首行结构化结论，只有 `BOTH_NEED_FIX` 或在 reviewer 已给出 `CONCERNS/BLOCKED` 时的 `REVIEWER_OK` 才接入，`PASS`、畸形文本、`PRIMARY_OK`、`NEED_HUMAN` 均不接入。原生 `bash` 工具结果现携带结构化 `commandTermination` 与 `exitCode`；只有绑定当前 Session/TaskRun/ToolExecution/canonical testing WorkItem、事件与输入/输出摘要一致、显式测试命令，并同时满足 `commandTermination === 'exited'`、`isError === true`、`exitCode` 为非零安全整数的真实 `tool-result`，才会生成只含摘要与 SHA-256 的测试失败 Evidence 并进入同一 repair 路径。`timed_out`、`aborted`、`output_limit`、`spawn_error`、`not_started` 等基础设施终止不会误报 Acceptance failure；普通 turn 错误、非测试命令、缺失退出码或跨项目 Run 同样拒绝/忽略。Snapshot barrier 固定为 `capture -> flush -> persist -> delete`，flush 受 per-session failure latch 约束；启动恢复会补齐快照已提交但 ingress 或 Run 绑定未提交的状态，并在 replay conflict 时 fail-closed。ART-002 的 policy authoring UI 与 Acceptance review/evidence UI 已由真实 Electron required gate 覆盖创建、多 criterion kind/source、空 source 拒绝、按 criterion 选择匹配 Evidence、通过和重启一致性；WorkItem transition/lease 控件也由真实 Electron required gate 覆盖状态图、owner-bound lease、终态清理和重启持久化。Supervisor pause/cancel/resume/retry/reassign 已接入受信 main-process SessionManager 控制切片；该能力仍不等于完整 WORK-004/ART-004：其他工具/引擎测试生产者、自动测试编排、Studio 控制 UI、自动 repair Run、独立 Verification/不可变端到端链、repair/retest review UI、跨域 strong-kill 和 clean release-bound evidence 仍开放。
- Supervisor 的持久状态/IPC foundation 已通过 `npm run test:supervisor-state:required`：最新 core/IPC/restart/bridge 报告分别为 `test-results/supervisor-state-smoke/2026-07-22T07-08-08-366Z/report.json`、`test-results/supervisor-ipc-e2e/2026-07-22T07-08-24-606Z/report.json`、`test-results/supervisor-restart-e2e/2026-07-22T07-08-38-598Z/report.json` 与 `test-results/supervisor-taskrun-bridge-smoke/2026-07-22T07-08-40-492Z/report.json`。新增 `test-results/supervisor-session-control-smoke/2026-07-22T07-08-50-631Z/report.json` 以受控 Engine 证明 pause→resume→reassign→cancel、failed→retry→resume、同一 TaskRun 身份、控制强制 expected revision/lease ID/fencing token、stale revision 在运行时动作前拒绝、retry 缺少匹配快照时不提交/不消耗次数、failed resume 转 blocked，以及 SessionManager 重建后 paused Run 仍保持发送/自动 replay 门禁直至显式 resume。pause/cancel/reassign 的 store 与执行器动作仍不是跨文件事务；Studio UI、预算/并发 enforcement、自动编排、真实 Provider 控制 parity 和跨域强杀后 retry/reconciliation 也仍开放。因此 `RUN-004`、`WORK-004` 与 `NFR-REC-004` 仅为部分完成，`RUN-005` 仍是立项目标，不构成 release evidence。
- 统一 Learning 生命周期已覆盖自动/模型 Memory、自动 Skill review 与 `optimize_skill`：三类入口只创建 project-scoped draft，保留来源、置信度、payload digest、目标路径与完整 before/after diff；仅主进程可信用户决定可 approve/reject/revoke/rollback/delete。单调版本、expiry、重启审计、项目隔离、symlink-safe journaled Skill 物化/对账，以及仅把 approved/unexpired Memory 注入 Anthropic、OpenAI Chat/Responses prompt 均由 required gate 和完整 Deep 覆盖。该边界不等于 TEAM-007 Worker memory namespace、退休 Worker 行为、全项目 retention/export/privacy 或 clean release-bound evidence。
- 1.0 验收映射已成为机器可读门禁：`npm run test:1.0-acceptance-map` 当前对 64 个 P0 和 38 个 P1 达到 `102/102` 唯一映射并通过结构自测，Release Doctor 已消费该结果；干净基线提交 `20fab616` 的报告（`test-results/product-1.0-acceptance-map/2026-07-23T05-06-26-438Z/report.json`）显示结构通过但严格 closure 仍失败：21/64 个 P0 当前已验证、43 个仍开放，108 个声明 gate command 中 78 个已实现、64 个 requirement 具备 implemented gate、132 项 closure failure。EXP-002 已由真实 Electron 的 5/5 检查证明 Assistant/Studio 共用 canonical Project/Goal/WorkItem/Run/Artifact；PROJ-003 以 27 项检查和 `notProved=[]` 关闭 Project ownership；NFR-PRIV-004 以 13 项本地 Provider parity 与 7/7 真实 Electron 零选择门禁关闭。ART-001、RUN-002、TEAM-003 仍仅部分完成。版本号、Deep 全绿或结构映射通过均不能替代 1.0 product closure。
- ✅ **32 并发压测:修复后 7/7 error=0**(连跑 3 次稳定)。根因=瞬时并发打爆 socket 层;修:并发闸门(默认 8 在途)+ 瞬时网络重试。压力脚本口径已修(idle/error 分统计、error=0 独立断言)
- **Claude Code 登录与 CLI 不再是产品依赖**。使用 Claude 模型时只需配置支持 Anthropic Messages 协议的 Provider API Key；CaoGen 不读取 Claude Code 登录态，不启动 Claude CLI。
- P1 全部可做项收口(2026-07-06):全文搜索、冲突三栏+合并回执、插件安装/卸载/版本/权限、CLI 真验
- Work OS 第一波已进入 main:A1 Drive、A2 Quickbar、A3 Desktop Control、A4 Code Forge、A5 Skill Fabric、A6 Memory Loop、A7 Control Center、A8 Personal OS、A9 Genesis(计划层)。Genesis 只宣称编排/交付计划,不宣称真实外部子 Agent 执行、自动合并、推送或发布。
- P2 本地 smoke 已刷新全绿;P2-005 IDE integrations 已由 `test:p2-ide-build-and-vscode:required`、`test:jetbrains-recorder-e2e:required`、`test:jetbrains-ide-interaction:required` 证明。最新 `npm run test:p2-audit` 报告中 P2-002/P2-003/P2-005 为 proved;`npm run test:p2-audit -- --required` 仍会失败,但失败范围只剩非本轮公开宣称的 P2-001 Windows GUI required evidence 与 P2-004 China external evidence。此前 Doctor 只对 1.x 启用可信 macOS 分发门禁，曾错误地把 0.1.7 未公证包判为 `packaging_release: ready`；该漏洞已修为 0.1.7+ 强制消费 required macOS audit、公证/staple、artifact digest 与包内 clean-commit provenance。旧包负向回归后 Doctor 重新保持 `packaging_release: open`，不得用旧报告发布。
- 私有 Provider 配置已由 fresh required gate 实测：6 个真实目标、72/72 golden tool-call cases、`maxGap=0`，报告为 `test-results/china-tool-call-parity/2026-07-22T09-54-35-764Z/report.json`。门禁仅对 `429/5xx` 或网络异常做最多三次短退避，最终 4 个用例发生重试、72 个结果均为 HTTP 200；没有降低 parity 标准。该结果不替代 clean candidate 上包含 send/tool/artifact/recovery/usage/billing 的真实默认 Provider release record。
- 当前 Intel 主机存在 1 个有效 Developer ID Application 身份，0.1.7 release config、entitlements、Hardened Runtime 和签名配置预检通过。本地 x64 签名基线已验证 Developer ID、TeamIdentifier、45/45 Mach-O、DMG/ZIP 内签名和真实 renderer 启动；它显式跳过 notarize，且构建时尚未嵌入提交 provenance，因此不是最终候选。新版负向 audit 对 app、DMG 内 app、ZIP 内 app 同时拒绝缺失 provenance，并保留 Gatekeeper/stapled ticket 共 6 项失败；未来 release config 会把 schema、完整 Git SHA、clean 状态与版本写入包内 `package.json`，required audit 必须在三份 app 上一致验证。当前进程没有完整公证凭据，历史 `2026-07-22T09-50-24-743Z` API-key 认证结果不冒充当前配置。
- 本轮 `node scripts/secret-scan.mjs --worktree --history` 已通过，覆盖 tracked、staged、worktree 内容、敏感文件名和 Git 历史；该 dirty-worktree 结果仍不替代精确 clean release commit、干净工作树 Deep 和 packaging 发布门禁。
- GitHub Releases 公开资产审计继续要求名称、大小、状态、SHA256 与 `latest*.yml` 文本全部可读;若发布后的远端 read-text 审计超时或失败,只保留本地校验结论,不得宣称公开文本资产已完成扫描。
- v0.1.6 最终发布说明保存在 `docs/RELEASE-NOTES-FINAL.md`,列出精确 5 资产及 SHA256,并作为 GitHub Release 正文。
- Packaging gate 的 v0.1.6 macOS x64 DMG/zip、两个 blockmap 与 `latest-mac.yml` 资产集 SHA256 为 `5ba568959b4973c7fa07a138ff80d1767be8945a9a76d155487b1d6556dc677b`。macOS 包仍未签名,Release notes 保留首次打开说明。
- v0.1.6 打包启动回归发现并修复 `tree-sitter` 运行时缺少 `node-gyp-build` 的主进程崩溃:`node-gyp-build` 已提升为应用直接依赖,`release-packaging-audit` 会解析 `app.asar` 并阻止缺失运行时文件的包通过,`test:packaged-app:mac` 会从全新用户目录启动成品并要求出现真实 `CaoGen` renderer。修复后的 macOS x64 `.app` 已通过该启动测试;仍未签名/公证。
- 项目级规则口径更新:`caogen.md/.caogen.md/README.md` 向 OpenAI-compatible 与原生 Anthropic Messages 两条运行时注入项目身份与规则。未配置规则的新项目也会注入项目身份和缺失规则提示;设置页项目规则已提供结构化编辑器,可同步编辑项目提示词、背景、技术栈、常用命令、测试/构建命令、禁止目录、隔离策略、模型调度策略、项目记忆与历史决策;`caogen.md` 的模型调度策略会进入智能路由理由。由 `node scripts/context-loader-smoke.mjs`、`npm run test:project-rules-ui`、`node scripts/model-router-smoke.mjs` 覆盖。
- 多厂商配置口径更新:Provider 已支持多 API Key、活动 key 选择、行内连通性检测、模型列表同步和持久化健康状态。Provider Credential Broker 使用当前活动 Key 向 OpenAI-compatible、原生 Anthropic、DAG 和模型发现 HTTP 请求注入受管凭据头；不再生成 Claude Code 子进程环境变量。活动 key 遇到鉴权、403、限流或余额/配额错误时,会先切到同 Provider 内的可用备用 key；备用 key 池耗尽后才进入同协议 Provider failover。当前只宣称 Provider Broker 基础,不宣称完整 project/session/operation/expiry 作用域、凭据迁移 crash fault injection、全出口 secret canary、主动额度探测或按 key 权重负载均衡已完成。
- 产品定位门禁新增: `npm run test:product-positioning:required` 会扫描 README、欢迎页入口文案、Release notes、Release gate 和公开品牌入口,防止公开文案重新出现固定未来版本目标、外部产品名称/对比话术、开发者-only 定位、未验证的中转站/Office 版式过度宣称,以及旧的菱形占位 logo。最新通过报告见 `test-results/product-positioning-audit/latest.json`;v0.1.5 release doctor 已在 release commit `d9969e3` 上绑定版本、当前 commit 与干净工作树并达到 `status: ready`。
- 自动调度口径更新:设置页已支持有序自定义规则、项目级模型偏好、Provider 健康过滤、预算限制、结构化决策日志和跨厂商备用目标。`npm run test:failover-target` 已验证 OpenAI-compatible 与原生 Anthropic 两条 failover 路径都会更新固定模型，UI 会显示可读的切换原因与重试目标。当前不宣称自然语言策略编排器、按 key 额度调度、跨月精确成本账本或长期趋势分析。
- 自动调度第五阶段最新闭环:均衡、成本优先、质量优先和速度优先已成为四个独立策略;速度优先先按延迟档排序,同档再参考历史延迟 EMA,专项测试证明它与质量优先会对同一复杂任务选择不同模型。策略优先级为“项目规则 > Core 用户策略 > 专用工作模式预设”;项目 `caogen.md` 的“速度优先”不会再折叠为均衡,Core 不再覆盖用户策略,专用模式仍保留自己的预设。设置页已真实保存 `schedulerStrategy: speed` 和自定义规则 `whenStrategy: speed`;聊天详情、控制中心和 3D 办公选中 Agent 面板均显示有效策略及延迟依据。当前完整深测口径为 `157 total / 155 required pass / 2 optional skip / 0 blocked / 0 fail`。当前仍不宣称自然语言策略编排器、按 key 额度调度、跨月精确成本账本或长期趋势分析。
- macOS 顶部菜单栏图标已与 Dock/应用图标分离:菜单栏使用 18×18 / 36×36 Retina 的透明单色 `trayTemplate` 轮廓并启用 Electron Template 模式,可随 macOS 深浅色菜单栏自动着色;Dock、窗口、应用内品牌与安装包继续使用正式全彩人物 Logo。`npm run test:macos-tray-icon` 已验证 PNG 尺寸/透明通道、打包资源声明、Electron `nativeImage` 加载、Template 标志和真实 Tray bounds(`test-results/macos-tray-icon/latest.json`)。
- 文件预览口径更新:HTML/Markdown/Text/CSV/JSON/图片/PDF 已有真实预览;PDF 已接入文本层 best-effort 提取并可发给 Agent;`.docx/.xlsx/.pptx` 已接入 OOXML 文本与结构提取。macOS 通过独立 Quick Look IPC 生成完整系统文档预览包,HTML/CSS/JS/图片附件全部内联,CSP 禁止网络,renderer iframe 仅开放 sandbox 脚本;完整预览失败时回退首屏 PNG,再失败则保留结构视图。结构视图已支持 Word 显式分页、Excel 工作表和 PowerPoint 幻灯片的上一项/下一项/选择器导航,可把当前页/表单独发给 Agent,批注会保存页码、摘录和结构选择器。`npm run test:office-visual-preview` 已用真实 DOCX 验证 625×980 系统文档预览、缓存、路径边界和附件/外链封锁(`test-results/office-visual-preview/latest.json`);`npm run test:page` 已验证完整 iframe、结构导航、当前单元发送和定位批注(17/17,`test-results/caogen-deep/2026-07-10T12-48-21-376Z/page-operation-smoke.json`)。发送给 Agent 的仍只有提取文本、元数据和批注,视觉 data URL 不会进入提示词。系统渲染可能与原应用中的完整原版式存在差异;编辑、复杂公式、动画和像素级一致性仍未完成,不得宣称。
- 3D 办公口径更新:Office model 已从真实 `SessionState` 派生路由决策、Provider/密钥故障切换、预算/成本、最近耗时、审批、工具、子任务、worktree 隔离/分支/状态与 checkpoint 文件变化;同 Provider 密钥接管会进入选中 Agent 信号栈并点亮工位故障恢复指示,只显示 key 标签。OfficeView 打开时会对可见会话按需刷新 `git status`,并把分支、dirty 文件数、staged/unstaged/untracked、错误状态汇入顶部指标、选中 Agent 面板和工位低位 3D 指示条。设施区离席 Agent 点击验证改为真实 canvas 投影路径扫描,不会直接调用 React/store 状态;最终实现已由两次连续单跑和完整 Deep 内的 orchestration E2E 连续 3 次通过,并覆盖工位、审批 Agent、设施 Agent 与会话打开链路(`test-results/caogen-deep/2026-07-19T16-02-28-655Z/deep-test-report.md`)。由 `npm run test:office-status-recheck`、`npm run test:provider-key-failover` 覆盖;Electron 页面流 `npm run test:page` 也已验证真实会话/worktree/Git 状态、可点击工位和非空 3D canvas。当前不宣称全量实时 git diff 轮询、完整项目交付驾驶舱、长期趋势图或可替代发布管理系统。
- 3D 办公性能口径更新:Office chunk 会在应用首帧后预取,进入 Office 后按 Boot → procedural Low → 选中 Agent Full 分阶段挂载;12 Agent 场景保持 `1 Full + 11 Low`,未选中 Agent 的 Low 不加载 GLB/Draco。历史基准（干净提交 `488caaa5`）记录过 14 项 required 检查及 macOS x64 12 Agent Auto 冷路径 shell/Canvas `26.6ms`、可交互 `170.9ms`、Low `350.0ms`、后台 Full `1310.5ms`;该历史 report 未随当前 checkout 保留。2026-07-18 当前 dirty-worktree 重跑写入 `test-results/office-performance/2026-07-18T09-13-54-270Z/report.md`，因 Electron page target not found 未形成通过证据；因此这些历史毫秒数和当前失败都不替代目标机器上的可复验 release gate。
- Assistant/Studio 性能口径更新:`NFR-PERF-001` 的历史有效基线由 `npm run test:assistant-studio-performance:required` 在参考设备 `MacBookPro16,1`（Intel i9-9980HK、32 GiB、macOS 26.5.2、Electron 40.10.2）完成三次 fresh-process Electron 测量，覆盖 `1320x860 / 760x700 / 360x520`。cold shell 共 3 个样本、P95 `33.5ms`，warm 共 60 个样本、P95 `34.1ms`；证据见 `test-results/assistant-studio-performance/2026-07-22T14-12-03-432Z/report.json`。2026-07-24 在同一设备电池 24%、Low Power Mode 开启且 CPU thermal level 71 的环境中连续三次复测均超过 `<300ms` 门槛，失败点分别落在 mobile cold、tablet warm、tablet warm；这些失败不能被改写成 pass，也不能单独证明产品代码回归，因为 `4a3f6359..61e895dc` 没有 renderer 变更。最终候选必须在正常供电、记录电源状态的环境重新全量测量；门禁阈值保持不变。
- 五支柱当前判断:多厂商、调度和 3D 已形成可用优势;迁移级工作流与长期自主执行仍受真人 N1、跨 Provider 账本、后台持续运行和交付证据约束。当前没有统一评分工件,不再给出百分比。
- 用户实测反馈已修 4 项(冗余"你"标注、矛盾错误文案、引擎×Provider 404、填 key 不生效)

# Current Focus

**当前焦点是等待并执行 M1 首位陌生用户验收，同时修复现有用户流程与发布完整性缺陷。** [Discussion #9](https://github.com/ChaoYuZhang001/CaoGen/discussions/9) 已公开征集一名非项目参与者；等待期间不暂停工程工作，但只做 onboarding、恢复、稳定性、安全与发布保护，不扩张新的 1.0 愿景功能。测试者仍须按 `docs/M1-FIRST-USER-DRILL.md` 使用精确 Intel DMG digest 完成私有演练，失败保留为 `observed_failed`；由于当前 GitHub Release 正文/资产已偏离批准的五资产合同，M1 可以收集观察记录，但在 Release 完整性恢复前不得关闭。Apple Silicon 与 Windows 继续暂停，不计入当前 M1 完成项；64 个 P0 仍为 21 已验证、43 开放。

# Goal

**北极星 N1**:真实重度 AI 工作者 **30 分钟内**跑通日常主链路(导入资产→建会话→@文件/资料→执行任务→审结果→提交/交付),资产零丢失。以五支柱代差做成"世界第一 / 中国首创"验收方向的多厂商 AI 工作桌面。

# Next Milestone

**M1 首位陌生用户验收** — Definition of Done:

1. 一名非项目参与者从 `caogen.dev` 进入 v0.1.7 Release，并下载 macOS Intel x64 DMG
2. 在 Intel Mac 上不使用绕过安全检查的命令完成安装、首次启动和主界面进入
3. 使用该用户自己的受支持 Provider API Key 完成 Provider 配置
4. 按 Quick Start 完成第一个只读项目任务，并保留开始时间、完成时间、失败点和恢复动作
5. 将卡点转成 onboarding 修复或明确 issue；该单人结果只关闭 M1，不冒充 M2 的 3 人 N1 或 10 用户目标

# Priority Tasks

**P0**
- 用户反馈快修循环(常设)
- 恢复 v0.1.7 公开 Release 到批准的 Intel 五资产与仓库最终正文；当前自动审计 fail-closed，删除 3 个 Windows 资产及改回正文等待创始人明确授权
- ~~v0.1.7 Intel 签名楔子版发布:clean candidate、Deep、macOS x64 签名公证/安装/启动审计、Release Notes、公开资产审计和官网同步~~ ✅；Apple Silicon/Windows 暂停
- M1 首位陌生用户 Quick Start 验收；随后按 M2-T1 扩展到 3 名真实同类工具用户的 N1 30 分钟迁移计时
- ~~arm64 / universal 打包~~ ✅ 已发布至 v0.1.1
- P0-1B:~~接入 `search_replace`、OpenAI/Anthropic 原生文件编辑的 queryable file Effect~~ ✅;~~E2A 接入 Renderer worktree patch、独立 push→PR 与 Agent `git_create_pr`~~ ✅;~~E2B-1 接入 Renderer 文件保存/commit并阻止复合 Code Forge commit/pr~~ ✅;~~E2B-2 接入 Renderer stage/stageAll/unstage/accept hunk 的精确 Index CAS~~ ✅;~~E2B-3 接入 discard hunk 独立文件 Target 与强杀对账~~ ✅;~~DAG autoMerge patch Effects 与 completion/finalizer durable outbox/receipt 接入并确认~~ ✅;~~managed-worktree create/remove 生命周期 Effect~~ ✅;继续补齐 Issue、消息、可查询 MCP 与 Code Forge patch
- P0-1C:TaskRun Effect evidence v6 foundation、v8 Workflow Ledger、canonical recovery sessions、`legacy / compare / canonical` 恢复读源和可逆 migration/continuity 门禁已完成 targeted smoke；Goal/WorkItem/Artifact/Acceptance 基础和有限 IPC/UI/cursor 查询已落地，未显式配置时仍默认 legacy；下一步是全入口接入、完整 Artifact Graph/blob/sourceRef 生命周期、Canonical Conversation Ledger、保留/导出/修复和生产补偿计划/审批/执行
- P0-2A:把 GUI/工具临时授权绑定 app/window/action/path/diff/postcondition,统一设置页与运行时的实际沙箱状态
- ~~P0-4A:把深测改为 `pass / skip / blocked / fail` 四态,required 项不得以 skip 通过~~ ✅
- ~~P0-2A:移除新 Provider Key 的 `b64:` 写入 fallback,建立进程内 session-only 降级、旧数据安全迁移和 Provider Broker 基础~~ ✅
- P0-2B:完成 provider/project/session/operation/expiry 作用域、子进程最小环境、全出口 secret canary 与数据保留/导出/删除策略
- P0-3:建立 MCP/插件 Capability Manifest、固定版本/digest、最小环境和恶意 fixture 隔离门禁
- 凭据安全:所有疑似泄漏或曾经外发/公开上传的个人/仓库 token 必须在对应平台轮换或撤销;仓库和 GitHub Releases 内不得保存真实密钥、webhook、证书、keystore、provision profile、签名材料或本地证据包

**历史交付批次 P1**(2026-07-06 收口:3/3 保留项完成;不同于竞品差距文档的新 P1 路线)
- ~~插件治理下半场:安装 / 卸载 / 版本 / 权限声明~~ ✅(本地安装+回收站卸载+
  路径牢笼,7 断言冒烟;版本锁定降级为版本展示,市场分发本版不做)
- ~~会话全文搜索(U5.1)~~ ✅(侧栏消息内容命中直达会话)
- ~~worktree 冲突三栏 + 合并回执~~ ✅(三栏对照+patchSha256 回执)

**历史交付批次 P2**(2026-07-06 推进:3/5 已推送;不同于竞品差距文档的新 P2 路线)
- ~~聊天头工具栏图标化(U3.3)~~ ✅ 8 按钮→图标+⋯更多下拉;page-smoke 按 aria-label 适配全绿
- ~~chat 历史自动压缩~~ ✅ 超 48k token 摘要旧段,不切断 tool_call 配对(e2e 4/4)
- ~~Responses 协议接工具循环~~ ✅ 官方 OpenAI 模型也成真编码 Agent(e2e 5/5)
- ~~路由能力表自学习~~ ✅ 按实测成败/延迟给同档模型打平降权(集成 T17 验证)
- N1 迁移实测:向导映射✅、演练 fixture+计时脚本✅(docs/N1-MIGRATION-DRILL.md);真人 30 分钟计时仍未做，formal 1.0 stable 的 N1 硬门禁仍开放

**Work OS Phase 2 并行任务**(2026-07-08 新排期)
- B0 Release Gate:保持 README/STATUS/release notes 与真实 gate 一致,审计公开 GitHub Release 资产,最后合并;草稿门禁见 `docs/RELEASE-GATE-DRAFT.md`
- B1 Windows GUI Required:P2-001 strict VS Code GUI/cross-app/input evidence,由专门 Windows agent 后续补
- B2 IDE Build + VS Code Host:✅ P2-005 插件构建、VS Code extension host evidence 已通过
- B3 JetBrains Real IDE:✅ P2-005 JetBrains runIde recorder + interaction evidence 已通过
- B4 China External Evidence:6 Provider tool-call parity 已 72/72、`maxGap=0`；P2-004 的独立 China real-network evidence 与发布范围声明仍需按门禁处理

# Blockers

**本地发布门禁与外部条件:**

| 阻碍 | 等级 | 状态 |
|---|---|---|
| ~~32 并发压测 5/6~~ | High | ✅ 已修:并发闸门(8 在途)+ 瞬时重试;连跑 3 次 7/7 error=0 |
| ~~最新 dist:mac 卡 Electron 下载~~ | Medium | ✅ 已修:.npmrc 配 npmmirror;双架构 DMG 完整产出 |
| ~~可选 Claude Runtime auth 误判~~ | High | ✅ 已删除该 Runtime 与登录检测 |
| ~~窄屏响应式布局未过人眼复核~~ | Medium | ✅ 已修:同日 responsive smoke 覆盖桌面/窄屏暗色与浅色主题及水平溢出;证据:`test-results/caogen-responsive/2026-07-06T10-08-05-301Z/responsive-light-smoke.json` |
| ~~新最终候选 Deep~~ | High | ✅ run `30162696430` 在 clean `bbec5265` 上通过 `157/157` required、2 optional skip，并完成 Intel 签名/公证/安装/renderer 与五资产证据；optional skip 未计作 pass |
| v0.1.7 公开 Release 完整性 | High | ❌ 远端现为 8 资产且正文包含未批准 Windows 发布声明；仓库五资产 Notes 合同审计失败，等待明确授权恢复远端状态 |
| arm64 包真机启动 | — | 创始人决定暂停；若恢复，仍需真实 Apple Silicon 机器，Intel 不可替代 |
| Docker | — | 不需要；产品运行模式、资源和分支已删除 |
| Claude Code 登录 | — | 已不需要；原生 Anthropic Messages 使用 Provider API Key |

**外部与人工发布门禁:**

| 阻碍 | 等什么 |
|---|---|
| Apple Developer / 签名材料 | GitHub Intel lane 已用已配置 secrets 完成 Developer ID、公证和 staple；本地 shell 不持有这些材料 |
| GitHub Actions 发布 secrets | Intel lane 已验证可用；Apple Silicon/Windows 凭据与 lane 未验证且当前暂停 |
| Apple Silicon 真机 | 暂停；只有恢复并宣称 arm64 真机启动时需要，Intel 机器不能替代 |
| 指定 Provider key / 额度 | 6 Provider tool-call parity 已 72/72；formal 1.0 仍需在最终 clean candidate 上生成真实默认 OpenAI-compatible release record，覆盖 send/tool/artifact/recovery/usage/billing |
| 凭据轮换 | 曾暴露或疑似外发的 token 必须由凭据持有人在对应平台撤销/重建 |
| N1 30 分钟计时 | formal 1.0 stable 硬门禁；需真人按秒表跑并留证 |
| M1 首位陌生用户 | 验收指南、模板、审计器与负向 smoke 已就绪；仍需 1 名非项目参与者在 Intel Mac 上完成私有实测 |
| 后续版本 push / GitHub Release | 每次仍需在精确 release commit 上通过发布门禁并获得用户授权 |

# Decisions

不会改变的原则:

1. **实测才算完成**:每个特性配真实 E2E(真进程/真 IPC/真模型调用),"编译过"不算数;状态如实标注,不虚标
2. **六环链路**:新能力必须主进程 → IPC → preload → types → store → UI 全通才算接通
3. **不搬同类工具代码**:只借鉴信息架构与交互,纯自实现
4. **安全边界**:新密钥不得以明文或可逆编码持久化且不出主进程;旧可逆记录必须迁移或要求重新输入;文件工具路径牢笼;权限审批不可绕过(bypass 需显式选择);发布物不含任何凭据
5. **中英双语**:所有 UI 文案 zh/en 齐备,zh 为母语级
6. **每任务独立提交**,提交信息写"做了什么 + 怎么验证"
7. **诚实降级**:能力不可用时如实报告(如 OCR 无引擎、PR 无 gh/glab),绝不伪造结果

# Out of Scope

当前滚动发布周期明确不做:

- 云端 Routines / 云端 Runner(本地定时任务已有)
- App Store 上架(走 GitHub Releases 分发)
- Windows x64 已在 v0.1.5 发布,但可见桌面最终截图受锁屏条件限制;后续 Windows 版本仍需真实 Windows 回归后再发布。Linux 打包配置存在但未完成发布验证,不承诺
- 移动端、自研/微调模型
- 插件市场(安装/治理做,"市场"不做)
- 写实游戏级 3D 自由漫游

# Risks

1. **零外部用户数据**:所有"可用"结论出自 E2E 与自测,N1 从未真人验证 —— 最大未知
2. **分发摩擦与发布漂移**:v0.1.7 Intel x64 的 provenance、Developer ID、notarize、staple、Gatekeeper、DMG 隔离安装和真实 renderer 证据仍有效，但公开 Release 已偏离批准的五资产/正文合同；在远端恢复并重新通过自动审计前，不得继续宣称公开资产审计通过。陌生用户机器上的下载、安装和 Quick Start 证据仍缺；Apple Silicon arm64 与 Windows x64 按当前决定暂停，不得由 Intel 或未批准 Windows artifact 替代
3. **外部凭据轮换状态不可由仓库验证**:疑似外泄 token 必须由持有人在对应平台撤销/重建;仓库只保留占位符、环境变量名和脱敏状态
4. **长会话膨胀**:~~chat 历史无压缩~~ 已加自动摘要压缩(超 48k token);OpenAI 引擎工具声明每请求固定开销仍在

# Success Criteria

- **下一次发布验收** = Release Gate Draft 中的阻塞项全部成立;P2-001/P2-004 按当前 macOS 窄发布边界不阻塞，N1 对 formal 1.0 stable 是硬门禁
- **长期成功** = 北极星 N1 由**非项目相关**的真实同类工具深度用户验证通过(30 分钟计时 + 资产零丢失 + 关键动作无需回退原工具)
