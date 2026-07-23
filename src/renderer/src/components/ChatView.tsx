import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { modelOptionsForProvider, PERMISSION_OPTIONS, useStore } from '../store'
import { useT } from '../i18n'
import { HeaderIcon, type HeaderIconName } from './ChatHeaderIcons'
import MessageItem from './MessageItem'
import PermissionBar from './PermissionBar'
import Composer from './Composer'
import RewindPanel from './RewindPanel'
import StartSuggestionsPanel from './StartSuggestionsPanel'
import type { PermissionModeId } from '../../../shared/types'
import type { ChatItem, ToolResultInfo } from '../store'
import { useExperienceProjection } from './experience/ExperienceProjection'
import ChatStatusBar from './experience/ChatStatusBar'

const VIRTUAL_MESSAGE_THRESHOLD = 100
const VIRTUAL_MESSAGE_ESTIMATED_HEIGHT = 116
const VIRTUAL_MESSAGE_GAP = 14
const VIRTUAL_MESSAGE_OVERSCAN_PX = 720
const CHAT_SCALE_MIN = 0.85
const CHAT_SCALE_MAX = 1.25
const CHAT_SCALE_STEP = 0.05

interface ScrollSnapshot {
  top: number
  height: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number(value.toFixed(2))))
}

export default function ChatView(): React.JSX.Element | null {
  const t = useT()
  const projection = useExperienceProjection()
  const activeId = useStore((s) => s.activeId)
  const session = useStore((s) => (s.activeId ? s.sessions[s.activeId] : undefined))
  const providers = useStore((s) => s.providers)
  const closeSession = useStore((s) => s.closeSession)
  const interrupt = useStore((s) => s.interrupt)
  const setPermissionMode = useStore((s) => s.setPermissionMode)
  const setModel = useStore((s) => s.setModel)
  const openLatestRewindPanel = useStore((s) => s.openLatestRewindPanel)
  const openBrowserPanel = useStore((s) => s.openBrowserPanel)
  const openFilesPanel = useStore((s) => s.openFilesPanel)
  const openWorktreePanel = useStore((s) => s.openWorktreePanel)
  const openTerminalPanel = useStore((s) => s.openTerminalPanel)
  const openPluginRegistryPanel = useStore((s) => s.openPluginRegistryPanel)
  const openSubagentPanel = useStore((s) => s.openSubagentPanel)
  const openRoutinePanel = useStore((s) => s.openRoutinePanel)
  const openMemoryPanel = useStore((s) => s.openMemoryPanel)
  const allStartSuggestions = useStore((s) => s.workbench.startSuggestions)
  const ignoredStartSuggestions = useStore((s) => s.workbench.ignoredStartSuggestions)
  const laterStartSuggestions = useStore((s) => s.workbench.laterStartSuggestions)
  const startSuggestionsLoading = useStore((s) => s.workbench.startSuggestionsLoading)
  const startSuggestionsError = useStore((s) => s.workbench.startSuggestionsError)
  const memorySuggestion = useStore((s) => s.workbench.memorySuggestion)
  const refreshStartSuggestions = useStore((s) => s.refreshStartSuggestions)
  const sendStartSuggestion = useStore((s) => s.sendStartSuggestion)
  const laterStartSuggestion = useStore((s) => s.laterStartSuggestion)
  const ignoreStartSuggestion = useStore((s) => s.ignoreStartSuggestion)
  const acceptMemorySuggestion = useStore((s) => s.acceptMemorySuggestion)
  const dismissMemorySuggestion = useStore((s) => s.dismissMemorySuggestion)
  const layout = useStore((s) => s.settings.layout)
  const updateSettings = useStore((s) => s.updateSettings)

  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const scrollFrame = useRef<number | null>(null)
  const [scrollSnapshot, setScrollSnapshot] = useState<ScrollSnapshot>({ top: 0, height: 0 })
  const [moreOpen, setMoreOpen] = useState(false)
  const [startSuggestionsSessionId, setStartSuggestionsSessionId] = useState<string | null>(null)
  const moreRef = useRef<HTMLDivElement>(null)
  const startSuggestionsOpen = startSuggestionsSessionId === activeId

  const updateScrollSnapshot = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    const next = { top: el.scrollTop, height: el.clientHeight }
    setScrollSnapshot((current) =>
      Math.abs(current.top - next.top) < 1 && Math.abs(current.height - next.height) < 1 ? current : next
    )
  }, [])

  const scheduleScrollSnapshot = useCallback((): void => {
    if (scrollFrame.current !== null) return
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = null
      updateScrollSnapshot()
    })
  }, [updateScrollSnapshot])

  const patchLayout = useCallback(
    (patch: Partial<typeof layout>): void => {
      void updateSettings({ layout: { ...layout, ...patch } }).catch((error) => {
        console.error('[agent-desk] Failed to persist chat layout:', error)
      })
    },
    [layout, updateSettings]
  )

  const setChatScale = useCallback(
    (value: number): void => {
      patchLayout({ chatScale: clamp(value, CHAT_SCALE_MIN, CHAT_SCALE_MAX) })
    },
    [patchLayout]
  )

  useEffect(() => {
    if (!moreOpen) return
    const onPointerDown = (event: MouseEvent): void => {
      if (moreRef.current?.contains(event.target as Node)) return
      setMoreOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMoreOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [moreOpen])

  const startSuggestions = useMemo(() => {
    if (!activeId) return []
    const now = Date.now()
    return allStartSuggestions.filter((suggestion) => {
      const key = `${activeId}:${suggestion.id}`
      return !ignoredStartSuggestions[key] && (laterStartSuggestions[key] ?? 0) <= now
    })
  }, [activeId, allStartSuggestions, ignoredStartSuggestions, laterStartSuggestions])

  const itemCount = session?.items.length ?? 0
  const streamLen = (session?.streamText.length ?? 0) + (session?.streamThinking.length ?? 0)

  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight
      updateScrollSnapshot()
    }
  }, [itemCount, streamLen, activeId, updateScrollSnapshot])

  useEffect(() => {
    updateScrollSnapshot()
    return () => {
      if (scrollFrame.current !== null) window.cancelAnimationFrame(scrollFrame.current)
    }
  }, [activeId, updateScrollSnapshot])

  useEffect(() => {
    setMoreOpen(false)
    setStartSuggestionsSessionId(null)
  }, [activeId])

  useEffect(() => {
    let lastEsc = 0
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const now = Date.now()
      if (now - lastEsc < 700) {
        e.preventDefault()
        openLatestRewindPanel('shortcut')
        lastEsc = 0
        return
      }
      lastEsc = now
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openLatestRewindPanel])

  if (!session || !activeId) return null
  const { meta } = session
  const running = meta.status === 'running' || meta.status === 'starting'
  const modelOptions = modelOptionsForProvider(providers, meta.providerId, t('autoRoute'), meta.model)
  const providerName = meta.providerId
    ? providers.find((p) => p.id === meta.providerId)?.name ?? t('unknownProvider')
    : t('providerOfficial')
  const activeMemorySuggestion = memorySuggestion?.sessionId === activeId ? memorySuggestion : undefined

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    scheduleScrollSnapshot()
  }

  return (
    <div
      className={`chat chat-density-${layout.chatDensity}`}
      data-experience-projection={projection}
      style={{ '--chat-scale': layout.chatScale } as React.CSSProperties}
    >
      <header className="chat-header drag-region">
        <div className="chat-heading">
          <div className="chat-title" title={meta.title}>
            {meta.title}
          </div>
          <div className="chat-cwd" title={meta.cwd}>
            {meta.cwd}
          </div>
        </div>
        <div className="chat-controls no-drag">
          <SessionModelSelect
            disabled={running}
            label={t('switchModel')}
            model={meta.model}
            onChange={setModel}
            options={modelOptions}
            sessionId={meta.id}
          />
          <select
            className="select"
            data-expert-control="true"
            value={meta.permissionMode}
            onChange={(e) => void setPermissionMode(e.target.value as PermissionModeId)}
            title={t('permissionMode')}
          >
            {PERMISSION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <div className="chat-layout-controls" aria-label={t('chatLayoutControls')}>
            <button
              type="button"
              className="icon-btn text-icon-btn"
              aria-label={t('zoomOutChat')}
              title={t('zoomOutChat')}
              disabled={layout.chatScale <= CHAT_SCALE_MIN}
              onClick={() => setChatScale(layout.chatScale - CHAT_SCALE_STEP)}
            >
              A-
            </button>
            <button
              type="button"
              className="chat-zoom-value"
              aria-label={t('resetChatZoom')}
              title={t('resetChatZoom')}
              onClick={() => setChatScale(1)}
            >
              {Math.round(layout.chatScale * 100)}%
            </button>
            <button
              type="button"
              className="icon-btn text-icon-btn"
              aria-label={t('zoomInChat')}
              title={t('zoomInChat')}
              disabled={layout.chatScale >= CHAT_SCALE_MAX}
              onClick={() => setChatScale(layout.chatScale + CHAT_SCALE_STEP)}
            >
              A+
            </button>
            <button
              type="button"
              className={`icon-btn text-icon-btn ${layout.chatDensity === 'compact' ? 'icon-btn-active' : ''}`}
              aria-label={t('toggleCompactChat')}
              title={t('toggleCompactChat')}
              onClick={() =>
                patchLayout({
                  chatDensity: layout.chatDensity === 'compact' ? 'comfortable' : 'compact'
                })
              }
            >
              ≡
            </button>
          </div>
          {running && (
            <button className="btn btn-danger" onClick={() => void interrupt()}>
              {t('stop')}
            </button>
          )}
          {meta.isolated && (
            <IconButton
              icon="worktree"
              expert
              label={t('worktreeShort')}
              onClick={() => void openWorktreePanel()}
            />
          )}
          <IconButton icon="files" label={t('filesShort')} onClick={() => void openFilesPanel()} />
          <IconButton
            icon="terminal"
            expert
            label={t('terminalShort')}
            onClick={() => void openTerminalPanel()}
          />
          <IconButton
            icon="browser"
            label={t('browserShort')}
            onClick={() => void openBrowserPanel()}
          />
          <div className="header-more" ref={moreRef}>
            <button
              type="button"
              className={`icon-btn ${moreOpen ? 'icon-btn-active' : ''}`}
              aria-label={t('moreActions')}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              title={t('moreActions')}
              onClick={() => setMoreOpen((v) => !v)}
            >
              <span className="header-more-glyph">⋯</span>
            </button>
            {moreOpen && (
              <div className="header-more-menu" role="menu">
                <MenuItem
                  action="subagents"
                  icon="subagents"
                  label={t('subagentsShort')}
                  onSelect={() => {
                    setMoreOpen(false)
                    void openSubagentPanel()
                  }}
                />
                <MenuItem
                  action="plugins"
                  icon="plugins"
                  label={t('pluginsShort')}
                  onSelect={() => {
                    setMoreOpen(false)
                    void openPluginRegistryPanel()
                  }}
                />
                <MenuItem
                  action="routines"
                  icon="routines"
                  label={t('routinesShort')}
                  onSelect={() => {
                    setMoreOpen(false)
                    void openRoutinePanel()
                  }}
                />
                <MenuItem
                  action="start-suggestions"
                  icon="suggestions"
                  label={t('startSuggestionsShort')}
                  onSelect={() => {
                    setMoreOpen(false)
                    if (startSuggestionsOpen) {
                      setStartSuggestionsSessionId(null)
                      return
                    }
                    setStartSuggestionsSessionId(activeId)
                    void refreshStartSuggestions()
                  }}
                />
                <MenuItem
                  action="memory"
                  icon="memory"
                  label={t('memoryShort')}
                  onSelect={() => {
                    setMoreOpen(false)
                    openMemoryPanel()
                  }}
                />
              </div>
            )}
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('closeSession')}
            title={t('closeSession')}
            onClick={() => void closeSession(activeId)}
          >
            <span className="header-close-glyph">✕</span>
          </button>
        </div>
      </header>

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-inner">
          {startSuggestionsOpen && startSuggestionsLoading && (
            <div className="notice start-suggestions-chat-notice" data-start-suggestions-status="loading">
              {t('startSuggestionsLoading')}
            </div>
          )}
          {startSuggestionsOpen && startSuggestionsError && (
            <div className="notice notice-error start-suggestions-chat-notice">{startSuggestionsError}</div>
          )}
          {startSuggestionsOpen &&
            !startSuggestionsLoading &&
            !startSuggestionsError &&
            startSuggestions.length === 0 && (
              <div className="notice start-suggestions-chat-notice" data-start-suggestions-status="empty">
                {t('startSuggestionsEmpty')}
              </div>
            )}
          {startSuggestionsOpen && (
            <StartSuggestionsPanel
              suggestions={startSuggestions}
              compact
              disabled={running || startSuggestionsLoading}
              maxVisible={3}
              onSendToAgent={(suggestion) => void sendStartSuggestion(suggestion)}
              onLater={(suggestion) => laterStartSuggestion(suggestion.id)}
              onIgnore={(suggestion) => ignoreStartSuggestion(suggestion.id)}
            />
          )}
          <MessageList
            activeId={activeId}
            items={session.items}
            toolResults={session.toolResults}
            runningTools={session.runningTools}
            scrollRef={scrollRef}
            scrollSnapshot={scrollSnapshot}
            stickToBottom={stickToBottom}
          />

          {session.streamThinking && (
            <div className="thinking-stream">
              <div className="thinking-label">{t('thinkingLive')}</div>
              <div className="thinking-text">{session.streamThinking}</div>
            </div>
          )}
          {session.streamText && <div className="assistant-text streaming">{session.streamText}</div>}
          {running && !session.streamText && !session.streamThinking && (
            <div className="working-indicator">
              <span className="spinner" /> {t('agentWorking')}
            </div>
          )}
        </div>
      </div>

      <PermissionBar sessionId={activeId} requests={session.pendingPermissions} />
      {activeMemorySuggestion && (
        <div className="memory-suggestion-bar" data-memory-suggestion-bar="true">
          <div
            className="memory-suggestion-text"
            title={activeMemorySuggestion.text}
            data-memory-suggestion-text
          >
            记住这条约定? {activeMemorySuggestion.text}
          </div>
          <button
            className="btn btn-primary btn-sm"
            data-memory-suggestion-action="accept"
            onClick={acceptMemorySuggestion}
          >
            记住
          </button>
          <button
            className="btn btn-ghost btn-sm"
            data-memory-suggestion-action="dismiss"
            onClick={dismissMemorySuggestion}
          >
            忽略
          </button>
        </div>
      )}
      <Composer running={running} />
      <RewindPanel />

      <ChatStatusBar meta={meta} providerName={providerName} session={session} />
    </div>
  )
}

