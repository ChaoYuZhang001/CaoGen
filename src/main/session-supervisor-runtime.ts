import type { Engine } from './engine'
import { digitalWorkerSupervisorPolicyError } from './digital-worker/session-action-policy'
import { listTaskRuns as listPersistedTaskRuns, getTaskSnapshot } from './task/task-snapshot'
import { isTaskRunTerminal, transitionTaskRun } from './task/task-run'
import { recoverTaskExecutionState } from './task/task-execution'
import { runHasUnresolvedEffects } from './task/effect-runtime'
import {
  executeSupervisorSessionControl,
  type SupervisorSessionControlBinding,
  type SupervisorSessionControlRequest,
  type SupervisorSessionControlResult
} from './task/supervisor-session-control'
import {
  ensureSupervisorRunBinding,
  reserveSupervisorRunForSend
} from './task/supervisor-taskrun-bridge'
import { SupervisorStateError, SupervisorStateStore } from './task/supervisor-state'
import { buildTaskSnapshotReplayPrompts, canEnforceGoalCostBudget } from './session-manager-support'
import type { SupervisorRunRecord } from '../shared/supervisor-types'
import type {
  AgentEvent,
  TaskRunRecord,
  TaskSnapshotReason,
  TaskSnapshotRecord
} from '../shared/types'
import type { TaskSnapshotReplaySendOptions } from './task/task-snapshot-replay'

interface TaskRunRegistry {
  get(sessionId: string): TaskRunRecord | undefined
  set(sessionId: string, run: TaskRunRecord): void
}

type SnapshotWriter = (
  sessionId: string,
  reason: TaskSnapshotReason,
  seq: number,
  eventKind?: AgentEvent['kind'],
  eventId?: string,
  strict?: boolean
) => Promise<void>

export class SessionSupervisorRuntime {
  private readonly pauseIntents = new Set<string>()
  private readonly runSendGates = new Set<string>()
  private readonly sessionSendGates = new Set<string>()
  private stateStoreRoot = ''
  private stateStore?: SupervisorStateStore

  constructor(
    private readonly rootDir: () => string,
    private readonly sessions: ReadonlyMap<string, Engine>,
    private readonly taskRuns: TaskRunRegistry,
    private readonly replaySnapshot: (
      sessionId: string,
      prompts: readonly string[],
      options: TaskSnapshotReplaySendOptions
    ) => Promise<boolean>,
    private readonly interruptSession: (id: string) => Promise<void>,
    private readonly flushWorkflow: (id: string) => Promise<void>,
    private readonly writeSnapshot: SnapshotWriter
  ) {}

  private readonly observationTasks = new Map<string, Promise<void>>()

  blocksSend(
    sessionId: string,
    run: TaskRunRecord | undefined,
    supervisorControlReplay = false
  ): boolean {
    if (supervisorControlReplay) return false
    return this.sessionSendGates.has(sessionId) ||
      this.pauseIntents.has(sessionId) ||
      Boolean(run && this.runSendGates.has(run.id))
  }

  isPauseIntent(sessionId: string): boolean {
    return this.pauseIntents.has(sessionId)
  }

  releaseSession(sessionId: string, runId?: string): void {
    if (runId) this.runSendGates.delete(runId)
    this.sessionSendGates.delete(sessionId)
    this.pauseIntents.delete(sessionId)
  }

  clear(): void {
    this.pauseIntents.clear()
    this.runSendGates.clear()
    this.sessionSendGates.clear()
    this.observationTasks.clear()
  }

  async authorizeSend(
    session: Engine,
    run: TaskRunRecord,
    options: { supervisorControlReplay?: boolean } = {}
  ): Promise<void> {
    await this.observationTasks.get(session.meta.id)
    if (
      options.supervisorControlReplay !== true &&
      (this.sessionSendGates.has(session.meta.id) || this.runSendGates.has(run.id))
    ) {
      throw new SupervisorStateError(
        'invalid_transition',
        `run ${run.id} is closed by a Supervisor accounting or control gate`
      )
    }
    const store = this.getStateStore()
    const supervisorRun = await reserveSupervisorRunForSend(session.meta, run, {
      rootDir: this.rootDir(),
      store,
      accountingBase: sessionAccountingBase(session),
      costBudgetEnforceable: canEnforceGoalCostBudget(session.meta)
    })
    if (supervisorRun) await store.authorizeTurn(supervisorRun.id)
  }

