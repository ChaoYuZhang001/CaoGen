import { useStore } from '../store'
import { basename, formatCost, formatTime } from '../format'
import type { SessionStatus } from '../../../shared/types'

const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: '启动中',
  running: '运行中',
  idle: '空闲',
  error: '错误',
  closed: '已关闭'
}

export default function Sidebar(): React.JSX.Element {
  const order = useStore((s) => s.order)
  const sessions = useStore((s) => s.sessions)
  const activeId = useStore((s) => s.activeId)
  const history = useStore((s) => s.history)
  const selectSession = useStore((s) => s.selectSession)
  const resumeFromHistory = useStore((s) => s.resumeFromHistory)
  const setShowNewSession = useStore((s) => s.setShowNewSession)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const setView = useStore((s) => s.setView)

  const openSdkIds = new Set(order.map((id) => sessions[id]?.meta.sdkSessionId).filter(Boolean))
  const recent = history.filter((h) => !openSdkIds.has(h.sdkSessionId)).slice(0, 20)

  return (
    <aside className="sidebar">
      <div className="sidebar-brand drag-region">
        <span className="brand-mark">◆</span>
        <span className="brand-name">AgentDesk</span>
      </div>

      <button className="btn btn-primary sidebar-new" onClick={() => setShowNewSession(true)}>
        + 新建会话
      </button>

      <button className="btn btn-ghost sidebar-office" onClick={() => setView('office')}>
        🏢 3D 办公区
      </button>

      <div className="sidebar-scroll">
        <div className="sidebar-section-title">进行中</div>
        {order.length === 0 && <div className="sidebar-empty">暂无会话</div>}
        {order.map((id) => {
          const s = sessions[id]
          if (!s) return null
          const { meta } = s
          return (
            <button
              key={id}
              className={`session-card ${activeId === id ? 'active' : ''}`}
              onClick={() => selectSession(id)}
            >
              <span className={`status-dot status-${meta.status}`} title={STATUS_LABEL[meta.status]} />
              <span className="session-card-body">
                <span className="session-card-title">{meta.title}</span>
                <span className="session-card-sub">
                  {basename(meta.cwd)} · {formatCost(meta.costUsd)}
                </span>
              </span>
              {s.pendingPermissions.length > 0 && (
                <span className="session-card-badge" title="等待授权">
                  {s.pendingPermissions.length}
                </span>
              )}
            </button>
          )
        })}

        {recent.length > 0 && (
          <>
            <div className="sidebar-section-title">最近会话</div>
            {recent.map((h) => (
              <button
                key={h.id}
                className="session-card history-card"
                title={`恢复会话:${h.cwd}`}
                onClick={() => void resumeFromHistory(h)}
              >
                <span className="history-icon">↻</span>
                <span className="session-card-body">
                  <span className="session-card-title">{h.title}</span>
                  <span className="session-card-sub">
                    {basename(h.cwd)} · {formatTime(h.updatedAt)}
                  </span>
                </span>
              </button>
            ))}
          </>
        )}
      </div>

      <div className="sidebar-footer">
        <button className="btn btn-ghost" onClick={() => setShowSettings(true)}>
          ⚙ 设置
        </button>
      </div>
    </aside>
  )
}
