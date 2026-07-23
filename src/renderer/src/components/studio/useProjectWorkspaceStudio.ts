import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Goal,
  GoalInput,
  ProjectWorkspace,
  ProjectWorkspaceInput,
  WorkItem,
  WorkItemInput
} from '../../../../shared/types'
import { compareWorkItemsByBoardOrder, errorText, TEXT, type StudioMutationKind } from './projectWorkspaceStudioModel'

export function useWorkspaceSelection(
  initialProjectId?: string,
  onProjectChange?: (project: ProjectWorkspace | null) => void
): {
  projects: ProjectWorkspace[]
  selectedProject: ProjectWorkspace | null
  selectedProjectId: string
  loading: boolean
  error: string
  selectProject: (id: string) => void
  refreshProjects: (preferredId?: string) => Promise<void>
} {
  const [projects, setProjects] = useState<ProjectWorkspace[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const request = useRef(0)
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  )

  const refreshProjects = useCallback(async (preferredId?: string): Promise<void> => {
    const requestId = ++request.current
    setLoading(true)
    setError('')
    try {
      const next = await window.agentDesk.listProjectWorkspaces({ includeArchived: true, includeDeleted: true })
      if (requestId !== request.current) return
      next.sort((left, right) => right.updatedAt - left.updatedAt)
      setProjects(next)
      setSelectedProjectId((current) => chooseProjectId(next, preferredId || current))
    } catch (cause) {
      if (requestId === request.current) setError(errorText(cause))
    } finally {
      if (requestId === request.current) setLoading(false)
    }
  }, [])

  useEffect(() => { void refreshProjects(initialProjectId) }, [initialProjectId, refreshProjects])
  useEffect(() => { onProjectChange?.(selectedProject) }, [onProjectChange, selectedProject])
  useEffect(() => () => { request.current += 1 }, [])

  return {
    projects,
    selectedProject,
    selectedProjectId,
    loading,
    error,
    selectProject: setSelectedProjectId,
    refreshProjects
  }
}

export function useProjectContents(projectId: string): {
  goals: Goal[]
  workItems: WorkItem[]
  loading: boolean
  error: string
  refreshContents: () => Promise<void>
} {
  const [goals, setGoals] = useState<Goal[]>([])
  const [workItems, setWorkItems] = useState<WorkItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const request = useRef(0)

  const refreshContents = useCallback(async (): Promise<void> => {
    if (!projectId) return
    const requestId = ++request.current
    setLoading(true)
    setError('')
    try {
      const [nextGoals, nextWorkItems] = await Promise.all([
        window.agentDesk.listProjectGoals(projectId, { includeArchived: true }),
        window.agentDesk.listProjectWorkItems(projectId)
      ])
      if (requestId !== request.current) return
      setGoals(nextGoals.sort((left, right) => right.updatedAt - left.updatedAt))
      setWorkItems(nextWorkItems.sort(compareWorkItemsByBoardOrder))
    } catch (cause) {
      if (requestId === request.current) setError(errorText(cause))
    } finally {
      if (requestId === request.current) setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    request.current += 1
    setGoals([])
    setWorkItems([])
    setError('')
    if (projectId) void refreshContents()
  }, [projectId, refreshContents])
  useEffect(() => () => { request.current += 1 }, [])

  return { goals, workItems, loading, error, refreshContents }
}

export function useStudioCreateActions({
  onSuccess,
  refreshContents,
  refreshProjects
}: {
  onSuccess: () => void
  refreshContents: () => Promise<void>
  refreshProjects: (preferredId?: string) => Promise<void>
}): {
  busy: StudioMutationKind | null
  error: string
  announcement: string
  clearFeedback: () => void
  createProject: (input: ProjectWorkspaceInput) => Promise<void>
  createGoal: (input: GoalInput) => Promise<void>
  createWorkItem: (input: WorkItemInput) => Promise<void>
} {
  const [busy, setBusy] = useState<StudioMutationKind | null>(null)
  const [error, setError] = useState('')
  const [announcement, setAnnouncement] = useState('')

  const run = useCallback(async <T,>(
    kind: StudioMutationKind,
    action: () => Promise<T>,
    after: (result: T) => Promise<void>,
    successMessage: string
  ): Promise<void> => {
    setBusy(kind)
    setError('')
    setAnnouncement('')
    try {
      const result = await action()
      await after(result)
      setAnnouncement(successMessage)
      onSuccess()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(null)
    }
  }, [onSuccess])

  const createProject = useCallback((input: ProjectWorkspaceInput) => run(
    'project',
    () => window.agentDesk.createProjectWorkspace(input),
    (created) => refreshProjects(created.id),
    TEXT.projectCreated
  ), [refreshProjects, run])
  const createGoal = useCallback((input: GoalInput) => run(
    'goal', () => window.agentDesk.createProjectGoal(input), async () => refreshContents(), TEXT.goalCreated
  ), [refreshContents, run])
  const createWorkItem = useCallback((input: WorkItemInput) => run(
    'workItem', () => window.agentDesk.createProjectWorkItem(input), async () => refreshContents(), TEXT.workItemCreated
  ), [refreshContents, run])
  const clearFeedback = useCallback(() => { setError(''); setAnnouncement('') }, [])

  return { busy, error, announcement, clearFeedback, createProject, createGoal, createWorkItem }
}

function chooseProjectId(projects: ProjectWorkspace[], preferredId?: string): string {
  if (preferredId && projects.some((project) => project.id === preferredId)) return preferredId
  return projects[0]?.id ?? ''
}
