import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeCaoGenDriveMode } from '../shared/types'
import type {
  AppSettings,
  ModelRoutingRule,
  ModelRoutingTaskKind,
  OfficeQualityMode,
  SchedulerStrategy
} from '../shared/types'

const SIDEBAR_MIN_WIDTH = 220
const SIDEBAR_MAX_WIDTH = 420
const WORKBENCH_SIDE_MIN_WIDTH = 360
const WORKBENCH_SIDE_MAX_WIDTH = 900
const CHAT_SCALE_MIN = 0.85
const CHAT_SCALE_MAX = 1.25
const SETTINGS_SCHEMA_VERSION = 1
const MODEL_ROUTING_TASK_KINDS = new Set<ModelRoutingTaskKind>([
  'chat',
  'coding',
  'reasoning',
  'vision',
  'toolUse',
  'longContext',
  'review',
  'summarization',
  'research',
  'planning',
  'testing',
  'documentation'
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
  researchProviderId: '',
  researchModel: '',
  planningProviderId: '',
  planningModel: '',
  codingProviderId: '',
  codingModel: '',
  testingProviderId: '',
  testingModel: '',
  documentationProviderId: '',
  documentationModel: '',
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
  sandboxMode: 'restrictedLocal',
  chinaEcosystemMirrorEnabled: false,
  chinaNpmRegistry: '',
  chinaPipIndexUrl: '',
  permissionAllowlist: '',
  permissionDenylist: '',
  permissionTemporaryAllowlist: '',
  guiAutomationEnabled: false,
  guiAutomationTemporaryGrantUntil: 0,
  notificationsEnabled: true,
  preventDisplaySleep: true,
  ideBridgeEnabled: false,
  ideBridgeHost: '127.0.0.1',
  ideBridgePort: 17365,
  ideBridgeToken: '',
  autoSkillLearningEnabled: false,
  office: { qualityMode: 'auto', showBadges: true, liveliness: 1, catEars: false },
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

function normalizeOfficeQualityMode(raw: unknown, fallback: OfficeQualityMode): OfficeQualityMode {
  return raw === 'auto' || raw === 'high' || raw === 'balanced' || raw === 'low' ? raw : fallback
}

function normalizeOffice(raw: unknown, fallback: AppSettings['office']): AppSettings['office'] {
  const office = raw && typeof raw === 'object' ? (raw as Partial<AppSettings['office']>) : {}
  return {
    qualityMode: normalizeOfficeQualityMode(office.qualityMode, fallback.qualityMode),
    showBadges: typeof office.showBadges === 'boolean' ? office.showBadges : fallback.showBadges,
    liveliness: clampNumber(office.liveliness, fallback.liveliness, 0.2, 1.2, 1),
    catEars: typeof office.catEars === 'boolean' ? office.catEars : fallback.catEars
  }
}

function normalizeSchedulerStrategy(raw: unknown, fallback: SchedulerStrategy): SchedulerStrategy {
  return raw === 'quality' || raw === 'cost' || raw === 'speed' || raw === 'balanced' ? raw : fallback
}

function normalizeSandboxMode(raw: unknown): AppSettings['sandboxMode'] {
  if (raw === 'disabled' || raw === 'strictDocker') return 'disabled'
  if (raw === 'loose') return 'loose'
  if (raw === 'restrictedLocal' || raw === 'standardSystem') return 'restrictedLocal'
  return DEFAULTS.sandboxMode
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
    const persisted = JSON.parse(readFileSync(settingsFile(), 'utf8')) as Partial<AppSettings> & {
      _schemaVersion?: unknown
      sandboxMode?: unknown
      sandboxDockerImage?: unknown
      chinaDockerRegistryMirror?: unknown
    }
    if (persisted._schemaVersion !== undefined && persisted._schemaVersion !== SETTINGS_SCHEMA_VERSION) {
      throw new UnsupportedSettingsSchemaError(persisted._schemaVersion)
    }
    const {
      _schemaVersion: _schemaVersion,
      sandboxMode,
      sandboxDockerImage: _legacyDockerImage,
      chinaDockerRegistryMirror: _legacyDockerRegistryMirror,
      ...raw
    } = persisted
    cache = {
      ...DEFAULTS,
      ...raw,
      driveMode: normalizeCaoGenDriveMode(raw.driveMode),
      sandboxMode: normalizeSandboxMode(sandboxMode),
      schedulerStrategy: normalizeSchedulerStrategy(raw.schedulerStrategy, DEFAULTS.schedulerStrategy),
      modelRoutingRules: normalizeModelRoutingRules(raw.modelRoutingRules),
      office: normalizeOffice(raw.office, DEFAULTS.office),
      layout: normalizeLayout(raw.layout)
    }
  } catch (error) {
    if (error instanceof UnsupportedSettingsSchemaError) throw error
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
    sandboxMode: patch.sandboxMode === undefined ? prev.sandboxMode : normalizeSandboxMode(patch.sandboxMode),
    schedulerStrategy:
      patch.schedulerStrategy === undefined
        ? prev.schedulerStrategy
        : normalizeSchedulerStrategy(patch.schedulerStrategy, prev.schedulerStrategy),
    modelRoutingRules:
      patch.modelRoutingRules === undefined ? prev.modelRoutingRules : normalizeModelRoutingRules(patch.modelRoutingRules),
    office: normalizeOffice(patch.office, prev.office),
    layout: normalizeLayout({ ...prev.layout, ...(patch.layout ?? {}) })
  }
  try {
    writeSettingsAtomic(settingsFile(), { _schemaVersion: SETTINGS_SCHEMA_VERSION, ...next })
  } catch (err) {
    console.error('[agent-desk] 保存设置失败:', err)
    throw err
  }
  cache = next
  return next
}

class UnsupportedSettingsSchemaError extends Error {
  constructor(version: unknown) {
    super(`Unsupported settings schema version: ${String(version)}`)
    this.name = 'UnsupportedSettingsSchemaError'
  }
}

function writeSettingsAtomic(file: string, value: Record<string, unknown>): void {
  const directory = dirname(file)
  const temporary = join(directory, `.settings.${process.pid}.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    mkdirSync(directory, { recursive: true })
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, file)
    syncSettingsDirectory(directory)
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch { /* best effort */ }
    }
    if (existsSync(temporary)) {
      try { unlinkSync(temporary) } catch { /* canonical settings remain authoritative */ }
    }
    throw error
  }
}

function syncSettingsDirectory(directory: string): void {
  if (process.platform === 'win32') return
  try {
    const descriptor = openSync(directory, 'r')
    try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
  } catch {
    // The file is fsynced; some filesystems reject directory fsync.
  }
}
