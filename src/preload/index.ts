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
  listHistory: () => ipcRenderer.invoke('history:list'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke('settings:update', patch),
  listProviders: () => ipcRenderer.invoke('providers:list'),
  createProvider: (provider: ProviderInput) => ipcRenderer.invoke('providers:create', provider),
  updateProvider: (id: string, patch: Partial<ProviderInput>) =>
    ipcRenderer.invoke('providers:update', id, patch),
  deleteProvider: (id: string) => ipcRenderer.invoke('providers:delete', id),
  listProviderHealth: () => ipcRenderer.invoke('providers:health'),
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
