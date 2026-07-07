import type { ReactNode } from 'react'
import type { RoutineRunRecord } from '../../../../shared/types'

export type RoutinePanelRunState = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed'
export type RoutinePanelTimestamp = Date | number | string | null | undefined

export interface RoutinePanelItem {
  id: string
  name: string
  schedule: string
  enabled: boolean
  prompt?: string
  projectCwd?: string
  providerId?: string
  model?: string
  nextRunAt?: RoutinePanelTimestamp
  lastRunAt?: RoutinePanelTimestamp
  lastError?: string | null
  runState?: RoutinePanelRunState
  runDisabled?: boolean
  toggleDisabled?: boolean
  disabledReason?: string
}

export interface RoutinePanelEmptyState {
  title?: ReactNode
  message?: ReactNode
}

export interface RoutinePanelProps {
  routines: readonly RoutinePanelItem[]
  className?: string
  title?: ReactNode
  subtitle?: ReactNode
  loading?: boolean
  disabled?: boolean
  error?: ReactNode
  message?: ReactNode
  runs?: readonly RoutineRunRecord[]
  selectedRoutineId?: string | null
  now?: RoutinePanelTimestamp
  showCloudSchedulingNote?: boolean
  cloudSchedulingNote?: ReactNode
  emptyState?: RoutinePanelEmptyState
  onAddRoutine?: () => void
  onRefresh?: () => void | Promise<void>
  onClose?: () => void
  onDeleteRoutine?: (routine: RoutinePanelItem) => void
  onEditRoutine?: (routine: RoutinePanelItem) => void
  onSelectRoutine?: (routine: RoutinePanelItem) => void
  onToggleRoutine?: (routine: RoutinePanelItem, enabled: boolean) => void
  onRunRoutine?: (routine: RoutinePanelItem) => void
}

interface TimeDisplay {
  primary: string
  secondary: string
  title?: string
}

const DEFAULT_TITLE = 'Routines'
const DEFAULT_SUBTITLE = '本地定时'
const DEFAULT_CLOUD_NOTE = '云端定时未接入；当前仅管理本机定时。'
const DEFAULT_EMPTY_TITLE = '暂无 Routine'
const DEFAULT_EMPTY_MESSAGE = '保存后会显示下次运行和最近状态。'

function toDate(value: RoutinePanelTimestamp): Date | null {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'number') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }

  const trimmed = value.trim()
  if (!trimmed) return null
  const numeric = Number(trimmed)
  const date = Number.isFinite(numeric) && /^\d+$/.test(trimmed) ? new Date(numeric) : new Date(trimmed)
  return Number.isNaN(date.getTime()) ? null : date
}

