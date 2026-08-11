import type { CaoGenDriveMode, PermissionModeId, TaskStrategy } from '../../../shared/types'
import type { ExperienceMode } from './experience-mode'
import { loadWelcomeDraft, persistWelcomeDraft } from './welcome-draft-persistence'

export type WelcomeRoutingMode = 'fixed' | 'provider' | 'global'
export type WelcomeComputeSelectionSource = 'default' | 'user'

export interface WelcomeDraftState {
  text: string
  projectChoice: string | null
  cwd: string | null
  driveMode: CaoGenDriveMode | null
  computeSelectionSource: WelcomeComputeSelectionSource
  routingMode: WelcomeRoutingMode
  providerId: string | null
  model: string | null
  permissionMode: PermissionModeId | null
  taskStrategy?: TaskStrategy
  experienceModeOverride?: ExperienceMode
  forkFromSdkSessionId?: string
  forkCheckpointId?: string
  forkSourceTitle?: string
}

export interface WelcomeDraftSlice {
  welcomeDraft: WelcomeDraftState
  updateWelcomeDraft(patch: Partial<WelcomeDraftState>): void
  clearWelcomeDraft(): void
}

export function emptyWelcomeDraft(): WelcomeDraftState {
  return {
    text: '',
    projectChoice: null,
    cwd: null,
    driveMode: null,
    computeSelectionSource: 'default',
    routingMode: 'global',
    providerId: null,
    model: null,
    permissionMode: null
  }
}

type WelcomeDraftStoreState = Pick<WelcomeDraftSlice, 'welcomeDraft'>

export function createWelcomeDraftSlice(
  set: (
    update: WelcomeDraftStoreState | ((state: WelcomeDraftStoreState) => WelcomeDraftStoreState)
  ) => void
): WelcomeDraftSlice {
  const initialDraft = loadWelcomeDraft(emptyWelcomeDraft())
  return {
    welcomeDraft: initialDraft,
    updateWelcomeDraft: (patch) =>
      set((state) => {
        const welcomeDraft = { ...state.welcomeDraft, ...patch }
        persistWelcomeDraft(welcomeDraft)
        return { welcomeDraft }
      }),
    clearWelcomeDraft: () => {
      const welcomeDraft = emptyWelcomeDraft()
      persistWelcomeDraft(welcomeDraft)
      set({ welcomeDraft })
    }
  }
}
