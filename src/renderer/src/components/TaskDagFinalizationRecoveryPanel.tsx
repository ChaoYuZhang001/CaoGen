import type {
  TaskDagFinalizationResolution,
  TaskDagFinalizationView,
  TaskSnapshotRecord
} from '../../../shared/types'

interface TaskDagFinalizationRecoveryPanelProps {
  finalization: TaskDagFinalizationView
  disabled: boolean
  onResolve(
    finalization: TaskDagFinalizationView,
    resolution: TaskDagFinalizationResolution
  ): void | Promise<void>
}

interface ResolutionButtonProps {
  finalization: TaskDagFinalizationView
  resolution: TaskDagFinalizationResolution
  label: string
  disabled: boolean
  onResolve: TaskDagFinalizationRecoveryPanelProps['onResolve']
}

export function pendingDagFinalization(snapshot: TaskSnapshotRecord): TaskDagFinalizationView | undefined {
  return snapshot.dagExecutions
    .map((execution) => execution.finalization)
    .find((finalization) =>
      finalization?.phase === 'waiting_reconciliation' ||
      (finalization?.phase === 'summary_pending' && Boolean(finalization.error))
    )
}

export function TaskDagFinalizationRecoveryPanel({
  finalization,
  disabled,
  onResolve
}: TaskDagFinalizationRecoveryPanelProps): React.JSX.Element {
  const verificationWaiting =
    finalization.phase === 'waiting_reconciliation' && finalization.error?.includes('验收命令')
  return (
    <div className="task-recovery-effects">
      <div className="task-recovery-effect-heading">DAG 最终收口等待处置</div>
      <div className="task-recovery-effect-row">
        <div className="task-recovery-effect-copy">
          <strong>{finalization.phase}</strong>
          <span>{finalization.executionId}</span>
          <small>{finalization.error || '等待耐久 finalizer 收敛。'}</small>
        </div>
        <div className="task-recovery-effect-actions">
          {verificationWaiting && (
            <>
              <ResolutionButton
                {...{ finalization, disabled, onResolve }}
                resolution="verification_passed"
                label="确认验收通过"
              />
              <ResolutionButton
                {...{ finalization, disabled, onResolve }}
                resolution="verification_failed"
                label="确认验收失败"
              />
              <ResolutionButton
                {...{ finalization, disabled, onResolve }}
                resolution="verification_not_started"
                label="确认未启动"
              />
            </>
          )}
          {finalization.phase === 'summary_pending' && (
            <ResolutionButton
              {...{ finalization, disabled, onResolve }}
              resolution="summary_not_delivered"
              label="确认未投递并重试"
            />
          )}
          {finalization.phase === 'waiting_reconciliation' && (
            <ResolutionButton
              {...{ finalization, disabled, onResolve }}
              resolution="finalization_abandoned"
              label="停止自动处理并汇总"
            />
          )}
        </div>
      </div>
    </div>
  )
}

function ResolutionButton({
  finalization,
  resolution,
  label,
  disabled,
  onResolve
}: ResolutionButtonProps): React.JSX.Element {
  return (
    <button
      className="btn btn-ghost btn-sm"
      disabled={disabled}
      onClick={() => void onResolve(finalization, resolution)}
    >
      {label}
    </button>
  )
}
