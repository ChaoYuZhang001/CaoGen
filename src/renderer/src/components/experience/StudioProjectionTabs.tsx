import type { KeyboardEvent } from 'react'

export type StudioProjectionSurface = 'workspace' | 'result' | 'session'

const SURFACES: StudioProjectionSurface[] = ['workspace', 'result', 'session']
export const STUDIO_PROJECTION_TAB_IDS: Record<StudioProjectionSurface, string> = {
  workspace: 'studio-projection-tab-workspace',
  result: 'studio-projection-tab-result',
  session: 'studio-projection-tab-session'
}
export const STUDIO_PROJECTION_PANEL_IDS: Record<StudioProjectionSurface, string> = {
  workspace: 'studio-projection-panel-workspace',
  result: 'studio-projection-panel-result',
  session: 'studio-projection-panel-session'
}

export default function StudioProjectionTabs({
  hasResult,
  language,
  hidden,
  onChange,
  surface
}: {
  hasResult: boolean
  hidden: boolean
  language: 'zh' | 'en'
  onChange: (surface: StudioProjectionSurface) => void
  surface: StudioProjectionSurface
}): React.JSX.Element {
  const labels = language === 'zh'
    ? { navigation: '工作台区域', workspace: '项目工作台', result: '结果', session: '会话与工具' }
    : { navigation: 'Studio area', workspace: 'Project workspace', result: 'Results', session: 'Session and tools' }
  const surfaces = hasResult ? SURFACES : SURFACES.filter((surface) => surface !== 'result')
  return (
    <nav className="studio-projection-tabs" role="tablist" aria-label={labels.navigation} data-studio-projection-tabs hidden={hidden}>
      {surfaces.map((option) => (
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
          onKeyDown={(event) => handleTabKeyDown(event, option, surfaces, onChange)}
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
  surfaces: readonly StudioProjectionSurface[],
  onChange: (surface: StudioProjectionSurface) => void
): void {
  const next = nextSurface(current, event.key, surfaces)
  if (!next) return
  event.preventDefault()
  onChange(next)
  requestAnimationFrame(() => document.getElementById(STUDIO_PROJECTION_TAB_IDS[next])?.focus())
}

function nextSurface(
  current: StudioProjectionSurface,
  key: string,
  surfaces: readonly StudioProjectionSurface[]
): StudioProjectionSurface | null {
  if (key === 'Home') return surfaces[0] ?? null
  if (key === 'End') return surfaces[surfaces.length - 1] ?? null
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null
  const offset = key === 'ArrowRight' ? 1 : -1
  const index = (surfaces.indexOf(current) + offset + surfaces.length) % surfaces.length
  return surfaces[index] ?? null
}
