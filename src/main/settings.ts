import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppSettings } from '../shared/types'

const DEFAULTS: AppSettings = {
  defaultModel: '',
  defaultPermissionMode: 'default',
  defaultProviderId: '',
  schedulerStrategy: 'balanced',
  language: 'zh',
  persona: '',
  allowedTools: '',
  disallowedTools: '',
  office: { showBadges: true, liveliness: 1, catEars: false }
}

let cache: AppSettings | null = null

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function getSettings(): AppSettings {
  if (cache) return cache
  try {
    const raw = JSON.parse(readFileSync(settingsFile(), 'utf8')) as Partial<AppSettings>
    cache = { ...DEFAULTS, ...raw, office: { ...DEFAULTS.office, ...(raw.office ?? {}) } }
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const prev = getSettings()
  const next = { ...prev, ...patch, office: { ...prev.office, ...(patch.office ?? {}) } }
  cache = next
  try {
    mkdirSync(dirname(settingsFile()), { recursive: true })
    writeFileSync(settingsFile(), JSON.stringify(next, null, 2))
  } catch (err) {
    console.error('[agent-desk] 保存设置失败:', err)
  }
  return next
}
