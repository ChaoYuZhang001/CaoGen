import { memo, Suspense, lazy } from 'react'
import type { ChatItem, ToolResultInfo } from '../store'
import { formatCost, formatDuration, formatTokens } from '../format'
import ToolCallCard from './ToolCallCard'

// Markdown 依赖 highlight.js(~700KB),懒加载拆出首屏包;未加载完先按纯文本显示
const Markdown = lazy(() => import('./Markdown'))

interface Props {
  item: ChatItem
  toolResults: Record<string, ToolResultInfo>
  runningTools: Record<string, true>
}

function MessageItem({ item, toolResults, runningTools }: Props): React.JSX.Element | null {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg-user">
          <div className="msg-user-label">你</div>
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
                  <summary>思考过程</summary>
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
              <span className="turn-result-tag">本轮异常({item.subtype})</span>
              {item.resultText && <span className="turn-result-text">{item.resultText}</span>}
            </>
          ) : (
            <span className="turn-result-tag">
              本轮完成 · {formatDuration(item.durationMs)}
              {item.usage &&
                ` · ↑${formatTokens(
                  item.usage.input + item.usage.cacheRead + item.usage.cacheCreation
                )} ↓${formatTokens(item.usage.output)}`}
              {item.costUsd !== undefined && ` · 累计 ${formatCost(item.costUsd)}`}
            </span>
          )}
        </div>
      )

    case 'routing':
      return (
        <div className="routing-note" title="智能调度决策">
          <span className="routing-icon">🧭</span>
          <span className="routing-text">{item.reason}</span>
        </div>
      )

    case 'failover':
      return (
        <div className="routing-note failover-note" title="厂商故障自动切换">
          <span className="routing-icon">⚡</span>
          <span className="routing-text">
            {item.fromName} 故障({item.reason}),已切换 → {item.toName}
            {item.model ? ` · ${item.model}` : ''},自动重试中
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
