import { useCallback, useEffect, useId, useState } from 'react'
import type { Goal, GoalPatch, ProjectWorkspace, ProjectWorkspaceLeaseOptions, WorkItem } from '../../../../shared/types'
import {
  GoalCreateForm,
  ProjectCreateForm,
  WorkItemCreateForm
} from './ProjectWorkspaceStudioForms'
import { GoalsView, WorkItemsView } from './ProjectWorkspaceStudioViews'
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
  useStudioCreateActions,
  useWorkspaceSelection
} from './useProjectWorkspaceStudio'
import './ProjectWorkspaceStudio.css'

export interface ProjectWorkspaceStudioProps {
  className?: string
  initialProjectId?: string
  onProjectChange?: (project: ProjectWorkspace | null) => void
  onWorkItemsChange?: (workItems: WorkItem[]) => void
  onContextChange?: (context: ProjectWorkspaceStudioContext) => void
}

export interface ProjectWorkspaceStudioContext {
  project: ProjectWorkspace | null
  goals: Goal[]
  workItems: WorkItem[]
}

type WorkspaceSelection = ReturnType<typeof useWorkspaceSelection>
type ProjectContentsState = ReturnType<typeof useProjectContents>
type StudioCreateActions = ReturnType<typeof useStudioCreateActions>

export function ProjectWorkspaceStudio({
  className,
  initialProjectId,
  onContextChange,
  onProjectChange,
  onWorkItemsChange
}: ProjectWorkspaceStudioProps): React.JSX.Element {
  const titleId = useId()
  const [form, setForm] = useState<StudioCreateForm>(null)
  const [view, setView] = useState<StudioView>(() => readStoredStudioView())
  const workspace = useWorkspaceSelection(initialProjectId, onProjectChange)
  const contents = useProjectContents(workspace.selectedProjectId)
  const closeForm = useCallback(() => setForm(null), [])
  const actions = useStudioCreateActions({
    onSuccess: closeForm,
    refreshContents: contents.refreshContents,
    refreshProjects: workspace.refreshProjects
  })
  const controls = useStudioEntityActions(contents.refreshContents)

  useEffect(() => {
    setForm((current) => current === 'project' ? current : null)
  }, [workspace.selectedProjectId])
  useEffect(() => {
    try { window.localStorage.setItem('caogen.project-workspace.work-items.view.v1', view) } catch { /* preference persistence is best effort */ }
  }, [view])
  useEffect(() => {
    onWorkItemsChange?.(contents.workItems)
    onContextChange?.({
      project: workspace.selectedProject,
      goals: contents.goals,
      workItems: contents.workItems
    })
  }, [contents.goals, contents.workItems, onContextChange, onWorkItemsChange, workspace.selectedProject])

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
  const loading = workspace.loading || contents.loading || actions.busy !== null
  return (
    <section className={rootClassName} aria-labelledby={titleId} aria-busy={loading} data-project-workspace-studio>
      <StudioHeader
        titleId={titleId}
        projects={workspace.projects}
        selectedProject={workspace.selectedProject}
        selectedProjectId={workspace.selectedProjectId}
        goalCount={contents.goals.length}
        workItemCount={contents.workItems.length}
        disabled={loading}
        refreshing={workspace.loading || contents.loading}
        onCreate={() => openForm('project')}
        onRefresh={() => void refresh()}
        onSelect={workspace.selectProject}
      />

      <WorkspaceStatus
        actions={actions}
        contentsError={contents.error}
        form={form}
        onCloseForm={closeForm}
        onCreateProject={() => openForm('project')}
        onRetry={retry}
        workspace={workspace}
      />
      {workspace.selectedProject && (
        <ProjectWorkspaceLifecycle
          project={workspace.selectedProject}
          refreshContents={contents.refreshContents}
          refreshProjects={workspace.refreshProjects}
        />
      )}
      <ProjectContents
        actions={actions}
        contents={contents}
        form={form}
        onCloseForm={closeForm}
        onOpenForm={openForm}
        onGoalControl={controls.controlGoal}
        onGoalUpdate={controls.updateGoal}
        onWorkItemControl={controls.controlWorkItem}
        onWorkItemReorder={controls.reorderWorkItem}
        onViewChange={setView}
        project={workspace.selectedProject}
        view={view}
      />
    </section>
  )
}