interface SessionModelSelectProps {
  disabled: boolean
  label: string
  model: string
  onChange: (model: string) => Promise<void>
  options: Array<{ value: string; label: string }>
  sessionId: string
}

function SessionModelSelect({
  disabled,
  label,
  model,
  onChange,
  options,
  sessionId
}: SessionModelSelectProps): React.JSX.Element {
  const [error, setError] = useState('')
  useEffect(() => setError(''), [model, sessionId])
  const errorId = error ? 'session-model-switch-error' : undefined

  return (
    <div className="session-model-control">
      <select
        aria-describedby={errorId}
        aria-invalid={Boolean(error)}
        className="select"
        data-expert-control="true"
        data-session-model-select="true"
        disabled={disabled}
        title={label}
        value={model}
        onChange={(event) => {
          setError('')
          void onChange(event.target.value).catch((cause) => setError(errorText(cause)))
        }}
      >
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      {error && <span id={errorId} className="session-model-error" role="alert">{error}</span>}
    </div>
  )
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

interface MessageListProps {
  activeId: string
  items: ChatItem[]
  toolResults: Record<string, ToolResultInfo>
  runningTools: Record<string, true>
  scrollRef: React.RefObject<HTMLDivElement>
  scrollSnapshot: ScrollSnapshot
  stickToBottom: React.MutableRefObject<boolean>
}

function MessageList({
  activeId,
  items,
  toolResults,
  runningTools,
  scrollRef,
  scrollSnapshot,
  stickToBottom
}: MessageListProps): React.JSX.Element {
  if (items.length <= VIRTUAL_MESSAGE_THRESHOLD) {
    return (
      <>
        {items.map((item) => (
          <MessageItem key={item.id} item={item} toolResults={toolResults} runningTools={runningTools} />
        ))}
      </>
    )
  }

  return (
    <VirtualMessageList
      activeId={activeId}
      items={items}
      toolResults={toolResults}
      runningTools={runningTools}
      scrollRef={scrollRef}
      scrollSnapshot={scrollSnapshot}
      stickToBottom={stickToBottom}
    />
  )
}

function VirtualMessageList({
  activeId,
  items,
  toolResults,
  runningTools,
  scrollRef,
  scrollSnapshot,
  stickToBottom
}: MessageListProps): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  const sizeById = useRef(new Map<string, number>())
  const heightFrame = useRef<number | null>(null)
  const [heightVersion, setHeightVersion] = useState(0)
  const [listTop, setListTop] = useState(0)

  const scheduleHeightVersion = useCallback((): void => {
    if (heightFrame.current !== null) return
    heightFrame.current = window.requestAnimationFrame(() => {
      heightFrame.current = null
      setHeightVersion((value) => value + 1)
    })
  }, [])

  const measureListTop = useCallback((): void => {
    const scrollEl = scrollRef.current
    const listEl = listRef.current
    if (!scrollEl || !listEl) return
    const scrollRect = scrollEl.getBoundingClientRect()
    const listRect = listEl.getBoundingClientRect()
    const nextTop = listRect.top - scrollRect.top + scrollEl.scrollTop
    setListTop((current) => (Math.abs(current - nextTop) < 1 ? current : nextTop))
  }, [scrollRef])

  useEffect(() => {
    sizeById.current.clear()
    scheduleHeightVersion()
    setListTop(0)
    return () => {
      if (heightFrame.current !== null) window.cancelAnimationFrame(heightFrame.current)
    }
  }, [activeId, scheduleHeightVersion])

  useEffect(() => {
    const liveIds = new Set(items.map((item) => item.id))
    let changed = false
    for (const id of sizeById.current.keys()) {
      if (liveIds.has(id)) continue
      sizeById.current.delete(id)
      changed = true
    }
    if (changed) scheduleHeightVersion()
  }, [items, scheduleHeightVersion])

  useLayoutEffect(() => {
    measureListTop()
  }, [items.length, measureListTop, scrollSnapshot.height])

  useEffect(() => {
    const scrollEl = scrollRef.current
    const listEl = listRef.current
    if (!scrollEl || !listEl) return
    const observer = new ResizeObserver(measureListTop)
    observer.observe(scrollEl)
    observer.observe(listEl)
    window.addEventListener('resize', measureListTop)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measureListTop)
    }
  }, [measureListTop, scrollRef])

  const handleMeasure = useCallback(
    (id: string, height: number): void => {
      const previous = sizeById.current.get(id)
      if (previous !== undefined && Math.abs(previous - height) < 1) return
      sizeById.current.set(id, height)
      scheduleHeightVersion()
      if (stickToBottom.current) {
        window.requestAnimationFrame(() => {
          const scrollEl = scrollRef.current
          if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight
        })
      }
    },
    [scheduleHeightVersion, scrollRef, stickToBottom]
  )

  const sizes = useMemo(
    () => items.map((item) => sizeById.current.get(item.id) ?? VIRTUAL_MESSAGE_ESTIMATED_HEIGHT),
    [heightVersion, items]
  )
  const offsets = useMemo(() => {
    const values = new Array<number>(sizes.length + 1)
    values[0] = 0
    for (let i = 0; i < sizes.length; i++) values[i + 1] = values[i] + sizes[i]
    return values
  }, [sizes])

  const totalHeight = offsets[offsets.length - 1] ?? 0
  const visibleTop = Math.max(0, scrollSnapshot.top - listTop - VIRTUAL_MESSAGE_OVERSCAN_PX)
  const visibleBottom = Math.min(
    totalHeight,
    scrollSnapshot.top - listTop + scrollSnapshot.height + VIRTUAL_MESSAGE_OVERSCAN_PX
  )
  const startIndex = Math.max(0, findVirtualIndex(offsets, visibleTop) - 1)
  const endIndex = Math.min(items.length, findVirtualIndex(offsets, visibleBottom) + 1)
  const visibleItems = items.slice(startIndex, endIndex)

  return (
    <div
      ref={listRef}
      className="chat-virtual-list"
      style={{ height: totalHeight }}
      data-virtualized-messages="true"
      data-total-messages={items.length}
      data-visible-messages={visibleItems.length}
    >
      {visibleItems.map((item, visibleOffset) => {
        const index = startIndex + visibleOffset
        return (
          <VirtualMessageRow
            key={item.id}
            item={item}
            top={offsets[index] ?? 0}
            onMeasure={handleMeasure}
            toolResults={toolResults}
            runningTools={runningTools}
          />
        )
      })}
    </div>
  )
}

