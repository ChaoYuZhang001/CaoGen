# CaoGen VS Code Bridge

P2-005 最小闭环插件,用于验证 VS Code 选中代码可以通过本机 CaoGen IDE bridge 发送到 CaoGen,并能接收 `session.event` 回流。

## 前置条件

- CaoGen 桌面端必须显式开启 IDE bridge。bridge 默认关闭。
- 默认地址为 `ws://127.0.0.1:17365/ide-bridge`。
- 如果 CaoGen 设置了 token,需要在 VS Code 设置 `caogen.bridgeToken` 中填入同一个 token。

## 可验证命令

- `CaoGen: Connect IDE Bridge`: 建立 WebSocket 连接并完成 token 握手。
- `CaoGen: Create Session`: 使用当前 workspace 路径创建会话,若编辑器有选区则作为首条消息发送。
- `CaoGen: List Sessions`: 拉取 CaoGen 会话并选择当前活动会话。
- `CaoGen: Send Selection`: 将当前选中代码发送到活动 CaoGen 会话。
- `CaoGen: Edit Selection`: 请求 CaoGen 返回当前选区的完整替换代码。
- `CaoGen: Preview Selection Diff`: 用 VS Code diff 预览待应用选区改动。
- `CaoGen: Apply Selection Edit`: 将最近一次选区改动应用回编辑器。
- `CaoGen: Open Desktop`: 通过 `caogen://ide-bridge` 打开桌面端当前项目。

事件回流会写入 VS Code 的 `CaoGen Bridge` Output Channel。

## 本地验证

```powershell
npm.cmd run test:ide-bridge
Push-Location plugins\vscode
npm.cmd install
npm.cmd run compile
Pop-Location
```

## Realtime Sync v1

- Disabled by default through `caogen.realtimeSync=false`.
- `CaoGen: Toggle Realtime Sync` sends debounced `[IDE_SYNC v1]` active-file snapshots to the active CaoGen session.
- v1 uses the passive `documents.sync` bridge protocol. It does not trigger a normal chat/model turn.

仍属于 prototype-only: 插件未打包发布,未提供状态栏 UI,未实现断线自动重连和多 workspace 会话路由。
