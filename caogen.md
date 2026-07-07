# 项目概述

CaoGen 是 Electron + React + TypeScript 桌面 AI 编码 Agent。主进程在 `src/main`，渲染进程在 `src/renderer/src`，共享类型在 `src/shared`，插件位于 `plugins`，自动化验证脚本位于 `scripts`。

# 代码规范

- 优先保持现有 TypeScript 模块风格，不引入无关框架。
- 修改已有文件时优先使用 `search_replace` 或小范围补丁，避免全文件覆写。
- 新增运行时数据应写入 `.caogen`、`test-results` 或系统临时目录，并确保不污染 git 状态。
- 不要把真实 API key、webhook、token、账号凭据写入仓库。

# 常用命令

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd run test:deep
npm.cmd run test:p2-required
```

# 测试要求

- P0/P1/P2 能力补全后至少运行对应 targeted smoke。
- 发布级判断必须区分 smoke 通过、required gate 通过、外部真实凭据/真实 IDE/真实网络验证通过。
- `test:p2-required` 失败时应保留 `test-results/p2-required/latest.json` 作为外部阻塞证据。

# 注意事项

- `test-results/` 和 `.caogen` 运行态缓存不是源码交付物。
- 中国真实网络、国产模型工具调用 parity、JetBrains 真实 IDE 交互需要外部凭据或本机软件证据，不能用普通 smoke 代替。
- 在工作树已有大量未提交改动时，不要回滚非本轮修改。
