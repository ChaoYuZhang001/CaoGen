import type {
  MutationOptions,
  ProjectMemberRole,
  ProjectAuthorizationView,
  ProjectWorkspace,
  ProjectWorkspaceState,
  WorkItemActor
} from '../../shared/project-workspace-types'
import { ProjectWorkspaceError } from './errors'

export type ProjectAuthorizationCapability =
  | 'view'
  | 'edit'
  | 'execute'
  | 'comment'
  | 'approve'
  | 'transfer'
  | 'manage_squads'
  | 'manage_members'
  | 'manage_invitations'

export type { ProjectAuthorizationView } from '../../shared/project-workspace-types'

/**
 * Resolve the actor attached to a trusted mutation call. Renderer callers do
 * not get to supply an actor; omitted actors remain the local desktop admin.
 */
export function projectMutationActor(options?: MutationOptions | number): WorkItemActor {
  if (typeof options === 'object' && options?.actor) return normalizeActor(options.actor)
  return { type: 'local_user', id: 'caogen:local-user', displayName: 'Local user' }
}

const ROLE_CAPABILITIES: Record<ProjectMemberRole, readonly ProjectAuthorizationCapability[]> = {
  owner: ['view', 'edit', 'execute', 'comment', 'approve', 'transfer', 'manage_squads', 'manage_members', 'manage_invitations'],
  admin: ['view', 'edit', 'execute', 'comment', 'approve', 'transfer', 'manage_squads', 'manage_members', 'manage_invitations'],
  editor: ['view', 'edit', 'execute', 'comment', 'transfer'],
  reviewer: ['view', 'comment', 'approve'],
  viewer: ['view']
}

export function inspectProjectAuthorization(
  state: ProjectWorkspaceState,
  project: ProjectWorkspace,
  actor: WorkItemActor,
  options: { allowDeleted?: boolean; allowInactive?: boolean } = {}
): ProjectAuthorizationView {
  assertActor(actor)
  if (project.status !== 'active' && !options.allowInactive && !(options.allowDeleted && project.status === 'deleted')) {
    throw new ProjectWorkspaceError('project_inactive', `Project ${project.id} is not active`)
  }
  if (actor.type === 'local_user' && (actor.id === 'caogen:local-user' || actor.id === project.ownerId || actor.id === 'local-user')) {
    return {
      projectId: project.id,
      actor: { ...actor },
      role: actor.id === project.ownerId || actor.id === 'local-user' ? 'owner' : 'local_admin',
      capabilities: [...ROLE_CAPABILITIES.owner],
      authorizationRevision: project.revision
    }
  }
  const member = state.members.find((candidate) =>
    candidate.projectId === project.id &&
    candidate.status === 'active' &&
    candidate.principal.type === actor.type &&
    candidate.principal.id === actor.id
  )
  if (!member) {
    return {
      projectId: project.id,
      actor: { ...actor },
      role: 'unregistered',
      capabilities: [],
      authorizationRevision: project.revision
    }
  }
  return {
    projectId: project.id,
    actor: { ...actor },
    role: member.role,
    capabilities: [...ROLE_CAPABILITIES[member.role]],
    authorizationRevision: Math.max(project.revision, member.revision)
  }
}

export function assertProjectAuthorized(
  state: ProjectWorkspaceState,
  project: ProjectWorkspace,
  actor: WorkItemActor,
  capability: ProjectAuthorizationCapability,
  options: { allowDeleted?: boolean; allowInactive?: boolean } = {}
): ProjectAuthorizationView {
  const view = inspectProjectAuthorization(state, project, actor, options)
  if (!view.capabilities.includes(capability)) {
    throw new ProjectWorkspaceError(
      'actor_forbidden',
      `Actor ${actor.id} is not allowed to ${capability} Project ${project.id}`,
      { actorId: actor.id, capability, projectId: project.id, role: view.role }
    )
  }
  return view
}

function assertActor(actor: WorkItemActor): void {
  if (!actor || (actor.type !== 'local_user' && actor.type !== 'human' && actor.type !== 'digital_worker')) {
    throw new ProjectWorkspaceError('invalid_actor', 'Project actor type is invalid')
  }
  if (typeof actor.id !== 'string' || !actor.id.trim() || actor.id !== actor.id.trim() || actor.id.length > 512) {
    throw new ProjectWorkspaceError('invalid_actor', 'Project actor id is invalid')
  }
}

function normalizeActor(actor: WorkItemActor): WorkItemActor {
  assertActor(actor)
  return { ...actor }
}
