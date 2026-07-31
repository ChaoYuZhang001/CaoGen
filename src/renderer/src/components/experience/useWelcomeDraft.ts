import { useEffect, useMemo } from 'react'
import { AUTO_MODEL, caogenDrivePolicyView } from '../../../../shared/types'
import type {
  AppSettings,
  CaoGenDriveMode,
  Project,
  ProviderView
} from '../../../../shared/types'
import { useStore } from '../../store'
import type { WelcomeDraftState, WelcomeRoutingMode } from '../../store/welcome-draft'

export const NEW_PROJECT = '__new_project__'
export const UNASSIGNED = '__unassigned__'

interface WelcomeDraftControllerOptions {
  projects: Project[]
  providers: ProviderView[]
  requestedProjectId: string | null
  settings: AppSettings
}

function resolveProjectDraft(
  availableProjects: Project[],
  storedProjectChoice: string | null,
  storedCwd: string | null,
  initialProject: Project | undefined,
  projectsLoaded: boolean
): { projectChoice: string; cwd: string } {
  if (!projectsLoaded) {
    return { projectChoice: storedProjectChoice ?? NEW_PROJECT, cwd: storedCwd ?? '' }
  }
  const storedProjectMissing = storedProjectChoice !== null
    && storedProjectChoice !== NEW_PROJECT
    && storedProjectChoice !== UNASSIGNED
    && !availableProjects.some((project) => project.id === storedProjectChoice)
  if (storedProjectMissing) return { projectChoice: UNASSIGNED, cwd: '' }
  return {
    projectChoice: storedProjectChoice ?? initialProject?.id ?? NEW_PROJECT,
    cwd: storedCwd ?? initialProject?.path ?? ''
  }
}

export function useWelcomeDraftController({
  projects,
  providers,
  requestedProjectId,
  settings
}: WelcomeDraftControllerOptions) {
  const stored = useStore((state) => state.welcomeDraft)
  const update = useStore((state) => state.updateWelcomeDraft)
  const clear = useStore((state) => state.clearWelcomeDraft)
  const projectsLoaded = useStore((state) => state.projectsLoaded)
  const providersLoaded = useStore((state) => state.providersLoaded)
  const availableProjects = useMemo(
    () => projects.filter((project) => !project.archived),
    [projects]
  )
  const initialProject = availableProjects.find((project) => project.id === requestedProjectId)
    ?? availableProjects[0]
  const { projectChoice, cwd } = resolveProjectDraft(
    availableProjects,
    stored.projectChoice,
    stored.cwd,
    initialProject,
    projectsLoaded
  )
  const driveMode = stored.driveMode ?? settings.driveMode
  const { providerId, model } = useResolvedProviderDraft(
    providers,
    settings,
    stored,
    providersLoaded,
    update
  )
  const permissionMode = stored.permissionMode
    ?? caogenDrivePolicyView(settings.driveMode).defaultPermissionMode

  useEffect(() => {
    if (!projectsLoaded || stored.projectChoice !== null || stored.cwd || !initialProject) return
    update({ projectChoice: initialProject.id, cwd: initialProject.path })
  }, [initialProject, projectsLoaded, stored.cwd, stored.projectChoice, update])

  useEffect(() => {
    if (!projectsLoaded || !requestedProjectId) return
    const requested = availableProjects.find((project) => project.id === requestedProjectId)
    if (requested) update({ projectChoice: requested.id, cwd: requested.path })
  }, [availableProjects, projectsLoaded, requestedProjectId, update])

  useEffect(() => {
    const storedProjectChoice = stored.projectChoice
    if (!projectsLoaded) return
    if (storedProjectChoice === null || storedProjectChoice === NEW_PROJECT || storedProjectChoice === UNASSIGNED) return
    if (!availableProjects.some((project) => project.id === storedProjectChoice)) {
      update({ projectChoice: UNASSIGNED, cwd: '' })
    }
  }, [availableProjects, projectsLoaded, stored.projectChoice, update])

  const setRoutingMode = (routingMode: WelcomeRoutingMode, firstFixedModel: string): void => {
    update({ routingMode, model: routingMode === 'fixed' ? firstFixedModel : AUTO_MODEL })
  }
  const setProvider = (nextProviderId: string): void => {
    const provider = providers.find((item) => item.id === nextProviderId)
    update({
      providerId: nextProviderId,
      model: stored.routingMode === 'fixed' ? provider?.models[0] ?? '' : AUTO_MODEL
    })
  }
  const setDriveMode = (nextDriveMode: CaoGenDriveMode): void => {
    const selectedProvider = providers.find((provider) => provider.id === providerId)
    const nextModel = stored.routingMode === 'fixed'
      ? selectedProvider?.models.includes(model) ? model : ''
      : providerId ? AUTO_MODEL : ''
    update({
      driveMode: nextDriveMode,
      model: nextModel,
      permissionMode: caogenDrivePolicyView(nextDriveMode).defaultPermissionMode
    })
  }
  const setProject = (nextProjectChoice: string): void => {
    const project = projects.find((item) => item.id === nextProjectChoice)
    update({ projectChoice: nextProjectChoice, cwd: project?.path ?? '' })
  }
  const setPickedDirectory = (nextCwd: string): void => {
    update({
      projectChoice: projectChoice === UNASSIGNED ? UNASSIGNED : NEW_PROJECT,
      cwd: nextCwd
    })
  }

  return {
    availableProjects,
    clear,
    cwd,
    driveMode,
    model,
    permissionMode,
    projectChoice,
    providerId,
    routingMode: stored.routingMode,
    setDriveMode,
    setPickedDirectory,
    setProject,
    setProvider,
    setRoutingMode,
    text: stored.text,
    update
  }
}

