import { randomUUID } from 'node:crypto'
import type {
  MutationOptions,
  ProjectSquad,
  ProjectSquadInput,
  ProjectSquadMember,
  ProjectSquadMemberInput,
  ProjectSquadPatch,
  ProjectWorkspaceState,
  WorkItemActor,
  WorkItemComment,
  WorkItemCommentInput,
  WorkItemCommentPatch,
  WorkItemOwnerType
} from '../../shared/project-workspace-types'
import { PROJECT_WORKSPACE_SCHEMA_VERSION } from '../../shared/project-workspace-types'
import { DigitalWorkerStore } from '../digital-worker/domain-store'
import { clone, digest, optionalId, optionalText, requiredId, requiredText, timestamp } from './codec'
import { ProjectWorkspaceError } from './errors'
import { appendEvent, ProjectWorkspacePersistence } from './persistence'
import type { ListOptions } from './repository-types'
import {
  activeWorkspaceFrom,
  commentFrom,
  squadFrom,
  workItemFrom,
  workspaceFrom
} from './state-access'

export class ProjectCollaborationRepository {
  constructor(private readonly persistence: ProjectWorkspacePersistence) {}

  async listSquads(projectId?: string, options: ListOptions = {}): Promise<ProjectSquad[]> {
    const state = await this.persistence.read()
    if (projectId !== undefined) requiredId(projectId, 'projectId')
    return state.squads
      .filter((squad) => projectId === undefined || squad.projectId === projectId)
      .filter((squad) => options.includeArchived !== false || squad.status !== 'archived')
      .filter((squad) => options.includeDeleted || workspaceFrom(state, squad.projectId).status !== 'deleted')
      .map(clone)
  }

  async getSquad(id: string): Promise<ProjectSquad | undefined> {
    const state = await this.persistence.read()
    const squad = state.squads.find((candidate) => candidate.id === requiredId(id, 'squad id'))
    return squad ? clone(squad) : undefined
  }

  async createSquad(input: ProjectSquadInput, options?: MutationOptions | number): Promise<ProjectSquad> {
    return this.persistence.mutate(options, ({ state, now }) => {
      this.persistence.assertCreateRevision(state, options)
      const projectId = requiredId(input.projectId, 'squad projectId')
      activeWorkspaceFrom(state, projectId)
      const id = optionalId(input.id, 'squad id') ?? randomUUID()
      if (state.squads.some((candidate) => candidate.id === id)) {
        throw new ProjectWorkspaceError('already_exists', `squad ${id} already exists`)
      }
      const members = normalizeSquadMembers(input.members, now)
      assertMemberReferences(this.persistence.rootDir, projectId, members, true)
      const createdAt = timestamp(input.createdAt, 'squad createdAt', now)
      const squad: ProjectSquad = {
        schemaVersion: PROJECT_WORKSPACE_SCHEMA_VERSION,
        id,
        projectId,
        name: requiredText(input.name, 'squad name'),
        description: optionalText(input.description, 'squad description'),
        members,
        status: 'active',
        createdBy: input.createdBy ? normalizeActor(input.createdBy, 'squad creator') : undefined,
        createdAt,
        updatedAt: timestamp(input.updatedAt, 'squad updatedAt', createdAt),
        revision: 1
      }
      state.squads.push(squad)
      appendEvent(state, projectId, 'squad', id, 'squad.created', 1, squadEventPayload(squad), now)
      return squad
    })
  }

