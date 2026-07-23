import type { Engine } from '../engine'
import {
  buildTaskSnapshot,
  getTaskDagFinalization,
  getTaskSnapshot,
  listTaskDagFinalizations,
  listTaskRuns,
  listTaskSnapshots,
  saveTaskDagFinalizationBarrier
} from './task-snapshot'
import { isTaskRunTerminal } from './task-run'
import { taskRuntimeRegistry } from './task-runtime-registry'
import {
  buildTaskDagFinalizationSummaryForRecord,
  createTaskDagFinalizationRecord,
  findLegacyTaskDagFinalizationSummaryReceipt,
  findTaskDagFinalizationSummaryReceipt,
  isTaskDagFinalizationCompleted,
  isTaskDagFinalizationPending,
  isTaskDagFinalizationWaiting,
  taskDagFinalizationView,
  transitionTaskDagFinalization
} from '../agent/dag-finalization'
import {
  applyTaskDagAutoMerge,
  projectUserConfirmedVerification,
  resumeTaskDagRollback,
  skippedTaskDagAutoMerge,
  type DagFinalizationAutoMergeAdapter
} from '../git/auto-merge-finalization'
import type {
  AgentEvent,
  EffectRecord,
  EffectStatus,
  SendMessagePayload,
  TaskDagAutoMergeView,
  TaskDagExecutionView,
  TaskDagFinalizationRecord,
  TaskDagFinalizationResolution,
  TaskDagRuntimeAutoMergeOptions,
  TaskDagRuntimeMergeSession,
  TaskDagRuntimeSnapshot,
  TaskSnapshotRecord,
  TaskSnapshotSubtaskState
} from '../../shared/types'

interface DagSnapshotCursor {
  total: number
  lastSeq: number
  lastEventId?: string
}

export interface TaskDagFinalizationCoordinatorDependencies {
  sessions: ReadonlyMap<string, Engine>
  snapshotCursor(sessionId: string): DagSnapshotCursor | undefined
  snapshotSubtasks(sessionId: string): TaskSnapshotSubtaskState[]
  snapshotDagExecutions(sessionId: string): TaskDagExecutionView[]
  snapshotDagRuntimes(sessionId: string): TaskDagRuntimeSnapshot[]
  send(parentSessionId: string, payload: SendMessagePayload): boolean
  emitParentEvent(parentSessionId: string, event: AgentEvent): void
  updateExecution(parentSessionId: string, execution: TaskDagExecutionView, emit: boolean): void
  releaseScheduler(executionId: string): void
  cleanupExecution(executionId: string): void
  recoverParent(parentSessionId: string): Promise<unknown>
}

const SUMMARY_RECEIPT_PENDING = '父汇总消息尚未产生可验证 transcript receipt，保持待投递状态。'

export class TaskDagFinalizationCoordinator {
  private readonly records = new Map<string, TaskDagFinalizationRecord>()
  private readonly tasks = new Map<string, Promise<void>>()

  constructor(private readonly dependencies: TaskDagFinalizationCoordinatorDependencies) {}

  async load(): Promise<void> {
    for (const record of await listTaskDagFinalizations()) {
      this.dependencies.updateExecution(record.parentSessionId, this.project(record), false)
      if (isTaskDagFinalizationPending(record) || isTaskDagFinalizationWaiting(record)) {
        this.records.set(record.executionId, record)
      }
    }
  }

  async migrateLegacyRecords(): Promise<void> {
    const snapshots = await listTaskSnapshots()
    const known = new Set((await listTaskDagFinalizations()).map((record) => record.executionId))
    for (const snapshot of snapshots) {
      for (const execution of snapshot.dagExecutions) {
        if (!isMigratableLegacyExecution(execution, known)) continue
        const runtime = (snapshot.dagRuntimes ?? []).find((candidate) => candidate.executionId === execution.id)
        const record = createTaskDagFinalizationRecord({
          terminalExecution: execution,
          autoMergeOptions: runtime?.autoMerge,
          mergeSessions: runtime?.mergeSessions
        })
        try {
          const legacyReceipt = findLegacyTaskDagFinalizationSummaryReceipt(
            snapshot.transcript,
            record.summary!,
            execution.completedAt
          )
          const migrated = legacyReceipt
            ? completedLegacyFinalization(record, legacyReceipt)
            : record
          await this.persist(migrated, 0)
          if (legacyReceipt) this.cleanup(execution.id)
          known.add(execution.id)
        } catch (error) {
          console.error('[caogen] legacy terminal DAG finalizer migration failed:', error)
        }
      }
    }
  }

