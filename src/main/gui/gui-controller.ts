import { desktopCapturer, systemPreferences } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { ocrImage, type OcrResult } from '../imageOcr'
import { nutClick, nutHotkey, nutScroll, nutType } from './nutjs-adapter'
import {
  windowsActivateWindow,
  windowsClick,
  windowsHotkey,
  windowsListWindows,
  windowsScroll,
  windowsTypeText,
  type WindowsBounds,
  type WindowsElementInfo
} from './windows-controller'
import {
  macosActivateWindow,
  macosClick,
  macosHotkey,
  macosListWindows,
  macosScroll,
  macosTypeText
} from './macos-controller'

type MouseButton = 'left' | 'right' | 'middle'
type ScreenCapturePermissionStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'

interface WindowSelector {
  windowId?: string
  title?: string
  processName?: string
  pid?: number
}

interface ElementSelector extends WindowSelector {
  elementId?: string
  elementName?: string
  automationId?: string
  className?: string
  controlType?: string
  elementIndex?: number
  maxElements?: number
}

interface ListWindowsInput extends WindowSelector {
  includeElements?: boolean
  maxElements?: number
}

interface ScreenshotInput {
  sourceId?: string
  savePath?: string
  maxWidth?: number
  includeOcr?: boolean
}

interface ClickInput extends ElementSelector {
  x?: number
  y?: number
  button: MouseButton
}

interface TypeTextInput extends ElementSelector {
  text: string
}

interface ScrollInput extends ElementSelector {
  x?: number
  y?: number
  deltaX?: number
  deltaY?: number
}

interface GuiBaseResult {
  ok: boolean
  error?: string
}

interface GuiWindowInfo {
  id: string
  name: string
  kind: 'screen' | 'window'
  appIcon: boolean
  platform?: NodeJS.Platform | 'electron'
  title?: string
  processName?: string
  pid?: number
  bounds?: WindowsBounds
  minimized?: boolean
  className?: string
  automationId?: string
  controlType?: string
  elements?: WindowsElementInfo[]
}

interface GuiListWindowsResult extends GuiBaseResult {
  windows: GuiWindowInfo[]
}

interface GuiScreenshotResult extends GuiBaseResult {
  path?: string
  sourceId?: string
  sourceName?: string
  sourceCount?: number
  screenCapturePermission?: ScreenCapturePermissionStatus
  width?: number
  height?: number
  ocr?: OcrResult
}

interface GuiActionResult extends GuiBaseResult {
  detail?: string
}

