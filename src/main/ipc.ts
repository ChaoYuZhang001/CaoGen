import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { sessionManager } from './sessionManager'
import { getSettings, updateSettings } from './settings'
import { listHistory } from './history'
import {
  listProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  fetchModels
} from './providers'
import { listHealth } from './scheduler'
import { listEngines } from './engine'
import { scanMigration, importAssets } from './migration'
import { listProjects, updateProject, deleteProject } from './projects'
import { suggestFiles } from './fileSuggest'
import { listProjectFiles, readTextFile, writeTextFile } from './fileOps'
import { preparePreview } from './previewOps'
import { getWorkspaceDiff } from './gitDiff'
import {
  exportManagedWorktreePatch,
  getManagedWorktreeSummary,
  removeManagedWorktreeView
} from './worktrees'
import { terminalManager } from './terminal'
import { browserViewManager } from './browserView'
import { copyImageAttachment, saveImageAttachmentBytes } from './attachmentOps'
import type {
  AppSettings,
  BrowserBounds,
  CreateSessionOptions,
  ImageAttachmentView,
  PermissionModeId,
  ProviderInput,
  SaveImageAttachmentBytesInput,
  SendMessagePayload
} from '../shared/types'

let terminalEventsRegistered = false
let browserEventsRegistered = false

function attachmentRoot(sessionId: string): string {
  return join(app.getPath('userData'), 'attachments', sessionId)
}

function normalizeSendPayload(sessionId: string, raw: unknown): SendMessagePayload | null {
  if (typeof raw === 'string') {
    const text = raw.trim()
    return text ? { text } : null
  }
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const text = typeof record.text === 'string' ? record.text.trim() : ''
  const images = Array.isArray(record.images)
    ? record.images.filter((image): image is ImageAttachmentView => {
        return isImageAttachmentView(image) && isInsideAttachmentRoot(sessionId, image.path)
      })
    : undefined
  if (!text && (!images || images.length === 0)) return null
  return { text, ...(images && images.length > 0 ? { images } : {}) }
}

function isInsideAttachmentRoot(sessionId: string, fullPath: string): boolean {
  const root = resolve(attachmentRoot(sessionId))
  const target = resolve(fullPath)
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function isImageAttachmentView(value: unknown): value is ImageAttachmentView {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.hash === 'string' &&
    typeof record.path === 'string' &&
    typeof record.mime === 'string' &&
    typeof record.bytes === 'number' &&
    Number.isFinite(record.bytes) &&
    typeof record.createdAt === 'string'
  )
}

