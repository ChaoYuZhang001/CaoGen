# CaoGen

多会话并行的桌面 AI 编码 Agent。目标是**超越 Codex、Claude Code、Marvis 等桌面端 Agent**:多厂商模型可配置、指定运行或智能自动调度、每个 Agent 用 Git worktree 隔离、并行会话以写实 3D 办公区呈现,并补齐深度用户迁移所需的检查点回溯、子代理编排、内置浏览器批注、插件生态、产物预览、自动化与主动建议——完整目标与里程碑见 [ROADMAP.md](./ROADMAP.md)。

当前以 Claude Agent SDK 为引擎(与 Claude Code 同源),在桌面层提供 CLI 给不了的体验:

> **多厂商 / OpenAI 格式接入**:引擎讲 Anthropic Messages API 协议。要接入 OpenAI / Gemini / 国产模型,在设置里添加一个指向 **Anthropic 兼容网关**(one-api、new-api、LiteLLM 等)的 Provider 即可——已内置网关预设模板,填入网关地址与密钥,选模型开工。原生(不经网关)多引擎见 ROADMAP 的 M6。


- **多会话并行** — 同时在多个项目上运行 Agent,侧栏一键切换,互不阻塞
- **Worktree 隔离** — 每个 Agent 默认在独立 Git worktree 工作,互不污染主工作区
- **跨厂商故障切换** — 厂商余额耗尽/限流/宕机时自动切到健康厂商重试,任务不中断,切换过程在聊天流透明标注
- **多引擎架构** — Engine 接口 + 注册表(M6),Claude Agent SDK 为默认引擎,Codex/Gemini CLI 适配位已留好
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
