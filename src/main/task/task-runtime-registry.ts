import type { TaskRunRecord, ToolExecutionRecord } from '../../shared/types'
import {
  buildToolIdempotencyKey,
  requiresDuplicateConfirmation
} from './tool-idempotency'

export type ToolIdempotencyDecision =
  | { kind: 'neutral'; idempotencyKey?: string }
  | {
      kind: 'deny' | 'ask'
      idempotencyKey: string
      duplicateExecutionId: string
      reason: string
    }

class TaskRuntimeRegistry {
  private readonly runs = new Map<string, TaskRunRecord>()
  private readonly archivedExecutions = new Map<string, ToolExecutionRecord[]>()

  get(sessionId: string): TaskRunRecord | undefined {
    return this.runs.get(sessionId)
  }

  set(sessionId: string, run: TaskRunRecord): void {
    const previous = this.runs.get(sessionId)
    if (previous && previous.id !== run.id && (previous.toolExecutions?.length ?? 0) > 0) {
      const archived = dedupeExecutions([
        ...(this.archivedExecutions.get(sessionId) ?? []),
        ...(previous.toolExecutions ?? [])
      ])
      this.archivedExecutions.set(sessionId, archived.slice(-100))
    }
    this.runs.set(sessionId, run)
  }

  delete(sessionId: string): boolean {
    this.archivedExecutions.delete(sessionId)
    return this.runs.delete(sessionId)
  }

  clear(): void {
    this.runs.clear()
    this.archivedExecutions.clear()
  }

  hydrateHistory(runs: TaskRunRecord[]): void {
    const bySession = new Map<string, ToolExecutionRecord[]>()
    for (const run of runs) {
      if (!run.toolExecutions?.length) continue
      const current = bySession.get(run.sessionId) ?? []
      current.push(...run.toolExecutions)
      bySession.set(run.sessionId, current)
    }
    for (const [sessionId, executions] of bySession) {
      const merged = dedupeExecutions([
        ...(this.archivedExecutions.get(sessionId) ?? []),
        ...executions
      ])
      this.archivedExecutions.set(sessionId, merged.slice(-100))
    }
  }

  supersedeArchivedExecution(
    sessionId: string,
    executionId: string,
    replacementExecutionId: string,
    now = Date.now()
  ): boolean {
    let changed = false
    const archived = (this.archivedExecutions.get(sessionId) ?? []).map((execution) => {
      if (execution.id !== executionId || execution.status !== 'unknown_outcome') return execution
      changed = true
      return {
        ...execution,
        status: 'superseded' as const,
        supersededByExecutionId: replacementExecutionId,
        updatedAt: now,
        finishedAt: now,
        error: '未知结果已由用户确认后的成功重试取代'
      }
    })
    if (changed) this.archivedExecutions.set(sessionId, archived)
    return changed
  }

  evaluateTool(input: {
    sessionId: string
    cwd: string
    toolName: string
    toolInput: unknown
    toolUseId?: string
  }): ToolIdempotencyDecision {
    const run = this.runs.get(input.sessionId)
    if (!run) return { kind: 'neutral' }
    const idempotencyKey = buildToolIdempotencyKey({
      scopeId: run.sessionId,
      cwd: input.cwd,
      toolName: input.toolName,
      toolInput: input.toolInput
    })
    if (!idempotencyKey) return { kind: 'neutral' }
    const duplicates = dedupeExecutions([
      ...(this.archivedExecutions.get(input.sessionId) ?? []),
      ...(run.toolExecutions ?? [])
    ]).filter(
      (execution) =>
        execution.idempotencyKey === idempotencyKey &&
        (execution.toolUseId !== input.toolUseId || execution.status === 'unknown_outcome' || execution.status === 'succeeded')
    )
    const active = latestWithStatus(duplicates, ['requested', 'running', 'waiting_approval', 'approved'])
    if (active) {
      return {
        kind: 'deny',
        idempotencyKey,
        duplicateExecutionId: active.id,
        reason: `相同工具操作仍在执行或等待审批(${active.toolName})，已阻止并发重复执行。`
      }
    }
    const succeeded = latestWithStatus(duplicates, ['succeeded'])
    const unknown = latestWithStatus(
      duplicates.filter((execution) => !succeeded || execution.updatedAt > succeeded.updatedAt),
      ['unknown_outcome']
    )
    if (unknown) {
      return {
        kind: 'ask',
        idempotencyKey,
        duplicateExecutionId: unknown.id,
        reason: `相同工具操作在上次退出时结果未知(${unknown.toolName})，必须先核对实际状态；确认后才可重新执行。`
      }
    }
    if (succeeded && requiresDuplicateConfirmation(input.toolName, input.toolInput)) {
      return {
        kind: 'ask',
        idempotencyKey,
        duplicateExecutionId: succeeded.id,
        reason: `相同高风险操作已经成功执行(${succeeded.toolName})，再次执行可能产生重复副作用。`
      }
    }
    return { kind: 'neutral', idempotencyKey }
  }
}

function dedupeExecutions(executions: ToolExecutionRecord[]): ToolExecutionRecord[] {
  const byId = new Map<string, ToolExecutionRecord>()
  for (const execution of executions) {
    const previous = byId.get(execution.id)
    if (!previous || execution.updatedAt >= previous.updatedAt) byId.set(execution.id, execution)
  }
  return [...byId.values()].sort((a, b) => a.updatedAt - b.updatedAt)
}

function latestWithStatus(
  executions: ToolExecutionRecord[],
  statuses: ToolExecutionRecord['status'][]
): ToolExecutionRecord | undefined {
  const allowed = new Set(statuses)
  return executions
    .filter((execution) => allowed.has(execution.status))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

export const taskRuntimeRegistry = new TaskRuntimeRegistry()