  finish(
    execution: TaskDagExecutionView,
    autoMergeOptions: TaskDagRuntimeAutoMergeOptions | undefined,
    mergeSessions: TaskDagRuntimeMergeSession[]
  ): Promise<void> {
    return this.serialize(execution.id, async () => {
      let record = this.records.get(execution.id)
      if (!record) {
        record = createTaskDagFinalizationRecord({ terminalExecution: execution, autoMergeOptions, mergeSessions })
        record = await this.persist(record, 0)
        this.dependencies.releaseScheduler(execution.id)
      }
      await this.resume(record)
    })
  }

  async restoreTerminalExecution(
    execution: TaskDagExecutionView,
    autoMergeOptions: TaskDagRuntimeAutoMergeOptions | undefined,
    mergeSessions: TaskDagRuntimeMergeSession[] | undefined
  ): Promise<void> {
    const existing = await getTaskDagFinalization(execution.id)
    if (!existing) {
      const record = createTaskDagFinalizationRecord({ terminalExecution: execution, autoMergeOptions, mergeSessions })
      await this.persist(record, 0)
      return
    }
    if (isTaskDagFinalizationCompleted(existing)) return
    this.records.set(existing.executionId, existing)
    this.dependencies.updateExecution(existing.parentSessionId, this.project(existing), false)
  }

  hasIncomplete(parentSessionId: string): boolean {
    for (const record of this.records.values()) {
      if (record.parentSessionId === parentSessionId && !isTaskDagFinalizationCompleted(record)) return true
    }
    return false
  }

  waitingForParent(parentSessionId: string): TaskDagFinalizationRecord | undefined {
    return [...this.records.values()].find(
      (record) => record.parentSessionId === parentSessionId && isTaskDagFinalizationWaiting(record)
    )
  }

  notifyRecoveryBlock(record: TaskDagFinalizationRecord): void {
    this.emitRecoveryBlock(record)
  }

  async resumeForParent(parentSessionId: string): Promise<boolean> {
    const records = [...this.records.values()].filter(
      (record) => record.parentSessionId === parentSessionId && !isTaskDagFinalizationCompleted(record)
    )
    for (const record of records) {
      await this.serialize(record.executionId, () => this.resumeCurrent(record))
    }
    return records.length > 0
  }

  async autoRecoverParents(snapshots: readonly TaskSnapshotRecord[]): Promise<void> {
    const snapshotIds = new Set(snapshots.map((snapshot) => snapshot.sessionId))
    const parentSessionIds = new Set(
      [...this.records.values()]
        .filter((record) => !isTaskDagFinalizationCompleted(record))
        .map((record) => record.parentSessionId)
    )
    for (const parentSessionId of parentSessionIds) {
      if (this.dependencies.sessions.has(parentSessionId) || !snapshotIds.has(parentSessionId)) continue
      try {
        await this.dependencies.recoverParent(parentSessionId)
      } catch (error) {
        console.error('[caogen] DAG finalizer parent auto-recovery failed:', error)
      }
    }
  }

  async resumeForOperation(operationId: string): Promise<void> {
    const effect = await taskDagOperationEffect(operationId)
    if (!effect || isUnresolvedEffectStatus(effect.status)) return
    const records = [...this.records.values()].filter((record) =>
      isTaskDagFinalizationWaiting(record) && operationBelongsToRecord(record, operationId)
    )
    for (const record of records) {
      await this.serialize(record.executionId, () => this.resumeSettledOperation(record, operationId, effect))
    }
  }

