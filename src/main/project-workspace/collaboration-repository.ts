import { randomBytes, randomUUID } from 'node:crypto'
import type {
  MutationOptions,
  ProjectMember,
  ProjectMemberInput,
  ProjectMemberPatch,
  ProjectMemberRole,
  ProjectInvitation,
  ProjectInvitationCreateResult,
  ProjectInvitationInput,
  ProjectSquad,
  ProjectSquadInput,
  ProjectSquadMember,
  ProjectSquadMemberInput,
  ProjectSquadPatch,
  ProjectWorkspaceState,
  ProjectCollaborationInboxItem,
  ProjectCollaborationInboxListOptions,
  ProjectCollaborationInboxMarkInput,
  ProjectCollaborationInboxReceipt,
  ProjectCollaborationInboxSourceKind,
  WorkItemActor,
  WorkItemComment,
  WorkItemCommentInput,
  WorkItemCommentPatch,
  WorkItemSharedApproval,
  WorkItemSharedApprovalDecisionInput,
  WorkItemSharedApprovalInput,
  WorkItemOwner,
  WorkItemOwnerType
} from '../../shared/project-workspace-types'
import { PROJECT_WORKSPACE_SCHEMA_VERSION } from '../../shared/project-workspace-types'
import { DigitalWorkerStore } from '../digital-worker/domain-store'
import { clone, digest, optionalId, optionalText, requiredId, requiredText, timestamp } from './codec'
import { ProjectWorkspaceError } from './errors'
import { appendEvent, ProjectWorkspacePersistence } from './persistence'
import type { ListOptions } from './repository-types'
import { LOCAL_USER_ACTOR } from './work-item-authorization'
import { assertProjectAuthorized } from './project-authorization'
import {
  activeWorkspaceFrom,
  commentFrom,
  memberFrom,
  sharedApprovalFrom,
  squadFrom,
  workItemFrom,
  workspaceFrom
} from './state-access'

export class ProjectCollaborationRepository {
  constructor(private readonly persistence: ProjectWorkspacePersistence) {}

  async listMembers(projectId?: string, options: ListOptions = {}): Promise<ProjectMember[]> {
    const state = await this.persistence.read()
    if (projectId !== undefined) requiredId(projectId, 'projectId')
    return state.members
      .filter((member) => projectId === undefined || member.projectId === projectId)
      .filter((member) => options.includeArchived !== false || member.status === 'active')
      .filter((member) => options.includeDeleted || workspaceFrom(state, member.projectId).status !== 'deleted')
      .sort((left, right) => actorLabel(left.principal).localeCompare(actorLabel(right.principal)))
      .map(clone)
  }

