# D0 首任务引导 · QA 门禁结论

**当前刷新**: 2026-07-31
**整体判定**: 定向 Node 行为门禁通过；当前 Electron、真人首任务和 clean release 证据仍开放，因此 D0/M2-T2 不作完整关闭。

## 当前已验证

- `test-results/first-task-onboarding/2026-07-31T08-31-41-212Z/report.json` 以 `15/15` 通过，绑定 `b37c17cf8dea` 和 421 项 dirty worktree。
- 首任务提交改为 renderer module 级互斥；并发第二次提交不会创建 Session 或发送 prompt，失败后锁会释放并允许显式重试。
- 六态投影先识别候选 Session 的 `starting/running`，不会被 Provider 水合状态覆盖；`error` 不再误报 `running`，Workbench 为当前失败候选提供显式“重新开始”入口。
- `createSession` 和 `startSessionWithPrompt` 返回确定的 Session ID；首条消息定向发送到该 ID，Welcome 直接用返回值登记候选，不再在 await 后读取可能已变化的全局 `activeId`。
- 完成判定绑定当前候选 Session；用户重新开始后才返回的旧 Result 快照不会重新写入新的空 onboarding 记录。
- reload 行为门禁从持久记录恢复 `running` 投影，并断言模块加载不会新增 create/send 调用；onboarding storage 和机器报告均拒绝 prompt、路径、token 与 Provider canary。
- 当前 `npm run typecheck`、`npm run build`、`npm run test:first-task-onboarding` 和范围内 `git diff --check` 通过。

## 当前未验证

- 15/15 是生产 helper + 源码合同的 Node 行为门禁，不是 Electron 鼠标双击、连续 Enter、真实 reload 或视觉布局证据。
- 当前源码的 `test:studio-surface`、`test:acceptance-policy-ui`、`test:assistant-studio-consistency` 与首任务 Electron required gate未在本轮重跑。
- 无真人 60 秒/30 分钟首任务成功、失败恢复可用性、真实 Provider、本地模型全矩阵或 clean release 绑定。

## 历史问题校正

2026-07-30 记录的 `desktop Acceptance row missing` 已定性为测试等待竞态；测试应等待异步 `WorkflowAcceptanceRow` 可见。该旧记录中的 typecheck 失败和 Electron 二进制诊断不再作为当前源码结论，当前边界以上述 2026-07-31 定向重跑为准。
