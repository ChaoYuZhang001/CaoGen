import { useMemo } from 'react'
import type {
  ModelAttemptReconciliationResolution,
  ModelAttemptReconciliationView
} from '../../../shared/model-attempt-types'
import type { TaskSnapshotRecord } from '../../../shared/types'
import { useStore } from '../store'

type ModelAttemptResolver = (view: ModelAttemptReconciliationView, resolution: ModelAttemptReconciliationResolution) => void | Promise<void>

interface ModelAttemptRecoveryPanelProps {
  reconciliations: ModelAttemptReconciliationView[]
  snapshots: TaskSnapshotRecord[]
  busyId: string | null
  setBusyId(value: string | null): void
}

export function ModelAttemptRecoveryPanel({
  reconciliations,
  snapshots,
  busyId,
  setBusyId
}: ModelAttemptRecoveryPanelProps): React.JSX.Element | null {
  const resolveModelAttemptReconciliation = useStore(
    (state) => state.resolveModelAttemptReconciliation
  )
  const retryableAttemptIds = useMemo(
    () => new Set(
      reconciliations
        .filter((reconciliation) =>
          snapshots.some((snapshot) => modelAttemptMatchesSnapshot(reconciliation, snapshot))
        )
        .map((reconciliation) => reconciliation.attempt.id)
    ),
    [reconciliations, snapshots]
  )
  if (reconciliations.length === 0) return null
  const disabled = busyId !== null

  const resolve = async (
    reconciliation: ModelAttemptReconciliationView,
    resolution: ModelAttemptReconciliationResolution
  ): Promise<void> => {
    setBusyId(reconciliation.attempt.id)
    try {
      await resolveModelAttemptReconciliation(
        reconciliation.attempt.id,
        reconciliation.attempt.revision,
        resolution
      )
    } catch {
      // Store refreshes both recovery lists and keeps the original CAS/IPC error visible.
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="model-attempt-recovery-panel" aria-label="模型请求恢复">
      <div className="model-attempt-recovery-heading">
        模型请求结果未知 ({reconciliations.length})
      </div>
      <div className="task-recovery-meta model-attempt-recovery-warning">
        应用退出前未收到可验证的 Provider 结果，已禁止自动重放。
      </div>
      {reconciliations.map((reconciliation) => (
        <ModelAttemptRecoveryItem
          key={reconciliation.attempt.id}
          reconciliation={reconciliation}
          retryAvailable={retryableAttemptIds.has(reconciliation.attempt.id)}
          disabled={disabled}
          onResolve={resolve}
        />
      ))}
    </section>
  )
}

function ModelAttemptRecoveryItem({
  reconciliation,
  retryAvailable,
  disabled,
  onResolve
}: {
  reconciliation: ModelAttemptReconciliationView
  retryAvailable: boolean
  disabled: boolean
  onResolve: ModelAttemptResolver
}): React.JSX.Element {
  const { attempt, requestId, runId, sessionId } = reconciliation
  return (
    <div className="task-recovery-row model-attempt-recovery-row">
      <div className="task-recovery-main">
        <div className="task-recovery-title">{attempt.providerId} / {attempt.model}</div>
        <div className="task-recovery-meta">
          会话 {sessionId} · 请求 {requestId} · Run {runId}
        </div>
        <div className="task-recovery-meta">
          {attempt.routeReason} · {formatTime(attempt.startedAt)} · revision {attempt.revision}
        </div>
        {!retryAvailable && (
          <div className="task-recovery-meta model-attempt-recovery-unavailable">
            缺少可恢复任务快照，无法安全重放；只能取消本次请求。
          </div>
        )}
      </div>
      <div className="task-recovery-actions">
        <button
          className="btn btn-primary btn-sm"
          disabled={disabled || !retryAvailable}
          onClick={() => void onResolve(reconciliation, 'retry_authorized')}
        >
          授权重试
        </button>
        <button
          className="btn btn-ghost btn-sm"
          disabled={disabled}
          onClick={() => void onResolve(reconciliation, 'cancelled_by_user')}
        >
          取消本次请求
        </button>
      </div>
    </div>
  )
}

export function modelAttemptMatchesSnapshot(
  reconciliation: ModelAttemptReconciliationView,
  snapshot: TaskSnapshotRecord
): boolean {
  return snapshot.run
    ? snapshot.run.id === reconciliation.runId
    : snapshot.sessionId === reconciliation.sessionId
}

function formatTime(value: number): string {
  try {
    return new Date(value).toLocaleString()
  } catch {
    return String(value)
  }
}
