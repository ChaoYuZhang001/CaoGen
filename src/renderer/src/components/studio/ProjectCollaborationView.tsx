import { useEffect, useMemo, useState } from 'react'
import { Check, CheckCheck, Copy, ExternalLink, Inbox, MailOpen } from 'lucide-react'
import type {
  DigitalWorker,
  ProjectMember,
  ProjectInvitation,
  ProjectCollaborationInboxItem,
  ProjectInvitationRole,
  ProjectMemberRole,
  ProjectAuthorizationView,
  ProjectSquad,
  ProjectSquadMember,
  WorkItem,
  WorkItemActor,
  WorkItemComment,
  WorkItemSharedApproval,
  WorkItemOwnerType
} from '../../../../shared/types'
import { COLLAB_TEXT as C, errorText } from './projectWorkspaceStudioModel'

interface ProjectCollaborationViewProps {
  projectId: string
  workItems: WorkItem[]
  squads: ProjectSquad[]
  members: ProjectMember[]
  invitations: ProjectInvitation[]
  comments: WorkItemComment[]
  sharedApprovals: WorkItemSharedApproval[]
  inboxItems: ProjectCollaborationInboxItem[]
  authorization: ProjectAuthorizationView | null
  onRefresh: () => Promise<void>
}

export function ProjectCollaborationView({
  projectId,
  workItems,
  squads,
  members,
  invitations,
  comments,
  sharedApprovals,
  inboxItems,
  authorization,
  onRefresh
}: ProjectCollaborationViewProps): React.JSX.Element {
  const [workers, setWorkers] = useState<DigitalWorker[]>([])
  const [workerError, setWorkerError] = useState('')

  useEffect(() => {
    let active = true
    setWorkerError('')
    void window.agentDesk.listDigitalWorkers({ projectId, status: 'active' }).then((values) => {
      if (active) setWorkers(values.sort((left, right) => left.displayName.localeCompare(right.displayName)))
    }).catch((cause) => {
      if (active) setWorkerError(errorText(cause))
    })
    return () => { active = false }
  }, [projectId])

  return (
    <section className="pws-section pws-collaboration" data-project-collaboration>
      <CollaborationInboxSurface
        projectId={projectId}
        items={inboxItems}
        members={members}
        onRefresh={onRefresh}
      />
      <MemberSurface projectId={projectId} members={members} workers={workers} authorization={authorization} onRefresh={onRefresh} />
      <InvitationSurface projectId={projectId} invitations={invitations} workers={workers} members={members} authorization={authorization} onRefresh={onRefresh} />
      <SquadSurface
        projectId={projectId}
        squads={squads}
        workers={workers}
        members={members}
        authorization={authorization}
        workerError={workerError}
        onRefresh={onRefresh}
      />
      <CommentSurface
        projectId={projectId}
        workItems={workItems}
        squads={squads}
        members={members}
        comments={comments}
        authorization={authorization}
        onRefresh={onRefresh}
      />
      <SharedApprovalSurface
        projectId={projectId}
        workItems={workItems}
        members={members}
        approvals={sharedApprovals}
        authorization={authorization}
        onRefresh={onRefresh}
      />
    </section>
  )
}

