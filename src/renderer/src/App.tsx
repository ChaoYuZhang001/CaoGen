import { useEffect } from 'react'
import { useStore } from './store'
import Sidebar from './components/Sidebar'
import ChatView from './components/ChatView'
import WelcomeView from './components/WelcomeView'
import NewSessionModal from './components/NewSessionModal'
import SettingsModal from './components/SettingsModal'

export default function App(): React.JSX.Element {
  const init = useStore((s) => s.init)
  const activeId = useStore((s) => s.activeId)
  const hasActive = useStore((s) => (activeId ? Boolean(s.sessions[activeId]) : false))
  const showNewSession = useStore((s) => s.showNewSession)
  const showSettings = useStore((s) => s.showSettings)

  useEffect(() => {
    if (typeof window.agentDesk === 'undefined') return
    void init()
  }, [init])

  if (typeof window.agentDesk === 'undefined') {
    return (
      <div className="app-fallback">
        <h1>AgentDesk</h1>
        <p>请通过 Electron 启动本应用(npm run dev)。</p>
      </div>
    )
  }

  return (
    <div className="app">
      <Sidebar />
      <main className="main">{hasActive ? <ChatView key={activeId} /> : <WelcomeView />}</main>
      {showNewSession && <NewSessionModal />}
      {showSettings && <SettingsModal />}
    </div>
  )
}
