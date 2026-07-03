import type { ChatItem, ToolResultInfo } from '../store'
import { formatCost, formatDuration, formatTokens } from '../format'
import ToolCallCard from './ToolCallCard'
import Markdown from './Markdown'

interface Props {
  item: ChatItem
  toolResults: Record<string, ToolResultInfo>
  runningTools: Record<string, true>
}

export default function MessageItem({ item, toolResults, runningTools }: Props): React.JSX.Element | null {
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
                  <Markdown text={block.text} />
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

    case 'notice':
      return <div className={`notice notice-${item.level}`}>{item.text}</div>

    default:
      return null
  }
}
