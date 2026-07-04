import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AgentDeskApi,
  AppSettings,
  CreateSessionOptions,
  PermissionModeId,
  ProviderInput,
  SaveImageAttachmentBytesInput,
  SendMessagePayload,
  SessionEventPayload
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
  createSession: (opts: CreateSessionOptions) => ipcRenderer.invoke('sessions:create', opts),
  copyImageAttachment: (sessionId: string, sourcePath: string) =>
    ipcRenderer.invoke('attachments:copyImage', sessionId, sourcePath),
  saveImageAttachmentBytes: (sessionId: string, input: SaveImageAttachmentBytesInput) =>
    ipcRenderer.invoke('attachments:saveImageBytes', sessionId, input),
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
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke('settings:update', patch),
  listProviders: () => ipcRenderer.invoke('providers:list'),
  createProvider: (provider: ProviderInput) => ipcRenderer.invoke('providers:create', provider),
  updateProvider: (id: string, patch: Partial<ProviderInput>) =>
    ipcRenderer.invoke('providers:update', id, patch),
  deleteProvider: (id: string) => ipcRenderer.invoke('providers:delete', id),
  fetchProviderModels: (opts: { baseUrl: string; token?: string; providerId?: string }) =>
    ipcRenderer.invoke('providers:fetchModels', opts),
  listProviderHealth: () => ipcRenderer.invoke('providers:health'),
  listEngines: () => ipcRenderer.invoke('engines:list'),
  getWorkspaceDiff: (sessionId: string) => ipcRenderer.invoke('workspace:diff', sessionId),
  getWorktreeSummary: (sessionId: string) => ipcRenderer.invoke('worktrees:summary', sessionId),
  exportWorktreePatch: (sessionId: string) => ipcRenderer.invoke('worktrees:exportPatch', sessionId),
  removeWorktree: (sessionId: string, opts?: { deleteBranch?: boolean; force?: boolean }) =>
    ipcRenderer.invoke('worktrees:remove', sessionId, opts),
  listProjectFiles: (sessionId: string) => ipcRenderer.invoke('files:list', sessionId),
  readTextFile: (sessionId: string, path: string) => ipcRenderer.invoke('files:read', sessionId, path),
  writeTextFile: (sessionId: string, path: string, content: string) =>
    ipcRenderer.invoke('files:write', sessionId, path, content),
  preparePreview: (sessionId: string, path: string) => ipcRenderer.invoke('preview:prepare', sessionId, path),
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
  onBrowserEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, event: Parameters<typeof cb>[0]): void => {
      cb(event)
    }
    ipcRenderer.on('browser:event', listener)
    return () => {
      ipcRenderer.removeListener('browser:event', listener)
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
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  onSessionEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, payload: SessionEventPayload): void => {
      cb(payload.sessionId, payload.event, payload.seq)
    }
    ipcRenderer.on('session:event', listener)
    return () => {
      ipcRenderer.removeListener('session:event', listener)
    }
  }
}

contextBridge.exposeInMainWorld('agentDesk', api)