  async listCollaborationInbox(
    projectId: string,
    options: ProjectCollaborationInboxListOptions = {}
  ): Promise<ProjectCollaborationInboxItem[]> {
    const state = await this.persistence.read()
    const project = activeWorkspaceFrom(state, requiredId(projectId, 'inbox projectId'))
    assertProjectAuthorized(state, project, LOCAL_USER_ACTOR, 'view')
    const memberId = options.memberId === undefined ? undefined : requiredId(options.memberId, 'inbox memberId')
    if (memberId !== undefined) {
      const member = activeMemberFrom(state, memberId)
      if (member.projectId !== project.id) throw new ProjectWorkspaceError('cross_project', 'inbox member crosses project boundary')
    }
    const members = state.members.filter((member) => member.projectId === project.id && member.status === 'active' &&
      (memberId === undefined || member.id === memberId))
    const items = members.flatMap((member) => deriveInboxItems(state, project.id, member, options))
    return items.sort((left, right) => inboxPriority(right) - inboxPriority(left) || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
  }

  async markCollaborationInbox(
    input: ProjectCollaborationInboxMarkInput,
    options?: MutationOptions | number
  ): Promise<ProjectCollaborationInboxReceipt> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const projectId = requiredId(input.projectId, 'inbox projectId')
      const project = activeWorkspaceFrom(state, projectId)
      const member = state.members.find((candidate) => candidate.projectId === projectId && deriveInboxItems(state, projectId, candidate, { includeHandled: true }).some((item) => item.id === input.itemId))
      if (!member || member.status !== 'active') throw new ProjectWorkspaceError('not_found', `inbox item ${input.itemId} not found`)
      assertProjectAuthorized(state, project, mutationActor(options), 'view')
      if (input.status !== 'read' && input.status !== 'handled') throw new ProjectWorkspaceError('invalid_input', 'inbox status is invalid')
      if (!Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 1) throw new ProjectWorkspaceError('invalid_input', 'inbox sourceRevision is invalid')
      const derived = deriveInboxItems(state, projectId, member, { includeHandled: true }).find((item) => item.id === input.itemId)
      if (!derived) throw new ProjectWorkspaceError('not_found', `inbox item ${input.itemId} not found`)
      if (derived.sourceRevision !== input.sourceRevision) throw new ProjectWorkspaceError('conflict', 'inbox item changed; refresh before updating')
      const [sourceKind, sourceId] = [derived.sourceKind, derived.sourceId]
      const existing = state.inboxReceipts.find((receipt) => receipt.projectId === projectId && receipt.memberId === member.id && receipt.sourceKind === sourceKind && receipt.sourceId === sourceId)
      if (existing) {
        this.persistence.assertEntityRevision(existing.revision, options, 'inbox receipt')
        existing.sourceRevision = input.sourceRevision
        existing.status = input.status
        existing.readAt = existing.readAt || now
        existing.handledAt = input.status === 'handled' ? (existing.handledAt || now) : undefined
        existing.updatedAt = now
        existing.revision += 1
        appendEvent(state, projectId, 'inbox_receipt', existing.id, 'inbox_receipt.updated', existing.revision, { memberId: member.id, sourceKind, sourceId, sourceRevision: input.sourceRevision, status: input.status }, now)
        return existing
      }
      const receipt: ProjectCollaborationInboxReceipt = {
        schemaVersion: PROJECT_WORKSPACE_SCHEMA_VERSION,
        id: `inbox-receipt:${member.id}:${sourceKind}:${sourceId}`,
        projectId,
        memberId: member.id,
        sourceKind,
        sourceId,
        sourceRevision: input.sourceRevision,
        status: input.status,
        readAt: now,
        ...(input.status === 'handled' ? { handledAt: now } : {}),
        updatedAt: now,
        revision: 1
      }
      state.inboxReceipts.push(receipt)
      appendEvent(state, projectId, 'inbox_receipt', receipt.id, 'inbox_receipt.created', 1, { memberId: member.id, sourceKind, sourceId, sourceRevision: input.sourceRevision, status: input.status }, now)
      return receipt
    })
  }

  async getMember(id: string): Promise<ProjectMember | undefined> {
    const state = await this.persistence.read()
    const member = state.members.find((candidate) => candidate.id === requiredId(id, 'member id'))
    return member ? clone(member) : undefined
  }

  async createMember(input: ProjectMemberInput, options?: MutationOptions | number): Promise<ProjectMember> {
    return this.persistence.mutate(options, ({ state, now }) => {
      this.persistence.assertCreateRevision(state, options)
      const projectId = requiredId(input.projectId, 'member projectId')
      const project = activeWorkspaceFrom(state, projectId)
      assertProjectAuthorized(state, project, mutationActor(options), 'manage_members')
      const principal = normalizePrincipal(input.principal, 'member principal')
      assertActorReferences(this.persistence.rootDir, state, projectId, [principal], principal.type === 'digital_worker')
      if (state.members.some((candidate) => candidate.projectId === projectId &&
        candidate.principal.type === principal.type && candidate.principal.id === principal.id)) {
        throw new ProjectWorkspaceError('already_exists', `Project member ${principal.type}:${principal.id} already exists`)
      }
      const id = optionalId(input.id, 'member id') ?? randomUUID()
      if (state.members.some((candidate) => candidate.id === id)) {
        throw new ProjectWorkspaceError('already_exists', `member ${id} already exists`)
      }
      const joinedAt = timestamp(input.joinedAt, 'member joinedAt', now)
      const member: ProjectMember = {
        schemaVersion: PROJECT_WORKSPACE_SCHEMA_VERSION,
        id,
        projectId,
        principal,
        role: normalizeMemberRole(input.role ?? 'viewer'),
        status: 'active',
        joinedAt,
        updatedAt: timestamp(input.updatedAt, 'member updatedAt', joinedAt),
        revision: 1
      }
      state.members.push(member)
      appendEvent(state, projectId, 'member', id, 'member.created', 1, memberEventPayload(member), now)
      return member
    })
  }

  async updateMember(id: string, patch: ProjectMemberPatch, options?: MutationOptions | number): Promise<ProjectMember> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const member = activeMemberFrom(state, requiredId(id, 'member id'))
      const project = activeWorkspaceFrom(state, member.projectId)
      assertProjectAuthorized(state, project, mutationActor(options), 'manage_members')
      this.persistence.assertEntityRevision(member.revision, options, 'member')
      if (patch.displayName !== undefined) {
        member.principal.displayName = optionalText(patch.displayName, 'member displayName')
      }
      if (patch.role !== undefined) member.role = normalizeMemberRole(patch.role)
      member.updatedAt = now
      member.revision += 1
      appendEvent(state, member.projectId, 'member', member.id, 'member.updated', member.revision, memberEventPayload(member), now)
      return member
    })
  }

  async revokeMember(id: string, options?: MutationOptions | number): Promise<ProjectMember> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const member = memberFrom(state, requiredId(id, 'member id'))
      const project = activeWorkspaceFrom(state, member.projectId)
      assertProjectAuthorized(state, project, mutationActor(options), 'manage_members')
      this.persistence.assertEntityRevision(member.revision, options, 'member')
      if (member.status === 'revoked') return member
      member.status = 'revoked'
      member.revokedAt = now
      member.updatedAt = now
      member.revision += 1
      appendEvent(state, member.projectId, 'member', member.id, 'member.revoked', member.revision, memberEventPayload(member), now)
      return member
    })
  }

  async restoreMember(id: string, options?: MutationOptions | number): Promise<ProjectMember> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const member = memberFrom(state, requiredId(id, 'member id'))
      const project = activeWorkspaceFrom(state, member.projectId)
      assertProjectAuthorized(state, project, mutationActor(options), 'manage_members')
      this.persistence.assertEntityRevision(member.revision, options, 'member')
      if (member.status === 'active') return member
      assertActorReferences(this.persistence.rootDir, state, member.projectId, [member.principal], true)
      member.status = 'active'
      member.revokedAt = undefined
      member.updatedAt = now
      member.revision += 1
      appendEvent(state, member.projectId, 'member', member.id, 'member.restored', member.revision, memberEventPayload(member), now)
      return member
    })
  }

  async listInvitations(projectId?: string, options: ListOptions = {}): Promise<ProjectInvitation[]> {
    const state = await this.persistence.read()
    if (projectId !== undefined) requiredId(projectId, 'projectId')
    return state.invitations
      .filter((invitation) => projectId === undefined || invitation.projectId === projectId)
      .filter((invitation) => options.includeArchived !== false || invitation.status === 'pending')
      .filter((invitation) => options.includeDeleted || workspaceFrom(state, invitation.projectId).status !== 'deleted')
      .map((invitation) => expireInvitationIfNeeded(invitation))
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
      .map(clone)
  }

  async createInvitation(input: ProjectInvitationInput, options?: MutationOptions | number): Promise<ProjectInvitationCreateResult> {
    return this.persistence.mutate(options, ({ state, now }) => {
      this.persistence.assertCreateRevision(state, options)
      const projectId = requiredId(input.projectId, 'invitation projectId')
      const project = activeWorkspaceFrom(state, projectId)
      assertProjectAuthorized(state, project, mutationActor(options), 'manage_invitations')
      const principal = normalizePrincipal(input.principal, 'invitation principal')
      assertActorReferences(this.persistence.rootDir, state, projectId, [principal], principal.type === 'digital_worker')
      if (state.members.some((member) => member.projectId === projectId && member.status === 'active' &&
        member.principal.type === principal.type && member.principal.id === principal.id)) {
        throw new ProjectWorkspaceError('already_exists', `Project member ${principal.type}:${principal.id} already exists`)
      }
      if (state.invitations.some((invitation) => invitation.projectId === projectId && invitation.status === 'pending' &&
        invitation.principal.type === principal.type && invitation.principal.id === principal.id)) {
        throw new ProjectWorkspaceError('already_exists', `Pending invitation for ${principal.type}:${principal.id} already exists`)
      }
      const id = optionalId(input.id, 'invitation id') ?? randomUUID()
      if (state.invitations.some((candidate) => candidate.id === id) || state.members.some((candidate) => candidate.id === id)) {
        throw new ProjectWorkspaceError('already_exists', `invitation ${id} already exists`)
      }
      const expiresAt = timestamp(input.expiresAt, 'invitation expiresAt', now + 7 * 24 * 60 * 60 * 1000)
      if (expiresAt <= now) throw new ProjectWorkspaceError('invalid_input', 'invitation expiresAt must be in the future')
      const token = randomBytes(32).toString('base64url')
      const invitation: ProjectInvitation = {
        schemaVersion: PROJECT_WORKSPACE_SCHEMA_VERSION,
        id,
        projectId,
        principal,
        role: normalizeInvitationRole(input.role),
        tokenDigest: digest(token),
        status: 'pending',
        expiresAt,
        createdAt: timestamp(input.createdAt, 'invitation createdAt', now),
        updatedAt: now,
        revision: 1
      }
      state.invitations.push(invitation)
      appendEvent(state, projectId, 'invitation', id, 'invitation.created', 1, invitationEventPayload(invitation), now)
      return { invitation, token }
    })
  }

  async acceptInvitation(projectId: string, token: string, options?: MutationOptions | number): Promise<ProjectMember> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const normalizedProjectId = requiredId(projectId, 'invitation projectId')
      activeWorkspaceFrom(state, normalizedProjectId)
      const normalizedToken = requiredText(token, 'invitation token')
      const invitation = state.invitations.find((candidate) => candidate.projectId === normalizedProjectId && candidate.tokenDigest === digest(normalizedToken))
      if (!invitation) throw new ProjectWorkspaceError('not_found', 'invitation token is invalid')
      if (invitation.status === 'accepted' && invitation.acceptedMemberId) {
        const member = state.members.find((candidate) => candidate.id === invitation.acceptedMemberId)
        if (member) return member
      }
      if (invitation.status === 'revoked') throw new ProjectWorkspaceError('forbidden', 'invitation has been revoked')
      if (invitation.status === 'expired' || invitation.expiresAt <= now) {
        if (invitation.status !== 'expired') {
          invitation.status = 'expired'
          invitation.updatedAt = now
          invitation.revision += 1
          appendEvent(state, normalizedProjectId, 'invitation', invitation.id, 'invitation.expired', invitation.revision, invitationEventPayload(invitation), now)
        }
        throw new ProjectWorkspaceError('forbidden', 'invitation has expired')
      }
      const existing = state.members.find((member) => member.projectId === normalizedProjectId &&
        member.principal.type === invitation.principal.type && member.principal.id === invitation.principal.id)
      if (existing) {
        invitation.status = 'accepted'
        invitation.acceptedMemberId = existing.id
        invitation.acceptedAt = invitation.acceptedAt ?? now
        invitation.updatedAt = now
        invitation.revision += 1
        appendEvent(state, normalizedProjectId, 'invitation', invitation.id, 'invitation.accepted', invitation.revision, invitationEventPayload(invitation), now)
        return existing
      }
      const member: ProjectMember = {
        schemaVersion: PROJECT_WORKSPACE_SCHEMA_VERSION,
        id: randomUUID(),
        projectId: normalizedProjectId,
        principal: clone(invitation.principal),
        role: invitation.role,
        status: 'active',
        joinedAt: now,
        updatedAt: now,
        revision: 1
      }
      state.members.push(member)
      appendEvent(state, normalizedProjectId, 'member', member.id, 'member.created', 1, memberEventPayload(member), now)
      invitation.status = 'accepted'
      invitation.acceptedMemberId = member.id
      invitation.acceptedAt = now
      invitation.updatedAt = now
      invitation.revision += 1
      appendEvent(state, normalizedProjectId, 'invitation', invitation.id, 'invitation.accepted', invitation.revision, invitationEventPayload(invitation), now)
      return member
    })
  }

  async revokeInvitation(id: string, options?: MutationOptions | number): Promise<ProjectInvitation> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const invitation = state.invitations.find((candidate) => candidate.id === requiredId(id, 'invitation id'))
      if (!invitation) throw new ProjectWorkspaceError('not_found', `invitation ${id} not found`)
      const project = activeWorkspaceFrom(state, invitation.projectId)
      assertProjectAuthorized(state, project, mutationActor(options), 'manage_invitations')
      this.persistence.assertEntityRevision(invitation.revision, options, 'invitation')
      if (invitation.status === 'revoked') return invitation
      if (invitation.status === 'accepted') throw new ProjectWorkspaceError('conflict', 'accepted invitation cannot be revoked')
      invitation.status = invitation.expiresAt <= now ? 'expired' : 'revoked'
      invitation.revokedAt = invitation.status === 'revoked' ? now : undefined
      invitation.updatedAt = now
      invitation.revision += 1
      appendEvent(state, invitation.projectId, 'invitation', invitation.id, `invitation.${invitation.status}`, invitation.revision, invitationEventPayload(invitation), now)
      return invitation
    })
  }

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
      const project = activeWorkspaceFrom(state, projectId)
      assertProjectAuthorized(state, project, mutationActor(options), 'manage_squads')
      const id = optionalId(input.id, 'squad id') ?? randomUUID()
      if (state.squads.some((candidate) => candidate.id === id)) {
        throw new ProjectWorkspaceError('already_exists', `squad ${id} already exists`)
      }
      const members = normalizeSquadMembers(input.members, now)
      assertMemberReferences(this.persistence.rootDir, state, projectId, members, true)
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
      const project = activeWorkspaceFrom(state, squad.projectId)
      assertProjectAuthorized(state, project, mutationActor(options), 'manage_squads')
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
      const project = activeWorkspaceFrom(state, squad.projectId)
      assertProjectAuthorized(state, project, mutationActor(options), 'manage_squads')
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
      const project = activeWorkspaceFrom(state, squad.projectId)
      assertProjectAuthorized(state, project, mutationActor(options), 'manage_squads')
      this.persistence.assertEntityRevision(squad.revision, options, 'squad')
      if (squad.status === 'active') return squad
      assertMemberReferences(this.persistence.rootDir, state, squad.projectId, squad.members, true)
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
      const project = activeWorkspaceFrom(state, squad.projectId)
      assertProjectAuthorized(state, project, mutationActor(options), 'manage_squads')
      this.persistence.assertEntityRevision(squad.revision, options, 'squad')
      const member = normalizeSquadMember(input, squad.members.length, now)
      if (squad.members.some((candidate) => memberKey(candidate) === memberKey(member))) {
        throw new ProjectWorkspaceError('already_exists', `squad member ${memberKey(member)} already exists`)
      }
      assertMemberReferences(this.persistence.rootDir, state, squad.projectId, [member], true)
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
      const project = activeWorkspaceFrom(state, squad.projectId)
      assertProjectAuthorized(state, project, mutationActor(options), 'manage_squads')
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
      const project = activeWorkspaceFrom(state, projectId)
      assertProjectAuthorized(state, project, mutationActor(options, input.author), 'comment')
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
      assertActorReferences(this.persistence.rootDir, state, projectId, [author], true)
      assertActorReferences(this.persistence.rootDir, state, projectId, mentions, false)
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
      const project = activeWorkspaceFrom(state, comment.projectId)
      assertProjectAuthorized(state, project, mutationActor(options), 'comment')
      this.persistence.assertEntityRevision(comment.revision, options, 'comment')
      if (patch.body !== undefined) comment.body = requiredText(patch.body, 'comment body')
      if (patch.mentions !== undefined) {
        const mentions = normalizeActors(patch.mentions, 'comment mention')
        assertActorReferences(this.persistence.rootDir, state, comment.projectId, mentions, false)
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
      const project = activeWorkspaceFrom(state, comment.projectId)
      assertProjectAuthorized(state, project, mutationActor(options), 'comment')
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

  async listSharedApprovals(projectId?: string, options: ListOptions = {}): Promise<WorkItemSharedApproval[]> {
    const state = await this.persistence.read()
    if (projectId !== undefined) requiredId(projectId, 'projectId')
    return state.sharedApprovals
      .filter((approval) => projectId === undefined || approval.projectId === projectId)
      .filter((approval) => options.includeDeleted || workspaceFrom(state, approval.projectId).status !== 'deleted')
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
      .map(clone)
  }

  async getSharedApproval(id: string): Promise<WorkItemSharedApproval | undefined> {
    const state = await this.persistence.read()
    const approval = state.sharedApprovals.find((candidate) => candidate.id === requiredId(id, 'shared approval id'))
    return approval ? clone(approval) : undefined
  }

  async createSharedApproval(
    input: WorkItemSharedApprovalInput,
    requester: WorkItemActor,
    options?: MutationOptions | number
  ): Promise<WorkItemSharedApproval> {
    return this.persistence.mutate(options, ({ state, now }) => {
      this.persistence.assertCreateRevision(state, options)
      const projectId = requiredId(input.projectId, 'shared approval projectId')
      const requesterActor = normalizeActor(requester, 'shared approval requester')
      const project = activeWorkspaceFrom(state, projectId)
      assertProjectAuthorized(state, project, mutationActor(options, requesterActor), 'edit')
      const workItem = workItemFrom(state, requiredId(input.workItemId, 'shared approval workItemId'))
      if (workItem.projectId !== projectId) {
        throw new ProjectWorkspaceError('cross_project', 'shared approval WorkItem crosses project boundary')
      }
      const goalId = optionalId(input.goalId, 'shared approval goalId')
      if (goalId && (workItem.goalId !== goalId || !state.goals.some((goal) => goal.id === goalId && goal.projectId === projectId))) {
        throw new ProjectWorkspaceError('cross_project', 'shared approval Goal does not own the WorkItem')
      }
      const approverMemberIds = normalizeApproverMemberIds(input.approverMemberIds)
      const approvers = approverMemberIds.map((memberId) => activeMemberFrom(state, memberId))
      for (const member of approvers) {
        if (member.projectId !== projectId) throw new ProjectWorkspaceError('cross_project', `approver ${member.id} crosses project boundary`)
        assertApprovalRole(member.role)
      }
      const requiredApprovals = input.requiredApprovals ?? approverMemberIds.length
      if (!Number.isSafeInteger(requiredApprovals) || requiredApprovals < 1 || requiredApprovals > approverMemberIds.length) {
        throw new ProjectWorkspaceError('invalid_input', 'requiredApprovals must be within the approver count')
      }
      const expiresAt = input.expiresAt === undefined ? undefined : timestamp(input.expiresAt, 'shared approval expiresAt', now)
      if (expiresAt !== undefined && expiresAt <= now) {
        throw new ProjectWorkspaceError('invalid_input', 'shared approval expiresAt must be in the future')
      }
      const id = optionalId(input.id, 'shared approval id') ?? randomUUID()
      if (state.sharedApprovals.some((candidate) => candidate.id === id)) {
        throw new ProjectWorkspaceError('already_exists', `shared approval ${id} already exists`)
      }
      const createdAt = timestamp(input.createdAt, 'shared approval createdAt', now)
      const approval: WorkItemSharedApproval = {
        schemaVersion: PROJECT_WORKSPACE_SCHEMA_VERSION,
        id,
        projectId,
        workItemId: workItem.id,
        goalId,
        acceptanceId: optionalId(input.acceptanceId, 'shared approval acceptanceId'),
        effectId: optionalId(input.effectId, 'shared approval effectId'),
        title: requiredText(input.title, 'shared approval title'),
        requester: requesterActor,
        approverMemberIds,
        requiredApprovals,
        decisions: [],
        status: 'pending',
        expiresAt,
        createdAt,
        updatedAt: timestamp(input.updatedAt, 'shared approval updatedAt', createdAt),
        revision: 1
      }
      state.sharedApprovals.push(approval)
      appendEvent(state, projectId, 'shared_approval', id, 'shared_approval.created', 1, approvalEventPayload(approval), now)
      return approval
    })
  }

  async decideSharedApproval(
    id: string,
    input: WorkItemSharedApprovalDecisionInput,
    options?: MutationOptions | number
  ): Promise<WorkItemSharedApproval> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const approval = sharedApprovalFrom(state, requiredId(id, 'shared approval id'))
      const project = activeWorkspaceFrom(state, approval.projectId)
      assertProjectAuthorized(state, project, mutationActor(options), 'approve')
      this.persistence.assertEntityRevision(approval.revision, options, 'shared approval')
      if (approval.status !== 'pending') return approval
      if (approval.expiresAt !== undefined && approval.expiresAt <= now) {
        approval.status = 'expired'
        approval.resolvedAt = now
        approval.updatedAt = now
        approval.revision += 1
        appendEvent(state, approval.projectId, 'shared_approval', approval.id, 'shared_approval.expired', approval.revision, approvalEventPayload(approval), now)
        return approval
      }
      const memberId = requiredId(input.memberId, 'shared approval memberId')
      if (!approval.approverMemberIds.includes(memberId)) {
        throw new ProjectWorkspaceError('forbidden', `member ${memberId} is not an approver`)
      }
      const member = activeMemberFrom(state, memberId)
      if (member.projectId !== approval.projectId) throw new ProjectWorkspaceError('cross_project', 'approval member crosses project boundary')
      assertMemberActorMatchesDecision(member, mutationActor(options))
      assertApprovalRole(member.role)
      if (input.decision !== 'approved' && input.decision !== 'rejected') {
        throw new ProjectWorkspaceError('invalid_input', 'shared approval decision is invalid')
      }
      const existing = approval.decisions.find((decision) => decision.memberId === memberId)
      if (existing) {
        if (existing.decision === input.decision && existing.comment === optionalText(input.comment, 'shared approval comment')) return approval
        throw new ProjectWorkspaceError('conflict', `member ${memberId} already decided this approval`)
      }
      approval.decisions.push({
        memberId,
        decision: input.decision,
        comment: optionalText(input.comment, 'shared approval comment'),
        decidedAt: now
      })
      approval.decisions.sort((left, right) => left.decidedAt - right.decidedAt || left.memberId.localeCompare(right.memberId))
      approval.status = deriveApprovalStatus(approval)
      if (approval.status !== 'pending') approval.resolvedAt = now
      approval.updatedAt = now
      approval.revision += 1
      appendEvent(state, approval.projectId, 'shared_approval', approval.id, 'shared_approval.decided', approval.revision, {
        memberId,
        decision: input.decision,
        status: approval.status,
        approvedCount: approval.decisions.filter((decision) => decision.decision === 'approved').length
      }, now)
      return approval
    })
  }

  async revokeSharedApproval(id: string, options?: MutationOptions | number): Promise<WorkItemSharedApproval> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const approval = sharedApprovalFrom(state, requiredId(id, 'shared approval id'))
      const project = activeWorkspaceFrom(state, approval.projectId)
      assertProjectAuthorized(state, project, mutationActor(options), 'approve')
      this.persistence.assertEntityRevision(approval.revision, options, 'shared approval')
      if (approval.status === 'revoked') return approval
      if (approval.status !== 'pending') throw new ProjectWorkspaceError('conflict', 'only a pending shared approval can be revoked')
      approval.status = 'revoked'
      approval.revokedAt = now
      approval.resolvedAt = now
      approval.updatedAt = now
      approval.revision += 1
      appendEvent(state, approval.projectId, 'shared_approval', approval.id, 'shared_approval.revoked', approval.revision, approvalEventPayload(approval), now)
      return approval
    })
  }
}

