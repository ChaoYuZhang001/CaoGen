# CaoGen 竞品差距与优化优先级

> 快照日期: 2026-07-11
> CaoGen 代码基线: `main@6ab58bf2e718`
> 对标范围: Codex Desktop、Claude Desktop / Claude Code、OpenClaw、Hermes Agent
> 结论口径: 竞品事实只采用官方文档、官方仓库或当前 Codex Desktop 可调用能力; CaoGen 事实只采用当前代码和测试产物。

## 结论

CaoGen 当前的主要问题不是功能少，而是已有能力还没有形成与功能规模匹配的信任平面。

CaoGen 已经具备真实差异化:

- 多 Provider、多 API Key、健康度、预算、路由解释和跨厂商故障切换。
- 真实 child session、DAG、worktree 隔离、自动合并和恢复快照。
- Git、Diff、终端、文件、浏览器、Office 预览和 3D 办公状态统一在一个桌面工作台。
- 任务事件身份、恢复游标、SQLite 快照和强杀恢复已经明显强于普通聊天桌面壳。

但以下五项会直接阻止 CaoGen 成为可信赖的长期 Agent Desktop:

1. Effect Ledger 核心已经落地，但自动 Reconciler 只覆盖 `write_file`、`git_commit`、`git_push`；PR、Issue、消息、可查询 MCP、直接 Renderer Git 入口、补偿执行和防篡改 evidence 链仍未闭环。
2. 审计日志已改为 metadata/hash 并限制文件权限，权限卡也会完整展示脱敏输入；但 `safeStorage` 不可用时 API Key 仍会退化为可逆 Base64，scoped credential broker 和数据保留/删除策略尚未建立。
3. MCP 子进程继承完整环境变量，内置模板使用未锁版本的 `npx -y`，插件安装缺少来源、哈希、签名、能力清单和运行时隔离。
4. 本地深测仍把退出码为 0 的 `SKIP` 计为 `pass`；仓库没有托管 CI，macOS 包未签名，也没有 SBOM、provenance、安装升级验证和失败回滚证据。
5. OpenAI Responses 的 `lastResponseId` 只在内存中，重启、换 Provider 或换 Key 会丢失服务端上下文链，尚无 Provider 无关的会话账本。

因此下一阶段不应继续追求更多可见功能。正确顺序是:

```text
扩展 Effect Reconciler / evidence / compensation
  -> 修正测试四态与 required gate
  -> 凭据与审计安全
  -> 插件/MCP 供应链
  -> 托管 CI、签名、SBOM 与回滚
  -> Provider 无关上下文耐久性
  -> Genesis 执行化与远程长期任务
```

总体判断信心: 高。竞品快速变化或官方材料内部冲突的地方已单独标注。

## 继续优化问题清单