  resolve(
    executionId: string,
    expectedRevision: number,
    resolution: TaskDagFinalizationResolution
  ): Promise<TaskDagFinalizationRecord> {
    return this.serialize(executionId, () =>
      this.resolveSerialized(executionId, expectedRevision, resolution)
    )
  }

  async flushPending(): Promise<void> {
    while (this.tasks.size > 0) {
      await Promise.allSettled([...new Set(this.tasks.values())])
    }
  }

  private async resumeCurrent(fallback: TaskDagFinalizationRecord): Promise<void> {
    const current = this.records.get(fallback.executionId)
    if (current) await this.resume(current)
  }

  private async resume(initial: TaskDagFinalizationRecord): Promise<void> {
    let record = this.current(initial)
    if (isTaskDagFinalizationCompleted(record)) return this.cleanup(record.executionId)
    if (record.phase === 'verifying') {
      await this.blockUnknownVerification(record)
      return
    }
    if (record.phase === 'rollback_pending') {
      record = await resumeTaskDagRollback(record, this.autoMergeAdapter())
      if (isTaskDagFinalizationWaiting(record)) return
    }
    if (isTaskDagFinalizationWaiting(record)) return
    if (record.phase === 'prepared') record = await this.transitionAndPersist(record, 'merging')
    if (record.phase === 'merging') {
      record = await applyTaskDagAutoMerge(record, this.autoMergeAdapter())
      if (isTaskDagFinalizationWaiting(record)) return
    }
    if (record.phase === 'merge_settled') {
      const summary = buildTaskDagFinalizationSummaryForRecord(record)
      record = await this.transitionAndPersist(record, 'summary_pending', { summary })
    }
    if (record.phase === 'summary_pending') record = await this.deliver(record)
    if (record.phase === 'summary_delivered') record = await this.transitionAndPersist(record, 'completed')
    if (isTaskDagFinalizationCompleted(record)) this.cleanup(record.executionId)
  }

  private async blockUnknownVerification(record: TaskDagFinalizationRecord): Promise<void> {
    const waiting = transitionTaskDagFinalization(record, 'waiting_reconciliation', {
      error: '验收命令在进程停止前已启动，结果未知；已禁止自动重跑。'
    })
    const persisted = await this.persist(waiting, waiting.revision - 1)
    this.emitRecoveryBlock(persisted)
  }

  private transitionAndPersist(
    record: TaskDagFinalizationRecord,
    phase: 'merging' | 'summary_pending' | 'completed',
    patch: { summary?: TaskDagFinalizationRecord['summary'] } = {}
  ): Promise<TaskDagFinalizationRecord> {
    const next = transitionTaskDagFinalization(record, phase, { ...patch, error: undefined })
    return this.persist(next, next.revision - 1)
  }

  private async resolveSerialized(
    executionId: string,
    expectedRevision: number,
    resolution: TaskDagFinalizationResolution
  ): Promise<TaskDagFinalizationRecord> {
    let record = this.records.get(executionId) ?? await getTaskDagFinalization(executionId)
    if (!record) throw new Error(`未找到 DAG finalizer:${executionId}`)
    if (record.revision !== expectedRevision) {
      throw new Error(`stale_revision: DAG finalizer 已从 ${expectedRevision} 更新到 ${record.revision}`)
    }
    record = await this.applyResolution(record, resolution)
    return await getTaskDagFinalization(executionId) ?? record
  }

  private applyResolution(
    record: TaskDagFinalizationRecord,
    resolution: TaskDagFinalizationResolution
  ): Promise<TaskDagFinalizationRecord> {
    if (resolution === 'summary_not_delivered') return this.retrySummary(record)
    if (resolution === 'finalization_abandoned') return this.abandon(record)
    return this.resolveVerification(record, resolution)
  }

