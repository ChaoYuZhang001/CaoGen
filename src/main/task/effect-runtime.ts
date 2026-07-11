import { randomUUID } from 'node:crypto'
import type { EffectRecord, TaskRunRecord, TaskSnapshotRecord } from '../../shared/types'
import {
  abandonPreparedEffect,
  applyEffectReconciliation,
  completeEffect,
  hasUnresolvedEffects,
  hasWaitingReconciliation,
  manuallyResolveEffect,
  markEffectExecuting,
  prepareEffect,
  type EffectExecutionHandle
} from './effect-ledger'
import { buildEffectDescriptor, reconcileEffect } from './effect-reconciler'
import { getTaskSnapshot, saveTaskRunBarrier, saveTaskSnapshot } from './task-snapshot'
import { taskRuntimeRegistry } from './task-runtime-registry'
import { isTaskRunTerminal, transitionTaskRun } from './task-run'
import { isSideEffectingTool, stableValueDigest } from './tool-idempotency'

const PROCESS_OWNER_ID = `caogen:${process.pid}:${randomUUID()}`
const sessionQueues = new Map<string, Promise<unknown>>()

export interface PrepareEffectExecutionInput {
  sessionId: string
  cwd: string
  toolUseId: string
  toolName: string
  toolInput: Record<string, unknown>
}

export interface CompleteEffectExecutionInput {
  ok: boolean
  output: string
}

export async function prepareEffectExecution(
  input: PrepareEffectExecutionInput
): Promise<EffectExecutionHandle | null> {
  if (!isSideEffectingTool(input.toolName)) return null
  return withSessionQueue(input.sessionId, async () => {
    const run = requireRun(input.sessionId)
    const descriptor = await buildEffectDescriptor({
      toolName: input.toolName,
      toolInput: input.toolInput,
      cwd: input.cwd
    })
    const prepared = prepareEffect(run, {
      sessionId: input.sessionId,
      cwd: input.cwd,
      toolUseId: input.toolUseId,
      toolName: input.toolName,
      descriptor,
      ownerId: PROCESS_OWNER_ID
    })
    if (!prepared.created) return prepared.handle
    const persisted = await persistRun(prepared.run, prepared.handle.effectId)
    return effectHandleFromRecord(requireEffect(persisted, prepared.handle.effectId))
  })
}

export async function markEffectExecutionStarted(
  handle: EffectExecutionHandle | null,
  input: PrepareEffectExecutionInput
): Promise<void> {
  if (!handle) return
  await withSessionQueueByHandle(handle, async (run) => {
    const effect = requireEffect(run, handle.effectId)
    let descriptor
    try {
      descriptor = await buildEffectDescriptor({
        toolName: input.toolName,
        toolInput: input.toolInput,
        cwd: input.cwd
      })
    } catch (error) {
      const reason = `执行前无法重新验证效果目标:${error instanceof Error ? error.message : String(error)}`
      const abandoned = abandonPreparedEffect(run, handle, reason)
      if (abandoned !== run) await persistRun(abandoned, handle.effectId)
      throw new Error(reason)
    }
    if (
      input.sessionId !== handle.sessionId ||
      input.toolUseId !== handle.toolUseId ||
      descriptor.targetDigest !== effect.targetDigest ||
      descriptor.intentDigest !== effect.intentDigest ||
      descriptor.inputDigest !== effect.inputDigest
    ) {
      const reason = '执行前目标或输入已变化，旧审批与效果意图失效；请基于当前状态重新审批'
      const abandoned = abandonPreparedEffect(run, handle, reason)
      if (abandoned !== run) await persistRun(abandoned, handle.effectId)
      throw new Error(reason)
    }
    const next = markEffectExecuting(run, handle)
    if (next !== run) await persistRun(next, handle.effectId)
  })
}

