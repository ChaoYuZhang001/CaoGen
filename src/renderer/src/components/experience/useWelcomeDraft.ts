import { useEffect, useMemo } from 'react'
import { AUTO_MODEL, caogenDrivePolicyView } from '../../../../shared/types'
import type {
  AppSettings,
  CaoGenDriveMode,
  Project,
  ProviderView
} from '../../../../shared/types'
import { useStore } from '../../store'
import type { WelcomeRoutingMode } from '../../store/welcome-draft'

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
  initialProject: Project | undefined
): { projectChoice: string; cwd: string } {
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
  const availableProjects = useMemo(
    () => projects.filter((project) => !project.archived),
    [projects]
  )
  const initialProject = availableProjects.find((project) => project.id === requestedProjectId)
    ?? availableProjects[0]
  const initialProvider = providers.find(
    (provider) => provider.id === settings.defaultProviderId && provider.hasToken
  )
  const { projectChoice, cwd } = resolveProjectDraft(
    availableProjects,
    stored.projectChoice,
    stored.cwd,
    initialProject
  )
  const driveMode = stored.driveMode ?? settings.driveMode
  const providerId = stored.providerId ?? initialProvider?.id ?? ''
  const model = stored.model ?? initialProviderModel(initialProvider, settings.defaultModel)
  const permissionMode = stored.permissionMode
    ?? caogenDrivePolicyView(settings.driveMode).defaultPermissionMode

  useEffect(() => {
    if (stored.projectChoice !== null || stored.cwd || !initialProject) return
    update({ projectChoice: initialProject.id, cwd: initialProject.path })
  }, [initialProject, stored.cwd, stored.projectChoice, update])

  useEffect(() => {
    if (!requestedProjectId) return
    const requested = availableProjects.find((project) => project.id === requestedProjectId)
    if (requested) update({ projectChoice: requested.id, cwd: requested.path })
  }, [availableProjects, requestedProjectId, update])

  useEffect(() => {
    const storedProjectChoice = stored.projectChoice
    if (storedProjectChoice === null || storedProjectChoice === NEW_PROJECT || storedProjectChoice === UNASSIGNED) return
    if (!availableProjects.some((project) => project.id === storedProjectChoice)) {
      update({ projectChoice: UNASSIGNED, cwd: '' })
    }
  }, [availableProjects, stored.projectChoice, update])

  useEffect(() => {
    if (providerId) return
    const preferred = providers.find(
      (provider) => provider.id === settings.defaultProviderId && provider.hasToken
    )
    if (preferred) {
      update({ providerId: preferred.id, model: initialProviderModel(preferred, settings.defaultModel) })
    }
  }, [providerId, providers, settings.defaultModel, settings.defaultProviderId, update])

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
    update({
      driveMode: nextDriveMode,
      model: providerId ? AUTO_MODEL : '',
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
