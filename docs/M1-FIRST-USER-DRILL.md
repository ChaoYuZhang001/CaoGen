# M1 首位陌生用户验收

目标：一名未参与项目、从未使用 CaoGen 的 Intel Mac 用户从 `https://caogen.dev/`
下载 v0.1.8 macOS x64 DMG，在不使用安全绕过命令的前提下完成安装、Provider 配置和一个
只读项目任务。该验收用于发现首次使用卡点，不代表 1.0 stable 或其他平台的发布结论。

## 测试者条件

- 非 CaoGen 项目参与者，且是首次使用 CaoGen。
- 使用 Intel Mac，架构记录为 `x86_64`。
- 自备 OpenAI-compatible 或 Anthropic Messages Provider；主持人和录屏不得看到 Key。
- 录屏前明确说明用途、脱敏和删除期限，并取得明确同意。

## 主持人准备

在仓库外选择新的绝对路径，运行：

```bash
npm run prepare:m1-first-user-drill -- \
  --evidence-dir /absolute/private/path/CaoGen-M1-Evidence
```

准备命令只生成权限为 `0700`/`0600` 的私有模板和清单；它不会下载 DMG、创建占位证据或代替
测试者操作。不要把私有证据目录提交、上传或粘贴到 Issue、Discussion 或聊天中。

## 计时流程

测试者只能使用官网、公开 Quick Start 和应用内引导；主持人只记录，不提示按钮位置或代操作。

1. 从 `https://caogen.dev/` 找到 v0.1.8 下载入口。
2. 下载 `CaoGen-0.1.8.dmg`，不得使用聊天或私发链接。
3. 拖入 Applications 并正常启动；不得使用 `xattr`、关闭 Gatekeeper 或其他绕过命令。
4. 只在应用内输入测试者自己的 Provider Key。
5. 使用 Quick Start 提示词完成只读项目问答，确认文件和 Git 状态无变化。

Quick Start 提示词 ID：`quick_start_project_read_only_v1`。建议正文：

```text
先阅读这个项目，告诉我启动方式、关键入口和最值得修的 3 个问题；先不要改代码。
```

记录每步用时、卡点和体感毛刺。失败或需要帮助的结果也要保留为观察记录，不要帮助测试者补跑
后改写成通过。

## 私有证据与治理

结果 JSON 必须引用四个真实、非符号链接、非空文件：完整屏幕录制、Intel 架构证据、已安装应用
身份证据、只读任务完成且零文件修改的证据；另保留测试者实际下载的 DMG。不得写入 API key、token、
secret、password、Provider URL、真实项目路径或私库地址。

证据唯一用途是 `m1_onboarding_acceptance_and_friction_review`。录制前设置
`screenRecordingConsent` 并记录时间；结束后先完成脱敏复核，再设置
`redactionReviewCompleted`。`maximumRetentionDays` 不得超过 30，证据仍存在或审计未完成时
`deletionStatus` 必须为 `scheduled` 且 `deletedAt` 为 `null`。问题提取完成后删除 DMG、录屏和
证据文件，不保留备份。

## 审计命令

通过记录使用：

```bash
npm run test:m1-first-user-onboarding:required -- \
  --record /absolute/private/path/CaoGen-M1-Evidence/m1-first-user.json \
  --expected-release-tag v0.1.8 \
  --expected-candidate-commit 9a00bb92e1bed90a6dbf644790d4c253375cef4a \
  --expected-asset-sha256 e0362fc3fda196259a5c6b782eedcf62cbf45eaaea36336bb3eba4afc617553d
```

未完成、超时、需要帮助或存在 blocker 的记录使用观察模式：

```bash
npm run test:m1-first-user-onboarding -- --observation \
  --record /absolute/private/path/CaoGen-M1-Evidence/m1-first-user.json \
  --expected-release-tag v0.1.8 \
  --expected-candidate-commit 9a00bb92e1bed90a6dbf644790d4c253375cef4a \
  --expected-asset-sha256 e0362fc3fda196259a5c6b782eedcf62cbf45eaaea36336bb3eba4afc617553d
```

只有 required 命令输出 `status: passed` 才能关闭 M1；观察结果用于建立 onboarding 修复项，
不能替代真人验收。
