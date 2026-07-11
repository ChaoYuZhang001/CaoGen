import {
  AUTO_MODEL,
  caogenDrivePolicyView,
  type AppSettings,
  type CaoGenDrivePolicyView,
  type EngineInfo,
  type HistoryEntry,
  type McpProbeResult,
  type PluginRegistryItem,
  type PluginRegistryView,
  type ProviderHealthView,
  type ProviderView,
  type SessionMeta
} from '../../shared/types'
import { calculateBudgetReport, type BudgetReportSnapshot } from '../../shared/budget'

export type ControlCenterStatus = 'available' | 'needs-config' | 'external-required' | 'disabled' | 'unknown'

export interface ControlCenterProviderStatus {
  id: string
  name: string
  endpoint: string
  modelCount: number
  keyCount: number
  activeKeyLabel?: string
  budgetLabel: string
  hasToken: boolean
  tokenLabel: string
  healthLabel: string
  successRateLabel: string
  latencyLabel: string
  recentFailures: ProviderHealthView['recentFailures']
  status: ControlCenterStatus
  detail: string
  selected: boolean
}

export interface ControlCenterMcpStatus {
  total: number
  enabled: number
  probed: number
  ok: number
  failed: number
  status: ControlCenterStatus
  label: string
  items: Array<{
    id: string
    name: string
    enabled: boolean
    status: ControlCenterStatus
    label: string
  }>
}

export interface ControlCenterEngineStatus {
  kind: string
  label: string
  available: boolean
  optional: boolean
  configured: boolean
  status: ControlCenterStatus
  statusLabel: string
}

export interface ControlCenterCapability {
  title: string
  status: ControlCenterStatus
  detail: string
}

export interface ControlCenterModelRole {
  key: string
  label: string
  providerLabel: string
  modelLabel: string
  status: ControlCenterStatus
  detail: string
}

export interface ControlCenterView {
  policy: CaoGenDrivePolicyView
  route: {
    driveLabel: string
    routeLabel: string
    providerLabel: string
    providerStatus: ControlCenterStatus
    modelLabel: string
    strategyLabel: string
    crossValidationLabel: string
    failoverLabel: string
    customRulesLabel: string
  }
  budget: {
    driveSessionLabel: string
    sessionLabel: string
    monthlyLabel: string
    status: ControlCenterStatus
    report: BudgetReportSnapshot
  }
  providers: ControlCenterProviderStatus[]
  providerSummary: {
    total: number
    configuredKeys: number
    totalKeys: number
    healthy: number
    missingKeys: number
  }
  modelRoles: ControlCenterModelRole[]
  mcp: ControlCenterMcpStatus
  engines: ControlCenterEngineStatus[]
  capabilities: ControlCenterCapability[]
}

export interface BuildControlCenterViewInput {
  settings: AppSettings
  providers: ProviderView[]
  health: ProviderHealthView[]
  engines: EngineInfo[]
  pluginRegistry?: PluginRegistryView
  mcpProbeResults?: Record<string, McpProbeResult>
  history?: HistoryEntry[]
  activeSessions?: SessionMeta[]
  now?: number
}

