import { BrowserWindow, dialog, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { ProviderProfileImportDecision } from '../../shared/types'
import type { ProviderProfileWebDavConfigInput } from '../../shared/provider-profile-webdav-types'
import type { ProviderProfileS3ConfigInput } from '../../shared/provider-profile-s3-types'
import {
  applyProviderProfileSync,
  configureProviderProfileSyncDirectory,
  disconnectProviderProfileSync,
  getProviderProfileSyncStatus,
  previewProviderProfileSync,
  publishProviderProfileSync
} from '../provider/providerProfileSync'
import {
  applyProviderProfileWebDavSync,
  applyProviderProfileWebDavHistory,
  getProviderProfileWebDavConfig,
  listProviderProfileWebDavHistory,
  previewProviderProfileWebDavHistory,
  previewProviderProfileWebDavSync,
  publishProviderProfileWebDavSync,
  removeProviderProfileWebDavConfig,
  saveProviderProfileWebDavConfig,
  testProviderProfileWebDavConnection
} from '../provider/providerProfileWebDavSync'
import {
  applyProviderProfileS3Sync,
  applyProviderProfileS3History,
  getProviderProfileS3Config,
  listProviderProfileS3History,
  previewProviderProfileS3History,
  previewProviderProfileS3Sync,
  publishProviderProfileS3Sync,
  removeProviderProfileS3Config,
  saveProviderProfileS3Config,
  testProviderProfileS3Connection
} from '../provider/providerProfileS3Sync'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

type ProviderProfileSyncAction =
  | 'status'
  | 'choose-directory'
  | 'disconnect'
  | 'preview'
  | 'publish'
  | 'apply'
  | ProviderProfileWebDavAction
  | ProviderProfileS3Action

export function handleProviderProfileSyncIpc(
  event: IpcMainInvokeEvent,
  action: unknown,
  ...args: unknown[]
) {
  assertTrustedWorkflowLedgerSender(event)
  if (!isSyncAction(action)) throw new Error('Provider 同步操作无效')
  if (isWebDavAction(action)) return handleWebDavAction(action, args)
  if (isS3Action(action)) return handleS3Action(action, args)
  if (action === 'status') return getProviderProfileSyncStatus()
  if (action === 'choose-directory') return chooseSyncDirectory(event.sender)
  if (action === 'disconnect') return disconnectProviderProfileSync()
  if (action === 'preview') return previewProviderProfileSync()
  if (action === 'publish') {
    return publishProviderProfileSync(typeof args[0] === 'string' ? args[0] : '', args[1] === true)
  }
  const previewId = typeof args[0] === 'string' ? args[0] : ''
  const decisions = Array.isArray(args[1]) ? args[1] as ProviderProfileImportDecision[] : []
  return applyProviderProfileSync(previewId, decisions)
}

type ProviderProfileWebDavAction =
  | 'webdav-config'
  | 'webdav-save'
  | 'webdav-remove'
  | 'webdav-test'
  | 'webdav-preview'
  | 'webdav-publish'
  | 'webdav-apply'
  | 'webdav-history-list'
  | 'webdav-history-preview'
  | 'webdav-history-apply'

function handleWebDavAction(action: ProviderProfileWebDavAction, args: unknown[]) {
  if (action.startsWith('webdav-history-')) return handleWebDavHistoryAction(action, args)
  if (action === 'webdav-config') return getProviderProfileWebDavConfig()
  if (action === 'webdav-remove') return removeProviderProfileWebDavConfig()
  if (action === 'webdav-test') return testProviderProfileWebDavConnection()
  if (action === 'webdav-preview') return previewProviderProfileWebDavSync()
  if (action === 'webdav-save') {
    if (!args[0] || typeof args[0] !== 'object') throw new Error('WebDAV configuration is invalid')
    return saveProviderProfileWebDavConfig(args[0] as ProviderProfileWebDavConfigInput)
  }
  if (action === 'webdav-publish') {
    return publishProviderProfileWebDavSync(typeof args[0] === 'string' ? args[0] : '', args[1] === true)
  }
  const previewId = typeof args[0] === 'string' ? args[0] : ''
  const decisions = Array.isArray(args[1]) ? args[1] as ProviderProfileImportDecision[] : []
  return applyProviderProfileWebDavSync(previewId, decisions)
}

function handleWebDavHistoryAction(action: ProviderProfileWebDavAction, args: unknown[]) {
  if (action === 'webdav-history-list') return listProviderProfileWebDavHistory()
  if (action === 'webdav-history-preview') {
    return previewProviderProfileWebDavHistory(typeof args[0] === 'string' ? args[0] : '')
  }
  const previewId = typeof args[0] === 'string' ? args[0] : ''
  const decisions = Array.isArray(args[1]) ? args[1] as ProviderProfileImportDecision[] : []
  return applyProviderProfileWebDavHistory(previewId, decisions)
}

type ProviderProfileS3Action =
  | 's3-config'
  | 's3-save'
  | 's3-remove'
  | 's3-test'
  | 's3-preview'
  | 's3-publish'
  | 's3-apply'
  | 's3-history-list'
  | 's3-history-preview'
  | 's3-history-apply'

function handleS3Action(action: ProviderProfileS3Action, args: unknown[]) {
  if (action.startsWith('s3-history-')) return handleS3HistoryAction(action, args)
  if (action === 's3-config') return getProviderProfileS3Config()
  if (action === 's3-remove') return removeProviderProfileS3Config()
  if (action === 's3-test') return testProviderProfileS3Connection()
  if (action === 's3-preview') return previewProviderProfileS3Sync()
  if (action === 's3-save') {
    if (!args[0] || typeof args[0] !== 'object') throw new Error('S3 configuration is invalid')
    return saveProviderProfileS3Config(args[0] as ProviderProfileS3ConfigInput)
  }
  if (action === 's3-publish') {
    return publishProviderProfileS3Sync(typeof args[0] === 'string' ? args[0] : '', args[1] === true)
  }
  const previewId = typeof args[0] === 'string' ? args[0] : ''
  const decisions = Array.isArray(args[1]) ? args[1] as ProviderProfileImportDecision[] : []
  return applyProviderProfileS3Sync(previewId, decisions)
}

function handleS3HistoryAction(action: ProviderProfileS3Action, args: unknown[]) {
  if (action === 's3-history-list') return listProviderProfileS3History()
  if (action === 's3-history-preview') {
    return previewProviderProfileS3History(typeof args[0] === 'string' ? args[0] : '')
  }
  const previewId = typeof args[0] === 'string' ? args[0] : ''
  const decisions = Array.isArray(args[1]) ? args[1] as ProviderProfileImportDecision[] : []
  return applyProviderProfileS3History(previewId, decisions)
}

async function chooseSyncDirectory(sender: WebContents) {
  const win = BrowserWindow.fromWebContents(sender) ?? BrowserWindow.getAllWindows()[0]
  const result = await dialog.showOpenDialog(win, {
    title: '选择 Provider 同步目录',
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return configureProviderProfileSyncDirectory(result.filePaths[0])
}

function isSyncAction(value: unknown): value is ProviderProfileSyncAction {
  return [
    'status', 'choose-directory', 'disconnect', 'preview', 'publish', 'apply',
    'webdav-config', 'webdav-save', 'webdav-remove', 'webdav-test',
    'webdav-preview', 'webdav-publish', 'webdav-apply',
    'webdav-history-list', 'webdav-history-preview', 'webdav-history-apply',
    's3-config', 's3-save', 's3-remove', 's3-test', 's3-preview', 's3-publish', 's3-apply',
    's3-history-list', 's3-history-preview', 's3-history-apply'
  ].includes(String(value))
}

function isWebDavAction(value: unknown): value is ProviderProfileWebDavAction {
  return String(value).startsWith('webdav-')
}

function isS3Action(value: unknown): value is ProviderProfileS3Action {
  return String(value).startsWith('s3-')
}
