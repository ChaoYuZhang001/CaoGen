import { BrowserWindow, dialog, ipcMain } from 'electron'
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
import type {
  AppSettings,
  CreateSessionOptions,
  PermissionModeId,
  ProviderInput
} from '../shared/types'

export function registerIpc(): void {
  ipcMain.handle('sessions:list', () => sessionManager.list())

  ipcMain.handle('sessions:pendingPermissions', (_e, id: string) =>
    sessionManager.get(id)?.pendingPermissions() ?? []
  )

  ipcMain.handle('sessions:transcript', (_e, id: string) => sessionManager.getTranscript(id))

  ipcMain.handle('sessions:create', (_e, opts: CreateSessionOptions) => {
    if (!opts || typeof opts.cwd !== 'string' || opts.cwd.length === 0) {
      throw new Error('必须指定工作目录')
    }
    return sessionManager.create(opts)
  })

  ipcMain.handle('sessions:send', (_e, id: string, text: string) => {
    if (typeof text !== 'string' || text.trim().length === 0) return
    sessionManager.get(id)?.send(text)
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