  async updateSquad(
    id: string,
    patch: ProjectSquadPatch,
    options?: MutationOptions | number
  ): Promise<ProjectSquad> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const squad = activeSquadFrom(state, requiredId(id, 'squad id'))
      activeWorkspaceFrom(state, squad.projectId)
      this.persistence.assertEntityRevision(squad.revision, options, 'squad')
      if (patch.name !== undefined) squad.name = requiredText(patch.name, 'squad name')
      if (patch.description !== undefined) squad.description = optionalText(patch.description, 'squad description')
      squad.updatedAt = now
      squad.revision += 1
      appendEvent(state, squad.projectId, 'squad', squad.id, 'squad.updated', squad.revision, {
        name: squad.name,
        description: squad.description
      }, now)
      return squad
    })
  }

  async archiveSquad(id: string, options?: MutationOptions | number): Promise<ProjectSquad> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const squad = squadFrom(state, requiredId(id, 'squad id'))
      activeWorkspaceFrom(state, squad.projectId)
      this.persistence.assertEntityRevision(squad.revision, options, 'squad')
      if (squad.status === 'archived') return squad
      squad.status = 'archived'
      squad.archivedAt = now
      squad.updatedAt = now
      squad.revision += 1
      appendEvent(state, squad.projectId, 'squad', squad.id, 'squad.archived', squad.revision, {
        status: squad.status
      }, now)
      return squad
    })
  }

  async restoreSquad(id: string, options?: MutationOptions | number): Promise<ProjectSquad> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const squad = squadFrom(state, requiredId(id, 'squad id'))
      activeWorkspaceFrom(state, squad.projectId)
      this.persistence.assertEntityRevision(squad.revision, options, 'squad')
      if (squad.status === 'active') return squad
      assertMemberReferences(this.persistence.rootDir, squad.projectId, squad.members, true)
      squad.status = 'active'
      squad.archivedAt = undefined
      squad.updatedAt = now
      squad.revision += 1
      appendEvent(state, squad.projectId, 'squad', squad.id, 'squad.restored', squad.revision, {
        status: squad.status
      }, now)
      return squad
    })
  }

  async addSquadMember(
    id: string,
    input: ProjectSquadMemberInput,
    options?: MutationOptions | number
  ): Promise<ProjectSquad> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const squad = activeSquadFrom(state, requiredId(id, 'squad id'))
      activeWorkspaceFrom(state, squad.projectId)
      this.persistence.assertEntityRevision(squad.revision, options, 'squad')
      const member = normalizeSquadMember(input, squad.members.length, now)
      if (squad.members.some((candidate) => memberKey(candidate) === memberKey(member))) {
        throw new ProjectWorkspaceError('already_exists', `squad member ${memberKey(member)} already exists`)
      }
      assertMemberReferences(this.persistence.rootDir, squad.projectId, [member], true)
      squad.members.push(member)
      squad.members.sort(compareMembers)
      squad.updatedAt = now
      squad.revision += 1
      appendEvent(state, squad.projectId, 'squad', squad.id, 'squad.member_added', squad.revision, {
        member
      }, now)
      return squad
    })
  }

  async removeSquadMember(
    id: string,
    memberType: WorkItemOwnerType,
    memberId: string,
    options?: MutationOptions | number
  ): Promise<ProjectSquad> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const squad = activeSquadFrom(state, requiredId(id, 'squad id'))
      activeWorkspaceFrom(state, squad.projectId)
      this.persistence.assertEntityRevision(squad.revision, options, 'squad')
      const key = memberKey({ type: normalizeOwnerType(memberType), id: requiredId(memberId, 'squad member id') })
      const index = squad.members.findIndex((candidate) => memberKey(candidate) === key)
      if (index < 0) throw new ProjectWorkspaceError('not_found', `squad member ${key} was not found`)
      const [member] = squad.members.splice(index, 1)
      squad.updatedAt = now
      squad.revision += 1
      appendEvent(state, squad.projectId, 'squad', squad.id, 'squad.member_removed', squad.revision, {
        member
      }, now)
      return squad
    })
  }

  async listComments(workItemId: string, options: ListOptions = {}): Promise<WorkItemComment[]> {
    const state = await this.persistence.read()
    const item = workItemFrom(state, requiredId(workItemId, 'comment workItemId'))
    return state.comments
      .filter((comment) => comment.workItemId === item.id)
      .filter((comment) => options.includeDeleted || comment.status !== 'deleted')
      .filter((comment) => options.includeDeleted || workspaceFrom(state, comment.projectId).status !== 'deleted')
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .map(clone)
  }

  async listProjectComments(projectId?: string, options: ListOptions = {}): Promise<WorkItemComment[]> {
    const state = await this.persistence.read()
    if (projectId !== undefined) requiredId(projectId, 'projectId')
    return state.comments
      .filter((comment) => projectId === undefined || comment.projectId === projectId)
      .filter((comment) => options.includeDeleted || comment.status !== 'deleted')
      .filter((comment) => options.includeDeleted || workspaceFrom(state, comment.projectId).status !== 'deleted')
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .map(clone)
  }

  async getComment(id: string): Promise<WorkItemComment | undefined> {
    const state = await this.persistence.read()
    const comment = state.comments.find((candidate) => candidate.id === requiredId(id, 'comment id'))
    return comment ? clone(comment) : undefined
  }

  async createComment(
    input: WorkItemCommentInput,
    options?: MutationOptions | number
  ): Promise<WorkItemComment> {
    return this.persistence.mutate(options, ({ state, now }) => {
      this.persistence.assertCreateRevision(state, options)
      const projectId = requiredId(input.projectId, 'comment projectId')
      activeWorkspaceFrom(state, projectId)
      const item = workItemFrom(state, requiredId(input.workItemId, 'comment workItemId'))
      if (item.projectId !== projectId) {
        throw new ProjectWorkspaceError('cross_project', 'comment WorkItem crosses project boundary')
      }
      const id = optionalId(input.id, 'comment id') ?? randomUUID()
      if (state.comments.some((candidate) => candidate.id === id)) {
        throw new ProjectWorkspaceError('already_exists', `comment ${id} already exists`)
      }
      const author = normalizeActor(input.author, 'comment author')
      const mentions = normalizeActors(input.mentions, 'comment mention')
      assertActorReferences(this.persistence.rootDir, projectId, [author], true)
      assertActorReferences(this.persistence.rootDir, projectId, mentions, false)
      const createdAt = timestamp(input.createdAt, 'comment createdAt', now)
      const comment: WorkItemComment = {
        schemaVersion: PROJECT_WORKSPACE_SCHEMA_VERSION,
        id,
        projectId,
        workItemId: item.id,
        author,
        body: requiredText(input.body, 'comment body'),
        mentions,
        status: 'active',
        createdAt,
        updatedAt: timestamp(input.updatedAt, 'comment updatedAt', createdAt),
        revision: 1
      }
      state.comments.push(comment)
      appendEvent(state, projectId, 'comment', id, 'comment.created', 1, commentEventPayload(comment), now)
      return comment
    })
  }

  async updateComment(
    id: string,
    patch: WorkItemCommentPatch,
    options?: MutationOptions | number
  ): Promise<WorkItemComment> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const comment = activeCommentFrom(state, requiredId(id, 'comment id'))
      activeWorkspaceFrom(state, comment.projectId)
      this.persistence.assertEntityRevision(comment.revision, options, 'comment')
      if (patch.body !== undefined) comment.body = requiredText(patch.body, 'comment body')
      if (patch.mentions !== undefined) {
        const mentions = normalizeActors(patch.mentions, 'comment mention')
        assertActorReferences(this.persistence.rootDir, comment.projectId, mentions, false)
        comment.mentions = mentions
      }
      comment.updatedAt = now
      comment.revision += 1
      appendEvent(state, comment.projectId, 'comment', comment.id, 'comment.updated', comment.revision, commentEventPayload(comment), now)
      return comment
    })
  }

  async deleteComment(id: string, options?: MutationOptions | number): Promise<WorkItemComment> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const comment = commentFrom(state, requiredId(id, 'comment id'))
      activeWorkspaceFrom(state, comment.projectId)
      this.persistence.assertEntityRevision(comment.revision, options, 'comment')
      if (comment.status === 'deleted') return comment
      comment.body = ''
      comment.mentions = []
      comment.status = 'deleted'
      comment.deletedAt = now
      comment.updatedAt = now
      comment.revision += 1
      appendEvent(state, comment.projectId, 'comment', comment.id, 'comment.deleted', comment.revision, {
        workItemId: comment.workItemId,
        author: comment.author,
        status: comment.status
      }, now)
      return comment
    })
  }
}