function useStudioEntityActions(refreshContents: () => Promise<void>): {
  controlGoal: (goal: Goal, action: GoalControlAction) => Promise<void>
  controlWorkItem: (item: WorkItem, action: WorkItemControlAction) => Promise<void>
  reorderWorkItem: (item: WorkItem, targetId: string, placement: 'before' | 'after') => Promise<void>
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
  const reorderWorkItem = useCallback(async (item: WorkItem, targetId: string, placement: 'before' | 'after'): Promise<void> => {
    await window.agentDesk.reorderProjectWorkItem(item.id, targetId, placement, { expectedRevision: item.revision })
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
  return { controlGoal, controlWorkItem, reorderWorkItem, updateGoal }
}

function WorkspaceStatus({
  actions,
  contentsError,
  form,
  onCloseForm,
  onCreateProject,
  onRetry,
  workspace
}: {
  actions: StudioCreateActions
  contentsError: string
  form: StudioCreateForm
  onCloseForm: () => void
  onCreateProject: () => void
  onRetry: () => void
  workspace: WorkspaceSelection
}): React.JSX.Element {
  const loadError = workspace.error || contentsError
  const showLoading = workspace.loading && workspace.projects.length === 0
  const showEmpty = !workspace.loading && !workspace.error && workspace.projects.length === 0 && form !== 'project'
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
      {showEmpty ? <ProjectEmpty onCreate={onCreateProject} /> : null}
    </>
  )
}

function ProjectContents({
  actions,
  contents,
  form,
  onCloseForm,
  onGoalControl,
  onGoalUpdate,
  onOpenForm,
  onWorkItemControl,
  onWorkItemReorder,
  onViewChange,
  project,
  view
}: {
  actions: StudioCreateActions
  contents: ProjectContentsState
  form: StudioCreateForm
  onCloseForm: () => void
  onGoalControl: (goal: Goal, action: GoalControlAction) => Promise<void>
  onGoalUpdate: (goal: Goal, patch: GoalPatch) => Promise<void>
  onOpenForm: (form: Exclude<StudioCreateForm, null>) => void
  onWorkItemControl: (item: WorkItem, action: WorkItemControlAction) => Promise<void>
  onWorkItemReorder: (item: WorkItem, targetId: string, placement: 'before' | 'after') => Promise<void>
  onViewChange: (view: StudioView) => void
  project: ProjectWorkspace | null
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
          {form === 'goal' && (
            <GoalCreateForm projectId={project.id} busy={actions.busy} onCancel={onCloseForm} onSubmit={actions.createGoal} />
          )}
          {form === 'workItem' && (
            <WorkItemCreateForm projectId={project.id} goals={contents.goals.filter((goal) => goal.status !== 'archived')} workItems={contents.workItems} busy={actions.busy} onCancel={onCloseForm} onSubmit={actions.createWorkItem} />
          )}
          <GoalsView goals={contents.goals} onCreate={() => onOpenForm('goal')} onControl={onGoalControl} onUpdate={onGoalUpdate} />
          <WorkItemsView key={project.id} projectId={project.id} goals={contents.goals} items={contents.workItems} view={view} onViewChange={onViewChange} onCreate={() => onOpenForm('workItem')} onControl={onWorkItemControl} onReorder={onWorkItemReorder} />
        </>
      )}
    </div>
  )
}

function StudioHeader({
  disabled,
  goalCount,
  onCreate,
  onRefresh,
  onSelect,
  projects,
  refreshing,
  selectedProject,
  selectedProjectId,
  titleId,
  workItemCount
}: {
  disabled: boolean
  goalCount: number
  onCreate: () => void
  onRefresh: () => void
  onSelect: (id: string) => void
  projects: ProjectWorkspace[]
  refreshing: boolean
  selectedProject: ProjectWorkspace | null
  selectedProjectId: string
  titleId: string
  workItemCount: number
}): React.JSX.Element {
  const selectId = useId()
  return (
    <header className="pws-header">
      <div className="pws-heading">
        <h1 id={titleId}>{TEXT.title}</h1>
        {selectedProject && (
          <p>{TEXT.projectKindSummary(projectKindLabel(selectedProject.kind))} · {TEXT.projectSummary(goalCount, workItemCount)}</p>
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

function ProjectEmpty({ onCreate }: { onCreate: () => void }): React.JSX.Element {
  return (
    <div className="pws-project-empty">
      <p>{TEXT.noProjects}</p>
      <button type="button" className="btn btn-primary" onClick={onCreate}>{TEXT.createProject}</button>
    </div>
  )
}

export default ProjectWorkspaceStudio

function readStoredStudioView(): StudioView {
  try {
    return window.localStorage.getItem('caogen.project-workspace.work-items.view.v1') === 'board' ? 'board' : 'list'
  } catch {
    return 'list'
  }
}