  private async retrySummary(record: TaskDagFinalizationRecord): Promise<TaskDagFinalizationRecord> {
    if (record.phase !== 'summary_pending' || record.error !== SUMMARY_RECEIPT_PENDING) {
      throw new Error('当前 DAG finalizer 不处于可授权重试的 summary_pending 状态')
    }
    if (!this.canDeliver(record.parentSessionId)) {
      throw new Error('父会话当前不可接收 DAG 汇总，不能执行已授权重试')
    }
    const retry = transitionTaskDagFinalization(record, 'summary_pending', { error: undefined })
    const persisted = await this.persist(retry, retry.revision - 1)
    const attempted = await this.attemptDelivery(persisted, persisted.summary!)
    if (attempted.phase === 'summary_delivered') await this.resume(attempted)
    return attempted
  }

  private async abandon(record: TaskDagFinalizationRecord): Promise<TaskDagFinalizationRecord> {
    if (!isTaskDagFinalizationWaiting(record)) {
      throw new Error('只有 waiting_reconciliation DAG finalizer 可以停止自动处理')
    }
    const base = record.autoMergeResult ?? skippedTaskDagAutoMerge(record.error ?? 'DAG finalizer 已人工停止')
    const autoMerge: TaskDagAutoMergeView = {
      ...base,
      status: 'failed',
      completedAt: Date.now(),
      summary: '用户已停止 DAG finalizer 的自动处理；保留现有工作区与 Effect 证据。',
      error: record.error ?? base.error ?? 'DAG finalizer 已人工停止'
    }
    const settled = transitionTaskDagFinalization(record, 'merge_settled', {
      autoMergeResult: autoMerge,
      terminalExecution: { ...record.terminalExecution, autoMerge },
      verification: abandonedVerification(record),
      error: undefined
    })
    const persisted = await this.persist(settled, settled.revision - 1)
    await this.resume(persisted)
    return persisted
  }

  private async resolveVerification(
    record: TaskDagFinalizationRecord,
    resolution: Exclude<TaskDagFinalizationResolution, 'summary_not_delivered' | 'finalization_abandoned'>
  ): Promise<TaskDagFinalizationRecord> {
    if (!isTaskDagFinalizationWaiting(record) || record.verification.status !== 'started') {
      throw new Error('当前 DAG finalizer 不处于待确认的 verification 状态')
    }
    if (resolution === 'verification_not_started') {
      const merging = transitionTaskDagFinalization(record, 'merging', {
        verification: {
          status: 'not_started',
          ...(record.verification.command ? { command: record.verification.command } : {})
        },
        error: undefined
      })
      const persisted = await this.persist(merging, merging.revision - 1)
      await this.resume(persisted)
      return persisted
    }
    return this.settleManualVerification(record, resolution === 'verification_passed')
  }

  private async settleManualVerification(
    record: TaskDagFinalizationRecord,
    passed: boolean
  ): Promise<TaskDagFinalizationRecord> {
    const autoMerge = projectUserConfirmedVerification(record, passed)
    const phase = passed ? 'merge_settled' : 'rollback_pending'
    const settled = transitionTaskDagFinalization(record, phase, {
      autoMergeResult: autoMerge,
      terminalExecution: { ...record.terminalExecution, autoMerge },
      verification: { status: 'settled', result: autoMerge.verification },
      error: undefined
    })
    const persisted = await this.persist(settled, settled.revision - 1)
    await this.resume(persisted)
    return persisted
  }

  private async resumeSettledOperation(
    fallback: TaskDagFinalizationRecord,
    operationId: string,
    effect: EffectRecord
  ): Promise<void> {
    const current = this.records.get(fallback.executionId)
    if (!current || !isTaskDagFinalizationWaiting(current)) return
    const phase = current.rollbackOperationIds.includes(operationId) ? 'rollback_pending' : 'merging'
    const autoMergeResult = projectSettledOperationReceipt(current, operationId, effect.status)
    const next = transitionTaskDagFinalization(current, phase, {
      ...(autoMergeResult
        ? {
            autoMergeResult,
            terminalExecution: { ...current.terminalExecution, autoMerge: autoMergeResult }
          }
        : {}),
      error: undefined
    })
    await this.resume(await this.persist(next, next.revision - 1))
  }

