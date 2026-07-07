# CaoGen Agent Work OS Truth Gate

> 生成时间: 2026-07-07 23:29 CST  
> 审计分支: `codex/workos-a0-truth-gate`  
> 基线: `main@2b311fd81008cf14f2ebdc904912276c59395e57`  
> 范围: 只做真实状态审计、跑测试、生成本文档；不改功能代码。

## 结论

CaoGen 已有一批 Work OS 底座能力: 多会话、DAG/子 Agent、worktree、Git/diff、Skill/MCP、Memory、Routine、Provider/模型路由、GUI 工具与权限闸门。但按 `docs/AGENT-WORK-OS-PARALLEL-PLAN.md` 的北极星验收口径,当前不能声称已经是完整 Agent Work OS。

核心原因很直接:

1. `typecheck` 与生产 `build` 在 A0 初始审计窗口通过。
2. `test:p1`、`test:dag`、`test:orchestration` 通过,证明部分本地底座可运行。
3. A0 要求的 `test:p2-audit` 当前输出 `failed`;P2-001 到 P2-005 全部是 `missing_evidence`。
4. `test:p2-external:preflight` 命令本身退出 0,但报告状态为 `failed`,原因是 JetBrains、国内真实网络、国内工具调用 parity 均缺外部配置或构建产物。
5. Drive 五档、Quickbar、统一 Control Center、完整 Code Forge、完整 Genesis 仍不能写成已完成。源码里有相邻能力,但缺少端到端验收证据。

信心度: 高。依据是当前命令输出、`test-results/*/latest.json`、`package.json` scripts、源码入口和 A0 计划文档。对于并发脏工作区造成的补充 smoke 失败,信心度为中等,因为该失败发生在其他 Agent 未提交改动出现之后,不能代表干净 `main@2b311fd`。

## 审计纪律

- 不碰 `scripts/claude-real-e2e.cjs`。该文件在 A0 开始前已是本地修改。
- 不把未验证能力写成已完成。
- 源码存在只算“有实现入口”,不等于“已通过 Work OS 交付验收”。
- 真对话、真实 IDE、真实 GUI、真实外部网络必须有对应 E2E 或外部证据 JSON,否则归为待验证或阻塞。
- 本次工作区被其他并行 Agent 多次切换分支,且出现非 A0 文件修改。A0 报告只新增本文档,不暂存、不回滚其他人的改动。

## 当前工作区风险

A0 开始时的脏工作区包含:

- `scripts/claude-real-e2e.cjs` 已修改。
- `docs/AGENT-WORK-OS-PARALLEL-PLAN.md` 未跟踪。

A0 运行中观察到同一 worktree 被切到过以下分支:

- `codex/workos-a8-personal-os`
- `codex/workos-a6-memory-loop`
- `codex/workos-a3-desktop-control`

A0 运行中还观察到更多非 A0 文件变为 modified,包括 GUI、Routine、Memory、Settings、Store、shared types、Session Manager、Agent Session 等区域,并出现 `src/main/model/drive.ts`、`src/main/memory/memory-loop.ts`、`src/main/routines/personal-os.ts` 等未跟踪文件。这些不是 A0 产物。后续若要做严格基线验收,应在独立干净 worktree 或 CI 环境重新跑 gate。

## 已运行验证