export function buildControlCenterView(input: BuildControlCenterViewInput): ControlCenterView {
  const policy = caogenDrivePolicyView(input.settings.driveMode)
  const healthByProvider = new Map(input.health.map((item) => [item.providerId, item]))
  const selectedProviderId = input.settings.defaultProviderId
  const providerRows = input.providers.map((provider) =>
    buildProviderStatus(provider, healthByProvider.get(provider.id), selectedProviderId)
  )
  const selectedProvider = providerRows.find((provider) => provider.id === selectedProviderId)
  const selectedProviderMissing = Boolean(selectedProviderId) && !selectedProvider
  const allProviders = providerRows
  const providerStatus = selectedProviderMissing
    ? 'needs-config'
    : selectedProviderId
      ? (selectedProvider?.status ?? 'external-required')
      : 'needs-config'
  const defaultProviderName = selectedProviderMissing
    ? `${input.settings.defaultProviderId} (missing)`
    : (selectedProvider?.name ?? '未设置 Provider 偏好')
  const mcp = buildMcpStatus(input.pluginRegistry, input.mcpProbeResults ?? {})
  const engines = input.engines.map((engine) => {
    const optional = engine.optional === true
    const configured = engine.configured !== false
    return {
      ...engine,
      optional,
      configured,
      status: !engine.available
        ? 'external-required'
        : optional
          ? configured
            ? 'unknown'
            : 'needs-config'
          : 'available',
      statusLabel: !engine.available
        ? '运行时不可用'
        : optional
          ? configured
            ? '有凭据，兼容性未验证'
            : '未保存凭据，可选'
          : '可用'
    } satisfies ControlCenterEngineStatus
  })
  const budgetReport = calculateBudgetReport({
    settings: input.settings,
    providers: input.providers,
    history: input.history ?? [],
    activeSessions: input.activeSessions ?? [],
    now: input.now
  })
  const budgetExceeded = budgetReport.monthlyExceeded || budgetReport.activeSessions.some((session) => session.overBudget)

  return {
    policy,
    route: {
      driveLabel: `${policy.label} / ${policy.zhLabel}`,
      routeLabel: input.settings.smartModelRoutingEnabled ? 'Auto routing enabled' : 'Auto routing disabled',
      providerLabel: defaultProviderName,
      providerStatus,
      modelLabel: modelLabel(input.settings.defaultModel),
      strategyLabel: strategyLabel(input.settings.schedulerStrategy),
      crossValidationLabel: input.settings.modelCrossValidationAutoRunEnabled ? 'Auto review enabled' : 'Auto review disabled',
      failoverLabel: input.settings.failoverEnabled ? 'Failover enabled' : 'Failover disabled',
      customRulesLabel: customRulesLabel(input.settings.modelRoutingRules)
    },
    budget: {
      driveSessionLabel: moneyLabel(policy.sessionBudgetUsd),
      sessionLabel: input.settings.budgetUsdPerSession > 0 ? moneyLabel(input.settings.budgetUsdPerSession) : 'unlimited',
      monthlyLabel: input.settings.budgetUsdPerMonth > 0 ? moneyLabel(input.settings.budgetUsdPerMonth) : 'unlimited',
      status: budgetExceeded
        ? 'needs-config'
        : input.settings.budgetUsdPerSession > 0 || input.settings.budgetUsdPerMonth > 0
          ? 'available'
          : 'unknown',
      report: budgetReport
    },
    providers: allProviders,
    providerSummary: {
      total: input.providers.length,
      configuredKeys: input.providers.filter((provider) => provider.hasToken).length,
      totalKeys: input.providers.reduce((sum, provider) => sum + providerKeyCount(provider), 0),
      healthy: providerRows.filter((provider) => provider.status === 'available').length,
      missingKeys: input.providers.filter((provider) => !provider.hasToken).length
    },
    modelRoles: buildModelRoles(input.settings, input.providers),
    mcp,
    engines,
    capabilities: buildCapabilities({
      settings: input.settings,
      providerStatus,
      selectedProviderMissing,
      selectedProviderName: defaultProviderName,
      mcp,
      engines
    })
  }
}

function customRulesLabel(rules: AppSettings['modelRoutingRules'] | undefined): string {
  const normalized = rules ?? []
  const total = normalized.length
  const enabled = normalized.filter((rule) =>
    rule.enabled && Boolean(
      rule.match.trim() ||
      rule.taskKinds?.length ||
      rule.minRiskLevel ||
      rule.whenStrategy
    )
  ).length
  if (total === 0) return 'Custom rules disabled'
  return `${enabled}/${total} custom rules enabled`
}

function buildModelRoles(settings: AppSettings, providers: ProviderView[]): ControlCenterModelRole[] {
  return [
    buildModelRole('lowCost', '低成本', settings.lowCostProviderId, settings.lowCostModel, providers),
    buildModelRole('strongReasoning', '强推理', settings.strongReasoningProviderId, settings.strongReasoningModel, providers),
    buildModelRole('review', '审查', settings.reviewProviderId, settings.reviewModel, providers),
    buildModelRole('fallback', '备用', settings.fallbackProviderId, settings.fallbackModel, providers)
  ]
}

