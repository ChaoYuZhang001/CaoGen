<div align="center">

<p><strong>简体中文</strong> | <a href="./README.en.md">English</a></p>

<img src="./resources/icon.png" alt="CaoGen" width="96" height="96">

# CaoGen

## 用你自己的 Key，在本地让 AI 完成真实工作；服务不可用时按策略切换，改动全程可审查。

<img src="https://img.shields.io/badge/release-v0.1.8-blue" alt="latest public release v0.1.8">
<img src="https://img.shields.io/badge/source-main-informational" alt="current source branch main">
<img src="https://img.shields.io/badge/license-AGPL--3.0--only-green" alt="AGPL-3.0-only">
<img src="https://img.shields.io/badge/macOS-Intel%20x64%20signed-success" alt="macOS Intel x64 signed and notarized">
<img src="https://img.shields.io/badge/release%20Electron-40.10.2-informational" alt="v0.1.8 uses Electron 40.10.2">
<img src="https://img.shields.io/badge/source%20Electron-41.10.3-informational" alt="current source uses Electron 41.10.3">
<img src="https://img.shields.io/badge/PRs-welcome-brightgreen" alt="PRs welcome">

[下载](https://github.com/ChaoYuZhang001/CaoGen/releases) · [快速开始](#quick-start) · [讨论](https://github.com/ChaoYuZhang001/CaoGen/discussions) · [贡献](#贡献-caogen) · [路线图](#roadmap--长期愿景建设中)

![CaoGen 主界面](./resources/screenshots/app.jpg)

</div>

## CaoGen 能帮你做什么

CaoGen 是一个开源、厂商中立、本地优先的多厂商 AI 工作桌面。用户使用自己的 API Key 连接已配置的模型服务商，在一个桌面里处理多模型、多项目、多文件、多任务、多工具；服务异常时按策略尝试备用 Key 或兼容服务，项目、记录和审查流程仍由 CaoGen 持有。

它面向两类人：

- **想用 AI 完成日常工作的人**：整理资料、写文档、做研究、处理表格和检查最终产物，不必先理解模型路由、Git 或任务图。
- **管理多项目和多把 Key 的专业用户**：在同一工作台查看会话、终端、文件、浏览器、Diff、Git、worktree、成本和审批。

当前公开版本可以：

- 配置多个模型服务商、API Key、自定义接口地址和本地兼容服务。
- 按任务、成本、速度、质量和健康状态选择执行路径，并记录切换原因。
- 在独立 Git worktree 中执行改动，合并前检查 Diff、冲突、测试和 Patch。
- 在应用内使用终端、文件、浏览器、Git，以及 PDF、图片和 Office 文档预览。
- 用 3D 办公区查看真实会话、审批、失败、成本和工作区状态。

## 一个内核，三个工作入口

当前 `main` 的开发版界面固定为三个业务入口。它们共享会话、项目和运行状态，切换入口不会复制任务：

| 入口 | 适合做什么 | 核心操作 |
|---|---|---|
| **助手** | 快速问答、联网研究、写作、读图和日常任务 | 对话、附件、模型与权限控制 |
| **项目工作台** | 长任务、代码、文件、终端、Git、Diff、计划和交付检查 | 项目、WorkItem、工具面板与结果工作台 |
| **视频工作室** | 脚本、分镜、素材、预览、修改和导出 | 制作、任务、素材、Provider 与输出状态 |

3D 办公区是跨入口的运行总览，投影真实会话、任务状态、审批、失败、Provider、成本、worktree 和 Git 状态；它不是第四个业务入口。

## 当前状态

`v0.1.8` 是当前公开正式版本；`main` 包含尚未发布的开发改动。正式可用范围以 GitHub Releases 中对应版本的说明和校验值为准，未发布代码不视为稳定能力。

> **源码与发布包边界**：公开的 `v0.1.8` Intel x64 安装包固定使用 Electron `40.10.2`。当前 `main` 源码已进入 Electron `41.10.3` 和依赖安全更新验证，但尚未形成新的正式发布；这批变更通过 clean candidate 门禁后必须使用后续补丁版本，不能覆盖或重发 `v0.1.8`。

> **首位陌生用户验收仍开放**：目标是在不超过 30 分钟内从官网安装受支持的发布资产、配置自己的 Provider，并完成一个只读任务。参与条件、隐私边界和报名方式见 [Discussion #9](https://github.com/ChaoYuZhang001/CaoGen/discussions/9)；请勿公开任何 Key、Provider URL 或项目路径。

![CaoGen 3D 办公区](./resources/screenshots/office.jpg)

## Quick Start

| 平台 | 当前入口 | 信任状态 |
|---|---|---|
| macOS Intel x64 | [v0.1.8 DMG / ZIP](https://github.com/ChaoYuZhang001/CaoGen/releases/tag/v0.1.8) | Developer ID 签名、Apple 公证并已 staple |
| Windows x64 | 暂无现行 v0.1.8 安装包 | 历史 unsigned preview 不是当前正式发布 |
| macOS Apple Silicon / Linux | 暂无现行安装包 | 从源码构建 |

1. **下载并核对来源**：只使用本仓库的 GitHub Releases，并按 Release Notes 核对 SHA-256。
2. **添加 Provider 和 Key**：打开设置，选择 Provider 模板或填写兼容服务的 Base URL，再添加你自己的 API Key。密钥不会提交到本仓库。
3. **开始第一个任务**：打开助手直接输入：`先阅读这个项目，告诉我启动方式、关键入口和最值得修的 3 个问题；先不要改代码。` 项目关联是可选的，需要长流程时再进入项目工作台。

> macOS 与 Windows 的签名状态不同；每个平台的签名和信任状态以对应 GitHub Release 的说明为准。

从源码运行：

```bash
git clone https://github.com/ChaoYuZhang001/CaoGen.git
cd CaoGen
npm install
npm run dev
```

## Roadmap / 长期愿景（建设中）

CaoGen 的长期方向是厂商中立的 Agent Work OS：用持久的 Goal、WorkItem、数字员工、Artifact/Evidence、验收和恢复机制承载完整工作流，并继续演进 3D 办公体验。这些是建设方向，不等于当前已发布能力；公开进展以 GitHub Releases、Issues 和 Discussions 为准。

## 贡献 CaoGen

**我们在找志同道合的人，一起把“厂商中立、本地优先的 AI 工作桌面”做成真正可靠的开源基础设施。**

- 阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)，了解开发环境、六环架构链路和 PR 流程。
- 从 GitHub 的 [good first issue](https://github.com/ChaoYuZhang001/CaoGen/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22good%20first%20issue%22) 开始。
- 在 [GitHub Discussions](https://github.com/ChaoYuZhang001/CaoGen/discussions) 分享使用反馈、提问或讨论改进建议；入口选择和 48 小时首次回应承诺见 [SUPPORT.md](./SUPPORT.md)。
- 提交 [Bug](https://github.com/ChaoYuZhang001/CaoGen/issues/new?template=bug_report.yml)、[功能建议](https://github.com/ChaoYuZhang001/CaoGen/issues/new?template=feature_request.yml) 或 Pull Request。

安全问题请按 [SECURITY.md](./SECURITY.md) 私下报告。CaoGen 采用 [AGPL-3.0-only](./LICENSE) 开源许可，并提供独立的 [商业授权](./COMMERCIAL-LICENSE.md)。
