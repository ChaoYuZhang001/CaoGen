import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeCaoGenDriveMode } from '../shared/types'
import type { AppSettings } from '../shared/types'

const SIDEBAR_MIN_WIDTH = 220
const SIDEBAR_MAX_WIDTH = 420
const WORKBENCH_SIDE_MIN_WIDTH = 360
const WORKBENCH_SIDE_MAX_WIDTH = 900
const CHAT_SCALE_MIN = 0.85
const CHAT_SCALE_MAX = 1.25

const DEFAULTS: AppSettings = {
  driveMode: 'core',
  defaultModel: '',
  defaultPermissionMode: 'default',
  defaultProviderId: '',
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
  office: { showBadges: true, liveliness: 1, catEars: false },
  layout: {
    sidebarCollapsed: false,
    sidebarWidth: 264,
    workbenchSideWidth: 560,
    chatScale: 1,
    chatDensity: 'comfortable'
  }
}

let cache: AppSettings | null = null

function clampNumber(value: unknown, fallback: number, min: number, max: number, precision = 0): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  const clamped = Math.min(max, Math.max(min, numeric))
  if (precision <= 0) return Math.round(clamped)
  const factor = 10 ** precision
  return Math.round(clamped * factor) / factor
}

function normalizeLayout(raw: unknown): AppSettings['layout'] {
  const layout = raw && typeof raw === 'object' ? (raw as Partial<AppSettings['layout']>) : {}
  return {
    sidebarCollapsed:
      typeof layout.sidebarCollapsed === 'boolean' ? layout.sidebarCollapsed : DEFAULTS.layout.sidebarCollapsed,
    sidebarWidth: clampNumber(layout.sidebarWidth, DEFAULTS.layout.sidebarWidth, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH),
    workbenchSideWidth: clampNumber(
      layout.workbenchSideWidth,
      DEFAULTS.layout.workbenchSideWidth,
      WORKBENCH_SIDE_MIN_WIDTH,
      WORKBENCH_SIDE_MAX_WIDTH
    ),
    chatScale: clampNumber(layout.chatScale, DEFAULTS.layout.chatScale, CHAT_SCALE_MIN, CHAT_SCALE_MAX, 2),
    chatDensity: layout.chatDensity === 'compact' ? 'compact' : 'comfortable'
  }
}

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
      office: { ...DEFAULTS.office, ...(raw.office ?? {}) },
      layout: normalizeLayout(raw.layout)
    }
  } catch {
    cache = { ...DEFAULTS, office: { ...DEFAULTS.office }, layout: { ...DEFAULTS.layout } }
  }
  return cache
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const prev = getSettings()
  const next = {
    ...prev,
    ...patch,
    driveMode: patch.driveMode === undefined ? prev.driveMode : normalizeCaoGenDriveMode(patch.driveMode),
    office: { ...prev.office, ...(patch.office ?? {}) },
    layout: normalizeLayout({ ...prev.layout, ...(patch.layout ?? {}) })
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
