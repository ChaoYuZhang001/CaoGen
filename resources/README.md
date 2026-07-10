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

## trayTemplate.png — macOS 顶部菜单栏图标

macOS 菜单栏不能直接使用 1024×1024 的全彩应用图标。CaoGen 使用独立的单色 Template 图标:

- `trayTemplate.svg`:可编辑的头肩轮廓源文件
- `trayTemplate.png`:18×18,标准分辨率
- `trayTemplate@2x.png`:36×36,Retina 分辨率
- PNG 必须保留透明通道,图形使用纯黑;主进程通过 `setTemplateImage(true)` 让 macOS 在浅色/深色菜单栏中自动着色
- Dock、窗口、安装包和应用内品牌仍使用正式全彩 `icon.png` / `icon.icns`,不要用菜单栏轮廓替换

修改 SVG 后可重新生成 PNG:

```bash
sips -s format png --resampleHeightWidth 18 18 resources/trayTemplate.svg --out resources/trayTemplate.png
sips -s format png --resampleHeightWidth 36 36 resources/trayTemplate.svg --out resources/trayTemplate@2x.png
```