function initialProviderModel(provider: ProviderView | undefined, defaultModel: string): string {
  if (!provider) return ''
  return defaultModel && provider.models.includes(defaultModel) ? defaultModel : AUTO_MODEL
}

function useResolvedProviderDraft(
  providers: ProviderView[],
  settings: AppSettings,
  stored: WelcomeDraftState,
  providersLoaded: boolean,
  update: (patch: Partial<WelcomeDraftState>) => void
): { providerId: string; model: string } {
  const initialProvider = providers.find(
    (provider) => provider.id === settings.defaultProviderId && provider.hasToken && provider.models.length > 0
  )
  const storedProvider = providersLoaded && stored.providerId
    ? providers.find(
        (provider) => provider.id === stored.providerId && provider.hasToken && provider.models.length > 0
      )
    : undefined
  const providerId = !providersLoaded
    ? stored.providerId ?? ''
    : stored.providerId === null
      ? initialProvider?.id ?? ''
      : storedProvider?.id ?? ''
  const model = !providersLoaded
    ? stored.model ?? ''
    : stored.providerId === null
      ? initialProviderModel(initialProvider, settings.defaultModel)
      : storedProviderModel(stored.routingMode, stored.model, storedProvider)

  useEffect(() => {
    if (!providersLoaded) return
    if (stored.providerId === null) {
      if (initialProvider) {
        update({ providerId: initialProvider.id, model: initialProviderModel(initialProvider, settings.defaultModel) })
      }
      return
    }
    const nextModel = storedProviderModel(stored.routingMode, stored.model, storedProvider)
    if (!storedProvider) {
      if (stored.providerId !== '' || stored.model !== '') update({ providerId: '', model: '' })
      return
    }
    if (stored.model !== nextModel) update({ model: nextModel })
  }, [initialProvider, providersLoaded, settings.defaultModel, stored.model, stored.providerId, stored.routingMode, storedProvider, update])

  return { providerId, model }
}

function storedProviderModel(
  routingMode: WelcomeRoutingMode,
  storedModel: string | null,
  provider: ProviderView | undefined
): string {
  if (!provider) return ''
  if (routingMode !== 'fixed') return AUTO_MODEL
  return storedModel && provider.models.includes(storedModel) ? storedModel : ''
}
