import {
  BrowserWindow,
  app,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain
} from 'electron'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { copyImageAttachment } from '../attachmentOps'
import { createGuiController } from '../gui/gui-controller'
import { sessionManager } from '../sessionManager'
import type {
  ImageAttachmentView,
  QuickbarClipboardInput,
  QuickbarContextResult,
  QuickbarEvent,
  QuickbarEventSource,
  QuickbarFileInput,
  QuickbarPayloadResult,
  QuickbarScreenshotInput,
  QuickbarState,
  QuickbarWindowContext,
  SendMessagePayload
} from '../../shared/types'

const DEFAULT_ACCELERATOR = 'CommandOrControl+Shift+Space'
const FALLBACK_ACCELERATOR = 'CommandOrControl+Alt+Space'
const QUICKBAR_FILE_LIMIT = 40

interface QuickbarControllerOptions {
  getMainWindow?: () => BrowserWindow | null
  showMainWindow?: () => void
}

interface FileContext {
  path: string
  kind: 'file' | 'directory' | 'other'
  exists: boolean
  bytes?: number
  error?: string
}

class QuickbarController {
  private options: QuickbarControllerOptions = {}
  private visible = false
  private accelerator = DEFAULT_ACCELERATOR
  private registered = false
  private registrationError: string | undefined

  configure(options: QuickbarControllerOptions): void {
    this.options = { ...this.options, ...options }
  }

  registerGlobalShortcut(): QuickbarState {
    this.unregisterGlobalShortcut()
    const candidates = [DEFAULT_ACCELERATOR, FALLBACK_ACCELERATOR]
    for (const candidate of candidates) {
      const ok = globalShortcut.register(candidate, () => {
        this.setVisible(!this.visible, 'global-shortcut')
      })
      if (ok) {
        this.accelerator = candidate
        this.registered = true
        this.registrationError = undefined
        return this.getState()
      }
    }
    this.accelerator = DEFAULT_ACCELERATOR
    this.registered = false
    this.registrationError = 'Quickbar 全局快捷键注册失败:系统可能已占用 Command/Ctrl+Shift+Space 和 Command/Ctrl+Alt+Space'
    return this.getState()
  }

  unregisterGlobalShortcut(): void {
    for (const accelerator of [DEFAULT_ACCELERATOR, FALLBACK_ACCELERATOR]) {
      if (globalShortcut.isRegistered(accelerator)) globalShortcut.unregister(accelerator)
    }
    this.registered = false
  }

  dispose(): void {
    this.unregisterGlobalShortcut()
  }

  getState(): QuickbarState {
    return {
      visible: this.visible,
      accelerator: this.accelerator,
      registered: this.registered,
      ...(this.registrationError ? { registrationError: this.registrationError } : {})
    }
  }

  setVisible(visible: boolean, source: QuickbarEventSource): QuickbarState {
    this.visible = visible
    if (visible) this.options.showMainWindow?.()
    this.emit({ kind: 'visibility', visible, source })
    return this.getState()
  }

  private emit(event: QuickbarEvent): void {
    const win = this.options.getMainWindow?.() ?? BrowserWindow.getAllWindows()[0] ?? null
    if (!win || win.isDestroyed()) return
    win.webContents.send('quickbar:event', event)
  }
}

export const quickbarController = new QuickbarController()

export function configureQuickbar(options: QuickbarControllerOptions): void {
  quickbarController.configure(options)
}

export function registerQuickbarGlobalShortcut(): QuickbarState {
  return quickbarController.registerGlobalShortcut()
}

export function disposeQuickbar(): void {
  quickbarController.dispose()
}

