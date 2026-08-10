import { Suspense, lazy, useEffect } from 'react'
import type { ExperienceMode } from '../store/experience-mode'
import { useStore } from '../store'
import { useT } from '../i18n'
import Sidebar from './Sidebar'
import WelcomeView from './WelcomeView'
import WorkbenchRoot from './workbench/WorkbenchRoot'
import { ExperienceProjectionProvider } from './experience/ExperienceProjection'
import StudioResultPanel from './workbench/StudioResultPanel'
import { useFirstTaskOnboardingLifecycle } from './experience/first-task-onboarding'
import StudioProjectionTabs, {
  STUDIO_PROJECTION_PANEL_IDS,
  STUDIO_PROJECTION_TAB_IDS,
  type StudioProjectionSurface
} from './experience/StudioProjectionTabs'
import { loadStudioView, preloadStudioView } from './studio/loadStudioView'

const StudioView = lazy(loadStudioView)

interface AppListViewProps {
  activeId: string | null
  experienceMode: ExperienceMode
  hasActive: boolean
  language: 'zh' | 'en'
  mobileSidebarOpen: boolean
  showNewSession: boolean
  studioVisited: boolean
  onCloseMobileSidebar: () => void
  onExperienceModeChange: (mode: ExperienceMode) => void
  onToggleMobileSidebar: () => void
}

interface MobileSidebarControlsProps {
  open: boolean
  closeLabel: string
  openLabel: string
  onClose: () => void
  onToggle: () => void
}

function MobileSidebarControls({
  open,
  closeLabel,
  openLabel,
  onClose,
  onToggle
}: MobileSidebarControlsProps): React.JSX.Element {
  return (
    <>
      <button
        type="button"
        className="mobile-sidebar-toggle"
        aria-label={open ? closeLabel : openLabel}
        aria-expanded={open}
        onClick={onToggle}
      >
        <span />
        <span />
        <span />
      </button>
      {open && (
        <button type="button" className="mobile-sidebar-backdrop" aria-label={closeLabel} onClick={onClose} />
      )}
    </>
  )
}

interface SessionSurfaceProps {
  activeId: string | null
  experienceMode: ExperienceMode
  hasActive: boolean
  hidden: boolean
  showNewSession: boolean
}

function SessionSurface({
  activeId,
  experienceMode,
  hasActive,
  hidden,
  showNewSession
}: SessionSurfaceProps): React.JSX.Element {
  return (
    <section
      id={STUDIO_PROJECTION_PANEL_IDS.session}
      className="experience-surface experience-session"
      data-experience-projection={experienceMode}
      role={experienceMode === 'studio' ? 'tabpanel' : undefined}
      aria-labelledby={experienceMode === 'studio' ? STUDIO_PROJECTION_TAB_IDS.session : undefined}
      hidden={hidden}
      aria-hidden={hidden}
      {...(hidden ? { inert: '' } : {})}
    >
      {showNewSession || !hasActive ? <WelcomeView /> : <WorkbenchRoot key={activeId} />}
    </section>
  )
}

function WorkspaceSurface({ hidden }: { hidden: boolean }): React.JSX.Element {
  return (
    <section
      id={STUDIO_PROJECTION_PANEL_IDS.workspace}
      className="experience-surface experience-workspace"
      role="tabpanel"
      aria-labelledby={STUDIO_PROJECTION_TAB_IDS.workspace}
      hidden={hidden}
      aria-hidden={hidden}
      {...(hidden ? { inert: '' } : {})}
    >
      <Suspense fallback={<div className="studio-loading">加载工作台...</div>}>
        <StudioView active={!hidden} />
      </Suspense>
    </section>
  )
}

interface ResultSurfaceProps {
  activeId: string | null
  hidden: boolean
  onOpenSession: () => void
}

function ResultSurface({ activeId, hidden, onOpenSession }: ResultSurfaceProps): React.JSX.Element {
  return (
    <section
      id={STUDIO_PROJECTION_PANEL_IDS.result}
      className="experience-surface experience-result"
      role="tabpanel"
      aria-labelledby={STUDIO_PROJECTION_TAB_IDS.result}
      hidden={hidden}
      aria-hidden={hidden}
      {...(hidden ? { inert: '' } : {})}
    >
      {!hidden && <StudioResultPanel sessionId={activeId} standalone onOpenSessionSurface={onOpenSession} />}
    </section>
  )
}

function useStudioSurface(
  workspaceNonce: number,
  sessionNonce: number
): [StudioProjectionSurface, (surface: StudioProjectionSurface) => void] {
  const surface = useStore((state) => state.studioSurface)
  const setSurface = useStore((state) => state.setStudioSurface)
  useEffect(() => {
    if (workspaceNonce > 0) setSurface('workspace')
  }, [workspaceNonce])
  useEffect(() => {
    if (sessionNonce > 0) setSurface('session')
  }, [sessionNonce])
  return [surface, setSurface]
}

export default function AppListView({
  activeId,
  experienceMode,
  hasActive,
  language,
  mobileSidebarOpen,
  onCloseMobileSidebar,
  onExperienceModeChange,
  onToggleMobileSidebar,
  showNewSession,
  studioVisited
}: AppListViewProps): React.JSX.Element {
  const t = useT()
  useFirstTaskOnboardingLifecycle()
  const studioNavigationNonce = useStore((state) => state.studioNavigationNonce)
  const studioSessionNavigationNonce = useStore((state) => state.studioSessionNavigationNonce)
  const [studioSurface, setStudioSurface] = useStudioSurface(studioNavigationNonce, studioSessionNavigationNonce)
  useEffect(() => preloadStudioView(), [])
  useEffect(() => {
    if (showNewSession) setStudioSurface('session')
  }, [setStudioSurface, showNewSession])
  const sessionProjection = experienceMode === 'studio' && studioSurface === 'session' ? 'studio' : 'assistant'
  const sessionHidden = experienceMode === 'studio' && studioSurface !== 'session'
  const workspaceHidden = experienceMode !== 'studio' || studioSurface !== 'workspace'
  const resultHidden = experienceMode !== 'studio' || studioSurface !== 'result'
  return (
    <>
      <MobileSidebarControls
        open={mobileSidebarOpen}
        closeLabel={t('closeSession')}
        openLabel={t('openSidebar')}
        onClose={onCloseMobileSidebar}
        onToggle={onToggleMobileSidebar}
      />
      <Sidebar
        experienceMode={experienceMode}
        language={language}
        mobileOpen={mobileSidebarOpen}
        onExperienceModeChange={onExperienceModeChange}
        onMobileClose={onCloseMobileSidebar}
      />
      <ExperienceProjectionProvider mode={sessionProjection}>
        <main className="main">
          <StudioProjectionTabs
            hidden={experienceMode !== 'studio'}
            language={language}
            surface={studioSurface}
            onChange={setStudioSurface}
          />
          <div
            className="experience-pane"
            data-experience-mode={experienceMode}
            data-studio-surface={experienceMode === 'studio' ? studioSurface : undefined}
          >
            <SessionSurface
              activeId={activeId}
              experienceMode={experienceMode}
              hasActive={hasActive}
              hidden={sessionHidden}
              showNewSession={showNewSession}
            />
            {studioVisited && <WorkspaceSurface hidden={workspaceHidden} />}
            {studioVisited && (
              <ResultSurface
                activeId={activeId}
                hidden={resultHidden}
                onOpenSession={() => setStudioSurface('session')}
              />
            )}
          </div>
        </main>
      </ExperienceProjectionProvider>
    </>
  )
}
