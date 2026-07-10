import { memo, Suspense, lazy } from 'react'
import type { ChatItem, ToolResultInfo } from '../store'
import { useT } from '../i18n'
import { formatCost, formatDuration, formatTokens } from '../format'
import ToolCallCard from './ToolCallCard'
import RewindButton from './RewindButton'

// Markdown 依赖 highlight.js(~700KB),懒加载拆出首屏包;未加载完先按纯文本显示
const Markdown = lazy(() => import('./Markdown'))

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const ROUTING_TASK_KEYS: Record<string, string> = {
  chat: 'routingTaskChat',
  coding: 'routingTaskCoding',
  reasoning: 'routingTaskReasoning',
  vision: 'routingTaskVision',
  toolUse: 'routingTaskToolUse',
  longContext: 'routingTaskLongContext',
  review: 'routingTaskReview',
  summarization: 'routingTaskSummarization'
}

function routingStrategyKey(strategy: 'quality' | 'cost' | 'speed' | 'balanced'): string {
  if (strategy === 'quality') return 'routingStrategyQuality'
  if (strategy === 'cost') return 'routingStrategyCost'
  if (strategy === 'speed') return 'routingStrategySpeed'
  return 'routingStrategyBalanced'
}

function routingRiskKey(risk: 'low' | 'medium' | 'high'): string {
  if (risk === 'high') return 'routingRiskHigh'
  if (risk === 'medium') return 'routingRiskMedium'
  return 'routingRiskLow'
}

function routingComplexityKey(complexity: 'simple' | 'medium' | 'complex'): string {
  if (complexity === 'complex') return 'routingComplexityComplex'
  if (complexity === 'medium') return 'routingComplexityMedium'
  return 'routingComplexitySimple'
}

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
          {/* 右对齐气泡本身已表明是用户消息,不再冗余标注"你";头部仅在有回溯按钮时渲染 */}
          {item.checkpointId && (
            <div className="msg-user-head">
              <RewindButton messageId={item.checkpointId} sourceText={item.text} />
            </div>
          )}
          {item.text && <div className="msg-user-text">{item.text}</div>}
          {item.attachments && item.attachments.length > 0 && (
            <div className="msg-user-attachments">
              {item.attachments.map((attachment, index) => (
                <div key={`${attachment.id}-${index}`} className="msg-user-attachment">
                  <span>{attachment.mime.replace('image/', '').toUpperCase()}</span>
                  <span>{formatBytes(attachment.bytes)}</span>
                </div>
              ))}
            </div>
          )}
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
              {/* subtype 为 success/空时不显示——"本轮异常(success)"是自相矛盾的 */}
              <span className="turn-result-tag">
                {item.subtype && item.subtype !== 'success'
                  ? t('turnErrorTag', { subtype: item.subtype })
                  : t('turnErrorPlain')}
              </span>
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

    case 'routing': {
      const decision = item.decision
      const providerLabel = item.providerName ?? decision?.providerName ?? item.providerId
      const taskLabel = decision?.complexity
        ? t(routingComplexityKey(decision.complexity))
        : decision?.taskKinds.map((kind) => t(ROUTING_TASK_KEYS[kind] ?? kind)).join(' + ')
      return (
        <div
          className="routing-note"
          title={t('routingTitle')}
          data-routing-provider={item.providerId}
          data-routing-model={item.model}
          data-routing-decision={decision ? 'structured' : 'legacy'}
        >
          <span className="routing-icon">🧭</span>
          <div className="routing-content">
            <div className="routing-summary">
              <strong>{providerLabel}</strong>
              <span aria-hidden="true">→</span>
              <strong>{item.model}</strong>
              {decision?.switchedProvider && <span className="routing-badge">{t('routingProviderSwitched')}</span>}
              {decision?.manualOverrideApplied && <span className="routing-badge">{t('routingManualOverride')}</span>}
              {decision?.budgetDowngraded && <span className="routing-badge routing-badge-warning">{t('routingBudgetDowngraded')}</span>}
            </div>
            <details className="routing-details">
              <summary>{t('routingDetails')}</summary>
              {decision && (
                <div className="routing-metrics">
                  <span>{t('routingStrategy')}</span>
                  <strong>{t(routingStrategyKey(decision.strategy))}</strong>
                  <span>{t('routingTasks')}</span>
                  <strong>{taskLabel || '-'}</strong>
                  <span>{t('routingRisk')}</span>
                  <strong>{t(routingRiskKey(decision.riskLevel))}</strong>
                  <span>{t('routingCandidates')}</span>
                  <strong>{decision.candidateCount}</strong>
                  {decision.estimatedCostUsd !== undefined && (
                    <>
                      <span>{t('routingEstimate')}</span>
                      <strong>{formatCost(decision.estimatedCostUsd)}</strong>
                    </>
                  )}
                  {decision.reliability !== undefined && (
                    <>
                      <span>{t('routingReliability')}</span>
                      <strong>{Math.round(decision.reliability * 100)}%</strong>
                    </>
                  )}
                  {decision.latencyEmaMs !== undefined && (
                    <>
                      <span>{t('routingLatency')}</span>
                      <strong>{Math.round(decision.latencyEmaMs)}ms</strong>
                    </>
                  )}
                  {decision.remainingBudgetUsd !== undefined && (
                    <>
                      <span>{t('routingRemainingBudget')}</span>
                      <strong>{formatCost(decision.remainingBudgetUsd)}</strong>
                    </>
                  )}
                  {item.crossValidationPlan?.enabled && (
                    <>
                      <span>{t('routingReviewModels')}</span>
                      <strong>{item.crossValidationPlan.validators.length}</strong>
                    </>
                  )}
                </div>
              )}
              <div className="routing-reason">{item.reason}</div>
              {decision?.selectedReasons && decision.selectedReasons.length > 0 && (
                <div className="routing-reason-list">
                  {decision.selectedReasons.map((reason) => (
                    <span key={reason}>{reason}</span>
                  ))}
                </div>
              )}
              {decision?.alternatives && decision.alternatives.length > 0 && (
                <div className="routing-alternatives">
                  <span>{t('routingAlternatives')}</span>
                  {decision.alternatives.map((alternative) => (
                    <strong key={`${alternative.providerId}:${alternative.model}`}>
                      {alternative.providerName ?? alternative.providerId} / {alternative.model} · {formatCost(alternative.estimatedCostUsd)}
                    </strong>
                  ))}
                </div>
              )}
              {decision?.warnings && decision.warnings.length > 0 && (
                <div className="routing-warnings">
                  {decision.warnings.map((warning) => (
                    <span key={warning}>{warning}</span>
                  ))}
                </div>
              )}
            </details>
          </div>
        </div>
      )
    }

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

    case 'provider-key-failover':
      return (
        <div className="routing-note failover-note key-failover-note" title={t('keyFailoverTitle')}>
          <span className="routing-icon">K</span>
          <span className="routing-text">
            {t('keyFailoverText', {
              provider: item.providerName,
              from: item.fromKeyLabel,
              reason: item.reason,
              to: item.toKeyLabel
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
