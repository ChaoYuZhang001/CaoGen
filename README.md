# CaoGen

<p>
  <img src="https://img.shields.io/badge/license-MIT-black" alt="License: MIT">
  <img src="https://img.shields.io/badge/Electron-40-informational" alt="Electron 40">
  <img src="https://img.shields.io/badge/React-18-61dafb" alt="React 18">
  <img src="https://img.shields.io/badge/TypeScript-5-3178c6" alt="TypeScript 5">
  <img src="https://img.shields.io/badge/3D-react--three--fiber-ff69b4" alt="react-three-fiber">
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen" alt="PRs welcome">
</p>

> 🐳 国产原创 · 多厂商 AI 编码桌面工作室 · 开源(MIT)

多会话并行的桌面 AI 编码 Agent。终极目标是让 **Codex、Claude Code、Gemini CLI、Marvis 以及其他主流 Agent 的深度用户丝滑转用 CaoGen**,把 CaoGen 做成中国原创、世界级第一梯队的桌面 AI 编码工作室:多厂商模型可配置、指定运行或智能自动调度、每个 Agent 用 Git worktree 隔离、并行会话以写实 3D 办公区呈现,并补齐深度用户迁移所需的检查点回溯、子代理编排、内置浏览器批注、插件生态、产物预览、自动化与主动建议——完整目标与里程碑见 [ROADMAP.md](./ROADMAP.md)。

当前以 Claude Agent SDK 为默认引擎(与 Claude Code 同源),并提供 OpenAI Responses API 原生引擎第一版,在桌面层提供 CLI 给不了的体验:

> **多厂商 / OpenAI 主流支持**:OpenAI 可选择 **OpenAI Responses API** 引擎直连官方或兼容端点;Claude 引擎仍讲 Anthropic Messages API 协议,要用 OpenAI/Gemini/其他模型可通过 one-api、new-api、LiteLLM 等 Anthropic 兼容网关。Provider 模板已内置 OpenAI 官方直连、国产官方 Anthropic 端点和常见网关。


- **多会话并行** — 同时在多个项目上运行 Agent,侧栏一键切换,互不阻塞
- **Worktree 隔离** — 每个 Agent 默认在独立 Git worktree 工作,互不污染主工作区
- **跨厂商故障切换** — 厂商余额耗尽/限流/宕机时自动切到健康厂商重试,任务不中断,切换过程在聊天流透明标注
- **多引擎架构** — Engine 接口 + 注册表(M6),Claude Agent SDK 为默认引擎,OpenAI Responses API 已接入,Codex/Gemini CLI 适配位已留好
- **迁移级交互** — `@` 文件、图片输入、斜杠命令、`Esc Esc` / `/rewind` 检查点回溯
- **真子代理编排** — 主 Agent 可派活给子 Agent 并行完成前端、后端、测试等任务
- **工作台能力** — 拖拽分屏、内置终端/编辑器、HTML/PDF/表格/PPT 预览、可逐块处理的 Diff 查看器
- **内置浏览器批注** — 用户可直接在网页上框选、标注、截图并把指令交给 Agent
- **记忆与自动化** — 跨会话记忆、主动开工建议、本地/云端 Routines、完成通知与防休眠
- **中英双语界面** — 全部 UI 文案 zh/en 可切换
- **工具调用可视化** — Bash / 文件编辑 / 搜索每一步以卡片呈现,输入输出可展开
- **Diff 审查** — Edit / Write 的文件修改以红绿差异块呈现
- **权限掌控** — 敏感操作逐条审批(允许 / 拒绝),或随时切换权限模式(默认 / 自动接受编辑 / 规划 / 跳过)
- **成本仪表盘** — 每轮 token 用量、上下文规模、累计费用实时显示
- **会话恢复** — 历史会话持久化,一键恢复上下文继续工作
- **流式输出** — 文本与思考过程逐字流式渲染,支持随时中断

## 界面预览

![CaoGen 主界面](./docs/screenshot-app.jpg)

> 侧栏多项目并行、六大能力一览;切到 **🏢 3D 办公区**,每个会话是一个工位,一眼看出谁在写码、谁在等审批。

## 运行前提

- Node.js ≥ 20
- 已登录 Claude Code(`claude` CLI 登录)或设置了 `ANTHROPIC_API_KEY` 环境变量

## 开发

```bash
npm install
npm run dev        # 启动开发模式(HMR)
```

## 构建 / 校验

```bash
npm run typecheck  # TS 类型检查(主进程 + 渲染进程)
npm run build      # 产物输出到 out/
npm start          # 预览构建产物
```

## 打包分发 / 发布