| 优先级 | 问题 | 当前状态 | 下一纵切 | 完成判据 |
|---|---|---|---|---|
| P0-1B | Reconciler 覆盖不足 | 文件写入、Git commit/push 已自动回读；其他副作用仍 opaque fail-closed | 接入 PR、Issue、消息、可查询 MCP、merge/Code Forge 和直接 Renderer Git 入口 | 所有高风险入口统一经过 Effect Runtime；外部成功后强杀不会重复执行 |
| P0-1C | Evidence 与补偿不完整 | 有 generation/revision、resource lease/fencing 和 evidence digest；没有 append-only 哈希链及生产补偿器 | 独立 Effect 存储、审计关联、补偿计划/审批/执行 | 每次确认、重试、补偿均可追溯；篡改可检测；补偿失败仍 fail closed |
| P0-4A | 测试结果语义失真 | 外层 84 项显示 pass，但 Claude/China 三项实际 `SKIP` | 建立 `pass / skip / blocked / fail` 四态和发布档位 required checks | `SKIP` 不计入 pass；required 项 skip/blocked 必须阻断发布 |
| P0-2 | 凭据与本地数据安全 | 审计脱敏第一纵切完成；Base64 fallback、凭据代理和保留策略未完成 | safeStorage fail-closed、旧密钥迁移、scoped broker、导出/删除/保留周期 | 不再新增可逆编码密钥；插件/MCP 只能取得声明范围内的凭据 |
| P0-3 | MCP/插件供应链 | 已能安装和调用，但缺 provenance、digest、能力约束和隔离 | Capability Manifest、固定版本/digest、最小环境、权限 diff | 恶意 fixture 不能读取无关环境、文件或凭据；内容变化必须重新批准 |
| P0-4B | 发布可信度不足 | 有本地审计和双架构包；无 hosted CI、签名、SBOM/provenance、升级回滚证据 | 跨平台 CI、签名公证、制品证明和干净机安装/升级/回滚 | 每个制品绑定源码 SHA、哈希、签名、SBOM、provenance 和回滚版本 |
| P0-5 | Provider 无关会话账本缺失 | 三套会话/checkpoint 语义仍分裂 | Canonical Conversation Ledger 和跨 Provider resume | 重启/换 Provider 后工具配对、附件、checkpoint 和已确认效果连续 |
| P1-9 | 架构热点持续膨胀 | `store.ts`、`sessionManager.ts`、`ipc.ts`、shared types 超阈值 | 按 IPC domain、renderer slice、session service 和跨进程 contract 拆分 | strict standards audit 通过；新功能不再进入聚合热点 |
| P1-2/3 | Agent 生命周期与 Supervisor 不统一 | child、DAG、Routine、恢复各自可用但生命周期分散 | 四类 Agent 原语 + 本地/远程 Supervisor | 长任务跨 Desktop 重启继续，状态、预算、审批和交付无缺口 |
| P2-6 | 缺真实用户迁移证据 | N1 fixture/脚本已准备，尚无非项目用户 30 分钟实测 | 真人计时、录屏、失败点和回退次数记录 | 30 分钟主链路、资产零丢失，关键动作无需回退原工具 |

## 产品类别校正

这四个产品不能只按“有没有某个按钮”比较。

| 产品 | 实际产品形态 | 最值得对标的部分 | 不能直接类比的部分 |
|---|---|---|---|
| Codex Desktop | 软件工程 Agent Desktop，连接本地、worktree 和托管任务能力 | 多 Agent、线程/目标持久化、浏览器/Computer Use、插件与连接器、审批治理 | OpenAI 官方手册本次抓取被 403 阻断；部分结论来自同日官方源码和当前安装环境，不能外推到所有账号 |
| Claude Desktop / Code | `Chat + Cowork + Code` 桌面工作面，Code 另含本地/云端/SSH、worktree、PR/CI | MCPB、权限与 OS 沙箱、Subagent/Agent View、Checkpoint、桌面 PR 生命周期 | Agent Teams 仍是实验能力；Computer Use 仍是受限研究预览 |
| OpenClaw | 本地常驻 Gateway + Agent runtime + 多渠道/多设备，Desktop 是控制和设备伴侣层 | Task Flow、长期自动化、Gateway/UI 解耦、插件供应链、跨平台发布 | 不是纯软件工程 Desktop；默认 sandbox 为 off，不支持敌对多租户 |
| Hermes Agent | 开源单租户 Agent 平台，含 Electron Desktop、TUI、Web、Gateway、Cron、Kanban | SQLite durable Kanban、工具搜索、Skills/MCP、远程 backend、Agent 运维面 | Kanban 明确是单机；默认本地 backend 和进程内插件不是强隔离 |
| CaoGen | 多厂商 AI 工作桌面，面向工程、文件、浏览器、Office、自动化和多 Agent | Provider 开放性、路由与成本透明、工作台统一、3D 状态可视化 | 安全、供应链、持续交付和长期任务证据尚未达到功能广度 |

## 当前能力矩阵