  private async deliver(record: TaskDagFinalizationRecord): Promise<TaskDagFinalizationRecord> {
    const summary = record.summary ?? buildTaskDagFinalizationSummaryForRecord(record)
    const receipt = await this.findReceipt(record, summary)
    if (receipt) return this.markDelivered(record, summary, receipt)
    if (summary.deliveryAttempts > 0) {
      if (record.error === SUMMARY_RECEIPT_PENDING) return record
      const blocked = transitionTaskDagFinalization(record, 'summary_pending', {
        summary,
        error: SUMMARY_RECEIPT_PENDING
      })
      const persisted = await this.persist(blocked, blocked.revision - 1)
      this.emitRecoveryBlock(persisted)
      return persisted
    }
    if (!this.canDeliver(record.parentSessionId)) return record
    return this.attemptDelivery(record, summary)
  }

  private async attemptDelivery(
    record: TaskDagFinalizationRecord,
    summary: NonNullable<TaskDagFinalizationRecord['summary']>
  ): Promise<TaskDagFinalizationRecord> {
    const attempted = transitionTaskDagFinalization(record, 'summary_pending', {
      summary: { ...summary, deliveryAttempts: summary.deliveryAttempts + 1, lastAttemptAt: Date.now() },
      error: undefined
    })
    const persisted = await this.persist(attempted, attempted.revision - 1)
    const sent = this.dependencies.send(record.parentSessionId, {
      text: attempted.summary!.text,
      messageId: attempted.summary!.messageId
    })
    const receipt = await this.findReceipt(persisted, attempted.summary!)
    if (sent && receipt) return this.markDelivered(persisted, attempted.summary!, receipt)

    const status = this.dependencies.sessions.get(record.parentSessionId)?.meta.status
    const error = !sent || status === 'error' || status === 'closed'
      ? '父会话拒绝 DAG 汇总消息，保持待投递状态。'
      : SUMMARY_RECEIPT_PENDING
    const pending = transitionTaskDagFinalization(persisted, 'summary_pending', { error })
    return this.persist(pending, pending.revision - 1)
  }

  private markDelivered(
    record: TaskDagFinalizationRecord,
    summary: NonNullable<TaskDagFinalizationRecord['summary']>,
    receipt: { eventId?: string; seq: number; occurredAt?: number }
  ): Promise<TaskDagFinalizationRecord> {
    const delivered = transitionTaskDagFinalization(record, 'summary_delivered', {
      summary: {
        ...summary,
        deliveredEventId: receipt.eventId,
        deliveredEventSeq: receipt.seq,
        deliveredAt: receipt.occurredAt ?? Date.now()
      },
      error: undefined
    })
    return this.persist(delivered, delivered.revision - 1)
  }

  private canDeliver(parentSessionId: string): boolean {
    const parent = this.dependencies.sessions.get(parentSessionId)
    if (!parent || parent.meta.status !== 'idle') return false
    const run = taskRuntimeRegistry.get(parentSessionId)
    return !run || isTaskRunTerminal(run.status)
  }

  private async findReceipt(
    record: TaskDagFinalizationRecord,
    summary: NonNullable<TaskDagFinalizationRecord['summary']>
  ) {
    const transcript = this.dependencies.sessions.get(record.parentSessionId)?.getTranscript() ?? []
    const snapshot = await getTaskSnapshot(record.parentSessionId)
    return findTaskDagFinalizationSummaryReceipt([...transcript, ...(snapshot?.transcript ?? [])], summary)
  }

  private async persist(
    record: TaskDagFinalizationRecord,
    expectedRevision: number
  ): Promise<TaskDagFinalizationRecord> {
    const execution = this.project(record)
    const snapshot = await this.snapshotForFinalization(record.parentSessionId, execution)
    const persisted = await saveTaskDagFinalizationBarrier(snapshot, record, { expectedRevision })
    this.records.set(record.executionId, persisted.finalization)
    this.dependencies.updateExecution(record.parentSessionId, execution, true)
    return persisted.finalization
  }

