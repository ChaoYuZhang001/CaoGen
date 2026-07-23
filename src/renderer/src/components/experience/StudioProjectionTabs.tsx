import type { KeyboardEvent } from 'react'

export type StudioProjectionSurface = 'workspace' | 'session'

const SURFACES: StudioProjectionSurface[] = ['workspace', 'session']
export const STUDIO_PROJECTION_TAB_IDS: Record<StudioProjectionSurface, string> = {
  workspace: 'studio-projection-tab-workspace',
  session: 'studio-projection-tab-session'
}
export const STUDIO_PROJECTION_PANEL_IDS: Record<StudioProjectionSurface, string> = {
  workspace: 'studio-projection-panel-workspace',
  session: 'studio-projection-panel-session'
}

export default function StudioProjectionTabs({
  language,
  hidden,
  onChange,
  surface
}: {
  hidden: boolean
  language: 'zh' | 'en'
  onChange: (surface: StudioProjectionSurface) => void
  surface: StudioProjectionSurface
}): React.JSX.Element {
  const labels = language === 'zh'
    ? { navigation: '工作台区域', workspace: '项目工作台', session: '会话与工具' }
    : { navigation: 'Studio area', workspace: 'Project workspace', session: 'Session and tools' }
  return (
    <nav className="studio-projection-tabs" role="tablist" aria-label={labels.navigation} data-studio-projection-tabs hidden={hidden}>
      {SURFACES.map((option) => (
        <button
          key={option}
          id={STUDIO_PROJECTION_TAB_IDS[option]}
          type="button"
          role="tab"
          aria-selected={surface === option}
          aria-controls={STUDIO_PROJECTION_PANEL_IDS[option]}
          tabIndex={surface === option ? 0 : -1}
          className={surface === option ? 'active' : ''}
          data-studio-projection-tab={option}
          onClick={() => onChange(option)}
          onKeyDown={(event) => handleTabKeyDown(event, option, onChange)}
        >
          {labels[option]}
        </button>
      ))}
    </nav>
  )
}

function handleTabKeyDown(
  event: KeyboardEvent<HTMLButtonElement>,
  current: StudioProjectionSurface,
  onChange: (surface: StudioProjectionSurface) => void
): void {
  const next = nextSurface(current, event.key)
  if (!next) return
  event.preventDefault()
  onChange(next)
  requestAnimationFrame(() => document.getElementById(STUDIO_PROJECTION_TAB_IDS[next])?.focus())
}

function nextSurface(current: StudioProjectionSurface, key: string): StudioProjectionSurface | null {
  if (key === 'Home') return SURFACES[0]
  if (key === 'End') return SURFACES[SURFACES.length - 1]
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null
  const offset = key === 'ArrowRight' ? 1 : -1
  const index = (SURFACES.indexOf(current) + offset + SURFACES.length) % SURFACES.length
  return SURFACES[index]
}
