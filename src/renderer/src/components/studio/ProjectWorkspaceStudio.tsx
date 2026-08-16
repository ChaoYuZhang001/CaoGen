import { memo, useCallback, useEffect, useId, useRef, useState } from 'react'
import type { AcceptanceResult, Goal, GoalPatch, ProjectSquad, ProjectWorkspace, ProjectWorkspaceLeaseOptions, WorkItem, WorkItemComment, WorkItemOwner } from '../../../../shared/types'
import {
  GoalCreateForm,
  ProjectCreateForm,
  WorkItemCreateForm
} from './ProjectWorkspaceStudioForms'
import { GoalsView, WorkItemsView } from './ProjectWorkspaceStudioViews'
import { ProjectCollaborationView } from './ProjectCollaborationView'
import { ProjectInbox } from './ProjectInbox'
import { ProjectPortfolioView } from './ProjectPortfolioView'
import { ProjectSupervisorView } from './ProjectSupervisorView'
import ProjectWorkspaceLifecycle from './ProjectWorkspaceLifecycle'
import {
  projectKindLabel,
  PROJECT_STATUS_LABELS,
  TEXT,
  type GoalControlAction,
  type StudioCreateForm,
  type StudioView,
  type WorkItemControlAction
} from './projectWorkspaceStudioModel'
import {
  useProjectContents,
  useProjectGoalTaskStart,
  useStudioCreateActions,
  useWorkspaceSelection
} from './useProjectWorkspaceStudio'
import './ProjectWorkspaceStudio.css'
import './remote-continuation.css'
import { RemoteContinuationPanel } from './RemoteContinuationPanel'
import { ProjectDeliveryWorkbench } from './ProjectDeliveryWorkbench'
import { useStore } from '../../store'

export interface ProjectWorkspaceStudioProps {
  active?: boolean
  className?: string
  initialProjectId?: string
  newProjectRequest?: number
  onProjectChange?: (project: ProjectWorkspace | null) => void
  onWorkItemsChange?: (workItems: WorkItem[]) => void
  onContextChange?: (context: ProjectWorkspaceStudioContext) => void
}

export interface ProjectWorkspaceStudioContext {
  project: ProjectWorkspace | null
  goals: Goal[]
  workItems: WorkItem[]
  squads: ProjectSquad[]
  comments: WorkItemComment[]
}

type WorkspaceSelection = ReturnType<typeof useWorkspaceSelection>
type ProjectContentsState = ReturnType<typeof useProjectContents>
type StudioCreateActions = ReturnType<typeof useStudioCreateActions>
type GoalTaskStarterState = ReturnType<typeof useProjectGoalTaskStart>

function activeProjectContentsId(project: ProjectWorkspace | null, selectedProjectId: string): string {
  return project?.status === 'active' ? selectedProjectId : ''
}

