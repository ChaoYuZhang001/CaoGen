# 应用资源

## icon.png — 应用图标

把 CaoGen 的应用图标(那张 3D 人物形象)保存为本目录下的 **`icon.png`**:

- 推荐尺寸:**1024×1024**,PNG,透明或纯色背景皆可
- 放好后:
  - 主进程会自动把它用作窗口图标(Windows / Linux)
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
  - 打包(M7,electron-builder)会引用 `resources/icon.icns` / `resources/icon.png`

放置后重启应用即生效,无需改代码。
