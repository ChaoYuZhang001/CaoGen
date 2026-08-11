import { MANAGED_PERSONAL_WORKSPACE_ID, type ProjectWorkspace } from '../../../shared/types'
import type { ExperienceMode } from './experience-mode'

export interface ProjectWorkspaceStoreSlice {
  projectWorkspaces: ProjectWorkspace[]
  projectWorkspacesLoading: boolean
  projectWorkspacesError?: string
  preferredProjectWorkspaceId: string | null
  studioNavigationNonce: number
  studioNewProjectNonce: number
  studioSessionNavigationNonce: number
  refreshProjectWorkspaces(): Promise<ProjectWorkspace[]>
  archiveCanonicalProject(id: string, archived: boolean): Promise<void>
  deleteCanonicalProject(id: string): Promise<void>
  openProjectWorkspace(id: string): void
  openNewProjectWorkspace(): void
}

interface ProjectWorkspaceStoreHost extends ProjectWorkspaceStoreSlice {
  experienceMode: ExperienceMode
  showNewSession: boolean
  showSettings: boolean
}

export function nextStudioSessionNonce(current: number, mode: ExperienceMode, requested = true): number {
  return requested && mode === 'studio' ? current + 1 : current
}

export function createProjectWorkspaceStoreSlice<T extends ProjectWorkspaceStoreHost>(
  set: (update: Partial<T> | ((state: T) => Partial<T>)) => void,
  get: () => T
): ProjectWorkspaceStoreSlice {
  return {
    projectWorkspaces: [],
    projectWorkspacesLoading: false,
    preferredProjectWorkspaceId: null,
    studioNavigationNonce: 0,
    studioNewProjectNonce: 0,
    studioSessionNavigationNonce: 0,

    async refreshProjectWorkspaces() {
      set({ projectWorkspacesLoading: true, projectWorkspacesError: undefined } as Partial<T>)
      try {
        const projectWorkspaces = (await window.agentDesk.listProjectWorkspaces({
          includeArchived: true,
          includeDeleted: true
        })).filter((workspace) => workspace.id !== MANAGED_PERSONAL_WORKSPACE_ID)
        projectWorkspaces.sort((left, right) => right.updatedAt - left.updatedAt)
        set({ projectWorkspaces, projectWorkspacesLoading: false } as Partial<T>)
        return projectWorkspaces
      } catch (error) {
        set({
          projectWorkspacesLoading: false,
          projectWorkspacesError: error instanceof Error ? error.message : String(error)
        } as Partial<T>)
        throw error
      }
    },

    async archiveCanonicalProject(id, archived) {
      if (id === MANAGED_PERSONAL_WORKSPACE_ID) return
      const project = get().projectWorkspaces.find((item) => item.id === id)
      if (!project) return
      if (archived) {
        await window.agentDesk.archiveProjectWorkspace(id, { expectedRevision: project.revision })
      } else {
        await window.agentDesk.restoreProjectWorkspace(id, { expectedRevision: project.revision })
      }
      await get().refreshProjectWorkspaces()
    },

    async deleteCanonicalProject(id) {
      if (id === MANAGED_PERSONAL_WORKSPACE_ID) return
      const project = get().projectWorkspaces.find((item) => item.id === id)
      if (!project) return
      await window.agentDesk.deleteProjectWorkspace(id, { expectedRevision: project.revision })
      await get().refreshProjectWorkspaces()
      set((state) => ({
        preferredProjectWorkspaceId: state.preferredProjectWorkspaceId === id
          ? null
          : state.preferredProjectWorkspaceId
      } as Partial<T>))
    },

    openProjectWorkspace(id) {
      set((state) => ({
        experienceMode: 'studio',
        preferredProjectWorkspaceId: id,
        showNewSession: false,
        showSettings: false,
        studioNavigationNonce: state.studioNavigationNonce + 1
      } as Partial<T>))
    },

    openNewProjectWorkspace() {
      set((state) => ({
        experienceMode: 'studio',
        showNewSession: false,
        showSettings: false,
        studioNavigationNonce: state.studioNavigationNonce + 1,
        studioNewProjectNonce: state.studioNewProjectNonce + 1
      } as Partial<T>))
    }
  }
}