function activeSquadFrom(state: ProjectWorkspaceState, id: string): ProjectSquad {
  const squad = squadFrom(state, id)
  if (squad.status === 'archived') throw new ProjectWorkspaceError('archived', `squad ${id} is archived`)
  return squad
}

function activeCommentFrom(state: ProjectWorkspaceState, id: string): WorkItemComment {
  const comment = commentFrom(state, id)
  if (comment.status === 'deleted') throw new ProjectWorkspaceError('deleted', `comment ${id} is deleted`)
  return comment
}

function normalizeSquadMembers(inputs: ProjectSquadMemberInput[] | undefined, now: number): ProjectSquadMember[] {
  if (inputs === undefined) return []
  if (!Array.isArray(inputs)) throw new ProjectWorkspaceError('invalid_input', 'squad members must be an array')
  const members = inputs.map((input, index) => normalizeSquadMember(input, index, now)).sort(compareMembers)
  const keys = new Set<string>()
  for (const member of members) {
    const key = memberKey(member)
    if (keys.has(key)) throw new ProjectWorkspaceError('invalid_input', `duplicate squad member ${key}`)
    keys.add(key)
  }
  return members
}

function normalizeSquadMember(input: ProjectSquadMemberInput, index: number, now: number): ProjectSquadMember {
  if (!input || typeof input !== 'object') {
    throw new ProjectWorkspaceError('invalid_input', `squad member ${index} must be an object`)
  }
  return {
    type: normalizeOwnerType(input.type),
    id: requiredId(input.id, `squad member ${index} id`),
    displayName: optionalText(input.displayName, `squad member ${index} displayName`),
    role: optionalText(input.role, `squad member ${index} role`),
    joinedAt: timestamp(input.joinedAt, `squad member ${index} joinedAt`, now)
  }
}

