import {
  AUTO_MODEL,
  caogenDrivePolicyView,
  type AppSettings,
  type CaoGenDrivePolicyView,
  type EngineInfo,
  type McpProbeResult,
  type PluginRegistryItem,
  type PluginRegistryView,
  type ProviderHealthView,
  type ProviderView
} from '../../shared/types'

export type ControlCenterStatus = 'available' | 'needs-config' | 'external-required' | 'disabled' | 'unknown'

export interface ControlCenterProviderStatus {
  id: string
  name: string
  endpoint: string
  modelCount: number
  budgetLabel: string
  hasToken: boolean
  tokenLabel: string
  healthLabel: string
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
  status: ControlCenterStatus
}

export interface ControlCenterCapability {
  title: string
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
  }
  budget: {
    driveSessionLabel: string
    sessionLabel: string
    monthlyLabel: string
    status: ControlCenterStatus
  }
  providers: ControlCenterProviderStatus[]
  providerSummary: {
    total: number
    configuredKeys: number
    healthy: number
    missingKeys: number
  }
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
}

export function buildControlCenterView(input: BuildControlCenterViewInput): ControlCenterView {
  const policy = caogenDrivePolicyView(input.settings.driveMode)
  const healthByProvider = new Map(input.health.map((item) => [item.providerId || 'official', item]))
  const selectedProviderId = input.settings.defaultProviderId || 'official'
  const providerRows = input.providers.map((provider) =>
    buildProviderStatus(provider, healthByProvider.get(provider.id), selectedProviderId)
  )
  const selectedProvider = providerRows.find((provider) => provider.id === selectedProviderId)
  const selectedProviderMissing = selectedProviderId !== 'official' && !selectedProvider
  const officialProviderStatus = buildOfficialProviderStatus(healthByProvider.get('official'), selectedProviderId)
  const allProviders = [officialProviderStatus, ...providerRows]
  const providerStatus = selectedProviderMissing
    ? 'needs-config'
    : (allProviders.find((provider) => provider.id === selectedProviderId)?.status ?? 'external-required')
  const defaultProviderName = selectedProviderMissing
    ? `${input.settings.defaultProviderId} (missing)`
    : (allProviders.find((provider) => provider.id === selectedProviderId)?.name ?? 'Official Anthropic')
  const mcp = buildMcpStatus(input.pluginRegistry, input.mcpProbeResults ?? {})
  const engines = input.engines.map((engine) => ({
    ...engine,
    status: engine.available ? 'available' : 'external-required'
  }) satisfies ControlCenterEngineStatus)

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
      failoverLabel: input.settings.failoverEnabled ? 'Failover enabled' : 'Failover disabled'
    },
    budget: {
      driveSessionLabel: moneyLabel(policy.sessionBudgetUsd),
      sessionLabel: input.settings.budgetUsdPerSession > 0 ? moneyLabel(input.settings.budgetUsdPerSession) : 'unlimited',
      monthlyLabel: input.settings.budgetUsdPerMonth > 0 ? moneyLabel(input.settings.budgetUsdPerMonth) : 'unlimited',
      status: input.settings.budgetUsdPerSession > 0 || input.settings.budgetUsdPerMonth > 0 ? 'available' : 'unknown'
    },
    providers: allProviders,
    providerSummary: {
      total: input.providers.length,
      configuredKeys: input.providers.filter((provider) => provider.hasToken).length,
      healthy: providerRows.filter((provider) => provider.status === 'available').length,
      missingKeys: input.providers.filter((provider) => !provider.hasToken).length
    },
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

function buildProviderStatus(
  provider: ProviderView,
  health: ProviderHealthView | undefined,
  selectedProviderId: string
): ControlCenterProviderStatus {
  const healthLabel = health
    ? health.healthy
      ? `healthy · ${health.successes}/${health.failures}`
      : `failing · ${health.consecutiveFailures} consecutive`
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
      ? health.lastError ?? 'provider health check is failing'
      : missingModels
        ? 'model list is empty'
        : provider.openaiProtocol === 'chat'
          ? 'OpenAI chat protocol'
          : 'ready for routing'

  return {
    id: provider.id,
    name: provider.name,
    endpoint: provider.baseUrl || 'official endpoint',
    modelCount: provider.models.length,
    budgetLabel: provider.budgetUsd > 0 ? moneyLabel(provider.budgetUsd) : 'inherits global budget',
    hasToken: provider.hasToken,
    tokenLabel: provider.hasToken ? 'hasToken' : 'missing',
    healthLabel,
    status,
    detail,
    selected: provider.id === selectedProviderId
  }
}

function buildOfficialProviderStatus(
  health: ProviderHealthView | undefined,
  selectedProviderId: string
): ControlCenterProviderStatus {
  return {
    id: 'official',
    name: 'Official Anthropic',
    endpoint: 'default Claude / Anthropic login',
    modelCount: 3,
    budgetLabel: 'inherits global budget',
    hasToken: false,
    tokenLabel: 'external credential',
    healthLabel: health ? (health.healthy ? 'healthy' : `failing · ${health.consecutiveFailures} consecutive`) : 'not probed',
    status: health && !health.healthy ? 'needs-config' : 'external-required',
    detail: 'uses external CLI/login/env credential; secret is not readable here',
    selected: selectedProviderId === 'official'
  }
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
  const availableEngines = input.engines.filter((engine) => engine.available)
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
      title: 'CLI engines',
      status: availableEngines.length > 0 ? 'available' : 'external-required',
      detail: availableEngines.length > 0 ? availableEngines.map((engine) => engine.label).join(', ') : 'no local engine is currently available'
    }
  ]
}

function modelLabel(model: string): string {
  if (model === AUTO_MODEL) return 'auto route'
  if (!model) return 'engine default'
  return model
}

function strategyLabel(strategy: AppSettings['schedulerStrategy']): string {
  if (strategy === 'quality') return 'quality'
  if (strategy === 'cost') return 'cost'
  return 'balanced'
}

function moneyLabel(value: number): string {
  return `$${value.toFixed(value >= 1 ? 2 : 3)}`
}
