import { createHash } from 'node:crypto'
import type {
  DigitalWorker,
  DigitalWorkerPerformanceProfile
} from '../../shared/digital-worker-types'
import type { ModelAttemptRecord } from '../../shared/model-attempt-types'
import type { ProjectAggregateSnapshot } from '../../shared/project-aggregate-types'
import { createProductionProjectAggregateService } from '../project-aggregate/project-aggregate-factory'
import { queryPersistedModelAttempts } from '../task/model-attempt-api'
import { DigitalWorkerStore } from './domain-store'

export async function refreshDigitalWorkerPerformance(
  store: DigitalWorkerStore,
  rootDir: string,
  workerId: string
): Promise<DigitalWorker> {
  const worker = await store.getDigitalWorker(workerId)
  if (!worker) throw new Error(`DigitalWorker not found: ${workerId}`)
  if (worker.status === 'retired') throw new Error(`Retired DigitalWorker performance is immutable: ${workerId}`)
  const aggregate = await createProductionProjectAggregateService(rootDir).verifyLiveProject(worker.projectId)
  const attempts = await listProjectAttempts(worker.projectId, rootDir)
  const profile = buildDigitalWorkerPerformanceProfile(worker, aggregate, attempts)
  const previous = worker.performanceProfile
  if (previous && previous.sourceDigest === profile.sourceDigest) return worker
  return store.updateDigitalWorker(
    worker.id,
    { performanceProfile: profile },
    { expectedRevision: worker.revision }
  )
}

export function buildDigitalWorkerPerformanceProfile(
  worker: DigitalWorker,
  aggregate: ProjectAggregateSnapshot,
  attempts: readonly ModelAttemptRecord[],
  sampledAt = Date.now()
): DigitalWorkerPerformanceProfile {
  const runs = aggregate.workflow.runs.filter((run) => {
    const binding = run.taskRun.digitalWorkerBinding
    return binding?.kind === 'assigned' && binding.workerId === worker.id
  })
  const runIds = new Set(runs.map((run) => run.id))
  const acceptanceIds = new Set(
    runs.map((run) => run.acceptanceId).filter((id): id is string => Boolean(id))
  )
  const legacyAcceptanceWorkItemIds = new Set(
    runs.filter((run) => !run.acceptanceId).map((run) => run.workItemId)
  )
  const relevantAttempts = attempts.filter((attempt) => runIds.has(attempt.runId))
  const unpricedAttempts = relevantAttempts.filter((attempt) => attempt.costUsd === undefined).length
  const costCoverage = relevantAttempts.some((attempt) => attempt.status === 'started')
    ? 'untrackable' as const
    : unpricedAttempts > 0 ? 'partial' as const : 'complete' as const
  const acceptances = aggregate.workflow.acceptances.filter((acceptance) =>
    acceptanceIds.has(acceptance.id) ||
    Boolean(acceptance.workItemId && legacyAcceptanceWorkItemIds.has(acceptance.workItemId)))

  const completedRuns = runs.filter((run) => run.status === 'completed').length
  const failedRuns = runs.filter((run) => run.status === 'failed').length
  const terminalRuns = runs.filter((run) =>
    run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled')
  const decidedAcceptances = acceptances.filter((acceptance) =>
    acceptance.status === 'passed' || acceptance.status === 'failed')
  const acceptancePassed = decidedAcceptances.filter((acceptance) => acceptance.status === 'passed').length
  const workItemRunCounts = new Map<string, number>()
  for (const run of runs) workItemRunCounts.set(run.workItemId, (workItemRunCounts.get(run.workItemId) ?? 0) + 1)
  const reworkRuns = [...workItemRunCounts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0)
  const durations = runs
    .map((run) => run.startedAt === undefined || run.finishedAt === undefined
      ? undefined
      : Math.max(0, run.finishedAt - run.startedAt))
    .filter((duration): duration is number => duration !== undefined)
  const workItems = new Map(aggregate.workItems.map((workItem) => [workItem.id, workItem]))
  const dueDatedRuns = runs.filter((run) => run.finishedAt !== undefined && workItems.get(run.workItemId)?.dueAt !== undefined)
  const onTimeRuns = dueDatedRuns.filter((run) => run.finishedAt! <= workItems.get(run.workItemId)!.dueAt!).length
  const source = {
    workerId: worker.id,
    runs: runs
      .map((run) => [run.id, run.revision, run.status, run.startedAt, run.finishedAt])
      .sort(compareSourceRows),
    acceptances: acceptances
      .map((acceptance) => [acceptance.id, acceptance.revision, acceptance.status])
      .sort(compareSourceRows),
    attempts: relevantAttempts
      .map((attempt) => [attempt.id, attempt.revision, attempt.status, attempt.costUsd])
      .sort(compareSourceRows)
  }
  return {
    schemaVersion: 1,
    workerId: worker.id,
    projectId: worker.projectId,
    sampledAt,
    sourceDigest: createHash('sha256').update(JSON.stringify(source)).digest('hex'),
    totalRuns: runs.length,
    completedRuns,
    failedRuns,
    acceptanceDecisions: decidedAcceptances.length,
    acceptancePassed,
    acceptancePassRate: ratio(acceptancePassed, decidedAcceptances.length),
    reworkRuns,
    costUsd: round(relevantAttempts.reduce((total, attempt) => total + (attempt.costUsd ?? 0), 0), 6),
    averageDurationMs: durations.length === 0
      ? 0
      : Math.round(durations.reduce((total, duration) => total + duration, 0) / durations.length),
    onTimeRuns,
    dueDatedRuns: dueDatedRuns.length,
    onTimeRate: ratio(onTimeRuns, dueDatedRuns.length),
    reliability: ratio(completedRuns, terminalRuns.length),
    costCoverage,
    unpricedAttempts
  }
}

async function listProjectAttempts(projectId: string, rootDir: string): Promise<ModelAttemptRecord[]> {
  const attempts: ModelAttemptRecord[] = []
  let cursor: string | undefined
  do {
    const page = await queryPersistedModelAttempts(
      { projectId, limit: 500, ...(cursor ? { cursor } : {}) },
      rootDir
    )
    attempts.push(...page.attempts)
    cursor = page.nextCursor
  } while (cursor)
  return attempts
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator, 4)
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function compareSourceRows(left: readonly unknown[], right: readonly unknown[]): number {
  return String(left[0]).localeCompare(String(right[0]))
}