| 命令 | 结果 | 证据/说明 |
| --- | --- | --- |
| `git rev-parse HEAD` | PASS | `2b311fd81008cf14f2ebdc904912276c59395e57` |
| `npm run typecheck` | PASS | `tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json` 退出 0 |
| `npm run build` | PASS | `electron-vite build` 退出 0;main/preload/renderer 均完成构建 |
| `npm run test:p2-external:preflight` | COMMAND PASS, REPORT FAIL | 退出 0;`test-results/p2-external-preflight/2026-07-07T15-22-42-136Z`;报告状态 `failed` |
| `npm run test:p2-required` | FAIL | `test-results/p2-required/2026-07-07T15-23-04-742Z`;失败项见下文 |
| `npm run test:p2-audit` | COMMAND PASS, REPORT FAIL | 退出 0;`test-results/p2-completion-audit/2026-07-07T15-24-38-316Z`;P2 全部 `missing_evidence` |
| `npm run test:p1` | PASS | `skillManager`、`layeredMemory`、`mcpClient`、`routineRunner`、`openaiP1Tools` 全部 ok |
| `npm run test:dag` | PASS | `task-dag smoke: PASS` |
| `npm run test:orchestration` | PASS | `orchestration mock e2e ok`;结果目录 `test-results/orchestration-mock-e2e/2026-07-07T15-27-33-419Z` |
| `npm --prefix plugins/vscode run compile` | FAIL | 缺 `vscode` 类型声明解析,并有隐式 `any`;插件目录没有 `node_modules` |
| `npm run test:git-tools` | FAIL | 补充 smoke;失败发生在非 A0 GUI 改动出现后,临时 `tsc src/main/openaiTools.ts` 命中 `src/main/gui/macos-controller.ts` 类型窄化错误 |
| `npm run typecheck && npm run build` | FAIL | 收尾复跑时 `typecheck` 失败,`build` 因 `&&` 未启动。失败点为非 A0 Drive 改动:`src/main/sessionManager.ts` 传入 `driveMode`,但 `newSessionMeta` 参数类型尚未包含该字段 |
| `npm run test:p2-audit` | COMMAND PASS, REPORT FAIL | 收尾复跑退出 0;最新目录 `test-results/p2-completion-audit/2026-07-07T15-31-37-754Z`;P2 仍全部 `missing_evidence` |

## P2 Required Gate

`test-results/p2-required/latest.json`:

- 总状态: `failed`
- runId: `2026-07-07T15-23-04-742Z`
- 失败项:
  - `p2_default_smoke`
  - `gui_desktop_e2e_required`
  - `ide_build_and_vscode_required`
  - `jetbrains_ide_interaction_required`
  - `china_real_network_required`
  - `china_tool_call_parity_required`
- 通过项:
  - `gui_permission_required`

关键事实:

- `p2_default_smoke` 在 Skill、Model、China local smoke 已打印 ok 后失败。直接失败点是 `scripts/p2-external-validators-smoke.mjs` 期望 JetBrains preflight 为 `ready`,但实际得到 `missing_configuration`。根因之一是 `plugins/jetbrains/build/distributions/caogen-jetbrains-bridge-0.0.1.zip` 缺失。
- `gui_desktop_e2e_required` 在当前 macOS 环境跳过 Windows-only VS Code/cross-app GUI E2E,随后因缺 `test-results/gui-vscode-e2e/latest.json` 判失败。
- `gui_permission_required` 通过 19 个权限闸门断言,包括默认禁用、临时授权、OpenAI/Claude gate 顺序、denylist 优先、审计日志、renderer 设置入口。
- `ide_build_and_vscode_required` 失败: VS Code 插件 compile failed;JetBrains build plugin 因缺本地 Gradle/JDK 工具链跳过,required 模式下算失败。
- `jetbrains_ide_interaction_required` 失败:缺真实 IDE 可执行路径、缺插件 zip、缺真实交互 evidence JSON 或 recorder JSONL。
- `china_real_network_required` 失败:未设置 `CAOGEN_CHINA_REAL_NETWORK=1`,缺 Feishu/DingTalk/WeCom/Gitee/阿里云云效/腾讯 CODING/微信小程序等真实目标配置。
- `china_tool_call_parity_required` 失败:未设置 `CAOGEN_CHINA_TOOL_CALL_PARITY=1`,缺 `CAOGEN_CHINA_PARITY_PROVIDERS`,缺 baseline provider 和 China provider。

## P2 Completion Audit

`test-results/p2-completion-audit/latest.json` 当前最新 runId 为 `2026-07-07T15-31-37-754Z`:

| P2 项 | 审计状态 | 真实含义 |
| --- | --- | --- |
| P2-001 GUI automation and permission boundary | `missing_evidence` | 权限边界已通过 smoke;真实 VS Code GUI、cross-app GUI、input preflight 证据缺失或跳过 |
| P2-002 Skill learning/review/optimization/invocation | `missing_evidence` | 本地 skill 子 smoke 在 `test:p2` 链路前半段打印 ok,但 `p2_default_smoke` 整体失败,不能关闭 P2 |
| P2-003 Model routing/optimization/cross validation | `missing_evidence` | 本地 model 子 smoke 打印 ok,但 `p2_default_smoke` 整体失败,不能关闭 P2 |
| P2-004 China ecosystem local + real network + parity | `missing_evidence` | 本地 China ecosystem/provider smoke 打印 ok;真实网络与 parity 均失败 |
| P2-005 IDE integrations | `missing_evidence` | VS Code host workflow 缺证据;JetBrains 真实 IDE 交互失败;IDE 插件构建失败 |