function formatAbsolute(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

function formatFull(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(date)
}

function formatRelative(date: Date, base: Date): string {
  const diffMs = date.getTime() - base.getTime()
  const absMs = Math.abs(diffMs)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  if (absMs < minute) return diffMs >= 0 ? '1 分钟内' : '刚刚'
  if (absMs < hour) {
    const minutes = Math.ceil(absMs / minute)
    return diffMs >= 0 ? `${minutes} 分钟后` : `${minutes} 分钟前`
  }
  if (absMs < day) {
    const hours = Math.ceil(absMs / hour)
    return diffMs >= 0 ? `${hours} 小时后` : `${hours} 小时前`
  }

  const days = Math.ceil(absMs / day)
  return diffMs >= 0 ? `${days} 天后` : `${days} 天前`
}

function nextRunDisplay(routine: RoutinePanelItem, now: Date): TimeDisplay {
  if (!routine.enabled) {
    return {
      primary: '已停用',
      secondary: '启用后恢复定时'
    }
  }

  const nextRun = toDate(routine.nextRunAt)
  if (!nextRun) {
    return {
      primary: '未安排',
      secondary: '暂无本地下次运行'
    }
  }

  return {
    primary: formatRelative(nextRun, now),
    secondary: formatAbsolute(nextRun),
    title: formatFull(nextRun)
  }
}

function lastRunDisplay(routine: RoutinePanelItem, now: Date): TimeDisplay {
  const lastRun = toDate(routine.lastRunAt)
  if (!lastRun) {
    return {
      primary: '从未运行',
      secondary: '暂无运行记录'
    }
  }

  return {
    primary: formatRelative(lastRun, now),
    secondary: formatAbsolute(lastRun),
    title: formatFull(lastRun)
  }
}

function visualState(routine: RoutinePanelItem): string {
  if (routine.lastError || routine.runState === 'failed') return 'failed'
  if (routine.runState === 'running') return 'running'
  if (routine.runState === 'queued') return 'queued'
  if (!routine.enabled) return 'paused'
  if (routine.runState === 'succeeded') return 'succeeded'
  return 'active'
}

function stateLabel(state: string): string {
  switch (state) {
    case 'failed':
      return '失败'
    case 'running':
      return '运行中'
    case 'queued':
      return '排队中'
    case 'paused':
      return '已停用'
    case 'succeeded':
      return '已成功'
    default:
      return '已启用'
  }
}

function runStatusLabel(status: RoutineRunRecord['status']): string {
  switch (status) {
    case 'failed':
      return '失败'
    case 'running':
      return '运行中'
    case 'queued':
      return '排队中'
    default:
      return '成功'
  }
}

function RoutineMain({
  children,
  onSelect,
  routine
}: {
  children: ReactNode
  onSelect?: (routine: RoutinePanelItem) => void
  routine: RoutinePanelItem
}): React.JSX.Element {
  if (!onSelect) return <div className="routine-panel-main">{children}</div>
  return (
    <button className="routine-panel-main routine-panel-main-button" type="button" onClick={() => onSelect(routine)}>
      {children}
    </button>
  )
}

function RoutineRow({
  disabled,
  now,
  onDeleteRoutine,
  onEditRoutine,
  onRunRoutine,
  onSelectRoutine,
  onToggleRoutine,
  routine,
  selected
}: {
  disabled: boolean
  now: Date
  onDeleteRoutine?: (routine: RoutinePanelItem) => void
  onEditRoutine?: (routine: RoutinePanelItem) => void
  onRunRoutine?: (routine: RoutinePanelItem) => void
  onSelectRoutine?: (routine: RoutinePanelItem) => void
  onToggleRoutine?: (routine: RoutinePanelItem, enabled: boolean) => void
  routine: RoutinePanelItem
  selected: boolean
}): React.JSX.Element {
  const state = visualState(routine)
  const nextRun = nextRunDisplay(routine, now)
  const lastRun = lastRunDisplay(routine, now)
  const running = routine.runState === 'running'
  const queued = routine.runState === 'queued'
  const runDisabled = disabled || Boolean(routine.runDisabled) || running || queued || !onRunRoutine
  const toggleDisabled = disabled || Boolean(routine.toggleDisabled) || !onToggleRoutine
  const modelLabel = [routine.providerId, routine.model].filter(Boolean).join(' / ')

  return (
    <article
      role="listitem"
      className={[
        'routine-panel-item',
        `routine-panel-item-${state}`,
        selected ? 'routine-panel-item-selected' : ''
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <RoutineMain routine={routine} onSelect={onSelectRoutine}>
        <div className="routine-panel-item-top">
          <div className="routine-panel-title-row">
            <h3 className="routine-panel-name">{routine.name}</h3>
            <span className={`routine-panel-status routine-panel-status-${state}`}>{stateLabel(state)}</span>
          </div>
          <div className="routine-panel-schedule" title={routine.schedule}>
            {routine.schedule}
          </div>
        </div>

        <div className="routine-panel-metrics">
          <div className="routine-panel-metric" title={nextRun.title}>
            <span className="routine-panel-metric-label">下次运行</span>
            <strong className="routine-panel-metric-value">{nextRun.primary}</strong>
            <span className="routine-panel-metric-sub">{nextRun.secondary}</span>
          </div>
          <div className="routine-panel-metric" title={lastRun.title}>
            <span className="routine-panel-metric-label">上次运行</span>
            <strong className="routine-panel-metric-value">{lastRun.primary}</strong>
            <span className="routine-panel-metric-sub">{lastRun.secondary}</span>
          </div>
        </div>

        {(routine.projectCwd || modelLabel || routine.prompt) && (
          <div className="routine-panel-meta">
            {routine.projectCwd && (
              <span className="routine-panel-path" title={routine.projectCwd}>
                {routine.projectCwd}
              </span>
            )}
            {modelLabel && <span className="routine-panel-model">{modelLabel}</span>}
            {routine.prompt && (
              <span className="routine-panel-prompt" title={routine.prompt}>
                {routine.prompt}
              </span>
            )}
          </div>
        )}

        {(routine.lastError || state === 'failed') && (
          <div className="routine-panel-error">{routine.lastError || '上次运行失败。'}</div>
        )}
      </RoutineMain>

      <div className="routine-panel-actions">
        <label className="routine-panel-switch" title={routine.disabledReason}>
          <input
            className="routine-panel-switch-input"
            type="checkbox"
            checked={routine.enabled}
            disabled={toggleDisabled}
            aria-label={`${routine.name} 启停`}
            onChange={(event) => onToggleRoutine?.(routine, event.currentTarget.checked)}
          />
          <span className="routine-panel-switch-track" aria-hidden="true">
            <span className="routine-panel-switch-thumb" />
          </span>
          <span className="routine-panel-switch-label">{routine.enabled ? '开' : '关'}</span>
        </label>
        <button
          className="routine-panel-run"
          type="button"
          disabled={runDisabled}
          title={routine.disabledReason}
          onClick={() => onRunRoutine?.(routine)}
        >
          {running ? '运行中' : queued ? '排队中' : '标记运行'}
        </button>
        <div className="routine-panel-row-buttons">
          <button
            className="routine-panel-secondary"
            type="button"
            disabled={disabled || !onEditRoutine}
            onClick={() => onEditRoutine?.(routine)}
          >
            编辑
          </button>
          <button
            className="routine-panel-secondary routine-panel-secondary-danger"
            type="button"
            disabled={disabled || !onDeleteRoutine}
            onClick={() => onDeleteRoutine?.(routine)}
          >
            删除
          </button>
        </div>
      </div>
    </article>
  )
}

export default function RoutinePanel({
  className,
  cloudSchedulingNote = DEFAULT_CLOUD_NOTE,
  disabled = false,
  emptyState,
  error,
  loading = false,
  message,
  now,
  onAddRoutine,
  onClose,
  onDeleteRoutine,
  onEditRoutine,
  onRefresh,
  onRunRoutine,
  onSelectRoutine,
  onToggleRoutine,
  runs = [],
  routines,
  selectedRoutineId,
  showCloudSchedulingNote = true,
  subtitle = DEFAULT_SUBTITLE,
  title = DEFAULT_TITLE
}: RoutinePanelProps): React.JSX.Element {
  const nowDate = toDate(now) ?? new Date()
  const rootClassName = ['routine-panel', className].filter(Boolean).join(' ')
  const visibleRuns = (selectedRoutineId ? runs.filter((run) => run.routineId === selectedRoutineId) : runs).slice(0, 6)

  return (
    <section className={rootClassName}>
      <header className="routine-panel-header">
        <div className="routine-panel-heading">
          <h2 className="routine-panel-title">{title}</h2>
          {subtitle && <div className="routine-panel-subtitle">{subtitle}</div>}
        </div>
        <div className="routine-panel-header-actions">
          <div className="routine-panel-count">{loading ? '加载中' : `${routines.length} 个`}</div>
          {onAddRoutine && (
            <button className="btn btn-primary btn-sm" disabled={loading} onClick={onAddRoutine}>
              新增
            </button>
          )}
          {onRefresh && (
            <button className="btn btn-ghost btn-sm" disabled={loading} onClick={() => void onRefresh()}>
              刷新
            </button>
          )}
          {onClose && (
            <button className="btn btn-ghost btn-sm" onClick={onClose}>
              关闭
            </button>
          )}
        </div>
      </header>

      {error && <div className="notice notice-error routine-panel-notice">{error}</div>}
      {message && <div className="notice notice-info routine-panel-notice">{message}</div>}
      {showCloudSchedulingNote && <div className="routine-panel-cloud-note">{cloudSchedulingNote}</div>}

      <div className="routine-panel-list" role="list">
        {loading && routines.length === 0 ? (
          <div className="routine-panel-empty">正在加载 Routine...</div>
        ) : routines.length === 0 ? (
          <div className="routine-panel-empty">
            <strong>{emptyState?.title ?? DEFAULT_EMPTY_TITLE}</strong>
            <span>{emptyState?.message ?? DEFAULT_EMPTY_MESSAGE}</span>
          </div>
        ) : (
          routines.map((routine) => (
            <RoutineRow
              key={routine.id}
              disabled={disabled}
              now={nowDate}
              onDeleteRoutine={onDeleteRoutine}
              onEditRoutine={onEditRoutine}
              onRunRoutine={onRunRoutine}
              onSelectRoutine={onSelectRoutine}
              onToggleRoutine={onToggleRoutine}
              routine={routine}
              selected={selectedRoutineId === routine.id}
            />
          ))
        )}
      </div>

      {visibleRuns.length > 0 && (
        <section className="routine-panel-history">
          <div className="routine-panel-result-head">
            <span>运行历史</span>
            <b>{visibleRuns.length}</b>
          </div>
          <div className="routine-panel-history-list">
            {visibleRuns.map((run) => (
              <div key={run.id} className={`routine-panel-history-item routine-panel-history-${run.status}`}>
                <span>{runStatusLabel(run.status)}</span>
                <strong>{run.routineName}</strong>
                <time title={formatFull(new Date(run.startedAt))}>{formatRelative(new Date(run.startedAt), nowDate)}</time>
                {run.error && <small title={run.error}>{run.error}</small>}
              </div>
            ))}
          </div>
        </section>
      )}
    </section>
  )
}