export function ProjectWorkspaceStudio({
  active = true,
  className,
  initialProjectId,
  newProjectRequest = 0,
  onContextChange,
  onProjectChange,
  onWorkItemsChange
}: ProjectWorkspaceStudioProps): React.JSX.Element {
  const titleId = useId()
  const [form, setForm] = useState<StudioCreateForm>(null)
  const [view, setView] = useState<StudioView>(() => readStoredStudioView())
  const workspace = useWorkspaceSelection(active, initialProjectId, onProjectChange)
  const contents = useProjectContents(active, activeProjectContentsId(workspace.selectedProject, workspace.selectedProjectId))
  const closeForm = useCallback(() => setForm(null), [])
  const actions = useStudioCreateActions({
    onSuccess: closeForm,
    refreshContents: contents.refreshContents,
    refreshProjects: workspace.refreshProjects
  })
  const goalTaskStarter = useProjectGoalTaskStart(contents.refreshContents)
  const controls = useStudioEntityActions(contents.refreshContents)

  useEffect(() => {
    setForm((current) => current === 'project' ? current : null)
  }, [workspace.selectedProjectId])
  useEffect(() => {
    if (newProjectRequest > 0) setForm('project')
  }, [newProjectRequest])
  useEffect(() => {
    try { window.localStorage.setItem('caogen.project-workspace.work-items.view.v1', view) } catch { /* preference persistence is best effort */ }
  }, [view])
  useEffect(() => {
    onWorkItemsChange?.(contents.workItems)
    onContextChange?.({
      project: workspace.selectedProject,
      goals: contents.goals,
      workItems: contents.workItems,
      squads: contents.squads,
      comments: contents.comments
    })
  }, [
    contents.comments,
    contents.goals,
    contents.squads,
    contents.workItems,
    onContextChange,
    onWorkItemsChange,
    workspace.selectedProject
  ])

  const openForm = (next: Exclude<StudioCreateForm, null>): void => {
    actions.clearFeedback()
    setForm((current) => current === next ? null : next)
  }
  const refresh = async (): Promise<void> => {
    actions.clearFeedback()
    await workspace.refreshProjects(workspace.selectedProjectId)
    if (workspace.selectedProjectId) await contents.refreshContents()
  }
  const retry = (): void => {
    if (workspace.error || !workspace.selectedProjectId) void workspace.refreshProjects(workspace.selectedProjectId)
    else void contents.refreshContents()
  }

  const rootClassName = ['project-workspace-studio', className].filter(Boolean).join(' ')
  const loading = workspace.loading || contents.loading || actions.busy !== null || goalTaskStarter.busy
  return (
    <section className={rootClassName} aria-labelledby={titleId} aria-busy={loading} data-project-workspace-studio>
      <StudioHeader
        titleId={titleId}
        projects={workspace.projects}
        selectedProject={workspace.selectedProject}
        selectedProjectId={workspace.selectedProjectId}
        goalCount={contents.goals.length}
        workItemCount={contents.workItems.length}
        authorization={contents.authorization}
        disabled={loading}
        importing={actions.busy === 'import'}
        refreshing={workspace.loading || contents.loading}
        onCreate={() => openForm('project')}
        onImport={actions.importProject}
        onRefresh={() => void refresh()}
        onSelect={workspace.selectProject}
      />

      <WorkspaceStatus
        actions={actions}
        contentsError={contents.error}
        form={form}
        onCloseForm={closeForm}
        onCreateProject={() => openForm('project')}
        onImportProject={actions.importProject}
        onRetry={retry}
        workspace={workspace}
      />
      <ProjectPortfolioView
        active={active}
        refreshToken={`${workspace.projects.map((project) => `${project.id}:${project.revision}`).join('|')}|${contents.goals.map((goal) => `${goal.id}:${goal.revision}`).join('|')}|${contents.workItems.map((item) => `${item.id}:${item.revision}`).join('|')}`}
        onSelectProject={workspace.selectProject}
      />
      <RemoteContinuationPanel active={active} projectId={workspace.selectedProjectId} />
      {workspace.selectedProject && (
        <ProjectWorkspaceLifecycle
          project={workspace.selectedProject}
          refreshContents={contents.refreshContents}
          refreshProjects={workspace.refreshProjects}
        />
      )}
      <ProjectContents
        active={active}
        actions={actions}
        contents={contents}
        form={form}
        onCloseForm={closeForm}
        onOpenForm={openForm}
        onGoalControl={controls.controlGoal}
        onGoalUpdate={controls.updateGoal}
        onWorkItemAcceptance={controls.setWorkItemAcceptance}
        onWorkItemControl={controls.controlWorkItem}
        onWorkItemReorder={controls.reorderWorkItem}
        onWorkItemTransfer={controls.transferWorkItem}
        onViewChange={setView}
        project={workspace.selectedProject}
        starter={goalTaskStarter}
        view={view}
      />
    </section>
  )
}

