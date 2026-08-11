import {
  AUTO_MODEL,
  AUTO_PROVIDER_ID,
  type CaoGenDriveMode,
  type CreateSessionOptions,
  type ProviderView,
  type TaskStrategy
} from '../../../../shared/types'
import type { ExperienceMode } from '../../store/experience-mode'
import type {
  WelcomeComputeSelectionSource,
  WelcomeRoutingMode
} from '../../store/welcome-draft'

export const NEW_PROJECT_SESSION_CHOICE = '__new_project__'

export type { WelcomeRoutingMode } from '../../store/welcome-draft'

export interface WelcomeSessionDraft {
  cwd: string
  driveMode: CaoGenDriveMode
  model: string
  taskStrategy: TaskStrategy
  experienceModeOverride: ExperienceMode
  projectId?: string
  providerId: string
  routingMode: WelcomeRoutingMode
  unassigned: boolean
  forkFromSdkSessionId?: string
  forkCheckpointId?: string
}

export interface WelcomeDefaultComputeSelection {
  model: string
  routingMode: WelcomeRoutingMode
}

export interface WelcomeStoredComputeSelection {
  computeSelectionSource: WelcomeComputeSelectionSource
  model: string | null
  providerId: string | null
  routingMode: WelcomeRoutingMode
}

export interface WelcomeResolvedComputeSelection {
  model: string
  providerId: string
  routingMode: WelcomeRoutingMode
}

export function welcomeDefaultComputeSelection(
  provider: Pick<ProviderView, 'models'> | undefined,
  defaultModel: string
): WelcomeDefaultComputeSelection {
  if (!provider) return { model: '', routingMode: 'global' }
  const model = defaultModel.trim()
  return model && model !== AUTO_MODEL && provider.models.includes(model)
    ? { model, routingMode: 'fixed' }
    : { model: AUTO_MODEL, routingMode: 'provider' }
}

export function resolveWelcomeComputeSelection(
  providers: ProviderView[],
  defaultProviderId: string,
  defaultModel: string,
  stored: WelcomeStoredComputeSelection,
  providersLoaded: boolean
): WelcomeResolvedComputeSelection {
  if (!providersLoaded) {
    return {
      providerId: stored.providerId ?? '',
      model: stored.model ?? '',
      routingMode: stored.routingMode
    }
  }

  if (stored.computeSelectionSource === 'default') {
    const provider = providers.find(
      (candidate) => candidate.id === defaultProviderId && candidate.ready && candidate.models.length > 0
    )
    const selection = welcomeDefaultComputeSelection(provider, defaultModel)
    return {
      providerId: provider?.id ?? '',
      model: selection.model,
      routingMode: selection.routingMode
    }
  }

  const provider = stored.providerId
    ? providers.find(
      (candidate) => candidate.id === stored.providerId && candidate.ready && candidate.models.length > 0
    )
    : undefined
  if (!provider) return { providerId: '', model: '', routingMode: stored.routingMode }
  return {
    providerId: provider.id,
    model: stored.routingMode === 'fixed'
      && stored.model
      && provider.models.includes(stored.model)
      ? stored.model
      : stored.routingMode === 'fixed' ? '' : AUTO_MODEL,
    routingMode: stored.routingMode
  }
}

export function hasAvailableCompute(
  providers: Array<Pick<ProviderView, 'ready' | 'models'>>
): boolean {
  return providers.some((provider) => provider.ready && provider.models.length > 0)
}

export function welcomeValidationKey(
  projection: ExperienceMode,
  draft: WelcomeSessionDraft,
  computeAvailable: boolean
): string | null {
  if (!draft.unassigned && !draft.cwd.trim()) return 'errNeedProjectDir'
  if (projection === 'assistant') return computeAvailable ? null : 'assistantComputeUnavailable'
  if (draft.routingMode === 'global' && !computeAvailable) return 'explicitProviderRequired'
  if (draft.routingMode !== 'global' && !draft.providerId) return 'explicitProviderRequired'
  if (draft.routingMode === 'fixed' && (!draft.model || draft.model === AUTO_MODEL)) {
    return 'explicitModelRequired'
  }
  return null
}

export function welcomeSessionOptions(
  projection: ExperienceMode,
  draft: WelcomeSessionDraft,
  prompt: string
): CreateSessionOptions {
  const placement = {
    cwd: draft.cwd.trim(),
    projectId: draft.projectId,
    unassigned: draft.unassigned,
    experienceModeOverride: draft.experienceModeOverride,
    initialPrompt: prompt,
    forkFromSdkSessionId: draft.forkFromSdkSessionId,
    forkCheckpointId: draft.forkCheckpointId
  }
  if (projection === 'assistant') {
    return {
      ...placement,
      driveMode: 'core',
      model: draft.routingMode === 'fixed' ? draft.model : AUTO_MODEL,
      providerId: draft.routingMode === 'global' ? AUTO_PROVIDER_ID : draft.providerId,
      routingScope: draft.routingMode,
      taskStrategy: draft.taskStrategy
    }
  }
  return {
    ...placement,
    driveMode: draft.driveMode,
    model: draft.routingMode === 'fixed' ? draft.model : AUTO_MODEL,
    providerId: draft.routingMode === 'global' ? AUTO_PROVIDER_ID : draft.providerId,
    routingScope: draft.routingMode,
    taskStrategy: draft.taskStrategy
  }
}

export function assistantSafeStartError(projection: ExperienceMode, error: unknown): string | null {
  if (projection !== 'assistant') return null
  return error instanceof Error && /路径|目录|project|workspace/i.test(error.message)
    ? 'assistantWorkspaceUnavailable'
    : 'assistantStartFailed'
}
