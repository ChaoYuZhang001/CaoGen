import { useCallback, useEffect, useState } from 'react'
import type {
  ProjectResourceInput,
  ProjectWorkspace,
  ProjectWorkspaceManifest,
  ProjectWorkspacePatch
} from '../../../../shared/types'
import { errorText, TEXT, type ProjectLifecycleMutation } from './projectWorkspaceStudioModel'

interface LifecycleOptions {
  project: ProjectWorkspace
  refreshContents: () => Promise<void>
  refreshProjects: (preferredId?: string) => Promise<void>
  onMutationSuccess: () => void
}

interface LifecycleActions {
  announcement: string
  busy: ProjectLifecycleMutation | null
  error: string
  manifest: ProjectWorkspaceManifest | null
  clearFeedback: () => void
  updateProject: (patch: ProjectWorkspacePatch) => Promise<void>
  addResource: (resource: ProjectResourceInput) => Promise<void>
  removeResource: (resourceId: string) => Promise<void>
  archiveProject: () => Promise<void>
  restoreProject: () => Promise<void>
  exportManifest: () => Promise<void>
  closeManifest: () => void
  copyManifest: () => Promise<void>
  softDeleteProject: () => Promise<void>
  purgeProject: () => Promise<void>
}

type MutationRunner = <T>(
  kind: ProjectLifecycleMutation,
  action: () => Promise<T>,
  after: (result: T) => Promise<void>,
  successMessage: string
) => Promise<void>

export function useProjectWorkspaceLifecycle(options: LifecycleOptions): LifecycleActions {
  const { onMutationSuccess, project, refreshContents, refreshProjects } = options
  const feedback = useLifecycleFeedback(project.id, onMutationSuccess)
  const [manifest, setManifest] = useState<ProjectWorkspaceManifest | null>(null)
  const refreshProject = useCallback(async (updated: ProjectWorkspace): Promise<void> => {
    await refreshProjects(updated.id)
  }, [refreshProjects])
  const projectMutations = useProjectMutations(project, refreshProject, feedback.run)
  const statusMutations = useProjectStatusMutations({
    project,
    refreshContents,
    refreshProject,
    refreshProjects,
    run: feedback.run
  })

  useEffect(() => setManifest(null), [project.id])

  const exportManifest = useCallback(async (): Promise<void> => {
    feedback.begin('export')
    try {
      const exported = await window.agentDesk.exportProjectWorkspaceManifest(project.id)
      setManifest(exported)
      feedback.succeed(`${TEXT.exportManifest} · ${exported.digest.slice(0, 12)}`)
    } catch (cause) {
      feedback.fail(cause)
    } finally {
      feedback.finish()
    }
  }, [feedback, project.id])

  const copyManifest = useCallback(async (): Promise<void> => {
    if (!manifest) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(manifest, null, 2))
      feedback.succeed(TEXT.manifestCopied)
    } catch (cause) {
      feedback.fail(cause)
    }
  }, [feedback, manifest])

  const closeManifest = useCallback(() => setManifest(null), [])
  return {
    announcement: feedback.announcement,
    busy: feedback.busy,
    error: feedback.error,
    manifest,
    clearFeedback: feedback.clear,
    ...projectMutations,
    ...statusMutations,
    exportManifest,
    closeManifest,
    copyManifest
  }
}

function useLifecycleFeedback(projectId: string, onSuccess: () => void) {
  const [busy, setBusy] = useState<ProjectLifecycleMutation | null>(null)
  const [error, setError] = useState('')
  const [announcement, setAnnouncement] = useState('')
  useEffect(() => {
    setError('')
    setAnnouncement('')
  }, [projectId])
  const begin = useCallback((kind: ProjectLifecycleMutation): void => {
    setBusy(kind)
    setError('')
    setAnnouncement('')
  }, [])
  const finish = useCallback(() => setBusy(null), [])
  const fail = useCallback((cause: unknown) => setError(errorText(cause)), [])
  const succeed = useCallback((message: string) => setAnnouncement(message), [])
  const clear = useCallback(() => {
    setError('')
    setAnnouncement('')
  }, [])
  const run = useCallback<MutationRunner>(async (kind, action, after, successMessage) => {
    begin(kind)
    try {
      const result = await action()
      await after(result)
      succeed(successMessage)
      onSuccess()
    } catch (cause) {
      fail(cause)
    } finally {
      finish()
    }
  }, [begin, fail, finish, onSuccess, succeed])
  return { announcement, busy, error, begin, finish, fail, succeed, clear, run }
}

function useProjectMutations(
  project: ProjectWorkspace,
  refreshProject: (updated: ProjectWorkspace) => Promise<void>,
  run: MutationRunner
) {
  const updateProject = useCallback((patch: ProjectWorkspacePatch) => run(
    'update',
    () => window.agentDesk.updateProjectWorkspace(project.id, patch, { expectedRevision: project.revision }),
    refreshProject,
    TEXT.projectUpdated
  ), [project.id, project.revision, refreshProject, run])
  const addResource = useCallback((resource: ProjectResourceInput) => run(
    'resource',
    () => window.agentDesk.updateProjectWorkspace(
      project.id,
      { resources: [...project.resources, resource] },
      { expectedRevision: project.revision }
    ),
    refreshProject,
    TEXT.resourceAdded
  ), [project.id, project.resources, project.revision, refreshProject, run])
  const removeResource = useCallback((resourceId: string) => run(
    'resource',
    () => window.agentDesk.updateProjectWorkspace(
      project.id,
      { resources: project.resources.filter((resource) => resource.id !== resourceId) },
      { expectedRevision: project.revision }
    ),
    refreshProject,
    TEXT.resourceRemoved
  ), [project.id, project.resources, project.revision, refreshProject, run])
  return { updateProject, addResource, removeResource }
}

function useProjectStatusMutations({
  project,
  refreshContents,
  refreshProject,
  refreshProjects,
  run
}: {
  project: ProjectWorkspace
  refreshContents: () => Promise<void>
  refreshProject: (updated: ProjectWorkspace) => Promise<void>
  refreshProjects: (preferredId?: string) => Promise<void>
  run: MutationRunner
}) {
  const archiveProject = useCallback(() => run(
    'archive',
    () => window.agentDesk.archiveProjectWorkspace(project.id, { expectedRevision: project.revision }),
    refreshProject,
    TEXT.projectArchived
  ), [project.id, project.revision, refreshProject, run])
  const restoreProject = useCallback(() => run(
    'restore',
    () => window.agentDesk.restoreProjectWorkspace(project.id, { expectedRevision: project.revision }),
    async (updated) => {
      await refreshProject(updated)
      await refreshContents()
    },
    TEXT.projectRestored
  ), [project.id, project.revision, refreshContents, refreshProject, run])
  const softDeleteProject = useCallback(() => run(
    'delete',
    () => window.agentDesk.deleteProjectWorkspace(project.id, { expectedRevision: project.revision }),
    async (updated) => {
      if (updated) await refreshProject(updated)
    },
    TEXT.deletedProjectNotice
  ), [project.id, project.revision, refreshProject, run])
  const purgeProject = useCallback(() => run(
    'purge',
    () => window.agentDesk.purgeProjectWorkspace(project.id, { expectedRevision: project.revision }),
    async () => refreshProjects(),
    TEXT.purgeProject
  ), [project.id, project.revision, refreshProjects, run])
  return { archiveProject, restoreProject, softDeleteProject, purgeProject }
}
