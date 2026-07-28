import { ipcMain } from 'electron'
import type { SessionMeta } from '../../shared/types'
import {
  closeTerminalWithEffect,
  resizeTerminalWithEffect,
  startTerminalWithEffect,
  type TerminalEffectManager,
  writeTerminalWithEffect
} from '../terminalEffect'
import { executeInteractiveOperationEffect } from '../task/operation-effect-gateway'

export interface TerminalMutationIpcDependencies {
  getSessionMeta(id: string): SessionMeta | undefined
  manager: TerminalEffectManager
}

export function registerTerminalMutationIpc(dependencies: TerminalMutationIpcDependencies): void {
  ipcMain.handle(
    'terminals:start',
    (_event, id: string, options?: { cols?: number; rows?: number; reuse?: boolean }) => {
      const session = dependencies.getSessionMeta(id)
      if (!session) return { ok: false, error: '会话不存在' }
      return startTerminalWithEffect({
        sourceSessionId: session.id,
        projectId: session.projectId,
        cwd: session.cwd
      }, dependencies.manager, {
        cols: options?.cols,
        rows: options?.rows,
        reuse: options?.reuse
      }, executeInteractiveOperationEffect)
    }
  )

  ipcMain.handle('terminals:write', (_event, id: string, data: string) =>
    writeTerminalWithEffect(
      dependencies.manager,
      id,
      typeof data === 'string' ? data : '',
      executeInteractiveOperationEffect
    )
  )

  ipcMain.handle('terminals:resize', (_event, id: string, cols: number, rows: number) =>
    resizeTerminalWithEffect(
      dependencies.manager,
      id,
      cols,
      rows,
      executeInteractiveOperationEffect
    )
  )

  ipcMain.handle('terminals:close', (_event, id: string) =>
    closeTerminalWithEffect(dependencies.manager, id, executeInteractiveOperationEffect)
  )
}
