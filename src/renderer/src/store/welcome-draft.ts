import type { CaoGenDriveMode, PermissionModeId } from '../../../shared/types'

export type WelcomeRoutingMode = 'fixed' | 'provider' | 'global'

export interface WelcomeDraftState {
  text: string
  projectChoice: string | null
  cwd: string | null
  driveMode: CaoGenDriveMode | null
  routingMode: WelcomeRoutingMode
  providerId: string | null
  model: string | null
  permissionMode: PermissionModeId | null
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
  return {
    welcomeDraft: emptyWelcomeDraft(),
    updateWelcomeDraft: (patch) =>
      set((state) => ({ welcomeDraft: { ...state.welcomeDraft, ...patch } })),
    clearWelcomeDraft: () => set({ welcomeDraft: emptyWelcomeDraft() })
  }
}
