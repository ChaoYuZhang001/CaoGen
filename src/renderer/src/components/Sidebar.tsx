import { useState } from 'react'
import { useStore } from '../store'
import { useT } from '../i18n'
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
  const t = useT()
  const order = useStore((s) => s.order)
  const sessions = useStore((s) => s.sessions)
  const activeId = useStore((s) => s.activeId)
  const history = useStore((s) => s.history)
  const projects = useStore((s) => s.projects)
  const selectSession = useStore((s) => s.selectSession)
  const resumeFromHistory = useStore((s) => s.resumeFromHistory)
  const renameSession = useStore((s) => s.renameSession)
  const closeSession = useStore((s) => s.closeSession)
  const deleteProject = useStore((s) => s.deleteProject)
  const setShowNewSession = useStore((s) => s.setShowNewSession)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const setView = useStore((s) => s.setView)
  const createSession = useStore((s) => s.createSession)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')

  const openSdkIds = new Set(order.map((id) => sessions[id]?.meta.sdkSessionId).filter(Boolean))
  const recent = history.filter((h) => !openSdkIds.has(h.sdkSessionId)).slice(0, 20)

  const startRename = (id: string, title: string): void => {
    setEditingId(id)
    setDraftTitle(title)
  }
  const commitRename = (): void => {
    if (editingId) void renameSession(editingId, draftTitle)
    setEditingId(null)
  }

  // 用某项目目录一键新建会话(沿用默认 Provider/模型/权限)
  const newInProject = (path: string): void => {
    void createSession({ cwd: path })
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-brand drag-region">
        <span className="brand-mark">◆</span>
        <span className="brand-name">CaoGen</span>
      </div>

      <button className="btn btn-primary sidebar-new" onClick={() => setShowNewSession(true)}>
        {t('newSession')}
      </button>

      <button className="btn btn-ghost sidebar-office" onClick={() => setView('office')}>
        {t('office3d')}
      </button>

      <div className="sidebar-scroll">
        {projects.length > 0 && (
          <>
            <div className="sidebar-section-title">{t('projects')}</div>
            {projects.slice(0, 6).map((p) => (
              <div key={p.id} className="project-row" title={p.path}>
                <button className="project-row-main" onClick={() => newInProject(p.path)}>
                  <span className="project-icon">📁</span>
                  <span className="project-name">{p.name}</span>
                </button>
                <button
                  className="session-action"
                  title={t('newSessionHere')}
                  onClick={() => newInProject(p.path)}
                >
                  ＋
                </button>
                <button
                  className="session-action"
                  title={t('delete')}
                  onClick={() => void deleteProject(p.id)}
                >
                  ✕
                </button>
              </div>
            ))}
          </>
        )}

        <div className="sidebar-section-title">{t('ongoing')}</div>
        {order.length === 0 && <div className="sidebar-empty">{t('noSessions')}</div>}
        {order.map((id) => {
          const s = sessions[id]
          if (!s) return null
          const { meta } = s
          if (editingId === id) {
            return (
              <div key={id} className="session-card session-card-editing">
                <input
                  className="input session-rename-input"
                  value={draftTitle}
                  autoFocus
                  onChange={(e) => setDraftTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  onBlur={commitRename}
                />
              </div>
            )
          }
          return (
            <div
              key={id}
              className={`session-card ${activeId === id ? 'active' : ''}`}
              role="button"
              tabIndex={0}
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
              <span className="session-card-actions">
                <button
                  className="session-action"
                  title={t('rename')}
                  onClick={(e) => {
                    e.stopPropagation()
                    startRename(id, meta.title)
                  }}
                >
                  ✎
                </button>
                <button
                  className="session-action"
                  title={t('delete')}
                  onClick={(e) => {
                    e.stopPropagation()
                    void closeSession(id)
                  }}
                >
                  ✕
                </button>
              </span>
            </div>
          )
        })}

        {recent.length > 0 && (
          <>
            <div className="sidebar-section-title">{t('recent')}</div>
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
          {t('settings')}
        </button>
      </div>
    </aside>
  )
}
