import {
  executeTaskDagAutoMergePatchEffect,
  replayTaskDagAutoMergePatchEffect,
  taskDagAutoMergePatchOperationId
} from '../ipc/worktree-operation-handlers'
import { executeInteractiveOperationEffect } from '../task/operation-effect-gateway'
import { transitionTaskDagFinalization } from '../agent/dag-finalization'
import {
  runTaskDagAutoMerge,
  type TaskDagAutoMergeProgress
} from './auto-merger'
import type {
  EffectStatus,
  TaskDagAutoMergeRollbackEntry,
  TaskDagAutoMergeView,
  TaskDagExecutionView,
  TaskDagFinalizationRecord
} from '../../shared/types'

export interface DagFinalizationAutoMergeAdapter {
  current(record: TaskDagFinalizationRecord): TaskDagFinalizationRecord
  persist(record: TaskDagFinalizationRecord, expectedRevision: number): Promise<TaskDagFinalizationRecord>
  emitRecoveryBlock(record: TaskDagFinalizationRecord): void
  projectIdForSession(sessionId: string): string | undefined
}

interface AutoMergeAttempt {
  record: TaskDagFinalizationRecord
  autoMerge?: TaskDagAutoMergeView
  waiting: boolean
}

interface RollbackPlanAttempt {
  entry: TaskDagAutoMergeRollbackEntry
  confirmed: boolean
  needsReconciliation: boolean
}

export async function applyTaskDagAutoMerge(
  record: TaskDagFinalizationRecord,
  adapter: DagFinalizationAutoMergeAdapter
): Promise<TaskDagFinalizationRecord> {
  const execution = record.terminalExecution
  if (!record.autoMergeOptions?.enabled) return settleDisabledAutoMerge(record, adapter)

  const attempt = execution.status === 'success'
    ? await runAutoMergeAttempt(record, adapter)
    : {
        record,
        autoMerge: skippedTaskDagAutoMerge('DAG 存在失败任务,自动合并已跳过。'),
        waiting: false
      }
  if (attempt.waiting) return attempt.record
  return settleAutoMergeResult(attempt.record, execution, attempt.autoMerge!, adapter)
}

export async function resumeTaskDagRollback(
  initial: TaskDagFinalizationRecord,
  adapter: DagFinalizationAutoMergeAdapter
): Promise<TaskDagFinalizationRecord> {
  let record = adapter.current(initial)
  const plans = record.rollbackPatches ?? []
  if (plans.length === 0 || !record.autoMergeResult) {
    return waitForReconciliation(
      record,
      'DAG autoMerge 回滚已启动，但缺少冻结的反向 patch 计划；已禁止自动重跑。',
      adapter
    )
  }

  const initialAutoMerge = record.autoMergeResult
  let entries = [...(initialAutoMerge.rollback?.entries ?? [])]
  for (const plan of plans) {
    const operationId = taskDagAutoMergePatchOperationId({ ...plan, direction: 'reverse' })
    const settled = settledRollbackEntry(entries, operationId)
    if (isConfirmedRollback(settled)) continue
    if (settled && settled.effectStatus !== 'confirmed') {
      return settleRollback(record, entries, false, adapter, settled.error)
    }

    const attempt = await executeRollbackPlan(plan, operationId, adapter)
    const entry = attempt.entry
    entries = replaceRollbackEntry(entries, operationId, entry)
    record = await persistRollbackProgress(record, initialAutoMerge, entries, plans, adapter)
    if (attempt.needsReconciliation) {
      return waitForReconciliation(
        record,
        entry.error ?? `Rollback Effect ${operationId} 尚未唯一收敛。`,
        adapter
      )
    }
    if (!attempt.confirmed) return settleRollback(record, entries, false, adapter, entry.error)
  }
  return settleRollback(record, entries, true, adapter)
}

