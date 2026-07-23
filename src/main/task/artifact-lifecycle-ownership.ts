import type { ProjectWorkspaceState } from '../../shared/project-workspace-types'
import type { WorkflowRunRecord } from '../../shared/workflow-types'
import type {
  ArtifactLifecycleRecord,
  ArtifactProjectOwnership
} from './artifact-lifecycle-types'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'

export function resolveArtifactProjectOwnership(
  state: ProjectWorkspaceState,
  run: WorkflowRunRecord,
  projectId: string,
  requireActive = true
): ArtifactProjectOwnership {
  const project = state.workspaces.find((candidate) => candidate.id === projectId)
  if (!project) throw new WorkflowLedgerCorruptionError(`ProjectWorkspace not found: ${projectId}`)
  if (requireActive && project.status !== 'active') {
    throw new WorkflowLedgerCorruptionError(`ProjectWorkspace is not active: ${projectId}`)
  }
  if (run.projectId !== projectId) {
    throw new WorkflowLedgerCorruptionError(`creating Run ${run.id} crosses Project ownership boundary`)
  }
  const workItem = state.workItems.find((candidate) => candidate.id === run.workItemId)
  if (!workItem || workItem.projectId !== projectId) {
    throw new WorkflowLedgerCorruptionError(`creating Run ${run.id} lacks its Project-owned WorkItem`)
  }
  if (!workItem.runRefs.includes(run.id)) {
    throw new WorkflowLedgerCorruptionError(`Project WorkItem ${workItem.id} does not own creating Run ${run.id}`)
  }
  const goalId = resolveGoalOwnership(state, run, workItem.goalId, projectId)
  return {
    projectId,
    projectRevision: project.revision,
    ...(goalId ? { goalId } : {}),
    workItemId: workItem.id
  }
}

export function assertArtifactLifecycleProjectOwnership(
  state: ProjectWorkspaceState,
  records: readonly ArtifactLifecycleRecord[]
): void {
  for (const record of records) {
    const project = state.workspaces.find((candidate) => candidate.id === record.projectId)
    if (!project || project.revision < record.projectRevision) {
      throw new WorkflowLedgerCorruptionError(`artifact ${record.artifactId} Project ownership is unavailable`)
    }
    const workItem = state.workItems.find((candidate) => candidate.id === record.workItemId)
    if (!workItem || workItem.projectId !== record.projectId || !workItem.runRefs.includes(record.runId)) {
      throw new WorkflowLedgerCorruptionError(`artifact ${record.artifactId} WorkItem ownership is unavailable`)
    }
    if (record.goalId) {
      const goal = state.goals.find((candidate) => candidate.id === record.goalId)
      if (!goal || goal.projectId !== record.projectId || workItem.goalId !== goal.id) {
        throw new WorkflowLedgerCorruptionError(`artifact ${record.artifactId} Goal ownership is unavailable`)
      }
    }
  }
}

function resolveGoalOwnership(
  state: ProjectWorkspaceState,
  run: WorkflowRunRecord,
  workItemGoalId: string | undefined,
  projectId: string
): string | undefined {
  if (run.goalId !== workItemGoalId) {
    throw new WorkflowLedgerCorruptionError(`creating Run ${run.id} Goal/WorkItem ownership differs`)
  }
  if (!run.goalId) return undefined
  const goal = state.goals.find((candidate) => candidate.id === run.goalId)
  if (!goal || goal.projectId !== projectId) {
    throw new WorkflowLedgerCorruptionError(`creating Run ${run.id} lacks its Project-owned Goal`)
  }
  return goal.id
}
