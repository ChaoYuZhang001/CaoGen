import { useEffect, useRef } from 'react'
import { MODEL_OPTIONS, PERMISSION_OPTIONS, useStore } from '../store'
import { useT } from '../i18n'
import { formatCost, formatTokens } from '../format'
import MessageItem from './MessageItem'
import PermissionBar from './PermissionBar'
import Composer from './Composer'
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

  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  const itemCount = session?.items.length ?? 0
  const streamLen = (session?.streamText.length ?? 0) + (session?.streamThinking.length ?? 0)

  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [itemCount, streamLen, activeId])

  if (!session || !activeId) return null
  const { meta } = session
  const running = meta.status === 'running' || meta.status === 'starting'
  const modelKnown = MODEL_OPTIONS.some((o) => o.value === meta.model)
  const providerName = meta.providerId
    ? providers.find((p) => p.id === meta.providerId)?.name ?? t('unknownProvider')
    : t('providerOfficial')

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
          <button
            className="btn btn-ghost"
            title={t('closeSession')}
            onClick={() => void closeSession(activeId)}
          >
            ✕
          </button>
        </div>
      </header>

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-inner">
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
      <Composer running={running} />

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
