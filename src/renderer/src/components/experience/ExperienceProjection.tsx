import { createContext, useContext, type ReactNode } from 'react'
import type { ExperienceMode } from '../../store/experience-mode'

const ExperienceProjectionContext = createContext<ExperienceMode>('assistant')

export function ExperienceProjectionProvider({
  children,
  mode
}: {
  children: ReactNode
  mode: ExperienceMode
}): React.JSX.Element {
  return (
    <ExperienceProjectionContext.Provider value={mode}>
      {children}
    </ExperienceProjectionContext.Provider>
  )
}

export function useExperienceProjection(): ExperienceMode {
  return useContext(ExperienceProjectionContext)
}