function CollaborationInboxSurface({ projectId, items, members, onRefresh }: {
  projectId: string
  items: ProjectCollaborationInboxItem[]
  members: ProjectMember[]
  onRefresh: () => Promise<void>
}): React.JSX.Element {
  const [memberId, setMemberId] = useState('all')
  const [scope, setScope] = useState<'unread' | 'all'>('unread')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const activeMembers = members.filter((member) => member.status === 'active')
  const visible = items.filter((item) =>
    (memberId === 'all' || item.memberId === memberId) &&
    (scope === 'all' || item.state === 'unread'))
  const unreadCount = items.filter((item) => item.state === 'unread').length

  useEffect(() => {
    if (memberId !== 'all' && !activeMembers.some((member) => member.id === memberId)) setMemberId('all')
  }, [activeMembers, memberId])

  const mark = async (item: ProjectCollaborationInboxItem, status: 'read' | 'handled'): Promise<void> => {
    setBusy(`${status}:${item.id}`)
    setError('')
    try {
      await window.agentDesk.markProjectCollaborationInbox({
        projectId,
        itemId: item.id,
        sourceRevision: item.sourceRevision,
        status
      }, item.receiptRevision === undefined ? undefined : { expectedRevision: item.receiptRevision })
      await onRefresh()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy('')
    }
  }

  const openWorkItem = async (item: ProjectCollaborationInboxItem): Promise<void> => {
    if (item.state === 'unread') await mark(item, 'read')
    const target = document.querySelector<HTMLElement>(`[data-work-item-id="${CSS.escape(item.workItemId)}"]`)
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    target?.classList.add('pws-inbox-target')
    window.setTimeout(() => target?.classList.remove('pws-inbox-target'), 1600)
  }

  return (
    <div className="pws-collaboration-pane pws-collaboration-inbox" data-collaboration-inbox>
      <div className="pws-section-header pws-collaboration-inbox-header">
        <div><Inbox size={16} aria-hidden="true" /><h2>{C.collaborationInbox}</h2><span className="pws-count">{unreadCount}</span></div>
        <div className="pws-collaboration-inbox-filters">
          <label><span className="pws-visually-hidden">{C.inboxMember}</span><select className="select" aria-label={C.inboxMember} value={memberId} onChange={(event) => setMemberId(event.target.value)}><option value="all">{C.allMembers}</option>{activeMembers.map((member) => <option value={member.id} key={member.id}>{member.principal.displayName || member.principal.id}</option>)}</select></label>
          <div className="pws-segmented" role="group" aria-label={C.inboxScope}>
            <button type="button" aria-pressed={scope === 'unread'} onClick={() => setScope('unread')}>{C.unread}</button>
            <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>{C.all}</button>
          </div>
        </div>
      </div>
      {visible.length === 0 ? <p className="pws-muted pws-collaboration-inbox-empty">{scope === 'unread' ? C.noUnreadInbox : C.noInbox}</p> : (
        <div className="pws-collaboration-inbox-list">
          {visible.map((item) => {
            const member = members.find((candidate) => candidate.id === item.memberId)
            return <article className="pws-collaboration-inbox-item" data-state={item.state} data-priority={item.priority} key={item.id}>
              <div className="pws-collaboration-inbox-copy">
                <div><strong>{item.title}</strong><span>{inboxKindLabel(item.sourceKind)}</span></div>
                {item.detail && <p>{item.detail}</p>}
                <small>{member?.principal.displayName || member?.principal.id || item.memberId} · {formatTimestamp(item.updatedAt)} · {inboxStateLabel(item.state)}</small>
              </div>
              <div className="pws-collaboration-inbox-actions">
                <button type="button" className="btn btn-ghost btn-icon-sm" title={C.openWorkItem} aria-label={C.openWorkItem} disabled={Boolean(busy)} onClick={() => void openWorkItem(item)}><ExternalLink size={14} aria-hidden="true" /></button>
                {item.state === 'unread' && <button type="button" className="btn btn-ghost btn-icon-sm" title={C.markRead} aria-label={C.markRead} disabled={Boolean(busy)} onClick={() => void mark(item, 'read')}><MailOpen size={14} aria-hidden="true" /></button>}
                {item.state !== 'handled' && <button type="button" className="btn btn-ghost btn-icon-sm" title={C.markHandled} aria-label={C.markHandled} disabled={Boolean(busy)} onClick={() => void mark(item, 'handled')}><CheckCheck size={14} aria-hidden="true" /></button>}
              </div>
            </article>
          })}
        </div>
      )}
      {error && <p className="pws-work-item-control-error" role="alert">{error}</p>}
    </div>
  )
}

function inboxKindLabel(kind: ProjectCollaborationInboxItem['sourceKind']): string {
  return ({ work_item_assignment: C.inboxAssignment, comment_mention: C.inboxMention, shared_approval: C.inboxApproval })[kind]
}

function inboxStateLabel(state: ProjectCollaborationInboxItem['state']): string {
  return ({ unread: C.unread, read: C.read, handled: C.handled })[state]
}

