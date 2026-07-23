import { dirname } from 'node:path'
import type { SessionMeta, TaskRunRecord, TaskSnapshotRecord } from '../../shared/types'
import type { WorkItem } from '../../shared/project-workspace-types'
import type { SupervisorRunRecord } from '../../shared/supervisor-types'
import {
  SupervisorStateError,
  SupervisorStateStore
} from './supervisor-state'
import {
  bindWorkflowRunToCanonicalWorkItem
} from './workflow-run-canonical-binding'

export type SupervisorTaskRunBindingDisposition =
  | 'unscoped'
  | 'canonical_only'
  | 'attached'
  | 'existing'

export interface SupervisorTaskRunBindingResult {
  disposition: SupervisorTaskRunBindingDisposition
  workItem?: WorkItem
  supervisorRun?: SupervisorRunRecord
}

export interface SupervisorTaskRunBridgeOptions {
  /** Root containing both the ProjectWorkspace aggregate and task snapshot DB. */
  rootDir?: string
  /** Reuse one durable Supervisor store when called from SessionManager. */
  store?: SupervisorStateStore
}

interface SupervisorBindingContext {
  rootDir?: string
  store?: SupervisorStateStore
}

interface SupervisorRunIdentity {
  id: string
  projectId: string
  goalId?: string
  workItemId: string
}

export interface SupervisorRunBindingRecoveryResult {
  attached: string[]
  existing: string[]
  unscoped: number
  failures: Array<{ runId: string; error: string }>
}

export type SupervisorRestartDisposition =
  | 'terminal'
  | 'waiting_reconciliation'
  | 'retryable'
  | 'manual_approval'
  | 'paused'
  | 'blocked'
  | 'failed_requires_authorization'
  | 'missing_task_run'

export interface SupervisorRestartClassification {
  disposition: SupervisorRestartDisposition
  reason: string
}

export interface SupervisorRestartClassificationInput {
  supervisor: Pick<SupervisorRunRecord, 'status'>
  taskRun?: TaskRunRecord
  /** A durable ModelAttempt reconciliation barrier blocks automatic replay. */
  hasModelAttemptBarrier?: boolean
}

/**
 * Bind one durable TaskRun to the rich WorkItem source and to a Supervisor row.
 *
 * The TaskRun/WorkflowRun identity is the single run key across all three
 * stores. The Supervisor store remains coordination metadata only; canonical
 * WorkItem mutation is delegated to its command boundary by the existing
 * binding helper.
 */
export async function ensureSupervisorRunBinding(
  meta: Pick<SessionMeta, 'id' | 'workspaceId' | 'goalId' | 'workItemId'>,
  run: TaskRunRecord,
  options: SupervisorTaskRunBridgeOptions = {}
): Promise<SupervisorTaskRunBindingResult> {
  assertTaskRunSessionOwnership(meta, run)
  const { rootDir, store } = resolveSupervisorBindingContext(options)
  const existingBeforeBinding = await getSupervisorRun(store, run.id)
  if (existingBeforeBinding) assertClaimedSupervisorIdentity(existingBeforeBinding, meta)
  const canonical = await bindWorkflowRunToCanonicalWorkItem(meta, run, rootDir)
  if (canonical.disposition === 'unscoped') return { disposition: 'unscoped' }

  // Callers that only need the historical canonical WorkItem binding (for
  // isolated/unit contexts without a Supervisor store) retain that behavior.
  const canonicalOnly = canonicalOnlyBinding(options, rootDir, canonical.workItem)
  if (canonicalOnly) return canonicalOnly

  if (!store) throw new Error('Supervisor Run binding requires rootDir or a Supervisor store')
  const input = supervisorRunIdentity(run.id, canonical.workItem)
  const supervisorRun = await createOrLoadSupervisorRun(store, input, existingBeforeBinding)

  // A pre-existing row is checked against SessionMeta before the canonical
  // mutation to avoid side effects on obvious ownership conflicts. The
  // canonical WorkItem may still supply an inferred Goal, so verify the full
  // immutable identity after resolving it as well.
  assertSupervisorRunIdentity(supervisorRun, input)

  const disposition: Extract<SupervisorTaskRunBindingDisposition, 'attached' | 'existing'> =
    canonical.disposition === 'attached' ? 'attached' : 'existing'
  return {
    disposition,
    workItem: canonical.workItem,
    supervisorRun
  }
}

function assertTaskRunSessionOwnership(
  meta: Pick<SessionMeta, 'id'>,
  run: TaskRunRecord
): void {
  if (run.sessionId !== meta.id) {
    throw new Error(`Supervisor Run ${run.id} crosses session ownership`)
  }
}

function resolveSupervisorBindingContext(options: SupervisorTaskRunBridgeOptions): SupervisorBindingContext {
  const rootDir = options.rootDir ?? (options.store ? dirname(options.store.filePath) : undefined)
  const store = options.store ?? (rootDir ? new SupervisorStateStore(rootDir) : undefined)
  return { rootDir, store }
}

async function getSupervisorRun(
  store: SupervisorStateStore | undefined,
  runId: string
): Promise<SupervisorRunRecord | undefined> {
  return store ? store.getRun(runId) : undefined
}

function canonicalOnlyBinding(
  options: SupervisorTaskRunBridgeOptions,
  rootDir: string | undefined,
  workItem: WorkItem
): SupervisorTaskRunBindingResult | undefined {
  if (options.store || rootDir) return undefined
  return { disposition: 'canonical_only', workItem }
}

function supervisorRunIdentity(runId: string, workItem: WorkItem): SupervisorRunIdentity {
  return {
    id: runId,
    projectId: workItem.projectId,
    ...(workItem.goalId === undefined ? {} : { goalId: workItem.goalId }),
    workItemId: workItem.id
  }
}

