# Work OS Truth Gate

审计时间: 2026-07-08 00:31 CST (+0800)

审计基线: `main@3b684027fdd6`

审计分支: `codex/workos-a0-truth-gate-refresh`

结论信心度: 高, 限于本仓库 Git 状态、本机 smoke/typecheck/build、以及本机 P2 audit/preflight 输出。外部真实环境结论仍为中等以下, 因为 JetBrains 真 IDE、China real network、真实 GUI/IDE 工作流还没有提交可复验外部证据。

## 当前可声明事实

1. A1/A3/A5/A6/A8 已进入当前 `main@3b684027fdd6`。
2. A1/A3/A5/A6/A8 在 A0 审计 worktree 内的对应 smoke 均通过。
3. A0 本轮未修改功能代码, 未修改 `scripts/claude-real-e2e.cjs`, 未提交 `test-results`。
4. P2 Truth Gate 仍不能宣称关闭: audit/preflight 命令能运行, 但报告状态明确为 `failed`。

## A9 Genesis 增量边界

A9 Genesis v1 已新增核心编排/交付协议, 但只进入可测试的计划层, 不宣称真实外部 Agent 控制闭环。

当前可声明:

- `src/main/genesis/orchestrator.ts` 可以生成结构化 Genesis 报告: DAG 任务拆解、worker lanes、计划中的隔离 worktree 策略、validation gates、风险判断、人工确认点和 Code Forge 交付策略。
- OpenAI 工具 `genesis_orchestrate` 已注册到 Chat Completions / Responses 工具 schema。该工具只返回计划 JSON, 不启动 `task_dispatch_dag`, 不创建 child session, 不执行 `git worktree add`, 不调用 `code_forge_delivery`。
- 权限边界: `genesis_orchestrate` 被归类为 high risk; Spark/Core/Forge 默认 deny, Command/Genesis 可进入计划层, 后续真实调度、写入、验证命令和交付仍需各自权限 gate。
- `scripts/genesis-smoke.mjs` 覆盖模式策略、计划结构、隔离/验证字段、风险判断、OpenAI 工具注册/权限边界, 以及不会声称已真实控制外部子 Agent。

当前不可声明:

- 不能宣称 Genesis 已真实控制外部子 Agent。
- 不能宣称 Genesis 已自动创建隔离 worktree、自动合并、自动提交、自动推送或自动发布。
- 不能把 `genesis_orchestrate` 的计划报告等同于真实 DAG 执行结果或 Code Forge 交付结果。

## 第一波合并与验证

| Wave | 当前状态 | 证据 | A0 复核命令 |
| --- | --- | --- | --- |
| A1 Drive | 已合并到当前 main | `07c12f5 feat(drive): add CaoGen Drive modes` 被 `main@3b684027fdd6` 包含 | `node scripts/drive-smoke.mjs` -> exit 0, `drive smoke ok` |
| A3 Desktop Control | 已合并到当前 main | merge commit `79ae15e`, feature commit `728a590` | `node scripts/gui-macos-smoke.mjs` -> exit 0, macOS controller checks passed |
| A5 Skill Fabric | 已合并到当前 main | merge commit `2b78693`, feature commit `75d336b` | `node scripts/skill-fabric-smoke.mjs` -> exit 0, `skillFabric smoke ok` |
| A6 Memory Loop | 已合并到当前 main | merge commit `22e0006`, feature commit `3b6184a` | `node scripts/memory-loop-smoke.mjs` -> exit 0, `memoryLoop smoke ok` |
| A8 Personal OS | 已合并到当前 main | merge commit `3b68402`, branch commit `8c4cb67` | `node scripts/personal-os-smoke.mjs` -> exit 0, `personalOS smoke ok` |

这些 smoke 证明第一波对应本地能力没有在 A0 分支上立刻回归。它们不是外部真实 IDE、真实公网、真实跨平台 GUI 的替代证据。

## A0 必跑验证结果

