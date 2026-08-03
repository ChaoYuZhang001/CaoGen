import type {
  ProjectWorkspace,
  WorkItem,
  WorkItemActor,
  WorkItemAuthorizationView,
  WorkItemCapability,
  WorkItemOwner
} from '../../shared/project-workspace-types'
import { ProjectWorkspaceError } from './errors'

export const LOCAL_USER_ACTOR: WorkItemActor = Object.freeze({
  type: 'local_user',
  id: 'caogen:local-user',
  displayName: 'Local user'
})

const ADMIN_CAPABILITIES: WorkItemCapability[] = ['view', 'edit', 'execute', 'approve', 'transfer']
const OWNER_CAPABILITIES: WorkItemCapability[] = ['view', 'edit', 'execute', 'approve', 'transfer']

export function inspectWorkItemAuthorization(
  project: ProjectWorkspace,
  workItem: WorkItem,
  actor: WorkItemActor
): WorkItemAuthorizationView {
  assertActor(actor)
  if (workItem.projectId !== project.id) {
    throw new ProjectWorkspaceError('project_scope_conflict', 'WorkItem does not belong to the authorization Project')
  }
  const projectAdministrator = actor.type === 'local_user' || project.ownerId === actor.id
  const currentOwner = ownerMatchesActor(workItem.owner, actor)
  return {
    projectId: project.id,
    workItemId: workItem.id,
    actor: { ...actor },
    ...(workItem.owner ? { owner: { ...workItem.owner } } : {}),
    authorizationRevision: workItem.revision,
    projectAdministrator,
    currentOwner,
    capabilities: projectAdministrator
      ? [...ADMIN_CAPABILITIES]
      : currentOwner
        ? [...OWNER_CAPABILITIES]
        : []
  }
}

export function assertWorkItemAuthorized(
  project: ProjectWorkspace,
  workItem: WorkItem,
  actor: WorkItemActor,
  capability: WorkItemCapability,
  expectedRevision?: number
): WorkItemAuthorizationView {
  if (expectedRevision !== undefined && workItem.revision !== expectedRevision) {
    throw new ProjectWorkspaceError(
      'authorization_revision_conflict',
      `WorkItem ${workItem.id} authorization is at revision ${workItem.revision}, expected ${expectedRevision}`
    )
  }
  const view = inspectWorkItemAuthorization(project, workItem, actor)
  if (!view.capabilities.includes(capability)) {
    throw new ProjectWorkspaceError(
      'actor_forbidden',
      `Actor ${actor.id} is not allowed to ${capability} WorkItem ${workItem.id}`,
      { actorId: actor.id, capability, workItemId: workItem.id, authorizationRevision: workItem.revision }
    )
  }
  return view
}

function ownerMatchesActor(owner: WorkItemOwner | undefined, actor: WorkItemActor): boolean {
  if (!owner || owner.id !== actor.id) return false
  if (actor.type === 'local_user') return owner.type === 'human'
  return owner.type === actor.type
}

function assertActor(actor: WorkItemActor): void {
  if (!actor || (actor.type !== 'local_user' && actor.type !== 'human' && actor.type !== 'digital_worker')) {
    throw new ProjectWorkspaceError('invalid_actor', 'WorkItem actor type is invalid')
  }
  if (typeof actor.id !== 'string' || !actor.id.trim() || actor.id !== actor.id.trim() || actor.id.length > 512) {
    throw new ProjectWorkspaceError('invalid_actor', 'WorkItem actor id is invalid')
  }
}
