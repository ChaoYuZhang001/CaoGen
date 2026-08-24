import * as React from 'react'
import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { useStore } from './store'
import { useThemeEffect } from './theme'
import type { AppSettings, MenuCommand } from '../../shared/types'
import CommandPalette from './components/CommandPalette'
import TaskRecoveryModal from './components/TaskRecoveryModal'
import Quickbar from './components/Quickbar'
import AppListView from './components/AppListView'
import { APP_ICON_URL, APP_NAME } from './brand'
import { loadOfficeView } from './components/office/loadOffice'
import type { ExperienceMode } from './store/experience-mode'
import { sessionExperienceMode } from './store/session-experience'

const OfficeView = lazy(loadOfficeView)
const SettingsPage = lazy(() => import('./components/SettingsModal'))

function useStudioVisited(experienceMode: ExperienceMode): boolean {
  const [visited, setVisited] = useState(experienceMode === 'studio')
  useEffect(() => {
    if (experienceMode === 'studio') setVisited(true)
  }, [experienceMode])
  return visited
}

function useVideoVisited(experienceMode: ExperienceMode): boolean {
  const [visited, setVisited] = useState(experienceMode === 'video')
  useEffect(() => {
    if (experienceMode === 'video') setVisited(true)
  }, [experienceMode])
  return visited
}

function useVisitedExperiences(mode: ExperienceMode): [boolean, boolean] {
  return [useStudioVisited(mode), useVideoVisited(mode)]
}

function startPrimaryCreation(
  mode: ExperienceMode,
  actions: { newProject: () => void; newSession: () => void; selectMode: (mode: ExperienceMode) => void }
): void {
  if (mode === 'studio') return actions.newProject()
  if (mode === 'assistant') return actions.newSession()
  actions.selectMode('video')
  requestAnimationFrame(() => window.dispatchEvent(new Event('caogen:video-new')))
}

function sessionOrderForMode(
  mode: ExperienceMode,
  order: string[],
  sessions: ReturnType<typeof useStore.getState>['sessions']
): string[] {
  if (mode === 'video') return []
  return order.filter((id) => {
    const meta = sessions[id]?.meta
    if (!meta) return false
    return mode === sessionExperienceMode(meta)
  })
}

function officeBootProps(
  order: string[],
  sessions: ReturnType<typeof useStore.getState>['sessions'],
  activeId: string | null,
  settings: AppSettings,
  selectSession: ReturnType<typeof useStore.getState>['selectSession']
): React.ComponentProps<typeof OfficeView>['boot'] {
  const systemLight = settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches
  return {
    sessionIds: order.filter((id) => Boolean(sessions[id])),
    activeId,
    quality: settings.office?.qualityMode ?? 'auto',
    lightMode: settings.theme === 'light' || systemLight,
    language: settings.language,
    selectSession
  }
}

export default function App(): React.JSX.Element {
  const init = useStore((s) => s.init)
  const activeId = useStore((s) => s.activeId)
  const hasActive = useStore((s) => (activeId ? Boolean(s.sessions[activeId]) : false))
  const order = useStore((s) => s.order)
  const sessions = useStore((s) => s.sessions)
  const view = useStore((s) => s.view)
  const experienceMode = useStore((s) => s.experienceMode)
  const settings = useStore((s) => s.settings)
  const showNewSession = useStore((s) => s.showNewSession)
  const showSettings = useStore((s) => s.showSettings)
  const showCommandPalette = useStore((s) => s.showCommandPalette)
  const setShowNewSession = useStore((s) => s.setShowNewSession)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const setShowCommandPalette = useStore((s) => s.setShowCommandPalette)
  const selectSession = useStore((s) => s.selectSession)
  const setView = useStore((s) => s.setView)
  const setExperienceMode = useStore((s) => s.setExperienceMode)
  const openNewProjectWorkspace = useStore((s) => s.openNewProjectWorkspace)
  const [studioVisited, videoVisited] = useVisitedExperiences(experienceMode)
  useThemeEffect()
  const focusSidebarSearch = useCallback((): void => {
    setView('list')
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>('.sidebar-search')
      if (!input) return
      input.focus()
      input.select()
    })
  }, [setView])

  const handleMenuCommand = useCallback(
    (command: MenuCommand): void => {
      if (command.type === 'new-session') {
        setShowSettings(false)
        startPrimaryCreation(experienceMode, {
          newProject: openNewProjectWorkspace,
          newSession: () => setShowNewSession(true),
          selectMode: setExperienceMode
        })
        return
      }
      if (command.type === 'settings') {
        setShowNewSession(false)
        setShowCommandPalette(false)
        setShowSettings(true)
        return
      }
      if (command.type === 'command-palette') {
        setShowCommandPalette(true)
        return
      }
      if (command.type === 'open-search') {
        setShowSettings(false)
        focusSidebarSearch()
        return
      }
      const id = sessionOrderForMode(experienceMode, order, sessions)[command.index]
      if (id) {
        setShowSettings(false)
        selectSession(id)
      }
    },
    [experienceMode, focusSidebarSearch, openNewProjectWorkspace, order, selectSession, sessions, setExperienceMode, setShowCommandPalette, setShowNewSession, setShowSettings]
  )

  useEffect(() => {
    if (typeof window.agentDesk === 'undefined') return
    void init()
  }, [init])

  useEffect(() => {
    if (typeof window.agentDesk === 'undefined') return
    return window.agentDesk.onMenuCommand(handleMenuCommand)
  }, [handleMenuCommand])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod || e.altKey || e.isComposing) return
      const key = e.key.toLowerCase()
      if (key === 'n') {
        e.preventDefault()
        handleMenuCommand({ type: 'new-session' })
        return
      }
      if (key === ',') {
        e.preventDefault()
        handleMenuCommand({ type: 'settings' })
        return
      }
      if (key === 'k') {
        e.preventDefault()
        handleMenuCommand({ type: 'command-palette' })
        return
      }
      if (key === 'f') {
        e.preventDefault()
        handleMenuCommand({ type: 'open-search' })
        return
      }
      if (/^[1-9]$/.test(key)) {
        e.preventDefault()
        handleMenuCommand({ type: 'select-session', index: Number(key) - 1 })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleMenuCommand])

  if (typeof window.agentDesk === 'undefined') {
    return (
      <div className="app-fallback">
        <img className="app-fallback-logo" src={APP_ICON_URL} alt="" />
        <h1>{APP_NAME}</h1>
        <p>请通过 Electron 启动本应用(npm run dev)。</p>
      </div>
    )
  }

  return (
    <div className="app">
      {showSettings ? (
        <Suspense fallback={<div className="office-loading">加载设置…</div>}>
          <SettingsPage />
        </Suspense>
      ) : view === 'office' ? (
        <Suspense fallback={<div className="office-loading">加载办公区…</div>}>
          <OfficeView boot={officeBootProps(order, sessions, activeId, settings, selectSession)} />
        </Suspense>
      ) : (
        <AppListView
          activeId={activeId}
          experienceMode={experienceMode}
          hasActive={hasActive}
          language={settings.language}
          showNewSession={showNewSession}
          studioVisited={studioVisited}
          videoVisited={videoVisited}
          onExperienceModeChange={setExperienceMode}
        />
      )}
      {showCommandPalette && <CommandPalette />}
      {!showSettings && <TaskRecoveryModal />}
      {!showSettings && <Quickbar />}
    </div>
  )
}
