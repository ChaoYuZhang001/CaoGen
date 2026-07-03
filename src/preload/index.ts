import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AgentDeskApi,
  AppSettings,
  CreateSessionOptions,
  PermissionModeId,
  SessionEventPayload
} from '../shared/types'

const api: AgentDeskApi = {
  listSessions: () => ipcRenderer.invoke('sessions:list'),
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
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  onSessionEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, payload: SessionEventPayload): void => {
      cb(payload.sessionId, payload.event)
    }
    ipcRenderer.on('session:event', listener)
    return () => {
      ipcRenderer.removeListener('session:event', listener)
    }
  }
}

contextBridge.exposeInMainWorld('agentDesk', api)