| 维度 | CaoGen 当前状态 | 竞品基线 | 判断 |
|---|---|---|---|
| Agent 执行内核 | Claude Agent SDK + OpenAI-compatible API；Effect Ledger、资源级 lease/fencing、强杀恢复和三类 Reconciler 已接 | Codex/Claude 有成熟线程与后台会话；OpenClaw Task Flow、Hermes Kanban 有持久状态机 | 内部恢复和有限外部对账较强；仍缺完整副作用覆盖、补偿和统一 Supervisor |
| 多 Agent | 33 child sessions、DAG、worktree、结果回传、自动合并 | Codex multi-agent 已标 stable；Claude 有 Subagent/Agent View/实验 Teams；OpenClaw/Hermes 有隔离 Agent | 强项；下一步应区分临时子任务、持久会话、Team 和确定性 Workflow |
| Provider 开放性 | 多厂商、多 Key、健康度、预算、跨厂商 failover | 竞品通常围绕自家模型或单一 Gateway | CaoGen 领先，但上下文和成本账本仍不够耐久 |
| 权限治理 | 风险分类、审批模式、资源级副作用门禁、文件边界、GUI 权限检查、审计 metadata/hash 和权限输入脱敏已接 | Claude 有宿主权限 + OS sandbox；Codex 有 sandbox/approval/Guardian；OpenClaw/Hermes 提供策略但默认姿态不总是安全 | 中等；缺凭证代理、统一保留策略和更强 OS 隔离 |
| MCP / 插件 / Skills | 扫描、启停、安装、调用、Slash 入口已接 | 竞品已进入 manifest、精确版本、来源、digest、权限预览、组织策略和市场治理 | 明显落后在供应链信任，不是落后在“能不能装” |
| 记忆与自动化 | 分层记忆、建议、Routine scheduler、run history 已接 | OpenClaw/Hermes 长期自动化更完整；Codex/Claude 有后台/计划任务 | 功能可用，但生命周期分散，关闭桌面后的远程续跑未闭环 |
| 桌面工作台 | Git、Diff、终端、文件、浏览器、Office、3D、控制中心 | Codex/Claude/Hermes 的 Agent 树、Artifacts、PR/CI 状态更一体化 | CaoGen 表面广度强，交付控制面仍弱 |
| 恢复与 Checkpoint | 事件回执、游标、快照、文件/聊天回退、worktree | Claude 自动 checkpoint；Hermes shadow-git；OpenClaw/Hermes durable task | 内部恢复强；外部系统和跨 Provider 恢复弱 |
| 可观测性 | 路由、Provider/Key、成本、预算、工具、审批、worktree、3D 状态 | OpenClaw audit、Hermes Command Center、Codex/Claude 任务/Agent 面板 | CaoGen 强项；应把可观测数据升级为可执行控制面 |
| 持续交付 | 本地测试和发布审计脚本很多 | OpenClaw 有跨 OS、安装/升级、签名、公证、SBOM/provenance；Hermes 有较强 CI 和 Sigstore 发布 | CaoGen 明显落后，当前是最高风险之一 |
| 工程可维护性 | 核心热点文件继续膨胀 | 成熟项目通常按协议、状态、平台和 UI 边界拆分 | 已成为安全审计和交付速度阻碍 |

## CaoGen 已验证事实

以下是当前可依赖的实现，不应在后续重构中回退:

- `src/main/engine.ts` 和 `src/main/engines.ts` 已固定两条正式运行时路径。Codex CLI / Gemini CLI Adapter 已移除，不再作为未来方向。
- `src/main/task/task-recovery.ts`、`src/main/task/task-snapshot.ts` 和 `src/main/task/task-runtime-registry.ts` 已形成事件回执、恢复游标、快照和幂等防重底座。
- `src/main/task/effect-ledger.ts`、`effect-runtime.ts` 和 `effect-reconciler.ts` 已形成持久 EffectRecord、资源级 lease/fencing、字段级并发合并、自动/人工对账和 fail-closed 恢复底座。
- `write_file`、`git_commit`、`git_push` 已有只读 Reconciler；Git 远端探针隔离仓库/global 配置、credential helper 和 askpass，确定性 preflight 失败不会生成未知结果。
- `src/main/sessionManager.ts` 与 `src/main/agent/dag-scheduler.ts` 已支持真实 child session、DAG 和 worktree 编排。
- `src/main/providers.ts`、`src/main/providerKeyRouting.ts` 和 `src/main/model/session-routing.ts` 已支持 Provider/Key 选择、健康、预算和故障切换。
- `src/main/permission/tool-permission.ts`、`src/main/permission/audit-log.ts` 和沙箱相关模块已形成权限治理基础；审计输入默认保存 metadata/hash，权限卡展示完整但递归脱敏的审批输入。
- `src/main/skill`、`src/main/mcp`、`src/main/pluginInstall.ts` 已形成扩展生态底座。
- `src/renderer/src/components/office` 已消费真实会话、审批、工具、路由、成本、worktree 和 checkpoint 状态。
- 完整深测外层记录为 84/84（`test-results/caogen-deep/2026-07-10T19-26-04-373Z/deep-test-report.md`），但 `claude real e2e`、China real-network 和 China tool-call parity 的日志实际为 `SKIP`，不能算真实外部环境通过。

