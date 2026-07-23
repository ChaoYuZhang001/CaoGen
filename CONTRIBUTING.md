# Contributing to CaoGen

[中文](#中文) | [English](#english)

## 中文

CaoGen 欢迎 Issue、讨论、文档、测试、设计和代码贡献。项目仍在快速建设中；贡献的第一目标是让当前发布能力更可靠、更容易使用，而不是把路线图提前写成已完成。

### 本地运行

准备 Git、Node.js 和 npm，然后执行：

```bash
git clone https://github.com/ChaoYuZhang001/CaoGen.git
cd CaoGen
npm install
npm run dev
```

常用验证命令：

```bash
npm run typecheck
npm run build
```

涉及 Agent、Provider、Git/worktree、浏览器、文件预览或 3D Office 时，请同时运行对应的 `scripts/*-smoke.*` 或 `package.json` 中的目标测试。完整编码门禁见 [docs/CODING-STANDARDS.md](./docs/CODING-STANDARDS.md)。

### 六环架构地图

新增一项跨进程能力时，通常必须沿下面六环同步打通：

```text
1. Main process
   src/main/*
       ↓ 注册处理器
2. IPC
   src/main/ipc.ts + src/main/ipc/*
       ↓ 暴露受控调用
3. Preload bridge
   src/preload/*
       ↓ 共享契约
4. Types
   src/shared/types.ts + src/shared/*-types.ts
       ↓ 状态与动作
5. Renderer store
   src/renderer/src/store.ts + src/renderer/src/store/*
       ↓ 视图与交互
6. UI
   src/renderer/src/components/*
```

只改其中一环通常会产生以下问题：主进程已有实现但 UI 调不到、preload 暴露了未声明类型、store 没有消费事件，或 UI 能编译但运行时通道不存在。提交前请从 Main 到 UI 逐环核对，并为纯逻辑或关键通道添加最小 smoke 测试。

### `src/` 目录说明

| 路径 | 职责 | 常见改动 |
|---|---|---|
| `src/main/` | Electron 主进程、模型运行时、本地文件/Git/终端/浏览器能力 | Provider、路由、会话、worktree、预览、工具执行 |
| `src/main/ipc.ts`、`src/main/ipc/` | IPC 注册与参数边界 | 新增或拆分 handler、输入校验、主进程调用 |
| `src/preload/` | 受控暴露给 renderer 的桥接 API | 增加 `window.agentDesk` 方法与事件订阅 |
| `src/shared/` | 主进程、preload、renderer 共用类型与契约 | 请求/响应类型、事件、领域类型 |
| `src/renderer/src/store.ts`、`src/renderer/src/store/` | renderer 状态、动作和 IPC 编排 | 加载态、错误态、缓存、跨面板状态 |
| `src/renderer/src/components/` | React UI、工作台与 3D Office | 页面、控件、可访问性、交互与视觉状态 |

Effect Ledger、Workflow Ledger、验收/恢复和外部副作用网关属于高风险核心账本。第一次贡献请优先选择不触碰这些模块的任务；确需修改时，先在 Issue 中和维护者确认边界与验证方案。

### 从哪里开始

1. 查看 [good-first-issue 草稿](./docs/good-first-issues.md) 或 GitHub 的 [good first issue](https://github.com/ChaoYuZhang001/CaoGen/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22good%20first%20issue%22)。
2. 在 Issue 下留言说明你准备处理，避免重复工作。
3. 选择一个不碰核心账本、能够独立验证的小任务，例如 Provider 模板、预览格式、i18n、tooltip、纯函数测试或脚本文档。
4. 不确定入口时，在 Issue 中贴出你找到的文件和计划；维护者会帮助缩小范围。

### Pull Request 流程

1. 从最新 `main` 创建分支，一个 PR 只解决一个明确问题。
2. 保持改动聚焦，不要把无关格式化、重构和功能修改混在一起。
3. 新增行为时补测试；UI 改动附截图或短录屏，文档改动检查链接和事实边界。
4. 至少运行 `npm run typecheck && npm run build`，并在 PR 模板中记录结果和未运行的检查。
5. 提交 PR 后回应 review，必要时说明取舍、风险和回退方法。

**维护者承诺：对公开 Issue 和 Pull Request 在 48 小时内给出首次回应。** 这表示确认、分流或提出下一步，不代表 48 小时内完成 review 或合并。

推荐使用简短的 Conventional Commit 前缀：

```text
feat: add provider preset
fix: clarify preview error
docs: explain smoke script
test: cover routing helper
```

### 安全与许可

- 不要在公开 Issue、PR、截图或日志中提交 API Key、Token、私有仓库内容或本机敏感路径；安全问题按 [SECURITY.md](./SECURITY.md) 私下报告。
- 不要提交 `dist/`、本地缓存、模型原始响应或无关生成产物，除非维护者明确要求。
- 提交 PR 表示你有权贡献相关代码和资料，并同意该贡献至少可按 [AGPL-3.0-only](./LICENSE) 使用。
- CaoGen 另有商业授权。若外部贡献需要纳入商业授权版本，维护者会在合并前单独提出明确的贡献者许可协议；提交 PR 本身不会自动转让版权或授予重新许可权。

---

## English

CaoGen welcomes issues, discussions, documentation, tests, design work, and code contributions. The project is moving quickly; contributions should first make today's released capabilities more reliable and approachable, not present roadmap work as already complete.

### Run locally

Install Git, Node.js, and npm, then run:

```bash
git clone https://github.com/ChaoYuZhang001/CaoGen.git
cd CaoGen
npm install
npm run dev
```

The baseline verification commands are:

```bash
npm run typecheck
npm run build
```

If your change touches agents, providers, Git/worktrees, the browser, file previews, or the 3D Office, also run the relevant `scripts/*-smoke.*` test or its `package.json` command. See [docs/CODING-STANDARDS.md](./docs/CODING-STANDARDS.md) for the full coding gates.

### Six-link architecture map

A new cross-process capability normally needs to pass through all six links:

```text
1. Main process
   src/main/*
       ↓ register handlers
2. IPC
   src/main/ipc.ts + src/main/ipc/*
       ↓ expose controlled calls
3. Preload bridge
   src/preload/*
       ↓ share contracts
4. Types
   src/shared/types.ts + src/shared/*-types.ts
       ↓ define state and actions
5. Renderer store
   src/renderer/src/store.ts + src/renderer/src/store/*
       ↓ drive views and interactions
6. UI
   src/renderer/src/components/*
```

Changing only one link often leaves an implementation that the UI cannot call, an untyped preload API, an event the store never consumes, or a view whose runtime channel does not exist. Before opening a PR, trace the capability from Main to UI and add a focused smoke test for pure logic or a critical bridge.

### `src/` directory guide

| Path | Responsibility | Typical changes |
|---|---|---|
| `src/main/` | Electron main process, model runtimes, local file/Git/terminal/browser capabilities | Providers, routing, sessions, worktrees, previews, tool execution |
| `src/main/ipc.ts`, `src/main/ipc/` | IPC registration and input boundaries | Handlers, validation, main-process calls |
| `src/preload/` | Controlled APIs exposed to the renderer | `window.agentDesk` methods and event subscriptions |
| `src/shared/` | Contracts shared by main, preload, and renderer | Request/response, event, and domain types |
| `src/renderer/src/store.ts`, `src/renderer/src/store/` | Renderer state, actions, and IPC orchestration | Loading/error states, caching, cross-panel state |
| `src/renderer/src/components/` | React UI, workbench, and 3D Office | Views, controls, accessibility, interactions, visual states |

The Effect Ledger, Workflow Ledger, acceptance/recovery paths, and external side-effect gateway are high-risk accounting cores. First-time contributors should prefer tasks that do not touch them. If a change genuinely requires those modules, agree on the boundary and verification plan with a maintainer in an issue first.

### Where to start

1. Browse the [good-first-issue drafts](./docs/good-first-issues.md) or live GitHub [good first issues](https://github.com/ChaoYuZhang001/CaoGen/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22good%20first%20issue%22).
2. Comment on the issue before starting so contributors do not duplicate work.
3. Pick a small, independently testable task outside the core ledgers, such as a provider preset, preview format, i18n parity, tooltip, pure helper test, or script documentation.
4. If the entry point is unclear, post the files and approach you found; a maintainer will help narrow the scope.

### Pull request workflow

1. Branch from the latest `main`; keep one clear problem per PR.
2. Keep the diff focused and avoid mixing unrelated formatting, refactors, and feature work.
3. Add tests for new behavior. Include screenshots or a short recording for UI changes, and verify links and capability boundaries for documentation changes.
4. Run at least `npm run typecheck && npm run build`, then record results and skipped checks in the PR template.
5. Respond to review feedback and explain tradeoffs, risk, and rollback details where relevant.

**Maintainer commitment: every public issue and pull request will receive an initial response within 48 hours.** This means acknowledgment, routing, or a concrete next step; it is not a promise to complete review or merge within 48 hours.

Short Conventional Commit prefixes are preferred:

```text
feat: add provider preset
fix: clarify preview error
docs: explain smoke script
test: cover routing helper
```

### Security and licensing

- Never put API keys, tokens, private repository content, or sensitive local paths in public issues, PRs, screenshots, or logs. Report security issues privately through [SECURITY.md](./SECURITY.md).
- Do not commit `dist/`, local caches, raw model responses, or unrelated generated artifacts unless a maintainer explicitly requests them.
- By submitting a PR, you confirm that you have the right to contribute the code and materials and agree that the contribution may be used under [AGPL-3.0-only](./LICENSE).
- CaoGen also offers commercial licensing. If an external contribution needs to enter a commercially licensed distribution, maintainers will request an explicit contributor license agreement before merge; opening a PR does not automatically transfer copyright or grant relicensing rights.