function useStudioEntityActions(refreshContents: () => Promise<void>): {
  controlGoal: (goal: Goal, action: GoalControlAction) => Promise<void>
  controlWorkItem: (item: WorkItem, action: WorkItemControlAction) => Promise<void>
  setWorkItemAcceptance: (item: WorkItem, result: AcceptanceResult) => Promise<void>
  reorderWorkItem: (item: WorkItem, targetId: string, placement: 'before' | 'after') => Promise<void>
  transferWorkItem: (item: WorkItem, target: WorkItemOwner, reason: string, requestId: string) => Promise<void>
  updateGoal: (goal: Goal, patch: GoalPatch) => Promise<void>
} {
  const controlWorkItem = useCallback(async (item: WorkItem, action: WorkItemControlAction): Promise<void> => {
    if (action.kind === 'transition') {
      await window.agentDesk.transitionProjectWorkItem(item.id, action.status, { expectedRevision: item.revision })
    } else {
      const options: ProjectWorkspaceLeaseOptions = {
        expectedRevision: item.revision,
        ...(item.owner?.id ? { ownerId: item.owner.id } : {}),
        ...(item.lease?.id ? { leaseId: item.lease.id } : {}),
        ...(item.lease?.fencingToken === undefined ? {} : { fencingToken: item.lease.fencingToken })
      }
      if (action.operation === 'acquire') await window.agentDesk.acquireProjectWorkItemLease(item.id, options)
      if (action.operation === 'renew') await window.agentDesk.renewProjectWorkItemLease(item.id, options)
      if (action.operation === 'release') await window.agentDesk.releaseProjectWorkItemLease(item.id, options)
    }
    await refreshContents()
  }, [refreshContents])
  const setWorkItemAcceptance = useCallback(async (item: WorkItem, result: AcceptanceResult): Promise<void> => {
    await window.agentDesk.setProjectWorkItemAcceptance(item.id, result, { expectedRevision: item.revision })
    await refreshContents()
  }, [refreshContents])
  const reorderWorkItem = useCallback(async (item: WorkItem, targetId: string, placement: 'before' | 'after'): Promise<void> => {
    await window.agentDesk.reorderProjectWorkItem(item.id, targetId, placement, { expectedRevision: item.revision })
    await refreshContents()
  }, [refreshContents])
  const transferWorkItem = useCallback(async (
    item: WorkItem,
    target: WorkItemOwner,
    reason: string,
    requestId: string
  ): Promise<void> => {
    const result = await window.agentDesk.transferProjectWorkItem({
      requestId,
      workItemId: item.id,
      target,
      reason,
      expectedRevision: item.revision
    })
    const successorSessionId = result.continuation?.successorSessionId
    if (successorSessionId && await useStore.getState().syncSession(successorSessionId)) {
      useStore.getState().selectSession(successorSessionId)
    }
    await refreshContents()
  }, [refreshContents])
  const updateGoal = useCallback(async (goal: Goal, patch: GoalPatch): Promise<void> => {
    await window.agentDesk.updateProjectGoal(goal.id, patch, { expectedRevision: goal.revision })
    await refreshContents()
  }, [refreshContents])
  const controlGoal = useCallback(async (goal: Goal, action: GoalControlAction): Promise<void> => {
    if (action.kind === 'transition') {
      await window.agentDesk.transitionProjectGoal(goal.id, action.status, { expectedRevision: goal.revision })
    } else if (action.kind === 'archive') {
      await window.agentDesk.archiveProjectGoal(goal.id, { expectedRevision: goal.revision })
    } else {
      await window.agentDesk.restoreProjectGoal(goal.id, { expectedRevision: goal.revision })
    }
    await refreshContents()
  }, [refreshContents])
  return { controlGoal, controlWorkItem, setWorkItemAcceptance, reorderWorkItem, transferWorkItem, updateGoal }
}

function WorkspaceStatus({
  actions,
  contentsError,
  form,
  onCloseForm,
  onCreateProject,
  onImportProject,
  onRetry,
  workspace
}: {
  actions: StudioCreateActions
  contentsError: string
  form: StudioCreateForm
  onCloseForm: () => void
  onCreateProject: () => void
  onImportProject: (file: File) => Promise<void>
  onRetry: () => void
  workspace: WorkspaceSelection
}): React.JSX.Element {
  const loadError = workspace.error || contentsError
  const showLoading = workspace.loading && workspace.projects.length === 0
  const showEmpty = !workspace.loading && !workspace.error && workspace.projects.length === 0 &&
    form !== 'project' && actions.busy === null
  return (
    <>
      {(loadError || actions.error) && (
        <ErrorNotice message={actions.error || loadError} onRetry={loadError ? onRetry : undefined} />
      )}
      <div className="pws-announcer" role="status" aria-live="polite">{actions.announcement}</div>
      {form === 'project' && (
        <ProjectCreateForm busy={actions.busy} onCancel={onCloseForm} onSubmit={actions.createProject} />
      )}
      {showLoading ? <LoadingState message={TEXT.loadingProjects} /> : null}
      {showEmpty ? <ProjectEmpty onCreate={onCreateProject} onImport={onImportProject} /> : null}
    </>
  )
}

