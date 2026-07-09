import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AgentDeskApi,
  AppSettings,
  CheckpointRestoreMode,
  CreateRoutineInput,
  CreateSessionOptions,
  DispatchSubagentsInput,
  LayeredMemorySearchInput,
  LayeredMemoryUpdateInput,
  LayeredMemoryWriteInput,
  MarkRunOptions,
  MenuCommand,
  MemorySuggestionEvent,
  PermissionModeId,
  PreviewAnnotationInput,
  PluginRegistryScanOptions,
  ProjectMemoryDraftInput,
  ProviderModelFetchInput,
  ProviderInput,
  QuickbarClipboardInput,
  QuickbarFileInput,
  QuickbarScreenshotInput,
  SaveImageAttachmentBytesInput,
  SendMessagePayload,
  SessionEventPayload,
  TaskDagDispatchInput,
  TaskDecomposeInput,
  UpdateRoutineInput
} from '../shared/types'

const api: AgentDeskApi = {
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  listPendingPermissions: (sessionId: string) =>
    ipcRenderer.invoke('sessions:pendingPermissions', sessionId),
  getTranscript: (sessionId: string) => ipcRenderer.invoke('sessions:transcript', sessionId),
  suggestFiles: (sessionId: string, query: string) =>
    ipcRenderer.invoke('sessions:suggestFiles', sessionId, query),
  rewindFiles: (sessionId: string, messageId: string, dryRun: boolean) =>
    ipcRenderer.invoke('sessions:rewindFiles', sessionId, messageId, dryRun),
  restoreCheckpoint: (
    sessionId: string,
    messageId: string,
    mode: CheckpointRestoreMode,
    dryRun: boolean
  ) => ipcRenderer.invoke('sessions:restoreCheckpoint', sessionId, messageId, mode, dryRun),
  createSession: (opts: CreateSessionOptions) => ipcRenderer.invoke('sessions:create', opts),
  decomposeTask: (parentSessionId: string, input: TaskDecomposeInput) =>
    ipcRenderer.invoke('sessions:decomposeTask', parentSessionId, input),
  dispatchSubagents: (parentSessionId: string, input: DispatchSubagentsInput) =>
    ipcRenderer.invoke('sessions:dispatchSubagents', parentSessionId, input),
  dispatchTaskDag: (parentSessionId: string, input: TaskDagDispatchInput) =>
    ipcRenderer.invoke('sessions:dispatchTaskDag', parentSessionId, input),
  listSupportedAgents: (sessionId: string) => ipcRenderer.invoke('sessions:supportedAgents', sessionId),
  listTaskSnapshots: () => ipcRenderer.invoke('taskSnapshots:list'),
  recoverTaskSnapshot: (snapshotId: string) =>
    ipcRenderer.invoke('taskSnapshots:recover', snapshotId),
  deleteTaskSnapshot: (snapshotId: string) =>
    ipcRenderer.invoke('taskSnapshots:delete', snapshotId),
  copyImageAttachment: (sessionId: string, sourcePath: string) =>
    ipcRenderer.invoke('attachments:copyImage', sessionId, sourcePath),
  saveImageAttachmentBytes: (sessionId: string, input: SaveImageAttachmentBytesInput) =>
    ipcRenderer.invoke('attachments:saveImageBytes', sessionId, input),
  ocrImageAttachment: (sessionId: string, imagePath: string) =>
    ipcRenderer.invoke('attachments:ocr', sessionId, imagePath),
  sendMessage: (sessionId: string, payload: string | SendMessagePayload) =>
    ipcRenderer.invoke('sessions:send', sessionId, payload),
  interrupt: (sessionId: string) => ipcRenderer.invoke('sessions:interrupt', sessionId),
  closeSession: (sessionId: string) => ipcRenderer.invoke('sessions:close', sessionId),
  respondPermission: (sessionId: string, requestId: string, allow: boolean, message?: string) =>
    ipcRenderer.invoke('sessions:permission', sessionId, requestId, allow, message),
  setPermissionMode: (sessionId: string, mode: PermissionModeId) =>
    ipcRenderer.invoke('sessions:setPermissionMode', sessionId, mode),
  setModel: (sessionId: string, model: string) =>
    ipcRenderer.invoke('sessions:setModel', sessionId, model),
  renameSession: (sessionId: string, title: string) =>
    ipcRenderer.invoke('sessions:rename', sessionId, title),
  listHistory: () => ipcRenderer.invoke('history:list'),
  searchTranscripts: (query: string) => ipcRenderer.invoke('transcripts:search', query),
  setHistoryArchived: (id: string, archived: boolean) =>
    ipcRenderer.invoke('history:setArchived', id, archived),
  setHistoryPinned: (id: string, pinned: boolean) =>
    ipcRenderer.invoke('history:setPinned', id, pinned),
  renameHistory: (id: string, title: string) => ipcRenderer.invoke('history:rename', id, title),
  deleteHistory: (id: string) => ipcRenderer.invoke('history:delete', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke('settings:update', patch),
  listProviders: () => ipcRenderer.invoke('providers:list'),
  createProvider: (provider: ProviderInput) => ipcRenderer.invoke('providers:create', provider),
  updateProvider: (id: string, patch: Partial<ProviderInput>) =>
    ipcRenderer.invoke('providers:update', id, patch),
  deleteProvider: (id: string) => ipcRenderer.invoke('providers:delete', id),
  fetchProviderModels: (opts: ProviderModelFetchInput) =>
    ipcRenderer.invoke('providers:fetchModels', opts),
  listProviderHealth: () => ipcRenderer.invoke('providers:health'),
  listEngines: () => ipcRenderer.invoke('engines:list'),
  scanPluginRegistry: (sessionId?: string, options?: PluginRegistryScanOptions) =>
    ipcRenderer.invoke('plugins:scan', sessionId, options),
  revealPluginRegistryItem: (path: string, sessionId?: string) =>
    ipcRenderer.invoke('plugins:reveal', path, sessionId),
  setPluginRegistryItemEnabled: (item, enabled, sessionId?: string) =>
    ipcRenderer.invoke('plugins:setEnabled', item, enabled, sessionId),
  probeMcpServers: (items, sessionId?: string) =>
    ipcRenderer.invoke('plugins:probeMcp', items, sessionId),
  installLocalPlugin: (sourcePath?: string, overwrite?: boolean) =>
    ipcRenderer.invoke('plugins:installLocal', sourcePath, overwrite),
  uninstallPlugin: (targetPath: string) => ipcRenderer.invoke('plugins:uninstall', targetPath),
  listRoutines: () => ipcRenderer.invoke('routines:list'),
  createRoutine: (input: CreateRoutineInput) => ipcRenderer.invoke('routines:create', input),
  deleteRoutine: (id: string) => ipcRenderer.invoke('routines:delete', id),
  updateRoutine: (id: string, patch: UpdateRoutineInput) =>
    ipcRenderer.invoke('routines:update', id, patch),
  markRoutineRun: (id: string, options?: MarkRunOptions) =>
    ipcRenderer.invoke('routines:markRun', id, options),
  runRoutineNow: (id: string) => ipcRenderer.invoke('routines:runNow', id),
  listRoutineRuns: (routineId?: string) => ipcRenderer.invoke('routines:listRuns', routineId),
  listRoutineTemplates: () => ipcRenderer.invoke('routines:listTemplates'),
  getStartSuggestions: (sessionId: string) => ipcRenderer.invoke('startSuggestions:get', sessionId),
  gitStatus: (sessionId: string) => ipcRenderer.invoke('git:status', sessionId),
  stageFiles: (sessionId: string, paths: string[]) => ipcRenderer.invoke('git:stage', sessionId, paths),
  stageAll: (sessionId: string) => ipcRenderer.invoke('git:stageAll', sessionId),
  unstageFiles: (sessionId: string, paths: string[]) => ipcRenderer.invoke('git:unstage', sessionId, paths),
  gitCommit: (sessionId: string, message: string) => ipcRenderer.invoke('git:commit', sessionId, message),
  getWorkspaceDiff: (sessionId: string) => ipcRenderer.invoke('workspace:diff', sessionId),
  applyWorkspaceHunk: (sessionId: string, filePath: string, hunkPatch: string) =>
    ipcRenderer.invoke('workspace:applyHunk', sessionId, filePath, hunkPatch),
  discardWorkspaceHunk: (sessionId: string, filePath: string, hunkPatch: string) =>
    ipcRenderer.invoke('workspace:discardHunk', sessionId, filePath, hunkPatch),
  getWorktreeSummary: (sessionId: string) => ipcRenderer.invoke('worktrees:summary', sessionId),
  exportWorktreePatch: (sessionId: string) => ipcRenderer.invoke('worktrees:exportPatch', sessionId),
  inspectWorktreeMerge: (sessionId: string) => ipcRenderer.invoke('worktrees:mergeInspect', sessionId),
  createWorktreeMergePatch: (sessionId: string) => ipcRenderer.invoke('worktrees:mergePatch', sessionId),
  checkWorktreeApply: (sessionId: string) => ipcRenderer.invoke('worktrees:applyCheck', sessionId),
  applyWorktreePatch: (sessionId: string) => ipcRenderer.invoke('worktrees:applyPatch', sessionId),
  getWorktreeConflictFiles: (sessionId: string) =>
    ipcRenderer.invoke('worktrees:conflictFiles', sessionId),
  listWorktreeMergeReceipts: () => ipcRenderer.invoke('worktrees:mergeReceipts'),
  createWorktreePullRequest: (sessionId: string) =>
    ipcRenderer.invoke('worktrees:createPr', sessionId),
  removeWorktree: (sessionId: string, opts?: { deleteBranch?: boolean; force?: boolean }) =>
    ipcRenderer.invoke('worktrees:remove', sessionId, opts),
  listProjectFiles: (sessionId: string) => ipcRenderer.invoke('files:list', sessionId),
  readTextFile: (sessionId: string, path: string) => ipcRenderer.invoke('files:read', sessionId, path),
  writeTextFile: (sessionId: string, path: string, content: string) =>
    ipcRenderer.invoke('files:write', sessionId, path, content),
  preparePreview: (sessionId: string, path: string) => ipcRenderer.invoke('preview:prepare', sessionId, path),
  savePreviewAnnotation: (sessionId: string, input: PreviewAnnotationInput) =>
    ipcRenderer.invoke('preview:saveAnnotation', sessionId, input),
  listPreviewAnnotations: (sessionId: string, path?: string) =>
    ipcRenderer.invoke('preview:listAnnotations', sessionId, path),
  openBrowser: (sessionId: string, url?: string) => ipcRenderer.invoke('browser:open', sessionId, url),
  navigateBrowser: (sessionId: string, url: string) =>
    ipcRenderer.invoke('browser:navigate', sessionId, url),
  setBrowserBounds: (sessionId: string, bounds) => ipcRenderer.invoke('browser:bounds', sessionId, bounds),
  browserGoBack: (sessionId: string) => ipcRenderer.invoke('browser:back', sessionId),
  browserGoForward: (sessionId: string) => ipcRenderer.invoke('browser:forward', sessionId),
  reloadBrowser: (sessionId: string) => ipcRenderer.invoke('browser:reload', sessionId),
  closeBrowser: (sessionId: string) => ipcRenderer.invoke('browser:close', sessionId),
  captureBrowserAnnotation: (sessionId: string, note: string) =>
    ipcRenderer.invoke('browser:captureAnnotation', sessionId, note),
  listBrowserAnnotations: (sessionId: string) =>
    ipcRenderer.invoke('browser:listAnnotations', sessionId),
  pickBrowserElement: (sessionId: string) => ipcRenderer.invoke('browser:pickElement', sessionId),
  captureBrowserElementAnnotation: (sessionId: string, pick, note: string) =>
    ipcRenderer.invoke('browser:captureElementAnnotation', sessionId, pick, note),
  observeBrowser: (sessionId: string) => ipcRenderer.invoke('browser:observe', sessionId),
  onBrowserEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, event: Parameters<typeof cb>[0]): void => {
      cb(event)
    }
    ipcRenderer.on('browser:event', listener)
    return () => {
      ipcRenderer.removeListener('browser:event', listener)
    }
  },
  onMenuCommand: (cb) => {
    const listeners: Array<[string, (e: IpcRendererEvent, value?: unknown) => void]> = [
      ['menu:new-session', () => cb({ type: 'new-session' })],
      ['menu:settings', () => cb({ type: 'settings' })],
      ['menu:command-palette', () => cb({ type: 'command-palette' })],
      ['menu:open-search', () => cb({ type: 'open-search' })],
      [
        'menu:select-session',
        (_e, value) => {
          const index = typeof value === 'number' ? value : Number(value)
          if (Number.isInteger(index) && index >= 0) cb({ type: 'select-session', index } satisfies MenuCommand)
        }
      ]
    ]
    for (const [channel, listener] of listeners) ipcRenderer.on(channel, listener)
    return () => {
      for (const [channel, listener] of listeners) ipcRenderer.removeListener(channel, listener)
    }
  },
  listTerminals: () => ipcRenderer.invoke('terminals:list'),
  startTerminal: (sessionId: string, opts?: { cols?: number; rows?: number; reuse?: boolean }) =>
    ipcRenderer.invoke('terminals:start', sessionId, opts),
  writeTerminal: (id: string, data: string) => ipcRenderer.invoke('terminals:write', id, data),
  resizeTerminal: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke('terminals:resize', id, cols, rows),
  closeTerminal: (id: string) => ipcRenderer.invoke('terminals:close', id),
  onTerminalEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, event: Parameters<typeof cb>[0]): void => {
      cb(event)
    }
    ipcRenderer.on('terminal:event', listener)
    return () => {
      ipcRenderer.removeListener('terminal:event', listener)
    }
  },
  scanMigration: (cwd: string) => ipcRenderer.invoke('migration:scan', cwd),
  importMigrationAssets: (cwd: string, paths: string[]) =>
    ipcRenderer.invoke('migration:import', cwd, paths),
  listProjects: () => ipcRenderer.invoke('projects:list'),
  updateProject: (id: string, patch: { name?: string }) =>
    ipcRenderer.invoke('projects:update', id, patch),
  deleteProject: (id: string) => ipcRenderer.invoke('projects:delete', id),
  readProjectContext: (projectPath: string) =>
    ipcRenderer.invoke('projectContext:read', projectPath),
  writeProjectContext: (projectPath: string, content: string) =>
    ipcRenderer.invoke('projectContext:write', projectPath, content),
  generateProjectContextTemplate: (projectPath: string) =>
    ipcRenderer.invoke('projectContext:template', projectPath),
  readProjectMemory: (sessionId: string) => ipcRenderer.invoke('memory:read', sessionId),
  proposeMemoryDraft: (sessionId: string, input: ProjectMemoryDraftInput) =>
    ipcRenderer.invoke('memory:propose', sessionId, input),
  acceptMemoryDraft: (sessionId: string, draftId: string) =>
    ipcRenderer.invoke('memory:accept', sessionId, draftId),
  deleteMemoryEntry: (sessionId: string, entryId: string) =>
    ipcRenderer.invoke('memory:delete', sessionId, entryId),
  listLayeredMemories: () => ipcRenderer.invoke('memory:layeredList'),
  searchLayeredMemories: (sessionId: string | undefined, input: LayeredMemorySearchInput) =>
    ipcRenderer.invoke('memory:layeredSearch', sessionId, input),
  addLayeredMemory: (sessionId: string | undefined, input: LayeredMemoryWriteInput) =>
    ipcRenderer.invoke('memory:layeredAdd', sessionId, input),
  archiveLayeredMemories: (olderThanDays?: number) =>
    ipcRenderer.invoke('memory:layeredArchive', olderThanDays),
  exportLayeredMemories: () => ipcRenderer.invoke('memory:layeredExport'),
  updateLayeredMemory: (entryId: string, input: LayeredMemoryUpdateInput) =>
    ipcRenderer.invoke('memory:layeredUpdate', entryId, input),
  deleteLayeredMemory: (entryId: string) => ipcRenderer.invoke('memory:layeredDelete', entryId),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  quickbarGetState: () => ipcRenderer.invoke('quickbar:getState'),
  quickbarSetVisible: (visible: boolean) => ipcRenderer.invoke('quickbar:setVisible', visible),
  quickbarGetWindowContext: (cwd?: string, sourceId?: string) =>
    ipcRenderer.invoke('quickbar:getWindowContext', cwd, sourceId),
  quickbarReadClipboard: (input?: QuickbarClipboardInput) =>
    ipcRenderer.invoke('quickbar:readClipboard', input),
  quickbarCaptureScreenshot: (input: QuickbarScreenshotInput) =>
    ipcRenderer.invoke('quickbar:captureScreenshot', input),
  quickbarPickFiles: () => ipcRenderer.invoke('quickbar:pickFiles'),
  quickbarPrepareFiles: (input: QuickbarFileInput) =>
    ipcRenderer.invoke('quickbar:prepareFiles', input),
  onQuickbarEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, event: Parameters<typeof cb>[0]): void => {
      cb(event)
    }
    ipcRenderer.on('quickbar:event', listener)
    return () => {
      ipcRenderer.removeListener('quickbar:event', listener)
    }
  },
  onSessionEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, payload: SessionEventPayload): void => {
      cb(payload.sessionId, payload.event, payload.seq)
    }
    ipcRenderer.on('session:event', listener)
    return () => {
      ipcRenderer.removeListener('session:event', listener)
    }
  },
  onMemorySuggestion: (cb) => {
    const listener = (_e: IpcRendererEvent, event: MemorySuggestionEvent): void => {
      cb(event)
    }
    ipcRenderer.on('memory:suggestion', listener)
    return () => {
      ipcRenderer.removeListener('memory:suggestion', listener)
    }
  }
}

contextBridge.exposeInMainWorld('agentDesk', api)