async function createOrLoadSupervisorRun(
  store: SupervisorStateStore,
  input: SupervisorRunIdentity,
  existingBeforeBinding: SupervisorRunRecord | undefined
): Promise<SupervisorRunRecord> {
  try {
    return existingBeforeBinding ?? await store.createRun(input, { actorId: 'supervisor-bridge' })
  } catch (error) {
    if (!(error instanceof SupervisorStateError) || error.code !== 'already_exists') throw error
    const existing = await store.getRun(input.id)
    if (!existing) {
      throw new Error(`Supervisor Run ${input.id} disappeared after already_exists`)
    }
    assertSupervisorRunIdentity(existing, input)
    return existing
  }
}

/**
 * Startup binding for every persisted snapshot. A single failure is returned
 * to the caller so SessionManager can keep the recovery surface fail-closed.
 */
export async function recoverSupervisorRunBindings(
  snapshots: readonly TaskSnapshotRecord[],
  options: SupervisorTaskRunBridgeOptions = {}
): Promise<SupervisorRunBindingRecoveryResult> {
  const result: SupervisorRunBindingRecoveryResult = {
    attached: [],
    existing: [],
    unscoped: 0,
    failures: []
  }
  for (const snapshot of snapshots) {
    if (!snapshot.run) continue
    try {
      const bound = await ensureSupervisorRunBinding(snapshot.meta, snapshot.run, options)
      if (bound.disposition === 'unscoped' || bound.disposition === 'canonical_only') {
        result.unscoped += 1
      } else {
        result[bound.disposition].push(snapshot.run.id)
      }
    } catch (error) {
      result.failures.push({
        runId: snapshot.run.id,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return result
}

/**
 * Classify a persisted Supervisor/TaskRun pair after a process restart.
 * Classification is deliberately pure: callers must perform any state
 * transition or user-authorized retry separately.
 */
export function classifySupervisorRestart(
  input: SupervisorRestartClassificationInput
): SupervisorRestartClassification {
  const { supervisor, taskRun } = input
  if (supervisor.status === 'completed' || supervisor.status === 'cancelled') {
    return { disposition: 'terminal', reason: `Supervisor is terminal: ${supervisor.status}` }
  }
  if (input.hasModelAttemptBarrier === true) {
    return {
      disposition: 'waiting_reconciliation',
      reason: 'ModelAttempt result is unknown; explicit reconciliation is required'
    }
  }
  if (supervisor.status === 'waiting_reconciliation') {
    return {
      disposition: 'waiting_reconciliation',
      reason: 'Supervisor is already waiting for reconciliation'
    }
  }
  if (!taskRun) {
    return {
      disposition: 'missing_task_run',
      reason: 'Supervisor Run has no matching durable TaskRun'
    }
  }
  if (hasUnresolvedTaskRunState(taskRun)) {
    return {
      disposition: 'waiting_reconciliation',
      reason: 'TaskRun contains an unresolved Effect or unknown tool outcome'
    }
  }
  if (taskRun.status === 'completed' || taskRun.status === 'cancelled') {
    return { disposition: 'terminal', reason: `TaskRun is terminal: ${taskRun.status}` }
  }
  if (taskRun.status === 'failed' || supervisor.status === 'failed') {
    return {
      disposition: 'failed_requires_authorization',
      reason: 'Retry requires an explicit authorization'
    }
  }
  if (supervisor.status === 'paused') {
    return { disposition: 'paused', reason: 'Supervisor was paused before restart' }
  }
  if (supervisor.status === 'blocked') {
    return { disposition: 'blocked', reason: 'Supervisor is blocked pending operator action' }
  }
  if (supervisor.status === 'waiting_approval' || taskRun.status === 'waiting_approval') {
    return { disposition: 'manual_approval', reason: 'Approval is pending and must be resolved explicitly' }
  }
  return {
    disposition: 'retryable',
    reason: `Non-terminal TaskRun can be resumed from ${taskRun.status}`
  }
}

function hasUnresolvedTaskRunState(run: TaskRunRecord): boolean {
  if (run.status === 'waiting_reconciliation') return true
  if ((run.effects ?? []).some((effect) =>
    effect.status === 'prepared' ||
    effect.status === 'executing' ||
    effect.status === 'waiting_reconciliation')) return true
  return (run.toolExecutions ?? []).some((execution) => execution.status === 'unknown_outcome')
}

function assertSupervisorRunIdentity(
  existing: SupervisorRunRecord,
  input: SupervisorRunIdentity
): void {
  if (
    existing.id !== input.id ||
    existing.projectId !== input.projectId ||
    existing.goalId !== input.goalId ||
    existing.workItemId !== input.workItemId
  ) {
    throw new Error(`Supervisor Run ${input.id} immutable canonical ownership changed`)
  }
}

function assertClaimedSupervisorIdentity(
  existing: SupervisorRunRecord,
  meta: Pick<SessionMeta, 'workspaceId' | 'goalId' | 'workItemId'>
): void {
  if (meta.workspaceId !== undefined && existing.projectId !== meta.workspaceId) {
    throw new Error(`Supervisor Run ${existing.id} immutable Workspace ownership changed`)
  }
  if (meta.goalId !== undefined && existing.goalId !== meta.goalId) {
    throw new Error(`Supervisor Run ${existing.id} immutable Goal ownership changed`)
  }
  if (meta.workItemId !== undefined && existing.workItemId !== meta.workItemId) {
    throw new Error(`Supervisor Run ${existing.id} immutable WorkItem ownership changed`)
  }
}