function InvitationSurface({ projectId, invitations, workers, members, authorization, onRefresh }: {
  projectId: string
  invitations: ProjectInvitation[]
  workers: DigitalWorker[]
  members: ProjectMember[]
  authorization: ProjectAuthorizationView | null
  onRefresh: () => Promise<void>
}): React.JSX.Element {
  const [principalId, setPrincipalId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [role, setRole] = useState<ProjectInvitationRole>('editor')
  const [token, setToken] = useState('')
  const [acceptToken, setAcceptToken] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const create = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); setBusy(true); setError(''); setNotice(''); setToken('')
    try {
      const worker = workers.find((candidate) => candidate.id === principalId)
      const result = await window.agentDesk.createProjectInvitation({ projectId, principal: { type: worker ? 'digital_worker' : 'human', id: principalId, displayName: worker?.displayName || displayName || undefined }, role })
      setToken(result.token); setPrincipalId(''); setDisplayName(''); await onRefresh()
    } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  const revoke = async (invitation: ProjectInvitation): Promise<void> => {
    setBusy(true); setError(''); setNotice('')
    try { await window.agentDesk.revokeProjectInvitation(invitation.id, { expectedRevision: invitation.revision }); await onRefresh() } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  const accept = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); setBusy(true); setError(''); setNotice('')
    try {
      await window.agentDesk.acceptProjectInvitation(projectId, acceptToken.trim())
      setAcceptToken('')
      setNotice(C.invitationAccepted)
      await onRefresh()
    } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  return <div className="pws-collaboration-pane" data-invitation-surface>
    <div className="pws-section-header"><div><h2>{C.invitations}</h2><span className="pws-count">{invitations.filter((item) => item.status === 'pending').length}</span></div></div>
    <form className="pws-inline-form" onSubmit={(event) => void create(event)}>
      <input className="input" required placeholder={C.principalId} value={principalId} onChange={(event) => setPrincipalId(event.target.value)} />
      <input className="input" placeholder={C.displayName} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
      <select className="select" aria-label={C.role} value={role} onChange={(event) => setRole(event.target.value as ProjectInvitationRole)}>{MEMBER_ROLES.filter((option) => option.value !== 'owner').map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
      <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !principalId || !authorization?.capabilities.includes('manage_invitations')}>{C.createInvitation}</button>
    </form>
    {token && <div className="pws-invitation-token" data-invitation-token><code>{token}</code><button type="button" className="btn btn-ghost btn-icon-sm" aria-label={C.copyInvitation} title={C.copyInvitation} onClick={() => void navigator.clipboard.writeText(token).then(() => setNotice(C.invitationCopied)).catch((cause) => setError(errorText(cause)))}><Copy size={14} aria-hidden="true" /></button></div>}
    <form className="pws-inline-form" onSubmit={(event) => void accept(event)} data-invitation-accept>
      <input className="input" required value={acceptToken} placeholder={C.invitationToken} onChange={(event) => setAcceptToken(event.target.value)} />
      <button className="btn btn-ghost btn-sm" type="submit" disabled={busy || !acceptToken.trim()}>{C.acceptInvitation}</button>
    </form>
    {invitations.map((invitation) => <article className="pws-directory-member" key={invitation.id} data-invitation-status={invitation.status}><div><strong>{invitation.principal.displayName || invitation.principal.id}</strong><small>{invitation.role} · {invitation.status}</small></div>{invitation.status === 'pending' && <button type="button" className="btn btn-ghost btn-sm" disabled={busy || !authorization?.capabilities.includes('manage_invitations')} onClick={() => void revoke(invitation)}>Revoke</button>}</article>)}
    {error && <p className="pws-work-item-control-error" role="alert">{error}</p>}
    {notice && <p className="pws-goal-task-success" role="status"><Check size={14} aria-hidden="true" />{notice}</p>}
  </div>
}

const MEMBER_ROLES: ReadonlyArray<{ value: ProjectMemberRole; label: string }> = [
  { value: 'owner', label: 'Owner' },
  { value: 'admin', label: 'Admin' },
  { value: 'editor', label: 'Editor' },
  { value: 'reviewer', label: 'Reviewer' },
  { value: 'viewer', label: 'Viewer' }
]

