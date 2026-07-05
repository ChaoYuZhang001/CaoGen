import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'

export type PluginRegistryKind = 'plugin' | 'skill' | 'agent' | 'mcp'
export type PluginRegistrySourceKind = 'project' | 'user' | 'codex' | 'other'
export type PluginRegistryEnabledSource = 'manifest' | 'user'

export interface PluginRegistryPanelItem {
  id: string
  name: string
  kind: PluginRegistryKind
  sourceKind?: PluginRegistrySourceKind
  sourceRoot: string
  path: string
  enabled: boolean
  enabledSource?: PluginRegistryEnabledSource
  enabledUpdatedAt?: string
  summary?: string
}

export interface PluginRegistryPanelDiagnostic {
  code: string
  message: string
  path: string
}

export interface PluginRegistryPanelLabels {
  title?: string
  subtitle?: string
  loading?: string
  refresh?: string
  close?: string
  searchPlaceholder?: string
  allKinds?: string
  plugins?: string
  skills?: string
  agents?: string
  mcp?: string
  allStatuses?: string
  allSources?: string
  projectSource?: string
  userSource?: string
  codexSource?: string
  otherSource?: string
  enabled?: string
  disabled?: string
  total?: string
  active?: string
  inactive?: string
  roots?: string
  diagnostics?: string
  truncated?: string
  yes?: string
  no?: string
  scanTime?: string
  selected?: string
  noSelection?: string
  empty?: string
  open?: string
  reveal?: string
  useWithAgent?: string
  dispatchAgent?: string
  enable?: string
  disable?: string
  status?: string
  stateSource?: string
  updatedAt?: string
  source?: string
  sourceRoot?: string
  path?: string
  summary?: string
}

export interface PluginRegistryPanelProps {
  items: PluginRegistryPanelItem[]
  roots?: string[]
  diagnostics?: PluginRegistryPanelDiagnostic[]
  scannedAt?: string
  truncated?: boolean
  loading?: boolean
  error?: string
  message?: string
  selectedItemId?: string
  className?: string
  labels?: PluginRegistryPanelLabels
  onRefresh?: () => void | Promise<void>
  onClose?: () => void
  onSelectItem?: (item: PluginRegistryPanelItem) => void
  onOpenItem?: (item: PluginRegistryPanelItem) => void
  onRevealItem?: (item: PluginRegistryPanelItem) => void
  onUseItem?: (item: PluginRegistryPanelItem) => void | Promise<void>
  onDispatchAgent?: (item: PluginRegistryPanelItem) => void | Promise<void>
  onToggleItem?: (item: PluginRegistryPanelItem, enabled: boolean) => void | Promise<void>
  /** MCP 运行态:探测可见 mcp 条目的真实连接状态 */
  onProbeMcp?: (items: PluginRegistryPanelItem[]) => void | Promise<void>
  /** MCP 探测结果(id → 状态);进行中用 mcpProbing */
  mcpProbeResults?: Record<string, McpProbeStatus>
  mcpProbing?: boolean
}

/** 面板展示用的 MCP 探测状态(shared McpProbeResult 的展示投影) */
export interface McpProbeStatus {
  ok: boolean
  serverName?: string
  serverVersion?: string
  latencyMs?: number
  error?: string
}

type KindFilter = PluginRegistryKind | 'all'
type StatusFilter = 'all' | 'enabled' | 'disabled'
type SourceFilter = PluginRegistrySourceKind | 'all'

const KIND_ORDER: PluginRegistryKind[] = ['plugin', 'skill', 'agent', 'mcp']
const SOURCE_ORDER: PluginRegistrySourceKind[] = ['codex', 'project', 'user', 'other']

const DEFAULT_LABELS: Required<PluginRegistryPanelLabels> = {
  title: '插件生态',
  subtitle: 'Skills / Agents / MCP',
  loading: '扫描中',
  refresh: '刷新',
  close: '关闭',
  searchPlaceholder: '搜索名称、摘要或路径',
  allKinds: '全部',
  plugins: 'Plugins',
  skills: 'Skills',
  agents: 'Agents',
  mcp: 'MCP',
  allStatuses: '全部状态',
  allSources: '全部来源',
  projectSource: 'Project',
  userSource: 'User',
  codexSource: 'Codex',
  otherSource: 'Other',
  enabled: '已启用',
  disabled: '已停用',
  total: '总数',
  active: '可用',
  inactive: '停用',
  roots: '来源',
  diagnostics: '诊断',
  truncated: '已截断',
  yes: '是',
  no: '否',
  scanTime: '扫描时间',
  selected: '当前插件',
  noSelection: '选择一个插件查看状态',
  empty: '没有匹配的插件',
  open: '打开',
  reveal: '定位',
  useWithAgent: '用于 Agent',
  dispatchAgent: '派发子 Agent',
  enable: '启用',
  disable: '停用',
  status: '状态',
  stateSource: '状态来源',
  updatedAt: '更新时间',
  source: '来源',
  sourceRoot: '来源根目录',
  path: '路径',
  summary: '摘要'
}

