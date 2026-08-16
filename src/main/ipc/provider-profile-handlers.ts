import { BrowserWindow, dialog, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { ProviderProfileImportDecision } from '../../shared/types'
import {
  applyProviderProfileBackupPreview,
  deleteProviderProfileBackup,
  applyProviderProfilePreview,
  exportProviderProfileToFile,
  listProviderProfileBackups,
  preflightProviderProfilePreview,
  previewProviderProfileBackup,
  previewProviderProfileFile,
  rollbackProviderProfileBackup
} from '../provider/providerProfileService'
import {
  applyCodexNativeProviderImport,
  listProviderNativeImportBackups,
  previewCodexNativeProviderImport,
  rollbackProviderNativeImportBackup
} from '../provider/providerNativeConfigImport'
import {
  applyCcSwitchProviderImport,
  listCcSwitchProviderImportBackups,
  previewCcSwitchProviderImport,
  rollbackCcSwitchProviderImportBackup
} from '../provider/ccSwitchProviderImport'
import {
  applyCodexNativeConfig,
  listCodexNativeConfigBackups,
  previewCodexNativeConfig,
  rollbackCodexNativeConfigBackup
} from '../provider/codexNativeConfigService'
import { executeProviderProfileOperationDelivery } from '../provider/provider-profile-operation-delivery'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

type ProviderProfileAction =
  | 'export'
  | 'preview'
  | 'apply'
  | 'backups'
  | 'backup-preview'
  | 'backup-apply'
  | 'backup-delete'
  | 'rollback'
  | 'native-codex-preview'
  | 'native-codex-apply'
  | 'cc-switch-preview'
  | 'cc-switch-apply'
  | 'cc-switch-backups'
  | 'cc-switch-rollback'
  | 'native-config-preview'
  | 'native-config-apply'
  | 'native-config-backups'
  | 'native-config-rollback'
  | 'native-backups'
  | 'native-rollback'

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
  if (action === 'backup-preview') {
    return previewProviderProfileBackup(typeof args[0] === 'string' ? args[0] : '')
  }
  if (action === 'backup-apply') {
    return executeProviderProfileOperationDelivery({
      operation: 'backup_restore',
      transport: 'local',
      title: 'Restore Provider Profile backup',
      objective: '恢复 Provider Profile 私有备份并生成脱敏、可验收的操作报告',
      execute: () => applyProviderProfileBackupPreview(typeof args[0] === 'string' ? args[0] : '')
    })
  }
  if (action === 'backup-delete') {
    const backupId = typeof args[0] === 'string' ? args[0] : ''
    return executeProviderProfileOperationDelivery({
      operation: 'backup_delete',
      transport: 'local',
      title: 'Delete Provider Profile backup',
      objective: '删除已过期或不再需要的 Provider Profile 私有备份并生成脱敏操作报告',
      backupId,
      execute: () => deleteProviderProfileBackup(backupId)
    })
  }
  if (action === 'native-codex-preview') return previewCodexNativeProviderImport()
  if (isCcSwitchProviderProfileAction(action)) return handleCcSwitchProviderProfileAction(action, args)
  if (action === 'native-backups') return listProviderNativeImportBackups()
  if (action === 'native-codex-apply') {
    const previewId = typeof args[0] === 'string' ? args[0] : ''
    const decision = args[1] === 'create' || args[1] === 'update' ? args[1] : 'skip'
    return applyCodexNativeProviderImport(previewId, decision)
  }
  if (action === 'native-rollback') {
    return rollbackProviderNativeImportBackup(typeof args[0] === 'string' ? args[0] : '')
  }
  if (isNativeConfigProviderProfileAction(action)) return handleNativeConfigProviderProfileAction(action, args)
  if (action === 'apply') {
    const previewId = typeof args[0] === 'string' ? args[0] : ''
    const decisions = Array.isArray(args[1]) ? args[1] as ProviderProfileImportDecision[] : []
    return executeProviderProfileOperationDelivery({
      operation: 'profile_import',
      transport: 'local',
      title: 'Import Provider Profile',
      objective: '应用无凭据 Provider Profile 并生成脱敏、可验收的操作报告',
      preflight: () => preflightProviderProfilePreview(previewId, decisions),
      execute: () => applyProviderProfilePreview(previewId, decisions)
    })
  }
  return executeProviderProfileOperationDelivery({
    operation: 'backup_restore',
    transport: 'local',
    title: 'Rollback Provider Profile backup',
    objective: '回滚 Provider Profile 私有备份并生成脱敏、可验收的操作报告',
    execute: () => rollbackProviderProfileBackup(typeof args[0] === 'string' ? args[0] : '')
  })
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
  return [
    'export', 'preview', 'apply', 'backups', 'backup-preview', 'backup-apply', 'backup-delete', 'rollback',
    'native-codex-preview', 'native-codex-apply', 'native-backups', 'native-rollback',
    'cc-switch-preview', 'cc-switch-apply', 'cc-switch-backups', 'cc-switch-rollback',
    'native-config-preview', 'native-config-apply', 'native-config-backups', 'native-config-rollback'
  ].includes(String(value))
}

type CcSwitchProviderProfileAction =
  | 'cc-switch-preview'
  | 'cc-switch-apply'
  | 'cc-switch-backups'
  | 'cc-switch-rollback'

type NativeConfigProviderProfileAction =
  | 'native-config-preview'
  | 'native-config-apply'
  | 'native-config-backups'
  | 'native-config-rollback'

function handleCcSwitchProviderProfileAction(action: CcSwitchProviderProfileAction, args: unknown[]) {
  if (action === 'cc-switch-preview') return previewCcSwitchProviderImport()
  if (action === 'cc-switch-backups') return listCcSwitchProviderImportBackups()
  if (action === 'cc-switch-rollback') {
    return rollbackCcSwitchProviderImportBackup(typeof args[0] === 'string' ? args[0] : '')
  }
  const previewId = typeof args[0] === 'string' ? args[0] : ''
  const decisions = Array.isArray(args[1]) ? args[1] as ProviderProfileImportDecision[] : []
  return applyCcSwitchProviderImport(previewId, decisions)
}

function isCcSwitchProviderProfileAction(value: unknown): value is CcSwitchProviderProfileAction {
  return ['cc-switch-preview', 'cc-switch-apply', 'cc-switch-backups', 'cc-switch-rollback'].includes(String(value))
}

function handleNativeConfigProviderProfileAction(action: NativeConfigProviderProfileAction, args: unknown[]) {
  if (action === 'native-config-preview') return previewCodexNativeConfig()
  if (action === 'native-config-backups') return listCodexNativeConfigBackups()
  if (action === 'native-config-rollback') {
    return rollbackCodexNativeConfigBackup(typeof args[0] === 'string' ? args[0] : '')
  }
  return applyCodexNativeConfig(
    typeof args[0] === 'string' ? args[0] : '',
    typeof args[1] === 'string' ? args[1] : ''
  )
}

function isNativeConfigProviderProfileAction(value: unknown): value is NativeConfigProviderProfileAction {
  return ['native-config-preview', 'native-config-apply', 'native-config-backups', 'native-config-rollback'].includes(String(value))
}