export function projectUserConfirmedVerification(
  record: TaskDagFinalizationRecord,
  passed: boolean
): TaskDagAutoMergeView {
  const base = record.autoMergeResult
  if (!base) throw new Error('DAG verification 处置缺少已持久化的 forward merge receipts')
  const verification = {
    status: passed ? 'passed' as const : 'failed' as const,
    ...(record.verification.command ? { command: record.verification.command } : {}),
    ...(base.repoRoot ? { cwd: base.repoRoot } : {}),
    output: passed ? '用户确认验收命令已通过' : '用户确认验收命令已失败'
  }
  return {
    ...base,
    status: passed ? 'success' : 'running',
    ...(passed ? { completedAt: Date.now() } : {}),
    verification,
    summary: passed
      ? `自动合并: ${base.mergedCount} 已合并 / 验收: passed (manual)`
      : `自动合并: ${base.mergedCount} 已合并 / 验收: failed (manual)`
  }
}

export function skippedTaskDagAutoMerge(error: string): TaskDagAutoMergeView {
  const now = Date.now()
  return {
    enabled: true,
    status: 'failed',
    startedAt: now,
    completedAt: now,
    entries: [],
    mergedCount: 0,
    blockedCount: 0,
    skippedCount: 0,
    verification: { status: 'not-run', error },
    summary: error,
    error
  }
}

export function taskDagAutoMergeReconciliationError(
  autoMerge: TaskDagAutoMergeView
): string | undefined {
  return patchReceiptError(autoMerge) ?? rollbackReceiptError(autoMerge)
}

function settleDisabledAutoMerge(
  record: TaskDagFinalizationRecord,
  adapter: DagFinalizationAutoMergeAdapter
): Promise<TaskDagFinalizationRecord> {
  const settled = transitionTaskDagFinalization(record, 'merge_settled', {
    terminalExecution: record.terminalExecution,
    verification: { status: 'settled', result: { status: 'not-run', error: 'DAG autoMerge 未启用' } },
    error: undefined
  })
  return adapter.persist(settled, settled.revision - 1)
}

async function runAutoMergeAttempt(
  initial: TaskDagFinalizationRecord,
  adapter: DagFinalizationAutoMergeAdapter
): Promise<AutoMergeAttempt> {
  const execution = initial.terminalExecution
  let record = initial
  try {
    const autoMerge = await runTaskDagAutoMerge({
      execution,
      sessions: initial.mergeSessions,
      verificationCommand: initial.autoMergeOptions?.verificationCommand,
      replayPatch: (input) => replayTaskDagAutoMergePatchEffect({
        ...input,
        projectId: adapter.projectIdForSession(input.sourceSessionId)
      }),
      applyPatch: (input) => executeTaskDagAutoMergePatchEffect(
        { ...input, projectId: adapter.projectIdForSession(input.sourceSessionId) },
        executeInteractiveOperationEffect
      ),
      rollbackPatch: (input) => executeTaskDagAutoMergePatchEffect(
        {
          ...input,
          direction: 'reverse',
          projectId: adapter.projectIdForSession(input.sourceSessionId)
        },
        executeInteractiveOperationEffect
      ),
      onVerificationStart: async (command, startedAt, progress) => {
        record = await persistAutoMergeProgress(
          record,
          execution,
          progress,
          'verifying',
          { status: 'started', ...(command ? { command } : {}), startedAt },
          adapter
        )
      },
      onRollbackStart: async (progress) => {
        record = await persistAutoMergeProgress(
          record,
          execution,
          progress,
          'rollback_pending',
          { status: 'settled', result: progress.autoMerge.verification },
          adapter
        )
      }
    })
    return { record, autoMerge, waiting: false }
  } catch (error) {
    return handleAutoMergeInterruption(record, error, adapter)
  }
}

