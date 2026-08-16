import type { WorkflowProjectionSource, WorkflowRunRecord, WorkflowWorkItemRecord } from '../../shared/workflow-types'
import { openProjectWorkspaceStore } from '../project-workspace/store'
import { resolveLifecycleRoots } from './artifact-lifecycle-api'
import type { ArtifactLifecycleRootInput } from './artifact-lifecycle-types'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'

export interface ArtifactProjectionAuthority {
  provenance: WorkflowProjectionSource
  attachToStage: boolean
}

/**
 * A Workflow projection can carry a legacy path-project id without that id
 * identifying a canonical ProjectWorkspace. Only the ProjectWorkspace store
 * can authorize stage and WorkItem mutations.
 */
export async function resolveArtifactProjectionAuthority(
  run: WorkflowRunRecord & { projectId: string },
  workItem: WorkflowWorkItemRecord,
  rootInput?: ArtifactLifecycleRootInput
): Promise<ArtifactProjectionAuthority> {
  if (workItem.id !== run.workItemId || workItem.projectId !== run.projectId ||
      workItem.goalId !== run.goalId || !workItem.runIds.includes(run.id)) {
    throw new WorkflowLedgerCorruptionError(
      `Artifact producer Run ${run.id} lacks its Workflow WorkItem ownership`
    )
  }

  const roots = resolveLifecycleRoots(rootInput)
  const store = await openProjectWorkspaceStore(roots.workspaceRoot)
  const workspace = await store.getWorkspace(run.projectId)
  if (!workspace) {
    if (workItem.source === 'explicit') {
      throw new WorkflowLedgerCorruptionError(
        `canonical Artifact producer is missing ProjectWorkspace: ${run.projectId}`
      )
    }
    return { provenance: 'legacy-derived', attachToStage: false }
  }
  if (workspace.status !== 'active') {
    throw new WorkflowLedgerCorruptionError(`Artifact producer ProjectWorkspace is not active: ${run.projectId}`)
  }

  const canonicalWorkItem = await store.getWorkItem(workItem.id)
  if (!canonicalWorkItem || canonicalWorkItem.projectId !== run.projectId ||
      canonicalWorkItem.goalId !== run.goalId || !canonicalWorkItem.runRefs.includes(run.id)) {
    throw new WorkflowLedgerCorruptionError(
      `Artifact producer Run ${run.id} lacks its canonical ProjectWorkspace WorkItem ownership`
    )
  }
  return { provenance: workItem.source, attachToStage: true }
}
