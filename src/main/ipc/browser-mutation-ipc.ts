import { BrowserWindow, ipcMain } from 'electron'
import type { SessionMeta } from '../../shared/types'
import {
  browserGoBackWithEffect,
  browserGoForwardWithEffect,
  navigateBrowserWithEffect,
  openBrowserWithEffect,
  reloadBrowserWithEffect,
  type BrowserEffectContext,
  type BrowserEffectManager
} from '../browserEffect'
import type { BrowserBounds } from '../../shared/types'
import { executeInteractiveOperationEffect } from '../task/operation-effect-gateway'

export interface BrowserMutationIpcDependencies {
  getSessionMeta(id: string): SessionMeta | undefined
  manager: BrowserEffectManager & {
    setBounds(sessionId: string, bounds: BrowserBounds): void
    close(sessionId: string): void
  }
}

export function registerBrowserMutationIpc(dependencies: BrowserMutationIpcDependencies): void {
  ipcMain.handle('browser:open', (event, id: string, url?: string) => {
    const context = operationContext(dependencies, id)
    if (!context) return { ok: false, error: '会话不存在' }
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner) return { ok: false, error: '浏览器宿主窗口不存在' }
    return openBrowserWithEffect(
      context,
      dependencies.manager,
      owner,
      typeof url === 'string' ? url : undefined,
      executeInteractiveOperationEffect
    )
  })

  ipcMain.handle('browser:navigate', (_event, id: string, url: string) => {
    const context = operationContext(dependencies, id)
    if (!context) return { ok: false, error: '会话不存在' }
    return navigateBrowserWithEffect(
      context,
      dependencies.manager,
      typeof url === 'string' ? url : '',
      executeInteractiveOperationEffect
    )
  })

  ipcMain.handle('browser:back', (_event, id: string) => {
    const context = operationContext(dependencies, id)
    if (!context) return { ok: false, error: '会话不存在' }
    return browserGoBackWithEffect(
      context,
      dependencies.manager,
      executeInteractiveOperationEffect
    )
  })

  ipcMain.handle('browser:forward', (_event, id: string) => {
    const context = operationContext(dependencies, id)
    if (!context) return { ok: false, error: '会话不存在' }
    return browserGoForwardWithEffect(
      context,
      dependencies.manager,
      executeInteractiveOperationEffect
    )
  })

  ipcMain.handle('browser:reload', (_event, id: string) => {
    const context = operationContext(dependencies, id)
    if (!context) return { ok: false, error: '会话不存在' }
    return reloadBrowserWithEffect(
      context,
      dependencies.manager,
      executeInteractiveOperationEffect
    )
  })

  ipcMain.handle('browser:bounds', (_event, id: string, bounds: BrowserBounds) => {
    dependencies.manager.setBounds(id, bounds)
  })

  ipcMain.handle('browser:close', (_event, id: string) => {
    dependencies.manager.close(id)
  })
}

function operationContext(
  dependencies: BrowserMutationIpcDependencies,
  id: string
): BrowserEffectContext | undefined {
  const session = dependencies.getSessionMeta(id)
  if (!session) return undefined
  return {
    sourceSessionId: session.id,
    projectId: session.projectId,
    cwd: session.cwd
  }
}