async function persistAutoMergeProgress(
  fallback: TaskDagFinalizationRecord,
  execution: TaskDagExecutionView,
  progress: TaskDagAutoMergeProgress,
  phase: 'verifying' | 'rollback_pending',
  verification: TaskDagFinalizationRecord['verification'],
  adapter: DagFinalizationAutoMergeAdapter
): Promise<TaskDagFinalizationRecord> {
  const current = adapter.current(fallback)
  const rollbackPatches = [...progress.appliedPatches].reverse()
  const transitioned = transitionTaskDagFinalization(current, phase, {
    autoMergeResult: progress.autoMerge,
    terminalExecution: { ...execution, autoMerge: progress.autoMerge },
    patchOperationIds: operationIds(progress.autoMerge.entries),
    rollbackOperationIds: rollbackPatches.map((input) =>
      taskDagAutoMergePatchOperationId({ ...input, direction: 'reverse' })
    ),
    rollbackPatches,
    verification,
    error: undefined
  })
  return adapter.persist(transitioned, transitioned.revision - 1)
}

async function handleAutoMergeInterruption(
  fallback: TaskDagFinalizationRecord,
  error: unknown,
  adapter: DagFinalizationAutoMergeAdapter
): Promise<AutoMergeAttempt> {
  const current = adapter.current(fallback)
  const message = error instanceof Error ? error.message : String(error)
  if (current.phase === 'verifying' || current.phase === 'rollback_pending') {
    const record = await waitForReconciliation(
      current,
      `DAG autoMerge ${current.phase} 阶段中断:${message}`,
      adapter
    )
    return { record, waiting: true }
  }
  if (current.phase === 'merging') throw error
  return {
    record: current,
    autoMerge: skippedTaskDagAutoMerge(`DAG 自动合并异常:${message}`),
    waiting: false
  }
}

async function settleAutoMergeResult(
  fallback: TaskDagFinalizationRecord,
  execution: TaskDagExecutionView,
  autoMerge: TaskDagAutoMergeView,
  adapter: DagFinalizationAutoMergeAdapter
): Promise<TaskDagFinalizationRecord> {
  const current = adapter.current(fallback)
  const patchOperationIds = operationIds(autoMerge.entries)
  const rollbackOperationIds = operationIds(autoMerge.rollback?.entries ?? [])
  const reconciliationError = taskDagAutoMergeReconciliationError(autoMerge)
  const phase = reconciliationError ? 'waiting_reconciliation' : 'merge_settled'
  const next = transitionTaskDagFinalization(current, phase, {
    autoMergeResult: autoMerge,
    terminalExecution: { ...execution, autoMerge },
    patchOperationIds,
    rollbackOperationIds,
    verification: { status: 'settled', result: autoMerge.verification },
    error: reconciliationError
  })
  const persisted = await adapter.persist(next, next.revision - 1)
  if (reconciliationError) adapter.emitRecoveryBlock(persisted)
  return persisted
}

async function executeRollbackPlan(
  plan: NonNullable<TaskDagFinalizationRecord['rollbackPatches']>[number],
  operationId: string,
  adapter: DagFinalizationAutoMergeAdapter
): Promise<RollbackPlanAttempt> {
  const result = await executeTaskDagAutoMergePatchEffect(
    {
      ...plan,
      direction: 'reverse',
      projectId: adapter.projectIdForSession(plan.sourceSessionId)
    },
    executeInteractiveOperationEffect
  )
  const confirmed = result.ok && result.effectStatus === 'confirmed' && result.operationId === operationId
  const error = 'error' in result
    ? result.error
    : `Rollback Effect 未确认:${result.effectStatus ?? 'missing'}`
  return {
    confirmed,
    needsReconciliation: !result.operationId ||
      result.operationId !== operationId ||
      !result.effectStatus ||
      isUnresolvedEffectStatus(result.effectStatus),
    entry: {
      taskId: plan.taskId,
      status: confirmed ? 'rolled-back' : 'failed',
      effectStatus: result.effectStatus,
      operationId: result.operationId ?? operationId,
      reconciliationRequired: result.reconciliationRequired,
      ...(!confirmed ? { error } : {})
    }
  }
}

