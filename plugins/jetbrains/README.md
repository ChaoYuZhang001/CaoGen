# CaoGen JetBrains Bridge

P2-005 JetBrains 插件当前是 prototype-only 的轻量闭环，用于验证 JetBrains IDE 可以通过本机 CaoGen IDE bridge 创建会话、发送选区、请求选区修改并接收 `session.event` 回流。

## 前置条件

- CaoGen 桌面端必须显式开启 IDE bridge；bridge 默认关闭。
- 默认地址为 `ws://127.0.0.1:17365/ide-bridge`。
- 当前 prototype 使用 `BridgeSettings` 默认值；URL/token 的 Settings UI 仍需后续补齐。

## 可验证动作

- `CaoGen: Connect/Create Session`: 连接 bridge，完成 hello 握手，创建当前项目会话，并可把当前选区作为初始消息发送。
- `CaoGen: Send Selection`: 将当前选区发送到 active session。
- `CaoGen: Edit Selection`: 发送选区修改请求，要求模型返回完整替换代码，并记录本次选区范围。
- `CaoGen: Preview Selection Diff`: 使用 JetBrains Diff 预览最近一次 CaoGen 替换建议。
- `CaoGen: Apply Selection Edit`: 通过 `WriteCommandAction` 应用最近一次替换建议，可用 IDE 原生 undo 回退。
- `CaoGen: Show Events`: 展示最近收到的 `session.event` 文本。
- `CaoGen: Open Desktop`: 通过 `caogen://ide-bridge` URI 请求打开桌面端当前项目。

## 本地验证

JetBrains 2024.2 平台要求 JDK 21；如果使用 portable 工具链,请先把 `JAVA_HOME` 指向 JDK 21。

```powershell
npm.cmd run test:ide-bridge
Push-Location plugins\jetbrains
if (Test-Path .\gradlew.bat) { .\gradlew.bat buildPlugin } else { gradle buildPlugin }
Pop-Location
```

## Realtime Sync v1

- Disabled by default. Use `CaoGen: Toggle Realtime Sync` to attach the current local editor document.
- The plugin debounces document changes and sends `ide-sync-v1` snapshots through the passive `documents.sync` bridge protocol.
- v1 is prototype-only context sync and has not been verified by a real JetBrains IDE install test in this workspace.

本机如果没有 Gradle wrapper、系统 `gradle` 或已下载的 Gradle/JDK 21 工具链，只能完成静态 smoke；不能宣称 JetBrains 插件已本机编译。

## prototype-only 边界

- 未实现正式 Settings UI。
- 未实现完整会话选择面板和工具窗口 UI。
- 未实现断线自动重连与插件发布签名。
- 未做 JetBrains IDE 真机安装验证。
- 当前 apply/diff 基于最近一次 `session.event.text`，复杂多轮回复仍需人工确认后再应用。
