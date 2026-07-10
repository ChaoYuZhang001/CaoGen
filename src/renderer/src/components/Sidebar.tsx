import { useEffect, useMemo, useState } from 'react'
import type * as React from 'react'
import { useStore } from '../store'
import { useT } from '../i18n'
import { basename, formatCost, formatTime } from '../format'
import { APP_ICON_URL, APP_NAME } from '../brand'
import type {
  HistoryEntry,
  LayoutSettings,
  SessionMeta,
  SessionStatus,
  TaskSnapshotRecord,
  TranscriptSearchResult
} from '../../../shared/types'
import SessionContextMenu, { type SessionMenuItem } from './SessionContextMenu'

const STATUS_LABEL_KEY: Record<SessionStatus, string> = {
  starting: 'statusStarting',
  running: 'statusRunning',
  idle: 'statusIdle',
  error: 'statusError',
  closed: 'statusClosed'
}

const SIDEBAR_MIN_WIDTH = 220
const SIDEBAR_MAX_WIDTH = 420
const SIDEBAR_COLLAPSED_WIDTH = 56

type SidebarEntry =
  | { kind: 'active'; id: string; meta: SessionMeta; history?: HistoryEntry; pendingCount: number }
  | { kind: 'history'; id: string; history: HistoryEntry }

type ActiveSidebarEntry = Extract<SidebarEntry, { kind: 'active' }>

interface ProjectGroup {
  key: string
  label: string
  path: string
  entries: HistoryEntry[]
  updatedAt: number
}

interface EditingTarget {
  kind: SidebarEntry['kind']
  id: string
}

interface MenuState {
  x: number
  y: number
  entry: SidebarEntry
}

function entryTitle(entry: SidebarEntry): string {
  return entry.kind === 'active' ? entry.meta.title : entry.history.title
}

function entryPath(entry: SidebarEntry): string {
  if (entry.kind === 'active') return entry.meta.sourceCwd ?? entry.meta.cwd
  return entry.history.sourceCwd ?? entry.history.cwd
}

function historyPath(entry: HistoryEntry): string {
  return entry.sourceCwd ?? entry.cwd
}

