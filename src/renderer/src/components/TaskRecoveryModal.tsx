import { useMemo, useState } from 'react'
import type {
  EffectRecord,
  TaskDagFinalizationResolution,
  TaskDagFinalizationView,
  TaskSnapshotRecord
} from '../../../shared/types'
import { useStore } from '../store'
import {
  modelAttemptMatchesSnapshot,
  ModelAttemptRecoveryPanel
} from './ModelAttemptRecoveryPanel'
import { isTaskSnapshotRecoverable, TaskRecoveryItem } from './TaskRecoveryItem'

export default function TaskRecoveryModal(): React.JSX.Element | null {
  const ready = useStore((s) => s.ready)
  const sessions = useStore((s) => s.sessions)
  const snapshots = useStore((s) => s.taskSnapshots)
  const modelAttemptReconciliations = useStore((s) => s.modelAttemptReconciliations)
  const loading = useStore((s) => s.taskSnapshotsLoading)
  const error = useStore((s) => s.taskSnapshotsError)
  const language = useStore((s) => s.settings.language)
  const showTaskRecovery = useStore((s) => s.showTaskRecovery)
  const recoverTaskSnapshot = useStore((s) => s.recoverTaskSnapshot)
  const resolveTaskEffect = useStore((s) => s.resolveTaskEffect)
  const resolveTaskDagFinalization = useStore((s) => s.resolveTaskDagFinalization)
  const deleteTaskSnapshot = useStore((s) => s.deleteTaskSnapshot)
  const setShowTaskRecovery = useStore((s) => s.setShowTaskRecovery)
  const [busyId, setBusyId] = useState<string | null>(null)
  const activeIds = useMemo(() => new Set(Object.keys(sessions)), [sessions])
  const recoverable = snapshots.filter(
    (snapshot) =>
      isTaskSnapshotRecoverable(snapshot, activeIds) ||
      modelAttemptReconciliations.some((reconciliation) =>
        modelAttemptMatchesSnapshot(reconciliation, snapshot)
      )
  )

  if (!ready || (recoverable.length === 0 && modelAttemptReconciliations.length === 0)) return null

  const labels = language === 'zh'
    ? {
        close: '关闭恢复中心',
        later: '稍后处理',
        subtitle: `检测到 ${recoverable.length} 个任务快照和 ${modelAttemptReconciliations.length} 个待处置模型请求。`,
        title: '恢复中心'
      }
    : {
        close: 'Close Recovery Center',
        later: 'Review later',
        subtitle: `${recoverable.length} task snapshots and ${modelAttemptReconciliations.length} model requests need review.`,
        title: 'Recovery Center'
      }

  if (!showTaskRecovery) return null

  const recover = async (snapshot: TaskSnapshotRecord): Promise<void> => {
    setBusyId(snapshot.id)
    try {
      await recoverTaskSnapshot(snapshot.id)
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (snapshot: TaskSnapshotRecord): Promise<void> => {
    setBusyId(snapshot.id)
    try {
      await deleteTaskSnapshot(snapshot.id)
    } finally {
      setBusyId(null)
    }
  }

  const resolveEffect = async (
    snapshot: TaskSnapshotRecord,
    effect: EffectRecord,
    resolution: 'confirmed_applied' | 'confirmed_not_applied'
  ): Promise<void> => {
    setBusyId(effect.id)
    try {
      await resolveTaskEffect(snapshot.id, effect.id, effect.revision, resolution)
    } catch {
      // Store 保留并展示 IPC/CAS 错误；此处只消费事件处理 Promise。
    } finally {
      setBusyId(null)
    }
  }

  const resolveFinalization = async (
    finalization: TaskDagFinalizationView,
    resolution: TaskDagFinalizationResolution
  ): Promise<void> => {
    setBusyId(finalization.executionId)
    try {
      await resolveTaskDagFinalization(finalization.executionId, finalization.revision, resolution)
    } catch {
      // Store keeps the CAS/IPC error visible in the recovery modal.
    } finally {
      setBusyId(null)
    }
  }

  return (
    <aside
      className="task-recovery-drawer no-drag"
      role="dialog"
      aria-modal="false"
      aria-labelledby="task-recovery-title"
    >
      <header className="task-recovery-drawer-header">
        <div>
          <h2 id="task-recovery-title" className="modal-title">{labels.title}</h2>
          <p className="task-recovery-subtitle">{labels.subtitle}</p>
        </div>
        <button
          type="button"
          className="icon-btn task-recovery-drawer-close"
          aria-label={labels.close}
          title={labels.close}
          disabled={busyId !== null}
          onClick={() => setShowTaskRecovery(false)}
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>

      <div className="task-recovery-drawer-body">
        {error && <div className="notice notice-error task-recovery-notice">{error}</div>}
        {loading && <div className="task-recovery-meta">正在刷新恢复候选...</div>}

        <div className="task-recovery-list">
          <ModelAttemptRecoveryPanel
            reconciliations={modelAttemptReconciliations}
            snapshots={snapshots}
            busyId={busyId}
            setBusyId={setBusyId}
          />
          {recoverable.map((snapshot) => (
            <TaskRecoveryItem
              key={snapshot.id}
              snapshot={snapshot}
              modelAttemptBlocked={modelAttemptReconciliations.some((reconciliation) =>
                modelAttemptMatchesSnapshot(reconciliation, snapshot)
              )}
              busyId={busyId}
              onRecover={recover}
              onRemove={remove}
              onResolveEffect={resolveEffect}
              onResolveFinalization={resolveFinalization}
            />
          ))}
        </div>
      </div>

      <footer className="task-recovery-drawer-footer">
        <button
          className="btn btn-ghost"
          disabled={busyId !== null}
          onClick={() => setShowTaskRecovery(false)}
        >
          {labels.later}
        </button>
      </footer>
    </aside>
  )
}
