# Contributing to CaoGen

CaoGen 欢迎 Issue、讨论和 Pull Request。项目仍处于 beta 阶段，贡献的第一目标是让用户真实可用，其次才是扩展功能数量。

## 参与方式

- 提交 Bug：请说明系统版本、CaoGen 版本、复现步骤、预期结果、实际结果和相关日志。
- 提交功能建议：请说明目标用户、使用场景、为什么现有能力不够，以及你认为的最小可交付版本。
- 提交 PR：请让改动保持聚焦，一个 PR 解决一个明确问题。

安全漏洞、密钥泄露、供应链风险不要放在公开 Issue 的正文里，请按 [SECURITY.md](./SECURITY.md) 处理。

## 本地开发

```bash
git clone https://github.com/ChaoYuZhang001/CaoGen.git
cd CaoGen
npm install
npm run dev
```

项目使用 Electron + React + TypeScript。新增主进程能力时，通常需要按下面链路同步类型和 UI：

```text
src/main/* -> IPC -> src/preload/* -> src/shared/types.ts -> src/renderer/src/*
```

## 提交前检查

普通代码 PR 至少运行：

```bash
npm run typecheck
npm run build
npm run secret:scan
```

如果改动触及 Agent、工具调用、Git/worktree、浏览器、打包或发布链路，请额外运行相关脚本，常用命令包括：

```bash
npm run test:deep
npm run test:release-packaging-audit:required -- --version 0.1.3
npm run test:github-release-audit:required -- --tag v0.1.3
```

需要真实模型 Key 的端到端脚本请只在本机运行，不要把 Key、请求内容或私有仓库日志提交到 PR。

## PR 标准

- 保持改动范围清晰，避免把重构、格式化和功能修改混在一起。
- UI 改动需要说明用户路径，最好附截图或短录屏。
- 文档改动需要确认链接、版本号和安装说明仍然准确。
- 新增能力要写清楚风险边界，尤其是命令执行、文件写入、GUI 自动化、网络请求和自动合并。
- 不要提交 `dist/`、本地缓存、密钥、模型响应原文或含私有路径的大日志，除非维护者明确要求。

## Commit 风格

推荐使用简短的 Conventional Commit 前缀：

```text
feat: add provider health fallback
fix: prevent stale worktree merge state
docs: clarify macOS unsigned install
test: cover release asset audit
```

## 发布说明

发布相关 PR 需要同步检查：

- `package.json` 和 `package-lock.json` 版本号一致。
- README 的当前版本、平台支持和安装说明准确。
- Release 资产与校验和一致。
- macOS 未签名/未公证时必须在文档中明确说明。

感谢你让 CaoGen 变得更可靠。
