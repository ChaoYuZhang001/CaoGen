import { useMemo, useState } from 'react'
import type { EffectRecord, TaskSnapshotRecord } from '../../../shared/types'
import { useStore } from '../store'

function formatTime(value: number): string {
  try {
    return new Date(value).toLocaleString()
  } catch {
    return String(value)
  }
}

function snapshotSubtitle(snapshot: TaskSnapshotRecord): string {
  const bits = [
    snapshot.projectPath,
    snapshot.execution.status,
    `${snapshot.transcript.length} 条记录`,
    `seq ${snapshot.execution.lastSeq}`
  ]
  return bits.filter(Boolean).join(' · ')
}

function replaySummary(snapshot: TaskSnapshotRecord): string | null {
  const text = snapshot.replayCandidate?.text?.replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > 96 ? `${text.slice(0, 95)}...` : text
}

function waitingEffects(snapshot: TaskSnapshotRecord): EffectRecord[] {
  return (snapshot.run?.effects ?? []).filter((effect) => effect.status === 'waiting_reconciliation')
}

function effectTargetLabel(effect: EffectRecord): string {
  if (effect.target.kind === 'file_content') return effect.target.relativePath
  if (effect.target.kind === 'git_commit') return `${effect.target.branch} @ ${effect.target.preHead.slice(0, 8)}`
  if (effect.target.kind === 'git_push') return `${effect.target.remote}/${effect.target.branch}`
  return '无自动查询器'
}

export default function TaskRecoveryModal(): React.JSX.Element | null {
  const ready = useStore((s) => s.ready)
  const sessions = useStore((s) => s.sessions)
  const snapshots = useStore((s) => s.taskSnapshots)
  const loading = useStore((s) => s.taskSnapshotsLoading)
  const error = useStore((s) => s.taskSnapshotsError)
  const showTaskRecovery = useStore((s) => s.showTaskRecovery)
  const recoverTaskSnapshot = useStore((s) => s.recoverTaskSnapshot)
  const resolveTaskEffect = useStore((s) => s.resolveTaskEffect)
  const deleteTaskSnapshot = useStore((s) => s.deleteTaskSnapshot)
  const setShowTaskRecovery = useStore((s) => s.setShowTaskRecovery)
  const [busyId, setBusyId] = useState<string | null>(null)

  const activeIds = useMemo(() => new Set(Object.keys(sessions)), [sessions])
  const recoverable = snapshots.filter((snapshot) =>
    !activeIds.has(snapshot.sessionId) || waitingEffects(snapshot).length > 0
  )

  if (!ready || !showTaskRecovery || recoverable.length === 0) return null

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

  return (
    <div className="modal-backdrop">
      <div className="modal modal-wide task-recovery-modal">
        <h2 className="modal-title">恢复未完成任务</h2>
        <p className="task-recovery-subtitle">
          检测到 {recoverable.length} 个任务快照，可继续执行或清理。
        </p>

        {error && <div className="notice notice-error task-recovery-notice">{error}</div>}
        {loading && <div className="task-recovery-meta">正在刷新任务快照...</div>}

        <div className="task-recovery-list">
          {recoverable.map((snapshot) => {
            const unresolvedEffects = waitingEffects(snapshot)
            return (
              <div key={snapshot.id} className="task-recovery-row">
                <div className="task-recovery-main">
                  <div className="task-recovery-title">{snapshot.title}</div>
                  <div className="task-recovery-meta">{snapshotSubtitle(snapshot)}</div>
                  {replaySummary(snapshot) && (
                    <div className="task-recovery-meta">续跑: {replaySummary(snapshot)}</div>
                  )}
                  <div className="task-recovery-meta">
                    {snapshot.reason} · {formatTime(snapshot.updatedAt)}
                  </div>
                  {unresolvedEffects.length > 0 && (
                    <div className="task-recovery-effects">
                      <div className="task-recovery-effect-heading">
                        等待外部状态对账 ({unresolvedEffects.length})
                      </div>
                      {unresolvedEffects.map((effect) => (
                        <div key={effect.id} className="task-recovery-effect-row">
                          <div className="task-recovery-effect-copy">
                            <strong>{effect.toolName}</strong>
                            <span>{effectTargetLabel(effect)}</span>
                            <small>{effect.error || '自动查询无法得到唯一结论，已禁止重放。'}</small>
                          </div>
                          <div className="task-recovery-effect-actions">
                            <button
                              className="btn btn-ghost btn-sm"
                              disabled={busyId !== null}
                              onClick={() => void resolveEffect(snapshot, effect, 'confirmed_applied')}
                            >
                              确认已执行
                            </button>
                            <button
                              className="btn btn-ghost btn-sm"
                              disabled={busyId !== null}
                              onClick={() => void resolveEffect(snapshot, effect, 'confirmed_not_applied')}
                            >
                              确认未执行
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="task-recovery-actions">
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={busyId !== null || unresolvedEffects.length > 0}
                    onClick={() => void recover(snapshot)}
                  >
                    {busyId === snapshot.id ? '恢复中' : unresolvedEffects.length > 0 ? '等待对账' : '恢复'}
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={busyId !== null || unresolvedEffects.length > 0}
                    onClick={() => void remove(snapshot)}
                  >
                    删除
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        <div className="modal-actions">
          <button
            className="btn btn-ghost"
            disabled={busyId !== null}
            onClick={() => setShowTaskRecovery(false)}
          >
            稍后处理
          </button>
        </div>
      </div>
    </div>
  )
}
