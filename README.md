<div align="center">

<p><strong>简体中文</strong> | <a href="./README.en.md">English</a></p>

<img src="./resources/icon.png" alt="CaoGen" width="96" height="96">

# CaoGen

## 多厂商 AI 工作桌面——用你自己的 key 跑所选模型，一个服务不可用时按策略切换。

<img src="https://img.shields.io/badge/version-v0.1.6-blue" alt="version">
<img src="https://img.shields.io/badge/license-AGPL--3.0--only-green" alt="AGPL-3.0-only">
<img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux%20build-lightgrey" alt="platform">
<img src="https://img.shields.io/badge/Electron-40-informational" alt="Electron 40">
<img src="https://img.shields.io/badge/PRs-welcome-brightgreen" alt="PRs welcome">

[下载](https://github.com/ChaoYuZhang001/CaoGen/releases) · [快速开始](#quick-start) · [贡献](#贡献-caogen) · [路线图](#roadmap--长期愿景建设中)

![CaoGen 主界面](./docs/screenshot-app.jpg)

</div>

## 这是什么

CaoGen 是一个开源、厂商中立、本地优先的 AI 工作桌面，把多厂商模型、你的本地项目和完成任务所需的工具放在同一个 Electron 应用里。用户使用自己的 API Key，Provider 是可替换的算力，项目目录、worktree、工具与审查流程留在自己的桌面工作流中。

CaoGen 面向需要完成真实任务的用户，把多模型、多项目、多文件、多任务、多工具统一到一个可审查的本地工作区。

> “所选模型”指通过 CaoGen 当前支持的 OpenAI-compatible、Anthropic Messages 或可选 Agent SDK 路径接入；实际可用性取决于模型服务的协议兼容性、账号、网络和额度。

| 能力 | CaoGen 当前实现 | 证据边界 |
|---|---|---|
| Provider 与模型 | 多 Provider、BYOK、自定义兼容服务 | 只保证已配置且协议兼容的目标 |
| 故障恢复 | 备用 Key 与已配置 Provider 间的受控 failover | 外部账号、网络和额度仍可能阻断请求 |
| 本地工作流 | 本地项目、Git worktree、Diff、终端和文件工具 | 高风险操作仍受权限与验收门禁约束 |
| 开放性 | AGPL-3.0-only 开源并提供独立商业授权 | 当前公开安装包仍未完成正式签名/公证 |

这张表只描述当前产品结构，不表示所有模型、Provider 或外部网络条件都已验证；精确边界见 [STATUS.md](./STATUS.md)。

## 当前进展

截至 2026-07-23，PRD 64 个 P0 = 21 个已验证 + 17 个部分完成 + 25 个立项目标 + 1 个仅达到基础。这个口径来自 [1.0 验收矩阵](./docs/1.0-ACCEPTANCE-MATRIX.md)，不是版本完成率；`0.1.7` 仍是签名楔子候选，不是 1.0 stable。

## 当前核心能力

- **连接多种 Provider 并 BYOK**：配置多个 Provider、多个 API Key、自定义 Base URL、中转站或本地 OpenAI-compatible 服务，覆盖 DeepSeek、Kimi、GLM 等常见兼容模型来源。
- **按策略路由并自动切换**：根据模型能力、成本、速度、预算与健康状态选择目标；遇到额度、限流、服务端或网络类可恢复错误时，先尝试备用 Key，再切到已配置的健康 Provider。
- **隔离任务改动**：为会话创建独立 Git worktree，在合并前查看 Diff、检查冲突、导出或应用 patch，不满意可以直接丢弃隔离工作区。
- **在工作台完成任务**：在应用内使用终端、文件浏览、文本编辑、浏览器、Diff、Git，以及 HTML/Markdown/JSON/CSV/图片/PDF/Office 文档预览。
- **查看 3D 办公区**：用真实会话状态展示运行、等待审批、完成、失败、Provider、成本、子任务与 worktree/Git 信号；当前发布的是机器人办公区，不是路线图中的水墨角色形态。

![CaoGen 3D 办公区](./docs/screenshot-office.jpg)

## Quick Start

1. **下载**：从 [GitHub Releases](https://github.com/ChaoYuZhang001/CaoGen/releases) 选择与你的平台和架构匹配的资产。当前公开发布以 macOS x64 v0.1.6、Windows x64 v0.1.5 和较早的 macOS arm64 资产为主；Linux 暂以源码运行或自行构建为主。
2. **添加 Provider 和 Key**：打开设置，选择 Provider 模板或填写兼容服务的 Base URL，再添加你自己的 API Key。密钥不会提交到本仓库。
3. **开始第一个任务**：新建会话，选择本地项目目录或使用“未关联项目”，然后输入：`先阅读这个项目，告诉我启动方式、关键入口和最值得修的 3 个问题；先不要改代码。`

> 当前公开安装包未完成正式签名/公证。macOS 和 Windows 首次打开可能显示系统安全提示；请仅从本项目 Releases 下载并核对对应 Release 说明。正式 1.0 验收和发布准备状态以 [STATUS.md](./STATUS.md) 为准。

从源码运行：

```bash
git clone https://github.com/ChaoYuZhang001/CaoGen.git
cd CaoGen
npm install
npm run dev
```

## Roadmap / 长期愿景（建设中）

CaoGen 的长期方向是厂商中立的 Agent Work OS：用持久的 Goal、WorkItem、数字员工、Artifact/Evidence、验收和恢复机制承载完整工作流，并继续演进 3D 办公体验。这些是路线图和建设目标，不等于当前已发布能力；请查看 [唯一执行计划](./docs/PLAN.md)、[项目立项书](./docs/PROJECT-CHARTER.md)、[产品需求](./docs/PRODUCT-REQUIREMENTS.md) 与 [当前状态](./STATUS.md) 了解边界和进度。

## 贡献 CaoGen

**我们在找志同道合的人，一起把“厂商中立、本地优先的 AI 工作桌面”做成真正可靠的开源基础设施。**

- 阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)，了解开发环境、六环架构链路和 PR 流程。
- 从 [good first issue 草稿](./docs/good-first-issues.md) 或 GitHub 的 [good first issue](https://github.com/ChaoYuZhang001/CaoGen/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22good%20first%20issue%22) 开始。
- 提交 [Bug](https://github.com/ChaoYuZhang001/CaoGen/issues/new?template=bug_report.yml)、[功能建议](https://github.com/ChaoYuZhang001/CaoGen/issues/new?template=feature_request.yml) 或 Pull Request。

安全问题请按 [SECURITY.md](./SECURITY.md) 私下报告。CaoGen 采用 [AGPL-3.0-only](./LICENSE) 开源许可，并提供独立的 [商业授权](./COMMERCIAL-LICENSE.md)。
