import type {
  McpProbeResult,
  TaskDagFinalizationResolution,
  TaskSnapshotRecord,
  WorkItem
} from '../../../shared/types'
import type { SupervisorRunRecord } from '../../../shared/supervisor-types'
import type { McpProbeOperationResult } from '../../../shared/mcp-probe-types'
import type {
  ModelAttemptReconciliationResolution,
  ModelAttemptReconciliationView
} from '../../../shared/model-attempt-types'

interface TaskRecoveryState {
  taskSnapshots: TaskSnapshotRecord[]
  modelAttemptReconciliations: ModelAttemptReconciliationView[]
  taskSnapshotsLoading: boolean
  taskSnapshotsError?: string
  workflowAttentionWorkItems: WorkItem[]
  workflowAttentionSupervisorRuns: SupervisorRunRecord[]
  workflowAttentionLoading: boolean
  workflowAttentionError?: string
  recoverTaskSnapshot(snapshotId: string): Promise<void>
  refreshTaskSnapshots(): Promise<void>
}

type TaskRecoveryStateUpdate = Partial<
  Pick<
    TaskRecoveryState,
    | 'taskSnapshots'
    | 'modelAttemptReconciliations'
    | 'taskSnapshotsLoading'
    | 'taskSnapshotsError'
    | 'workflowAttentionWorkItems'
    | 'workflowAttentionSupervisorRuns'
    | 'workflowAttentionLoading'
    | 'workflowAttentionError'
  >
>

export interface TaskRecoveryActions {
  modelAttemptReconciliations: ModelAttemptReconciliationView[]
  workflowAttentionWorkItems: WorkItem[]
  workflowAttentionSupervisorRuns: SupervisorRunRecord[]
  workflowAttentionLoading: boolean
  workflowAttentionError?: string
  hydrateTaskRecoveryCandidates(): Promise<void>
  refreshWorkflowAttention(): Promise<void>
  resolveTaskEffect(
    snapshotId: string,
    effectId: string,
    expectedRevision: number,
    resolution: 'confirmed_applied' | 'confirmed_not_applied'
  ): Promise<void>
  resolveTaskDagFinalization(
    executionId: string,
    expectedRevision: number,
    resolution: TaskDagFinalizationResolution
  ): Promise<void>
  resolveModelAttemptReconciliation(
    attemptId: string,
    expectedRevision: number,
    resolution: ModelAttemptReconciliationResolution
  ): Promise<void>
}

export async function requireMcpProbeResults(
  outcome: McpProbeOperationResult,
  refreshRecovery: () => Promise<void>
): Promise<McpProbeResult[]> {
  if (outcome.ok) return outcome.results
  if (outcome.effectStatus === 'waiting_reconciliation') await refreshRecovery()
  throw new Error(outcome.error)
}