function ProjectContents({
  active,
  actions,
  contents,
  form,
  onCloseForm,
  onGoalControl,
  onGoalUpdate,
  onOpenForm,
  onWorkItemControl,
  onWorkItemAcceptance,
  onWorkItemReorder,
  onWorkItemTransfer,
  onViewChange,
  project,
  starter,
  view
}: {
  active: boolean
  actions: StudioCreateActions
  contents: ProjectContentsState
  form: StudioCreateForm
  onCloseForm: () => void
  onGoalControl: (goal: Goal, action: GoalControlAction) => Promise<void>
  onGoalUpdate: (goal: Goal, patch: GoalPatch) => Promise<void>
  onOpenForm: (form: Exclude<StudioCreateForm, null>) => void
  onWorkItemControl: (item: WorkItem, action: WorkItemControlAction) => Promise<void>
  onWorkItemAcceptance: (item: WorkItem, result: AcceptanceResult) => Promise<void>
  onWorkItemReorder: (item: WorkItem, targetId: string, placement: 'before' | 'after') => Promise<void>
  onWorkItemTransfer: (item: WorkItem, target: WorkItemOwner, reason: string, requestId: string) => Promise<void>
  onViewChange: (view: StudioView) => void
  project: ProjectWorkspace | null
  starter: GoalTaskStarterState
  view: StudioView
}): React.JSX.Element | null {
  if (!project || project.status !== 'active') return null
  const contentsEmpty = contents.goals.length === 0 && contents.workItems.length === 0
  const waitingForContents = contents.loading && contentsEmpty
  const contentsUnavailable = Boolean(contents.error) && contentsEmpty
  return (
    <div className="pws-project-content">
      {waitingForContents && <LoadingState message={TEXT.loadingContents} />}
      {!waitingForContents && !contentsUnavailable && (
        <>
          <GoalTaskStarter projectId={project.id} state={starter} />
          <ProjectInbox
            active={active}
            projectId={project.id}
            workItems={contents.workItems}
            onRefreshProject={contents.refreshContents}
          />
          {form === 'goal' && (
            <GoalCreateForm projectId={project.id} busy={actions.busy} onCancel={onCloseForm} onSubmit={actions.createGoal} />
          )}
          {form === 'workItem' && (
            <WorkItemCreateForm projectId={project.id} goals={contents.goals.filter((goal) => goal.status !== 'archived')} workItems={contents.workItems} busy={actions.busy} onCancel={onCloseForm} onSubmit={actions.createWorkItem} />
          )}
          <GoalsView goals={contents.goals} onCreate={() => onOpenForm('goal')} onControl={onGoalControl} onUpdate={onGoalUpdate} />
          <WorkItemsView key={project.id} projectId={project.id} goals={contents.goals} items={contents.workItems} view={view} onViewChange={onViewChange} onCreate={() => onOpenForm('workItem')} onControl={onWorkItemControl} onAcceptance={onWorkItemAcceptance} onReorder={onWorkItemReorder} onTransfer={onWorkItemTransfer} />
          <ProjectDeliveryWorkbench
            active={active}
            projectId={project.id}
            refreshToken={contents.workItems.map((item) => `${item.id}:${item.revision}`).join('|')}
          />
          <ProjectSupervisorView
            active={active}
            projectId={project.id}
            refreshToken={contents.workItems.map((item) => `${item.id}:${item.revision}`).join('|')}
            workItems={contents.workItems}
            onRefreshProject={contents.refreshContents}
          />
          <ProjectCollaborationView
            projectId={project.id}
            workItems={contents.workItems}
            squads={contents.squads}
            members={contents.members}
            invitations={contents.invitations}
            comments={contents.comments}
            sharedApprovals={contents.sharedApprovals}
            inboxItems={contents.collaborationInbox}
            authorization={contents.authorization}
            onRefresh={contents.refreshContents}
          />
        </>
      )}
    </div>
  )
}

function GoalTaskStarter({
  projectId,
  state
}: {
  projectId: string
  state: GoalTaskStarterState
}): React.JSX.Element {
  const [objective, setObjective] = useState('')
  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (await state.start(projectId, objective)) setObjective('')
  }
  return (
    <form className="pws-goal-task-starter" onSubmit={(event) => void submit(event)} data-goal-task-starter>
      <label className="pws-visually-hidden" htmlFor={`goal-task-${projectId}`}>{TEXT.goalTaskPlaceholder}</label>
      <input
        id={`goal-task-${projectId}`}
        className="input"
        name="objective"
        value={objective}
        maxLength={20_000}
        placeholder={TEXT.goalTaskPlaceholder}
        disabled={state.busy}
        onChange={(event) => setObjective(event.target.value)}
        data-goal-task-objective
      />
      <button type="submit" className="btn btn-primary" disabled={state.busy || !objective.trim()} data-goal-task-start>
        {state.busy ? TEXT.startingGoalTask : TEXT.startGoalTask}
      </button>
      {state.error && <p className="pws-goal-task-error" role="alert">{state.error}</p>}
      {state.announcement && <p className="pws-goal-task-success" role="status">{state.announcement}</p>}
    </form>
  )
}

