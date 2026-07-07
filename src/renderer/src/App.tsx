import * as React from 'react'
import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { useStore } from './store'
import { useThemeEffect } from './theme'
import { useT } from './i18n'
import type { MenuCommand } from '../../shared/types'
import Sidebar from './components/Sidebar'
import WorkbenchRoot from './components/workbench/WorkbenchRoot'
import WelcomeView from './components/WelcomeView'
import NewSessionModal from './components/NewSessionModal'
import SettingsModal from './components/SettingsModal'
import CommandPalette from './components/CommandPalette'
import TaskRecoveryModal from './components/TaskRecoveryModal'
import Quickbar from './components/Quickbar'

// 3D 办公区体积较大且依赖 WebGL,懒加载,不拖累列表视图首屏
const OfficeView = lazy(() => import('./components/office/OfficeView'))

export default function App(): React.JSX.Element {
  const t = useT()
  const init = useStore((s) => s.init)
  const activeId = useStore((s) => s.activeId)
  const hasActive = useStore((s) => (activeId ? Boolean(s.sessions[activeId]) : false))
  const order = useStore((s) => s.order)
  const view = useStore((s) => s.view)
  const showNewSession = useStore((s) => s.showNewSession)
  const showSettings = useStore((s) => s.showSettings)
  const showCommandPalette = useStore((s) => s.showCommandPalette)
  const setShowNewSession = useStore((s) => s.setShowNewSession)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const setShowCommandPalette = useStore((s) => s.setShowCommandPalette)
  const selectSession = useStore((s) => s.selectSession)
  const setView = useStore((s) => s.setView)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)

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
        setShowNewSession(true)
        return
      }
      if (command.type === 'settings') {
        setShowSettings(true)
        return
      }
      if (command.type === 'command-palette') {
        setShowCommandPalette(true)
        return
      }
      if (command.type === 'open-search') {
        focusSidebarSearch()
        return
      }
      const id = order[command.index]
      if (id) selectSession(id)
    },
    [focusSidebarSearch, order, selectSession, setShowCommandPalette, setShowNewSession, setShowSettings]
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
    setMobileSidebarOpen(false)
  }, [activeId, view])

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
        <h1>CaoGen</h1>
        <p>请通过 Electron 启动本应用(npm run dev)。</p>
      </div>
    )
  }

  return (
    <div className="app">
      {view === 'office' ? (
        <Suspense fallback={<div className="office-loading">加载办公区…</div>}>
          <OfficeView />
        </Suspense>
      ) : (
        <>
          <button
            type="button"
            className="mobile-sidebar-toggle"
            aria-label={mobileSidebarOpen ? t('closeSession') : t('openSidebar')}
            aria-expanded={mobileSidebarOpen}
            onClick={() => setMobileSidebarOpen((open) => !open)}
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
              onClick={() => setMobileSidebarOpen(false)}
            />
          )}
          <Sidebar mobileOpen={mobileSidebarOpen} onMobileClose={() => setMobileSidebarOpen(false)} />
          <main className="main">{hasActive ? <WorkbenchRoot key={activeId} /> : <WelcomeView />}</main>
        </>
      )}
      {showCommandPalette && <CommandPalette />}
      <TaskRecoveryModal />
      <Quickbar />
      {showNewSession && <NewSessionModal />}
      {showSettings && <SettingsModal />}
    </div>
  )
}
