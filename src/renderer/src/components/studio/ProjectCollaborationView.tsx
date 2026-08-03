import { useEffect, useMemo, useState } from 'react'
import type {
  DigitalWorker,
  ProjectSquad,
  ProjectSquadMember,
  WorkItem,
  WorkItemActor,
  WorkItemComment,
  WorkItemOwnerType
} from '../../../../shared/types'
import { COLLAB_TEXT as C, errorText } from './projectWorkspaceStudioModel'

interface ProjectCollaborationViewProps {
  projectId: string
  workItems: WorkItem[]
  squads: ProjectSquad[]
  comments: WorkItemComment[]
  onRefresh: () => Promise<void>
}

export function ProjectCollaborationView({
  projectId,
  workItems,
  squads,
  comments,
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
      <SquadSurface
        projectId={projectId}
        squads={squads}
        workers={workers}
        workerError={workerError}
        onRefresh={onRefresh}
      />
      <CommentSurface
        projectId={projectId}
        workItems={workItems}
        squads={squads}
        comments={comments}
        onRefresh={onRefresh}
      />
    </section>
  )
}

function SquadSurface({
  projectId,
  squads,
  workers,
  workerError,
  onRefresh
}: {
  projectId: string
  squads: ProjectSquad[]
  workers: DigitalWorker[]
  workerError: string
  onRefresh: () => Promise<void>
}): React.JSX.Element {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [memberSquadId, setMemberSquadId] = useState('')
  const [memberType, setMemberType] = useState<WorkItemOwnerType>('digital_worker')
  const [memberId, setMemberId] = useState('')
  const [memberName, setMemberName] = useState('')
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
      const worker = memberType === 'digital_worker'
        ? workers.find((candidate) => candidate.id === memberId)
        : undefined
      await window.agentDesk.addProjectSquadMember(squad.id, {
        type: memberType,
        id: memberId,
        displayName: memberType === 'digital_worker' ? worker?.displayName : memberName || undefined,
        role: memberRole || undefined
      }, { expectedRevision: squad.revision })
      setMemberId('')
      setMemberName('')
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
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCreating((value) => !value)}>
          {creating ? C.cancel : C.newSquad}
        </button>
      </div>
      {creating && (
        <form className="pws-inline-form" onSubmit={(event) => void createSquad(event)}>
          <label>{C.name}<input className="input" value={name} maxLength={120} required onChange={(event) => setName(event.target.value)} /></label>
          <label>{C.description}<input className="input" value={description} maxLength={1000} onChange={(event) => setDescription(event.target.value)} /></label>
          <button className="btn btn-primary btn-sm" type="submit" disabled={!name.trim() || Boolean(busy)}>{C.create}</button>
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
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMemberSquadId((id) => id === squad.id ? '' : squad.id)}>
                      {C.addMember}
                    </button>
                  )}
                  <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => void toggleArchive(squad)}>
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
                        disabled={Boolean(busy)}
                        onClick={() => void removeMember(squad, member)}
                      >×</button>
                    )}
                  </span>
                ))}
              </div>
              {memberSquadId === squad.id && (
                <form className="pws-member-form" onSubmit={(event) => void addMember(event)}>
                  <select className="select" value={memberType} onChange={(event) => { setMemberType(event.target.value as WorkItemOwnerType); setMemberId('') }}>
                    <option value="digital_worker">{C.digitalWorker}</option>
                    <option value="human">{C.human}</option>
                  </select>
                  {memberType === 'digital_worker' ? (
                    <select className="select" value={memberId} required onChange={(event) => setMemberId(event.target.value)}>
                      <option value="">{C.chooseWorker}</option>
                      {workers.filter((worker) => !squad.members.some((member) => member.type === 'digital_worker' && member.id === worker.id)).map((worker) => (
                        <option value={worker.id} key={worker.id}>{worker.displayName}</option>
                      ))}
                    </select>
                  ) : (
                    <>
                      <input className="input" value={memberId} required placeholder={C.humanId} onChange={(event) => setMemberId(event.target.value)} />
                      <input className="input" value={memberName} placeholder={C.displayName} onChange={(event) => setMemberName(event.target.value)} />
                    </>
                  )}
                  <input className="input" value={memberRole} placeholder={C.role} onChange={(event) => setMemberRole(event.target.value)} />
                  <button type="submit" className="btn btn-primary btn-sm" disabled={!memberId || Boolean(busy)}>{C.add}</button>
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
  comments,
  onRefresh
}: {
  projectId: string
  workItems: WorkItem[]
  squads: ProjectSquad[]
  comments: WorkItemComment[]
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
    for (const squad of squads) {
      for (const member of squad.members) {
        const actor: WorkItemActor = { type: member.type, id: member.id, displayName: member.displayName }
        byKey.set(actorKey(actor), actor)
      }
    }
    return [...byKey.values()].sort((left, right) => actorLabel(left).localeCompare(actorLabel(right)))
  }, [squads])
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
            <select className="select" value={workItemId} onChange={(event) => setWorkItemId(event.target.value)}>
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
                    <button type="button" className="btn btn-primary btn-sm" disabled={!editingBody.trim() || Boolean(busy)} onClick={() => void saveComment(comment)}>{C.save}</button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingId('')}>{C.cancel}</button>
                  </div>
                ) : <p>{comment.body}</p>}
                {comment.mentions.length > 0 && <div className="pws-comment-mentions">{comment.mentions.map((actor) => <span key={actorKey(actor)}>@{actorLabel(actor)}</span>)}</div>}
                {editingId !== comment.id && (
                  <div className="pws-comment-actions">
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setEditingId(comment.id); setEditingBody(comment.body) }}>{C.edit}</button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => void deleteComment(comment)}>{C.delete}</button>
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
                  multiple
                  value={mentions}
                  onChange={(event) => setMentions(Array.from(event.currentTarget.selectedOptions, (option) => option.value))}
                >
                  {participants.map((actor) => <option value={actorKey(actor)} key={actorKey(actor)}>{actorLabel(actor)}</option>)}
                </select>
              </label>
            )}
            <button type="submit" className="btn btn-primary btn-sm" disabled={!body.trim() || Boolean(busy)}>{C.send}</button>
          </form>
        </>
      )}
      {error && <p className="pws-work-item-control-error" role="alert">{error}</p>}
    </div>
  )
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
