import { useEffect, useMemo, useRef, useState } from 'react'
import { MODEL_OPTIONS, PERMISSION_OPTIONS, useStore } from '../store'
import { useT } from '../i18n'
import { HeaderIcon, type HeaderIconName } from './ChatHeaderIcons'
import { formatCost, formatTokens } from '../format'
import MessageItem from './MessageItem'
import PermissionBar from './PermissionBar'
import Composer from './Composer'
import RewindPanel from './RewindPanel'
import StartSuggestionsPanel from './StartSuggestionsPanel'
import type { PermissionModeId } from '../../../shared/types'

export default function ChatView(): React.JSX.Element | null {
  const t = useT()
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

  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)

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
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [itemCount, streamLen, activeId])

  useEffect(() => {
    if (activeId) void refreshStartSuggestions()
  }, [activeId, refreshStartSuggestions])

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
  const modelKnown = MODEL_OPTIONS.some((o) => o.value === meta.model)
  const providerName = meta.providerId
    ? providers.find((p) => p.id === meta.providerId)?.name ?? t('unknownProvider')
    : t('providerOfficial')
  const activeMemorySuggestion = memorySuggestion?.sessionId === activeId ? memorySuggestion : undefined

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  return (
    <div className="chat">
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
          <select
            className="select"
            value={meta.model}
            onChange={(e) => void setModel(e.target.value)}
            title={t('switchModel')}
          >
            {MODEL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
            {!modelKnown && <option value={meta.model}>{meta.model}</option>}
          </select>
          <select
            className="select"
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
          {running && (
            <button className="btn btn-danger" onClick={() => void interrupt()}>
              {t('stop')}
            </button>
          )}
          {meta.isolated && (
            <IconButton
              icon="worktree"
              label={t('worktreeShort')}
              onClick={() => void openWorktreePanel()}
            />
          )}
          <IconButton icon="files" label={t('filesShort')} onClick={() => void openFilesPanel()} />
          <IconButton
            icon="terminal"
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
                  icon="subagents"
                  label={t('subagentsShort')}
                  onSelect={() => {
                    setMoreOpen(false)
                    void openSubagentPanel()
                  }}
                />
                <MenuItem
                  icon="plugins"
                  label={t('pluginsShort')}
                  onSelect={() => {
                    setMoreOpen(false)
                    void openPluginRegistryPanel()
                  }}
                />
                <MenuItem
                  icon="routines"
                  label={t('routinesShort')}
                  onSelect={() => {
                    setMoreOpen(false)
                    void openRoutinePanel()
                  }}
                />
                <MenuItem
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
          {startSuggestionsError && (
            <div className="notice notice-error start-suggestions-chat-notice">{startSuggestionsError}</div>
          )}
          <StartSuggestionsPanel
            suggestions={startSuggestions}
            compact
            disabled={running || startSuggestionsLoading}
            maxVisible={3}
            onSendToAgent={(suggestion) => void sendStartSuggestion(suggestion)}
            onLater={(suggestion) => laterStartSuggestion(suggestion.id)}
            onIgnore={(suggestion) => ignoreStartSuggestion(suggestion.id)}
          />
          {session.items.map((item) => (
            <MessageItem
              key={item.id}
              item={item}
              toolResults={session.toolResults}
              runningTools={session.runningTools}
            />
          ))}

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
        <div className="memory-suggestion-bar">
          <div className="memory-suggestion-text" title={activeMemorySuggestion.text}>
            记住这条约定? {activeMemorySuggestion.text}
          </div>
          <button className="btn btn-primary btn-sm" onClick={acceptMemorySuggestion}>
            记住
          </button>
          <button className="btn btn-ghost btn-sm" onClick={dismissMemorySuggestion}>
            忽略
          </button>
        </div>
      )}
      <Composer running={running} />
      <RewindPanel />

      <footer className="status-bar">
        <span className={`status-dot status-${meta.status}`} />
        <span className="status-text">
          {meta.status === 'running'
            ? t('statusRunning')
            : meta.status === 'starting'
              ? t('statusStarting')
              : meta.status === 'idle'
                ? t('statusIdle')
                : meta.status === 'error'
                  ? t('statusError')
                  : t('statusClosed')}
        </span>
        <span className="status-item">
          {t('provider')} {providerName}
        </span>
        {session.effectiveModel && (
          <span className="status-item">
            {t('model')} {session.effectiveModel}
          </span>
        )}
        <span className="status-spacer" />
        <span className="status-item">
          {t('statusContext')} ~{formatTokens(meta.contextTokens)} tokens
        </span>
        <span className="status-item">
          ↑{formatTokens(meta.usage.input + meta.usage.cacheRead + meta.usage.cacheCreation)} ↓
          {formatTokens(meta.usage.output)}
        </span>
        <span className="status-item status-cost">{formatCost(meta.costUsd)}</span>
      </footer>
    </div>
  )
}

interface IconButtonProps {
  icon: HeaderIconName
  label: string
  onClick: () => void
}

function IconButton({ icon, label, onClick }: IconButtonProps): React.JSX.Element {
  return (
    <button type="button" className="icon-btn" aria-label={label} title={label} onClick={onClick}>
      <HeaderIcon name={icon} />
    </button>
  )
}

interface MenuItemProps {
  icon: HeaderIconName
  label: string
  onSelect: () => void
}

function MenuItem({ icon, label, onSelect }: MenuItemProps): React.JSX.Element {
  return (
    <button type="button" className="header-more-item" role="menuitem" onClick={onSelect}>
      <HeaderIcon name={icon} />
      <span>{label}</span>
    </button>
  )
}
