# 应用资源

## icon.png — 通用 / macOS / Linux 图标

把 CaoGen 的应用图标(那张 3D 人物形象)保存为本目录下的 **`icon.png`**:

- 推荐尺寸:**1024×1024**,PNG,圆角画布,四角透明
- 放好后:
  - 主进程会自动把它用作 macOS / Linux 窗口图标
  - macOS 打包需要 `.icns`,可由此 PNG 生成:
    ```bash
    # 需要 macOS 自带的 iconutil
    mkdir -p /tmp/CaoGen.iconset
    for s in 16 32 128 256 512; do
      sips -z $s $s   resources/icon.png --out /tmp/CaoGen.iconset/icon_${s}x${s}.png
      sips -z $((s*2)) $((s*2)) resources/icon.png --out /tmp/CaoGen.iconset/icon_${s}x${s}@2x.png
    done
    iconutil -c icns /tmp/CaoGen.iconset -o resources/icon.icns
    ```
  - 打包(electron-builder)会引用 `resources/icon.icns` / `resources/icon.png`

## icon-win.png / icon-win.ico — Windows 透明图标

Windows 图标不要白色底板:

- `icon-win.png`:1024×1024,PNG,人物居中,背景透明
- `icon-win.ico`:由 `icon-win.png` 生成,包含 16/24/32/48/64/128/256 多尺寸 PNG 帧
- Windows 打包使用 `resources/icon-win.ico`;运行时窗口/托盘优先使用 `icon-win.png`

放置后重启应用即生效,无需改代码。
