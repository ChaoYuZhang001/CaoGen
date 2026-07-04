import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readdirSync, type Dirent } from 'node:fs'
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
import {
  readProjectMemory,
  proposeMemoryDraft,
  acceptMemoryDraft,
  deleteMemoryEntry,
  type ProjectMemoryDraftInput
} from './memoryStore'
import { suggestFiles } from './fileSuggest'
import { listProjectFiles, readTextFile, writeTextFile } from './fileOps'
import { preparePreview } from './previewOps'
import {
  commit as gitCommit,
  gitStatus,
  stageAll,
  stageFiles,
  unstageFiles
} from './gitOps'
import { applyHunk, getWorkspaceDiff } from './gitDiff'
import { getStartSuggestions, type StartSuggestionSignal } from './startSuggestions'
import {
  applyManagedWorktreePatch,
  checkManagedWorktreeApply,
  createManagedWorktreeMergePatch,
  exportManagedWorktreePatch,
  getManagedWorktreeSummary,
  inspectManagedWorktreeMerge,
  removeManagedWorktreeView
} from './worktrees'
import { terminalManager } from './terminal'
import { browserViewManager } from './browserView'
import { copyImageAttachment, saveImageAttachmentBytes } from './attachmentOps'
import {
  pluginRegistryItemKey,
  readPluginRegistryState,
  scanPluginRegistry,
  setPluginRegistryItemEnabled,
  writePluginRegistryState
} from './pluginRegistry'
import { listRoutines, markRun, updateRoutine, createRoutine, deleteRoutine } from './routineStore'
import type {
  AppSettings,
  BrowserBounds,
  CheckpointRestoreMode,
  CreateRoutineInput,
  CreateSessionOptions,
  DispatchSubagentsInput,
  ImageAttachmentView,
  MarkRunOptions,
  PermissionModeId,
  PluginRegistryItem,
  PluginRegistryScanOptions,
  ProviderInput,
  SaveImageAttachmentBytesInput,
  SendMessagePayload,
  UpdateRoutineInput
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

function isPluginRegistryItem(value: unknown): value is PluginRegistryItem {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    (record.kind === 'plugin' || record.kind === 'skill' || record.kind === 'agent' || record.kind === 'mcp') &&
    typeof record.name === 'string' &&
    typeof record.sourceRoot === 'string' &&
    typeof record.path === 'string'
  )
}

function pluginRegistryRoots(sessionId?: string): string[] {
  const roots: string[] = []
  const session = typeof sessionId === 'string' ? sessionManager.get(sessionId) : undefined
  const projectCwds = [session?.meta.sourceCwd, session?.meta.cwd].filter(
    (cwd): cwd is string => typeof cwd === 'string' && cwd.trim().length > 0
  )
  for (const cwd of projectCwds) roots.push(join(cwd, '.claude'))
  roots.push(join(homedir(), '.claude'))
  roots.push(join(homedir(), '.codex', 'skills'))
  roots.push(...codexPluginPackageRoots())
  return roots
}

function codexPluginPackageRoots(): string[] {
  const cacheRoot = join(homedir(), '.codex', 'plugins', 'cache')
  const roots: string[] = []
  const maxDepth = 5
  const maxRoots = 500

  const walk = (dir: string, depth: number): void => {
    if (roots.length >= maxRoots || depth > maxDepth) return
    if (existsSync(join(dir, '.codex-plugin', 'plugin.json')) || existsSync(join(dir, 'plugin.json'))) {
      roots.push(dir)
      return
    }
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.git') continue
      walk(join(dir, entry.name), depth + 1)
      if (roots.length >= maxRoots) return
    }
  }

  walk(cacheRoot, 0)
  return roots
}

function normalizePluginScanOptions(options?: PluginRegistryScanOptions): PluginRegistryScanOptions {
  return {
    maxFiles: clampPositiveInt(options?.maxFiles, 3000, 5000),
    maxDepth: clampPositiveInt(options?.maxDepth, 6, 12),
    maxReadBytes: clampPositiveInt(options?.maxReadBytes, 256 * 1024, 1024 * 1024),
    includeSiblingProjectMcp: options?.includeSiblingProjectMcp ?? true
  }
}