function cx(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

function mergeLabels(labels: PluginRegistryPanelLabels | undefined): Required<PluginRegistryPanelLabels> {
  return { ...DEFAULT_LABELS, ...labels }
}

function kindLabel(kind: KindFilter, labels: Required<PluginRegistryPanelLabels>): string {
  if (kind === 'plugin') return labels.plugins
  if (kind === 'skill') return labels.skills
  if (kind === 'agent') return labels.agents
  if (kind === 'mcp') return labels.mcp
  return labels.allKinds
}

function itemKindLabel(kind: PluginRegistryKind, labels: Required<PluginRegistryPanelLabels>): string {
  return kindLabel(kind, labels)
}

function sourceLabel(source: SourceFilter | undefined, labels: Required<PluginRegistryPanelLabels>): string {
  if (source === 'codex') return labels.codexSource
  if (source === 'project') return labels.projectSource
  if (source === 'user') return labels.userSource
  if (source === 'other') return labels.otherSource
  return labels.allSources
}

function normalizeSearch(value: string): string {
  return value.trim().toLowerCase()
}

function itemMatchesQuery(item: PluginRegistryPanelItem, query: string): boolean {
  if (!query) return true
  return [item.name, item.summary, item.sourceRoot, item.path, item.kind, item.sourceKind, item.enabledSource]
    .join('\n')
    .toLowerCase()
    .includes(query)
}

function itemMatchesStatus(item: PluginRegistryPanelItem, status: StatusFilter): boolean {
  if (status === 'enabled') return item.enabled
  if (status === 'disabled') return !item.enabled
  return true
}

function itemMatchesSource(item: PluginRegistryPanelItem, source: SourceFilter): boolean {
  if (source === 'all') return true
  return (item.sourceKind ?? 'other') === source
}

function compareItems(a: PluginRegistryPanelItem, b: PluginRegistryPanelItem): number {
  return (
    KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
    a.name.localeCompare(b.name) ||
    a.sourceRoot.localeCompare(b.sourceRoot) ||
    a.path.localeCompare(b.path)
  )
}

function formatScanTime(value: string | undefined): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function shortPath(path: string): string {
  const clean = path.replace(/\/+$/, '')
  const parts = clean.split(/[\\/]+/).filter(Boolean)
  if (parts.length <= 3) return path
  return `.../${parts.slice(-3).join('/')}`
}

function StatCard({ label, value, tone }: { label: string; value: ReactNode; tone?: string }): React.JSX.Element {
  return (
    <div className={cx('plugin-registry-stat', tone && `plugin-registry-stat-${tone}`)}>
      <span className="plugin-registry-stat-label">{label}</span>
      <b className="plugin-registry-stat-value">{value}</b>
    </div>
  )
}

function MetaRow({
  label,
  children,
  mono = false
}: {
  label: string
  children: ReactNode
  mono?: boolean
}): React.JSX.Element {
  return (
    <div className="plugin-registry-meta-row">
      <span className="plugin-registry-meta-label">{label}</span>
      <span className={cx('plugin-registry-meta-value', mono && 'plugin-registry-mono')}>{children}</span>
    </div>
  )
}

export default function PluginRegistryPanel({
  items,
  roots = [],
  diagnostics = [],
  scannedAt,
  truncated = false,
  loading = false,
  error,
  message,
  selectedItemId,
  className,
  labels: labelOverrides,
  onRefresh,
  onClose,
  onSelectItem,
  onOpenItem,
  onRevealItem,
  onUseItem,
  onDispatchAgent,
  onToggleItem,
  onProbeMcp,
  mcpProbeResults = {},
  mcpProbing = false
}: PluginRegistryPanelProps): React.JSX.Element {
  const labels = mergeLabels(labelOverrides)
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [localSelectedId, setLocalSelectedId] = useState<string | undefined>()

  const stats = useMemo(() => {
    const byKind: Record<PluginRegistryKind, number> = { plugin: 0, skill: 0, agent: 0, mcp: 0 }
    const bySource: Record<PluginRegistrySourceKind, number> = { codex: 0, project: 0, user: 0, other: 0 }
    let enabled = 0

    for (const item of items) {
      byKind[item.kind] += 1
      bySource[item.sourceKind ?? 'other'] += 1
      if (item.enabled) enabled += 1
    }

    return {
      byKind,
      bySource,
      enabled,
      disabled: items.length - enabled,
      total: items.length
    }
  }, [items])

  const visibleItems = useMemo(() => {
    const normalizedQuery = normalizeSearch(query)
    return items
      .filter((item) => kindFilter === 'all' || item.kind === kindFilter)
      .filter((item) => itemMatchesStatus(item, statusFilter))
      .filter((item) => itemMatchesSource(item, sourceFilter))
      .filter((item) => itemMatchesQuery(item, normalizedQuery))
      .slice()
      .sort(compareItems)
  }, [items, kindFilter, query, sourceFilter, statusFilter])

  const selectedItem = useMemo(() => {
    const id = selectedItemId ?? localSelectedId
    return items.find((item) => item.id === id) ?? visibleItems[0]
  }, [items, localSelectedId, selectedItemId, visibleItems])

  const selectItem = (item: PluginRegistryPanelItem): void => {
    setLocalSelectedId(item.id)
    onSelectItem?.(item)
  }

  return (
    <div className={cx('plugin-registry-panel', className)}>
      <header className="plugin-registry-header">
        <div className="plugin-registry-heading">
          <div className="plugin-registry-title">{labels.title}</div>
          <div className="plugin-registry-subtitle">{labels.subtitle}</div>
        </div>
        <div className="plugin-registry-actions">
          {onProbeMcp && stats.byKind.mcp > 0 && (
            <button
              className="btn btn-ghost btn-sm"
              disabled={mcpProbing}
              title="真实连接测试:stdio 发 initialize 握手,http 测可达性"
              onClick={() => void onProbeMcp(items.filter((item) => item.kind === 'mcp'))}
            >
              {mcpProbing ? '探测中…' : '探测 MCP 连接'}
            </button>
          )}
          {onRefresh && (
            <button className="btn btn-ghost btn-sm" disabled={loading} onClick={() => void onRefresh()}>
              {loading ? labels.loading : labels.refresh}
            </button>
          )}
          {onClose && (
            <button className="btn btn-ghost btn-sm" onClick={onClose}>
              {labels.close}
            </button>
          )}
        </div>
      </header>

      {error && <div className="notice notice-error plugin-registry-notice">{error}</div>}
      {message && <div className="notice notice-info plugin-registry-notice">{message}</div>}

      <section className="plugin-registry-summary" aria-label={labels.status}>
        <StatCard label={labels.total} value={stats.total} />
        <StatCard label={labels.plugins} value={stats.byKind.plugin} />
        <StatCard label={labels.skills} value={stats.byKind.skill} />
        <StatCard label={labels.agents} value={stats.byKind.agent} />
        <StatCard label={labels.mcp} value={stats.byKind.mcp} />
        <StatCard label={labels.active} value={stats.enabled} tone="enabled" />
        <StatCard label={labels.inactive} value={stats.disabled} tone="disabled" />
      </section>

      <section className="plugin-registry-toolbar">
        <input
          className="input plugin-registry-search"
          value={query}
          placeholder={labels.searchPlaceholder}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="plugin-registry-filter-group" role="group" aria-label="Plugin kind">
          {(['all', ...KIND_ORDER] as KindFilter[]).map((kind) => (
            <button
              key={kind}
              className={cx('plugin-registry-filter', kindFilter === kind && 'plugin-registry-filter-active')}
              onClick={() => setKindFilter(kind)}
            >
              {kindLabel(kind, labels)}
              <span className="plugin-registry-filter-count">
                {kind === 'all' ? stats.total : stats.byKind[kind]}
              </span>
            </button>
          ))}
        </div>
        <div className="plugin-registry-filter-group" role="group" aria-label="Plugin status">
          {(['all', 'enabled', 'disabled'] as StatusFilter[]).map((status) => (
            <button
              key={status}
              className={cx('plugin-registry-filter', statusFilter === status && 'plugin-registry-filter-active')}
              onClick={() => setStatusFilter(status)}
            >
              {status === 'enabled'
                ? labels.enabled
                : status === 'disabled'
                  ? labels.disabled
                  : labels.allStatuses}
            </button>
          ))}
        </div>
        <div className="plugin-registry-filter-group" role="group" aria-label="Plugin source">
          {(['all', ...SOURCE_ORDER] as SourceFilter[]).map((source) => (
            <button
              key={source}
              className={cx('plugin-registry-filter', sourceFilter === source && 'plugin-registry-filter-active')}
              onClick={() => setSourceFilter(source)}
            >
              {sourceLabel(source, labels)}
              <span className="plugin-registry-filter-count">
                {source === 'all' ? stats.total : stats.bySource[source]}
              </span>
            </button>
          ))}
        </div>
      </section>

      <div className="plugin-registry-body">
        <section className="plugin-registry-list" aria-label={labels.title}>
          {loading && visibleItems.length === 0 ? (
            <div className="plugin-registry-empty">{labels.loading}</div>
          ) : visibleItems.length === 0 ? (
            <div className="plugin-registry-empty">{labels.empty}</div>
          ) : (
            visibleItems.map((item) => (
              <article
                key={item.id}
                className={cx(
                  'plugin-registry-row',
                  selectedItem?.id === item.id && 'plugin-registry-row-active'
                )}
              >
                <button className="plugin-registry-row-main" title={item.path} onClick={() => selectItem(item)}>
                  <span className={cx('plugin-registry-kind', `plugin-registry-kind-${item.kind}`)}>
                    {itemKindLabel(item.kind, labels)}
                  </span>
                  <span className="plugin-registry-row-content">
                    <span className="plugin-registry-row-name">
                      {item.name}
                      {item.kind === 'mcp' && mcpProbeResults[item.id] && (
                        <span
                          className={cx(
                            'plugin-registry-probe',
                            mcpProbeResults[item.id].ok
                              ? 'plugin-registry-probe-ok'
                              : 'plugin-registry-probe-fail'
                          )}
                          title={
                            mcpProbeResults[item.id].ok
                              ? [
                                  mcpProbeResults[item.id].serverName &&
                                    `server: ${mcpProbeResults[item.id].serverName} ${mcpProbeResults[item.id].serverVersion ?? ''}`,
                                  mcpProbeResults[item.id].latencyMs !== undefined &&
                                    `${mcpProbeResults[item.id].latencyMs}ms`
                                ]
                                  .filter(Boolean)
                                  .join(' · ')
                              : mcpProbeResults[item.id].error
                          }
                        >
                          {mcpProbeResults[item.id].ok
                            ? `✓ 已连通${mcpProbeResults[item.id].latencyMs !== undefined ? ` ${mcpProbeResults[item.id].latencyMs}ms` : ''}`
                            : '✕ 连接失败'}
                        </span>
                      )}
                    </span>
                    <span className="plugin-registry-row-summary">
                      <span className={cx('plugin-registry-source', `plugin-registry-source-${item.sourceKind ?? 'other'}`)}>
                        {sourceLabel(item.sourceKind ?? 'other', labels)}
                      </span>
                      {item.summary || shortPath(item.path)}
                    </span>
                  </span>
                  <span
                    className={cx(
                      'plugin-registry-status-dot',
                      item.enabled ? 'plugin-registry-status-enabled' : 'plugin-registry-status-disabled'
                    )}
                    aria-label={item.enabled ? labels.enabled : labels.disabled}
                  />
                </button>
                {(onOpenItem || onRevealItem || onUseItem || onDispatchAgent || onToggleItem) && (
                  <div className="plugin-registry-row-actions">
                    {onOpenItem && (
                      <button className="btn btn-ghost btn-sm" onClick={() => onOpenItem(item)}>
                        {labels.open}
                      </button>
                    )}
                    {onRevealItem && (
                      <button className="btn btn-ghost btn-sm" onClick={() => onRevealItem(item)}>
                        {labels.reveal}
                      </button>
                    )}
                    {onUseItem && (
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={!item.enabled}
                        onClick={() => void onUseItem(item)}
                      >
                        {labels.useWithAgent}
                      </button>
                    )}
                    {onDispatchAgent && item.kind === 'agent' && (
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={!item.enabled}
                        onClick={() => void onDispatchAgent(item)}
                      >
                        {labels.dispatchAgent}
                      </button>
                    )}
                    {onToggleItem && (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => void onToggleItem(item, !item.enabled)}
                      >
                        {item.enabled ? labels.disable : labels.enable}
                      </button>
                    )}
                  </div>
                )}
              </article>
            ))
          )}
        </section>

        <aside className="plugin-registry-status-panel">
          <section className="plugin-registry-card">
            <h3 className="plugin-registry-card-title">{labels.selected}</h3>
            {selectedItem ? (
              <>
                <div className="plugin-registry-selected-head">
                  <span className={cx('plugin-registry-kind', `plugin-registry-kind-${selectedItem.kind}`)}>
                    {itemKindLabel(selectedItem.kind, labels)}
                  </span>
                  <strong className="plugin-registry-selected-name">{selectedItem.name}</strong>
                </div>
                <MetaRow label={labels.status}>
                  <span
                    className={cx(
                      'plugin-registry-badge',
                      selectedItem.enabled ? 'plugin-registry-badge-enabled' : 'plugin-registry-badge-disabled'
                    )}
                  >
                    {selectedItem.enabled ? labels.enabled : labels.disabled}
                  </span>
                </MetaRow>
                <MetaRow label={labels.stateSource}>{selectedItem.enabledSource === 'user' ? 'User override' : 'Manifest'}</MetaRow>
                {selectedItem.enabledUpdatedAt && (
                  <MetaRow label={labels.updatedAt}>{formatScanTime(selectedItem.enabledUpdatedAt)}</MetaRow>
                )}
                <MetaRow label={labels.source}>{sourceLabel(selectedItem.sourceKind ?? 'other', labels)}</MetaRow>
                <MetaRow label={labels.sourceRoot} mono>
                  {selectedItem.sourceRoot}
                </MetaRow>
                <MetaRow label={labels.path} mono>
                  {selectedItem.path}
                </MetaRow>
                <MetaRow label={labels.summary}>{selectedItem.summary || '-'}</MetaRow>
                {onUseItem && (
                  <button
                    className="btn btn-primary btn-sm plugin-registry-use-selected"
                    disabled={!selectedItem.enabled}
                    onClick={() => void onUseItem(selectedItem)}
                  >
                    {labels.useWithAgent}
                  </button>
                )}
                {onDispatchAgent && selectedItem.kind === 'agent' && (
                  <button
                    className="btn btn-primary btn-sm plugin-registry-use-selected"
                    disabled={!selectedItem.enabled}
                    onClick={() => void onDispatchAgent(selectedItem)}
                  >
                    {labels.dispatchAgent}
                  </button>
                )}
              </>
            ) : (
              <div className="plugin-registry-empty plugin-registry-empty-tight">{labels.noSelection}</div>
            )}
          </section>

          <section className="plugin-registry-card">
            <h3 className="plugin-registry-card-title">{labels.status}</h3>
            <MetaRow label={labels.roots}>{roots.length}</MetaRow>
            <MetaRow label={labels.diagnostics}>{diagnostics.length}</MetaRow>
            <MetaRow label={labels.truncated}>{truncated ? labels.yes : labels.no}</MetaRow>
            <MetaRow label={labels.scanTime}>{formatScanTime(scannedAt)}</MetaRow>
            {roots.length > 0 && (
              <div className="plugin-registry-path-list">
                {roots.map((root) => (
                  <code key={root} className="plugin-registry-path-chip" title={root}>
                    {shortPath(root)}
                  </code>
                ))}
              </div>
            )}
          </section>

          {diagnostics.length > 0 && (
            <section className="plugin-registry-card">
              <h3 className="plugin-registry-card-title">{labels.diagnostics}</h3>
              <div className="plugin-registry-diagnostics">
                {diagnostics.slice(0, 8).map((diagnostic, index) => (
                  <div key={`${diagnostic.code}-${diagnostic.path}-${index}`} className="plugin-registry-diagnostic">
                    <span className="plugin-registry-diagnostic-code">{diagnostic.code}</span>
                    <span className="plugin-registry-diagnostic-message">{diagnostic.message}</span>
                    <code className="plugin-registry-diagnostic-path" title={diagnostic.path}>
                      {shortPath(diagnostic.path)}
                    </code>
                  </div>
                ))}
              </div>
            </section>
          )}
        </aside>
      </div>
    </div>
  )
}
