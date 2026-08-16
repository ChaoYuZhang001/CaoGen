import { createContext, useContext, type ReactNode } from 'react'
import type { SessionExperienceMode } from '../../store/experience-mode'

const ExperienceProjectionContext = createContext<SessionExperienceMode>('assistant')

export function ExperienceProjectionProvider({
  children,
  mode
}: {
  children: ReactNode
  mode: SessionExperienceMode
}): React.JSX.Element {
  return (
    <ExperienceProjectionContext.Provider value={mode}>
      {children}
    </ExperienceProjectionContext.Provider>
  )
}

export function useExperienceProjection(): SessionExperienceMode {
  return useContext(ExperienceProjectionContext)
}