export function createTaskRecoveryActions(
  set: (update: TaskRecoveryStateUpdate) => void,
  get: () => TaskRecoveryState
): TaskRecoveryActions {
  return {
    modelAttemptReconciliations: [],
    workflowAttentionWorkItems: [],
    workflowAttentionSupervisorRuns: [],
    workflowAttentionLoading: false,

    async refreshWorkflowAttention() {
      set({ workflowAttentionLoading: true, workflowAttentionError: undefined })
      const [workItemsResult, supervisorResult] = await Promise.allSettled([
        window.agentDesk.listProjectWorkItems(undefined, { includeArchived: true }),
        window.agentDesk.listSupervisorRuns()
      ])
      const attentionStatuses = new Set<WorkItem['status']>(['running', 'waiting_approval', 'blocked', 'verifying', 'failed'])
      const errors = [
        workItemsResult.status === 'rejected' ? `WorkItem: ${errorMessage(workItemsResult.reason)}` : undefined,
        supervisorResult.status === 'rejected' ? `Supervisor: ${errorMessage(supervisorResult.reason)}` : undefined
      ].filter((value): value is string => Boolean(value))
      set({
        workflowAttentionWorkItems: workItemsResult.status === 'fulfilled'
          ? workItemsResult.value.filter((item) => attentionStatuses.has(item.status) || item.acceptance?.status === 'failed')
          : get().workflowAttentionWorkItems,
        workflowAttentionSupervisorRuns: supervisorResult.status === 'fulfilled'
          ? supervisorResult.value.filter((run) => ['waiting_approval', 'waiting_reconciliation', 'blocked', 'failed'].includes(run.status))
          : get().workflowAttentionSupervisorRuns,
        workflowAttentionLoading: false,
        workflowAttentionError: errors.length > 0 ? errors.join('\n') : undefined
      })
    },

    async hydrateTaskRecoveryCandidates() {
      set({ taskSnapshotsLoading: true, taskSnapshotsError: undefined })
      await refreshRecoveryCandidates(set, get)
    },

    async resolveTaskEffect(snapshotId, effectId, expectedRevision, resolution) {
      set({ taskSnapshotsLoading: true, taskSnapshotsError: undefined })
      try {
        const { snapshot: updated, resumedSession } = await window.agentDesk.resolveTaskEffect(
          snapshotId,
          effectId,
          expectedRevision,
          resolution
        )
        if (resumedSession) return get().recoverTaskSnapshot(resumedSession.id)
        set({
          taskSnapshots: get().taskSnapshots.map(
            (snapshot) => snapshot.id === updated.id ? updated : snapshot
          )
        })
        await refreshRecoveryCandidates(set, get)
      } catch (error) {
        await restoreRecoveryCandidatesAfterError(set, get, error)
        throw error
      }
    },

    async resolveTaskDagFinalization(executionId, expectedRevision, resolution) {
      set({ taskSnapshotsLoading: true, taskSnapshotsError: undefined })
      try {
        await window.agentDesk.resolveTaskDagFinalization(executionId, expectedRevision, resolution)
        await refreshRecoveryCandidates(set, get)
      } catch (error) {
        await restoreRecoveryCandidatesAfterError(set, get, error)
        throw error
      }
    },

    async resolveModelAttemptReconciliation(attemptId, expectedRevision, resolution) {
      set({ taskSnapshotsLoading: true, taskSnapshotsError: undefined })
      try {
        await window.agentDesk.resolveModelAttemptReconciliation(
          attemptId,
          expectedRevision,
          resolution
        )
        await refreshRecoveryCandidates(set, get)
      } catch (error) {
        await restoreRecoveryCandidatesAfterError(set, get, error)
        throw error
      }
    }
  }
}

async function restoreRecoveryCandidatesAfterError(
  set: (update: TaskRecoveryStateUpdate) => void,
  get: () => TaskRecoveryState,
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  await refreshRecoveryCandidates(set, get, message)
}

async function refreshRecoveryCandidates(
  set: (update: TaskRecoveryStateUpdate) => void,
  get: () => TaskRecoveryState,
  preferredError?: string
): Promise<void> {
  const [taskSnapshotsResult, modelAttemptsResult] = await Promise.allSettled([
    window.agentDesk.listTaskSnapshots(),
    window.agentDesk.listModelAttemptReconciliations()
  ])
  const refreshErrors = [
    taskSnapshotsResult.status === 'rejected'
      ? `task snapshots: ${errorMessage(taskSnapshotsResult.reason)}`
      : undefined,
    modelAttemptsResult.status === 'rejected'
      ? `model attempt reconciliations: ${errorMessage(modelAttemptsResult.reason)}`
      : undefined
  ].filter((message): message is string => Boolean(message))
  set({
    taskSnapshots:
      taskSnapshotsResult.status === 'fulfilled' ? taskSnapshotsResult.value : get().taskSnapshots,
    modelAttemptReconciliations:
      modelAttemptsResult.status === 'fulfilled'
        ? modelAttemptsResult.value
        : get().modelAttemptReconciliations,
    taskSnapshotsLoading: false,
    taskSnapshotsError: preferredError ?? (refreshErrors.length > 0 ? refreshErrors.join('\n') : undefined)
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
