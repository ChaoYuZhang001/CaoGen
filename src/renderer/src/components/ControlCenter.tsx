import {
  DRIVE_MODE_OPTIONS,
  MODEL_OPTIONS,
  STRATEGY_OPTIONS
} from '../store'
import { buildControlCenterView, type ControlCenterStatus } from '../controlCenter'
import { formatCost } from '../format'
import type {
  AppSettings,
  CaoGenDriveMode,
  EngineInfo,
  HistoryEntry,
  McpProbeResult,
  PluginRegistryItem,
  PluginRegistryView,
  ProviderHealthView,
  ProviderView,
  SchedulerStrategy,
  SessionMeta
} from '../../../shared/types'

interface Props {
  settings: AppSettings
  providers: ProviderView[]
  history: HistoryEntry[]
  activeSessions: SessionMeta[]
  health: ProviderHealthView[]
  engines: EngineInfo[]
  pluginRegistry?: PluginRegistryView
  mcpProbeResults: Record<string, McpProbeResult>
  loading: boolean
  mcpProbing: boolean
  error: string
  onRefresh: () => void
  onProbeMcp: (items: PluginRegistryItem[]) => void
  onSettingsPatch: (patch: Partial<AppSettings>) => void
  onAddProvider: () => void
  onEditProvider: (provider: ProviderView) => void
}

function healthTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export default function ControlCenter({
  settings,
  providers,
  history,
  activeSessions,
  health,
  engines,
  pluginRegistry,
  mcpProbeResults,
  loading,
  mcpProbing,
  error,
  onRefresh,
  onProbeMcp,
  onSettingsPatch,
  onAddProvider,
  onEditProvider
}: Props): React.JSX.Element {
  const view = buildControlCenterView({
    settings,
    providers,
    history,
    activeSessions,
    health,
    engines,
    pluginRegistry,
    mcpProbeResults
  })
  const mcpItems = pluginRegistry?.items.filter((item) => item.kind === 'mcp') ?? []
  const budgetExceeded = view.budget.report.monthlyExceeded || view.budget.report.activeSessions.some((session) => session.overBudget)

  const setBudget = (key: 'budgetUsdPerSession' | 'budgetUsdPerMonth', value: string): void => {
    const budget = Number(value)
    onSettingsPatch({ [key]: Number.isFinite(budget) && budget > 0 ? budget : 0 })
  }

  return (
    <div className="control-center">
      <div className="control-center-head">
        <div>
          <h3 className="settings-h3">Control Center</h3>
          <p className="settings-hint">Drive / Provider / Model / Budget / MCP / CLI</p>
        </div>
        <div className="control-center-actions">
          <button className="btn btn-ghost btn-sm" disabled={loading} onClick={onRefresh}>
            {loading ? '刷新中...' : '刷新'}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            disabled={mcpProbing || mcpItems.length === 0}
            onClick={() => onProbeMcp(mcpItems)}
          >
            {mcpProbing ? '探测中...' : '探测 MCP'}
          </button>
        </div>
      </div>

      {error && <div className="notice notice-error">{error}</div>}

      <div className="control-summary-grid">
        <SummaryCard title="Drive" status="available" value={view.route.driveLabel} detail={view.policy.summary} />
        <SummaryCard
          title="Routing"
          status={settings.smartModelRoutingEnabled ? view.route.providerStatus : 'disabled'}
          value={view.route.routeLabel}
          detail={`${view.route.providerLabel} · ${view.route.modelLabel} · ${view.route.strategyLabel}`}
        />
        <SummaryCard
          title="Budget"
          status={view.budget.status}
          value={`${formatCost(view.budget.report.monthlySpentUsd)} / ${view.budget.report.monthlyLimitUsd > 0 ? formatCost(view.budget.report.monthlyLimitUsd) : '∞'}`}
          detail={`${view.budget.report.monthKey} · ${view.budget.report.monthlyRemainingUsd === undefined ? 'unlimited' : `${formatCost(view.budget.report.monthlyRemainingUsd)} remaining`}`}
        />
        <SummaryCard
          title="Tools"
          status={view.mcp.status}
          value={view.mcp.label}
          detail={`${view.engines.filter((engine) => engine.available).length}/${view.engines.length} CLI engines available`}
        />
      </div>

      <section className="control-section">
        <div className="settings-section-head">
          <h3 className="settings-h3">Drive 与路由</h3>
          <StatusPill status={settings.smartModelRoutingEnabled ? 'available' : 'disabled'} label={view.route.routeLabel} />
        </div>
        <div className="control-form-grid">
          <label className="field-label">
            CaoGen Drive
            <select
              className="select select-block"
              value={settings.driveMode}
              onChange={(event) => onSettingsPatch({ driveMode: event.target.value as CaoGenDriveMode })}
            >
              {DRIVE_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            Provider 偏好
            <select
              className="select select-block"
              value={settings.defaultProviderId}
              onChange={(event) => onSettingsPatch({ defaultProviderId: event.target.value })}
            >
              <option value="">不设置 Provider 偏好</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            模型偏好
            <select
              className="select select-block"
              value={settings.defaultModel}
              onChange={(event) => onSettingsPatch({ defaultModel: event.target.value })}
            >
              <option value="">不设置模型偏好</option>
              {MODEL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            调度策略
            <select
              className="select select-block"
              value={settings.schedulerStrategy}
              onChange={(event) => onSettingsPatch({ schedulerStrategy: event.target.value as SchedulerStrategy })}
            >
              {STRATEGY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="control-switch-row">
          <label className="settings-check">
            <input
              type="checkbox"
              checked={settings.smartModelRoutingEnabled}
              onChange={(event) => onSettingsPatch({ smartModelRoutingEnabled: event.target.checked })}
            />
            智能路由
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={settings.modelCrossValidationAutoRunEnabled}
              disabled={!settings.smartModelRoutingEnabled}
              onChange={(event) => onSettingsPatch({ modelCrossValidationAutoRunEnabled: event.target.checked })}
            />
            自动复核
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={settings.failoverEnabled}
              onChange={(event) => onSettingsPatch({ failoverEnabled: event.target.checked })}
            />
            故障切换
          </label>
        </div>
        <div className="control-route-note">
          <span>{view.policy.toolPolicySummary}</span>
          <span>validation={view.policy.validationDepth}</span>
          <span>{view.route.crossValidationLabel}</span>
          <span>{view.route.customRulesLabel}</span>
        </div>
        <div className="control-mini-list control-role-list">
          {view.modelRoles.map((role) => (
            <div key={role.key} className="control-mini-row">
              <span>
                {role.label}: {role.providerLabel} / {role.modelLabel}
              </span>
              <StatusPill status={role.status} label={statusLabel(role.status)} />
            </div>
          ))}
        </div>
      </section>

      <section className="control-section">
        <div className="settings-section-head">
          <h3 className="settings-h3">预算</h3>
          <StatusPill
            status={view.budget.status}
            label={budgetExceeded ? 'over budget' : view.budget.status === 'unknown' ? 'unlimited' : 'configured'}
          />
        </div>
        <div className="control-form-grid">
          <label className="field-label">
            单会话预算上限 ($)
            <input
              className="input input-block"
              type="number"
              min="0"
              step="0.01"
              value={settings.budgetUsdPerSession || ''}
              placeholder="0 = 不限制"
              onChange={(event) => setBudget('budgetUsdPerSession', event.target.value)}
            />
          </label>
          <label className="field-label">
            月度预算上限 ($)
            <input
              className="input input-block"
              type="number"
              min="0"
              step="0.01"
              value={settings.budgetUsdPerMonth || ''}
              placeholder="0 = 不限制"
              onChange={(event) => setBudget('budgetUsdPerMonth', event.target.value)}
            />
          </label>
        </div>
        <div className="control-budget-stats">
          <span>本月已用 {formatCost(view.budget.report.monthlySpentUsd)}</span>
          <span>
            剩余{' '}
            {view.budget.report.monthlyRemainingUsd === undefined
              ? '不限制'
              : formatCost(view.budget.report.monthlyRemainingUsd)}
          </span>
          <span>活跃会话 {formatCost(view.budget.report.activeCostUsd)}</span>
          <span>历史会话 {formatCost(view.budget.report.historicalCostUsd)}</span>
        </div>
        {view.budget.report.monthlyRatio !== undefined && (
          <div
            className={`control-budget-progress ${view.budget.report.monthlyExceeded ? 'is-over' : ''}`}
            title={`${Math.round(view.budget.report.monthlyRatio * 100)}%`}
          >
            <span style={{ width: `${Math.max(2, view.budget.report.monthlyRatio * 100)}%` }} />
          </div>
        )}
        <div className="control-budget-report-grid">
          <div>
            <div className="control-subhead">Provider 本月成本</div>
            <div className="control-budget-list">
              {view.budget.report.providers.map((provider) => (
                <div key={provider.providerId} className="control-budget-row">
                  <span>
                    <strong>{provider.providerName}</strong>
                    <small>
                      {provider.sessionCount} sessions · {provider.activeSessions} active
                      {provider.currentSessionLimitUsd
                        ? ` · ${formatCost(provider.currentSessionLimitUsd)}/session cap`
                        : ''}
                    </small>
                  </span>
                  <strong>{formatCost(provider.spentUsd)}</strong>
                </div>
              ))}
              {view.budget.report.providers.length === 0 && <div className="provider-empty">本月暂无成本记录</div>}
            </div>
          </div>
          <div>
            <div className="control-subhead">最高成本会话</div>
            <div className="control-budget-list">
              {view.budget.report.topSessions.map((session) => (
                <div key={`${session.active ? 'active' : 'history'}:${session.id}`} className="control-budget-row">
                  <span>
                    <strong>{session.title}</strong>
                    <small>
                      {session.providerName} / {session.model}
                      {session.active ? ' · active' : ' · history'}
                      {session.sessionLimitUsd ? ` · ${formatCost(session.sessionLimitUsd)} cap` : ''}
                    </small>
                  </span>
                  <strong className={session.overBudget ? 'control-budget-over' : ''}>{formatCost(session.costUsd)}</strong>
                </div>
              ))}
              {view.budget.report.topSessions.length === 0 && <div className="provider-empty">本月暂无会话成本</div>}
            </div>
          </div>
        </div>
      </section>

      <section className="control-section">
        <div className="settings-section-head">
          <h3 className="settings-h3">Provider 与 Key</h3>
          <button className="btn btn-ghost btn-sm" onClick={onAddProvider}>
            添加 Provider
          </button>
        </div>
        <div className="control-provider-stats">
          <span>{view.providerSummary.totalKeys} keys / {view.providerSummary.configuredKeys} providers</span>
          <span>{view.providerSummary.healthy}/{view.providerSummary.total} healthy</span>
          <span>{view.providerSummary.missingKeys} missing key</span>
        </div>
        <div className="provider-list">
          {view.providers.map((provider) => {
            const rawProvider = providers.find((item) => item.id === provider.id)
            return (
              <div key={provider.id} className={`provider-row control-provider-row ${provider.selected ? 'control-row-selected' : ''}`}>
                <div className="provider-row-body">
                  <div className="provider-row-name">
                    {provider.name}
                    {provider.selected && <StatusPill status="available" label="default" />}
                    <StatusPill status={provider.status} label={provider.tokenLabel} />
                  </div>
                  <div className="provider-row-sub">
                    {provider.endpoint} · {provider.modelCount} models · {provider.healthLabel}
                  </div>
                  <div className="control-provider-health-meta">
                    <span>{provider.successRateLabel}</span>
                    <span>{provider.latencyLabel}</span>
                  </div>
                  <div className="control-row-detail">{provider.detail}</div>
                  {provider.recentFailures.length > 0 && (
                    <details className="control-provider-failures">
                      <summary>最近失败 {provider.recentFailures.length}</summary>
                      <div className="control-provider-failure-list">
                        {provider.recentFailures.map((failure, index) => (
                          <div key={`${failure.at}:${failure.label}:${index}`} className="control-provider-failure-row">
                            <span>{healthTime(failure.at)}</span>
                            <strong>{failure.label}</strong>
                            <span>{failure.switchable ? '可自动切换' : '需原地处理'}</span>
                            <code>{failure.message}</code>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
                <div className="provider-row-actions">
                  {rawProvider && (
                    <button className="btn btn-ghost btn-sm" onClick={() => onEditProvider(rawProvider)}>
                      编辑
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className="control-section">
        <div className="settings-section-head">
          <h3 className="settings-h3">MCP / CLI 工具</h3>
          <StatusPill status={view.mcp.status} label={view.mcp.label} />
        </div>
        <div className="control-tool-grid">
          <div>
            <div className="control-subhead">MCP</div>
            {view.mcp.items.length === 0 ? (
              <div className="provider-empty">未发现 MCP 声明</div>
            ) : (
              <div className="control-mini-list">
                {view.mcp.items.map((item) => (
                  <div key={item.id} className="control-mini-row">
                    <span>{item.name}</span>
                    <StatusPill status={item.status} label={item.label} />
                  </div>
                ))}
              </div>
            )}
          </div>
          <div>
            <div className="control-subhead">CLI</div>
            <div className="control-mini-list">
              {view.engines.map((engine) => (
                <div key={engine.kind} className="control-mini-row">
                  <span>{engine.label}</span>
                  <StatusPill status={engine.status} label={engine.available ? 'available' : 'external credential'} />
                </div>
              ))}
              {view.engines.length === 0 && <div className="provider-empty">未注册本地引擎</div>}
            </div>
          </div>
        </div>
      </section>

      <section className="control-section">
        <h3 className="settings-h3">边界</h3>
        <div className="control-capability-list">
          {view.capabilities.map((capability) => (
            <div key={capability.title} className="control-capability-row">
              <div>
                <div className="control-capability-title">{capability.title}</div>
                <div className="control-row-detail">{capability.detail}</div>
              </div>
              <StatusPill status={capability.status} label={statusLabel(capability.status)} />
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function SummaryCard({
  title,
  value,
  detail,
  status
}: {
  title: string
  value: string
  detail: string
  status: ControlCenterStatus
}): React.JSX.Element {
  return (
    <div className="control-summary-card">
      <div className="control-summary-top">
        <span>{title}</span>
        <StatusPill status={status} label={statusLabel(status)} />
      </div>
      <div className="control-summary-value">{value}</div>
      <div className="control-summary-detail">{detail}</div>
    </div>
  )
}

function StatusPill({ status, label }: { status: ControlCenterStatus; label: string }): React.JSX.Element {
  return <span className={`control-pill control-pill-${status}`}>{label}</span>
}

function statusLabel(status: ControlCenterStatus): string {
  if (status === 'available') return 'available'
  if (status === 'needs-config') return 'needs config'
  if (status === 'external-required') return 'external credential'
  if (status === 'disabled') return 'disabled'
  return 'unknown'
}