  observeAfterEvent(
    session: Engine,
    run: TaskRunRecord,
    sourceEventId: string,
    turnCompleted: boolean
  ): void {
    if (!session.meta.workspaceId && !session.meta.workItemId && !session.meta.goalId) return
    const previous = this.observationTasks.get(session.meta.id) ?? Promise.resolve()
    const next = previous
      .then(async () => {
        await this.writeSnapshot(
          session.meta.id,
          'important-event',
          0,
          run.lastEventKind,
          sourceEventId,
          true
        )
        const store = this.getStateStore()
        const binding = await ensureSupervisorRunBinding(session.meta, run, {
          rootDir: this.rootDir(),
          store,
          accountingBase: sessionAccountingBase(session)
        })
        if (!binding.supervisorRun) return
        await store.observeRun(binding.supervisorRun.id, {
          taskRunStatus: run.status,
          sourceEventId,
          usage: { ...session.meta.usage },
          costUsd: session.meta.costUsd,
          turnCompleted
        }, { actorId: 'session-runtime' })
      })
      .catch((error) => {
        this.runSendGates.add(run.id)
        this.sessionSendGates.add(session.meta.id)
        console.error(`[caogen] Supervisor accounting failed for run ${run.id}:`, error)
      })
    this.observationTasks.set(session.meta.id, next)
    void next.finally(() => {
      if (this.observationTasks.get(session.meta.id) === next) {
        this.observationTasks.delete(session.meta.id)
      }
    })
  }

  async settleAcceptedSend(sessionId: string): Promise<void> {
    await this.observationTasks.get(sessionId)
  }

  async settleAllObservations(): Promise<void> {
    while (this.observationTasks.size > 0) {
      await Promise.all([...this.observationTasks.values()])
    }
  }

  async hydrateSendGate(run: TaskRunRecord | undefined): Promise<void> {
    if (!run) return
    const supervisor = await this.getStateStore().getRun(run.id)
    if (!supervisor || !requiresExplicitControl(supervisor.status)) return
    this.runSendGates.add(run.id)
    this.sessionSendGates.add(run.sessionId)
  }

  async hydrateSendGates(runs: readonly TaskRunRecord[]): Promise<void> {
    const document = await this.getStateStore().read()
    const gatedRunIds = new Set(
      document.runs.filter((run) => requiresExplicitControl(run.status)).map((run) => run.id)
    )
    for (const run of runs) {
      if (!gatedRunIds.has(run.id)) continue
      this.runSendGates.add(run.id)
      this.sessionSendGates.add(run.sessionId)
    }
  }

  async recoverStartupState(runs: readonly TaskRunRecord[]): Promise<{
    expiredRunIds: string[]
    blockedRunIds: string[]
    orphanedRunIds: string[]
  }> {
    const store = this.getStateStore()
    const expired = await store.recoverExpiredLeases()
    const orphanedRunIds = await store.recoverOrphanedTaskRunReservations(
      new Set(runs.map((run) => run.id))
    )
    return { ...expired, orphanedRunIds }
  }

  async freezeForWorkItemTransfer(sessionId: string): Promise<TaskRunRecord | undefined> {
    return this.freezeForExternalBoundary(sessionId, 'WorkItem transfer', 'work-item-transfer')
  }

  async freezeForSourceRevocation(sessionId: string): Promise<TaskRunRecord | undefined> {
    return this.freezeForExternalBoundary(sessionId, 'connector source revocation', 'connector-source-revocation')
  }

  blockForSourceRevocation(sessionId: string): void {
    this.sessionSendGates.add(sessionId)
    const run = this.taskRuns.get(sessionId)
    if (run) this.runSendGates.add(run.id)
  }