function MemberSurface({ projectId, members, workers, authorization, onRefresh }: {
  projectId: string
  members: ProjectMember[]
  workers: DigitalWorker[]
  authorization: ProjectAuthorizationView | null
  onRefresh: () => Promise<void>
}): React.JSX.Element {
  const [creating, setCreating] = useState(false)
  const [type, setType] = useState<WorkItemOwnerType>('human')
  const [principalId, setPrincipalId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [role, setRole] = useState<ProjectMemberRole>('editor')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const run = async (key: string, action: () => Promise<void>): Promise<void> => {
    setBusy(key); setError('')
    try { await action(); await onRefresh() } catch (cause) { setError(errorText(cause)) } finally { setBusy('') }
  }
  const create = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const worker = workers.find((candidate) => candidate.id === principalId)
    await run('create-member', async () => {
      await window.agentDesk.createProjectMember({
        projectId,
        principal: { type, id: principalId, displayName: type === 'digital_worker' ? worker?.displayName : displayName || undefined },
        role
      })
      setPrincipalId(''); setDisplayName(''); setCreating(false)
    })
  }
  return (
    <div className="pws-collaboration-pane pws-member-directory" data-member-directory>
      <div className="pws-section-header">
        <div><h2>{C.members}</h2><span className="pws-count">{members.filter((member) => member.status === 'active').length}</span></div>
        <button type="button" className="btn btn-ghost btn-sm" disabled={!authorization?.capabilities.includes('manage_members')} onClick={() => setCreating((value) => !value)}>{creating ? C.cancel : C.newMember}</button>
      </div>
      {creating && <form className="pws-member-directory-form" onSubmit={(event) => void create(event)}>
        <select className="select" aria-label={`${C.human} / ${C.digitalWorker}`} value={type} onChange={(event) => { setType(event.target.value as WorkItemOwnerType); setPrincipalId('') }}>
          <option value="human">{C.human}</option><option value="digital_worker">{C.digitalWorker}</option>
        </select>
        {type === 'digital_worker' ? <select className="select" aria-label={C.chooseWorker} required value={principalId} onChange={(event) => setPrincipalId(event.target.value)}>
          <option value="">{C.chooseWorker}</option>
          {workers.filter((worker) => !members.some((member) => member.principal.type === 'digital_worker' && member.principal.id === worker.id)).map((worker) => <option value={worker.id} key={worker.id}>{worker.displayName}</option>)}
        </select> : <><input className="input" required placeholder={C.humanId} value={principalId} onChange={(event) => setPrincipalId(event.target.value)} /><input className="input" required placeholder={C.displayName} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></>}
        <select className="select" aria-label={C.role} value={role} onChange={(event) => setRole(event.target.value as ProjectMemberRole)}>{MEMBER_ROLES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        <button className="btn btn-primary btn-sm" type="submit" disabled={!principalId || Boolean(busy) || !authorization?.capabilities.includes('manage_members')}>{C.add}</button>
      </form>}
      <div className="pws-directory-list">
        {members.length === 0 && <p className="pws-muted">{C.noProjectMembers}</p>}
        {members.map((member) => <article className="pws-directory-member" key={member.id} data-status={member.status}>
          <div><strong>{member.principal.displayName || member.principal.id}</strong><small>{member.principal.type === 'digital_worker' ? C.digitalWorker : C.human}</small></div>
          <select className="select" aria-label={C.role} value={member.role} disabled={member.status !== 'active' || Boolean(busy) || !authorization?.capabilities.includes('manage_members')} onChange={(event) => void run(`role-${member.id}`, () => window.agentDesk.updateProjectMember(member.id, { role: event.target.value as ProjectMemberRole }, { expectedRevision: member.revision }).then(() => undefined))}>{MEMBER_ROLES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy) || !authorization?.capabilities.includes('manage_members')} onClick={() => void run(`status-${member.id}`, () => (member.status === 'active' ? window.agentDesk.revokeProjectMember : window.agentDesk.restoreProjectMember)(member.id, { expectedRevision: member.revision }).then(() => undefined))}>{member.status === 'active' ? C.revoke : C.restore}</button>
        </article>)}
      </div>
      {error && <p className="pws-work-item-control-error" role="alert">{error}</p>}
    </div>
  )
}