export function registerIpc(): void {
  ipcMain.handle('sessions:list', () => sessionManager.list())

  ipcMain.handle('sessions:pendingPermissions', (_e, id: string) =>
    sessionManager.get(id)?.pendingPermissions() ?? []
  )

  ipcMain.handle('sessions:transcript', (_e, id: string) => sessionManager.getTranscript(id))

  ipcMain.handle('sessions:suggestFiles', (_e, id: string, query: string) => {
    const cwd = sessionManager.get(id)?.meta.cwd
    return cwd ? suggestFiles(cwd, typeof query === 'string' ? query : '') : []
  })

  ipcMain.handle('sessions:rewindFiles', async (_e, id: string, messageId: string, dryRun: boolean) => {
    const session = sessionManager.get(id)
    if (!session?.rewindFiles) return { canRewind: false, error: '会话不存在或引擎不支持' }
    return session.rewindFiles(messageId, dryRun === true)
  })

  ipcMain.handle('workspace:diff', (_e, id: string) => {
    const cwd = sessionManager.get(id)?.meta.cwd
    if (!cwd) {
      return { ok: false, cwd: '', files: [], rawBytes: 0, error: '会话不存在' }
    }
    return getWorkspaceDiff(cwd)
  })

  ipcMain.handle('worktrees:summary', (_e, id: string) => getManagedWorktreeSummary(id))

  ipcMain.handle('worktrees:exportPatch', (_e, id: string) => exportManagedWorktreePatch(id))

  ipcMain.handle(
    'worktrees:remove',
    (_e, id: string, opts?: { deleteBranch?: boolean; force?: boolean }) => {
      const session = sessionManager.get(id)
      if (session?.meta.status === 'running' || session?.meta.status === 'starting') {
        return { ok: false, error: '会话仍在运行，停止后才能丢弃 worktree' }
      }
      const result = removeManagedWorktreeView(id, opts ?? {})
      if (result.ok) sessionManager.updateWorktreeState(id, result.record?.state ?? 'removed')
      return result
    }
  )

  ipcMain.handle('files:list', (_e, id: string) => {
    const cwd = sessionManager.get(id)?.meta.cwd
    if (!cwd) return { ok: false, entries: [], error: '会话不存在' }
    return listProjectFiles(cwd)
  })

  ipcMain.handle('files:read', (_e, id: string, relPath: string) => {
    const cwd = sessionManager.get(id)?.meta.cwd
    if (!cwd) return { ok: false, error: '会话不存在' }
    return readTextFile(cwd, typeof relPath === 'string' ? relPath : '')
  })

  ipcMain.handle('files:write', (_e, id: string, relPath: string, content: string) => {
    const cwd = sessionManager.get(id)?.meta.cwd
    if (!cwd) return { ok: false, error: '会话不存在' }
    return writeTextFile(cwd, typeof relPath === 'string' ? relPath : '', typeof content === 'string' ? content : '')
  })

  ipcMain.handle('preview:prepare', (_e, id: string, relPath: string) => {
    const cwd = sessionManager.get(id)?.meta.cwd
    if (!cwd) return { ok: false, error: '会话不存在' }
    return preparePreview(cwd, typeof relPath === 'string' ? relPath : '')
  })

  if (!browserEventsRegistered) {
    browserEventsRegistered = true
    browserViewManager.subscribe((event) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('browser:event', event)
      }
    })
  }

  ipcMain.handle('browser:open', async (e, id: string, url?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) throw new Error('浏览器宿主窗口不存在')
    if (!sessionManager.get(id)) throw new Error('会话不存在')
    return browserViewManager.open(win, id, typeof url === 'string' ? url : undefined)
  })

  ipcMain.handle('browser:navigate', (_e, id: string, url: string) =>
    browserViewManager.navigate(id, typeof url === 'string' ? url : '')
  )

  ipcMain.handle('browser:bounds', (_e, id: string, bounds: BrowserBounds) => {
    browserViewManager.setBounds(id, bounds)
  })

  ipcMain.handle('browser:back', (_e, id: string) => browserViewManager.goBack(id))

  ipcMain.handle('browser:forward', (_e, id: string) => browserViewManager.goForward(id))

  ipcMain.handle('browser:reload', (_e, id: string) => browserViewManager.reload(id))

  ipcMain.handle('browser:close', (_e, id: string) => {
    browserViewManager.close(id)
  })

  ipcMain.handle('browser:captureAnnotation', (_e, id: string, note: string) =>
    browserViewManager.captureAnnotation(id, typeof note === 'string' ? note : '')
  )

  ipcMain.handle('browser:listAnnotations', (_e, id: string) =>
    browserViewManager.listAnnotations(id)
  )

  if (!terminalEventsRegistered) {
    terminalEventsRegistered = true
    terminalManager.subscribe((event) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('terminal:event', event)
      }
    })
  }

  ipcMain.handle('terminals:list', () => terminalManager.list())

  ipcMain.handle(
    'terminals:start',
    (_e, id: string, opts?: { cols?: number; rows?: number; reuse?: boolean }) => {
      const session = sessionManager.get(id)
      if (!session) throw new Error('会话不存在')
      return terminalManager.start({
        cwd: session.meta.cwd,
        sessionId: id,
        cols: opts?.cols,
        rows: opts?.rows,
        reuse: opts?.reuse
      })
    }
  )

  ipcMain.handle('terminals:write', (_e, id: string, data: string) => {
    terminalManager.write(id, typeof data === 'string' ? data : '')
  })

  ipcMain.handle('terminals:resize', (_e, id: string, cols: number, rows: number) => {
    terminalManager.resize(id, cols, rows)
  })

  ipcMain.handle('terminals:close', (_e, id: string) => {
    terminalManager.close(id)
  })

  ipcMain.handle('sessions:create', (_e, opts: CreateSessionOptions) => {
    if (!opts || typeof opts.cwd !== 'string' || opts.cwd.length === 0) {
      throw new Error('必须指定工作目录')
    }
    return sessionManager.create(opts)
  })

  ipcMain.handle('attachments:copyImage', async (_e, id: string, sourcePath: string) => {
    if (!sessionManager.get(id)) return { ok: false, error: '会话不存在' }
    if (typeof sourcePath !== 'string' || sourcePath.trim().length === 0) {
      return { ok: false, error: '图片路径不能为空' }
    }
    return copyImageAttachment(sourcePath, attachmentRoot(id))
  })

  ipcMain.handle(
    'attachments:saveImageBytes',
    async (_e, id: string, input: SaveImageAttachmentBytesInput) => {
      if (!sessionManager.get(id)) return { ok: false, error: '会话不存在' }
      const data = input?.data
      if (typeof data !== 'string' && !(data instanceof ArrayBuffer)) {
        return { ok: false, error: '图片内容不能为空' }
      }
      return saveImageAttachmentBytes(data, attachmentRoot(id), {
        mime: typeof input.mime === 'string' ? input.mime : undefined
      })
    }
  )

  ipcMain.handle('sessions:send', (_e, id: string, raw: unknown) => {
    const payload = normalizeSendPayload(id, raw)
    if (!payload) return
    sessionManager.get(id)?.send(payload)
  })

  ipcMain.handle('sessions:interrupt', async (_e, id: string) => {
    await sessionManager.get(id)?.interrupt()
  })

  ipcMain.handle('sessions:close', (_e, id: string) => {
    sessionManager.close(id)
  })

  ipcMain.handle(
    'sessions:permission',
    (_e, id: string, requestId: string, allow: boolean, message?: string) => {
      sessionManager.get(id)?.respondPermission(requestId, allow === true, message)
    }
  )

  ipcMain.handle('sessions:setPermissionMode', async (_e, id: string, mode: PermissionModeId) => {
    await sessionManager.get(id)?.setPermissionMode(mode)
  })

  ipcMain.handle('sessions:setModel', async (_e, id: string, model: string) => {
    await sessionManager.get(id)?.setModel(typeof model === 'string' ? model : '')
  })

  ipcMain.handle('sessions:rename', (_e, id: string, title: string) => {
    if (typeof title === 'string') sessionManager.get(id)?.rename(title)
  })

  ipcMain.handle('history:list', () => listHistory())

  ipcMain.handle('settings:get', () => getSettings())

  ipcMain.handle('settings:update', (_e, patch: Partial<AppSettings>) =>
    updateSettings(patch ?? {})
  )

  ipcMain.handle('providers:list', () => listProviders())

  ipcMain.handle('providers:create', (_e, input: ProviderInput) => {
    if (!input || typeof input.name !== 'string' || input.name.trim().length === 0) {
      throw new Error('Provider 名称不能为空')
    }
    return createProvider(input)
  })

  ipcMain.handle('providers:update', (_e, id: string, patch: Partial<ProviderInput>) =>
    updateProvider(id, patch ?? {})
  )

  ipcMain.handle('providers:delete', (_e, id: string) => {
    deleteProvider(id)
  })

  ipcMain.handle('providers:health', () => listHealth())

  ipcMain.handle('engines:list', () => listEngines())

  ipcMain.handle('migration:scan', (_e, cwd: string) => {
    if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('必须指定项目目录')
    return scanMigration(cwd)
  })

  ipcMain.handle('migration:import', (_e, cwd: string, paths: string[]) => {
    if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('必须指定项目目录')
    if (!Array.isArray(paths)) return '未选择任何资产'
    return importAssets(cwd, paths.filter((p): p is string => typeof p === 'string'))
  })

  ipcMain.handle('projects:list', () => listProjects())
  ipcMain.handle('projects:update', (_e, id: string, patch: { name?: string }) =>
    updateProject(id, patch ?? {})
  )
  ipcMain.handle('projects:delete', (_e, id: string) => {
    deleteProject(id)
  })

  ipcMain.handle(
    'providers:fetchModels',
    (_e, opts: { baseUrl: string; token?: string; providerId?: string }) => fetchModels(opts ?? {})
  )

  ipcMain.handle('dialog:pickDirectory', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
}
