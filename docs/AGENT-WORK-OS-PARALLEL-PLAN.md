# CaoGen Agent Work OS 并行计划表

> 当前基线: `main@3b68402`。
> 目标: 把 CaoGen 从多厂商编码 Agent 升级为原生 Agent Work OS。
> 注意: 本地已有未提交修改 `scripts/claude-real-e2e.cjs`，所有 Agent 不要触碰。
> 最新状态: A1/A3/A5/A6/A8 已合并并通过集成验证；A0 需要刷新 Truth Gate；A2/A4/A7 进入第二波；A9 暂缓到 A4 稳定后。

## 新总目标

CaoGen 不做 Agent 启动器，不做配置搬运工具，而做一个原生 Agent Work OS:把桌面控制、代码执行、多模型调度、Skills/MCP、长期记忆、多 Agent 交付全部集成到一个 CaoGen 任务系统里。

北极星验收:

> 深度用户只打开 CaoGen，不再需要 Claude Desktop、Codex Desktop、OpenClaw、Hermes、ccswitch，也能完成代码、文件、浏览器、桌面、自动化、多 Agent 交付主链路。

## CaoGen Drive 档位

| 档位 | 中文 | 控制范围 |
|---|---|---|
| Spark | 星火 | 快速模型、低推理、少工具、轻验证 |
| Core | 中枢 | 默认日用，均衡模型、常规工具、基础验证 |
| Forge | 熔铸 | 多文件工程、强推理、局部测试、diff/review |
| Command | 指挥 | 高风险任务、强模型、GUI/IDE/Git/权限强管控 |
| Genesis | 创生 | 多 Agent、DAG、worktree、交叉复核、自动验证、交付闭环 |

## 并行总计划

| Agent | 任务代号 | 目标 | 可并行性 | 主要边界 | 验收 |
|---|---|---|---|---|---|
| A0 | Truth Gate | 核验最新主分支真实状态 | 立即并行 | 只跑测试、写审计报告，不改功能 | `typecheck/build/test:p2-audit/test:p2-external:preflight` |
| A1 | CaoGen Drive | 实现 Spark/Core/Forge/Command/Genesis 五档策略层 | 已合并 | `types/settings/store/i18n/SettingsModal` | 已通过 `drive-smoke`、`test:model-router` |
| A2 | Quickbar | 全局快捷入口、截图、剪贴板、文件投递 | 第二波并行 | 新建 Quickbar 模块，少碰 store | 全局唤起、截图入会话、剪贴板入会话 |
| A3 | Desktop Control | 原生 Computer Use 能力强化 | 已合并 | `src/main/gui/*`、GUI 工具、权限条 | 已通过 `test:gui-macos` |
| A4 | Code Forge | 工程交付闭环 | 可并行，但避开 A1 热点 | Git/worktree/diff/test/PR/IDE bridge | 一个任务能改代码、跑验证、审 diff、提交 |
| A5 | Skill Fabric | 原生 Skills/MCP 运行时 | 已合并 | `src/main/skill/*`、`src/main/mcp/*`、Skills UI | 已通过 `skill-fabric-smoke` |
| A6 | Memory Loop | 自成长记忆与任务复盘 | 已合并 | `src/main/memory/*`、MemoryPanel | 已通过 `memory-loop-smoke` |
| A7 | Control Center | 替代 ccswitch 的统一控制中心 | 第二波并行 | Provider/模型/预算/路由/密钥 UI | 一个界面管模型、Key、预算、路由、MCP |
| A8 | Personal OS | 常驻助理、Routines、通知、主动任务 | 已合并 | routines/notifications/start suggestions | 已通过 `personal-os-smoke`、`routine-runner-smoke`、`start-suggestions-e2e` |
| A9 | Genesis | CaoGen 独一档旗舰模式 | 暂缓 | DAG/子 Agent/验证/复核/交付总结 | 等 A4 Code Forge 稳定后再开 |
| A10 | Integration | 最终集成与冲突处理 | 最后做 | 全局收口，处理冲突 | `typecheck + build + test:deep` 全绿 |

## 推荐开工顺序

| 波次 | 并行 Agent | 说明 |
|---|---|---|
| Wave 0 | A0 | 初版已完成但需基于 `main@3b68402` 刷新 |
| Wave 1 | A1、A3、A5、A6、A8 | 已合并到 `main` 并通过本地集成验证 |
| Wave 2 | A2、A4、A7 | 当前开工波次:Quickbar、Code Forge、Control Center 接入 Drive |
| Wave 3 | A9 | Genesis 等 A4 Code Forge 接口稳定后再开 |
| Wave 4 | A10 | 统一集成、验收、修冲突 |

## 热点文件锁

| 文件/区域 | 负责人 | 规则 |
|---|---|---|
| `src/shared/types.ts` | A10 协调 | A1 已合并；A2/A4/A7 如必须扩展类型，保持最小改动并说明原因 |
| `src/main/settings.ts` | A7/A10 协调 | A1 已合并；A7 可扩展 Control Center 设置，但不要重写 Drive 默认 |
| `src/renderer/src/store.ts` | A7/A10 协调 | A2/A4 尽量不碰；A7 必须改时保持接口最小化 |
| `src/renderer/src/i18n.ts` | A10 协调 | 各 Agent 可加少量文案，但避免大规模重排 |
| `src/main/sessionManager.ts` | A4/A9 | A4 做 Code Forge，A9 做 Genesis，不能同时改 |
| `src/main/ipc.ts`、`src/preload/index.ts` | A10 | 各 Agent 先做模块，IPC 最后统一接 |
| `package.json`、`package-lock.json` | A10 | 除非必须新增依赖，否则不要碰 |
| `scripts/claude-real-e2e.cjs` | 禁碰 | 当前本地已有未提交修改，任何 Agent 不要改 |