function StudioHeader({
  disabled,
  goalCount,
  importing,
  onCreate,
  onImport,
  onRefresh,
  onSelect,
  projects,
  refreshing,
  selectedProject,
  selectedProjectId,
  authorization,
  titleId,
  workItemCount
}: {
  disabled: boolean
  goalCount: number
  importing: boolean
  onCreate: () => void
  onImport: (file: File) => Promise<void>
  onRefresh: () => void
  onSelect: (id: string) => void
  projects: ProjectWorkspace[]
  refreshing: boolean
  selectedProject: ProjectWorkspace | null
  selectedProjectId: string
  authorization: import('../../../../shared/types').ProjectAuthorizationView | null
  titleId: string
  workItemCount: number
}): React.JSX.Element {
  const selectId = useId()
  const importInputRef = useRef<HTMLInputElement>(null)
  const importSelectedFile = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const input = event.currentTarget
    const file = input.files?.[0]
    input.value = ''
    if (file) await onImport(file)
  }
  return (
    <header className="pws-header">
      <div className="pws-heading">
        <h1 id={titleId}>{TEXT.title}</h1>
        {selectedProject && (
          <p>{TEXT.projectKindSummary(projectKindLabel(selectedProject.kind))} · {TEXT.projectSummary(goalCount, workItemCount)}{authorization && ` · 角色：${authorization.role} · 权限：${authorization.capabilities.length}`}</p>
        )}
      </div>
      <div className="pws-project-controls">
        <label className="pws-visually-hidden" htmlFor={selectId}>{TEXT.selectProject}</label>
        <select id={selectId} className="select pws-project-select" value={selectedProjectId} onChange={(event) => onSelect(event.target.value)} disabled={disabled || projects.length === 0} aria-label={TEXT.selectProject} data-project-workspace-select>
          {projects.length === 0 && <option value="">{TEXT.noProjects}</option>}
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}{project.status === 'active' ? '' : ` · ${PROJECT_STATUS_LABELS[project.status]}`}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-primary" onClick={onCreate} disabled={disabled} data-studio-action="create-project">{TEXT.createProject}</button>
        <input
          ref={importInputRef}
          className="pws-visually-hidden"
          type="file"
          accept="application/json,.json"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => void importSelectedFile(event)}
          data-studio-import-input
        />
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => importInputRef.current?.click()}
          disabled={disabled}
          data-studio-action="import-project"
        >{importing ? TEXT.importingProject : TEXT.importProject}</button>
        <button type="button" className="btn btn-ghost" onClick={onRefresh} disabled={disabled} data-studio-action="refresh">{refreshing ? TEXT.refreshing : TEXT.refresh}</button>
      </div>
    </header>
  )
}

function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }): React.JSX.Element {
  return (
    <div className="notice notice-error pws-error" role="alert">
      <span>{message}</span>
      {onRetry && <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>{TEXT.retry}</button>}
    </div>
  )
}

function LoadingState({ message }: { message: string }): React.JSX.Element {
  return <div className="pws-loading" role="status" aria-live="polite"><span className="pws-loading-mark" aria-hidden="true" />{message}</div>
}

function ProjectEmpty({
  onCreate,
  onImport
}: {
  onCreate: () => void
  onImport: (file: File) => Promise<void>
}): React.JSX.Element {
  const importInputRef = useRef<HTMLInputElement>(null)
  return (
    <div className="pws-project-empty">
      <p>{TEXT.noProjects}</p>
      <div className="pws-project-empty-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={onCreate}
          data-studio-action="create-project-empty"
        >{TEXT.createProject}</button>
        <input
          ref={importInputRef}
          className="pws-visually-hidden"
          type="file"
          accept="application/json,.json"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const input = event.currentTarget
            const file = input.files?.[0]
            input.value = ''
            if (file) void onImport(file)
          }}
        />
        <button type="button" className="btn btn-ghost" onClick={() => importInputRef.current?.click()}>
          {TEXT.importProject}
        </button>
      </div>
    </div>
  )
}

export default memo(ProjectWorkspaceStudio)

function readStoredStudioView(): StudioView {
  try {
    return window.localStorage.getItem('caogen.project-workspace.work-items.view.v1') === 'board' ? 'board' : 'list'
  } catch {
    return 'list'
  }
}