  private async freezeForExternalBoundary(
    sessionId: string,
    boundary: string,
    actorId: string
  ): Promise<TaskRunRecord | undefined> {
    await this.observationTasks.get(sessionId)
    const session = this.sessions.get(sessionId)
    if (!session) return undefined
    const run = this.taskRuns.get(sessionId)
    this.sessionSendGates.add(sessionId)
    if (!run || isTaskRunTerminal(run.status)) return run
    if (runHasUnresolvedEffects(run) || run.status === 'waiting_reconciliation') {
      throw new SupervisorStateError(
        'invalid_transition',
        `run ${run.id} has unresolved outcomes; reconcile before ${boundary}`
      )
    }
    this.runSendGates.add(run.id)
    await this.pauseExecution({ session, taskRun: run })
    await this.observationTasks.get(sessionId)
    const frozen = this.taskRuns.get(sessionId)
    if (!frozen || frozen.id !== run.id || frozen.status !== 'recovering') {
      throw new SupervisorStateError(
        'invalid_transition',
        `run ${run.id} did not reach a recoverable checkpoint for ${boundary}`
      )
    }
    const store = this.getStateStore()
    const supervisor = await store.getRun(frozen.id)
    // A freshly assigned successor has a durable TaskRun before its first send
    // reserves a Supervisor projection. The TaskRun checkpoint is sufficient.
    if (!supervisor) return frozen
    if (supervisor.status !== 'paused') {
      await store.pauseRunForWorkItemTransfer(supervisor.id, {
        actorId,
        expectedRevision: supervisor.revision
      })
    }
    return frozen
  }

  control(
    store: SupervisorStateStore,
    request: SupervisorSessionControlRequest
  ): Promise<SupervisorSessionControlResult | null> {
    return executeSupervisorSessionControl(store, this.rootDir(), request, {
      resolve: (runId) => this.resolveControlBinding(runId),
      preflight: (controlRequest, binding) => this.preflightControl(controlRequest, binding),
      pause: (binding) => this.pauseExecution(binding),
      cancel: (binding) => this.cancelExecution(binding),
      resume: (binding) => this.resumeExecution(binding),
      prepareRetry: (binding) => this.prepareRetry(binding),
      reassign: (binding, newOwnerId) => this.recordReassignment(binding, newOwnerId),
      committed: (committedRequest, binding) => {
        if (committedRequest.action === 'pause' || committedRequest.action === 'cancel' || committedRequest.action === 'retry') {
          this.setSendGate(binding, true)
        }
      },
      completed: async (completedRequest, binding) => {
        await this.observationTasks.get(binding.taskRun.sessionId)
        if (completedRequest.action === 'resume' || completedRequest.action === 'cancel') {
          this.setSendGate(binding, false)
        }
      },
      failed: (failedRequest, binding) => {
        if (failedRequest.action === 'resume') this.setSendGate(binding, true)
      }
    })
  }

  /**
   * The renderer cannot name an arbitrary worker or take a TaskRun lease
   * directly. It can only claim a local operator lease after the active
   * canonical Session/TaskRun binding has been rechecked in main.
   */
  async claimControlLease(
    store: SupervisorStateStore,
    runId: string,
    expectedRevision: number
  ): Promise<SupervisorRunRecord> {
    const supervisor = await store.getRun(runId)
    if (!supervisor) {
      throw new SupervisorStateError('not_found', `run ${runId} was not found`)
    }
    if (supervisor.origin !== 'task_run') {
      throw new SupervisorStateError(
        'invalid_transition',
        `run ${supervisor.id} is not TaskRun-owned; use the coordination lease API`
      )
    }
    if (supervisor.revision !== expectedRevision) {
      throw new SupervisorStateError(
        'stale_revision',
        `run ${supervisor.id} revision is ${supervisor.revision}, expected ${expectedRevision}`
      )
    }
    const binding = await this.resolveControlBinding(supervisor.id)
    if (!binding) {
      throw new SupervisorStateError(
        'invalid_transition',
        `run ${supervisor.id} is TaskRun-owned but has no active canonical session runtime`
      )
    }
    assertControlBindingIdentity(supervisor, binding)
    const ownerId = 'local-operator'
    const lease = supervisor.lease
    const now = Date.now()
    if (lease && lease.expiresAt > now && lease.ownerId === ownerId) {
      return store.heartbeatLease(supervisor.id, {
        actorId: ownerId,
        expectedRevision,
        fencingToken: lease.fencingToken,
        leaseId: lease.id,
        ownerId,
        ttlMs: 30_000
      })
    }
    return store.acquireLease(supervisor.id, {
      actorId: ownerId,
      expectedRevision,
      ownerId,
      ttlMs: 30_000
    })
  }