因此: P2 当前不是“完成但有环境缺口”,而是“部分本地能力可用,整体验收未闭合”。

## Work OS 分项真实状态

| Agent | 计划目标 | 当前真实状态 | 判定 |
| --- | --- | --- | --- |
| A0 Truth Gate | 核验最新主分支真实状态,写报告 | 本文档生成;A0 gate 已跑;发现 P2 未闭合和并发 worktree 污染 | 已执行 |
| A1 CaoGen Drive | Spark/Core/Forge/Command/Genesis 五档策略层 | A0 初始基线扫描时未发现可验收的 `CaoGenDriveMode`/五档策略闭环。A0 运行后出现外部未提交 Drive 改动,但收尾 `typecheck` 因 `driveMode` 类型不同步失败,不能计为完成 | 未完成/未证明 |
| A2 Quickbar | 全局快捷入口、截图、剪贴板、文件投递 | 未发现 `src/main/quickbar` 或 Quickbar 组件。现有 `CommandPalette`/菜单快捷键不能等价替代 Quickbar | 未实现/未证明 |
| A3 Desktop Control | 原生 Computer Use 能力强化 | 有 `src/main/gui/*`、`gui-tools.ts`、GUI 权限闸门。权限 smoke 通过;真实桌面 E2E 在本机缺证据,Windows-only required E2E 跳过后失败 | 部分实现,未完成验收 |
| A4 Code Forge | worktree -> diff -> test -> commit -> PR 闭环 | 有 Git/worktree/diff IPC、worktree merge/PR 入口、DAG smoke 通过。`test:git-tools` 补充 smoke 在脏 GUI 改动后失败;未证明完整工程交付闭环 | 部分实现,未完成验收 |
| A5 Skill Fabric | Skill 生命周期、MCP 运行态、权限 | `test:p1` 中 Skill/MCP smoke 通过;P2 skill 子 smoke 也打印 ok。但 P2 总 audit 仍 `missing_evidence` | 本地底座可用,P2 未闭合 |
| A6 Memory Loop | 任务复盘、失败记忆、偏好学习 | `layeredMemory` smoke 通过;源码有 memory manager/retriever/writer、MemoryPanel、memory suggestion 入口。未在本轮证明完整任务后复盘闭环 | 部分实现,需系统验收 |
| A7 Control Center | Provider/模型/Key/预算/路由/MCP 统一管理 | 有 Provider IPC、settings、model router、monthly budget、MCP probe 入口。未发现 Drive 档位下的统一控制中心完成态 | 部分底座,未完成目标形态 |
| A8 Personal OS | Routines、通知、主动建议 | `routineRunner` smoke 通过;有 routines、notification、startSuggestions 源码。未在本轮证明定时任务 + 通知 + 主动建议稳定闭环 | 部分实现,需 E2E |
| A9 Genesis | 自动拆解、多 Agent、交叉审查、验证交付 | `test:dag` 和 `test:orchestration` 通过;源码有 DAG、subagent、worktree 自动合并入口。未跑通完整“拆解 -> 并行执行 -> 审查 -> 验证 -> 交付”真实链路 | 部分实现,未完成旗舰验收 |
| A10 Integration | 全局收口,`typecheck/build/test:deep` 全绿 | `typecheck/build` 通过;本轮未跑 `test:deep`;P2 audit 失败;并发脏工作区存在 | 未开始/不合格 |

## 已证明能力

这些可以写成“当前已验证”:

- 基线 HEAD 是 `2b311fd81008cf14f2ebdc904912276c59395e57`。
- A0 初始审计窗口内 `npm run typecheck` 通过。
- A0 初始审计窗口内 `npm run build` 通过。
- `test:p1` 通过:Skill Manager、Layered Memory、MCP Client、Routine Runner、OpenAI P1 Tools。
- `test:dag` 通过。
- `test:orchestration` 通过 mock Electron E2E。
- GUI 权限边界 smoke 通过 19 项断言。

