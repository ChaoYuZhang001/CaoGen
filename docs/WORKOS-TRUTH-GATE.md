# CaoGen Agent Work OS Truth Gate

> 生成时间: 2026-07-08 00:30 CST  
> 审计基线: `main@3b684027fdd64b0b9c93eb1977579a5e6b82f848`  
> 审计范围: 基于已合并后的 `main@3b68402` 重新取证,更新 Work OS 真实状态。  
> 工作区纪律: 不触碰既有本地改动 `scripts/claude-real-e2e.cjs`;不把未验证能力写成已完成。

## 总结论

`main@3b68402` 比上一轮 A0 审计明显前进:Drive、Desktop Control、Skill Fabric、Memory Loop、Personal OS 已有源码和本地 smoke 证据,`npm run typecheck` 与 `npm run build` 也通过。

但它仍不能被描述为“Agent Work OS 已完成”。按 `docs/AGENT-WORK-OS-PARALLEL-PLAN.md` 的北极星验收口径,当前状态是:

- 本地基础能力增强:通过。
- 新合并能力的模块级 smoke:多数通过。
- P2 required gate:失败。
- P2 completion audit:失败,所有 P2 项仍是 `missing_evidence`。
- 真实 GUI/IDE/外部网络/工具调用 parity:仍未闭合。
- Code Forge、Quickbar、Control Center、Genesis 完整主链路:仍不能声称完成。

信心度:高。依据是当前 `main@3b68402` 源码、命令输出、`test-results/*/latest.json` 与本轮补跑的专项 smoke。对真实外部服务能力的信心度为低,因为当前没有真实凭据、真实 IDE、真实网络、真实 provider parity 证据。

## 工作区状态

审计开始时与结束时均确认:

- `HEAD = main = 3b684027fdd64b0b9c93eb1977579a5e6b82f848`。
- 既有本地改动: `scripts/claude-real-e2e.cjs`。
- 未跟踪本地计划文档: `docs/AGENT-WORK-OS-PARALLEL-PLAN.md`。

审计过程中观察到当前工作区曾被切到 `codex/workos-a4-code-forge`,但 `HEAD` 仍指向同一提交。报告落盘前已切回 `main`。这说明并行 Agent 仍可能共享同一 worktree;后续严格验收建议使用独立 worktree 或 CI。

## 本轮验证

| 命令 | 结果 | 证据/说明 |
| --- | --- | --- |
| `git rev-parse HEAD main 3b68402` | PASS | 三者均为 `3b684027fdd64b0b9c93eb1977579a5e6b82f848` |
| `npm run typecheck` | PASS | `tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json` 退出 0 |
| `npm run build` | PASS | `electron-vite build` 退出 0;main/preload/renderer 均构建完成 |
| `node scripts/drive-smoke.mjs` | PASS | Drive 五档策略影响 routing、budget、permission、sandbox、cross-validation |
| `node scripts/skill-fabric-smoke.mjs` | PASS | Skill Fabric 能发现 project skill/MCP capability,默认阻止 MCP tool call,显式 allow 后可调用,能 draft/test skill |
| `node scripts/memory-loop-smoke.mjs` | PASS | 能生成任务复盘、失败复盘、preference 草稿;不会自动确认项目记忆;layered memory 可搜索 |
| `node scripts/personal-os-smoke.mjs` | PASS | Routine snapshot、通知策略、防休眠 wrapper、主动建议 routine 信号通过 |
| `npm run test:dag` | PASS | `task-dag smoke: PASS` |
| `npm run test:orchestration` | PASS | `test-results/orchestration-mock-e2e/2026-07-07T16-27-28-874Z` |
| `npm run test:gui-permission` | PASS | GUI 权限 19 项断言通过 |
| `npm run test:gui-macos` | PASS | macOS System Events/AX helper/schema/权限文案/osascript 检查通过 |
| `node scripts/worktree-merge-smoke.mjs` | PASS | worktree merge smoke 通过 |
| `npm run test:p1` | FAIL | skillManager/layeredMemory/mcpClient/routineRunner 已打印 ok;`openai-p1-tools-smoke` 单文件编译失败 |
| `npm run test:model-cross-validation` | FAIL | `AssertionError: session route should keep backup validator for arbitration` |
| `npm run test:git-tools` | FAIL | 单文件编译 `src/main/openaiTools.ts` 时被 `src/main/gui/macos-controller.ts` 联合类型窄化错误卡住 |
| `npm --prefix plugins/vscode run compile` | FAIL | 缺 `vscode` 类型声明解析,并有隐式 `any` |
| `npm run test:p2-external:preflight` | COMMAND PASS, REPORT FAIL | `test-results/p2-external-preflight/2026-07-07T16-28-02-840Z` |
| `npm run test:p2-required` | FAIL | `test-results/p2-required/2026-07-07T16-28-12-314Z` |
| `npm run test:p2-audit` | COMMAND PASS, REPORT FAIL | `test-results/p2-completion-audit/2026-07-07T16-29-04-427Z` |

