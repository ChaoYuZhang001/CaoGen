import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_PROVIDER_ID, normalizeCaoGenDriveMode } from '../shared/types'
import type { AppSettings } from '../shared/types'

const DEFAULTS: AppSettings = {
  driveMode: 'core',
  defaultModel: DEEPSEEK_DEFAULT_MODEL,
  defaultPermissionMode: 'default',
  defaultProviderId: DEEPSEEK_PROVIDER_ID,
  schedulerStrategy: 'balanced',
  smartModelRoutingEnabled: false,
  modelCrossValidationAutoRunEnabled: false,
  budgetUsdPerSession: 0,
  budgetUsdPerMonth: 0,
  failoverEnabled: true,
  language: 'zh',
  theme: 'dark',
  persona: '',
  allowedTools: '',
  disallowedTools: '',
  sandboxMode: 'loose',
  sandboxDockerImage: 'caogen-sandbox:latest',
  chinaEcosystemMirrorEnabled: false,
  chinaNpmRegistry: '',
  chinaPipIndexUrl: '',
  chinaDockerRegistryMirror: '',
  permissionAllowlist: '',
  permissionDenylist: '',
  permissionTemporaryAllowlist: '',
  guiAutomationEnabled: false,
  guiAutomationTemporaryGrantUntil: 0,
  notificationsEnabled: true,
  preventDisplaySleep: true,
  sdkAgentsEnabled: false,
  ideBridgeEnabled: false,
  ideBridgeHost: '127.0.0.1',
  ideBridgePort: 17365,
  ideBridgeToken: '',
  hookPostEditCommand: '',
  hookTurnEndCommand: '',
  autoSkillLearningEnabled: false,
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
    cache = {
      ...DEFAULTS,
      ...raw,
      driveMode: normalizeCaoGenDriveMode(raw.driveMode),
      office: { ...DEFAULTS.office, ...(raw.office ?? {}) }
    }
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const prev = getSettings()
  const next = {
    ...prev,
    ...patch,
    driveMode: patch.driveMode === undefined ? prev.driveMode : normalizeCaoGenDriveMode(patch.driveMode),
    office: { ...prev.office, ...(patch.office ?? {}) }
  }
  cache = next
  try {
    mkdirSync(dirname(settingsFile()), { recursive: true })
    writeFileSync(settingsFile(), JSON.stringify(next, null, 2))
  } catch (err) {
    console.error('[agent-desk] 保存设置失败:', err)
  }
  return next
}
