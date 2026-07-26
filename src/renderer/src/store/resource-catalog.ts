import type { AppSettings, Project, ProviderInput, ProviderView } from '../../../shared/types'

interface ResourceCatalogState {
  providers: ProviderView[]
  providersLoaded: boolean
  projects: Project[]
  projectsLoaded: boolean
  settings: AppSettings
  newSessionProjectId: string | null
  updateSettings(patch: Partial<AppSettings>): Promise<void>
}

type ResourceCatalogUpdate = Partial<
  Pick<
    ResourceCatalogState,
    'providers' | 'providersLoaded' | 'projects' | 'projectsLoaded' | 'newSessionProjectId'
  >
>

export interface ResourceCatalogSlice {
  providers: ProviderView[]
  providersLoaded: boolean
  projects: Project[]
  projectsLoaded: boolean
  refreshProviders(): Promise<void>
  createProvider(input: ProviderInput): Promise<ProviderView>
  updateProvider(id: string, patch: Partial<ProviderInput>): Promise<ProviderView>
  deleteProvider(id: string): Promise<void>
  refreshProjects(): Promise<void>
  archiveProject(id: string, archived: boolean): Promise<void>
  deleteProject(id: string): Promise<void>
}

export function createResourceCatalogSlice(
  set: (update: ResourceCatalogUpdate) => void,
  get: () => ResourceCatalogState
): ResourceCatalogSlice {
  return {
    providers: [],
    providersLoaded: false,
    projects: [],
    projectsLoaded: false,

    async refreshProviders() {
      await refreshProviderCatalog(set)
    },

    async createProvider(input) {
      const provider = await window.agentDesk.createProvider(input)
      await refreshProviderCatalog(set)
      return provider
    },

    async updateProvider(id, patch) {
      const provider = await window.agentDesk.updateProvider(id, patch)
      await refreshProviderCatalog(set)
      return provider
    },

    async deleteProvider(id) {
      await window.agentDesk.deleteProvider(id)
      await refreshProviderCatalog(set)
      if (get().settings.defaultProviderId === id) {
        await get().updateSettings({ defaultProviderId: '' })
      }
    },

    async refreshProjects() {
      const projects = await window.agentDesk.listProjects()
      set({ projects, projectsLoaded: true })
    },

    async archiveProject(id, archived) {
      await window.agentDesk.updateProject(id, { archived })
      await refreshProjectsAfterMutation(set, get, id)
    },

    async deleteProject(id) {
      await window.agentDesk.deleteProject(id)
      await refreshProjectsAfterMutation(set, get, id)
    }
  }
}

async function refreshProviderCatalog(set: (update: ResourceCatalogUpdate) => void): Promise<void> {
  const providers = await window.agentDesk.listProviders()
  set({ providers, providersLoaded: true })
}

async function refreshProjectsAfterMutation(
  set: (update: ResourceCatalogUpdate) => void,
  get: () => ResourceCatalogState,
  changedProjectId: string
): Promise<void> {
  const projects = await window.agentDesk.listProjects()
  set({
    projects,
    projectsLoaded: true,
    newSessionProjectId:
      get().newSessionProjectId === changedProjectId ? null : get().newSessionProjectId
  })
}
