import type { ProjectWorkspaceState } from '../../shared/project-workspace-types'
import { ProjectWorkspaceError } from './errors'
import { findProjectWorkspaceLedgerShadowEntity } from './ledger-shadow-source'
import type { ProjectWorkspaceLedgerShadowMutation } from './ledger-shadow-types'

export async function assertCanonicalAcceptanceBeforeTerminalWrite(
  rootDir: string,
  state: ProjectWorkspaceState,
  mutation: ProjectWorkspaceLedgerShadowMutation
): Promise<void> {
  const entity = findProjectWorkspaceLedgerShadowEntity(state, mutation.entityType, mutation.entityId)
  if (!entity) return
  if (!requiresCanonicalAcceptance(mutation, entity)) return
  try {
    const [{ readTaskSnapshotDatabase }, workflow, acceptance] = await Promise.all([
      import('../task/task-snapshot.js'),
      import('../task/workflow-ledger-store.js'),
      import('../task/workflow-acceptance-guard.js')
    ])
    await readTaskSnapshotDatabase(rootDir, (db) => {
      if (mutation.entityType === 'goal') {
        const record = workflow.findWorkflowGoal(db, mutation.entityId)
        if (!record || record.projectId !== entity.projectId) throw missingCanonicalTarget(mutation.entityId)
        acceptance.assertWorkflowAcceptanceGate(db, { kind: 'goal', record })
        return
      }
      const record = workflow.findWorkflowWorkItem(db, mutation.entityId)
      if (!record || record.projectId !== entity.projectId) throw missingCanonicalTarget(mutation.entityId)
      acceptance.assertWorkflowAcceptanceGate(db, { kind: 'work_item', record })
    })
  } catch (error) {
    const item = error && typeof error === 'object' ? error as Record<string, unknown> : undefined
    const wrapped = new ProjectWorkspaceError(
      'canonical_acceptance_required',
      `${mutation.entityType} ${mutation.entityId} cannot become terminal until canonical Workflow Acceptance is valid`,
      {
        sourceCommitted: false,
        reconciliationRequired: false,
        entityType: mutation.entityType,
        entityId: mutation.entityId,
        workspaceId: entity.projectId,
        causeCode: typeof item?.code === 'string' ? item.code : undefined
      }
    )
    Object.defineProperty(wrapped, 'cause', { value: error })
    throw wrapped
  }
}

function requiresCanonicalAcceptance(
  mutation: ProjectWorkspaceLedgerShadowMutation,
  entity: ReturnType<typeof findProjectWorkspaceLedgerShadowEntity>
): boolean {
  if (!entity) return false
  if (mutation.requiresCanonicalAcceptance) return true
  if (mutation.command === 'goal.archive') return entity.status === 'completed'
  return mutation.command === 'goal.restore' && 'archivedFromStatus' in entity &&
    entity.status === 'archived' && entity.archivedFromStatus === 'completed'
}

function missingCanonicalTarget(entityId: string): ProjectWorkspaceError {
  return new ProjectWorkspaceError(
    'canonical_target_missing',
    `Workflow Ledger target ${entityId} is missing before terminal transition`
  )
}
