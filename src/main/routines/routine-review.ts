import type { AcceptanceResult, Goal, WorkItem } from '../../shared/project-workspace-types'
import type { RoutineRunRecord, RoutineRunReviewInput } from '../../shared/types'
import { openProjectWorkspaceCommandService } from '../project-workspace/command-service'
import { openProjectWorkspaceStore } from '../project-workspace/store'
import { listRoutineRuns, reviewRoutineRunRecord } from './routine-runner'

export async function reviewRoutineRun(
  routineRoot: string,
  workspaceRoot: string,
  runId: string,
  input: RoutineRunReviewInput
): Promise<RoutineRunRecord | null> {
  const id = requiredText(runId, 'runId', 240)
  const decision = input?.decision
  if (decision !== 'accept' && decision !== 'reject') throw new Error('Routine review decision is invalid')
  const note = optionalText(input.note, 'note', 20_000)
  const record = (await listRoutineRuns(routineRoot)).find((run) => run.id === id)
  if (!record) return null
  const expectedDecision = decision === 'accept' ? 'accepted' : 'rejected'
  if (record.reviewDecision) {
    if (record.reviewDecision !== expectedDecision) throw new Error(`Routine Run ${id} was already reviewed`)
    return record
  }
  if (record.status !== 'succeeded' || record.inboxStatus !== 'needs_review') {
    throw new Error(`Routine Run ${id} is not ready for review`)
  }
  if (record.projectId && record.workItemId) {
    await applyCanonicalReview(workspaceRoot, record, decision)
  }
  return reviewRoutineRunRecord(routineRoot, id, expectedDecision, note)
}

async function applyCanonicalReview(
  workspaceRoot: string,
  record: RoutineRunRecord,
  decision: RoutineRunReviewInput['decision']
): Promise<void> {
  const store = await openProjectWorkspaceStore(workspaceRoot)
  const item = await store.getWorkItem(record.workItemId!)
  if (!item || item.projectId !== record.projectId || item.goalId !== record.goalId) {
    throw new Error(`Routine review WorkItem binding is invalid:${record.workItemId}`)
  }
  const commands = await openProjectWorkspaceCommandService(workspaceRoot)
  if (!record.evidenceId || !record.artifactId) {
    throw new Error(`Routine Run ${record.id} has no persisted Artifact/Evidence result`)
  }
  const evidenceRefs = [record.evidenceId]
  const acceptance: AcceptanceResult = {
    status: decision === 'accept' ? 'passed' : 'failed',
    evidenceRefs,
    verifiedBy: 'local-user',
    verifiedAt: Date.now()
  }
  await reviewWorkItem(commands, item, acceptance, decision)
  if (record.goalId) {
    const goal = await store.getGoal(record.goalId)
    if (!goal || goal.projectId !== record.projectId) {
      throw new Error(`Routine review Goal binding is invalid:${record.goalId}`)
    }
    await reviewGoal(commands, goal, acceptance, decision)
  }
}

async function reviewWorkItem(
  commands: Awaited<ReturnType<typeof openProjectWorkspaceCommandService>>,
  initial: WorkItem,
  acceptance: AcceptanceResult,
  decision: RoutineRunReviewInput['decision']
): Promise<void> {
  let item = initial
  if (item.status === 'done' || item.status === 'failed') return
  if (item.status !== 'verifying') throw new Error(`Routine WorkItem is not verifying:${item.id}:${item.status}`)
  item = await commands.setWorkItemAcceptance(item.id, acceptance, { expectedRevision: item.revision })
  await commands.transitionWorkItem(
    item.id,
    decision === 'accept' ? 'done' : 'failed',
    { expectedRevision: item.revision }
  )
}

async function reviewGoal(
  commands: Awaited<ReturnType<typeof openProjectWorkspaceCommandService>>,
  initial: Goal,
  acceptance: AcceptanceResult,
  decision: RoutineRunReviewInput['decision']
): Promise<void> {
  let goal = initial
  if (goal.status === 'completed' || goal.status === 'failed') return
  if (goal.status !== 'verifying') throw new Error(`Routine Goal is not verifying:${goal.id}:${goal.status}`)
  goal = await commands.setGoalAcceptance(goal.id, acceptance, { expectedRevision: goal.revision })
  await commands.transitionGoal(
    goal.id,
    decision === 'accept' ? 'completed' : 'failed',
    { expectedRevision: goal.revision }
  )
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} is required`)
  const clean = value.trim()
  if (!clean || clean.length > maxLength || /[\0\x08\x0b\x0c\x0e-\x1f\x7f]/.test(clean)) {
    throw new Error(`${label} is invalid`)
  }
  return clean
}

function optionalText(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return requiredText(value, label, maxLength)
}
