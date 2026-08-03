import { BrowserWindow, dialog, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { ProviderProfileImportDecision } from '../../shared/types'
import {
  applyProviderProfilePreview,
  exportProviderProfileToFile,
  listProviderProfileBackups,
  previewProviderProfileFile,
  rollbackProviderProfileBackup
} from '../provider/providerProfileService'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

type ProviderProfileAction = 'export' | 'preview' | 'apply' | 'backups' | 'rollback'

export async function handleProviderProfileIpc(
  event: IpcMainInvokeEvent,
  action: unknown,
  ...args: unknown[]
) {
  assertTrustedWorkflowLedgerSender(event)
  if (!isProviderProfileAction(action)) throw new Error('Provider Profile 操作无效')
  if (action === 'export') return exportProfile(event.sender)
  if (action === 'preview') return previewProfile(event.sender)
  if (action === 'backups') return listProviderProfileBackups()
  if (action === 'apply') {
    const previewId = typeof args[0] === 'string' ? args[0] : ''
    const decisions = Array.isArray(args[1]) ? args[1] as ProviderProfileImportDecision[] : []
    return applyProviderProfilePreview(previewId, decisions)
  }
  return rollbackProviderProfileBackup(typeof args[0] === 'string' ? args[0] : '')
}

async function exportProfile(sender: WebContents) {
  const win = BrowserWindow.fromWebContents(sender) ?? BrowserWindow.getAllWindows()[0]
  const result = await dialog.showSaveDialog(win, {
    title: '导出 Provider Profile（不含密钥）',
    defaultPath: `caogen-provider-profile-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (result.canceled || !result.filePath) return { canceled: true, providerCount: 0 }
  return { canceled: false, ...exportProviderProfileToFile(result.filePath) }
}

async function previewProfile(sender: WebContents) {
  const win = BrowserWindow.fromWebContents(sender) ?? BrowserWindow.getAllWindows()[0]
  const result = await dialog.showOpenDialog(win, {
    title: '导入 Provider Profile',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return previewProviderProfileFile(result.filePaths[0])
}

function isProviderProfileAction(value: unknown): value is ProviderProfileAction {
  return ['export', 'preview', 'apply', 'backups', 'rollback'].includes(String(value))
}