  private getStateStore(): SupervisorStateStore {
    const rootDir = this.rootDir()
    if (!this.stateStore || rootDir !== this.stateStoreRoot) {
      this.stateStore = new SupervisorStateStore(rootDir)
      this.stateStoreRoot = rootDir
    }
    return this.stateStore
  }

  private async preflightControl(
    request: SupervisorSessionControlRequest,
    binding: SupervisorSessionControlBinding
  ): Promise<void> {
    await this.observationTasks.get(binding.taskRun.sessionId)
    if (request.action !== 'retry' && request.action !== 'resume') return
    const { taskRun } = this.assertRuntimeBinding(binding)
    const workerPolicyError = await digitalWorkerSupervisorPolicyError({
      rootDir: this.rootDir(),
      meta: binding.session.meta,
      action: request.action,
      run: taskRun,
      activeSessions: [...this.sessions.values()].map((candidate) => candidate.meta)
    })
    if (workerPolicyError) throw new SupervisorStateError('invalid_transition', workerPolicyError)
    const snapshot = await this.requireReplaySnapshot(taskRun)
    if (request.action === 'resume' && buildTaskSnapshotReplayPrompts(snapshot).length === 0) {
      throw new SupervisorStateError('invalid_transition', `run ${taskRun.id} has no durable replay request`)
    }
  }

  private setSendGate(binding: SupervisorSessionControlBinding, gated: boolean): void {
    if (gated) {
      this.runSendGates.add(binding.taskRun.id)
      this.sessionSendGates.add(binding.taskRun.sessionId)
      return
    }
    this.runSendGates.delete(binding.taskRun.id)
    this.sessionSendGates.delete(binding.taskRun.sessionId)
  }

  private async resolveControlBinding(runId: string): Promise<SupervisorSessionControlBinding | null> {
    const active: SupervisorSessionControlBinding[] = []
    for (const session of this.sessions.values()) {
      const taskRun = this.taskRuns.get(session.meta.id)
      if (taskRun?.id === runId) active.push({ session, taskRun })
    }
    if (active.length > 1) {
      throw new SupervisorStateError('corrupt_store', `run ${runId} is attached to multiple active sessions`)
    }
    if (active[0]) return active[0]

    const persisted = (await listPersistedTaskRuns()).filter((taskRun) => taskRun.id === runId)
    if (persisted.length > 1 || new Set(persisted.map((taskRun) => taskRun.sessionId)).size > 1) {
      throw new SupervisorStateError('corrupt_store', `run ${runId} has conflicting persisted session ownership`)
    }
    if (persisted.length > 0) {
      throw new SupervisorStateError(
        'invalid_transition',
        `run ${runId} has a durable TaskRun but its canonical session is not active`
      )
    }
    return null
  }

  private async pauseExecution(binding: SupervisorSessionControlBinding): Promise<void> {
    const { session, taskRun } = this.assertRuntimeBinding(binding)
    this.pauseIntents.add(taskRun.sessionId)
    try {
      await session.interrupt()
      await this.flushWorkflow(taskRun.sessionId)
      const current = this.assertRuntimeBinding(binding).taskRun
      if (isTaskRunTerminal(current.status)) {
        throw new SupervisorStateError('invalid_transition', `run ${current.id} became ${current.status} while pausing`)
      }
      let recovering = current.status === 'recovering'
        ? current
        : transitionTaskRun(current, 'recovering', { lastEventKind: 'status' })
      recovering = recoverTaskExecutionState(recovering)
      if (runHasUnresolvedEffects(recovering)) {
        throw new SupervisorStateError(
          'invalid_transition',
          `run ${current.id} produced an unresolved Effect while pausing`
        )
      }
      this.taskRuns.set(taskRun.sessionId, recovering)
      await this.writeSnapshot(taskRun.sessionId, 'shutdown', 0, 'status', undefined, true)
    } finally {
      this.pauseIntents.delete(taskRun.sessionId)
    }
  }

  private async cancelExecution(binding: SupervisorSessionControlBinding): Promise<void> {
    const { taskRun } = this.assertRuntimeBinding(binding)
    await this.interruptSession(taskRun.sessionId)
    const cancelled = this.taskRuns.get(taskRun.sessionId)
    if (!cancelled || cancelled.id !== taskRun.id || cancelled.status !== 'cancelled') {
      throw new SupervisorStateError(
        'invalid_transition',
        `run ${taskRun.id} executor stopped without a matching cancelled TaskRun`
      )
    }
  }