## P0: 必须先解决

### P0-1 外部副作用对账内核（核心 MVP 已完成，Epic 部分完成）

已完成:

- 持久 `EffectRecord` 已包含 `effectKey`、独立 `resourceKey`、generation/revision、lease、fencing token、状态、目标摘要和 evidence digest。
- SQLite barrier 会跨会话阻止同一资源的并发 lease，并持久化每个资源的最大 fencing token。
- `write_file`、`git_commit`、`git_push` 已支持只读回读；不可查询操作在结果未知时 fail closed 并进入人工 CAS 处置。
- OpenAI-compatible 与 Claude SDK 两条正式工具执行路径均接入 prepare → persist barrier → execute → reconcile。
- 强杀、关闭、中断、普通事件与 Effect 并发写、目标漂移和空 staged commit 已有回归测试。
- UI 会显示 `waiting_reconciliation`，阻止自动恢复、继续发送和删除恢复入口。

继续问题:

- `git_create_pr`、Issue、消息、可查询 MCP、`edit_file/search_replace`、merge/Code Forge 和 Renderer 直接 Git 入口尚无专用 Reconciler 或未统一经过 Effect Runtime。
- `markEffectCompensated` 只有账本状态能力，没有生产级补偿计划、审批和执行器。
- evidence digest 尚未形成 append-only 哈希链、独立 Effect 表或审计事件关联，不能宣称防篡改不可变账本。
- 真实强杀 E2E 主要证明文件写入；Git commit/push、PR 和消息的“外部成功后强杀”仍需独立系统测试。

竞品信号:

- OpenClaw Task Flow 和 Hermes Kanban 都有 revision、重试、heartbeat 和 durable event，但官方材料同样没有证明它们能通用处理外部 `unknown_outcome`。
- Claude checkpoint 明确不覆盖 Bash、外部系统和并发会话。

这不是追平项，而是 CaoGen 可以建立领先优势的内核项。

下一纵切要求:

- 把所有高风险入口统一接入 Effect Runtime，先完成 PR、Issue、消息、可查询 MCP、merge/Code Forge 和直接 Git 操作。
- 建立独立 Effect 持久表、append-only evidence 链和审计事件 ID，避免 evidence 只存在 TaskRun JSON 中。
- 定义补偿动作的生成、审批、执行、失败恢复和二次补偿边界。
- 对每类可查询副作用补真实强杀 E2E；无外部回读能力的操作继续禁止自动重试。

验收标准:

- 在外部成功、内部 `tool-result` 落盘前强杀进程，重启后能自动确认成功且不重复执行。
- 同一 `resourceKey` 同时只能有一个有效 lease，跨进程 fencing token 单调递增。
- 每次确认、重试、补偿都有可验证的 append-only evidence 和审计关联。
- UI 明确展示 `waiting_reconciliation`，不能把它渲染成失败或成功。

建议验证:

```bash
npm run test:task-run
node scripts/effect-reconciliation-smoke.mjs
node scripts/effect-crash-recovery-e2e.mjs
node scripts/effect-close-race-smoke.mjs
```

Owner: Runtime / Task Kernel。

### P0-2 凭据、审计与本地数据安全

当前问题:

- `src/main/providers.ts` 在 `safeStorage` 不可用时写入 `b64:`，这是编码，不是加密。
- 审计日志已经停止保存 command/content/JSON 原文，改为 metadata、长度和 SHA-256；权限卡也会完整展示但递归脱敏输入。该纵切仍未覆盖所有日志、转录、插件和 MCP 数据出口。
- `providers.json`、会话转录、记忆、Routine、审计和插件配置缺少统一的保留、权限和加密策略。

实现要求:

- `safeStorage` 不可用时禁止持久化新密钥；提供仅本次会话使用或引导修复系统安全存储。
- 迁移并删除现有 `b64:` 密钥，迁移失败时要求用户重新输入。
- 把现有审计 metadata/hash 规则抽成统一数据分类与递归脱敏组件，覆盖日志、转录、插件、MCP 和错误回传。
- MCP/工具凭据通过 scoped broker 注入，避免把主进程完整环境传给子进程。
- 为会话、记忆、Routine 和审计定义保留周期、导出和删除策略。

验收标准:

- 全仓和运行产物中不存在可逆编码密钥。
- 包含 `Authorization`、API Key、JWT、cookie、密码和私钥片段的输入不会出现在审计日志。
- 渲染层、插件和 MCP 只能获得声明过的凭据范围。
- 权限不足或安全存储不可用时 fail closed，并给出可恢复提示。

建议验证:

```bash
npm run secret:scan
npm run secret:scan:history
node scripts/credential-storage-smoke.mjs
node scripts/audit-redaction-smoke.mjs
```

Owner: Security / Runtime。

### P0-3 MCP、插件与 Skill 供应链

当前问题:

- `src/main/mcp/mcp-client.ts` 的 stdio 子进程继承完整 `process.env`。
- 内置 MCP 模板使用未锁版本的 `npx -y`。
- `src/main/pluginInstall.ts` 只检查目录形状、大小和路径，没有来源、digest、签名、依赖、能力或兼容性验证。
- 插件、Skill、MCP 和 Hooks 尚未形成一致的信任模型。

竞品基线:

- Claude MCPB 显示权限和配置，敏感值进入系统凭据存储；组织策略可按精确 URL 或完整命令 allow/deny。
- Codex 官方 app-server 对 Hook 记录 `currentHash` 和 `trustStatus`，只有受信任的非托管 Hook 才能运行。
- OpenClaw 使用 manifest、JSON Schema、capability contracts、版本和 digest；Hermes 支持 MCP 白/黑名单、OAuth、mTLS 和动态能力刷新。

实现要求:

- 统一 `CapabilityManifest`: 文件、进程、网络域、凭据、MCP 工具、Hook 事件、GUI 和数据保留范围。
- 本地包记录来源、精确版本、content digest、许可证、SBOM 和兼容版本。
- 远程目录与本地侧载分轨；默认禁止未知侧载，更新前展示权限 diff。
- MCP 使用最小环境变量、独立工作目录、网络 allowlist 和进程/容器隔离。
- 不允许 `npx -y package` 无版本运行；首次安装和升级必须固定版本及 digest。

验收标准:

- 未声明能力的插件/MCP 访问文件、网络或凭据会被阻止。
- 包内容或 manifest 改变后信任状态失效，必须重新批准。
- 安装、升级、禁用和卸载均留下来源和哈希可审计记录。
- 恶意插件 fixture 不能读取无关环境变量或越过工作区。

建议验证:

```bash
node scripts/plugin-provenance-smoke.mjs
node scripts/mcp-env-isolation-smoke.mjs
node scripts/plugin-capability-sandbox-e2e.mjs
```

Owner: Security / Ecosystem。

### P0-4 真实测试状态与持续交付

当前问题:

- `scripts/deep-test.mjs` 只根据退出码判断 `pass/fail`，所以返回 0 的 `SKIP` 会显示成 `pass`。
- 当前没有 `.github/workflows` 托管门禁。
- `package.json` 的 macOS `identity` 为 `null`。
- 没有统一的安装、升级、回滚、SBOM、provenance、attestation 和发布后启动验证。

竞品基线:

- OpenClaw 官方 CI 覆盖跨 OS、安装包验收、升级存活、签名、公证、校验和以及 Docker SBOM/provenance/attestation。
- Hermes 有分区测试、Desktop build、Docker 多架构、OSV、供应链扫描和 OIDC + Sigstore 发布，但其 Desktop 打包矩阵仍不完整。
- Claude 有 GitHub Action、托管 Code Review 和桌面 PR/CI 流程，但托管 Review 仍是 best-effort。

实现要求:

- 测试协议改为 `pass / skip / blocked / fail` 四态，并声明每个发布档位的 required checks。
- 新增 Linux/Windows/macOS CI，缓存不能改变测试语义。
- macOS 签名、公证，Windows 签名；生成 SPDX/CycloneDX SBOM 和构建 provenance。
- 对全新安装、旧版升级、失败回滚、自动更新源和包内架构做真实验证。
- 发布必须绑定源码 SHA、依赖锁、测试报告、签名、制品哈希和回滚版本。

验收标准:

- `SKIP` 不再出现在 pass 计数中；required check 为 skip/blocked 时发布必须失败。
- PR 和 main 都执行最小确定性门禁；release tag 执行完整跨平台门禁。
- 已签名安装包可在干净机器安装、启动、升级和回滚。
- 每个公开制品有 SHA256、SBOM、provenance 和签名验证记录。

建议验证:

```bash
npm run test:deep
npm run test:release-packaging-audit:required
npm run test:github-release-audit:required
npm run workos:release-doctor -- --refresh
```

Owner: Platform / Release。

### P0-5 Provider 无关的会话与 Checkpoint 账本

当前问题:

- `src/main/openaiEngine.ts` 的 `lastResponseId` 只在内存中。
- 跨 Provider 或跨 Key failover 会清空 response id，然后重新发本轮请求。
- Responses 服务端状态、Chat 本地历史和 Claude SDK session/checkpoint 仍是三套语义。

实现要求:

- 建立 Canonical Conversation Ledger，持久化 user/assistant/tool-call/tool-result、附件引用、模型路由、checkpoint 和上下文压缩边界。
- Provider 的 response/session id 只是可丢失优化，不能成为唯一上下文来源。
- 重启、跨 Provider 和跨协议时从 Canonical Ledger 重建合法输入，保持 tool-call 配对和附件引用。
- Checkpoint 必须同时说明代码、对话、外部效果和 worktree 的恢复范围。

验收标准:

- Responses 会话在进程重启后继续，不丢已确认工具结果。
- 从 OpenAI-compatible Provider 切换到另一 Provider 后，任务语义和工具状态连续。
- 回退前 UI 显示将恢复/保留/无法撤销的范围。
- Canonical Ledger 可重放生成确定性的上下文摘要和验证证据。

建议验证:

```bash
node scripts/conversation-ledger-smoke.mjs
node scripts/provider-cross-resume-e2e.mjs
node scripts/checkpoint-effect-boundary-smoke.mjs
```

Owner: Runtime / Session。

## P1: P0 稳定后推进