function SquadSurface({
  projectId,
  squads,
  workers,
  members,
  authorization,
  workerError,
  onRefresh
}: {
  projectId: string
  squads: ProjectSquad[]
  workers: DigitalWorker[]
  members: ProjectMember[]
  authorization: ProjectAuthorizationView | null
  workerError: string
  onRefresh: () => Promise<void>
}): React.JSX.Element {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [memberSquadId, setMemberSquadId] = useState('')
  const [memberId, setMemberId] = useState('')
  const [memberRole, setMemberRole] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const createSquad = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    await runMutation('create-squad', async () => {
      await window.agentDesk.createProjectSquad({ projectId, name, description: description || undefined })
      setName('')
      setDescription('')
      setCreating(false)
    })
  }

  const addMember = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const squad = squads.find((candidate) => candidate.id === memberSquadId)
    if (!squad) return
    await runMutation(`member-${squad.id}`, async () => {
      const projectMember = members.find((candidate) => candidate.id === memberId)
      const worker = projectMember?.principal.type === 'digital_worker'
        ? workers.find((candidate) => candidate.id === projectMember.principal.id)
        : undefined
      if (!projectMember) return
      await window.agentDesk.addProjectSquadMember(squad.id, {
        type: projectMember.principal.type,
        id: projectMember.principal.id,
        memberId: projectMember.id,
        displayName: projectMember.principal.type === 'digital_worker' ? worker?.displayName : projectMember.principal.displayName,
        role: memberRole || undefined
      }, { expectedRevision: squad.revision })
      setMemberId('')
      setMemberRole('')
      setMemberSquadId('')
    })
  }

  const removeMember = async (squad: ProjectSquad, member: ProjectSquadMember): Promise<void> => {
    await runMutation(`remove-${squad.id}-${member.type}-${member.id}`, async () => {
      await window.agentDesk.removeProjectSquadMember(
        squad.id,
        member.type,
        member.id,
        { expectedRevision: squad.revision }
      )
    })
  }

  const toggleArchive = async (squad: ProjectSquad): Promise<void> => {
    await runMutation(`archive-${squad.id}`, async () => {
      if (squad.status === 'active') {
        await window.agentDesk.archiveProjectSquad(squad.id, { expectedRevision: squad.revision })
      } else {
        await window.agentDesk.restoreProjectSquad(squad.id, { expectedRevision: squad.revision })
      }
    })
  }

  const runMutation = async (key: string, mutation: () => Promise<void>): Promise<void> => {
    setBusy(key)
    setError('')
    try {
      await mutation()
      await onRefresh()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="pws-collaboration-pane" data-squad-surface>
      <div className="pws-section-header">
        <div><h2>{C.squads}</h2><span className="pws-count">{squads.length}</span></div>
        <button type="button" className="btn btn-ghost btn-sm" disabled={!authorization?.capabilities.includes('manage_squads')} onClick={() => setCreating((value) => !value)}>
          {creating ? C.cancel : C.newSquad}
        </button>
      </div>
      {creating && (
        <form className="pws-inline-form" onSubmit={(event) => void createSquad(event)}>
          <label>{C.name}<input className="input" value={name} maxLength={120} required onChange={(event) => setName(event.target.value)} /></label>
          <label>{C.description}<input className="input" value={description} maxLength={1000} onChange={(event) => setDescription(event.target.value)} /></label>
          <button className="btn btn-primary btn-sm" type="submit" disabled={!name.trim() || Boolean(busy) || !authorization?.capabilities.includes('manage_squads')}>{C.create}</button>
        </form>
      )}
      {squads.length === 0 ? <p className="pws-muted">{C.noSquads}</p> : (
        <div className="pws-squad-list">
          {squads.map((squad) => (
            <article className="pws-squad" key={squad.id} data-squad-id={squad.id} data-status={squad.status}>
              <header>
                <div><strong>{squad.name}</strong>{squad.description && <span>{squad.description}</span>}</div>
                <div className="pws-squad-actions">
                  {squad.status === 'active' && (
                    <button type="button" className="btn btn-ghost btn-sm" disabled={!authorization?.capabilities.includes('manage_squads')} onClick={() => setMemberSquadId((id) => id === squad.id ? '' : squad.id)}>
                      {C.addMember}
                    </button>
                  )}
                  <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy) || !authorization?.capabilities.includes('manage_squads')} onClick={() => void toggleArchive(squad)}>
                    {squad.status === 'active' ? C.archive : C.restore}
                  </button>
                </div>
              </header>
              <div className="pws-member-list">
                {squad.members.length === 0 && <span className="pws-muted">{C.noMembers}</span>}
                {squad.members.map((member) => (
                  <span className="pws-member" key={`${member.type}:${member.id}`}>
                    <span>{member.displayName || member.id}</span>
                    <small>{member.role || (member.type === 'digital_worker' ? C.digitalWorker : C.human)}</small>
                    {squad.status === 'active' && (
                      <button
                        type="button"
                        aria-label={`${C.removeMember}: ${member.displayName || member.id}`}
                        title={C.removeMember}
                        disabled={Boolean(busy) || !authorization?.capabilities.includes('manage_squads')}
                        onClick={() => void removeMember(squad, member)}
                      >×</button>
                    )}
                  </span>
                ))}
              </div>
              {memberSquadId === squad.id && (
                <form className="pws-member-form" onSubmit={(event) => void addMember(event)}>
                  <select className="select" aria-label={C.chooseMember} value={memberId} required onChange={(event) => setMemberId(event.target.value)}>
                    <option value="">{C.chooseMember}</option>
                    {members.filter((member) => member.status === 'active' && !squad.members.some((squadMember) => squadMember.type === member.principal.type && squadMember.id === member.principal.id)).map((member) => (
                      <option value={member.id} key={member.id}>{member.principal.displayName || member.principal.id} · {member.role}</option>
                    ))}
                  </select>
                  <input className="input" value={memberRole} placeholder={C.role} onChange={(event) => setMemberRole(event.target.value)} />
                  <button type="submit" className="btn btn-primary btn-sm" disabled={!memberId || Boolean(busy) || !authorization?.capabilities.includes('manage_squads')}>{C.add}</button>
                </form>
              )}
            </article>
          ))}
        </div>
      )}
      {(error || workerError) && <p className="pws-work-item-control-error" role="alert">{error || workerError}</p>}
    </div>
  )
}