  private async snapshotForFinalization(
    parentSessionId: string,
    execution: TaskDagExecutionView
  ): Promise<TaskSnapshotRecord> {
    const session = this.dependencies.sessions.get(parentSessionId)
    if (!session) return this.storedSnapshotForFinalization(parentSessionId, execution)
    const cursor = this.dependencies.snapshotCursor(parentSessionId) ?? { total: 0, lastSeq: 0 }
    return buildTaskSnapshot({
      meta: session.meta,
      transcript: session.getTranscript(),
      lastSeq: cursor.lastSeq,
      lastEventId: cursor.lastEventId,
      lastEventKind: 'task-dag-update',
      eventCount: cursor.total,
      reason: 'important-event',
      run: taskRuntimeRegistry.get(parentSessionId),
      subtasks: this.dependencies.snapshotSubtasks(parentSessionId),
      dagExecutions: upsertExecution(this.dependencies.snapshotDagExecutions(parentSessionId), execution),
      dagRuntimes: this.dependencies.snapshotDagRuntimes(parentSessionId).filter(
        (runtime) => runtime.executionId !== execution.id
      )
    })
  }

  private async storedSnapshotForFinalization(
    parentSessionId: string,
    execution: TaskDagExecutionView
  ): Promise<TaskSnapshotRecord> {
    const stored = await getTaskSnapshot(parentSessionId)
    if (!stored) throw new Error(`DAG finalizer 缺少父任务恢复快照:${parentSessionId}`)
    return {
      ...stored,
      updatedAt: Date.now(),
      reason: 'important-event',
      dagExecutions: upsertExecution(stored.dagExecutions, execution),
      dagRuntimes: (stored.dagRuntimes ?? []).filter((runtime) => runtime.executionId !== execution.id)
    }
  }

  private project(record: TaskDagFinalizationRecord): TaskDagExecutionView {
    return {
      ...record.terminalExecution,
      ...(record.autoMergeResult ? { autoMerge: record.autoMergeResult } : {}),
      finalization: taskDagFinalizationView(record)
    }
  }

  private emitRecoveryBlock(record: TaskDagFinalizationRecord): void {
    const detail = record.error ?? 'DAG finalization 需要人工对账，已禁止自动重放未知副作用。'
    const event: AgentEvent = {
      kind: 'hook-event',
      event: 'task-dag-finalization-blocked',
      detail: `${record.executionId}: ${detail}`
    }
    const parent = this.dependencies.sessions.get(record.parentSessionId)
    if (parent?.emitSyntheticEvent) parent.emitSyntheticEvent(event)
    else if (parent) this.dependencies.emitParentEvent(record.parentSessionId, event)
    else console.error('[caogen] DAG finalization recovery blocked:', detail)
  }

  private autoMergeAdapter(): DagFinalizationAutoMergeAdapter {
    return {
      current: (record) => this.current(record),
      persist: (record, expectedRevision) => this.persist(record, expectedRevision),
      emitRecoveryBlock: (record) => this.emitRecoveryBlock(record),
      projectIdForSession: (sessionId) => this.dependencies.sessions.get(sessionId)?.meta.projectId
    }
  }

  private current(record: TaskDagFinalizationRecord): TaskDagFinalizationRecord {
    return this.records.get(record.executionId) ?? record
  }

  private cleanup(executionId: string): void {
    this.records.delete(executionId)
    this.dependencies.cleanupExecution(executionId)
  }

  private serialize<T>(executionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tasks.get(executionId) ?? Promise.resolve()
    const execution = previous.then(task, task)
    const released = execution.then(() => undefined, () => undefined)
    this.tasks.set(executionId, released)
    void released.finally(() => {
      if (this.tasks.get(executionId) === released) this.tasks.delete(executionId)
    })
    return execution
  }
}

async function taskDagOperationEffect(operationId: string): Promise<EffectRecord | undefined> {
  const scopeId = `operation:${operationId}`
  const run = (await listTaskRuns(scopeId)).find((candidate) => candidate.operation?.operationId === operationId)
  return [...(run?.effects ?? [])].sort(compareEffectRecencyDescending)[0]
}

