import { memo, Suspense, lazy } from 'react'
import type { ChatItem, ToolResultInfo } from '../store'
import { useT } from '../i18n'
import { formatCost, formatDuration, formatTokens } from '../format'
import ToolCallCard from './ToolCallCard'
import RewindButton from './RewindButton'

// Markdown 依赖 highlight.js(~700KB),懒加载拆出首屏包;未加载完先按纯文本显示
const Markdown = lazy(() => import('./Markdown'))

interface Props {
  item: ChatItem
  toolResults: Record<string, ToolResultInfo>
  runningTools: Record<string, true>
}

function MessageItem({ item, toolResults, runningTools }: Props): React.JSX.Element | null {
  // useT 直接订阅 store 的语言字段,语言切换时即使 memo 也会触发重渲染
  const t = useT()
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg-user">
          <div className="msg-user-head">
            <div className="msg-user-label">{t('you')}</div>
            {item.checkpointId && <RewindButton messageId={item.checkpointId} />}
          </div>
          <div className="msg-user-text">{item.text}</div>
        </div>
      )

    case 'assistant':
      return (
        <div className="msg-assistant">
          {item.blocks.map((block, i) => {
            if (block.type === 'text') {
              return (
                <div key={i} className="assistant-text">
                  <Suspense fallback={<div className="md-fallback">{block.text}</div>}>
                    <Markdown text={block.text} />
                  </Suspense>
                </div>
              )
            }
            if (block.type === 'thinking') {
              return (
                <details key={i} className="thinking-block">
                  <summary>{t('thinkingProcess')}</summary>
                  <div className="thinking-text">{block.text}</div>
                </details>
              )
            }
            return (
              <ToolCallCard
                key={block.id || i}
                block={block}
                result={toolResults[block.id]}
                running={Boolean(runningTools[block.id])}
              />
            )
          })}
        </div>
      )

    case 'turn-result':
      return (
        <div className={`turn-result ${item.isError ? 'turn-result-error' : ''}`}>
          {item.isError ? (
            <>
              <span className="turn-result-tag">{t('turnErrorTag', { subtype: item.subtype })}</span>
              {item.resultText && <span className="turn-result-text">{item.resultText}</span>}
            </>
          ) : (
            <span className="turn-result-tag">
              {t('turnDone')} · {formatDuration(item.durationMs)}
              {item.usage &&
                ` · ↑${formatTokens(
                  item.usage.input + item.usage.cacheRead + item.usage.cacheCreation
                )} ↓${formatTokens(item.usage.output)}`}
              {item.costUsd !== undefined && ` · ${t('cumulative')} ${formatCost(item.costUsd)}`}
            </span>
          )}
        </div>
      )

    case 'routing':
      return (
        <div className="routing-note" title={t('routingTitle')}>
          <span className="routing-icon">🧭</span>
          <span className="routing-text">{item.reason}</span>
        </div>
      )

    case 'failover':
      return (
        <div className="routing-note failover-note" title={t('failoverTitle')}>
          <span className="routing-icon">⚡</span>
          <span className="routing-text">
            {t('failoverText', {
              from: item.fromName,
              reason: item.reason,
              to: item.model ? `${item.toName} · ${item.model}` : item.toName
            })}
          </span>
        </div>
      )

    case 'notice':
      return <div className={`notice notice-${item.level}`}>{item.text}</div>

    default:
      return null
  }
}

/**
 * memo:流式输出时 streamText 每字更新会重渲染 ChatView,但已成型的消息内容不变。
 * item 引用稳定(来自 items 数组),tool 相关在纯文本流式期间也稳定,故 memo 生效,
 * 避免每个 delta 重跑所有 MessageItem + 重解析 Markdown。
 */
export default memo(MessageItem)