export function registerQuickbarIpc(): void {
  ipcMain.handle('quickbar:getState', () => quickbarController.getState())
  ipcMain.handle('quickbar:setVisible', (_e, visible: boolean) =>
    quickbarController.setVisible(visible === true, 'renderer')
  )
  ipcMain.handle('quickbar:getWindowContext', (_e, cwd?: string, sourceId?: string) =>
    getQuickbarWindowContext(cwd, sourceId)
  )
  ipcMain.handle('quickbar:readClipboard', (_e, input?: QuickbarClipboardInput) =>
    readQuickbarClipboard(input)
  )
  ipcMain.handle('quickbar:captureScreenshot', (_e, input: QuickbarScreenshotInput) =>
    captureQuickbarScreenshot(input)
  )
  ipcMain.handle('quickbar:pickFiles', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win
      ? await dialog.showOpenDialog(win, {
          properties: ['openFile', 'openDirectory', 'multiSelections']
        })
      : await dialog.showOpenDialog({
          properties: ['openFile', 'openDirectory', 'multiSelections']
        })
    return result.canceled ? [] : result.filePaths
  })
  ipcMain.handle('quickbar:prepareFiles', (_e, input: QuickbarFileInput) =>
    prepareQuickbarFiles(input)
  )
}

export async function getQuickbarWindowContext(
  cwd?: string,
  sourceId?: string
): Promise<QuickbarContextResult> {
  const resolvedCwd = resolveCwd(cwd)
  try {
    const result = await createGuiController(resolvedCwd).listWindows({ includeElements: false })
    const windows = (result.windows ?? []).map(toWindowContext)
    const current =
      pickCurrentWindow(windows, typeof sourceId === 'string' ? sourceId : undefined) ?? undefined
    return {
      ok: result.ok,
      cwd: resolvedCwd,
      capturedAt: Date.now(),
      ...(current ? { current } : {}),
      windows: windows.slice(0, 30),
      ...(result.error ? { error: result.error } : {})
    }
  } catch (err) {
    return {
      ok: false,
      cwd: resolvedCwd,
      capturedAt: Date.now(),
      windows: [],
      error: errorMessage(err)
    }
  }
}

export async function readQuickbarClipboard(
  input: QuickbarClipboardInput = {}
): Promise<QuickbarPayloadResult> {
  const text = clipboard.readText().trim()
  if (!text) return { ok: false, error: '剪贴板没有可投递的文本内容' }
  const context = input.includeWindowContext === false ? undefined : await getQuickbarWindowContext(input.cwd)
  const payload: SendMessagePayload = {
    text: [
      '[CaoGen Quickbar 剪贴板上下文]',
      contextLines(context),
      input.note?.trim() ? `备注: ${input.note.trim()}` : '',
      '',
      text
    ]
      .filter(Boolean)
      .join('\n')
  }
  return { ok: true, payload, ...(context ? { context } : {}) }
}

export async function captureQuickbarScreenshot(
  input: QuickbarScreenshotInput
): Promise<QuickbarPayloadResult> {
  const sessionId = typeof input?.sessionId === 'string' ? input.sessionId.trim() : ''
  if (!sessionId || !sessionManager.get(sessionId)) return { ok: false, error: '截图投递需要一个有效会话' }

  const cwd = resolveCwd(input.cwd, sessionId)
  const context = input.includeWindowContext === false
    ? undefined
    : await getQuickbarWindowContext(cwd, input.sourceId)
  const screenshot = await createGuiController(cwd).screenshot({
    sourceId: input.sourceId?.trim() || undefined,
    maxWidth: input.maxWidth
  })
  if (!screenshot.ok || !screenshot.path) {
    return {
      ok: false,
      error: screenshot.error || '截图失败',
      ...(context ? { context } : {})
    }
  }

  const copied = await copyImageAttachment(screenshot.path, attachmentRoot(sessionId))
  if (!copied.ok) {
    return {
      ok: false,
      error: copied.error,
      screenshotPath: screenshot.path,
      ...(context ? { context } : {})
    }
  }

  const { ok: _ok, ...image } = copied
  const payload: SendMessagePayload = {
    text: [
      '[CaoGen Quickbar 截图上下文]',
      `截图源: ${screenshot.sourceName || screenshot.sourceId || '默认屏幕'}`,
      typeof screenshot.width === 'number' && typeof screenshot.height === 'number'
        ? `尺寸: ${screenshot.width}x${screenshot.height}`
        : '',
      contextLines(context),
      input.note?.trim() ? `备注: ${input.note.trim()}` : '',
      '',
      '请把随附截图作为当前任务上下文。'
    ]
      .filter(Boolean)
      .join('\n'),
    images: [image as ImageAttachmentView]
  }
  return { ok: true, payload, screenshotPath: screenshot.path, ...(context ? { context } : {}) }
}

