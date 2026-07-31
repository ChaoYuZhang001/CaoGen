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
- 在开始录制前明确同意主持人私下录屏；录屏、真实项目名和本地路径不公开、不提交仓库。

可直接发送的招募文案：

> 招募 1 位使用 AI 工作工具的 Intel Mac 用户，帮忙做一次不超过 30 分钟的 CaoGen
> 首次安装测试。你会从官网下载安装包，用自己的 Provider Key 完成一个只读项目问答。
> 我们不会索取或记录 Key；录屏只用于本次 M1 验收和定位 onboarding 卡点，不公开，
> 验收与问题提取完成后尽快删除且最迟保留 30 天。开始录制前会再次说明范围并征得你的明确同意。
> 测试中请像真实新用户一样操作，
> 看不懂就停下来说明，不要替产品猜答案。

## 主持人准备

1. 在仓库外选择一个全新的绝对路径，运行下方准备命令；生成目录权限为 `0700`，记录和清单权限为 `0600`。
2. 向测试者说明录屏用途、内容范围、脱敏方式和 `deleteBy`，在开始录制前取得明确同意并记录时间；不同意则不录制，也不能把该次记录计为 M1 通过。
3. 确认录屏不会包含 API Key、通知、真实私库名或可访问的私有 URL。
4. 让测试者准备一个允许只读分析的本地项目；不要使用 CaoGen 仓库。
5. 不预装 CaoGen，不提前展示界面，不口头讲解按钮位置。
6. 录制“关于本机”或等价系统信息，证明机器为 Intel；开始计时前打开浏览器空白页。

```bash
npm run prepare:m1-first-user-drill -- \
  --evidence-dir /absolute/private/path/CaoGen-M1-Evidence
```

准备命令拒绝相对路径、仓库内路径、符号链接、非空目录和覆盖写入。它只生成私有 JSON 模板与
`HOST-CHECKLIST.txt`，不会提前下载 DMG、创建占位证据或替测试者完成任何计时步骤。

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

### 同意、用途、脱敏与删除

- 唯一允许用途是 `m1_onboarding_acceptance_and_friction_review`：证明 M1 首次使用结果，并把真实卡点整理成不含个人信息的修复项。不得用于宣传、公开演示、模型训练或其他目的。
- `screenRecordingConsent` 只有在测试者听完上述范围并明确同意后才能设为 `true`；`consentRecordedAt` 必须不晚于开始时间。测试者可在录制过程中要求停止。
- 停止计时后，主持人必须检查录屏和全部证据，移除 Key、Provider URL、真实路径、通知及无关桌面内容；只在复核完成后设置 `redactionReviewCompleted: true` 和 `redactionReviewedAt`。原始未脱敏副本不得继续保留。
- `maximumRetentionDays` 不得超过 30，`deleteBy` 必须晚于测试结束且不晚于结束后 30 个日历日。验收和问题提取完成后应提前删除，不必等到最后一天，也不得保留备份。
- 文件仍存在或审计尚未完成时，`deletionStatus` 必须是 `scheduled`、`deletedAt` 必须是 `null`。不能为了让记录看起来合规而提前声称已经删除；审计器会拒绝这种矛盾状态。
- 删除 DMG、录屏和四份证据后，才可在私有生命周期记录中标记实际删除时间。删除后的记录不能再次冒充一份仍可审计的 M1 证据包。

## 审计命令

按私有目录中的 `HOST-CHECKLIST.txt` 收齐真实文件并填写 `m1-first-user.json`。下方路径仅为示例，
必须替换成准备命令实际输出的仓库外绝对路径。

通过记录使用 fail-closed 门禁：

```bash
npm run test:m1-first-user-onboarding:required -- \
  --record /absolute/private/path/CaoGen-M1-Evidence/m1-first-user.json \
  --expected-release-tag v0.1.7 \
  --expected-candidate-commit bbec526554aea9785291edf4d8164084145347ae \
  --expected-asset-sha256 a6b65ddd7d11bc8aab36cd800a7ddd9055b562d5aa85b39ef0296fb9c4f78a7b
```

未完成、超时、需要主持人帮助、出现安全绕过或存在 blocker 的记录，使用观察模式保存：

```bash
npm run test:m1-first-user-onboarding -- \
  --observation \
  --record /absolute/private/path/CaoGen-M1-Evidence/m1-first-user.json \
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

招募可以保留简短候补名单，字段仅限 Intel 机型/年份、时区和可参与时间；不要收集 Key、Provider URL、项目路径或证据。候补不算参与者，也不算真人验收结果。