export async function completeEffectExecution(
  handle: EffectExecutionHandle | null,
  result: CompleteEffectExecutionInput
): Promise<EffectRecord | null> {
  if (!handle) return null
  return withSessionQueueByHandle(handle, async (run) => {
    const effect = requireEffect(run, handle.effectId)
    let next: TaskRunRecord
    if (effect.reconcilability === 'queryable') {
      const observed = completeEffect(
        run,
        handle,
        'waiting_reconciliation',
        stableValueDigest({ ok: result.ok, output: result.output }),
        result.ok
          ? '工具报告成功，正在验证目标后置条件'
          : '工具报告失败，正在查询目标是否已产生部分副作用'
      )
      const probed = await reconcileEffect(requireEffect(observed, effect.id))
      const reconciliation = result.ok && probed.kind === 'not_applied'
        ? {
            kind: 'unresolved' as const,
            evidenceDigest: stableValueDigest({
              effectId: effect.id,
              toolResultDigest: stableValueDigest(result),
              probeEvidenceDigest: probed.evidenceDigest,
              reason: 'successful_tool_missing_postcondition'
            }),
            verifier: 'effect-runtime-postcondition-v1',
            reason: '工具报告成功，但目标后置条件未出现；可能执行了不同效果，已禁止自动重试'
          }
        : probed
      next = applyEffectReconciliation(observed, effect.id, reconciliation)
    } else if (result.ok) {
      next = completeEffect(
        run,
        handle,
        'confirmed',
        stableValueDigest({ ok: true, output: result.output }),
        '工具返回明确成功结果'
      )
    } else {
      next = completeEffect(
        run,
        handle,
        'waiting_reconciliation',
        stableValueDigest({ ok: false, output: result.output }),
        '不可查询工具返回失败，但可能已产生部分副作用，已按 fail-closed 等待人工对账'
      )
    }
    const persisted = await persistRun(next, handle.effectId)
    return requireEffect(persisted, handle.effectId)
  })
}

export async function cancelEffectExecution(
  handle: EffectExecutionHandle | null,
  reason: string
): Promise<void> {
  if (!handle) return
  await withSessionQueueByHandle(handle, async (run) => {
    const next = abandonPreparedEffect(run, handle, reason)
    if (next !== run) {
      await persistRun(next, handle.effectId)
    }
  })
}

async function reconcileStoppedTaskRunEffects(run: TaskRunRecord): Promise<TaskRunRecord> {
  let next = run
  const candidates = (run.effects ?? []).filter((effect) =>
    effect.status === 'prepared' ||
    effect.status === 'executing' ||
    effect.status === 'waiting_reconciliation'
  )
  for (const candidate of candidates) {
    const current = requireEffect(next, candidate.id)
    if (current.status === 'prepared') {
      const handle = effectHandleFromRecord(current)
      next = abandonPreparedEffect(next, handle, '原执行进程已停止，且效果尚未进入 executing；已确认外部执行未开始')
      continue
    }
    const probed = await reconcileEffect(current)
    const result = probed.kind === 'not_applied' && current.lease?.ownerId === PROCESS_OWNER_ID
      ? {
          kind: 'unresolved' as const,
          evidenceDigest: stableValueDigest({
            effectId: current.id,
            ownerId: current.lease.ownerId,
            probeEvidenceDigest: probed.evidenceDigest,
            reason: 'same_process_owner_not_stopped'
          }),
          verifier: 'effect-runtime-owner-fence-v1',
          reason: '效果仍由当前进程持有，尚无独立的执行器终止证据；已拒绝采信 not_applied 并禁止自动重试'
        }
      : probed
    next = applyEffectReconciliation(next, current.id, result)
  }
  return next
}

function effectHandleFromRecord(effect: EffectRecord): EffectExecutionHandle {
  if (!effect.lease) throw new Error(`EffectRecord 缺少 lease:${effect.id}`)
  return {
    sessionId: effect.sessionId,
    effectId: effect.id,
    effectKey: effect.effectKey,
    resourceKey: effect.resourceKey,
    leaseId: effect.lease.id,
    ownerId: effect.lease.ownerId,
    fencingToken: effect.lease.fencingToken,
    toolUseId: effect.toolUseId,
    target: effect.target,
    targetDigest: effect.targetDigest
  }
}

export async function reconcileTaskSnapshotEffects(
  snapshot: TaskSnapshotRecord,
  options: { processStopped: true }
): Promise<TaskSnapshotRecord> {
  if (options.processStopped !== true) throw new Error('外部效果只能在确认原执行进程已停止后对账')
  if (!snapshot.run?.effects?.length) return snapshot
  let run = await reconcileStoppedTaskRunEffects(snapshot.run)
  if (hasWaitingReconciliation(run) && !isTaskRunTerminal(run.status) && run.status !== 'waiting_reconciliation') {
    run = transitionTaskRun(run, 'waiting_reconciliation', {
      lastEventKind: snapshot.execution.lastEventKind
    })
  }
  return run === snapshot.run
    ? snapshot
    : { ...snapshot, updatedAt: Math.max(snapshot.updatedAt, run.updatedAt), run }
}

