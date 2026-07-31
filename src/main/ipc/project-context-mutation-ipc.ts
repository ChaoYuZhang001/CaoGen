import { ipcMain } from 'electron'
import { executeProjectContextWriteEffect } from '../projectContextEffect'
import { executeInteractiveOperationEffect } from '../task/operation-effect-gateway'

export function registerProjectContextMutationIpc(): void {
  ipcMain.handle('projectContext:write', (_event, projectPath: string, content: string) =>
    executeProjectContextWriteEffect(projectPath, content, executeInteractiveOperationEffect)
  )
}
