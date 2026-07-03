# AgentDesk

多会话并行的桌面 AI 编码 Agent。以 Claude Agent SDK 为引擎(与 Claude Code 同源),在桌面层提供 CLI 给不了的体验:

- **多会话并行** — 同时在多个项目上运行 Agent,侧栏一键切换,互不阻塞
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
