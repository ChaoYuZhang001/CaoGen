import type {
  EffectRecord,
  TaskDagFinalizationResolution,
  TaskDagFinalizationView,
  TaskSnapshotRecord
} from '../../../shared/types'
import {
  pendingDagFinalization,
  TaskDagFinalizationRecoveryPanel
} from './TaskDagFinalizationRecoveryPanel'

interface TaskRecoveryItemProps {
  snapshot: TaskSnapshotRecord
  modelAttemptBlocked?: boolean
  busyId: string | null
  onRecover(snapshot: TaskSnapshotRecord): void | Promise<void>
  onRemove(snapshot: TaskSnapshotRecord): void | Promise<void>
  onResolveEffect(
    snapshot: TaskSnapshotRecord,
    effect: EffectRecord,
    resolution: 'confirmed_applied' | 'confirmed_not_applied'
  ): void | Promise<void>
  onResolveFinalization(
    finalization: TaskDagFinalizationView,
    resolution: TaskDagFinalizationResolution
  ): void | Promise<void>
}

export function waitingEffects(snapshot: TaskSnapshotRecord): EffectRecord[] {
  return (snapshot.run?.effects ?? []).filter((effect) => effect.status === 'waiting_reconciliation')
}

export function isTaskSnapshotRecoverable(
  snapshot: TaskSnapshotRecord,
  activeIds: ReadonlySet<string>
): boolean {
  return (
    !activeIds.has(snapshot.sessionId) ||
    waitingEffects(snapshot).length > 0 ||
    pendingDagFinalization(snapshot) !== undefined
  )
}

export function TaskRecoveryItem({
  snapshot,
  modelAttemptBlocked = false,
  busyId,
  onRecover,
  onRemove,
  onResolveEffect,
  onResolveFinalization
}: TaskRecoveryItemProps): React.JSX.Element {
  const unresolvedEffects = waitingEffects(snapshot)
  const operationSnapshot = snapshot.run?.operation !== undefined
  const finalization = pendingDagFinalization(snapshot)
  const replay = replaySummary(snapshot)
  const disabled = busyId !== null
  return (
    <div className="task-recovery-row">
      <div className="task-recovery-main">
        <div className="task-recovery-title">{snapshot.title}</div>
        <div className="task-recovery-meta">{snapshotSubtitle(snapshot)}</div>
        {replay && <div className="task-recovery-meta">续跑: {replay}</div>}
        <div className="task-recovery-meta">{snapshot.reason} · {formatTime(snapshot.updatedAt)}</div>
        {unresolvedEffects.length > 0 && (
          <EffectRecoveryPanel
            snapshot={snapshot}
            effects={unresolvedEffects}
            disabled={disabled}
            onResolve={onResolveEffect}
          />
        )}
        {finalization && (
          <TaskDagFinalizationRecoveryPanel
            finalization={finalization}
            disabled={disabled}
            onResolve={onResolveFinalization}
          />
        )}
      </div>
      <div className="task-recovery-actions">
        <button
          className="btn btn-primary btn-sm"
          disabled={
            disabled ||
            modelAttemptBlocked ||
            unresolvedEffects.length > 0 ||
            operationSnapshot ||
            Boolean(finalization)
          }
          onClick={() => void onRecover(snapshot)}
        >
          {recoveryActionLabel(busyId, snapshot, unresolvedEffects, modelAttemptBlocked)}
        </button>
        <button
          className="btn btn-ghost btn-sm"
          disabled={
            disabled || modelAttemptBlocked || unresolvedEffects.length > 0 || Boolean(finalization)
          }
          onClick={() => void onRemove(snapshot)}
        >
          删除
        </button>
      </div>
    </div>
  )
}

function EffectRecoveryPanel({
  snapshot,
  effects,
  disabled,
  onResolve
}: {
  snapshot: TaskSnapshotRecord
  effects: EffectRecord[]
  disabled: boolean
  onResolve: TaskRecoveryItemProps['onResolveEffect']
}): React.JSX.Element {
  return (
    <div className="task-recovery-effects">
      <div className="task-recovery-effect-heading">等待外部状态对账 ({effects.length})</div>
      {effects.map((effect) => (
        <div key={effect.id} className="task-recovery-effect-row">
          <div className="task-recovery-effect-copy">
            <strong>{effect.toolName}</strong>
            <span>{effectTargetLabel(effect)}</span>
            <small>{effect.error || '自动查询无法得到唯一结论，已禁止重放。'}</small>
          </div>
          <div className="task-recovery-effect-actions">
            <button
              className="btn btn-ghost btn-sm"
              disabled={disabled}
              onClick={() => void onResolve(snapshot, effect, 'confirmed_applied')}
            >
              确认已执行
            </button>
            <button
              className="btn btn-ghost btn-sm"
              disabled={disabled}
              onClick={() => void onResolve(snapshot, effect, 'confirmed_not_applied')}
            >
              确认未执行
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

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
    snapshot.run?.operation ? '交互操作' : snapshot.execution.status,
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

function effectTargetLabel(effect: EffectRecord): string {
  if (effect.target.kind === 'file_content') return effect.target.relativePath
  if (effect.target.kind === 'git_commit') return `${effect.target.branch} @ ${effect.target.preHead.slice(0, 8)}`
  if (effect.target.kind === 'git_merge') return `${effect.target.destinationRef} <- ${effect.target.sourceRef}`
  if (effect.target.kind === 'git_push') return `${effect.target.remote}/${effect.target.branch}`
  if (effect.target.kind === 'worktree_patch_apply') {
    return `${effect.target.changedPaths.length} files · ${effect.target.patchSha256.slice(0, 12)}`
  }
  if (effect.target.kind === 'code_forge_patch') {
    return `${effect.target.changedPaths.length} files · artifact ${effect.target.patchSha256.slice(0, 12)}`
  }
  if (effect.target.kind === 'pull_request_create') {
    return `${effect.target.projectPath}: ${effect.target.sourceBranch} -> ${effect.target.baseBranch}`
  }
  return '无自动查询器'
}

function recoveryActionLabel(
  busyId: string | null,
  snapshot: TaskSnapshotRecord,
  unresolvedEffects: EffectRecord[],
  modelAttemptBlocked: boolean
): string {
  if (busyId === snapshot.id) return '恢复中'
  if (modelAttemptBlocked) return '等待模型请求处置'
  if (unresolvedEffects.length > 0) return '等待对账'
  return snapshot.run?.operation !== undefined ? '仅支持对账' : '恢复'
}