function clampPositiveInt(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback
  return Math.min(max, Math.max(1, Math.floor(value)))
}

function routineStoreRoot(): string {
  return join(app.getPath('userData'), 'routines')
}

function pluginRegistryStateFile(): string {
  return join(app.getPath('userData'), 'plugin-registry-state.json')
}

function canRevealPluginPath(targetPath: string, sessionId?: string): boolean {
  if (typeof targetPath !== 'string' || targetPath.trim().length === 0) return false
  const target = resolve(targetPath)
  for (const root of pluginRegistryRoots(sessionId)) {
    const resolvedRoot = resolve(root)
    if (isInsidePath(resolvedRoot, target)) return true
    if (basename(resolvedRoot) === '.claude' && target === resolve(dirname(resolvedRoot), '.mcp.json')) {
      return true
    }
  }
  return false
}

function findScannedPluginRegistryItem(item: PluginRegistryItem, sessionId?: string): PluginRegistryItem | undefined {
  const state = readPluginRegistryState(pluginRegistryStateFile())
  const view = scanPluginRegistry(pluginRegistryRoots(sessionId), normalizePluginScanOptions(), state)
  const key = pluginRegistryItemKey(item)
  return view.items.find((candidate) => pluginRegistryItemKey(candidate) === key)
}

function isInsidePath(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
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

  ipcMain.handle(
    'sessions:restoreCheckpoint',
    async (_e, id: string, messageId: string, mode: CheckpointRestoreMode, dryRun: boolean) => {
      const session = sessionManager.get(id)
      const safeMode: CheckpointRestoreMode =
        mode === 'chat' || mode === 'both' || mode === 'code' ? mode : 'code'
      if (!session?.restoreCheckpoint) {
        return {
          mode: safeMode,
          checkpointId: messageId,
          canRewind: false,
          applied: false,
          error: '会话不存在或引擎不支持'
        }
      }
      if (session.meta.status === 'running' || session.meta.status === 'starting') {
        return {
          mode: safeMode,
          checkpointId: messageId,
          canRewind: false,
          applied: false,
          error: '会话仍在运行,请停止后再回溯'
        }
      }
      return session.restoreCheckpoint(messageId, safeMode, dryRun === true)
    }
  )

  ipcMain.handle('git:status', (_e, id: string) => {
    const cwd = sessionManager.get(id)?.meta.cwd
    if (!cwd) {
      return {
        ok: false,
        cwd: '',
        branch: '',
        files: [],
        staged: 0,
        unstaged: 0,
        untracked: 0,
        error: '会话不存在'
      }
    }
    return gitStatus(cwd)
  })

  ipcMain.handle('git:stage', (_e, id: string, paths: string[]) => {
    const cwd = sessionManager.get(id)?.meta.cwd
    if (!cwd) return { ok: false, error: '会话不存在' }
    return stageFiles(cwd, paths)
  })

  ipcMain.handle('git:stageAll', (_e, id: string) => {
    const cwd = sessionManager.get(id)?.meta.cwd
    if (!cwd) return { ok: false, error: '会话不存在' }
    return stageAll(cwd)
  })

  ipcMain.handle('git:unstage', (_e, id: string, paths: string[]) => {
    const cwd = sessionManager.get(id)?.meta.cwd
    if (!cwd) return { ok: false, error: '会话不存在' }
    return unstageFiles(cwd, paths)
  })

  ipcMain.handle('git:commit', (_e, id: string, message: string) => {
    const cwd = sessionManager.get(id)?.meta.cwd
    if (!cwd) return { ok: false, error: '会话不存在' }
    return gitCommit(cwd, message)
  })

  ipcMain.handle('workspace:diff', (_e, id: string) => {
    const cwd = sessionManager.get(id)?.meta.cwd
    if (!cwd) {
      return { ok: false, cwd: '', files: [], rawBytes: 0, error: '会话不存在' }
    }
    return getWorkspaceDiff(cwd)
  })

  ipcMain.handle('workspace:applyHunk', (_e, id: string, filePath: string, hunkPatch: string) => {
    const cwd = sessionManager.get(id)?.meta.cwd
    if (!cwd) return { ok: false, error: '会话不存在' }
    return applyHunk(cwd, typeof filePath === 'string' ? filePath : '', hunkPatch, { reverse: false })
  })

  ipcMain.handle('workspace:discardHunk', (_e, id: string, filePath: string, hunkPatch: string) => {
    const cwd = sessionManager.get(id)?.meta.cwd
    if (!cwd) return { ok: false, error: '会话不存在' }
    return applyHunk(cwd, typeof filePath === 'string' ? filePath : '', hunkPatch, { reverse: true })
  })

  ipcMain.handle('worktrees:summary', (_e, id: string) => getManagedWorktreeSummary(id))

  ipcMain.handle('worktrees:exportPatch', (_e, id: string) => exportManagedWorktreePatch(id))

  ipcMain.handle('worktrees:mergeInspect', (_e, id: string) => inspectManagedWorktreeMerge(id))

  ipcMain.handle('worktrees:mergePatch', (_e, id: string) => createManagedWorktreeMergePatch(id))

  ipcMain.handle('worktrees:applyCheck', (_e, id: string) => checkManagedWorktreeApply(id))

  ipcMain.handle('worktrees:applyPatch', (_e, id: string) => {
    const session = sessionManager.get(id)
    // 仅 running(agent 正在改文件)时拦截,避免边改边合并的竞态;
    // starting(SDK 尚未真正开跑,可能因未配 provider 长期停留)不阻止合并。
    if (session?.meta.status === 'running') {
      return { ok: false, error: '会话正在运行，停止后才能合并 worktree 改动' }
    }
    return applyManagedWorktreePatch(id)
  })

  ipcMain.handle(
    'worktrees:remove',
    (_e, id: string, opts?: { deleteBranch?: boolean; force?: boolean }) => {
      const session = sessionManager.get(id)
      if (session?.meta.status === 'running') {
        return { ok: false, error: '会话正在运行，停止后才能丢弃 worktree' }
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

  ipcMain.handle('sessions:dispatchSubagents', (_e, parentSessionId: string, input: DispatchSubagentsInput) => {
    if (typeof parentSessionId !== 'string' || parentSessionId.trim().length === 0) {
      throw new Error('必须指定父会话')
    }
    if (!input || !Array.isArray(input.tasks)) throw new Error('必须提供子代理任务列表')
    return sessionManager.dispatchSubagents(parentSessionId, input)
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

  ipcMain.handle(
    'plugins:scan',
    (_e, sessionId?: string, options?: PluginRegistryScanOptions) =>
      scanPluginRegistry(
        pluginRegistryRoots(sessionId),
        normalizePluginScanOptions(options),
        readPluginRegistryState(pluginRegistryStateFile())
      )
  )

  ipcMain.handle('plugins:reveal', (_e, targetPath: string, sessionId?: string) => {
    if (!canRevealPluginPath(targetPath, sessionId)) {
      return { ok: false, error: '插件路径不在允许的扫描范围内' }
    }
    shell.showItemInFolder(resolve(targetPath))
    return { ok: true, path: resolve(targetPath) }
  })

  ipcMain.handle('plugins:setEnabled', (_e, item: unknown, enabled: unknown, sessionId?: string) => {
    if (!isPluginRegistryItem(item)) return { ok: false, error: '插件条目无效' }
    if (typeof enabled !== 'boolean') return { ok: false, error: '插件状态无效' }

    const scannedItem = findScannedPluginRegistryItem(item, sessionId)
    if (!scannedItem) return { ok: false, error: '插件条目不在当前允许的扫描范围内' }

    const state = setPluginRegistryItemEnabled(
      readPluginRegistryState(pluginRegistryStateFile()),
      scannedItem,
      enabled
    )
    writePluginRegistryState(pluginRegistryStateFile(), state)

    const refreshed = scanPluginRegistry(
      pluginRegistryRoots(sessionId),
      normalizePluginScanOptions(),
      state
    )
    return {
      ok: true,
      item: refreshed.items.find((candidate) => pluginRegistryItemKey(candidate) === pluginRegistryItemKey(scannedItem)) ?? {
        ...scannedItem,
        enabled
      }
    }
  })

  ipcMain.handle('routines:list', () => listRoutines(routineStoreRoot()))

  ipcMain.handle('routines:create', (_e, input: CreateRoutineInput) =>
    createRoutine(routineStoreRoot(), input)
  )

  ipcMain.handle('routines:delete', (_e, id: string) => {
    if (typeof id !== 'string' || id.trim().length === 0) return false
    return deleteRoutine(routineStoreRoot(), id)
  })

  ipcMain.handle('routines:update', (_e, id: string, patch: UpdateRoutineInput) => {
    if (typeof id !== 'string' || id.trim().length === 0) return null
    return updateRoutine(routineStoreRoot(), id, patch ?? {})
  })

  ipcMain.handle('routines:markRun', (_e, id: string, options?: MarkRunOptions) => {
    if (typeof id !== 'string' || id.trim().length === 0) return null
    return markRun(routineStoreRoot(), id, options ?? {})
  })

  ipcMain.handle('startSuggestions:get', async (_e, id: string) => {
    const session = sessionManager.get(id)
    if (!session) return []
    const projectRoot = session.meta.sourceCwd ?? session.meta.cwd
    const memory = await readProjectMemory(projectRoot, memoryRoot()).catch(() => ({ entries: [] }))
    const worktree = getManagedWorktreeSummary(id)
    const historySignals: StartSuggestionSignal[] = listHistory().slice(0, 8).map((entry) => ({
      id: entry.id,
      title: entry.title,
      body: entry.cwd,
      source: 'history',
      updatedAt: entry.updatedAt,
      ok: true
    }))
    const routines = await listRoutines(routineStoreRoot())
    const routineSignals: StartSuggestionSignal[] = routines.map((routine) => ({
      id: routine.id,
      title: routine.name,
      body: routine.prompt,
      source: 'routine',
      status: routine.enabled ? 'enabled' : 'disabled',
      updatedAt: routine.updatedAt,
      ok: true
    }))
    return getStartSuggestions(projectRoot, {
      memoryEntries: memory.entries.map((entry) => ({
        id: entry.id,
        title: entry.title,
        body: entry.body,
        source: entry.source || 'memory',
        status: entry.kind,
        updatedAt: entry.updatedAt,
        failed: /失败|报错|阻塞|failed|error|blocked/i.test(`${entry.title}\n${entry.body}\n${entry.reason}`)
      })),
      worktreeSummaries: [
        {
          id,
          title: worktree.record?.branch ?? session.meta.title,
          body: worktree.error ?? `${worktree.changedFiles} changed files`,
          source: 'worktree',
          status: worktree.dirty ? 'dirty' : 'clean',
          failed: worktree.ok === false,
          ok: worktree.ok
        }
      ],
      historySummaries: historySignals,
      routineSummaries: routineSignals
    })
  })

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

  // 项目记忆:草稿→确认制,按项目隔离。projectRoot 取会话源目录(worktree 前的原仓库)
  const memoryRoot = (): string => join(app.getPath('userData'), 'memory')
  const projectRootFor = (sessionId: string): string | null => {
    const meta = sessionManager.get(sessionId)?.meta
    return meta ? (meta.sourceCwd ?? meta.cwd) : null
  }
  ipcMain.handle('memory:read', (_e, sessionId: string) => {
    const root = projectRootFor(sessionId)
    if (!root) return { projectHash: '', markdown: '', entries: [], drafts: [] }
    return readProjectMemory(root, memoryRoot())
  })
  ipcMain.handle('memory:propose', (_e, sessionId: string, input: ProjectMemoryDraftInput) => {
    const root = projectRootFor(sessionId)
    if (!root) throw new Error('会话不存在')
    return proposeMemoryDraft(root, memoryRoot(), input)
  })
  ipcMain.handle('memory:accept', (_e, sessionId: string, draftId: string) => {
    const root = projectRootFor(sessionId)
    if (!root) throw new Error('会话不存在')
    return acceptMemoryDraft(root, memoryRoot(), draftId)
  })
  ipcMain.handle('memory:delete', (_e, sessionId: string, entryId: string) => {
    const root = projectRootFor(sessionId)
    if (!root) throw new Error('会话不存在')
    return deleteMemoryEntry(root, memoryRoot(), entryId)
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