| ID | 问题 | 优化方向 | 验收标准 | Owner |
|---|---|---|---|---|
| P1-1 | Genesis 仍只生成计划 | 把 Genesis 升级为权限门控的执行协议，复用 DAG、worktree、预算、验证和 Code Forge | 每个 lane 有 owner、lease、权限、预算、验证和交付状态；高风险点必须确认 | Orchestration |
| P1-2 | Agent 原语过于统一 | 明确定义 `Subtask / Durable Session / Team / Deterministic Workflow` 四类生命周期 | UI、恢复、消息、预算和隔离规则不再依赖隐含约定 | Runtime |
| P1-3 | Routine、后台任务和任务恢复分散 | 建立统一 Supervisor，支持本地常驻、远程 runner、断线重连和关闭桌面后续跑 | 同一任务可跨 Desktop 重启或远程 worker 继续，状态无缺口 | Runtime / Cloud |
| P1-4 | Project 数据分散 | 统一代码、知识、记忆、任务、连接器、Artifact、预算和审计的 Project Workspace | 导入、导出、删除和权限都以项目为边界 | Product / Data |
| P1-5 | 路由仍依赖结构化规则 | 增加自然语言策略编译、按 Key 配额/权重、跨月精确成本账本和趋势 | 路由决策可重放，账单能与 Provider 对账 | Model Routing |
| P1-6 | 工具 schema 可能挤占上下文 | 增加 Tool Search、capability catalog、动态能力刷新和渐进披露 | 大型插件集下只暴露当前任务需要的工具 | Ecosystem |
| P1-7 | 记忆/Skill 自动变化治理不足 | 所有自动学习先进入暂存，附来源、置信度、diff、审批和撤销 | 未批准变更不能成为稳定规则或执行代码 | Memory / Security |
| P1-8 | 桌面交付状态不完整 | 把 Diff 评论、Artifact、验证、CI、PR、review、merge 和 release 状态接入统一控制面 | 用户不离开 CaoGen 即可判断是否可交付 | Desktop / Delivery |
| P1-9 | 架构热点阻碍迭代 | 拆分 `store.ts`、`sessionManager.ts`、`ipc.ts` 和 shared types | 严格标准审计通过，新增功能不再进入超大聚合文件 | Architecture |

## P2: 差异化扩张

| ID | 优化方向 | 边界 |
|---|---|---|
| P2-1 | 3D 办公性能、镜头、资产和状态交互继续优化 | 只消费真实状态；P0 未完成前不再把视觉精修当主线 |
| P2-2 | Office 文档高保真、编辑、公式、动画和协作批注 | 必须继续区分结构预览、系统渲染和原应用像素级一致性 |
| P2-3 | 跨设备、移动节点、语音、Canvas 和多渠道入口 | 这是 OpenClaw 类扩张面，不是当前 Codex Desktop 对标阻塞项 |
| P2-4 | 公共插件市场、评分、共享和组织目录 | 先完成供应链与隔离，再扩大数量 |
| P2-5 | 跨主机 worker 和分布式 lease | 目标是超越 Hermes 单机 Kanban，而不是先复制其全部 UI |
| P2-6 | N1 迁移实测和长期用户研究 | 必须用真人计时、录屏、失败点和回退次数作为证据 |

## 推荐实施顺序

### 第一批: Trust Kernel

1. P0-1B/C 扩展 Reconciler、append-only evidence 和补偿执行。
2. P0-4A 先修测试四态与 required gate，使后续安全完成度可被可信判断。
3. P0-2 移除 Base64 fallback，完成 scoped credential broker 和数据生命周期。
4. P0-3 MCP/插件 Capability Manifest、版本/digest 固定与隔离。

完成条件: 强杀、重复执行、恶意插件、凭据泄漏四类测试全部进入 required gate，且 `SKIP` 不再被统计为通过。

### 第二批: Durable Delivery

1. P0-4B Hosted CI、签名、SBOM、provenance、安装升级和回滚。
2. P0-5 Canonical Conversation Ledger 与跨 Provider resume。

完成条件: 任一提交、安装包和恢复会话都能从持久证据解释“做了什么、用什么版本、结果是否可信”。

### 第三批: Agent Control Plane

1. P1-2 四类 Agent 原语。
2. P1-3 统一 Supervisor 和远程 runner。
3. P1-1 Genesis 执行化。
4. P1-8 PR/CI/Artifact 桌面控制面。

完成条件: 长任务可恢复、可审批、可验证、可交付，不依赖某个 UI 进程一直存活。

## 明确不做

- 不重新引入 Codex CLI Adapter 或 Gemini CLI Adapter。相关产品只作为迁移资产来源和能力参考。
- 不复制竞品代码、品牌、界面或不可验证的营销声明。
- 不把 Hook、Prompt 或模型自律当作权限和沙箱的替代品。
- 不把退出码 0 的 skip 当成通过。
- 不在没有签名、安装、升级和回滚证据时宣称“可发布”。
- 不在没有外部回读证据时宣称 exactly-once。
- 不让 3D 视觉精修继续挤占内核安全、恢复和交付优先级。