## P2 Required Gate

`test-results/p2-required/latest.json` 当前 runId: `2026-07-07T16-28-12-314Z`。

失败项:

- `p2_default_smoke`
- `gui_desktop_e2e_required`
- `ide_build_and_vscode_required`
- `jetbrains_ide_interaction_required`
- `china_real_network_required`
- `china_tool_call_parity_required`

通过项:

- `gui_permission_required`

关键变化:

- `p2_default_smoke` 不再先卡外部 validator,而是在 `model-cross-validation-smoke.mjs` 失败: `session route should keep backup validator for arbitration`。这表示模型交叉验证/会话路由在合并后存在回归或测试期望未同步。
- `gui_desktop_e2e_required` 仍缺严格 VS Code GUI 和 cross-app GUI 证据;当前 macOS 环境提示这些 required E2E 仅在 Windows 路径运行,随后因 `test-results/gui-vscode-e2e/latest.json` 缺失失败。
- `gui_permission_required` 通过,说明权限闸门本身仍健康。
- `ide_build_and_vscode_required` 失败:VS Code 插件 compile failed;JetBrains build plugin 在 required 模式下因缺本地 Gradle/JDK 工具链被判失败。
- `jetbrains_ide_interaction_required` 失败:缺插件 zip、缺真实 JetBrains IDE executable、缺真实 evidence JSON 或 recorder JSONL。
- `china_real_network_required` 与 `china_tool_call_parity_required` 仍是外部配置缺失。

## P2 Completion Audit

`test-results/p2-completion-audit/latest.json` 当前 runId: `2026-07-07T16-29-04-427Z`。

| P2 项 | 审计状态 | 当前解释 |
| --- | --- | --- |
| P2-001 GUI automation and permission boundary | `missing_evidence` | 权限 smoke 通过;严格 VS Code GUI/cross-app GUI/input preflight 证据缺失或跳过 |
| P2-002 Skill learning/review/optimization/invocation | `missing_evidence` | skill 子 smoke 在 `test:p2` 前半段打印 ok,但 `p2_default_smoke` 整体失败,不能关闭 P2 |
| P2-003 Model routing/optimization/cross validation | `missing_evidence` | `model-cross-validation-smoke` 明确失败,模型交叉验证不能写成完成 |
| P2-004 China ecosystem local + real network + parity | `missing_evidence` | 本地 China 子能力未跑到完整 P2 通过;真实网络与 parity required 均失败 |
| P2-005 IDE integrations | `missing_evidence` | VS Code 插件 compile failed;VS Code host latest 缺失;JetBrains 真实 IDE 交互失败 |

结论: P2 不是“只差外部环境”。除外部环境缺口外,当前还有本地 smoke 回归:`model-cross-validation-smoke`、`openai-p1-tools-smoke`/`git-tools-smoke` 单文件编译、VS Code 插件 compile。

## Work OS 分项真实状态