interface VirtualMessageRowProps {
  item: ChatItem
  top: number
  toolResults: Record<string, ToolResultInfo>
  runningTools: Record<string, true>
  onMeasure: (id: string, height: number) => void
}

function VirtualMessageRow({
  item,
  top,
  toolResults,
  runningTools,
  onMeasure
}: VirtualMessageRowProps): React.JSX.Element {
  const rowRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const node = rowRef.current
    if (!node) return
    const measure = (): void => {
      onMeasure(item.id, Math.ceil(node.getBoundingClientRect().height) + VIRTUAL_MESSAGE_GAP)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [item.id, onMeasure])

  return (
    <div ref={rowRef} className="chat-virtual-row" style={{ transform: `translateY(${top}px)` }}>
      <MessageItem item={item} toolResults={toolResults} runningTools={runningTools} />
    </div>
  )
}

function findVirtualIndex(offsets: number[], target: number): number {
  let low = 0
  let high = offsets.length - 1
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if ((offsets[mid] ?? 0) < target) low = mid + 1
    else high = mid
  }
  return low
}

interface IconButtonProps {
  expert?: boolean
  icon: HeaderIconName
  label: string
  onClick: () => void
}

function IconButton({ expert = false, icon, label, onClick }: IconButtonProps): React.JSX.Element {
  return (
    <button type="button" className="icon-btn" aria-label={label} title={label} data-expert-control={expert || undefined} onClick={onClick}>
      <HeaderIcon name={icon} />
    </button>
  )
}

interface MenuItemProps {
  action: string
  icon: HeaderIconName
  label: string
  onSelect: () => void
}

function MenuItem({ action, icon, label, onSelect }: MenuItemProps): React.JSX.Element {
  return (
    <button
      type="button"
      className="header-more-item"
      role="menuitem"
      data-header-action={action}
      onClick={onSelect}
    >
      <HeaderIcon name={icon} />
      <span>{label}</span>
    </button>
  )
}
