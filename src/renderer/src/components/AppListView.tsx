import { Suspense, lazy, useState } from 'react'
import type { ExperienceMode } from '../store/experience-mode'
import { useT } from '../i18n'
import AppModeSwitcher from './AppModeSwitcher'
import Sidebar from './Sidebar'
import WelcomeView from './WelcomeView'
import WorkbenchRoot from './workbench/WorkbenchRoot'
import { ExperienceProjectionProvider } from './experience/ExperienceProjection'
import StudioProjectionTabs, {
  STUDIO_PROJECTION_PANEL_IDS,
  STUDIO_PROJECTION_TAB_IDS,
  type StudioProjectionSurface
} from './experience/StudioProjectionTabs'

const StudioView = lazy(() => import('./studio/StudioView'))

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
  const [studioSurface, setStudioSurface] = useState<StudioProjectionSurface>('workspace')
  const sessionHidden = experienceMode === 'studio' && studioSurface === 'workspace'
  const workspaceHidden = experienceMode !== 'studio' || studioSurface !== 'workspace'
  return (
    <>
      <button
        type="button"
        className="mobile-sidebar-toggle"
        aria-label={mobileSidebarOpen ? t('closeSession') : t('openSidebar')}
        aria-expanded={mobileSidebarOpen}
        onClick={onToggleMobileSidebar}
      >
        <span />
        <span />
        <span />
      </button>
      {mobileSidebarOpen && (
        <button
          type="button"
          className="mobile-sidebar-backdrop"
          aria-label={t('closeSession')}
          onClick={onCloseMobileSidebar}
        />
      )}
      <Sidebar mobileOpen={mobileSidebarOpen} onMobileClose={onCloseMobileSidebar} />
      <ExperienceProjectionProvider mode={experienceMode}>
        <main className="main">
          <AppModeSwitcher language={language} mode={experienceMode} onChange={onExperienceModeChange} />
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
            <section
              id={STUDIO_PROJECTION_PANEL_IDS.session}
              className="experience-surface experience-session"
              role={experienceMode === 'studio' ? 'tabpanel' : undefined}
              aria-labelledby={experienceMode === 'studio' ? STUDIO_PROJECTION_TAB_IDS.session : undefined}
              hidden={sessionHidden}
              aria-hidden={sessionHidden}
            >
              {showNewSession || !hasActive ? <WelcomeView /> : <WorkbenchRoot key={activeId} />}
            </section>
            {studioVisited && (
              <section
                id={STUDIO_PROJECTION_PANEL_IDS.workspace}
                className="experience-surface experience-workspace"
                role="tabpanel"
                aria-labelledby={STUDIO_PROJECTION_TAB_IDS.workspace}
                hidden={workspaceHidden}
                aria-hidden={workspaceHidden}
              >
                <Suspense fallback={<div className="studio-loading">加载工作台...</div>}>
                  <StudioView />
                </Suspense>
              </section>
            )}
          </div>
        </main>
      </ExperienceProjectionProvider>
    </>
  )
}
