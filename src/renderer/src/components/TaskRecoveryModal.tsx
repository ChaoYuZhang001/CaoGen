import { useEffect, useMemo, useState } from 'react'
import type {
  EffectRecord,
  TaskDagFinalizationResolution,
  TaskDagFinalizationView,
  TaskSnapshotRecord,
  WorkItem,
  SupervisorRunRecord
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
  const attentionWorkItems = useStore((s) => s.workflowAttentionWorkItems)
  const attentionSupervisorRuns = useStore((s) => s.workflowAttentionSupervisorRuns)
  const attentionLoading = useStore((s) => s.workflowAttentionLoading)
  const attentionError = useStore((s) => s.workflowAttentionError)
  const refreshWorkflowAttention = useStore((s) => s.refreshWorkflowAttention)
  const loading = useStore((s) => s.taskSnapshotsLoading)
  const error = useStore((s) => s.taskSnapshotsError)
  const language = useStore((s) => s.settings.language)
  const showTaskRecovery = useStore((s) => s.showTaskRecovery)
  const recoverTaskSnapshot = useStore((s) => s.recoverTaskSnapshot)
  const resolveTaskEffect = useStore((s) => s.resolveTaskEffect)
  const resolveTaskDagFinalization = useStore((s) => s.resolveTaskDagFinalization)
  const deleteTaskSnapshot = useStore((s) => s.deleteTaskSnapshot)
  const setShowTaskRecovery = useStore((s) => s.setShowTaskRecovery)
  const selectSession = useStore((s) => s.selectSession)
  const openProjectWorkspace = useStore((s) => s.openProjectWorkspace)
  const [busyId, setBusyId] = useState<string | null>(null)
  const activeIds = useMemo(() => new Set(Object.keys(sessions)), [sessions])
  const recoverable = snapshots.filter(
    (snapshot) =>
      isTaskSnapshotRecoverable(snapshot, activeIds) ||
      modelAttemptReconciliations.some((reconciliation) =>
        modelAttemptMatchesSnapshot(reconciliation, snapshot)
      )
  )
  const permissionSessions = Object.values(sessions).filter((session) => session.pendingPermissions.length > 0)
  const attentionCount = attentionWorkItems.length + attentionSupervisorRuns.length + permissionSessions
    .reduce((total, session) => total + session.pendingPermissions.length, 0)

  useEffect(() => {
    if (!ready || !showTaskRecovery) return
    void refreshWorkflowAttention()
  }, [ready, refreshWorkflowAttention, showTaskRecovery])

  if (!ready || (recoverable.length === 0 && modelAttemptReconciliations.length === 0 && attentionCount === 0)) return null

  const labels = language === 'zh'
    ? {
        close: '关闭恢复中心',
        later: '稍后处理',
        subtitle: `检测到 ${recoverable.length} 个任务快照、${modelAttemptReconciliations.length} 个模型请求和 ${attentionCount} 个工作流事项。`,
        title: '恢复中心'
      }
    : {
        close: 'Close Recovery Center',
        later: 'Review later',
        subtitle: `${recoverable.length} task snapshots, ${modelAttemptReconciliations.length} model requests, and ${attentionCount} workflow items need review.`,
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
        {attentionError && <div className="notice notice-error task-recovery-notice">{attentionError}</div>}
        {loading && <div className="task-recovery-meta">正在刷新恢复候选...</div>}
        {attentionLoading && <div className="task-recovery-meta">正在刷新工作流事项...</div>}

        <div className="task-recovery-list">
          <WorkflowAttentionPanel
            workItems={attentionWorkItems}
            supervisorRuns={attentionSupervisorRuns}
            permissionSessions={permissionSessions}
            onOpenProject={(projectId) => {
              openProjectWorkspace(projectId)
              setShowTaskRecovery(false)
            }}
            onOpenSession={(sessionId) => {
              selectSession(sessionId)
              setShowTaskRecovery(false)
            }}
          />
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

function WorkflowAttentionPanel({
  workItems,
  supervisorRuns,
  permissionSessions,
  onOpenProject,
  onOpenSession
}: {
  workItems: readonly WorkItem[]
  supervisorRuns: readonly SupervisorRunRecord[]
  permissionSessions: Array<{ meta: { id: string; title?: string }; pendingPermissions: unknown[] }>
  onOpenProject: (projectId: string) => void
  onOpenSession: (sessionId: string) => void
}): React.JSX.Element | null {
  if (workItems.length === 0 && supervisorRuns.length === 0 && permissionSessions.length === 0) return null
  return (
    <section className="task-recovery-attention" aria-labelledby="workflow-attention-title">
      <header><h3 id="workflow-attention-title">待处理工作流</h3></header>
      <div role="list">
        {permissionSessions.map((session) => (
          <div className="task-recovery-attention-row" role="listitem" key={`permission:${session.meta.id}`}>
            <span className="task-recovery-attention-state">待审批</span>
            <div><strong>{session.meta.title || session.meta.id}</strong><small>{session.pendingPermissions.length} 项权限请求</small></div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenSession(session.meta.id)}>打开会话</button>
          </div>
        ))}
        {supervisorRuns.map((run) => (
          <div className="task-recovery-attention-row" role="listitem" key={`supervisor:${run.id}`}>
            <span className="task-recovery-attention-state">{attentionStateLabel(run.status)}</span>
            <div><strong>{run.workItemId}</strong><small>{run.error || `Supervisor Run ${run.id}`}</small></div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenProject(run.projectId)}>打开项目</button>
          </div>
        ))}
        {workItems.map((item) => (
          <div className="task-recovery-attention-row" role="listitem" key={`work-item:${item.id}`}>
            <span className="task-recovery-attention-state">{attentionStateLabel(item.acceptance?.status === 'failed' ? 'acceptance_failed' : item.status)}</span>
            <div><strong>{item.title}</strong><small>{item.description || item.id}</small></div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenProject(item.projectId)}>打开项目</button>
          </div>
        ))}
      </div>
    </section>
  )
}

function attentionStateLabel(status: string): string {
  if (status === 'waiting_approval') return '待审批'
  if (status === 'waiting_reconciliation') return '待对账'
  if (status === 'verifying') return '待验收'
  if (status === 'acceptance_failed') return '验收失败'
  if (status === 'failed' || status === 'blocked') return '失败'
  return '运行中'
}
