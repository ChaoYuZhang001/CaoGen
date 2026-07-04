import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AgentDeskApi,
  AppSettings,
  CreateSessionOptions,
  PermissionModeId,
  ProviderInput,
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
  sendMessage: (sessionId: string, text: string) =>
    ipcRenderer.invoke('sessions:send', sessionId, text),
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
