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
import { SupervisorStateError, SupervisorStateStore } from './task/supervisor-state'
import { buildTaskSnapshotReplayPrompts } from './session-manager-support'
import type {
  AgentEvent,
  SendMessagePayload,
  TaskRunRecord,
  TaskSnapshotReason,
  TaskSnapshotRecord
} from '../shared/types'

interface TaskRunRegistry {
  get(sessionId: string): TaskRunRecord | undefined
  set(sessionId: string, run: TaskRunRecord): void
}

type SendOptions = {
  modelAttemptRecoveryReplay?: boolean
  supervisorControlReplay?: boolean
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
    private readonly sendMessage: (id: string, input: string | SendMessagePayload, options?: SendOptions) => boolean,
    private readonly interruptSession: (id: string) => Promise<void>,
    private readonly flushWorkflow: (id: string) => Promise<void>,
    private readonly writeSnapshot: SnapshotWriter
  ) {}

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
      completed: (completedRequest, binding) => {
        if (completedRequest.action === 'resume' || completedRequest.action === 'cancel') {
          this.setSendGate(binding, false)
        }
      },
      failed: (failedRequest, binding) => {
        if (failedRequest.action === 'resume') this.setSendGate(binding, true)
      }
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
    if (request.action !== 'retry' && request.action !== 'resume') return
    const { taskRun } = this.assertRuntimeBinding(binding)
    const workerPolicyError = digitalWorkerSupervisorPolicyError({
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
    const accepted = this.sendMessage(taskRun.sessionId, prompts[0], {
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

function requiresExplicitControl(status: string): boolean {
  return status === 'queued' ||
    status === 'waiting_approval' ||
    status === 'waiting_reconciliation' ||
    status === 'paused' ||
    status === 'blocked' ||
    status === 'failed'
}