function buildModelRole(
  key: string,
  label: string,
  providerId: string,
  model: string,
  providers: ProviderView[]
): ControlCenterModelRole {
  const provider = providerId ? providers.find((item) => item.id === providerId) : undefined
  const hasProvider = Boolean(providerId)
  const hasModel = Boolean(model)
  const status: ControlCenterStatus = !hasProvider && !hasModel
    ? 'disabled'
    : hasProvider && !provider
      ? 'needs-config'
      : provider && !provider.hasToken
        ? 'external-required'
        : provider && hasModel && provider.models.length > 0 && !provider.models.includes(model)
          ? 'needs-config'
          : 'available'
  const providerLabel = hasProvider ? (provider?.name ?? `${providerId} (missing)`) : '不指定 Provider'
  const modelLabel = hasModel ? model : '不指定模型'
  const detail = !hasProvider && !hasModel
    ? '交给自动调度'
    : status === 'needs-config'
      ? '配置与 Provider/模型列表不匹配'
      : status === 'external-required'
        ? 'Provider 需要 API Key'
        : '将作为自动调度角色偏好'
  return { key, label, providerLabel, modelLabel, status, detail }
}

function buildProviderStatus(
  provider: ProviderView,
  health: ProviderHealthView | undefined,
  selectedProviderId: string
): ControlCenterProviderStatus {
  const totalCalls = (health?.successes ?? 0) + (health?.failures ?? 0)
  const successRate = totalCalls > 0 ? Math.round(((health?.successes ?? 0) / totalCalls) * 100) : undefined
  const latency = health?.latencyEmaMs ?? health?.lastLatencyMs
  const latestFailure = health?.recentFailures?.[0]
  const healthLabel = health
    ? health.healthy
      ? `healthy · ${successRate ?? '-'}%${latency ? ` · ${Math.round(latency)}ms EMA` : ''}`
      : `failing · ${health.consecutiveFailures} consecutive${latestFailure ? ` · ${latestFailure.label}` : ''}`
    : 'not probed'
  const missingModels = provider.models.length === 0
  const status: ControlCenterStatus = !provider.hasToken
    ? 'external-required'
    : health && !health.healthy
      ? 'needs-config'
      : missingModels
        ? 'needs-config'
        : 'available'
  const detail = !provider.hasToken
    ? 'API key required outside this view'
    : health && !health.healthy
      ? latestFailure?.message ?? health.lastError ?? 'provider health check is failing'
      : missingModels
        ? 'model list is empty'
        : provider.openaiProtocol === 'chat'
          ? 'OpenAI chat protocol'
          : 'ready for routing'

  return {
    id: provider.id,
    name: provider.name,
    endpoint: provider.baseUrl || 'local login endpoint',
    modelCount: provider.models.length,
    keyCount: providerKeyCount(provider),
    activeKeyLabel: provider.activeKeyLabel,
    budgetLabel: provider.budgetUsd > 0 ? moneyLabel(provider.budgetUsd) : 'inherits global budget',
    hasToken: provider.hasToken,
    tokenLabel: provider.hasToken
      ? `${providerKeyCount(provider)} key${providerKeyCount(provider) === 1 ? '' : 's'}${provider.activeKeyLabel ? ` · ${provider.activeKeyLabel}` : ''}`
      : 'missing',
    healthLabel,
    successRateLabel: successRate === undefined ? 'no samples' : `${successRate}% success`,
    latencyLabel: latency ? `${Math.round(latency)}ms EMA` : 'no latency sample',
    recentFailures: health?.recentFailures ?? [],
    status,
    detail,
    selected: provider.id === selectedProviderId
  }
}

function providerKeyCount(provider: ProviderView): number {
  return provider.keyCount ?? (provider.hasToken ? 1 : 0)
}