| Agent | 计划目标 | main@3b68402 真实状态 | 判定 |
| --- | --- | --- | --- |
| A0 Truth Gate | 真实状态审计 | 本文档已基于 `main@3b68402` 重新生成;P2 失败原因已刷新 | 已执行 |
| A1 CaoGen Drive | Spark/Core/Forge/Command/Genesis 五档策略层 | `src/shared/types.ts` 与 `src/main/model/drive.ts` 已有五档策略;`drive-smoke` 证明策略能影响路由、预算、权限、sandbox、cross-validation。还缺真实 UI/会话 E2E 证明用户通过 Drive 替代手动参数选择 | 本地策略已证明,端到端待验证 |
| A2 Quickbar | 全局快捷入口、截图、剪贴板、文件投递 | 未发现 Quickbar 模块或专项 smoke。现有 Command Palette 不等价于计划中的全局 Quickbar | 未实现/未证明 |
| A3 Desktop Control | 原生 Computer Use 能力强化 | GUI 权限 smoke 与 macOS GUI smoke 通过;required Windows VS Code/cross-app GUI E2E 缺证据;单文件编译 smoke 被 `macos-controller.ts` 类型窄化错误卡住 | 部分实现,验收未闭合 |
| A4 Code Forge | worktree -> diff -> test -> commit -> PR 闭环 | `worktreeMerge` 与 DAG smoke 通过;`git-tools` smoke 失败,完整工程交付闭环不能关闭 | 部分底座可用,未完成 |
| A5 Skill Fabric | Skill 生命周期、MCP 运行态、权限 | `skill-fabric-smoke` 通过,证明 Skill/MCP capability、默认 deny、显式 allow、draft/test skill。P2 总 audit 仍未关闭 | 本地 Fabric 通过,P2 待闭合 |
| A6 Memory Loop | 任务复盘、失败记忆、偏好学习 | `memory-loop-smoke` 通过,证明复盘草稿、失败草稿、preference、layered search。完整任务结束自动复盘 E2E 未证明 | 本地 loop 通过,系统 E2E 待验证 |
| A7 Control Center | Provider/模型/Key/预算/路由/MCP 统一管理 | 有 Provider/Settings/Model/Drive/MCP 底座,但没有 Control Center 完整形态与专项 smoke | 未完成/未证明 |
| A8 Personal OS | Routines、通知、防休眠、主动建议 | `personal-os-smoke` 通过,证明 routine 状态、通知策略、防休眠 wrapper、主动建议 routine 信号。真实长期运行/系统通知 E2E 未证明 | 本地策略通过,长期 E2E 待验证 |
| A9 Genesis | 自动拆解、多 Agent、交叉审查、验证交付 | DAG 与 orchestration mock 通过;未跑通完整 Genesis “自动拆解 -> 并行执行 -> 审查 -> 验证 -> 交付”真实闭环 | 部分底座可用,未完成 |
| A10 Integration | 全局收口 | `typecheck/build` 通过,但 P2 required/audit 失败,`test:deep` 本轮未跑 | 未达到集成验收 |

## 阻塞项

| 阻塞 | 类型 | 当前证据 | 解除条件 |
| --- | --- | --- | --- |
| `model-cross-validation-smoke` 失败 | 本地回归 | `session route should keep backup validator for arbitration` | 修复路由/validator 保留逻辑或更新测试期望,再跑 `npm run test:model-cross-validation` 和 `npm run test:p2` |
| `macos-controller.ts` 单文件编译失败 | 本地回归 | `target.error` / `target.target` 联合类型窄化错误;影响 `openai-p1-tools-smoke` 与 `git-tools-smoke` | 修复 `ElementTargetResult` 窄化写法或 smoke 编译口径,再跑 `test:p1`、`test:git-tools` |
| VS Code 插件 compile 失败 | 本地依赖/类型 | 找不到 `vscode` 类型声明;隐式 `any` | 安装/恢复 `plugins/vscode` 依赖并修类型 |
| JetBrains 插件 zip 缺失 | 本机构建产物 | `plugins/jetbrains/build/distributions/caogen-jetbrains-bridge-0.0.1.zip` missing | 准备 Gradle/JDK 工具链并构建插件 |
| JetBrains 真实 IDE 证据缺失 | 外部/人工或 GUI E2E | 缺 `CAOGEN_JETBRAINS_IDE_PATH`、evidence JSON/recorder JSONL | 在真实 JetBrains IDE 完成工作流并提供证据 |
| GUI required E2E 缺证据 | 平台/环境 | `gui_desktop_e2e_required` 缺 VS Code/cross-app latest JSON | 在支持环境跑 required GUI E2E,或补 macOS 对等 required gate |
| China real network 缺配置 | 外部凭据/网络 | 缺 webhook/API/Gitee/云效/CODING/微信小程序等 env | 配置真实目标并运行 required gate |
| China tool-call parity 缺 provider | 外部凭据/网络 | 缺 `CAOGEN_CHINA_TOOL_CALL_PARITY=1` 与 `CAOGEN_CHINA_PARITY_PROVIDERS` | 提供 baseline + China provider JSON 并运行 required gate |
| N1 真人迁移计时缺失 | 外部人工验收 | 只有 drill 文档,没有真人 30 分钟录屏/计时结果 | 真实竞品深度用户按秒表跑通并留证 |

## 下一步顺序

建议先按这个顺序推进,否则后续大集成会被同一批失败反复打断:

1. 修 `model-cross-validation-smoke` 失败,恢复 P2 默认 smoke 的模型段。
2. 修 `macos-controller.ts` 单文件编译窄化问题,恢复 `test:p1` 和 `test:git-tools`。
3. 修 VS Code 插件 compile,再跑 `test:p2-ide-build-and-vscode:required`。
4. 准备 JetBrains build/真实 IDE evidence。
5. 准备 China real network 与 tool-call parity 的真实配置。
6. 重新跑 `npm run typecheck && npm run build && npm run test:p2-required && npm run test:p2-audit && npm run test:p2-external:preflight`。
7. P2 全部 proved 后,再推进 A2/A4/A7/A9/A10 的最终闭环。