function CommentSurface({
  projectId,
  workItems,
  squads,
  members,
  comments,
  authorization,
  onRefresh
}: {
  projectId: string
  workItems: WorkItem[]
  squads: ProjectSquad[]
  members: ProjectMember[]
  comments: WorkItemComment[]
  authorization: ProjectAuthorizationView | null
  onRefresh: () => Promise<void>
}): React.JSX.Element {
  const [workItemId, setWorkItemId] = useState('')
  const [body, setBody] = useState('')
  const [mentions, setMentions] = useState<string[]>([])
  const [editingId, setEditingId] = useState('')
  const [editingBody, setEditingBody] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    setWorkItemId((current) => workItems.some((item) => item.id === current) ? current : workItems[0]?.id ?? '')
  }, [workItems])

  const participants = useMemo(() => {
    const byKey = new Map<string, WorkItemActor>()
    for (const member of members.filter((candidate) => candidate.status === 'active')) {
      const actor: WorkItemActor = { type: member.principal.type, id: member.principal.id, displayName: member.principal.displayName }
      byKey.set(actorKey(actor), actor)
    }
    for (const squad of squads) {
      for (const member of squad.members) {
        const actor: WorkItemActor = { type: member.type, id: member.id, displayName: member.displayName }
        byKey.set(actorKey(actor), actor)
      }
    }
    return [...byKey.values()].sort((left, right) => actorLabel(left).localeCompare(actorLabel(right)))
  }, [members, squads])
  const selectedItem = workItems.find((item) => item.id === workItemId)
  const visibleComments = comments.filter((comment) => comment.workItemId === workItemId)

  const run = async (key: string, mutation: () => Promise<void>): Promise<void> => {
    setBusy(key)
    setError('')
    try {
      await mutation()
      await onRefresh()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy('')
    }
  }

  const createComment = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!selectedItem) return
    await run('create-comment', async () => {
      await window.agentDesk.createProjectWorkItemComment({
        projectId,
        workItemId: selectedItem.id,
        body,
        mentions: mentions.map((key) => participants.find((actor) => actorKey(actor) === key)).filter(isActor)
      })
      setBody('')
      setMentions([])
    })
  }

  const saveComment = async (comment: WorkItemComment): Promise<void> => {
    await run(`edit-${comment.id}`, async () => {
      await window.agentDesk.updateProjectWorkItemComment(comment.id, { body: editingBody }, {
        expectedRevision: comment.revision
      })
      setEditingId('')
      setEditingBody('')
    })
  }

  const deleteComment = async (comment: WorkItemComment): Promise<void> => {
    await run(`delete-${comment.id}`, async () => {
      await window.agentDesk.deleteProjectWorkItemComment(comment.id, { expectedRevision: comment.revision })
    })
  }

  return (
    <div className="pws-collaboration-pane" data-comment-surface>
      <div className="pws-section-header">
        <div><h2>{C.comments}</h2><span className="pws-count">{visibleComments.length}</span></div>
      </div>
      {workItems.length === 0 ? <p className="pws-muted">{C.createWorkItemFirst}</p> : (
        <>
          <label className="pws-comment-work-item">{C.workItem}
            <select className="select" aria-label={C.workItem} value={workItemId} onChange={(event) => setWorkItemId(event.target.value)}>
              {workItems.map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}
            </select>
          </label>
          {selectedItem && (
            <div className="pws-comment-context">
              <span>{C.owner}：{selectedItem.owner?.displayName || selectedItem.owner?.id || C.unassigned}</span>
              <span>{C.runHistory}：{selectedItem.runRefs.length}</span>
              {selectedItem.runRefs.length > 0 && <code title={selectedItem.runRefs.join('\n')}>{selectedItem.runRefs.at(-1)}</code>}
            </div>
          )}
          <div className="pws-comments" role="log" aria-live="polite">
            {visibleComments.length === 0 && <p className="pws-muted">{C.noComments}</p>}
            {visibleComments.map((comment) => (
              <article className="pws-comment" key={comment.id} data-comment-id={comment.id}>
                <header>
                  <strong>{actorLabel(comment.author)}</strong>
                  <time dateTime={new Date(comment.createdAt).toISOString()}>{formatTimestamp(comment.createdAt)}</time>
                </header>
                {editingId === comment.id ? (
                  <div className="pws-comment-edit">
                    <textarea className="input" value={editingBody} maxLength={20_000} onChange={(event) => setEditingBody(event.target.value)} />
                    <button type="button" className="btn btn-primary btn-sm" disabled={!editingBody.trim() || Boolean(busy) || !authorization?.capabilities.includes('comment')} onClick={() => void saveComment(comment)}>{C.save}</button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingId('')}>{C.cancel}</button>
                  </div>
                ) : <p>{comment.body}</p>}
                {comment.mentions.length > 0 && <div className="pws-comment-mentions">{comment.mentions.map((actor) => <span key={actorKey(actor)}>@{actorLabel(actor)}</span>)}</div>}
                {editingId !== comment.id && (
                  <div className="pws-comment-actions">
                    <button type="button" className="btn btn-ghost btn-sm" disabled={!authorization?.capabilities.includes('comment')} onClick={() => { setEditingId(comment.id); setEditingBody(comment.body) }}>{C.edit}</button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy) || !authorization?.capabilities.includes('comment')} onClick={() => void deleteComment(comment)}>{C.delete}</button>
                  </div>
                )}
              </article>
            ))}
          </div>
          <form className="pws-comment-form" onSubmit={(event) => void createComment(event)}>
            <textarea className="input" value={body} maxLength={20_000} placeholder={C.writeComment} required onChange={(event) => setBody(event.target.value)} />
            {participants.length > 0 && (
              <label>{C.mentions}
                <select
                  className="select"
                  aria-label={C.mentions}
                  multiple
                  value={mentions}
                  onChange={(event) => setMentions(Array.from(event.currentTarget.selectedOptions, (option) => option.value))}
                >
                  {participants.map((actor) => <option value={actorKey(actor)} key={actorKey(actor)}>{actorLabel(actor)}</option>)}
                </select>
              </label>
            )}
            <button type="submit" className="btn btn-primary btn-sm" disabled={!body.trim() || Boolean(busy) || !authorization?.capabilities.includes('comment')}>{C.send}</button>
          </form>
        </>
      )}
      {error && <p className="pws-work-item-control-error" role="alert">{error}</p>}
    </div>
  )
}