export async function reconcilePersistedTaskSnapshot(
  candidate: TaskSnapshotRecord
): Promise<TaskSnapshotRecord> {
  return withSessionQueue(candidate.sessionId, async () => {
    const stored = await getTaskSnapshot(candidate.id)
    const base = stored && compareSnapshotFreshness(stored, candidate) >= 0 ? stored : candidate
    const reconciled = await reconcileTaskSnapshotEffects(base, { processStopped: true })
    const persisted = reconciled === stored ? stored : await saveTaskSnapshot(reconciled)
    if (!persisted) throw new Error('任务快照在对账期间被删除')
    if (persisted.run) taskRuntimeRegistry.set(persisted.run.sessionId, persisted.run)
    return persisted
  })
}

export async function resolvePersistedTaskEffect(
  snapshotId: string,
  effectId: string,
  expectedRevision: number,
  resolution: 'confirmed_applied' | 'confirmed_not_applied'
): Promise<TaskSnapshotRecord> {
  return withSessionQueue(snapshotId, async () => {
    const snapshot = await getTaskSnapshot(snapshotId)
    if (!snapshot?.run) throw new Error('任务快照没有可处置的效果账本')
    const effect = snapshot.run.effects?.find((item) => item.id === effectId)
    if (!effect) throw new Error(`未找到 EffectRecord:${effectId}`)
    if (effect.revision !== expectedRevision) {
      throw new Error(`stale_revision: EffectRecord 已从 ${expectedRevision} 更新到 ${effect.revision}`)
    }
    const run = manuallyResolveEffect(snapshot.run, effectId, resolution)
    const persisted = await saveTaskSnapshot({ ...snapshot, updatedAt: Date.now(), run })
    taskRuntimeRegistry.set(run.sessionId, persisted.run ?? run)
    return persisted
  })
}

export function runHasWaitingEffects(run: TaskRunRecord | undefined): boolean {
  return hasWaitingReconciliation(run)
}

export function runHasUnresolvedEffects(run: TaskRunRecord | undefined): boolean {
  return hasUnresolvedEffects(run)
}

async function withSessionQueueByHandle<T>(
  handle: EffectExecutionHandle,
  task: (run: TaskRunRecord) => Promise<T>
): Promise<T> {
  return withSessionQueue(handle.sessionId, () => task(requireRun(handle.sessionId)))
}

async function persistRun(run: TaskRunRecord, requiredEffectId?: string): Promise<TaskRunRecord> {
  const persisted = await saveTaskRunBarrier(run)
  if (requiredEffectId) {
    const expected = run.effects?.find((effect) => effect.id === requiredEffectId)
    const stored = persisted.effects?.find((effect) => effect.id === requiredEffectId)
    if (!expected || !stored || stored.revision < expected.revision) {
      throw new Error('效果记录未以预期 revision 跨过持久化屏障，已阻止外部执行')
    }
  }
  taskRuntimeRegistry.set(persisted.sessionId, persisted)
  return persisted
}

function requireRun(sessionId: string): TaskRunRecord {
  const run = taskRuntimeRegistry.get(sessionId)
  if (!run) throw new Error('当前会话没有 TaskRun，已按 fail-closed 阻止外部副作用')
  return run
}

function requireEffect(run: TaskRunRecord, effectId: string): EffectRecord {
  const effect = run.effects?.find((item) => item.id === effectId)
  if (!effect) throw new Error(`未找到 EffectRecord:${effectId}`)
  return effect
}

function withSessionQueue<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const previous = sessionQueues.get(sessionId) ?? Promise.resolve()
  const next = previous.then(task, task)
  const release = (): void => {
    if (sessionQueues.get(sessionId) === queued) sessionQueues.delete(sessionId)
  }
  const queued = next.then(release, release)
  sessionQueues.set(sessionId, queued)
  return next
}

function compareSnapshotFreshness(left: TaskSnapshotRecord, right: TaskSnapshotRecord): number {
  const leftSeq = left.execution.cursor?.seq ?? left.execution.lastSeq
  const rightSeq = right.execution.cursor?.seq ?? right.execution.lastSeq
  if (leftSeq !== rightSeq) return leftSeq - rightSeq
  const leftRevision = left.run?.revision ?? 0
  const rightRevision = right.run?.revision ?? 0
  if (leftRevision !== rightRevision) return leftRevision - rightRevision
  return left.updatedAt - right.updatedAt
}