function persistRollbackProgress(
  record: TaskDagFinalizationRecord,
  base: TaskDagAutoMergeView,
  entries: TaskDagAutoMergeRollbackEntry[],
  plans: NonNullable<TaskDagFinalizationRecord['rollbackPatches']>,
  adapter: DagFinalizationAutoMergeAdapter
): Promise<TaskDagFinalizationRecord> {
  const progress = projectDagRollbackAutoMerge(base, entries, 'running')
  const progressed = transitionTaskDagFinalization(record, 'rollback_pending', {
    autoMergeResult: progress,
    terminalExecution: { ...record.terminalExecution, autoMerge: progress },
    rollbackOperationIds: plans.map((plan) =>
      taskDagAutoMergePatchOperationId({ ...plan, direction: 'reverse' })
    ),
    rollbackPatches: plans,
    error: undefined
  })
  return adapter.persist(progressed, progressed.revision - 1)
}

function settleRollback(
  record: TaskDagFinalizationRecord,
  entries: TaskDagAutoMergeRollbackEntry[],
  ok: boolean,
  adapter: DagFinalizationAutoMergeAdapter,
  error?: string
): Promise<TaskDagFinalizationRecord> {
  const base = record.autoMergeResult
  if (!base) throw new Error('DAG rollback settlement 缺少 autoMergeResult')
  const autoMerge = projectDagRollbackAutoMerge(base, entries, ok ? 'settled' : 'failed', error)
  const settled = transitionTaskDagFinalization(record, 'merge_settled', {
    autoMergeResult: autoMerge,
    terminalExecution: { ...record.terminalExecution, autoMerge },
    verification: { status: 'settled', result: autoMerge.verification },
    error: undefined
  })
  return adapter.persist(settled, settled.revision - 1)
}

function projectDagRollbackAutoMerge(
  base: TaskDagAutoMergeView,
  rollbackEntries: TaskDagAutoMergeRollbackEntry[],
  state: 'running' | 'settled' | 'failed',
  error?: string
): TaskDagAutoMergeView {
  const rolledBackTaskIds = new Set(
    rollbackEntries.filter((entry) => entry.status === 'rolled-back').map((entry) => entry.taskId)
  )
  const entries = base.entries.map((entry) =>
    entry.status === 'merged' && rolledBackTaskIds.has(entry.taskId)
      ? { ...entry, status: 'rolled-back' as const }
      : entry
  )
  const rollbackOk = state === 'settled' && rollbackEntries.every((entry) => entry.status === 'rolled-back')
  return {
    ...base,
    status: state === 'running' ? 'running' : rollbackOk ? 'rolled-back' : 'failed',
    ...(state === 'running' ? {} : { completedAt: Date.now() }),
    entries,
    mergedCount: entries.filter((entry) => entry.status === 'merged').length,
    blockedCount: entries.filter((entry) => entry.status === 'blocked').length,
    skippedCount: entries.filter((entry) => entry.status === 'skipped').length,
    rollback: {
      attempted: true,
      ok: rollbackOk,
      entries: rollbackEntries.map((entry) => ({ ...entry })),
      ...(rollbackOk ? {} : { error: error ?? 'DAG autoMerge 回滚未完全成功' })
    },
    summary: rollbackSummary(state, rollbackOk),
    ...(rollbackOk
      ? { error: undefined }
      : state === 'running'
        ? {}
        : { error: error ?? 'DAG autoMerge 回滚未完全成功' })
  }
}

async function waitForReconciliation(
  record: TaskDagFinalizationRecord,
  error: string,
  adapter: DagFinalizationAutoMergeAdapter
): Promise<TaskDagFinalizationRecord> {
  const waiting = transitionTaskDagFinalization(record, 'waiting_reconciliation', { error })
  const persisted = await adapter.persist(waiting, waiting.revision - 1)
  adapter.emitRecoveryBlock(persisted)
  return persisted
}

