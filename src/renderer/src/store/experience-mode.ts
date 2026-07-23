export type ExperienceMode = 'assistant' | 'studio'

export interface ExperienceModeSlice {
  experienceMode: ExperienceMode
  setExperienceMode(mode: ExperienceMode): void
}

type ExperienceModeState = Pick<ExperienceModeSlice, 'experienceMode'>

export function createExperienceModeSlice(
  set: (update: ExperienceModeState) => void
): ExperienceModeSlice {
  return {
    experienceMode: 'assistant',
    setExperienceMode: (experienceMode) => set({ experienceMode })
  }
}