/**
 * Date.now() is millisecond based, so a retry generation can legitimately
 * share updatedAt with the previous Effect. Prefer the durable generation and
 * revision fields before terminalAt, then use the id as a deterministic final
 * tie-breaker.
 */
function compareEffectRecencyDescending(left: EffectRecord, right: EffectRecord): number {
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
  if (left.generation !== right.generation) return right.generation - left.generation
  if (left.revision !== right.revision) return right.revision - left.revision
  const leftTerminalAt = left.terminalAt ?? Number.NEGATIVE_INFINITY
  const rightTerminalAt = right.terminalAt ?? Number.NEGATIVE_INFINITY
  if (leftTerminalAt !== rightTerminalAt) return rightTerminalAt - leftTerminalAt
  return right.id.localeCompare(left.id)
}

function operationBelongsToRecord(record: TaskDagFinalizationRecord, operationId: string): boolean {
  return record.patchOperationIds.includes(operationId) || record.rollbackOperationIds.includes(operationId)
}

function projectSettledOperationReceipt(
  record: TaskDagFinalizationRecord,
  operationId: string,
  effectStatus: EffectStatus
): TaskDagAutoMergeView | undefined {
  const autoMerge = record.autoMergeResult
  if (!autoMerge) return undefined
  const confirmed = effectStatus === 'confirmed'
  const entries = autoMerge.entries.map((entry) => {
    if (entry.operationId !== operationId) return entry
    return {
      ...entry,
      status: confirmed ? 'merged' as const : 'failed' as const,
      effectStatus: confirmed ? 'confirmed' as const : undefined,
      reconciliationRequired: undefined,
      error: undefined
    }
  })
  const rollbackEntries = autoMerge.rollback?.entries?.map((entry) => {
    if (entry.operationId !== operationId) return entry
    return {
      ...entry,
      status: confirmed ? 'rolled-back' as const : 'failed' as const,
      effectStatus: confirmed ? 'confirmed' as const : undefined,
      reconciliationRequired: undefined,
      error: undefined
    }
  })
  return {
    ...autoMerge,
    status: 'running',
    completedAt: undefined,
    entries,
    ...(autoMerge.rollback
      ? { rollback: { ...autoMerge.rollback, ok: false, entries: rollbackEntries } }
      : {}),
    error: undefined
  }
}

function isUnresolvedEffectStatus(status: EffectStatus): boolean {
  return status === 'prepared' || status === 'executing' || status === 'waiting_reconciliation'
}

function isMigratableLegacyExecution(
  execution: TaskDagExecutionView,
  known: ReadonlySet<string>
): boolean {
  return !known.has(execution.id) &&
    execution.completedAt !== undefined &&
    (execution.status === 'success' || execution.status === 'failed')
}

function completedLegacyFinalization(
  record: TaskDagFinalizationRecord,
  receipt: { messageId: string; eventId?: string; seq: number; occurredAt?: number }
): TaskDagFinalizationRecord {
  const deliveredAt = receipt.occurredAt ?? Date.now()
  return {
    ...record,
    phase: 'completed',
    summary: {
      ...record.summary!,
      messageId: receipt.messageId,
      deliveryAttempts: 1,
      lastAttemptAt: deliveredAt,
      ...(receipt.eventId ? { deliveredEventId: receipt.eventId } : {}),
      deliveredEventSeq: receipt.seq,
      deliveredAt
    },
    error: undefined,
    updatedAt: Math.max(record.updatedAt, deliveredAt)
  }
}

function abandonedVerification(
  record: TaskDagFinalizationRecord
): TaskDagFinalizationRecord['verification'] {
  if (record.verification.status !== 'started') return record.verification
  return {
    status: 'settled',
    result: {
      status: 'not-run',
      ...(record.verification.command ? { command: record.verification.command } : {}),
      error: '用户停止自动处理，验收结果未声明'
    }
  }
}

function upsertExecution(
  executions: readonly TaskDagExecutionView[],
  execution: TaskDagExecutionView
): TaskDagExecutionView[] {
  return [...executions.filter((candidate) => candidate.id !== execution.id), execution]
}
