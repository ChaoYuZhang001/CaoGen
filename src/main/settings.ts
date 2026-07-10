import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeCaoGenDriveMode } from '../shared/types'
import type { AppSettings, ModelRoutingRule, ModelRoutingTaskKind, SchedulerStrategy } from '../shared/types'

const SIDEBAR_MIN_WIDTH = 220
const SIDEBAR_MAX_WIDTH = 420
const WORKBENCH_SIDE_MIN_WIDTH = 360
const WORKBENCH_SIDE_MAX_WIDTH = 900
const CHAT_SCALE_MIN = 0.85
const CHAT_SCALE_MAX = 1.25
const MODEL_ROUTING_TASK_KINDS = new Set<ModelRoutingTaskKind>([
  'chat',
  'coding',
  'reasoning',
  'vision',
  'toolUse',
  'longContext',
  'review',
  'summarization'
])

const DEFAULTS: AppSettings = {
  driveMode: 'core',
  defaultModel: '',
  defaultPermissionMode: 'default',
  defaultProviderId: '',
  fallbackProviderId: '',
  fallbackModel: '',
  lowCostProviderId: '',
  lowCostModel: '',
  strongReasoningProviderId: '',
  strongReasoningModel: '',
  reviewProviderId: '',
  reviewModel: '',
  schedulerStrategy: 'balanced',
  modelRoutingRules: [],
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

function normalizeSchedulerStrategy(raw: unknown, fallback: SchedulerStrategy): SchedulerStrategy {
  return raw === 'quality' || raw === 'cost' || raw === 'speed' || raw === 'balanced' ? raw : fallback
}

function normalizeModelRoutingRules(raw: unknown): ModelRoutingRule[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item, index): ModelRoutingRule | null => {
      if (!item || typeof item !== 'object') return null
      const record = item as Partial<ModelRoutingRule>
      const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : `rule-${index + 1}`
      const name = typeof record.name === 'string' ? record.name.slice(0, 80) : ''
      const match = typeof record.match === 'string' ? record.match.slice(0, 500) : ''
      const keywordMode = record.keywordMode === 'all' ? 'all' : 'any'
      const taskKinds = Array.isArray(record.taskKinds)
        ? [...new Set(record.taskKinds.filter((item): item is ModelRoutingTaskKind => MODEL_ROUTING_TASK_KINDS.has(item as ModelRoutingTaskKind)))].slice(0, MODEL_ROUTING_TASK_KINDS.size)
        : []
      const minRiskLevel =
        record.minRiskLevel === 'low' || record.minRiskLevel === 'medium' || record.minRiskLevel === 'high'
          ? record.minRiskLevel
          : undefined
      const whenStrategy =
        record.whenStrategy === 'quality' ||
        record.whenStrategy === 'cost' ||
        record.whenStrategy === 'speed' ||
        record.whenStrategy === 'balanced'
          ? record.whenStrategy
          : undefined
      const providerId = typeof record.providerId === 'string' ? record.providerId.trim() : ''
      const model = typeof record.model === 'string' ? record.model.trim() : ''
      if (!name && !match && taskKinds.length === 0 && !minRiskLevel && !whenStrategy && !providerId && !model) return null
      return {
        id,
        enabled: record.enabled !== false,
        name,
        match,
        keywordMode,
        taskKinds,
        minRiskLevel,
        whenStrategy,
        providerId,
        model
      }
    })
    .filter((item): item is ModelRoutingRule => Boolean(item))
    .slice(0, 20)
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
      schedulerStrategy: normalizeSchedulerStrategy(raw.schedulerStrategy, DEFAULTS.schedulerStrategy),
      modelRoutingRules: normalizeModelRoutingRules(raw.modelRoutingRules),
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
    schedulerStrategy:
      patch.schedulerStrategy === undefined
        ? prev.schedulerStrategy
        : normalizeSchedulerStrategy(patch.schedulerStrategy, prev.schedulerStrategy),
    modelRoutingRules:
      patch.modelRoutingRules === undefined ? prev.modelRoutingRules : normalizeModelRoutingRules(patch.modelRoutingRules),
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