CaoGen 通过 GitHub Releases 分发(不上架 App Store)。macOS 出 `.dmg`,Windows 出 NSIS 安装器,Linux 出 AppImage。

```bash
npm run dist:mac   # 产出 dist/CaoGen-<version>.dmg(+ .zip,供自动更新)
npm run dist       # 按当前平台打包
npm run dist:dir   # 只出未压缩 app 目录(调试打包用)
```

### macOS:签名与"首次打开"

当前配置产出的是**未签名**包(`build.mac.identity: null`)。够用来自建分发,但用户首次打开会遇到 Gatekeeper 拦截。两种发布档位:

**A · 未签名(当前默认,零成本)**
产物可直接传 GitHub Releases。用户首次打开需绕行一次:

> 下载 `.dmg` → 拖入「应用程序」→ **右键点 App 图标 → 打开** → 在弹窗里再点「打开」。
> 或:双击被拦后,去 **系统设置 → 隐私与安全性**,在底部点「仍要打开」。
> 之后每次正常双击即可,只需绕行第一次。

把上面这段放进 Release 说明,能省掉大量"打不开"的反馈。

**B · 签名 + 公证(推荐公开分发,需 Apple 凭据)**
让用户**双击即开、零警告**,是不上架却公开分发的行业标准做法。需要:

1. Apple Developer 账号($99/年),申请 **Developer ID Application** 证书并装入钥匙串。
2. 一个用于公证的 **app-specific password**(或 App Store Connect API Key)。
3. 改 `package.json` 的 `build.mac`:去掉 `identity: null`(或设为证书名),并加公证配置:
   ```jsonc
   "mac": {
     "hardenedRuntime": true,
     "gatekeeperAssess": false,
     "notarize": { "teamId": "<你的 TeamID>" }
   }
   ```
   公证凭据通过环境变量提供:`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。
4. 重新 `npm run dist:mac` 即产出已签名、已公证的 `.dmg`,无需改动任何代码。

> 签名/公证与「上架 App Store」是两回事:公证只是让 Apple 盖一个"扫描过、无恶意软件"的章,分发渠道仍是你自己的 GitHub Releases。

### 自动更新

`src/main/updater.ts` 已接 `electron-updater`(运行时探测:未打包 / 未装依赖时降级为 no-op,绝不静默下载)。启用真实自动更新:把 `package.json` 的 `build.publish` 里占位 URL 换成真实发布地址(generic 静态服务器或 github provider),发版时用 `electron-builder --publish always` 上传 `latest-mac.yml` + 安装包即可。查到新版本只**通知**,下载/安装由用户在 UI 显式确认。

## 架构

```
src/
  shared/types.ts        主/渲染进程共享类型(IPC 协议、事件模型)
  main/
    index.ts             应用生命周期与窗口
    agentSession.ts      单会话封装:一个长驻的 Agent SDK query(流式输入)
    sessionManager.ts    多会话注册表 + 事件广播 + 历史持久化
    ipc.ts               类型化 IPC handler
    settings.ts/history.ts  userData 下的 JSON 持久化
    pushable.ts          可推送 AsyncIterable(SDK 流式输入通道)
  preload/index.ts       contextBridge 暴露 window.agentDesk
  renderer/src/          React UI(zustand 状态,事件驱动渲染)
```

主进程通过 `@anthropic-ai/claude-agent-sdk` 的流式输入模式维持每个会话的长驻 agent 进程;
`canUseTool` 回调把权限决策转发到 UI;`includePartialMessages` 提供逐字流式;
`resume` 支持跨重启恢复会话上下文。

## 参与贡献

CaoGen 是开源项目,欢迎任何形式的参与:

- 🐛 **提 Issue** — bug、功能建议、使用问题都欢迎
- 🔧 **提 PR** — 修 bug、加功能、完善文档;请先跑通 `npm run typecheck` 和 `npm run build`
- 💡 **方向讨论** — 路线图见 [ROADMAP.md](./ROADMAP.md),需求规格见 [REQUIREMENTS.md](./REQUIREMENTS.md)

开发约定:主/渲染进程共享类型集中在 `src/shared/types.ts`;新增能力遵循「主进程模块 → IPC → preload → 类型 → store → UI」六环链路;保持中英双语文案(`src/renderer/src/i18n.ts`)。

## 开源许可

本项目基于 [MIT License](./LICENSE) 开源。你可以自由使用、修改、分发(含商用),只需保留版权与许可声明。

---

<sub>CaoGen · 国产原创 AI 编码桌面工作室 · 以 Claude Agent SDK 为默认引擎,多厂商可配置</sub>