export interface GuiController {
  listWindows(input?: ListWindowsInput): Promise<GuiListWindowsResult>
  activateWindow(input: WindowSelector): Promise<GuiActionResult>
  screenshot(input: ScreenshotInput): Promise<GuiScreenshotResult>
  click(input: ClickInput): Promise<GuiActionResult>
  typeText(input: TypeTextInput): Promise<GuiActionResult>
  scroll(input: ScrollInput): Promise<GuiActionResult>
  hotkey(keys: string[]): Promise<GuiActionResult>
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function safeOutputPath(cwd: string, requested: string | undefined): string {
  const root = resolve(cwd)
  const fallback = resolve(root, '.caogen', 'tmp', 'gui', 'screenshots', `screen-${Date.now()}.png`)
  const target = requested?.trim() ? resolve(root, requested) : fallback
  if (!inside(root, target)) throw new Error('截图保存路径必须位于当前工作目录内')
  return target
}

function normalizeMaxWidth(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 1440
  return Math.min(3840, Math.max(320, Math.floor(value)))
}

async function sources(): Promise<Electron.DesktopCapturerSource[]> {
  return desktopCapturer.getSources({
    types: ['screen', 'window'],
    fetchWindowIcons: true,
    thumbnailSize: { width: 3840, height: 2160 }
  })
}

function sourceKind(source: Electron.DesktopCapturerSource): 'screen' | 'window' {
  return source.id.startsWith('screen:') ? 'screen' : 'window'
}

function sourceInfo(source: Electron.DesktopCapturerSource): GuiWindowInfo {
  return {
    id: source.id,
    name: source.name,
    kind: sourceKind(source),
    appIcon: !source.appIcon.isEmpty(),
    platform: 'electron'
  }
}

function matchesSelector(source: Electron.DesktopCapturerSource, selector: WindowSelector): boolean {
  if (selector.windowId && source.id === selector.windowId) return true
  const name = source.name.toLowerCase()
  if (selector.title && name.includes(selector.title.toLowerCase())) return true
  if (selector.processName && name.includes(selector.processName.toLowerCase())) return true
  if (typeof selector.pid === 'number' && source.id.includes(String(selector.pid))) return true
  return false
}

function preferNativeWindows(windows: GuiWindowInfo[]): GuiWindowInfo[] {
  if (process.platform !== 'win32') return windows
  const screens = windows.filter((item) => item.kind === 'screen')
  const electronWindows = windows.filter((item) => item.kind === 'window')
  return [...screens, ...electronWindows]
}

function screenCapturePermissionStatus(): ScreenCapturePermissionStatus | undefined {
  if (process.platform !== 'darwin') return undefined
  return systemPreferences.getMediaAccessStatus('screen')
}

export function createGuiController(cwd: string): GuiController {
  return {
    async listWindows(input: ListWindowsInput = {}): Promise<GuiListWindowsResult> {
      const captureSources = await sources().catch(() => [])
      const captureWindows = captureSources.map(sourceInfo)

      if (process.platform === 'win32') {
        const native = await windowsListWindows(input)
        if (native.ok) {
          const nativeWindows: GuiWindowInfo[] = native.windows.map((item) => ({
            id: item.id,
            name: item.name,
            kind: 'window',
            appIcon: false,
            platform: 'win32',
            title: item.title,
            processName: item.processName,
            pid: item.pid,
            bounds: item.bounds,
            minimized: item.minimized,
            className: item.className,
            automationId: item.automationId,
            controlType: item.controlType,
            elements: item.elements
          }))
          return { ok: true, windows: preferNativeWindows([...nativeWindows, ...captureWindows]) }
        }
        if (captureWindows.length === 0) return { ok: false, windows: [], error: native.error }
      }

      if (process.platform === 'darwin') {
        const native = await macosListWindows(input)
        if (native.ok) {
          const nativeWindows: GuiWindowInfo[] = native.windows.map((item) => ({
            id: item.id,
            name: item.name,
            kind: 'window',
            appIcon: false,
            platform: 'darwin',
            title: item.title,
            processName: item.processName,
            pid: item.pid,
            bounds: item.bounds,
            minimized: item.minimized,
            elements: item.elements
          }))
          return { ok: true, windows: [...nativeWindows, ...captureWindows] }
        }
        if (captureWindows.length === 0) return { ok: false, windows: [], error: native.error }
      }

      return { ok: true, windows: captureWindows }
    },

    async activateWindow(input: WindowSelector): Promise<GuiActionResult> {
      if (process.platform === 'win32') {
        const native = await windowsActivateWindow(input)
        if (native.ok) return { ok: true, detail: native.detail }
        if (input.windowId?.startsWith('win32:')) return { ok: false, error: native.error }
      }
      if (process.platform === 'darwin') {
        const native = await macosActivateWindow(input)
        if (native.ok) return { ok: true, detail: native.detail }
        if (input.windowId?.startsWith('darwin:')) return { ok: false, error: native.error }
      }

      const all = await sources().catch(() => [])
      const target = all.find((source) => matchesSelector(source, input))
      if (!target) return { ok: false, error: '未找到匹配窗口' }
      return {
        ok: false,
        detail: target.name,
        error: '当前平台尚未实现真实窗口激活；Windows 已走 UI Automation/Win32 主路径，其他平台仍为 prototype-only'
      }
    },

    async screenshot(input: ScreenshotInput): Promise<GuiScreenshotResult> {
      try {
        const all = await sources()
        const screenCapturePermission = screenCapturePermissionStatus()
        const source = input.sourceId
          ? all.find((item) => item.id === input.sourceId)
          : all.find((item) => sourceKind(item) === 'screen') ?? all[0]
        if (!source) {
          return {
            ok: false,
            error: '未找到可截图源',
            sourceCount: all.length,
            ...(screenCapturePermission ? { screenCapturePermission } : {})
          }
        }
        if (source.thumbnail.isEmpty()) {
          return {
            ok: false,
            error: '截图源缩略图为空；请确认系统 Screen Recording/屏幕录制权限已授予 CaoGen，并重新打开应用后再试。',
            sourceId: source.id,
            sourceName: source.name,
            sourceCount: all.length,
            ...(screenCapturePermission ? { screenCapturePermission } : {})
          }
        }

        const width = normalizeMaxWidth(input.maxWidth)
        const image = source.thumbnail.resize({ width })
        if (image.isEmpty()) {
          return {
            ok: false,
            error: '截图缩放后为空；请降低 maxWidth 或重新选择截图源。',
            sourceId: source.id,
            sourceName: source.name,
            sourceCount: all.length,
            ...(screenCapturePermission ? { screenCapturePermission } : {})
          }
        }
        const outPath = safeOutputPath(cwd, input.savePath)
        mkdirSync(dirname(outPath), { recursive: true })
        writeFileSync(outPath, image.toPNG())
        const size = image.getSize()
        const ocr = input.includeOcr ? await ocrImage(outPath) : undefined
        return {
          ok: true,
          path: outPath,
          sourceId: source.id,
          sourceName: source.name,
          sourceCount: all.length,
          ...(screenCapturePermission ? { screenCapturePermission } : {}),
          width: size.width,
          height: size.height,
          ...(ocr ? { ocr } : {})
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },

    async click(input: ClickInput): Promise<GuiActionResult> {
      if (process.platform === 'win32') {
        const native = await windowsClick(input)
        if (native.ok) return { ok: true, detail: native.detail }
      }
      if (process.platform === 'darwin') {
        const native = await macosClick(input)
        if (native.ok) return { ok: true, detail: native.detail }
      }

      if (typeof input.x !== 'number' || typeof input.y !== 'number') {
        return { ok: false, error: '非 Windows 平台暂不支持按元素 selector 点击；请提供屏幕坐标或安装平台适配器' }
      }
      const ok = await nutClick(input.x, input.y, input.button)
      return ok ? { ok: true } : { ok: false, error: 'GUI 点击需要 Windows 主路径可用，或安装 nut.js 可选依赖' }
    },

    async typeText(input: TypeTextInput): Promise<GuiActionResult> {
      if (process.platform === 'win32') {
        const native = await windowsTypeText(input)
        if (native.ok) return { ok: true, detail: native.detail }
      }
      if (process.platform === 'darwin') {
        const native = await macosTypeText(input)
        if (native.ok) return { ok: true, detail: native.detail }
      }

      const ok = await nutType(input.text)
      return ok ? { ok: true } : { ok: false, error: 'GUI 输入需要 Windows 主路径可用，或安装 nut.js 可选依赖' }
    },

    async scroll(input: ScrollInput): Promise<GuiActionResult> {
      if (process.platform === 'win32') {
        const native = await windowsScroll(input)
        if (native.ok) return { ok: true, detail: native.detail }
      }
      if (process.platform === 'darwin') {
        const native = await macosScroll(input)
        if (native.ok) return { ok: true, detail: native.detail }
      }

      const ok = await nutScroll(input.deltaX, input.deltaY, input.x, input.y)
      return ok ? { ok: true } : { ok: false, error: 'GUI 滚动需要 Windows/macOS 主路径可用，或安装支持滚轮的 nut.js 可选依赖' }
    },

    async hotkey(keys: string[]): Promise<GuiActionResult> {
      if (process.platform === 'win32') {
        const native = await windowsHotkey(keys)
        if (native.ok) return { ok: true, detail: native.detail }
      }
      if (process.platform === 'darwin') {
        const native = await macosHotkey(keys)
        if (native.ok) return { ok: true, detail: native.detail }
      }

      const ok = await nutHotkey(keys)
      return ok ? { ok: true } : { ok: false, error: 'GUI 快捷键需要 Windows 主路径可用，或安装 nut.js 可选依赖' }
    }
  }
}
