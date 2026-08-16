import { app, ipcMain } from 'electron'
import type { SaveImageAttachmentBytesInput } from '../../shared/types'
import { executeInteractiveOperationEffect } from '../task/operation-effect-gateway'
import {
  executeInteractiveOperationEffectCopyDocument,
  executeInteractiveOperationEffectCopyImage,
  executeInteractiveOperationEffectSaveImageBytes
} from './renderer-mutation-handlers'

export function registerAttachmentMutationIpc(attachmentRoot: (sessionId: string) => string): void {
  ipcMain.handle('attachments:copyImage', async (_event, id: string, sourcePath: string) => {
    return executeInteractiveOperationEffectCopyImage(
      id, sourcePath, attachmentRoot(id), executeInteractiveOperationEffect, app.getPath('userData')
    )
  })

  ipcMain.handle('attachments:copyDocument', async (_event, id: string, sourcePath: string) => {
    return executeInteractiveOperationEffectCopyDocument(
      id, sourcePath, attachmentRoot(id), executeInteractiveOperationEffect, app.getPath('userData')
    )
  })

  ipcMain.handle(
    'attachments:saveImageBytes',
    async (_event, id: string, input: SaveImageAttachmentBytesInput) => {
      const data = input?.data
      if (typeof data !== 'string' && !(data instanceof ArrayBuffer)) {
        return { ok: false, error: '图片内容不能为空' }
      }
      return executeInteractiveOperationEffectSaveImageBytes(
        id,
        data,
        typeof input.mime === 'string' ? input.mime : undefined,
        attachmentRoot(id),
        executeInteractiveOperationEffect,
        app.getPath('userData')
      )
    }
  )
}
