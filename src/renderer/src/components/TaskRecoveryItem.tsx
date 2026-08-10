import type {
  AgentEvent,
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
        <RecoveryBoundary snapshot={snapshot} />
        <RecoveryTimeline snapshot={snapshot} />
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

function RecoveryBoundary({ snapshot }: { snapshot: TaskSnapshotRecord }): React.JSX.Element {
  const effects = snapshot.run?.effects ?? []
  const confirmed = effects.filter((effect) => effect.status === 'confirmed').length
  const pending = effects.filter((effect) =>
    effect.status === 'prepared' || effect.status === 'executing' || effect.status === 'waiting_reconciliation'
  ).length
  const checkpoint = snapshot.execution.lastCheckpointMessageId
  const context = snapshot.meta.responsesContext
  const ledger = snapshot.conversationLedger
  return (
    <div className="task-recovery-boundary" aria-label="恢复边界">
      <div className="task-recovery-section-heading">恢复边界</div>
      <div className="task-recovery-boundary-grid">
        <span>本地转录</span>
        <strong>{snapshot.transcript.length} 条 · seq {snapshot.execution.lastSeq}</strong>
        <span>账本完整性</span>
        <strong>
          {!ledger
            ? '旧快照 · 恢复时重新校验'
            : ledger.valid
              ? `${ledger.mode === 'sealed' ? '已封链' : ledger.mode === 'legacy' ? 'legacy' : '空账本'}${ledger.headDigest ? ` · ${shortId(ledger.headDigest)}` : ''}`
              : `校验失败 · ${ledger.error ?? '未知错误'}`}
        </strong>
        <span>服务端上下文</span>
        <strong>
          {context
            ? `${context.providerId} / ${context.model} · 第 ${context.generation} 代`
            : '无可安全复用的服务端游标'}
        </strong>
        <span>Checkpoint</span>
        <strong>{checkpoint ? shortId(checkpoint) : '无'}</strong>
        <span>外部效果</span>
        <strong>{confirmed} 已确认 · {pending} 待收敛</strong>
      </div>
      {effects.length > 0 && (
        <details className="task-recovery-effect-ledger">
          <summary>Effect 账本 ({effects.length})</summary>
          <ul>
            {effects.slice(-8).map((effect) => {
              const evidence = effect.evidence[effect.evidence.length - 1]
              return (
                <li key={effect.id}>
                  <strong>{effect.toolName} · {effect.status}</strong>
                  <span>
                    第 {effect.generation} 代
                    {effect.lease ? ` · lease ${shortId(effect.lease.id)} / fence ${effect.lease.fencingToken}` : ' · 无活动 lease'}
                  </span>
                  <span>
                    {evidence
                      ? `evidence ${evidence.kind} · ${shortId(evidence.digest)}`
                      : '无 evidence'}
                  </span>
                </li>
              )
            })}
          </ul>
        </details>
      )}
    </div>
  )
}

function RecoveryTimeline({ snapshot }: { snapshot: TaskSnapshotRecord }): React.JSX.Element | null {
  const entries = snapshot.transcript
    .filter((entry) => ledgerEventLabel(entry.event) !== null)
    .slice(-10)
  if (entries.length === 0) return null
  return (
    <details className="task-recovery-timeline">
      <summary>最近事件 ({entries.length})</summary>
      <ol>
        {entries.map((entry) => (
          <li key={entry.eventId ?? `${entry.seq}-${entry.event.kind}`}>
            <div className="task-recovery-timeline-head">
              <strong>{ledgerEventLabel(entry.event)}</strong>
              <span>seq {entry.seq} · {formatTime(entry.occurredAt ?? snapshot.updatedAt)}</span>
            </div>
            {(entry.causationId || entry.correlationId) && (
              <div className="task-recovery-event-links">
                {entry.causationId && <span title={entry.causationId}>原因 {shortId(entry.causationId)}</span>}
                {entry.correlationId && <span title={entry.correlationId}>链路 {shortId(entry.correlationId)}</span>}
              </div>
            )}
          </li>
        ))}
      </ol>
    </details>
  )
}

function ledgerEventLabel(event: AgentEvent): string | null {
  const routingLabel = routingLedgerEventLabel(event)
  if (routingLabel) return routingLabel
  switch (event.kind) {
    case 'init': return `执行器恢复 · ${event.model || '默认模型'}`
    case 'status': return `状态 · ${event.status}${event.error ? ' · 错误' : ''}`
    case 'meta': return event.meta.responsesContext
      ? `服务端上下文 · 第 ${event.meta.responsesContext.generation} 代`
      : '会话元数据更新'
    case 'user-message': return '用户消息'
    case 'assistant-message': return event.blocks.some((block) => block.type === 'tool_use')
      ? '模型请求工具' : '模型回复'
    case 'tool-start': return `工具开始 · ${event.name}`
    case 'tool-result': return `工具${event.isError ? '失败' : '完成'} · ${shortId(event.toolUseId)}`
    case 'permission-request': return `等待审批 · ${event.request.toolName}`
    case 'permission-resolved': return `审批${event.behavior === 'allow' ? '允许' : '拒绝'}`
    case 'turn-result': return event.isError ? '本轮失败' : '本轮完成'
    case 'checkpoint': return `Checkpoint · ${shortId(event.messageId)}`
    case 'checkpoint-restore': return `恢复 Checkpoint · ${shortId(event.messageId)}`
    case 'hook-event': return event.event === 'context-compressed' ? '上下文压缩边界' : `运行事件 · ${event.event}`
    case 'subagent-result': return `子任务${event.status === 'done' ? '完成' : '失败'}`
    case 'task-dag-update': return 'DAG 状态更新'
    case 'text-delta':
    case 'thinking-delta': return null
    default: return null
  }
}

function routingLedgerEventLabel(event: AgentEvent): string | undefined {
  switch (event.kind) {
    case 'routing': return `路由 · ${event.providerName ?? event.providerId} / ${event.model}`
    case 'failover': return `Provider 切换 · ${event.fromName} → ${event.toName}`
    case 'provider-key-failover': return `Key 切换 · ${event.fromKeyLabel} → ${event.toKeyLabel}`
    case 'provider-model-failover': return `模型切换 · ${event.fromModel} → ${event.toModel}`
    case 'provider-protocol-failover': return `协议降级 · Responses → Chat Completions`
    case 'provider-recovery-exhausted': return `等待人工接管 · ${event.providerName} / ${event.model}`
    default: return undefined
  }
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}...` : value
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