function buildMcpStatus(
  pluginRegistry: PluginRegistryView | undefined,
  mcpProbeResults: Record<string, McpProbeResult>
): ControlCenterMcpStatus {
  if (!pluginRegistry) {
    return {
      total: 0,
      enabled: 0,
      probed: 0,
      ok: 0,
      failed: 0,
      status: 'unknown',
      label: 'not scanned',
      items: []
    }
  }
  const mcpItems = pluginRegistry.items.filter((item) => item.kind === 'mcp')
  const enabledItems = mcpItems.filter((item) => item.enabled)
  const probed = enabledItems.filter((item) => mcpProbeResults[item.id])
  const ok = probed.filter((item) => mcpProbeResults[item.id]?.ok)
  const failed = probed.filter((item) => mcpProbeResults[item.id] && !mcpProbeResults[item.id].ok)
  const status: ControlCenterStatus =
    mcpItems.length === 0
      ? 'needs-config'
      : enabledItems.length === 0
        ? 'disabled'
        : probed.length === 0
          ? 'unknown'
          : failed.length > 0
            ? 'needs-config'
            : 'available'

  return {
    total: mcpItems.length,
    enabled: enabledItems.length,
    probed: probed.length,
    ok: ok.length,
    failed: failed.length,
    status,
    label:
      mcpItems.length === 0
        ? 'no MCP declarations'
        : probed.length === 0
          ? `${enabledItems.length}/${mcpItems.length} enabled · not probed`
          : `${ok.length}/${probed.length} reachable`,
    items: mcpItems.slice(0, 8).map((item) => buildMcpItemStatus(item, mcpProbeResults[item.id]))
  }
}

function buildMcpItemStatus(item: PluginRegistryItem, probe: McpProbeResult | undefined): ControlCenterMcpStatus['items'][number] {
  if (!item.enabled) {
    return { id: item.id, name: item.name, enabled: false, status: 'disabled', label: 'disabled' }
  }
  if (!probe) {
    return { id: item.id, name: item.name, enabled: true, status: 'unknown', label: 'not probed' }
  }
  return {
    id: item.id,
    name: item.name,
    enabled: true,
    status: probe.ok ? 'available' : 'needs-config',
    label: probe.ok ? `${probe.transport} · ${probe.latencyMs ?? '?'}ms` : probe.error ?? 'probe failed'
  }
}

function buildCapabilities(input: {
  settings: AppSettings
  providerStatus: ControlCenterStatus
  selectedProviderMissing: boolean
  selectedProviderName: string
  mcp: ControlCenterMcpStatus
  engines: ControlCenterEngineStatus[]
}): ControlCenterCapability[] {
  const availableEngines = input.engines.filter((engine) => engine.status === 'available')
  return [
    {
      title: 'Drive policy',
      status: 'available',
      detail: `${caogenDrivePolicyView(input.settings.driveMode).summary} · validation=${caogenDrivePolicyView(input.settings.driveMode).validationDepth}`
    },
    {
      title: 'Model routing',
      status: input.settings.smartModelRoutingEnabled ? input.providerStatus : 'disabled',
      detail: input.settings.smartModelRoutingEnabled
        ? `${input.selectedProviderName} · ${strategyLabel(input.settings.schedulerStrategy)}`
        : 'auto routing is off; fixed/default model path is active'
    },
    {
      title: 'Provider credential',
      status: input.selectedProviderMissing ? 'needs-config' : input.providerStatus,
      detail: input.selectedProviderMissing ? 'default provider id is not in the provider list' : `${input.selectedProviderName} credential state`
    },
    {
      title: 'MCP tools',
      status: input.mcp.status,
      detail: input.mcp.label
    },
    {
      title: 'Agent engines',
      status: availableEngines.length > 0 ? 'available' : 'external-required',
      detail: availableEngines.length > 0 ? availableEngines.map((engine) => engine.label).join(', ') : 'no configured Agent engine is currently available'
    }
  ]
}

function modelLabel(model: string): string {
  if (model === AUTO_MODEL) return 'auto route'
  if (!model) return 'no model preference'
  return model
}

function strategyLabel(strategy: AppSettings['schedulerStrategy']): string {
  if (strategy === 'quality') return 'quality'
  if (strategy === 'cost') return 'cost'
  if (strategy === 'speed') return 'speed'
  return 'balanced'
}

function moneyLabel(value: number): string {
  return `$${value.toFixed(value >= 1 ? 2 : 3)}`
}
