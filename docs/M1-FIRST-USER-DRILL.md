# M1 首位陌生用户验收

> 目标：一名非项目参与者从 `caogen.dev` 下载 v0.1.7 macOS Intel x64 DMG，
> 不使用安全绕过命令完成安装和首次启动，并在 30 分钟内按公开 Quick Start
> 配置自己的 Provider、完成第一个只读项目任务。

这项验收关闭的是 M1 的“交到陌生人手里”判据，不等于 M2 的 3 人 N1 迁移证据，
也不等于 10 用户、留存或 1.0 stable。Apple Silicon 与 Windows 不在本轮范围内。

## 测试者条件

- 没有参与 CaoGen 开发，也没有用过 CaoGen。
- 使用 Intel Mac，系统架构记录为 `x86_64`。
- 已有可用的 OpenAI-compatible 或 Anthropic Messages Provider 账号和 API Key。
- 愿意让主持人私下录制屏幕；录屏、真实项目名和本地路径不公开、不提交仓库。

可直接发送的招募文案：

> 招募 1 位使用 AI 工作工具的 Intel Mac 用户，帮忙做一次不超过 30 分钟的 CaoGen
> 首次安装测试。你会从官网下载安装包，用自己的 Provider Key 完成一个只读项目问答。
> 我们不会索取或记录 Key；录屏只用于私下定位卡点，不公开。测试中请像真实新用户一样操作，
> 看不懂就停下来说明，不要替产品猜答案。

## 主持人准备

1. 新建私有证据目录，复制 [结果模板](./M1-FIRST-USER-RESULT.template.json)。
2. 确认录屏不会包含 API Key、通知、真实私库名或可访问的私有 URL。
3. 让测试者准备一个允许只读分析的本地项目；不要使用 CaoGen 仓库。
4. 不预装 CaoGen，不提前展示界面，不口头讲解按钮位置。
5. 录制“关于本机”或等价系统信息，证明机器为 Intel；开始计时前打开浏览器空白页。

## 计时流程

测试者只能使用官网、公开 Quick Start 和应用内可见引导。主持人只记录，不代操作、不提示下一步。

| # | 步骤 | 完成判据 |
|---|---|---|
| 1 | 打开官网 | 从 `https://caogen.dev/` 找到 v0.1.7 下载入口 |
| 2 | 下载 Intel DMG | 下载文件名为 `CaoGen-0.1.7.dmg`，不从聊天或私发链接下载 |
| 3 | 安装并启动 | 拖入 Applications 并正常打开；不使用 `xattr`、关闭 Gatekeeper 或其他绕过命令 |
| 4 | 配置 Provider | 仅在应用内输入测试者自己的 Key；主持人和录屏都不得看到 Key |
| 5 | 完成只读任务 | 选择本地项目，使用 Quick Start 提示词得到有用回答，确认文件和 Git 状态无变化 |

Quick Start 提示词 ID 为 `quick_start_project_read_only_v1`，正文保持与 README 一致：

```text
先阅读这个项目，告诉我启动方式、关键入口和最值得修的 3 个问题；先不要改代码。
```

停止计时后，记录每步用时、卡点和体感毛刺。失败同样是有效研究结果，不要帮助用户补跑后
把它改写成一次通过；修复卡点后应新建另一份记录重新测试。

## 私有证据

结果 JSON 必须引用四个真实、非符号链接、非空文件：

- 完整屏幕录制。
- Intel 架构证据。
- 已安装应用的版本/候选身份证据。
- 只读任务完成且零文件修改的截图或导出证据。

另保留测试者实际下载的 DMG。审计器会流式计算 DMG 和四份证据的 SHA-256，但公开报告会删除
测试者身份、路径、项目名、Provider 身份、提示词、备注、卡点和毛刺文本。

禁止在结果 JSON 中加入 `apiKey`、`token`、`secret`、`password`、`baseUrl`、Provider URL、
真实项目路径或私库地址。记录和录屏只放私有证据目录，不提交到 Git。

## 审计命令

先复制模板并填写：

```bash
cp docs/M1-FIRST-USER-RESULT.template.json /private/evidence/m1-first-user.json
```

通过记录使用 fail-closed 门禁：

```bash
npm run test:m1-first-user-onboarding:required -- \
  --record /private/evidence/m1-first-user.json \
  --expected-release-tag v0.1.7 \
  --expected-candidate-commit bbec526554aea9785291edf4d8164084145347ae \
  --expected-asset-sha256 a6b65ddd7d11bc8aab36cd800a7ddd9055b562d5aa85b39ef0296fb9c4f78a7b
```

未完成、超时、需要主持人帮助、出现安全绕过或存在 blocker 的记录，使用观察模式保存：

```bash
npm run test:m1-first-user-onboarding -- \
  --observation \
  --record /private/evidence/m1-first-user.json \
  --expected-release-tag v0.1.7 \
  --expected-candidate-commit bbec526554aea9785291edf4d8164084145347ae \
  --expected-asset-sha256 a6b65ddd7d11bc8aab36cd800a7ddd9055b562d5aa85b39ef0296fb9c4f78a7b
```

观察模式的成功退出只表示记录结构和证据文件可审计；报告状态是 `observed_failed`，不会被算成
M1 通过。只有 required 命令输出 `status: passed` 才能关闭首位陌生用户验收。

## 结果处理

- `passed`：M1 首位陌生用户完成，可进入 M2 的 3 人 N1 迁移计时。
- `observed_failed`：按卡点建立 onboarding 修复项，修复后换一名或重新安排同一测试者跑新记录。
- `failed`：记录结构、证据完整性、发布绑定或通过条件不成立；不得更新 PLAN 为完成。