function deriveInboxItems(
  state: ProjectWorkspaceState,
  projectId: string,
  member: ProjectMember,
  options: ProjectCollaborationInboxListOptions
): ProjectCollaborationInboxItem[] {
  const principalKey = `${member.principal.type}:${member.principal.id}`
  const receiptFor = (sourceKind: ProjectCollaborationInboxSourceKind, sourceId: string, sourceRevision: number) =>
    state.inboxReceipts.find((receipt) => receipt.projectId === projectId && receipt.memberId === member.id &&
      receipt.sourceKind === sourceKind && receipt.sourceId === sourceId && receipt.sourceRevision === sourceRevision)
  const make = (
    sourceKind: ProjectCollaborationInboxSourceKind,
    sourceId: string,
    sourceRevision: number,
    workItemId: string,
    title: string,
    detail: string | undefined,
    action: ProjectCollaborationInboxItem['action'],
    actor: WorkItemActor | undefined,
    createdAt: number,
    updatedAt: number,
    priority: ProjectCollaborationInboxItem['priority']
  ): ProjectCollaborationInboxItem | undefined => {
    const receipt = receiptFor(sourceKind, sourceId, sourceRevision)
    if (!options.includeHandled && receipt?.status === 'handled') return undefined
    return {
      id: `inbox:${member.id}:${sourceKind}:${sourceId}`,
      projectId,
      memberId: member.id,
      sourceKind,
      sourceId,
      sourceRevision,
      workItemId,
      title,
      ...(detail ? { detail } : {}),
      ...(actor ? { actor: clone(actor) } : {}),
      state: receipt?.status ?? 'unread',
      priority,
      action,
      createdAt,
      updatedAt,
      ...(receipt ? { receiptRevision: receipt.revision } : {})
    }
  }
  const items: ProjectCollaborationInboxItem[] = []
  for (const item of state.workItems) {
    if (item.projectId !== projectId || !item.owner || `${item.owner.type}:${item.owner.id}` !== principalKey ||
        ['done', 'cancelled'].includes(item.status)) continue
    const entry = make(
      'work_item_assignment', item.id, item.revision, item.id, item.title,
      item.description, 'open_work_item', item.owner.type === 'human' ? { ...item.owner } : undefined,
      item.createdAt, item.updatedAt, item.status === 'blocked' || item.status === 'failed' ? 'urgent' : 'normal'
    )
    if (entry) items.push(entry)
  }
  for (const comment of state.comments) {
    if (comment.projectId !== projectId || comment.status !== 'active' ||
        !comment.mentions.some((actor) => `${actor.type}:${actor.id}` === principalKey)) continue
    const item = state.workItems.find((candidate) => candidate.id === comment.workItemId)
    if (!item) continue
    const entry = make(
      'comment_mention', comment.id, comment.revision, comment.workItemId,
      `评论提及：${item.title}`, comment.body.slice(0, 240), 'review_comment', comment.author,
      comment.createdAt, comment.updatedAt, 'normal'
    )
    if (entry) items.push(entry)
  }
  for (const approval of state.sharedApprovals) {
    if (approval.projectId !== projectId || !approval.approverMemberIds.includes(member.id) ||
        approval.status !== 'pending' || approval.decisions.some((decision) => decision.memberId === member.id)) continue
    const item = state.workItems.find((candidate) => candidate.id === approval.workItemId)
    if (!item) continue
    const entry = make(
      'shared_approval', approval.id, approval.revision, approval.workItemId,
      approval.title, `待你决定：${item.title}`, 'decide_approval', approval.requester,
      approval.createdAt, approval.updatedAt, 'urgent'
    )
    if (entry) items.push(entry)
  }
  return items
}

