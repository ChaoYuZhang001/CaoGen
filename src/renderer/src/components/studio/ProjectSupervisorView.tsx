import { useCallback, useEffect, useMemo, useState } from 'react'
import { Ban, CirclePause, Play, RefreshCw, RotateCcw } from 'lucide-react'
import type { SupervisorRunRecord, WorkItem } from '../../../../shared/types'

type SupervisorAction = 'pause' | 'resume' | 'cancel' | 'retry'

interface ProjectSupervisorViewProps {
  active: boolean
  projectId: string
  refreshToken: string
  workItems: WorkItem[]
  onRefreshProject: () => Promise<void>
}

/**
 * Project-scoped execution controls deliberately operate only on canonical
 * TaskRun rows. Manual Supervisor rows retain their separate coordination API.
 */
export function ProjectSupervisorView({
  active,
  projectId,
  refreshToken,
  workItems,
  onRefreshProject
}: ProjectSupervisorViewProps): React.JSX.Element {
  const [runs, setRuns] = useState<SupervisorRunRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    if (!active) return
    setLoading(true)
    setError('')
    try {
      const next = await window.agentDesk.listSupervisorRuns({ projectId })
      setRuns(next
        .filter((run) => run.origin === 'task_run')
        .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }, [active, projectId])

  useEffect(() => {
    void refresh()
  }, [refresh, refreshToken])

  const workItemTitles = useMemo(
    () => new Map(workItems.map((item) => [item.id, item.title])),
    [workItems]
  )
  const statusCounts = useMemo(() => countStatuses(runs), [runs])

  const control = async (run: SupervisorRunRecord, action: SupervisorAction): Promise<void> => {
    setBusyId(run.id)
    setError('')
    try {
      if (action === 'cancel') {
        await window.agentDesk.cancelSupervisorRun(run.id, { expectedRevision: run.revision })
      } else if (action === 'retry') {
        await window.agentDesk.retrySupervisorRun(run.id, { expectedRevision: run.revision })
      } else {
        const leased = await window.agentDesk.claimSupervisorControlLease(run.id, run.revision)
        const lease = leased.lease
        if (!lease) throw new Error(`Supervisor Run ${run.id} did not return a control lease`)
        const options = {
          ownerId: lease.ownerId,
          leaseId: lease.id,
          fencingToken: lease.fencingToken,
          expectedRevision: leased.revision
        }
        if (action === 'pause') await window.agentDesk.pauseSupervisorRun(run.id, options)
        else await window.agentDesk.resumeSupervisorRun(run.id, options)
      }
      await Promise.all([refresh(), onRefreshProject()])
    } catch (cause) {
      setError(errorMessage(cause))
      await Promise.allSettled([refresh(), onRefreshProject()])
    } finally {
      setBusyId('')
    }
  }

  return (
    <section className="pws-section pws-supervisor" aria-labelledby="project-supervisor-title" data-project-supervisor>
      <div className="pws-section-header">
        <div className="pws-section-title">
          <h2 id="project-supervisor-title">执行控制</h2>
          <span aria-label={`${runs.length} 个执行 Run`}>{runs.length}</span>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-icon-sm"
          disabled={loading || Boolean(busyId)}
          aria-label="刷新执行状态"
          title="刷新执行状态"
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} className={loading ? 'pws-supervisor-spin' : undefined} aria-hidden="true" />
        </button>
      </div>

      <div className="pws-supervisor-summary" aria-label="执行状态摘要">
        <span><strong>{statusCounts.running}</strong> 运行</span>
        <span><strong>{statusCounts.waiting}</strong> 等待处理</span>
        <span><strong>{statusCounts.paused}</strong> 已暂停</span>
        <span data-alert={statusCounts.blocked + statusCounts.failed > 0}>
          <strong>{statusCounts.blocked + statusCounts.failed}</strong> 需介入
        </span>
      </div>

      {runs.length === 0 && !loading && <p className="pws-muted">当前项目没有可控制的执行 Run。</p>}
      {runs.length > 0 && (
        <div className="pws-supervisor-list" role="list" aria-live="polite">
          {runs.map((run) => (
            <SupervisorRunRow
              key={run.id}
              run={run}
              workItemTitle={workItemTitles.get(run.workItemId)}
              busy={busyId === run.id}
              onControl={control}
            />
          ))}
        </div>
      )}
      {error && <p className="pws-work-item-control-error" role="alert">执行控制失败: {error}</p>}
    </section>
  )
}