function normalized(value: string | undefined): string {
  return (value ?? '').toLowerCase()
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

function activateByKeyboard(e: React.KeyboardEvent, action: () => void): void {
  if (e.key !== 'Enter' && e.key !== ' ') return
  e.preventDefault()
  action()
}

/** 片段内高亮命中词(大小写不敏感,只标注首个命中) */
function highlightSnippet(snippet: string, query: string): React.ReactNode {
  const idx = snippet.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return snippet
  return (
    <>
      {snippet.slice(0, idx)}
      <mark className="search-hit-mark">{snippet.slice(idx, idx + query.length)}</mark>
      {snippet.slice(idx + query.length)}
    </>
  )
}

interface SidebarProps {
  mobileOpen?: boolean
  onMobileClose?: () => void
}

export default function Sidebar({ mobileOpen = false, onMobileClose }: SidebarProps): React.JSX.Element {
  const t = useT()
  const order = useStore((s) => s.order)
  const sessions = useStore((s) => s.sessions)
  const activeId = useStore((s) => s.activeId)
  const history = useStore((s) => s.history)
  const projects = useStore((s) => s.projects)
  const taskSnapshots = useStore((s) => s.taskSnapshots)
  const taskSnapshotsLoading = useStore((s) => s.taskSnapshotsLoading)
  const taskSnapshotsError = useStore((s) => s.taskSnapshotsError)
  const query = useStore((s) => s.sidebarQuery)
  const setSidebarQuery = useStore((s) => s.setSidebarQuery)
  const transcriptSearchResults = useStore((s) => s.transcriptSearchResults)
  const transcriptSearchLoading = useStore((s) => s.transcriptSearchLoading)
  const openTranscriptSearchHit = useStore((s) => s.openTranscriptSearchHit)
  const selectSession = useStore((s) => s.selectSession)
  const resumeFromHistory = useStore((s) => s.resumeFromHistory)
  const renameSession = useStore((s) => s.renameSession)
  const renameHistoryEntry = useStore((s) => s.renameHistoryEntry)
  const archiveHistory = useStore((s) => s.archiveHistory)
  const pinHistory = useStore((s) => s.pinHistory)
  const deleteHistoryEntry = useStore((s) => s.deleteHistoryEntry)
  const recoverTaskSnapshot = useStore((s) => s.recoverTaskSnapshot)
  const deleteTaskSnapshot = useStore((s) => s.deleteTaskSnapshot)
  const setShowTaskRecovery = useStore((s) => s.setShowTaskRecovery)
  const closeSession = useStore((s) => s.closeSession)
  const setShowNewSession = useStore((s) => s.setShowNewSession)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const setView = useStore((s) => s.setView)
  const layout = useStore((s) => s.settings.layout)
  const updateSettings = useStore((s) => s.updateSettings)

  const [editing, setEditing] = useState<EditingTarget | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({})
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(layout.sidebarWidth)

  useEffect(() => {
    setSidebarWidth(layout.sidebarWidth)
  }, [layout.sidebarWidth])

  const patchLayout = (patch: Partial<LayoutSettings>): void => {
    void updateSettings({ layout: { ...layout, ...patch } })
  }

  const startSidebarResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (layout.sidebarCollapsed) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = sidebarWidth
    let nextWidth = startWidth
    const move = (moveEvent: PointerEvent): void => {
      nextWidth = clamp(startWidth + moveEvent.clientX - startX, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH)
      setSidebarWidth(nextWidth)
    }
    const stop = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      document.body.classList.remove('is-resizing-layout')
      patchLayout({ sidebarWidth: nextWidth })
    }
    document.body.classList.add('is-resizing-layout')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop, { once: true })
  }

  const historyByActiveId = useMemo(() => {
    const map = new Map<string, HistoryEntry>()
    for (const item of history) {
      map.set(item.id, item)
      if (item.sdkSessionId) map.set(item.sdkSessionId, item)
    }
    return map
  }, [history])

  const projectNameForPath = (path: string): string =>
    projects.find((project) => project.path === path)?.name ?? basename(path)

  const matchesQuery = (entry: SidebarEntry): boolean => {
    const q = query.trim().toLowerCase()
    if (!q) return true
    const path = entryPath(entry)
    const projectName = projectNameForPath(path)
    const text = [entryTitle(entry), path, projectName].map(normalized).join('\n')
    return text.includes(q)
  }

  const matchesTaskSnapshot = (snapshot: TaskSnapshotRecord): boolean => {
    const q = query.trim().toLowerCase()
    if (!q) return true
    const projectName = projectNameForPath(snapshot.projectPath)
    const text = [
      snapshot.title,
      snapshot.projectPath,
      projectName,
      snapshot.model,
      snapshot.providerId
    ].map(normalized).join('\n')
    return text.includes(q)
  }

  const openSdkIds = new Set(
    order.map((id) => sessions[id]?.meta.sdkSessionId).filter((id): id is string => Boolean(id))
  )
  const openSessionIds = new Set(order)
  const activeEntries: ActiveSidebarEntry[] = order.flatMap((id) => {
    const session = sessions[id]
    if (!session) return []
    const historyEntry =
      historyByActiveId.get(id) ??
      (session.meta.sdkSessionId ? historyByActiveId.get(session.meta.sdkSessionId) : undefined)
    const entry: ActiveSidebarEntry = {
      kind: 'active' as const,
      id,
      meta: session.meta,
      pendingCount: session.pendingPermissions.length
    }
    if (historyEntry) entry.history = historyEntry
    return matchesQuery(entry) ? [entry] : []
  })

  const historyEntries = history.filter(
    (entry) => !openSessionIds.has(entry.id) && !openSdkIds.has(entry.sdkSessionId)
  )
  const pinnedEntries: SidebarEntry[] = [
    ...activeEntries.filter((entry) => entry.history?.pinned && !entry.history.archived),
    ...historyEntries
      .filter((entry) => entry.pinned && !entry.archived)
      .map((entry) => ({ kind: 'history' as const, id: entry.id, history: entry }))
      .filter(matchesQuery)
  ]
  const pinnedActiveIds = new Set(
    pinnedEntries.filter((entry) => entry.kind === 'active').map((entry) => entry.id)
  )
  const ongoingEntries = activeEntries.filter((entry) => !pinnedActiveIds.has(entry.id))
  const recentHistory = historyEntries
    .filter((entry) => !entry.pinned && !entry.archived)
    .filter((entry) => matchesQuery({ kind: 'history', id: entry.id, history: entry }))
  const archivedHistory = historyEntries
    .filter((entry) => entry.archived)
    .filter((entry) => matchesQuery({ kind: 'history', id: entry.id, history: entry }))
  const visibleTaskSnapshots = taskSnapshots
    .filter((snapshot) => snapshot.reason !== 'created')
    .filter((snapshot) =>
      !openSessionIds.has(snapshot.sessionId) ||
      snapshot.run?.effects?.some((effect) => effect.status === 'waiting_reconciliation')
    )
    .filter(matchesTaskSnapshot)

  const projectGroups = useMemo<ProjectGroup[]>(() => {
    const groups = new Map<string, ProjectGroup>()
    for (const entry of recentHistory) {
      const path = historyPath(entry)
      const current = groups.get(path)
      if (current) {
        current.entries.push(entry)
        current.updatedAt = Math.max(current.updatedAt, entry.updatedAt)
      } else {
        groups.set(path, {
          key: path,
          label: projectNameForPath(path),
          path,
          entries: [entry],
          updatedAt: entry.updatedAt
        })
      }
    }
    return [...groups.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }, [recentHistory, projects])

  const startRename = (entry: SidebarEntry): void => {
    setEditing({ kind: entry.kind, id: entry.id })
    setDraftTitle(entryTitle(entry))
    setMenu(null)
  }

  const commitRename = (): void => {
    const target = editing
    const title = draftTitle.trim()
    setEditing(null)
    if (!target || !title) return
    if (target.kind === 'active') void renameSession(target.id, title)
    else void renameHistoryEntry(target.id, title)
  }

  const showMenu = (e: React.MouseEvent, entry: SidebarEntry): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, entry })
  }

  const showButtonMenu = (e: React.MouseEvent<HTMLButtonElement>, entry: SidebarEntry): void => {
    e.preventDefault()
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    setMenu({ x: rect.right - 4, y: rect.bottom + 4, entry })
  }

  const copyPath = (path: string): void => {
    void navigator.clipboard?.writeText(path).catch(() => undefined)
  }

  const closeMobile = (): void => {
    onMobileClose?.()
  }

  const menuItemsFor = (entry: SidebarEntry): SessionMenuItem[] => {
    const title = entryTitle(entry)
    const path = entryPath(entry)
    const historyEntry = entry.kind === 'history' ? entry.history : entry.history
    const items: SessionMenuItem[] = [
      { key: 'rename', label: t('rename'), onClick: () => startRename(entry) }
    ]

    if (historyEntry) {
      items.push({
        key: 'pin',
        label: historyEntry.pinned ? t('unpinSession') : t('pinSession'),
        onClick: () => void pinHistory(historyEntry.id, !historyEntry.pinned)
      })
      items.push({
        key: 'archive',
        label: historyEntry.archived ? t('unarchiveSession') : t('archiveSession'),
        onClick: () => void archiveHistory(historyEntry.id, !historyEntry.archived)
      })
    }

    items.push({ key: 'copy-path', label: t('copyPath'), onClick: () => copyPath(path) })
    items.push({
      key: 'delete',
      label: entry.kind === 'active' ? t('closeSession') : t('delete'),
      danger: true,
      onClick: () => {
        const message =
          entry.kind === 'active'
            ? t('closeSessionConfirm', { title })
            : t('deleteHistoryConfirm', { title })
        if (!window.confirm(message)) return
        if (entry.kind === 'active') void closeSession(entry.id)
        else void deleteHistoryEntry(entry.id)
      }
    })
    return items
  }

  const renderTitle = (entry: SidebarEntry): React.ReactNode => {
    const isolated = entry.kind === 'active' ? entry.meta.isolated : entry.history.isolated
    const pinned = entry.kind === 'active' ? entry.history?.pinned : entry.history.pinned
    return (
      <span className="session-card-title">
        {pinned && <span className="session-pin-mark" title={t('pinned')}>★</span>}
        {isolated && (
          <span className="worktree-mark" title="Git worktree 隔离">
            ⎇
          </span>
        )}
        {entryTitle(entry)}
      </span>
    )
  }

  const renderEditingCard = (key: string): React.ReactNode => (
    <div key={key} className="session-card session-card-editing">
      <input
        className="input session-rename-input"
        value={draftTitle}
        autoFocus
        onChange={(e) => setDraftTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitRename()
          if (e.key === 'Escape') setEditing(null)
        }}
        onBlur={commitRename}
      />
    </div>
  )

  const renderActiveEntry = (entry: ActiveSidebarEntry): React.ReactNode => {
    if (editing?.kind === 'active' && editing.id === entry.id) return renderEditingCard(entry.id)
    const displayCwd = entryPath(entry)
    return (
      <div
        key={entry.id}
        className={`session-card ${activeId === entry.id ? 'active' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => {
          selectSession(entry.id)
          closeMobile()
        }}
        onKeyDown={(e) =>
          activateByKeyboard(e, () => {
            selectSession(entry.id)
            closeMobile()
          })
        }
        onContextMenu={(e) => showMenu(e, entry)}
      >
        <span
          className={`status-dot status-${entry.meta.status}`}
          title={t(STATUS_LABEL_KEY[entry.meta.status])}
        />
        <span className="session-card-body">
          {renderTitle(entry)}
          <span className="session-card-sub">
            {projectNameForPath(displayCwd)} · {formatCost(entry.meta.costUsd)}
          </span>
        </span>
        {entry.pendingCount > 0 && (
          <span className="session-card-badge" title={t('awaitingApproval')}>
            {entry.pendingCount}
          </span>
        )}
        <button
          className="session-action session-card-more"
          title={t('moreActions')}
          aria-haspopup="menu"
          onClick={(e) => showButtonMenu(e, entry)}
        >
          ⋯
        </button>
      </div>
    )
  }

  const renderHistoryEntry = (entry: HistoryEntry): React.ReactNode => {
    const ref: SidebarEntry = { kind: 'history', id: entry.id, history: entry }
    if (editing?.kind === 'history' && editing.id === entry.id) return renderEditingCard(entry.id)
    const path = historyPath(entry)
    return (
      <div
        key={entry.id}
        className="session-card history-card"
        role="button"
        tabIndex={0}
        title={t('resumeSessionTitle', { cwd: path })}
        onClick={() => {
          closeMobile()
          void resumeFromHistory(entry)
        }}
        onKeyDown={(e) =>
          activateByKeyboard(e, () => {
            closeMobile()
            void resumeFromHistory(entry)
          })
        }
        onContextMenu={(e) => showMenu(e, ref)}
      >
        <span className="history-icon">↻</span>
        <span className="session-card-body">
          {renderTitle(ref)}
          <span className="session-card-sub">
            {projectNameForPath(path)} · {formatTime(entry.updatedAt)}
          </span>
        </span>
        <button
          className="session-action session-card-more"
          title={t('moreActions')}
          aria-haspopup="menu"
          onClick={(e) => showButtonMenu(e, ref)}
        >
          ⋯
        </button>
      </div>
    )
  }

  const renderSearchHit = (result: TranscriptSearchResult): React.ReactNode => {
    const first = result.hits[0]
    return (
      <div
        key={result.sdkSessionId}
        className="session-card search-hit-card"
        role="button"
        tabIndex={0}
        title={t('resumeSessionTitle', { cwd: result.cwd })}
        onClick={() => void openTranscriptSearchHit(result)}
        onKeyDown={(e) => activateByKeyboard(e, () => void openTranscriptSearchHit(result))}
      >
        <span className="history-icon">⌕</span>
        <span className="session-card-body">
          <span className="session-card-title">{result.title}</span>
          <span className="search-hit-snippet">
            {first ? highlightSnippet(first.snippet, query.trim()) : result.note}
          </span>
        </span>
      </div>
    )
  }

  const renderTaskSnapshot = (snapshot: TaskSnapshotRecord): React.ReactNode => {
    const waitingReconciliation = snapshot.run?.effects?.some(
      (effect) => effect.status === 'waiting_reconciliation'
    ) === true
    const openSnapshot = (): void => {
      closeMobile()
      if (waitingReconciliation) {
        setShowTaskRecovery(true)
        return
      }
      void recoverTaskSnapshot(snapshot.id)
    }
    return (
      <div
        key={snapshot.id}
        className="session-card task-snapshot-card"
        role="button"
        tabIndex={0}
        title={t('recoverTaskSnapshotTitle', { cwd: snapshot.projectPath })}
        onClick={openSnapshot}
        onKeyDown={(e) => activateByKeyboard(e, openSnapshot)}
      >
        <span className="history-icon">↺</span>
        <span className="session-card-body">
          <span className="session-card-title">{snapshot.title}</span>
          <span className="session-card-sub">
            {waitingReconciliation ? '等待对账 · ' : ''}
            {projectNameForPath(snapshot.projectPath)} · {formatTime(snapshot.updatedAt)}
          </span>
        </span>
        <button
          className="session-action task-snapshot-delete"
          title={t('deleteTaskSnapshot')}
          disabled={waitingReconciliation}
          onClick={(e) => {
            e.stopPropagation()
            if (waitingReconciliation) return
            if (!window.confirm(t('deleteTaskSnapshotConfirm', { title: snapshot.title }))) return
            void deleteTaskSnapshot(snapshot.id)
          }}
        >
          ×
        </button>
      </div>
    )
  }

  const totalVisible =
    pinnedEntries.length +
    ongoingEntries.length +
    visibleTaskSnapshots.length +
    recentHistory.length +
    archivedHistory.length
  const archiveExpanded = archiveOpen || query.trim().length > 0
  const isInitialEmpty = totalVisible === 0 && query.trim().length === 0
  const contentSearchActive = query.trim().length >= 2

  return (
    <aside
      className={`sidebar ${layout.sidebarCollapsed ? 'sidebar-collapsed' : ''} ${mobileOpen ? 'sidebar-mobile-open' : ''}`}
      style={
        {
          '--sidebar-width': `${layout.sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth}px`
        } as React.CSSProperties
      }
    >
      <div className="sidebar-brand drag-region" data-brand="caogen">
        <span className="brand-mark" data-brand-logo="caogen-app-icon" aria-hidden="true">
          <img src={APP_ICON_URL} alt="" />
        </span>
        <span className="brand-name">{APP_NAME}</span>
        <button
          type="button"
          className="sidebar-collapse-toggle no-drag"
          aria-label={layout.sidebarCollapsed ? t('expandSidebar') : t('collapseSidebar')}
          title={layout.sidebarCollapsed ? t('expandSidebar') : t('collapseSidebar')}
          onClick={() => patchLayout({ sidebarCollapsed: !layout.sidebarCollapsed })}
        >
          {layout.sidebarCollapsed ? '›' : '‹'}
        </button>
        <button
          type="button"
          className="sidebar-mobile-close no-drag"
          aria-label={t('closeSession')}
          onClick={closeMobile}
        >
          ×
        </button>
      </div>

      <button
        className="btn btn-primary sidebar-new"
        onClick={() => {
          closeMobile()
          setShowNewSession(true)
        }}
      >
        {t('newSession')}
      </button>

      <button
        className="btn btn-ghost sidebar-office"
        onClick={() => {
          closeMobile()
          setView('office')
        }}
      >
        {t('office3d')}
      </button>

      <div className="sidebar-search-wrap">
        <input
          className="input sidebar-search"
          value={query}
          placeholder={t('sidebarSearchPlaceholder')}
          onChange={(e) => setSidebarQuery(e.target.value)}
        />
      </div>

      <div className="sidebar-scroll">
        {isInitialEmpty ? (
          <div className="sidebar-empty-hero">
            <div className="sidebar-empty-title">{t('sidebarEmptyHeroTitle')}</div>
            <button className="btn btn-primary btn-sm" onClick={() => setShowNewSession(true)}>
              {t('newSession')}
            </button>
          </div>
        ) : (
          <>
            {pinnedEntries.length > 0 && (
              <section className="sidebar-section">
                <div className="sidebar-section-title">{t('pinned')}</div>
                {pinnedEntries.map((entry) =>
                  entry.kind === 'active' ? renderActiveEntry(entry) : renderHistoryEntry(entry.history)
                )}
              </section>
            )}

            {ongoingEntries.length > 0 && (
              <section className="sidebar-section">
                <div className="sidebar-section-title">{t('ongoing')}</div>
                {ongoingEntries.map((entry) => renderActiveEntry(entry))}
              </section>
            )}

            {(visibleTaskSnapshots.length > 0 || taskSnapshotsLoading || taskSnapshotsError) && (
              <section className="sidebar-section">
                <div className="sidebar-section-title">{t('recoverableTasks')}</div>
                {visibleTaskSnapshots.map((snapshot) => renderTaskSnapshot(snapshot))}
                {visibleTaskSnapshots.length === 0 && taskSnapshotsLoading && (
                  <div className="sidebar-empty">{t('loadingTaskSnapshots')}</div>
                )}
                {visibleTaskSnapshots.length === 0 && taskSnapshotsError && (
                  <div className="sidebar-empty">{taskSnapshotsError}</div>
                )}
              </section>
            )}

            {projectGroups.length > 0 && (
              <section className="sidebar-section">
                <div className="sidebar-section-title">{t('recent')}</div>
                {projectGroups.map((group) => {
                  const collapsed = collapsedProjects[group.key] === true
                  return (
                    <div key={group.key} className="sidebar-project-group">
                      <button
                        className="sidebar-group-head"
                        title={group.path}
                        onClick={() =>
                          setCollapsedProjects((state) => ({ ...state, [group.key]: !collapsed }))
                        }
                      >
                        <span className="sidebar-group-caret">{collapsed ? '▸' : '▾'}</span>
                        <span className="sidebar-group-title">{group.label}</span>
                        <span className="sidebar-group-count">{group.entries.length}</span>
                      </button>
                      {!collapsed && group.entries.map((entry) => renderHistoryEntry(entry))}
                    </div>
                  )
                })}
              </section>
            )}

            {archivedHistory.length > 0 && (
              <section className="sidebar-section">
                <button className="sidebar-section-toggle" onClick={() => setArchiveOpen((value) => !value)}>
                  <span>{archiveExpanded ? '▾' : '▸'}</span>
                  <span>{t('archived')}</span>
                  <span className="sidebar-group-count">{archivedHistory.length}</span>
                </button>
                {archiveExpanded && archivedHistory.map((entry) => renderHistoryEntry(entry))}
              </section>
            )}

            {contentSearchActive && (
              <section className="sidebar-section">
                <div className="sidebar-section-title">{t('contentSearchSection')}</div>
                {transcriptSearchResults.map((result) => renderSearchHit(result))}
                {transcriptSearchResults.length === 0 && !transcriptSearchLoading && (
                  <div className="sidebar-empty">{t('contentSearchEmpty')}</div>
                )}
              </section>
            )}

            {totalVisible === 0 && <div className="sidebar-empty">{t('noMatchingSessions')}</div>}
          </>
        )}
      </div>

      <div className="sidebar-footer">
        <button
          className="btn btn-ghost"
          onClick={() => {
            closeMobile()
            setShowSettings(true)
          }}
        >
          {t('settings')}
        </button>
      </div>

      <div
        className="sidebar-resize-handle no-drag"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('resizeSidebar')}
        title={t('resizeSidebar')}
        onPointerDown={startSidebarResize}
      />

      {menu && (
        <SessionContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItemsFor(menu.entry)}
          onClose={() => setMenu(null)}
        />
      )}
    </aside>
  )
}