## 各 Agent 具体任务

| Agent | 核心任务 | 目标文件建议 | 专项测试 |
|---|---|---|---|
| A0 | 生成当前能力审计:已完成/待验证/阻塞 | `docs/WORKOS-TRUTH-GATE.md` | `npm run test:p2-audit` |
| A1 | 新增 `CaoGenDriveMode`、五档策略、厂商降级规则 | `src/main/model/*`、共享类型、设置 | `test:model-router`、新增 drive smoke |
| A2 | Quickbar:全局唤起、截图、剪贴板、文件入口 | 新建 `src/main/quickbar/*`、renderer 组件 | 新增 quickbar smoke |
| A3 | GUI/Computer Use:权限、截图、窗口、输入可靠性 | `src/main/gui/*`、`gui-tools.ts` | `test:gui-*` |
| A4 | Code Forge:worktree -> diff -> test -> commit -> PR 闭环 | git、worktree、dag、IDE bridge | `test:git-tools`、`test:dag` |
| A5 | Skill Fabric:Skill 生命周期、MCP 运行态、权限 | `src/main/skill/*`、`src/main/mcp/*` | `test:p1`、skill/mcp smoke |
| A6 | Memory Loop:任务复盘、失败记忆、偏好学习 | `src/main/memory/*`、MemoryPanel | memory smoke/e2e |
| A7 | Control Center:模型、Provider、Key、预算、路由 | Provider UI、settings UI | model/router/budget smoke |
| A8 | Personal OS:Routines、通知、防休眠、主动建议 | routines、notification、startSuggestions | routine/start-suggestions e2e |
| A9 | Genesis:自动拆解、多 Agent、交叉审查、验证交付 | DAG、sessionManager、model validation | `test:orchestration`、`test:dag-automerge` |
| A10 | 集成、冲突处理、最终验收 | 全局 | `typecheck/build/test:deep` |

## 每个 Agent 的交付格式

| 项 | 要求 |
|---|---|
| 分支 | `codex/workos-a1-drive` 这种格式 |
| 提交 | 每个 Agent 只做一个主题，独立提交 |
| 文档 | 在 PR/最终说明写清楚“做了什么、没做什么、怎么验证” |
| 测试 | 至少跑 `npm run typecheck && npm run build`，再跑对应 smoke |
| 禁止 | 不改无关文件，不碰 `scripts/claude-real-e2e.cjs`，不把未验证能力写成已完成 |

## 最终验收标准

完成后必须证明:

1. 用户通过 Drive 五档启动任务，而不是手动选一堆模型参数。
2. Spark/Core/Forge/Command/Genesis 能真实影响模型、工具、预算、验证深度。
3. Quickbar 能替代 ChatGPT Desktop 的入口型需求。
4. Desktop Control 能替代 Claude/Codex Computer Use 的主链路。
5. Code Forge 能替代 Codex/Claude Code 的工程交付主链路。
6. Skill Fabric + Memory Loop 能覆盖 OpenClaw/Hermes 的 Skills、MCP、记忆成长。
7. Control Center 能覆盖 ccswitch 的配置/路由/Provider 管理。
8. Genesis 能完成“自动拆解、并行执行、审查、验证、交付”的完整闭环。

## 建议并发

第一波已完成:

`A1`、`A3`、`A5`、`A6`、`A8`

当前第二波建议并发:

`A0-refresh`、`A2`、`A4`、`A7`

暂缓:

`A9`

最后由 `A10` 统一集成。

## 第二波任务单

| Agent | 分支 | 任务 | 核心目标 | 禁碰/注意 |
|---|---|---|---|---|
| A0-refresh | `codex/workos-a0-truth-gate-refresh` | 刷新 Truth Gate | 基于 `main@3b68402` 重写 `docs/WORKOS-TRUTH-GATE.md`，把 A1/A3/A5/A6/A8 标为已合并/已验证，同时保留 P2 外部证据缺口 | 只改文档，不改功能代码 |
| A2 | `codex/workos-a2-quickbar` | Quickbar | 全局唤起、截图入会话、剪贴板入会话、文件投递、当前窗口上下文 | 少碰 `store.ts`，不要改 Drive 策略 |
| A4 | `codex/workos-a4-code-forge` | Code Forge | worktree -> diff -> test -> commit -> PR/patch -> 验证报告的工程交付闭环 | 可以碰 Git/worktree/DAG；谨慎改 `sessionManager.ts` |
| A7 | `codex/workos-a7-control-center` | Control Center | Provider、模型、Key、预算、Drive、MCP、CLI 工具统一管理 | 可碰 Settings/Provider UI；不要重写 A1 Drive 策略 |

第二波完成后，由 A10 做统一集成，跑 `npm run typecheck && npm run build && npm run test:deep`。

## 第二波启动记录

| Agent | Codex Agent ID | Nickname | 状态 |
|---|---|---|---|
| A0-refresh | `019f3d66-acc9-7481-b847-a69dfb52173e` | Bohr | 已启动 |
| A2 Quickbar | `019f3d66-b75b-7690-9003-8b4d385b062f` | Goodall | 已启动 |
| A4 Code Forge | `019f3d66-bcb3-7722-ac81-b08eb3c1be47` | Maxwell | 已启动 |
| A7 Control Center | `019f3d66-c322-7ad3-8649-a1fba9d94c7c` | Singer | 已启动 |

A9 Genesis 暂不启动，等 A4 Code Forge 的接口和验证报告稳定后再开。
