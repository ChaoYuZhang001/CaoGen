# CaoGen 项目状态

> 更新:2026-07-11(第 27 次)· 实测口径,非文档自评。此文件为活文档,Current Focus 随日更新。
>
> ⚠️ **未达完整发布标准**。本地代码、构建和四态 Deep 门禁已收口；正式签名/公证、Apple Silicon 真机启动、指定真实 Provider/中国网络证据仍取决于外部账号、机器或额度。Docker 已从产品模式删除；Claude 是可选引擎，不登录也不阻塞默认 OpenAI-compatible 路径、本地启动或发布门禁。
>
> **状态纪律**(修正第 2 次犯的"未复现即声称"):凡真对话/可用性类结论必须写明**成立条件与复现环境**,不写环境无关的绝对断言。

# Context

国产原创**多厂商 AI 工作桌面**(Electron + React + react-three-fiber,MIT 开源,[GitHub](https://github.com/ChaoYuZhang001/CaoGen))。差异化站位:**不绑定厂商** —— 支持多模型、多密钥、多厂商配置,接入中转站和本地兼容服务;每个项目可独立配置 AI 工作规则;内置代码执行、项目理解、任务拆解、自动调度、工作区隔离、插件扩展、项目记忆、文件预览和 3D 办公可视化。

# Current Status

- **v0.1.4 发布候选**(2026-07-12,本轮只发布 macOS x64 资产且尚未上传;GitHub 最新公开版仍为 v0.1.3)——Intel 主二进制与实际启动已验证,arm64/Windows/Linux 不在本轮发布范围
- 正式运行时保留可选 Claude Agent SDK 与默认 OpenAI-compatible API 两类执行路径。最新完整四态门禁目标与当前基线为 `87 total / 84 required pass / 3 optional skip / 0 blocked / 0 fail`；本次不可变报告为 `test-results/caogen-deep/2026-07-11T13-56-12-426Z/deep-test-report.md`，滚动入口为 `test-results/caogen-deep/latest.md`。3 个 optional skip 分别保留真实 Claude、China real-network、China tool-call parity 的外部条件，不计入 pass，也不阻塞默认发布档位。
- Agent 恢复内核已升级为稳定事件身份 + 恢复游标 + 持久 Effect Ledger:每个外部效果包含独立 intent/effect/resource key、generation/revision、资源级 lease/fencing、状态与 evidence digest;SQLite barrier 会跨会话阻止同路径或同 device+inode 的并发执行,字段级合并避免普通事件覆盖 Effect 终态。`write_file`、`search_replace`、OpenAI `edit_file`、Claude 原生 `Edit`、`git_commit`、`git_merge`、`git_push` 已支持只读自动对账;`search_replace dry_run=true` 保持只读且不建立 Effect,Claude `MultiEdit/NotebookEdit` 仍按 opaque fail-closed。文件编辑会冻结原始字节摘要、UTF-8 BOM、root/file 身份和预期内容;本地 writer 使用 identity/hash CAS,absent 写入还绑定审批时 root/parent 身份并原子发布,硬链接别名共享资源互斥。`git_merge` 会冻结 repo/ref/source SHA 与目录身份,在隔离 ODB 预检,并在 trusted ref transaction 中原子校验 old SHA、两父节点和 expected tree。强杀证据证明的是 Effect 执行边界可恢复,不是 writer 内部 crash-atomic:existing-file writer 仍原地 `truncate/write`,进程在写入中被杀、断电或遇到 ENOSPC 时仍可能留下空文件或半文件。这仍不是任意外部系统的事务级 exactly-once:PR、Issue、消息、可查询 MCP、Code Forge 和直接 Renderer Git/patch 入口尚未全部接入专用 Reconciler,补偿执行与 append-only evidence 也未完成。
- ✅ **32 并发压测:修复后 7/7 error=0**(连跑 3 次稳定)。根因=瞬时并发打爆 socket 层;修:并发闸门(默认 8 在途)+ 瞬时网络重试。压力脚本口径已修(idle/error 分统计、error=0 独立断言)
- **Claude 登录不是必需项**。Claude 不再是默认引擎；未配置 Claude 兼容凭据时状态为 `unknown/optional skip`，不会被任意 Provider key 误判为 ready。只有用户显式选择 Claude 专项时才需要 `ANTHROPIC_API_KEY`、兼容网关或有效 Claude 登录态。
- P1 全部可做项收口(2026-07-06):全文搜索、冲突三栏+合并回执、插件安装/卸载/版本/权限、CLI 真验
- Work OS 第一波已进入 main:A1 Drive、A2 Quickbar、A3 Desktop Control、A4 Code Forge、A5 Skill Fabric、A6 Memory Loop、A7 Control Center、A8 Personal OS、A9 Genesis(计划层)。Genesis 只宣称编排/交付计划,不宣称真实外部子 Agent 执行、自动合并、推送或发布。
- P2 本地 smoke 已刷新全绿;P2-005 IDE integrations 已由 `test:p2-ide-build-and-vscode:required`、`test:jetbrains-recorder-e2e:required`、`test:jetbrains-ide-interaction:required` 证明。最新 `npm run test:p2-audit` 报告中 P2-002/P2-003/P2-005 为 proved;`npm run test:p2-audit -- --required` 仍会失败,但失败范围只剩非本轮公开宣称的 P2-001 Windows GUI required evidence 与 P2-004 China external evidence。最新 release doctor 已把 `p2_required` 标记 ready,非阻塞开放项仍保留为 delegated/user-configured。提交/发布新增 `npm run secret:scan` / `npm run secret:scan:history` / `npm run test:github-release-audit` 门禁,用于阻止密钥、证书、签名材料、生成物和本地证据包进入公开仓库或公开 Release。
- GitHub Releases 公开资产审计已补齐:当前公开资产通过 `npm run test:github-release-audit`,未发现需删除的敏感资产;每次新发布后必须运行 `npm run test:github-release-audit:read-text:required -- --tag vX.Y.Z --expected-assets-from-dist`,同时核对实际 tag 的资产集合与本地 `dist` 完全一致,并读取 `latest*.yml` 等公开小文本元数据。
- v0.1.4 最终发布说明保存在 `docs/RELEASE-NOTES-FINAL.md`,滚动草稿保存在 `docs/RELEASE-NOTES-DRAFT.md`;最终正文必须在精确 release commit 的干净工作树上通过 `npm run test:release-notes-audit:final` 后才能发布。
- Packaging gate 已刷新:旧 `dist/` 历史包已归档到 `test-results/release-packaging-audit/archived-dist-*`,Electron 40 + `tree-sitter` 的原生模块构建阻塞已通过 `scripts/prepare-native-build.cjs` 修复;v0.1.4 候选范围固定为 macOS x64 DMG/zip、两个 blockmap 与 `latest-mac.yml`,由 `npm run dist:mac:x64` 生成。全部资产须在最终代码定稿后重建并重新审计。macOS 包仍未签名,Release notes 保留首次打开说明。
- 项目级规则口径更新:`caogen.md/.caogen.md/README.md` 会向 Claude/OpenAI 两类正式引擎注入项目身份与规则;未配置规则的新项目也会注入项目身份和缺失规则提示;设置页项目规则已提供结构化编辑器,可同步编辑项目提示词、背景、技术栈、常用命令、测试/构建命令、禁止目录、隔离策略、模型调度策略、项目记忆与历史决策;`caogen.md` 的模型调度策略会进入智能路由理由。由 `node scripts/context-loader-smoke.mjs`、`npm run test:project-rules-ui`、`node scripts/model-router-smoke.mjs` 覆盖;其中 context/model-router smoke 已验证不同项目的 prompt 与模型调度策略互不串用,同一请求会按各自项目规则路由到不同 Provider/模型;Electron 页面流 `npm run test:page` 也已验证当前项目规则可在设置页编辑并保存到项目 `caogen.md`,且不修改全局 `settings.json`(17/17,`test-results/caogen-deep/2026-07-10T12-48-21-376Z/page-operation-smoke.json`)。
- 多厂商配置口径更新:Provider 已支持多 API Key、活动 key 选择、行内连通性检测、模型列表同步和持久化健康状态;系统 `safeStorage` 可用时密钥加密落盘,但不可用时仍存在 `b64:` 可逆编码 fallback,这是未完成的 P0 安全问题,不能宣称所有环境均为加密持久化。会话启动、模型拉取、OpenAI/SDK Agent/DAG 路径统一经主进程活动 key helper 取密钥。活动 key 遇到鉴权、403、限流或余额/配额错误时,会先切到同 Provider 内未禁用、未处于 5 分钟失败冷却且本轮未尝试的备用 key;OpenAI 请求直接重试,SDK Agent 重建子进程并 resume 当前上下文;备用 key 池耗尽后才进入原有跨 Provider failover。聊天与 3D 办公只显示用户自定义 key 标签和失败分类,不暴露 token。`npm run test:provider-key-failover` 验证轮换策略、冷却、防打转和 Renderer 边界;`node scripts/openai-mock-e2e.mjs` 已用真实 Electron UI 验证“主 key 401 → 备用 key 成功 → 活动 key/失败元数据持久化”(`test-results/openai-mock-e2e/2026-07-10T07-27-01-023Z/openai-mock-e2e.json`)。当前不宣称主动额度探测、按 key 权重负载均衡或所有外部协议变体已验证。
- 产品定位门禁新增: `npm run test:product-positioning:required` 会扫描 README、欢迎页入口文案、Release notes、Release gate 和公开品牌入口,防止公开文案重新出现固定未来版本目标、外部产品名称/对比话术、开发者-only 定位、未验证的中转站/Office 版式过度宣称,以及旧的菱形占位 logo。最新通过报告见 `test-results/product-positioning-audit/latest.json`;v0.1.4 release doctor 现在强制绑定版本、当前 commit 与干净工作树,必须在候选提交后重新生成并达到 `status: ready`。
- 自动调度口径更新:设置页已支持按顺序执行的用户自定义调度规则,可组合关键词任一/全部、请求推断任务类型、最低风险和当前有效策略,命中后优先路由到指定 Provider/模型;未配置的条件不限制,条件组之间取 AND,任务类型组内取 OR。旧关键词规则无需迁移;规则目标仍受硬预算和 Provider 健康约束。项目级模型调度策略可覆盖默认角色偏好且保持项目隔离,OpenAI 引擎自动路由也已纳入月度剩余预算。智能路由现读取持久化 Provider 健康状态:存在健康候选时会跳过连续失败 Provider;若全部候选均不健康则继续给出可执行候选,同时把警告写入调度日志,避免静默停摆。每次路由会生成结构化决策日志,保留厂商、模型、有效策略、任务类型、风险、候选数、可靠性、成本估算、剩余预算、规则命中、预算降级、跨厂商状态、健康过滤、靠前备选和警告;渲染层不再丢失 `providerId`,聊天消息可展开查看详情,3D 办公选中 Agent 面板同步显示真实厂商/模型与选择依据。控制中心现接入共享预算报告:活跃会话与当月历史按 `id/sdkSessionId` 去重,显示月度已用/剩余/进度、活跃与历史成本、Provider 成本聚合和最高成本会话;活跃会话预算按“会话显式上限 > Provider 单会话上限 > 全局单会话上限”生效,月度或任一活跃会话超额都会进入告警状态。历史记录未保存当时的显式会话预算,因此不会伪造历史预算比例。Electron 页面流已验证用户可在设置页启用智能混合调度,配置模型角色,新增结构化“发布审查”规则并把关键词关系、成本策略、高风险门槛和审查任务类型保存到 `settings.json`(17/17,`test-results/caogen-deep/2026-07-10T12-48-21-376Z/page-operation-smoke.json`)。`npm run test:failover-target` 已验证主 Provider 失败后优先命中配置的备用 Provider/模型、不健康备用目标会被跳过、仅配置备用模型时能找到声明该模型的 Provider、OpenAI 与 SDK AgentSession 两条 failover 路径都会更新固定模型,并且 UI 会显示可读的切换原因与重试目标(最新报告 `test-results/failover-target/latest.json`)。由 `npm run test:model-router`、`npm run test:routing-visibility`、`npm run test:provider-health-history`、`npm run test:budget-report`、`node scripts/control-center-smoke.mjs`、`npm run test:failover-target`、`npm run typecheck`、`npm run build`、主集成 33/33 与扩展集成 7/7 覆盖;预算报告见 `test-results/budget-report/latest.json`。当前不宣称自然语言策略编排器、按 key 额度调度、跨月精确成本账本或长期趋势分析。
- 自动调度第五阶段最新闭环:均衡、成本优先、质量优先和速度优先已成为四个独立策略;速度优先先按延迟档排序,同档再参考历史延迟 EMA,专项测试证明它与质量优先会对同一复杂任务选择不同模型。策略优先级为“项目规则 > Core 用户策略 > 专用工作模式预设”;项目 `caogen.md` 的“速度优先”不会再折叠为均衡,Core 不再覆盖用户策略,专用模式仍保留自己的预设。设置页已真实保存 `schedulerStrategy: speed` 和自定义规则 `whenStrategy: speed`;聊天详情、控制中心和 3D 办公选中 Agent 面板均显示有效策略及延迟依据。当前完整深测口径为 `87 total / 84 required pass / 3 optional skip`。当前仍不宣称自然语言策略编排器、按 key 额度调度、跨月精确成本账本或长期趋势分析。
- macOS 顶部菜单栏图标已与 Dock/应用图标分离:菜单栏使用 18×18 / 36×36 Retina 的透明单色 `trayTemplate` 轮廓并启用 Electron Template 模式,可随 macOS 深浅色菜单栏自动着色;Dock、窗口、应用内品牌与安装包继续使用正式全彩人物 Logo。`npm run test:macos-tray-icon` 已验证 PNG 尺寸/透明通道、打包资源声明、Electron `nativeImage` 加载、Template 标志和真实 Tray bounds(`test-results/macos-tray-icon/latest.json`)。
- 文件预览口径更新:HTML/Markdown/Text/CSV/JSON/图片/PDF 已有真实预览;PDF 已接入文本层 best-effort 提取并可发给 Agent;`.docx/.xlsx/.pptx` 已接入 OOXML 文本与结构提取。macOS 通过独立 Quick Look IPC 生成完整系统文档预览包,HTML/CSS/JS/图片附件全部内联,CSP 禁止网络,renderer iframe 仅开放 sandbox 脚本;完整预览失败时回退首屏 PNG,再失败则保留结构视图。结构视图已支持 Word 显式分页、Excel 工作表和 PowerPoint 幻灯片的上一项/下一项/选择器导航,可把当前页/表单独发给 Agent,批注会保存页码、摘录和结构选择器。`npm run test:office-visual-preview` 已用真实 DOCX 验证 625×980 系统文档预览、缓存、路径边界和附件/外链封锁(`test-results/office-visual-preview/latest.json`);`npm run test:page` 已验证完整 iframe、结构导航、当前单元发送和定位批注(17/17,`test-results/caogen-deep/2026-07-10T12-48-21-376Z/page-operation-smoke.json`)。发送给 Agent 的仍只有提取文本、元数据和批注,视觉 data URL 不会进入提示词。系统渲染可能与原应用中的完整原版式存在差异;编辑、复杂公式、动画和像素级一致性仍未完成,不得宣称。
- 3D 办公口径更新:Office model 已从真实 `SessionState` 派生路由决策、Provider/密钥故障切换、预算/成本、最近耗时、审批、工具、子任务、worktree 隔离/分支/状态与 checkpoint 文件变化;同 Provider 密钥接管会进入选中 Agent 信号栈并点亮工位故障恢复指示,只显示 key 标签。OfficeView 打开时会对可见会话按需刷新 `git status`,并把分支、dirty 文件数、staged/unstaged/untracked、错误状态汇入顶部指标、选中 Agent 面板和工位低位 3D 指示条。设施区离席 Agent 已增加透明射线命中体,改善镜头过渡时的点击容错;真实 Electron 编排 E2E 连续 3 次通过,完整 `test:deep` 也覆盖工位、审批 Agent、设施 Agent 与会话打开链路。由 `npm run test:office-status-recheck`、`npm run test:provider-key-failover` 覆盖;Electron 页面流 `npm run test:page` 也已验证真实会话/worktree/Git 状态、可点击工位和非空 3D canvas。当前不宣称全量实时 git diff 轮询、完整项目交付驾驶舱、长期趋势图或可替代发布管理系统。
- 五支柱当前判断:多厂商、调度和 3D 已形成可用优势;迁移级工作流与长期自主执行仍受真人 N1、跨 Provider 账本、后台持续运行和交付证据约束。当前没有统一评分工件,不再给出百分比。
- 用户实测反馈已修 4 项(冗余"你"标注、矛盾错误文案、引擎×Provider 404、填 key 不生效)

# Current Focus

**Trust Kernel 继续收口 + 滚动发布门禁**:Docker 产品模式、Claude 默认依赖、Deep 四态误计数和本地执行迁移旁路已完成收口。下一顺序是 PR/Issue/消息/可查询 MCP/Code Forge/Renderer 入口 → append-only evidence/compensation → GUI/工具审批作用域 → Base64 fallback 与 scoped credential broker → MCP/插件 Capability Manifest。发布侧仍不绑定固定未来版本号；真实 China network/tool-call parity 由用户配置，N1 真人 30 分钟记录只阻塞 N1 达标宣称。

# Goal

**北极星 N1**:真实重度 AI 工作者 **30 分钟内**跑通日常主链路(导入资产→建会话→@文件/资料→执行任务→审结果→提交/交付),资产零丢失。以五支柱代差做成"世界第一 / 中国首创"验收方向的多厂商 AI 工作桌面。

# Next Milestone

**下一次滚动发布 "可日用"** — Definition of Done:

1. 规划方连续 7 天日常使用,新毛刺 ≤1/天且当天修复
2. ~~arm64 原生包发布~~ ✅ 2026-07-06(架构三重验证;M 系真机启动复验待用户)
3. 默认 OpenAI-compatible 路径无需 Claude 登录；Claude 仅作为用户显式选择的可选专项验证
4. N1 秒表实测 ≤30 分钟(真人,录屏留证)——北极星证据;无 N1 宣称的发布不以此为阻塞,未验证前不宣称通过
5. `test:deep` 保持 `87 total / 84 required pass / 3 optional skip / 0 blocked / 0 fail`;required 不得以 skip/blocked 通过

# Priority Tasks

**P0**
- 用户反馈快修循环(常设)
- ~~arm64 / universal 打包~~ ✅ 已发布至 v0.1.1
- P0-1B:~~接入 `search_replace`、OpenAI `edit_file` 与 Claude `Edit` 的 queryable file Effect~~ ✅;继续接入 PR/Issue/消息/可查询 MCP、Code Forge 与直接 Renderer Git/patch 入口
- P0-1C:建立独立 append-only evidence 链、审计关联与生产补偿计划/审批/执行
- P0-2A:把 GUI/工具临时授权绑定 app/window/action/path/diff/postcondition,统一设置页与运行时的实际沙箱状态
- ~~P0-4A:把深测改为 `pass / skip / blocked / fail` 四态,required 项不得以 skip 通过~~ ✅
- P0-2:移除 `b64:` 密钥 fallback,完成 scoped credential broker 与数据保留/导出/删除策略
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
- N1 迁移实测:向导映射✅、演练 fixture+计时脚本✅(docs/N1-MIGRATION-DRILL.md);真人 30 分钟计时仍未做,未验证前不做 N1 达标宣称

**Work OS Phase 2 并行任务**(2026-07-08 新排期)
- B0 Release Gate:保持 README/STATUS/release notes 与真实 gate 一致,审计公开 GitHub Release 资产,最后合并;草稿门禁见 `docs/RELEASE-GATE-DRAFT.md`
- B1 Windows GUI Required:P2-001 strict VS Code GUI/cross-app/input evidence,由专门 Windows agent 后续补
- B2 IDE Build + VS Code Host:✅ P2-005 插件构建、VS Code extension host evidence 已通过
- B3 JetBrains Real IDE:✅ P2-005 JetBrains runIde recorder + interaction evidence 已通过
- B4 China External Evidence:P2-004 真实网络与 tool-call parity evidence,由用户按需配置

# Blockers

**本地发布门禁与外部条件:**

| 阻碍 | 等级 | 状态 |
|---|---|---|
| ~~32 并发压测 5/6~~ | High | ✅ 已修:并发闸门(8 在途)+ 瞬时重试;连跑 3 次 7/7 error=0 |
| ~~最新 dist:mac 卡 Electron 下载~~ | Medium | ✅ 已修:.npmrc 配 npmmirror;双架构 DMG 完整产出 |
| ~~Claude auth 误判~~ | High | ✅ 已修:auth 检测只认真实凭据;无凭据干净跳过/明确提示 |
| ~~窄屏响应式布局未过人眼复核~~ | Medium | ✅ 已修:Electron 原生窗口 390/540px 侧栏抽屉、标题、controls、composer、overflow 全 PASS;证据:`test-results/caogen-responsive/2026-07-06T17-46-27-342Z/responsive-qa.json` |
| arm64 包真机启动 | — | 需真实 Apple Silicon 机器(Intel 不可替代) |
| Docker | — | 不需要；产品运行模式、资源和分支已删除 |
| Claude 登录 | — | 不需要；只影响用户显式选择的 Claude 专项 |

**需用户的外部阻塞:**

| 阻碍 | 等什么 |
|---|---|
| Apple Developer / 签名材料 | 仅签名、公证和正式分发需要；必须由账号持有人提供或操作 |
| Apple Silicon 真机 | 只有要宣称 arm64 真机启动时需要；Intel 机器不能替代 |
| 指定 Provider key / 额度 | 只有要补对应真实 Provider 或中国网络证据时需要 |
| 凭据轮换 | 曾暴露或疑似外发的 token 必须由凭据持有人在对应平台撤销/重建 |
| N1 30 分钟计时 | 只阻塞 N1 达标宣称；需真人按秒表跑并留证 |
| push / GitHub Release | 当前只完成本地 `main`；推送和发布必须获得用户最终授权 |

# Decisions

不会改变的原则:

1. **实测才算完成**:每个特性配真实 E2E(真进程/真 IPC/真模型调用),"编译过"不算数;状态如实标注,不虚标
2. **六环链路**:新能力必须主进程 → IPC → preload → types → store → UI 全通才算接通
3. **不搬同类工具代码**:只借鉴信息架构与交互,纯自实现
4. **安全边界**:密钥不得以明文或可逆编码持久化且不出主进程(`b64:` fallback 未移除前属于 P0 缺口);文件工具路径牢笼;权限审批不可绕过(bypass 需显式选择);发布物不含任何凭据
5. **中英双语**:所有 UI 文案 zh/en 齐备,zh 为母语级
6. **每任务独立提交**,提交信息写"做了什么 + 怎么验证"
7. **诚实降级**:能力不可用时如实报告(如 OCR 无引擎、PR 无 gh/glab),绝不伪造结果

# Out of Scope

当前滚动发布周期明确不做:

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

# Success Criteria

- **下一次发布验收** = Release Gate Draft 中的阻塞项全部成立;P2-001/P2-004/N1 按当前边界不阻塞,但不得过度宣称
- **长期成功** = 北极星 N1 由**非项目相关**的真实同类工具深度用户验证通过(30 分钟计时 + 资产零丢失 + 关键动作无需回退原工具)