function inboxPriority(item: ProjectCollaborationInboxItem): number {
  if (item.state === 'unread' && item.priority === 'urgent') return 4
  if (item.state === 'unread') return 3
  if (item.state === 'read' && item.priority === 'urgent') return 2
  if (item.state === 'read') return 1
  return 0
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

function activeMemberFrom(state: ProjectWorkspaceState, id: string): ProjectMember {
  const member = memberFrom(state, id)
  if (member.status !== 'active') throw new ProjectWorkspaceError('forbidden', `member ${id} is revoked`)
  return member
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
    memberId: optionalId(input.memberId, `squad member ${index} memberId`),
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
  state: ProjectWorkspaceState,
  projectId: string,
  members: readonly ProjectSquadMember[],
  requireActive: boolean
): void {
  for (const member of members) {
    if (!member.memberId) continue
    const identity = state.members.find((candidate) => candidate.id === member.memberId)
    if (!identity || identity.projectId !== projectId || identity.principal.type !== member.type || identity.principal.id !== member.id) {
      throw new ProjectWorkspaceError('cross_project', `squad member ${member.type}:${member.id} has an invalid Project member identity`)
    }
    if (requireActive && identity.status !== 'active') {
      throw new ProjectWorkspaceError('forbidden', `Project member ${identity.id} is revoked`)
    }
  }
  assertActorReferences(rootDir, state, projectId, members, requireActive)
}

function assertActorReferences(
  rootDir: string,
  state: ProjectWorkspaceState,
  projectId: string,
  actors: readonly Pick<WorkItemActor, 'type' | 'id'>[],
  requireActive: boolean
): void {
  const workerActors = actors.filter((actor) => actor.type === 'digital_worker')
  const humanActors = actors.filter((actor) => actor.type === 'human')
  for (const actor of humanActors) {
    const member = state.members.find((candidate) => candidate.projectId === projectId &&
      candidate.principal.type === actor.type && candidate.principal.id === actor.id && candidate.status === 'active')
    if (requireActive && !member) {
      throw new ProjectWorkspaceError('forbidden', `Project member ${actor.id} is not active`)
    }
  }
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

function normalizePrincipal(value: unknown, label: string): WorkItemOwner {
  if (!value || typeof value !== 'object') throw new ProjectWorkspaceError('invalid_input', `${label} must be an object`)
  const principal = value as WorkItemOwner
  if (principal.type !== 'human' && principal.type !== 'digital_worker') {
    throw new ProjectWorkspaceError('invalid_input', `${label} type is invalid`)
  }
  return {
    type: principal.type,
    id: requiredId(principal.id, `${label} id`),
    displayName: optionalText(principal.displayName, `${label} displayName`)
  }
}

function actorLabel(actor: Pick<WorkItemActor | WorkItemOwner, 'id' | 'displayName'>): string {
  return actor.displayName || actor.id
}

function normalizeMemberRole(value: unknown): ProjectMemberRole {
  if (value !== 'owner' && value !== 'admin' && value !== 'editor' && value !== 'reviewer' && value !== 'viewer') {
    throw new ProjectWorkspaceError('invalid_input', 'member role is invalid')
  }
  return value
}

function normalizeInvitationRole(value: unknown): ProjectInvitation['role'] {
  if (value !== 'admin' && value !== 'editor' && value !== 'reviewer' && value !== 'viewer') {
    throw new ProjectWorkspaceError('invalid_input', 'invitation role is invalid')
  }
  return value
}

function expireInvitationIfNeeded(invitation: ProjectInvitation): ProjectInvitation {
  if (invitation.status === 'pending' && invitation.expiresAt <= Date.now()) {
    return { ...invitation, status: 'expired', updatedAt: Date.now() }
  }
  return invitation
}

function assertApprovalRole(role: ProjectMemberRole): void {
  if (role !== 'owner' && role !== 'admin' && role !== 'reviewer') {
    throw new ProjectWorkspaceError('forbidden', `member role ${role} cannot approve`)
  }
}

function normalizeApproverMemberIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProjectWorkspaceError('invalid_input', 'approverMemberIds must be a non-empty array')
  }
  const ids = value.map((item, index) => requiredId(item, `approverMemberIds[${index}]`))
  if (new Set(ids).size !== ids.length) throw new ProjectWorkspaceError('invalid_input', 'approverMemberIds contains duplicates')
  return ids.sort()
}

