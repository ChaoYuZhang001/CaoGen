import { app } from 'electron'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ImportedProviderUsageRollup } from '../../shared/provider-usage-types'
import { parseCcSwitchUsageDocument } from './ccSwitchUsageDocument'

const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024

export function readImportedProviderUsage(): ImportedProviderUsageRollup[] {
  const filePath = importedUsagePath()
  if (!existsSync(filePath)) return []
  const info = lstatSync(filePath)
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_DOCUMENT_BYTES) {
    throw new Error('Imported Provider usage document is invalid')
  }
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
  return parseCcSwitchUsageDocument(parsed).rows
}

function importedUsagePath(): string {
  const testHome = !app.isPackaged ? process.env.CAOGEN_PROVIDER_USAGE_IMPORT_HOME?.trim() : undefined
  return join(resolve(testHome || app.getPath('home')), '.caogen', 'usage', 'cc-switch-daily-rollups.json')
}