function SupervisorRunRow({
  run,
  workItemTitle,
  busy,
  onControl
}: {
  run: SupervisorRunRecord
  workItemTitle?: string
  busy: boolean
  onControl: (run: SupervisorRunRecord, action: SupervisorAction) => Promise<void>
}): React.JSX.Element {
  const controls = controlsFor(run)
  return (
    <article className="pws-supervisor-run" role="listitem" data-supervisor-run-id={run.id} data-status={run.status}>
      <div className="pws-supervisor-run-primary">
        <strong>{workItemTitle ?? run.workItemId}</strong>
        <span className={`pws-status pws-supervisor-status-${run.status}`}>{statusLabel(run.status)}</span>
      </div>
      <div className="pws-supervisor-run-detail">
        <span>{usageLabel(run)}</span>
        <span>{retryLabel(run)}</span>
        {run.lease && <span>控制租约 {run.lease.fencingToken}</span>}
        <time dateTime={new Date(run.updatedAt).toISOString()}>{formatUpdatedAt(run.updatedAt)}</time>
      </div>
      {run.error && <p className="pws-supervisor-run-error">{run.error}</p>}
      <div className="pws-supervisor-run-actions" aria-label={`${workItemTitle ?? run.workItemId} 的执行操作`}>
        {controls.map((control) => {
          const Icon = control.Icon
          return (
            <button
              key={control.action}
              type="button"
              className="btn btn-ghost btn-icon-sm"
              disabled={busy}
              aria-label={control.label}
              title={control.label}
              onClick={() => void onControl(run, control.action)}
            >
              <Icon size={14} aria-hidden="true" />
            </button>
          )
        })}
      </div>
    </article>
  )
}

function controlsFor(run: SupervisorRunRecord): Array<{
  action: SupervisorAction
  label: string
  Icon: typeof CirclePause
}> {
  if (run.status === 'running' || run.status === 'waiting_approval') {
    return [
      { action: 'pause', label: '暂停执行', Icon: CirclePause },
      { action: 'cancel', label: '取消执行', Icon: Ban }
    ]
  }
  if (run.status === 'queued' || run.status === 'paused' || run.status === 'blocked') {
    return [
      { action: 'resume', label: '恢复执行', Icon: Play },
      { action: 'cancel', label: '取消执行', Icon: Ban }
    ]
  }
  if (run.status === 'failed' || run.status === 'waiting_reconciliation') {
    return [{ action: 'retry', label: '授权重试', Icon: RotateCcw }]
  }
  return []
}

function countStatuses(runs: readonly SupervisorRunRecord[]): {
  running: number
  waiting: number
  paused: number
  blocked: number
  failed: number
} {
  return runs.reduce((counts, run) => {
    if (run.status === 'running') counts.running += 1
    if (run.status === 'queued' || run.status === 'waiting_approval' || run.status === 'waiting_reconciliation') {
      counts.waiting += 1
    }
    if (run.status === 'paused') counts.paused += 1
    if (run.status === 'blocked') counts.blocked += 1
    if (run.status === 'failed') counts.failed += 1
    return counts
  }, { running: 0, waiting: 0, paused: 0, blocked: 0, failed: 0 })
}

function usageLabel(run: SupervisorRunRecord): string {
  const tokens = (run.usage?.input ?? 0) + (run.usage?.output ?? 0)
  if (run.budget?.maxTokens !== undefined) return `${tokens}/${run.budget.maxTokens} tokens`
  if (run.usage?.turns !== undefined) return `${run.usage.turns} 轮 · ${tokens} tokens`
  return `${tokens} tokens`
}

function retryLabel(run: SupervisorRunRecord): string {
  return `重试 ${run.retryCount}/${run.maxRetries}`
}

function statusLabel(status: SupervisorRunRecord['status']): string {
  const labels: Record<SupervisorRunRecord['status'], string> = {
    queued: '待执行',
    running: '运行中',
    waiting_approval: '待审批',
    waiting_reconciliation: '待对账',
    paused: '已暂停',
    blocked: '受阻',
    failed: '失败',
    completed: '已完成',
    cancelled: '已取消'
  }
  return labels[status]
}

function formatUpdatedAt(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(value)
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