function deriveApprovalStatus(approval: WorkItemSharedApproval): WorkItemSharedApproval['status'] {
  if (approval.decisions.some((decision) => decision.decision === 'rejected')) return 'rejected'
  const approved = approval.decisions.filter((decision) => decision.decision === 'approved').length
  return approved >= approval.requiredApprovals ? 'approved' : 'pending'
}

function memberEventPayload(member: ProjectMember): Record<string, unknown> {
  return {
    principal: member.principal,
    role: member.role,
    status: member.status,
    joinedAt: member.joinedAt,
    revokedAt: member.revokedAt
  }
}

function invitationEventPayload(invitation: ProjectInvitation): Record<string, unknown> {
  return {
    principal: invitation.principal,
    role: invitation.role,
    status: invitation.status,
    expiresAt: invitation.expiresAt,
    acceptedMemberId: invitation.acceptedMemberId,
    tokenDigest: invitation.tokenDigest
  }
}

function approvalEventPayload(approval: WorkItemSharedApproval): Record<string, unknown> {
  return {
    workItemId: approval.workItemId,
    goalId: approval.goalId,
    title: approval.title,
    approverMemberIds: approval.approverMemberIds,
    requiredApprovals: approval.requiredApprovals,
    decisions: approval.decisions,
    status: approval.status,
    requester: approval.requester
  }
}

function assertMemberActorMatchesDecision(member: ProjectMember, actor: WorkItemActor): void {
  if (actor.type === 'local_user') return
  if (actor.type !== member.principal.type || actor.id !== member.principal.id) {
    throw new ProjectWorkspaceError('actor_forbidden', `Actor ${actor.id} cannot decide for member ${member.id}`, {
      actorId: actor.id,
      memberId: member.id
    })
  }
}

function mutationActor(options: MutationOptions | number | undefined, fallback?: WorkItemActor): WorkItemActor {
  if (typeof options === 'object' && options?.actor) return normalizeActor(options.actor, 'mutation actor')
  return fallback ? normalizeActor(fallback, 'mutation actor') : LOCAL_USER_ACTOR
}