export async function prepareQuickbarFiles(input: QuickbarFileInput): Promise<QuickbarPayloadResult> {
  const cwd = resolveCwd(input.cwd)
  const paths = Array.isArray(input.paths) ? input.paths : []
  const files = paths
    .flatMap((raw) => normalizePathListItem(raw, cwd))
    .slice(0, QUICKBAR_FILE_LIMIT)
    .map(fileContext)
  if (files.length === 0) return { ok: false, error: '没有可投递的文件路径' }

  const context = input.includeWindowContext === false ? undefined : await getQuickbarWindowContext(cwd)
  const payload: SendMessagePayload = {
    text: [
      '[CaoGen Quickbar 文件路径上下文]',
      `工作目录: ${cwd}`,
      contextLines(context),
      input.note?.trim() ? `备注: ${input.note.trim()}` : '',
      '',
      ...files.map(formatFileContext),
      '',
      '请根据这些本机路径加载或检查相关文件。'
    ]
      .filter(Boolean)
      .join('\n')
  }
  return { ok: true, payload, files, ...(context ? { context } : {}) }
}

function attachmentRoot(sessionId: string): string {
  return resolve(app.getPath('userData'), 'attachments', sessionId)
}

function resolveCwd(cwd?: string, sessionId?: string): string {
  const sessionCwd = sessionId ? sessionManager.get(sessionId)?.meta.cwd : undefined
  const raw = cwd?.trim() || sessionCwd || homedir()
  return resolve(raw)
}

function toWindowContext(item: {
  id: string
  name: string
  kind: 'screen' | 'window'
  title?: string
  processName?: string
  pid?: number
  platform?: NodeJS.Platform | 'electron'
  minimized?: boolean
}): QuickbarWindowContext {
  return {
    id: item.id,
    name: item.name,
    kind: item.kind,
    ...(item.title ? { title: item.title } : {}),
    ...(item.processName ? { processName: item.processName } : {}),
    ...(typeof item.pid === 'number' ? { pid: item.pid } : {}),
    ...(item.platform ? { platform: item.platform } : {}),
    ...(typeof item.minimized === 'boolean' ? { minimized: item.minimized } : {})
  }
}

function pickCurrentWindow(
  windows: QuickbarWindowContext[],
  sourceId?: string
): QuickbarWindowContext | null {
  if (sourceId) {
    const byId = windows.find((item) => item.id === sourceId)
    if (byId) return byId
  }
  return (
    windows.find((item) => item.kind === 'window' && !item.minimized && !isCaoGenWindow(item)) ??
    windows.find((item) => item.kind === 'window' && !item.minimized) ??
    windows.find((item) => item.kind === 'screen') ??
    windows[0] ??
    null
  )
}

function isCaoGenWindow(item: QuickbarWindowContext): boolean {
  const haystack = [item.name, item.title, item.processName].filter(Boolean).join(' ').toLowerCase()
  return haystack.includes('caogen') || haystack.includes('electron')
}

function contextLines(context: QuickbarContextResult | undefined): string {
  const current = context?.current
  if (!current) return ''
  const name = current.title || current.name
  const owner = current.processName ? ` (${current.processName})` : ''
  return `当前窗口: ${name}${owner}`
}

function normalizePathListItem(raw: string, cwd: string): string[] {
  if (typeof raw !== 'string') return []
  return raw
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const withoutFileScheme = item.startsWith('file://') ? decodeURIComponent(new URL(item).pathname) : item
      return resolve(cwd, withoutFileScheme)
    })
}

function fileContext(path: string): FileContext {
  try {
    if (path.includes('\0')) return { path, kind: 'other', exists: false, error: '路径包含非法字符' }
    const info = statSync(path)
    return {
      path,
      kind: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
      exists: true,
      ...(info.isFile() ? { bytes: info.size } : {})
    }
  } catch (err) {
    return { path, kind: 'other', exists: false, error: errorMessage(err) }
  }
}

function formatFileContext(item: FileContext): string {
  const label = item.exists ? item.kind : 'missing'
  const bytes = typeof item.bytes === 'number' ? `, ${item.bytes} bytes` : ''
  const error = item.error ? `, ${item.error}` : ''
  return `- ${item.path} (${label}${bytes}${error})`
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
