<div align="center">

<img src="./resources/icon.png" alt="CaoGen" width="96" height="96">

# CaoGen

### 国产开源 · 多厂商不绑定 · AI 工作桌面

<img src="https://img.shields.io/badge/version-v0.1.3-blue" alt="version">
<img src="https://img.shields.io/badge/license-MIT-green" alt="License">
<img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux%20build-lightgrey" alt="platform">
<img src="https://img.shields.io/badge/Electron-40-informational" alt="Electron 40">
<img src="https://img.shields.io/badge/PRs-welcome-brightgreen" alt="PRs welcome">

**多模型、多项目、多文件、多任务、多工具，统一放进一个可控的桌面工作室。**

[立即下载](https://github.com/ChaoYuZhang001/CaoGen/releases) | [快速开始](#3-分钟快速开始) | [贡献指南](./CONTRIBUTING.md) | [安全报告](./SECURITY.md) | [路线图](./ROADMAP.md) | [反馈问题](https://github.com/ChaoYuZhang001/CaoGen/issues)

</div>

---

## 目录

- [核心优势](#核心优势)
- [界面预览](#界面预览)
- [工作桌面能力](#工作桌面能力)
- [核心功能](#核心功能)
- [3 分钟快速开始](#3-分钟快速开始)
- [下载安装](#下载安装)
- [校验下载文件](#校验下载文件)
- [常见问题](#常见问题)
- [开发与贡献](#开发与贡献)
- [架构速览](#架构速览)
- [项目状态](#项目状态)
- [安全](#安全)
- [开源协议](#开源协议)

## 核心优势

| 多厂商统一 | 项目规则独立 | 完整工作桌面 |
| :--- | :--- | :--- |
| 支持多模型、多密钥、多厂商配置，也能接入中转站和本地兼容服务。活动密钥鉴权、额度或限流失败时先切同 Provider 备用密钥，仍失败再切健康 Provider。 | 每个项目可独立配置 AI 工作规则、技术栈说明、常用命令、默认调度策略和安全边界。 | 内置代码执行、项目理解、任务拆解、终端、文件、Diff、Git、预览、浏览器批注、插件扩展和 3D 办公区。 |

一句话：**CaoGen 是一个多厂商 AI 工作桌面，让用户在一个桌面环境里完成从想法、需求、资料、方案到代码、内容、测试、审查与交付的完整 AI 工作流程。**

## 界面预览

| 主界面 | 3D 办公区 |
| :---: | :---: |
| ![CaoGen 主界面](./docs/screenshot-app.jpg) | ![CaoGen 3D 办公区](./docs/screenshot-office.jpg) |

> 3D 办公区不是装饰：每个会话对应一个工位，运行中、等待审批、完成、失败、成本气泡和子代理消息流都来自真实会话状态。

## 工作桌面能力

| 能力域 | CaoGen 当前目标 |
|---|---|
| 模型与服务 | 多协议、多厂商、网关、中转站和本地模型统一配置；Provider、模型、密钥、Base URL 和健康状态集中管理。 |
| 项目与规则 | 每个项目独立保存提示词、技术栈、常用命令、测试/构建命令、禁止目录、调度策略和项目记忆。 |
| 文件与资料 | 在应用内查看 HTML、Markdown、JSON、CSV、PDF、图片和 Office 文档；macOS 可生成隔离的系统文档预览，结构页、工作表和幻灯片可单独发送给 Agent。 |
| 任务与交付 | 支持任务拆解、命令执行、Diff 审查、Git 操作、worktree 隔离、冲突检查和交付前验证。 |
| 调度与成本 | 支持均衡、成本优先、质量优先和速度优先，按任务类型、项目规则、用户规则、Provider 健康状态、预算和失败记录选择模型，并保留可读的路由原因。 |
| 可视化办公 | 3D 办公区展示会话、工位、审批、失败、成本、耗时、子任务消息和工作区状态。 |

## 核心功能

### 多厂商模型配置

- 多 Provider、多 API Key、自定义 Base URL、中转站和本地兼容服务统一管理；密钥只由主进程读取，系统安全存储可用时加密保存。安全存储不可用时仍存在可逆编码 fallback，这是待移除的 P0 安全缺口，当前不宣称所有环境均加密落盘。
- 支持主流文本生成协议、流式输出和工具调用循环。
- 常用 Provider 模板覆盖海外、国产、网关和本地模型服务。
- Chat Completions 兼容模型可通过工具调用循环读文件、改代码、跑命令，不只是聊天。
- 智能路由、同 Provider 备用密钥接管、跨 Provider 故障切换、模型健康记录和预算闸门已接入。
- 速度优先会先比较模型延迟档，再参考历史延迟 EMA；质量优先与速度优先对同一复杂任务可产生不同选择。
- 调度策略按“项目规则 > Core 用户策略 > 专用工作模式预设”生效，设置页和自定义规则均可保存速度优先条件。
- 模型不可用时必须明确提示原因，不伪装成可用。

### 项目级工作规则

- 每个项目可独立配置提示词、项目背景、技术栈说明和输出风格。
- 可记录启动命令、测试命令、构建命令、关键目录、禁止修改路径和验收标准。
- 可配置默认模型、规划模型、编码模型、审查模型、低成本模型和 fallback 顺序。
- `caogen.md` 的模型调度策略可影响自动路由，并在调度理由里显示来源。
- 项目记忆、历史决策和常见问题可复用，但沉淀前需要用户确认。
- 未配置 `caogen.md` 的新项目也会注入项目身份和工作目录边界，避免规则链路静默失效。

### 编码核心能力

- `@` 文件引用、文件补全、多图粘贴/拖拽、图片 OCR。
- 命令执行、文件读写、精确搜索替换、代码/符号检索、依赖查看等原生工具。
- 外部副作用已接入持久 Effect Ledger、资源级 lease/fencing、强杀恢复和人工对账；文件写入、Git commit/push 支持只读后置状态核验，其他未注册 Reconciler 的操作仍按 fail-closed 处理。
- Diff 审查、逐 hunk stage/discard、应用内 Git 提交。
- Worktree 合并审查、patch 导出/应用、冲突文件查看、PR/MR 创建（`gh` / `glab`）。
- `Esc Esc` / `/rewind` 检查点回溯；空闲时可即时重建引擎截断上下文，运行中下次 resume 截断。
- 本地命令明确在宿主机执行，不宣称系统级沙箱；文件工具限制在项目目录，敏感操作进入权限审批。

### 多 Agent 与多任务

- 主 Agent 一次最多派发 33 个子 Agent，并行处理复杂任务。
- 子代理结果自动回灌父会话，由父 Agent 汇总成败、冲突风险和合并顺序。
- DAG 任务调度已接入，可表达任务依赖、失败重试和断点恢复。
- DAG 自动合并属于高风险工作流，适合在测试仓库或明确验证命令下使用。
- 任务快照与会话历史持久化，重启后可恢复上下文。

### 文件预览与桌面体验

- 内置终端，不用切出应用跑命令。
- 内置文件浏览和文本编辑器。
- HTML / Markdown / Text / CSV / JSON / 图片 / PDF 预览；PDF 支持内嵌查看和文本层 best-effort 提取。
- Word / Excel / PowerPoint 已接入 OOXML 文本与结构预览(`.docx` / `.xlsx` / `.pptx`)；结构视图支持页、工作表和幻灯片导航及当前单元引用。macOS 可显示无网络、sandbox 隔离的系统文档预览，失败时回退首屏缩略图或结构视图；系统渲染可能与原应用中的完整原版式存在差异。
- 内置浏览器，支持选区批注、DOM 圈选、元素截图、控制台错误和网络失败观测。
- 系统通知和防休眠：任务完成、失败、等待审批时能提醒。
- GUI 自动化支持 Windows/macOS 路径，但默认关闭，属于高风险能力，需要显式授权。

### 特色功能

- 写实 3D 办公区：多会话、多 Provider、成本、状态、父子 Agent 消息流可视化。
- 项目记忆、分层记忆和记忆建议，确认后才沉淀。
- plugin、skill、agent、MCP 扫描，支持启停、投递给 Agent 和 MCP 运行态探测。
- 自动 Skill 学习、复用和优化的基础链路已接入。
- 本地 Routines：可创建、编辑、运行、记录 run log；云端 Runner 不在当前版本范围内。
- 中英双语、深色/浅色/跟随系统主题。
- VS Code / JetBrains 插件与 IDE Bridge 正在推进，当前按实验性能力看待。

## 3 分钟快速开始

1. **下载安装**：从 [Releases](https://github.com/ChaoYuZhang001/CaoGen/releases) 下载对应系统安装包。
2. **添加模型**：打开设置，选择 Provider 模板或自定义中转站，填入 API Key。
3. **打开项目**：选择你的代码目录或资料目录，新建会话，让 AI 开始理解项目、处理文件、拆解任务、跑验证、看 Diff。

第一次建议试这个提示词：

```text
帮我阅读这个项目，指出最重要的入口文件、启动方式和当前最值得修的 3 个问题。先不要改代码。
```

## 下载安装

从 [GitHub Releases](https://github.com/ChaoYuZhang001/CaoGen/releases) 下载最新版本：

| 平台 | 当前公开包 | 状态 | 说明 |
|---|---|---|---|
| macOS Apple Silicon | `CaoGen-0.1.3-arm64.dmg` / `CaoGen-0.1.3-arm64-mac.zip` | 已发布 | 推荐 M 系列 Mac 使用 |
| macOS Intel | `CaoGen-0.1.3.dmg` / `CaoGen-0.1.3-mac.zip` | 已发布 | 适合 Intel Mac |
| Windows | `CaoGen.Setup.0.1.3.exe` | 已发布 | 请按 GitHub Release 资产和校验信息下载 |
| Linux | 暂未上传 Release 资产 | 源码运行/自行打包 | `package.json` 已配置 AppImage 打包目标 |

> **macOS 首次打开说明**：当前安装包未签名，首次打开会被拦截。右键点击应用图标 → 选择「打开」→ 弹窗里再点「打开」即可；也可以在「系统设置 → 隐私与安全性」底部点「仍要打开」。之后正常双击即可。

也可以直接从源码运行，见下方「开发与贡献」。

## 校验下载文件

下载后可用 `shasum -a 256 <文件名>` 校验安装包。v0.1.3 macOS 资产的 SHA256 如下：

| 文件 | SHA256 |
|---|---|
| `CaoGen-0.1.3-arm64.dmg` | `a6f4ec73f6e943a5a3e86007d83c38de4d2bbcf3e16cbbc85d0371a96359c136` |
| `CaoGen-0.1.3-arm64-mac.zip` | `7faaa14ccda133b0094158c3445ca8ff191fb73bc5324c4c2512a7f7566839a5` |
| `CaoGen-0.1.3.dmg` | `82ab21c0f629d24bdd4db02b19b982daaffa1f9be9f28ad7010813659e41099d` |
| `CaoGen-0.1.3-mac.zip` | `66d522b5c90067edf3addfadbb6aa613bd272208cb105d03a836adc66af5f3a5` |
| `CaoGen.Setup.0.1.3.exe` | 请以 GitHub Release 资产摘要或重新下载后本机 `shasum -a 256` 为准 |
| `latest-mac.yml` | `0fb955d9dffcd708746c24c00c0167fa381d659a2fa9114e1f4094ffbed6560e` |

## 常见问题

**Q: 必须绑定某个厂商账号才能用吗？**

A: 不需要。CaoGen 支持多厂商和本地兼容服务。某些引擎或 Provider 需要对应账号、API Key 或本机登录态，但它们不是使用 CaoGen 的唯一入口。

**Q: 支持本地模型吗？**

A: 支持。只要你的本地服务提供 OpenAI 兼容接口，例如 Ollama、vLLM、LM Studio 或 one-api/new-api，就可以用 Chat Completions 协议接入。

**Q: AI 改坏我的代码怎么办？**

A: 建议新会话开启 worktree 隔离。AI 在独立 worktree 里改，合并前你可以看 Diff、导出 patch、检查冲突；不想要就丢掉。检查点回溯也可以恢复聊天上下文和代码改动。

**Q: 会上传我的代码吗？**

A: CaoGen 没有自己的云端代码托管服务。代码会留在本机，但你发给 Agent 的上下文和工具结果会发送给你选择的模型 Provider 或本地/网关服务；请按自己的保密要求选择 Provider。

**Q: 现在适合正式生产使用吗？**

A: 当前是 beta。核心编码链路已经可试用，但项目状态仍明确标注未达最终发布标准；高风险任务请先用测试仓库或 worktree 隔离。

## 开发与贡献

欢迎提交 Issue 和 PR。开始前请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)，安全问题请按 [SECURITY.md](./SECURITY.md) 处理，不要把漏洞细节、密钥或私有日志直接贴到公开 Issue。

### 本地运行

```bash
git clone https://github.com/ChaoYuZhang001/CaoGen.git
cd CaoGen
npm install
npm run dev
```

### 构建与测试

```bash
npm run typecheck  # TypeScript 类型检查
npm run build      # 构建生产产物到 out/
npm start          # 预览构建产物
npm run test:deep  # 深度测试矩阵，当前脚本编排 84 项，失败即停
npm run secret:scan # 扫描当前工作树中的明显密钥
```

需要真实厂商 Key 的端到端脚本不进 CI，适合本机手动跑：

```bash
CHAT_E2E_KEY=sk-... npx electron scripts/chat-protocol-e2e.cjs
CHAT_E2E_KEY=sk-... npx electron scripts/orchestration-e2e.cjs
CHAT_E2E_KEY=sk-... npx electron scripts/stress-32-agents.cjs
CHAT_E2E_KEY=sk-... npx electron scripts/coding-agent-e2e.cjs
```

## 架构速览

```text
src/
  shared/types.ts        主/渲染进程共享类型、IPC 协议、事件模型
  main/
    engine.ts/engines.ts 引擎接口与注册表
    agentSession.ts      Agent SDK 会话封装
    openaiEngine.ts      Responses / Chat Completions 原生编码 Agent
    sessionManager.ts    多会话、子代理、DAG、预算、历史
    providers.ts         Provider、密钥加密、模型列表探测
    worktreeMerge.ts     worktree 合并审查、patch、PR/MR
    browserView.ts       内置浏览器、批注、页面观测
    pluginRegistry.ts    plugin/skill/agent/MCP 扫描
    routineStore.ts      本地 Routines
  preload/index.ts       contextBridge 暴露 window.agentDesk
  renderer/src/          React + Zustand UI
```

新增能力遵循「主进程模块 → IPC → preload → 类型 → store → UI」链路；提交前至少跑通 `npm run typecheck` 和 `npm run build`。

## 项目状态

- 当前版本：**v0.1.3 beta**。
- v0.1.3 基于当前 `main` 打包，已发布 macOS 和 Windows 安装包。
- 正式引擎包括 SDK Agent runtime 与通用 Responses / Chat Completions 兼容 runtime；已验证过的关键链路包括国产模型原生编码 Agent、子代理编排、双协议对话、32 并发压测和多项 Electron mock E2E。
- 仍需实测/收口：签名与公证、部分 CLI 登录后的真对话、Office 复杂公式/动画与原版式一致性、N1 迁移 30 分钟真人计时、Linux 包发布验证。

后续路线图见 [ROADMAP.md](./ROADMAP.md)，完整需求边界见 [REQUIREMENTS.md](./REQUIREMENTS.md)。

## 安全

如果你发现漏洞、供应链风险或误提交密钥，请先阅读 [SECURITY.md](./SECURITY.md)。如果密钥已经泄露，请先在对应平台撤销或轮换密钥，再提交不含敏感细节的报告。

## 开源协议

本项目基于 [MIT License](./LICENSE) 开源。你可以自由使用、修改、分发和商用，只需保留版权与许可声明。

---

<div align="center">
<sub>CaoGen · 国产开源 AI 工作桌面 · 不绑厂商，不锁模型</sub>
</div>
