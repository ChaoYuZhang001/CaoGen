import { useEffect, useMemo, useState } from 'react'
import type { TaskSnapshotRecord } from '../../../shared/types'
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

export default function TaskRecoveryModal(): React.JSX.Element | null {
  const ready = useStore((s) => s.ready)
  const sessions = useStore((s) => s.sessions)
  const recoverTaskSnapshot = useStore((s) => s.recoverTaskSnapshot)
  const [snapshots, setSnapshots] = useState<TaskSnapshotRecord[]>([])
  const [dismissed, setDismissed] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    void window.agentDesk
      .listTaskSnapshots()
      .then((items) => {
        if (!cancelled) setSnapshots(items)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [ready])

  const activeIds = useMemo(() => new Set(Object.keys(sessions)), [sessions])
  const recoverable = snapshots.filter((snapshot) => !activeIds.has(snapshot.sessionId))

  if (dismissed || recoverable.length === 0) return null

  const recover = async (snapshot: TaskSnapshotRecord): Promise<void> => {
    setBusyId(snapshot.id)
    setError('')
    try {
      await recoverTaskSnapshot(snapshot.id)
      setSnapshots((items) => items.filter((item) => item.id !== snapshot.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (snapshot: TaskSnapshotRecord): Promise<void> => {
    setBusyId(snapshot.id)
    setError('')
    try {
      await window.agentDesk.deleteTaskSnapshot(snapshot.id)
      setSnapshots((items) => items.filter((item) => item.id !== snapshot.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
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

        <div className="task-recovery-list">
          {recoverable.map((snapshot) => (
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
              </div>
              <div className="task-recovery-actions">
                <button
                  className="btn btn-primary btn-sm"
                  disabled={busyId !== null}
                  onClick={() => void recover(snapshot)}
                >
                  {busyId === snapshot.id ? '恢复中' : '恢复'}
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={busyId !== null}
                  onClick={() => void remove(snapshot)}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" disabled={busyId !== null} onClick={() => setDismissed(true)}>
            稍后处理
          </button>
        </div>
      </div>
    </div>
  )
}