function normalizeActors(inputs: WorkItemActor[] | undefined, label: string): WorkItemActor[] {
  if (inputs === undefined) return []
  if (!Array.isArray(inputs)) throw new ProjectWorkspaceError('invalid_input', `${label}s must be an array`)
  const actors = inputs.map((actor, index) => normalizeActor(actor, `${label} ${index}`))
  const ids = new Set<string>()
  for (const actor of actors) {
    const key = `${actor.type}:${actor.id}`
    if (ids.has(key)) throw new ProjectWorkspaceError('invalid_input', `duplicate ${label} ${key}`)
    ids.add(key)
  }
  return actors
}

function normalizeActor(value: WorkItemActor, label: string): WorkItemActor {
  if (!value || typeof value !== 'object') throw new ProjectWorkspaceError('invalid_input', `${label} must be an object`)
  if (value.type !== 'local_user' && value.type !== 'human' && value.type !== 'digital_worker') {
    throw new ProjectWorkspaceError('invalid_input', `${label} type is invalid`)
  }
  return {
    type: value.type,
    id: requiredId(value.id, `${label} id`),
    displayName: optionalText(value.displayName, `${label} displayName`)
  }
}

function normalizeOwnerType(value: unknown): WorkItemOwnerType {
  if (value !== 'human' && value !== 'digital_worker') {
    throw new ProjectWorkspaceError('invalid_input', 'squad member type is invalid')
  }
  return value
}

function assertMemberReferences(
  rootDir: string,
  projectId: string,
  members: readonly ProjectSquadMember[],
  requireActive: boolean
): void {
  assertActorReferences(rootDir, projectId, members, requireActive)
}

function assertActorReferences(
  rootDir: string,
  projectId: string,
  actors: readonly Pick<WorkItemActor, 'type' | 'id'>[],
  requireActive: boolean
): void {
  const workerActors = actors.filter((actor) => actor.type === 'digital_worker')
  if (workerActors.length === 0) return
  const workers = new DigitalWorkerStore(rootDir).read().workers
  for (const actor of workerActors) {
    const worker = workers.find((candidate) => candidate.id === actor.id)
    if (!worker) throw new ProjectWorkspaceError('not_found', `DigitalWorker ${actor.id} was not found`)
    if (worker.projectId !== projectId) {
      throw new ProjectWorkspaceError('cross_project', `DigitalWorker ${actor.id} crosses project boundary`)
    }
    if (requireActive && worker.status !== 'active') {
      throw new ProjectWorkspaceError('invalid_input', `DigitalWorker ${actor.id} is not active`)
    }
  }
}

function squadEventPayload(squad: ProjectSquad): Record<string, unknown> {
  return {
    name: squad.name,
    description: squad.description,
    status: squad.status,
    createdBy: squad.createdBy,
    members: squad.members
  }
}

function commentEventPayload(comment: WorkItemComment): Record<string, unknown> {
  return {
    workItemId: comment.workItemId,
    author: comment.author,
    mentions: comment.mentions,
    bodyDigest: digest(comment.body),
    status: comment.status
  }
}

function memberKey(member: Pick<ProjectSquadMember, 'type' | 'id'>): string {
  return `${member.type}:${member.id}`
}

function compareMembers(left: ProjectSquadMember, right: ProjectSquadMember): number {
  return memberKey(left).localeCompare(memberKey(right))
}
