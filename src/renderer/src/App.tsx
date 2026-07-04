import { Suspense, lazy, useEffect } from 'react'
import { useStore } from './store'
import { useThemeEffect } from './theme'
import Sidebar from './components/Sidebar'
import WorkbenchRoot from './components/workbench/WorkbenchRoot'
import WelcomeView from './components/WelcomeView'
import NewSessionModal from './components/NewSessionModal'
import SettingsModal from './components/SettingsModal'

// 3D 办公区体积较大且依赖 WebGL,懒加载,不拖累列表视图首屏
const OfficeView = lazy(() => import('./components/office/OfficeView'))

export default function App(): React.JSX.Element {
  const init = useStore((s) => s.init)
  const activeId = useStore((s) => s.activeId)
  const hasActive = useStore((s) => (activeId ? Boolean(s.sessions[activeId]) : false))
  const view = useStore((s) => s.view)
  const showNewSession = useStore((s) => s.showNewSession)
  const showSettings = useStore((s) => s.showSettings)

  useThemeEffect()

  useEffect(() => {
    if (typeof window.agentDesk === 'undefined') return
    void init()
  }, [init])

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
          <Sidebar />
          <main className="main">{hasActive ? <WorkbenchRoot key={activeId} /> : <WelcomeView />}</main>
        </>
      )}
      {showNewSession && <NewSessionModal />}
      {showSettings && <SettingsModal />}
    </div>
  )
}