| 命令 | 退出码 | 报告状态 | 判定 |
| --- | ---: | --- | --- |
| `npm run typecheck` | 0 | N/A | 通过。`tsc --noEmit` 的 node/web 两套 tsconfig 均无错误。 |
| `npm run build` | 0 | N/A | 通过。`electron-vite build` 成功产出 main/preload/renderer bundle。 |
| `npm run test:p2-audit` | 0 | `failed` | 命令可运行, 但审计报告未通过。`P2-001` 到 `P2-005` 均为 `missing_evidence`。 |
| `npm run test:p2-external:preflight` | 0 | `failed` | 命令可运行, 但外部预检未通过。JetBrains、China real network、China tool-call parity 均为 `missing_configuration`。 |

`test:p2-audit` 和 `test:p2-external:preflight` 默认不是 strict required mode, 因此即使报告状态为 `failed` 也会以 exit 0 结束。Truth Gate 应以 JSON 里的 `status` 和 `failures` 为准, 不能只看 shell 退出码。

本轮生成的报告位于 ignored `test-results/` 下, 不提交:

- `test-results/p2-completion-audit/latest.json`
- `test-results/p2-external-preflight/latest.json`

## P2 仍阻塞的外部证据

以下缺口仍必须保留为阻塞项, 不能被 A1/A3/A5/A6/A8 的本地 smoke 或 A0 的 build 结果覆盖。

| Area | 当前缺口 | 需要的外部证明 |
| --- | --- | --- |
| JetBrains real IDE | `CAOGEN_JETBRAINS_IDE_PATH` 未提供, 未发现可用 JetBrains IDE, 且缺少 `CAOGEN_JETBRAINS_IDE_EVIDENCE_JSON` 或 `CAOGEN_JETBRAINS_IDE_RECORDER_JSONL`。本 clean worktree 也没有 ignored JetBrains plugin distribution zip。 | 在真实兼容 JetBrains IDE 中安装/运行插件, 证明建会话、发消息、发送选区、请求编辑、预览 diff、应用编辑、原生 undo、实时同步、打开桌面等动作, 并保留 evidence JSON 或 recorder JSONL 与 artifact。 |
| China real network | `CAOGEN_CHINA_REAL_NETWORK=1` 未设置, 飞书/钉钉/企业微信/Gitee/阿里云云效/腾讯 CODING/微信小程序等目标缺真实 env。 | 使用真实公网 HTTPS endpoint、真实凭据和目标过滤运行 required gate, 证明请求不是 mock、localhost、private IP 或占位域名。 |
| China tool-call parity | `CAOGEN_CHINA_TOOL_CALL_PARITY=1` 未设置, 缺 `CAOGEN_CHINA_PARITY_PROVIDERS`, 缺 baseline provider 和 China provider。 | 提供至少一个 baseline provider 和至少一个 China provider 的真实 provider JSON, 运行 required parity gate, 留下通过报告。 |
| GUI/desktop evidence | A3 macOS smoke 只证明 controller 与 schema 边界, 不能替代真实 GUI 工作流。P2 audit 仍要求 VS Code strict GUI、cross-app GUI、input preflight、permission boundary 等 source reports。 | 真实或严格自动化 GUI 环境中跑 required GUI gate, 留下 `gui-vscode-e2e`、`gui-cross-app-e2e`、`gui-input-preflight`、`gui-permission` 与 aggregate `p2-required` 报告。 |
| Required source reports | A0 clean worktree 的 `test:p2-audit` 没有可用 `p2-required/latest.json`、IDE、GUI、China 等 source reports。 | 在同一验证环境中先跑 required source gates, 再跑 audit, 让 audit 读取同一批可复验报告。 |

## Truth Gate 判定

当前可以合并 A0 文档刷新, 因为它只更新事实记录, 不改变功能行为。

当前不能宣称 Work OS P2 完成, 也不能宣称真实 JetBrains/China/GUI/IDE 外部场景已闭环。正确对外口径是:

- 第一波 A1/A3/A5/A6/A8 已合并并通过本地 smoke/typecheck/build 复核。
- P2 外部证据 gate 仍未关闭。
- 下一次关闭 P2 前, 必须补齐 `docs/P2-EXTERNAL-REQUIRED.md` 中定义的 required 外部证据, 并让 `npm run test:p2-audit -- --required` 不再出现 `missing_evidence` 或 `missing_external`。
