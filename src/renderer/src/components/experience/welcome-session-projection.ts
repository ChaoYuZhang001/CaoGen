import {
  AUTO_MODEL,
  AUTO_PROVIDER_ID,
  caogenDrivePolicyView,
  type CaoGenDriveMode,
  type CreateSessionOptions,
  type PermissionModeId,
  type ProviderView
} from '../../../../shared/types'
import type { ExperienceMode } from '../../store/experience-mode'

export type WelcomeRoutingMode = 'fixed' | 'provider' | 'global'

export interface WelcomeSessionDraft {
  cwd: string
  driveMode: CaoGenDriveMode
  model: string
  permissionMode: PermissionModeId
  projectId?: string
  providerId: string
  routingMode: WelcomeRoutingMode
  unassigned: boolean
}

export function hasAvailableCompute(
  providers: Array<Pick<ProviderView, 'hasToken' | 'models'>>
): boolean {
  return providers.some((provider) => provider.hasToken && provider.models.length > 0)
}

export function welcomeValidationKey(
  projection: ExperienceMode,
  draft: WelcomeSessionDraft,
  computeAvailable: boolean
): string | null {
  if (!draft.cwd.trim()) return 'errNeedProjectDir'
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
    initialPrompt: prompt
  }
  if (projection === 'assistant') {
    return {
      ...placement,
      driveMode: 'core',
      model: AUTO_MODEL,
      providerId: AUTO_PROVIDER_ID,
      routingScope: 'global',
      permissionMode: caogenDrivePolicyView('core').defaultPermissionMode
    }
  }
  return {
    ...placement,
    driveMode: draft.driveMode,
    model: draft.routingMode === 'fixed' ? draft.model : AUTO_MODEL,
    providerId: draft.routingMode === 'global' ? AUTO_PROVIDER_ID : draft.providerId,
    routingScope: draft.routingMode,
    permissionMode: draft.permissionMode
  }
}

export function assistantSafeStartError(projection: ExperienceMode, error: unknown): string | null {
  if (projection !== 'assistant') return null
  return error instanceof Error && /路径|目录|project|workspace/i.test(error.message)
    ? 'assistantWorkspaceUnavailable'
    : 'assistantStartFailed'
}