  private async resumeExecution(binding: SupervisorSessionControlBinding): Promise<void> {
    const { taskRun } = this.assertRuntimeBinding(binding)
    const snapshot = await this.requireReplaySnapshot(taskRun)
    const prompts = buildTaskSnapshotReplayPrompts(snapshot)
    if (prompts.length === 0) {
      throw new SupervisorStateError('invalid_transition', `run ${taskRun.id} has no durable replay request`)
    }
    const accepted = await this.replaySnapshot(taskRun.sessionId, prompts, {
      modelAttemptRecoveryReplay: true,
      supervisorControlReplay: true
    })
    if (!accepted) {
      throw new SupervisorStateError(
        'invalid_transition',
        `run ${taskRun.id} replay was rejected by SessionManager`
      )
    }
  }

  private async prepareRetry(binding: SupervisorSessionControlBinding): Promise<void> {
    const { taskRun } = this.assertRuntimeBinding(binding)
    await this.requireReplaySnapshot(taskRun)
    const recovering = recoverTaskExecutionState(
      transitionTaskRun(taskRun, 'recovering', { lastEventKind: 'status' })
    )
    if (runHasUnresolvedEffects(recovering)) {
      throw new SupervisorStateError(
        'invalid_transition',
        `run ${taskRun.id} still requires Effect reconciliation`
      )
    }
    this.taskRuns.set(taskRun.sessionId, recovering)
    await this.writeSnapshot(taskRun.sessionId, 'recovered', 0, 'status', undefined, true)
  }

  private recordReassignment(binding: SupervisorSessionControlBinding, newOwnerId: string): void {
    const { session, taskRun } = this.assertRuntimeBinding(binding)
    session.emitSyntheticEvent?.({
      kind: 'hook-event',
      event: 'supervisor-lease-reassigned',
      detail: `Supervisor Run ${taskRun.id} lease reassigned to ${newOwnerId}`
    })
  }

  private assertRuntimeBinding(
    binding: SupervisorSessionControlBinding
  ): { session: Engine; taskRun: TaskRunRecord } {
    const session = this.sessions.get(binding.taskRun.sessionId)
    const taskRun = this.taskRuns.get(binding.taskRun.sessionId)
    if (!session || session !== binding.session || !taskRun || taskRun.id !== binding.taskRun.id) {
      throw new SupervisorStateError(
        'invalid_transition',
        `run ${binding.taskRun.id} active session binding changed during control`
      )
    }
    return { session, taskRun }
  }

  private async requireReplaySnapshot(taskRun: TaskRunRecord): Promise<TaskSnapshotRecord> {
    const snapshot = await getTaskSnapshot(taskRun.sessionId)
    if (!snapshot?.run || snapshot.run.id !== taskRun.id || snapshot.sessionId !== taskRun.sessionId) {
      throw new SupervisorStateError(
        'invalid_transition',
        `run ${taskRun.id} has no matching canonical recovery snapshot`
      )
    }
    return snapshot
  }
}

function assertControlBindingIdentity(
  supervisor: SupervisorRunRecord,
  binding: SupervisorSessionControlBinding
): void {
  const { meta } = binding.session
  const { taskRun } = binding
  if (
    taskRun.id !== supervisor.id ||
    taskRun.sessionId !== meta.id ||
    meta.workspaceId !== supervisor.projectId ||
    meta.goalId !== supervisor.goalId ||
    meta.workItemId !== supervisor.workItemId
  ) {
    throw new SupervisorStateError(
      'invalid_input',
      `run ${supervisor.id} canonical identity does not match the active session`
    )
  }
}

function sessionAccountingBase(session: Engine): {
  usage: Engine['meta']['usage']
  costUsd: number
} {
  return {
    usage: { ...session.meta.usage },
    costUsd: session.meta.costUsd
  }
}

function requiresExplicitControl(status: string): boolean {
  return status === 'queued' ||
    status === 'waiting_approval' ||
    status === 'waiting_reconciliation' ||
    status === 'paused' ||
    status === 'blocked' ||
    status === 'failed'
}
