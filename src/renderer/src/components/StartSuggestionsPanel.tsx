export type StartSuggestionPriority = 'high' | 'medium' | 'low'

export interface StartSuggestionPanelItem {
  id: string
  title: string
  body: string
  source: string
  priority: StartSuggestionPriority
  prompt: string
}

export interface StartSuggestionsPanelLabels {
  title: string
  subtitle: string
  reason: string
  promptPreview: string
  sendToAgent: string
  later: string
  ignore: string
  overflow: (count: number) => string
}

export interface StartSuggestionsPanelProps {
  suggestions: StartSuggestionPanelItem[]
  onSendToAgent: (suggestion: StartSuggestionPanelItem) => void
  onLater: (suggestion: StartSuggestionPanelItem) => void
  onIgnore: (suggestion: StartSuggestionPanelItem) => void
  className?: string
  compact?: boolean
  disabled?: boolean
  maxVisible?: number
  labels?: Partial<StartSuggestionsPanelLabels>
}

const DEFAULT_LABELS: StartSuggestionsPanelLabels = {
  title: '开工建议',
  subtitle: '基于当前项目状态，先挑一个能直接推进的动作。',
  reason: '理由',
  promptPreview: '将发送',
  sendToAgent: '发送给 Agent',
  later: '稍后',
  ignore: '忽略',
  overflow: (count) => `还有 ${count} 条建议未显示`
}

const PRIORITY_LABELS: Record<StartSuggestionPriority, string> = {
  high: '高',
  medium: '中',
  low: '低'
}

export default function StartSuggestionsPanel({
  suggestions,
  onSendToAgent,
  onLater,
  onIgnore,
  className,
  compact = false,
  disabled = false,
  maxVisible,
  labels
}: StartSuggestionsPanelProps): React.JSX.Element | null {
  const mergedLabels = { ...DEFAULT_LABELS, ...labels }
  const visibleSuggestions =
    typeof maxVisible === 'number' && maxVisible >= 0 ? suggestions.slice(0, maxVisible) : suggestions
  const hiddenCount = Math.max(0, suggestions.length - visibleSuggestions.length)

  if (visibleSuggestions.length === 0) return null

  const rootClassName = [
    'start-suggestions-panel',
    compact ? 'start-suggestions-panel-compact' : '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <section className={rootClassName} aria-label={mergedLabels.title}>
      <header className="start-suggestions-header">
        <div className="start-suggestions-heading">
          <h2 className="start-suggestions-title">{mergedLabels.title}</h2>
          <p className="start-suggestions-subtitle">{mergedLabels.subtitle}</p>
        </div>
        <div className="start-suggestions-count">{visibleSuggestions.length}</div>
      </header>

      <div className="start-suggestions-list">
        {visibleSuggestions.map((suggestion) => (
          <article
            key={suggestion.id}
            className="start-suggestions-item"
            data-priority={suggestion.priority}
          >
            <div className="start-suggestions-item-head">
              <div className="start-suggestions-item-title" title={suggestion.title}>
                {suggestion.title}
              </div>
              <div className="start-suggestions-meta">
                <span className="start-suggestions-priority">
                  {PRIORITY_LABELS[suggestion.priority]}
                </span>
                <span className="start-suggestions-source" title={suggestion.source}>
                  {suggestion.source}
                </span>
              </div>
            </div>

            <p className="start-suggestions-reason">
              <span>{mergedLabels.reason}</span>
              {suggestion.body}
            </p>

            <div className="start-suggestions-prompt" title={suggestion.prompt}>
              <span>{mergedLabels.promptPreview}</span>
              {suggestion.prompt}
            </div>

            <div className="start-suggestions-actions">
              <button
                type="button"
                className="start-suggestions-button start-suggestions-button-primary"
                disabled={disabled}
                aria-label={`${mergedLabels.sendToAgent}: ${suggestion.title}`}
                onClick={() => onSendToAgent(suggestion)}
              >
                {mergedLabels.sendToAgent}
              </button>
              <button
                type="button"
                className="start-suggestions-button"
                disabled={disabled}
                aria-label={`${mergedLabels.later}: ${suggestion.title}`}
                onClick={() => onLater(suggestion)}
              >
                {mergedLabels.later}
              </button>
              <button
                type="button"
                className="start-suggestions-button start-suggestions-button-quiet"
                disabled={disabled}
                aria-label={`${mergedLabels.ignore}: ${suggestion.title}`}
                onClick={() => onIgnore(suggestion)}
              >
                {mergedLabels.ignore}
              </button>
            </div>
          </article>
        ))}
      </div>

      {hiddenCount > 0 && <div className="start-suggestions-overflow">{mergedLabels.overflow(hiddenCount)}</div>}
    </section>
  )
}
