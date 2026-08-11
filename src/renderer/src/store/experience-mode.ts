export type ExperienceMode = 'assistant' | 'studio'
export type StudioSurface = 'workspace' | 'result' | 'session'

export interface ExperienceModeSlice {
  experienceMode: ExperienceMode
  studioSurface: StudioSurface
  setExperienceMode(mode: ExperienceMode): void
  setStudioSurface(surface: StudioSurface): void
}

type ExperienceModeState = Pick<ExperienceModeSlice, 'experienceMode' | 'studioSurface'>

export function createExperienceModeSlice(
  set: (update: Partial<ExperienceModeState>) => void,
  persist?: (mode: ExperienceMode) => void | Promise<void>
): ExperienceModeSlice {
  return {
    experienceMode: 'assistant',
    studioSurface: 'workspace',
    setExperienceMode: (experienceMode) => {
      set({ experienceMode })
      void persist?.(experienceMode)
    },
    setStudioSurface: (studioSurface) => set({ studioSurface })
  }
}