## 官方来源

### Codex

- [OpenAI Codex official repository](https://github.com/openai/codex/tree/6138909d6ec58b2fbe635ef973e02caecad5a5aa)
- [Codex Desktop entry in official README](https://github.com/openai/codex/blob/6138909d6ec58b2fbe635ef973e02caecad5a5aa/README.md#L1-L8)
- [Feature stages: multi-agent, apps, plugins, browser, computer use, goals and approvals](https://github.com/openai/codex/blob/6138909d6ec58b2fbe635ef973e02caecad5a5aa/codex-rs/features/src/lib.rs#L1031-L1269)
- [Thread resume, fork, list, goals and archive protocol](https://github.com/openai/codex/blob/6138909d6ec58b2fbe635ef973e02caecad5a5aa/codex-rs/app-server/README.md#L333-L648)
- [Skill enablement and Hook trust model](https://github.com/openai/codex/blob/6138909d6ec58b2fbe635ef973e02caecad5a5aa/codex-rs/app-server/README.md#L1691-L1725)

说明: `developers.openai.com/codex/codex-manual.md` 在本次核验中返回 HTTP 403，当前会话已配置的 OpenAI docs MCP 也未暴露为可调用工具。因此未用缓存或第三方摘要替代；补充采用同日官方仓库和当前 Codex Desktop 实际工具面。公开可用性仍以 OpenAI 正式文档和账号权限为准。

### Claude

- [Claude Desktop application](https://code.claude.com/docs/en/desktop)
- [Desktop scheduled tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks)
- [MCP Bundles](https://claude.com/docs/connectors/building/mcpb)
- [Managed MCP](https://code.claude.com/docs/en/managed-mcp)
- [Subagents](https://code.claude.com/docs/en/sub-agents)
- [Agent View](https://code.claude.com/docs/en/agent-view)
- [Agent Teams](https://code.claude.com/docs/en/agent-teams)
- [Permissions](https://code.claude.com/docs/en/permissions)
- [Sandboxing](https://code.claude.com/docs/en/sandboxing)
- [Checkpointing](https://code.claude.com/docs/en/checkpointing)
- [Hooks](https://code.claude.com/docs/en/hooks)
- [GitHub Actions](https://code.claude.com/docs/en/github-actions)
- [Code Review](https://code.claude.com/docs/en/code-review)

### OpenClaw

- [Official repository](https://github.com/openclaw/openclaw)
- [Architecture](https://docs.openclaw.ai/concepts/architecture)
- [Background Tasks](https://docs.openclaw.ai/automation/tasks)
- [Task Flow](https://docs.openclaw.ai/automation/taskflow)
- [Multi-Agent](https://docs.openclaw.ai/concepts/multi-agent)
- [Memory](https://docs.openclaw.ai/concepts/memory)
- [Plugin Manifest](https://docs.openclaw.ai/plugins/manifest)
- [Security](https://docs.openclaw.ai/gateway/security)
- [Sandboxing](https://docs.openclaw.ai/gateway/sandboxing)
- [CI Pipeline](https://docs.openclaw.ai/ci)
- [Full Release Validation](https://docs.openclaw.ai/reference/full-release-validation)

### Hermes Agent

- [Official repository](https://github.com/NousResearch/hermes-agent/tree/8727e6729512ef6415768e1980b1aadc19084abe)
- [Desktop architecture](https://hermes-agent.nousresearch.com/docs/user-guide/desktop)
- [Agent loop](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop)
- [Durable Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban)
- [Delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation)
- [Cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)
- [MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)
- [Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
- [Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- [Security Policy](https://github.com/NousResearch/hermes-agent/blob/8727e6729512ef6415768e1980b1aadc19084abe/SECURITY.md)
- [CI Orchestrator](https://github.com/NousResearch/hermes-agent/blob/8727e6729512ef6415768e1980b1aadc19084abe/.github/workflows/ci.yml)

Hermes 官方材料存在 Linux Desktop 支持和版本号漂移，相关结论信心为中等；其 Kanban、Agent loop 和安全边界结论信心为高。
