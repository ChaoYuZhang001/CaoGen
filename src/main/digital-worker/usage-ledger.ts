import type { ModelAttemptRecord } from '../../shared/model-attempt-types'
import { monthKeyFor } from '../../shared/budget'
import { verifyModelAttemptLedger } from '../task/model-attempt-store'
import { readRawModelAttempts } from '../task/model-attempt-schema'
import { readTaskSnapshotDatabase } from '../task/task-snapshot'
import { readRuns } from '../task/workflow-ledger-query'
import { verifyWorkflowLedger } from '../task/workflow-ledger-store'

export type DigitalWorkerUsageLedgerErrorCode =
  | 'budget_untrackable'
  | 'policy_store_unavailable'

export class DigitalWorkerUsageLedgerError extends Error {
  readonly name = 'DigitalWorkerUsageLedgerError'

  constructor(readonly code: DigitalWorkerUsageLedgerErrorCode, message: string) {
    super(message)
  }
}

/**
 * Aggregate immutable ModelAttempt costs instead of deletable Session projections.
 * ModelAttempt verification binds every row to a canonical Workflow Run before its
 * frozen DigitalWorker identity is used for accounting.
 */
export function readDigitalWorkerMonthlySpend(
  rootDir: string,
  workerId: string,
  now = Date.now()
): Promise<number> {
  return readTaskSnapshotDatabase(rootDir, (db) => {
    try {
      verifyWorkflowLedger(db)
      verifyModelAttemptLedger(db)
      const runBindings = new Map(readRuns(db).map((run) => [run.id, run.taskRun.digitalWorkerBinding]))
      const monthKey = monthKeyFor(now)
      const attempts = readRawModelAttempts(db).filter((attempt) => {
        const binding = runBindings.get(attempt.runId)
        return binding?.kind === 'assigned' && binding.workerId === workerId
      })
      const total = attempts.reduce((sum, attempt) => sum + attemptCostForMonth(attempt, monthKey), 0)
      return roundUsd(total)
    } catch (error) {
      if (error instanceof DigitalWorkerUsageLedgerError) throw error
      throw new DigitalWorkerUsageLedgerError(
        'policy_store_unavailable',
        `数字员工 ModelAttempt 用量账本不可用：${errorText(error)}`
      )
    }
  })
}

function attemptCostForMonth(attempt: ModelAttemptRecord, monthKey: string): number {
  if (monthKeyFor(attempt.startedAt) !== monthKey) return 0
  if (attempt.status === 'started') {
    throw new DigitalWorkerUsageLedgerError(
      'budget_untrackable',
      `ModelAttempt ${attempt.id} 结果未知，无法确认数字员工预算`
    )
  }
  if (attempt.completedAt === undefined) {
    throw new DigitalWorkerUsageLedgerError(
      'policy_store_unavailable',
      `ModelAttempt ${attempt.id} 缺少结算时间`
    )
  }
  if (attempt.costUsd !== undefined) return nonNegativeCost(attempt.costUsd, attempt.id)
  throw new DigitalWorkerUsageLedgerError(
    'budget_untrackable',
    `ModelAttempt ${attempt.id} 缺少可核验费用，无法确认数字员工预算`
  )
}

function nonNegativeCost(value: number, attemptId: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new DigitalWorkerUsageLedgerError(
      'policy_store_unavailable',
      `ModelAttempt ${attemptId} 的费用字段无效`
    )
  }
  return value
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