注意:收尾复跑 `npm run typecheck && npm run build` 已失败,原因是 A0 运行中出现的外部 Drive 改动尚未类型闭合。这不能反推 A0 初始窗口的 typecheck/build 结果无效,但说明当前共享 worktree 已不再是干净可发布状态。

## 待验证能力

这些只能写成“有源码或局部 smoke,待验证”:

- Desktop Control 的真实 macOS/Windows GUI 操作链路,尤其截图非空、窗口枚举、点击、输入、热键。
- Code Forge 的完整 `worktree -> diff -> test -> commit -> PR` 主链路。
- VS Code extension host 真实工作流。
- JetBrains installed IDE 真实工作流。
- 国内真实网络通知/仓库/DevOps API。
- 国内模型 provider 与 baseline provider 的工具调用 parity。
- Memory Loop 的任务结束自动沉淀、失败复盘、偏好学习。
- Personal OS 的定时任务、通知、主动建议连续稳定闭环。
- Genesis 的真实自动拆解、多 Agent 执行、交叉复核、验证交付闭环。
- N1 30 分钟真人迁移计时。

## 阻塞项

| 阻塞 | 类型 | 当前证据 | 解除条件 |
| --- | --- | --- | --- |
| JetBrains plugin zip 缺失 | 本机构建产物 | `p2-external-preflight` 和 `jetbrains_ide_interaction_required` 均报 `plugins/jetbrains/build/distributions/caogen-jetbrains-bridge-0.0.1.zip` missing | 准备 Gradle/JDK 工具链并产出插件 zip |
| JetBrains 真实 IDE 证据缺失 | 外部/人工或 GUI E2E | 缺 `CAOGEN_JETBRAINS_IDE_PATH` 和 evidence JSON/recorder JSONL | 在真实 IDE 中完成工作流并提供证据 |
| VS Code 插件 compile fail | 本地依赖/类型 | `npm --prefix plugins/vscode run compile` 找不到 `vscode` 类型声明;插件目录没有 `node_modules` | 在 `plugins/vscode` 安装依赖并修复隐式 any |
| GUI required E2E 缺证据 | 平台/环境 | 当前 required 脚本提示 VS Code/cross-app GUI E2E only runs on Windows,随后缺 latest JSON | 在支持环境跑 required GUI E2E,或补 macOS 对等 required 证据 |
| China real network 缺配置 | 外部凭据/网络 | 缺 webhook/API/Gitee 等环境变量 | 配置真实目标并运行 required gate |
| China tool-call parity 缺 provider | 外部凭据/网络 | 缺 `CAOGEN_CHINA_TOOL_CALL_PARITY=1` 与 provider JSON | 提供 baseline + China provider JSON 并运行 required gate |
| 同一 worktree 被并行 Agent 改写 | 流程风险 | 分支多次漂移,非 A0 文件持续变脏 | 每个 Agent 使用独立 worktree 或串行锁 |
| Drive 外部改动未类型闭合 | 并发开发风险 | 收尾 `typecheck` 报 `driveMode` 不存在于 `newSessionMeta` 参数类型 | A1 在独立分支补齐类型链路并通过 `typecheck/build` |

## 下一步建议

按阻塞价值排序:

1. 先隔离并行开发环境:每个 Agent 使用独立 Git worktree,禁止共享 `/Users/apple/agent-desk` 直接切分支。
2. 补本地构建依赖:安装/恢复 `plugins/vscode/node_modules`,准备 JetBrains Gradle/JDK 工具链,让 IDE plugin build gate 先过。
3. 修 `p2-external-validators-smoke` 对 JetBrains plugin zip 的前置依赖,或把插件 zip 生成纳入 gate 前置步骤。
4. 在真实 Windows/VS Code 环境跑 GUI required E2E,并决定是否补 macOS required E2E。
5. 准备 JetBrains 真实 IDE evidence JSON 或 recorder JSONL。
6. 准备 China real network 与 tool-call parity 的真实 env/provider JSON。
7. 重新跑: `npm run typecheck && npm run build && npm run test:p2-required && npm run test:p2-audit && npm run test:p2-external:preflight`。
8. P2 全部 proved 后,再推进 A1/A2/A4/A7/A9,否则后续 Agent 会建立在不可靠状态上。