function SharedApprovalSurface({ projectId, workItems, members, approvals, authorization, onRefresh }: {
  projectId: string
  workItems: WorkItem[]
  members: ProjectMember[]
  approvals: WorkItemSharedApproval[]
  authorization: ProjectAuthorizationView | null
  onRefresh: () => Promise<void>
}): React.JSX.Element {
  const approvers = members.filter((member) => member.status === 'active' && ['owner', 'admin', 'reviewer'].includes(member.role))
  const [creating, setCreating] = useState(false)
  const [workItemId, setWorkItemId] = useState('')
  const [title, setTitle] = useState('')
  const [selectedApprovers, setSelectedApprovers] = useState<string[]>([])
  const [quorum, setQuorum] = useState(1)
  const [decisionMemberId, setDecisionMemberId] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    setWorkItemId((current) => workItems.some((item) => item.id === current) ? current : workItems[0]?.id ?? '')
  }, [workItems])
  useEffect(() => {
    setQuorum((current) => Math.max(1, Math.min(current, selectedApprovers.length || 1)))
  }, [selectedApprovers.length])

  const run = async (key: string, action: () => Promise<void>): Promise<void> => {
    setBusy(key); setError('')
    try { await action(); await onRefresh() } catch (cause) { setError(errorText(cause)) } finally { setBusy('') }
  }
  const create = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const item = workItems.find((candidate) => candidate.id === workItemId)
    if (!item) return
    await run('create-approval', async () => {
      await window.agentDesk.createProjectSharedApproval({
        projectId,
        workItemId,
        goalId: item.goalId,
        title,
        approverMemberIds: selectedApprovers,
        requiredApprovals: quorum
      })
      setTitle(''); setSelectedApprovers([]); setCreating(false)
    })
  }
  const decide = (approval: WorkItemSharedApproval, decision: 'approved' | 'rejected'): Promise<void> => {
    const memberId = decisionMemberId[approval.id]
    if (!memberId) return Promise.resolve()
    return run(`${decision}-${approval.id}`, () => window.agentDesk.decideProjectSharedApproval(
      approval.id,
      { memberId, decision },
      { expectedRevision: approval.revision }
    ).then(() => undefined))
  }
  return (
    <div className="pws-collaboration-pane pws-shared-approvals" data-shared-approval-surface>
      <div className="pws-section-header">
        <div><h2>{C.sharedApprovals}</h2><span className="pws-count">{approvals.filter((approval) => approval.status === 'pending').length}</span></div>
        <button type="button" className="btn btn-ghost btn-sm" disabled={workItems.length === 0 || approvers.length === 0 || !authorization?.capabilities.includes('approve')} onClick={() => setCreating((value) => !value)}>{creating ? C.cancel : C.newApproval}</button>
      </div>
      {creating && <form className="pws-shared-approval-form" onSubmit={(event) => void create(event)}>
        <select className="select" aria-label={C.workItem} value={workItemId} required onChange={(event) => setWorkItemId(event.target.value)}>{workItems.map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select>
        <input className="input" value={title} required maxLength={240} placeholder={C.approvalTitle} onChange={(event) => setTitle(event.target.value)} />
        <select className="select" aria-label={C.chooseApprover} multiple required value={selectedApprovers} onChange={(event) => setSelectedApprovers(Array.from(event.currentTarget.selectedOptions, (option) => option.value))}>{approvers.map((member) => <option value={member.id} key={member.id}>{member.principal.displayName || member.principal.id} · {member.role}</option>)}</select>
        <label>{C.quorum}<input className="input" type="number" min={1} max={selectedApprovers.length || 1} value={quorum} onChange={(event) => setQuorum(Number(event.target.value))} /></label>
        <button className="btn btn-primary btn-sm" type="submit" disabled={!title.trim() || selectedApprovers.length === 0 || Boolean(busy) || !authorization?.capabilities.includes('approve')}>{C.create}</button>
      </form>}
      <div className="pws-approval-list">
        {approvals.length === 0 && <p className="pws-muted">{C.noApprovals}</p>}
        {approvals.map((approval) => {
          const approved = approval.decisions.filter((decision) => decision.decision === 'approved').length
          const undecided = approval.approverMemberIds.filter((memberId) => !approval.decisions.some((decision) => decision.memberId === memberId))
          return <article className="pws-approval" data-status={approval.status} key={approval.id}>
            <header><div><strong>{approval.title}</strong><small>{workItems.find((item) => item.id === approval.workItemId)?.title || approval.workItemId}</small></div><span>{approvalStatusLabel(approval.status)}</span></header>
            <div className="pws-approval-progress"><span style={{ width: `${Math.min(100, approved / approval.requiredApprovals * 100)}%` }} /></div>
            <p>{C.quorumProgress.replace('{approved}', String(approved)).replace('{required}', String(approval.requiredApprovals))}</p>
            <div className="pws-approval-decisions">{approval.approverMemberIds.map((memberId) => {
              const member = members.find((candidate) => candidate.id === memberId)
              const decision = approval.decisions.find((candidate) => candidate.memberId === memberId)
              return <span data-decision={decision?.decision || 'pending'} key={memberId}>{member?.principal.displayName || memberId}: {decision ? approvalDecisionLabel(decision.decision) : C.pending}</span>
            })}</div>
            {approval.status === 'pending' && <div className="pws-approval-actions">
              <select className="select" aria-label={C.chooseApprover} value={decisionMemberId[approval.id] || ''} onChange={(event) => setDecisionMemberId((current) => ({ ...current, [approval.id]: event.target.value }))}><option value="">{C.chooseApprover}</option>{undecided.map((memberId) => { const member = members.find((candidate) => candidate.id === memberId); return <option value={memberId} key={memberId}>{member?.principal.displayName || memberId}</option> })}</select>
              <button type="button" className="btn btn-primary btn-sm" disabled={!decisionMemberId[approval.id] || Boolean(busy) || !authorization?.capabilities.includes('approve')} onClick={() => void decide(approval, 'approved')}>{C.approve}</button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={!decisionMemberId[approval.id] || Boolean(busy) || !authorization?.capabilities.includes('approve')} onClick={() => void decide(approval, 'rejected')}>{C.reject}</button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy) || !authorization?.capabilities.includes('approve')} onClick={() => void run(`revoke-${approval.id}`, () => window.agentDesk.revokeProjectSharedApproval(approval.id, { expectedRevision: approval.revision }).then(() => undefined))}>{C.revoke}</button>
            </div>}
          </article>
        })}
      </div>
      {error && <p className="pws-work-item-control-error" role="alert">{error}</p>}
    </div>
  )
}

function approvalStatusLabel(status: WorkItemSharedApproval['status']): string {
  return ({ pending: C.pending, approved: C.approved, rejected: C.rejected, expired: C.expired, revoked: C.revoked })[status]
}

function approvalDecisionLabel(decision: 'approved' | 'rejected'): string {
  return decision === 'approved' ? C.approved : C.rejected
}

function actorKey(actor: Pick<WorkItemActor, 'type' | 'id'>): string {
  return `${actor.type}:${actor.id}`
}

function actorLabel(actor: Pick<WorkItemActor, 'id' | 'displayName'>): string {
  return actor.displayName || actor.id
}

function isActor(value: WorkItemActor | undefined): value is WorkItemActor {
  return value !== undefined
}

function formatTimestamp(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(value)
}