function settledRollbackEntry(
  entries: TaskDagAutoMergeRollbackEntry[],
  operationId: string
): TaskDagAutoMergeRollbackEntry | undefined {
  return entries.find((entry) =>
    entry.operationId === operationId && isSettledEffectStatus(entry.effectStatus)
  )
}

function isSettledEffectStatus(status: EffectStatus | undefined): boolean {
  return status === 'confirmed' || status === 'failed' || status === 'abandoned'
}

function isConfirmedRollback(entry: TaskDagAutoMergeRollbackEntry | undefined): boolean {
  return Boolean(
    entry?.status === 'rolled-back' &&
    entry.effectStatus === 'confirmed' &&
    !entry.reconciliationRequired
  )
}

function replaceRollbackEntry(
  entries: TaskDagAutoMergeRollbackEntry[],
  operationId: string,
  entry: TaskDagAutoMergeRollbackEntry
): TaskDagAutoMergeRollbackEntry[] {
  return [...entries.filter((candidate) => candidate.operationId !== operationId), entry]
}

function operationIds(entries: ReadonlyArray<{ operationId?: string }>): string[] {
  return entries.map((entry) => entry.operationId).filter((id): id is string => Boolean(id))
}

function isUnresolvedEffectStatus(status: EffectStatus | undefined): boolean {
  return status === undefined ||
    status === 'prepared' ||
    status === 'executing' ||
    status === 'waiting_reconciliation'
}

function patchReceiptError(autoMerge: TaskDagAutoMergeView): string | undefined {
  const missing = autoMerge.entries.find((entry) =>
    (entry.status === 'merged' || entry.status === 'rolled-back') &&
    (!entry.operationId || entry.effectStatus !== 'confirmed')
  )
  if (missing) return `DAG patch 缺少 confirmed operation receipt:${missing.taskId}`
  const inconsistent = autoMerge.entries.find((entry) => entry.reconciliationRequired)
  if (inconsistent) return `DAG patch receipt 与当前目标对账不一致:${inconsistent.taskId}`
  const unresolved = autoMerge.entries.find((entry) =>
    entry.status === 'failed' && Boolean(entry.patchSha256) && isUnresolvedEffectStatus(entry.effectStatus)
  )
  return unresolved
    ? `DAG patch Effect 尚未唯一收敛:${unresolved.taskId}/${unresolved.effectStatus ?? 'missing'}`
    : undefined
}

function rollbackReceiptError(autoMerge: TaskDagAutoMergeView): string | undefined {
  const entries = autoMerge.rollback?.entries ?? []
  const unresolved = entries.find((entry) =>
    entry.status === 'failed' && isUnresolvedEffectStatus(entry.effectStatus)
  )
  if (unresolved) {
    return `DAG rollback Effect 尚未唯一收敛:${unresolved.taskId}/${unresolved.effectStatus ?? 'missing'}`
  }
  const inconsistent = entries.find((entry) => entry.reconciliationRequired)
  if (inconsistent) return `DAG rollback receipt 与当前目标对账不一致:${inconsistent.taskId}`
  const missing = entries.find((entry) =>
    entry.status === 'rolled-back' && (!entry.operationId || entry.effectStatus !== 'confirmed')
  )
  if (missing) return `DAG rollback 缺少 confirmed operation receipt:${missing.taskId}`
  return autoMerge.rollback?.attempted && !autoMerge.rollback.ok && entries.length === 0
    ? 'DAG rollback 已启动但没有可验证的逐项 receipt。'
    : undefined
}

function rollbackSummary(state: 'running' | 'settled' | 'failed', rollbackOk: boolean): string {
  if (state === 'running') return 'DAG autoMerge 正在按冻结计划恢复回滚。'
  return rollbackOk
    ? '验收失败，已通过确认的反向 Effect 回滚全部已应用 patch。'
    : '验收失败，DAG autoMerge 回滚未完全成功。'
}
