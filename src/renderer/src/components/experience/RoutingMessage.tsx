import type { ChatItem } from '../../store'
import { formatCost } from '../../format'
import { useT } from '../../i18n'
import { useExperienceProjection } from './ExperienceProjection'

type RoutingItem = Extract<ChatItem, { kind: 'routing' }>
type RoutingDecision = NonNullable<RoutingItem['decision']>
type FailoverItem = Extract<ChatItem, { kind: 'failover' }>
type KeyFailoverItem = Extract<ChatItem, { kind: 'provider-key-failover' }>

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

export function RoutingMessage({ item }: { item: RoutingItem }): React.JSX.Element {
  const projection = useExperienceProjection()
  const t = useT()
  if (projection === 'assistant') {
    return <AssistantRouteNotice text={t('assistantRoutingStatus')} kind="route" />
  }
  return <StudioRoutingMessage item={item} />
}

export function FailoverMessage({ item }: { item: FailoverItem }): React.JSX.Element {
  const projection = useExperienceProjection()
  const t = useT()
  if (projection === 'assistant') {
    return <AssistantRouteNotice text={t('assistantFailoverStatus')} kind="failover" />
  }
  return (
    <div className="routing-note failover-note" title={t('failoverTitle')}>
      <span className="routing-icon">!</span>
      <span className="routing-text">
        {t('failoverText', {
          from: item.fromName,
          reason: item.reason,
          to: item.model ? `${item.toName} · ${item.model}` : item.toName
        })}
      </span>
    </div>
  )
}

export function ProviderKeyFailoverMessage({ item }: { item: KeyFailoverItem }): React.JSX.Element {
  const projection = useExperienceProjection()
  const t = useT()
  if (projection === 'assistant') {
    return <AssistantRouteNotice text={t('assistantFailoverStatus')} kind="key-failover" />
  }
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
}

function AssistantRouteNotice({ text, kind }: { text: string; kind: string }): React.JSX.Element {
  return (
    <div className="routing-note assistant-routing-note" data-assistant-routing-status={kind}>
      <span className="routing-icon">*</span>
      <span className="routing-text">{text}</span>
    </div>
  )
}

function StudioRoutingMessage({ item }: { item: RoutingItem }): React.JSX.Element {
  const t = useT()
  const decision = item.decision
  const providerLabel = item.providerName ?? decision?.providerName ?? item.providerId
  return (
    <div
      className="routing-note"
      title={t('routingTitle')}
      data-routing-provider={item.providerId}
      data-routing-model={item.model}
      data-routing-decision={decision ? 'structured' : 'legacy'}
    >
      <span className="routing-icon">*</span>
      <div className="routing-content">
        <RoutingSummary decision={decision} model={item.model} providerLabel={providerLabel} />
        <details className="routing-details">
          <summary>{t('routingDetails')}</summary>
          {decision && <RoutingMetrics decision={decision} item={item} />}
          <RoutingReasons decision={decision} reason={item.reason} />
        </details>
      </div>
    </div>
  )
}

function RoutingSummary({
  decision,
  model,
  providerLabel
}: {
  decision?: RoutingDecision
  model: string
  providerLabel: string
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="routing-summary">
      <strong>{providerLabel}</strong>
      <span aria-hidden="true">→</span>
      <strong>{model}</strong>
      {decision?.switchedProvider && <span className="routing-badge">{t('routingProviderSwitched')}</span>}
      {decision?.manualOverrideApplied && <span className="routing-badge">{t('routingManualOverride')}</span>}
      {decision?.budgetDowngraded && <span className="routing-badge routing-badge-warning">{t('routingBudgetDowngraded')}</span>}
    </div>
  )
}

function RoutingMetrics({ decision, item }: { decision: RoutingDecision; item: RoutingItem }): React.JSX.Element {
  const t = useT()
  const taskLabel = decision.complexity
    ? t(routingComplexityKey(decision.complexity))
    : decision.taskKinds.map((kind) => t(ROUTING_TASK_KEYS[kind] ?? kind)).join(' + ')
  return (
    <div className="routing-metrics">
      <span>{t('routingStrategy')}</span><strong>{t(routingStrategyKey(decision.strategy))}</strong>
      <span>{t('routingTasks')}</span><strong>{taskLabel || '-'}</strong>
      <span>{t('routingRisk')}</span><strong>{t(routingRiskKey(decision.riskLevel))}</strong>
      <span>{t('routingCandidates')}</span><strong>{decision.candidateCount}</strong>
      {decision.estimatedCostUsd !== undefined && <><span>{t('routingEstimate')}</span><strong>{formatCost(decision.estimatedCostUsd)}</strong></>}
      {decision.reliability !== undefined && <><span>{t('routingReliability')}</span><strong>{Math.round(decision.reliability * 100)}%</strong></>}
      {decision.latencyEmaMs !== undefined && <><span>{t('routingLatency')}</span><strong>{Math.round(decision.latencyEmaMs)}ms</strong></>}
      {decision.remainingBudgetUsd !== undefined && <><span>{t('routingRemainingBudget')}</span><strong>{formatCost(decision.remainingBudgetUsd)}</strong></>}
      {item.crossValidationPlan?.enabled && <><span>{t('routingReviewModels')}</span><strong>{item.crossValidationPlan.validators.length}</strong></>}
    </div>
  )
}

function RoutingReasons({ decision, reason }: { decision?: RoutingDecision; reason: string }): React.JSX.Element {
  const t = useT()
  return (
    <>
      <div className="routing-reason">{reason}</div>
      {decision?.selectedReasons && decision.selectedReasons.length > 0 && (
        <div className="routing-reason-list">{decision.selectedReasons.map((item) => <span key={item}>{item}</span>)}</div>
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
        <div className="routing-warnings">{decision.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>
      )}
    </>
  )
}

function routingStrategyKey(strategy: RoutingDecision['strategy']): string {
  if (strategy === 'quality') return 'routingStrategyQuality'
  if (strategy === 'cost') return 'routingStrategyCost'
  if (strategy === 'speed') return 'routingStrategySpeed'
  return 'routingStrategyBalanced'
}

function routingRiskKey(risk: RoutingDecision['riskLevel']): string {
  if (risk === 'high') return 'routingRiskHigh'
  if (risk === 'medium') return 'routingRiskMedium'
  return 'routingRiskLow'
}

function routingComplexityKey(complexity: NonNullable<RoutingDecision['complexity']>): string {
  if (complexity === 'complex') return 'routingComplexityComplex'
  if (complexity === 'medium') return 'routingComplexityMedium'
  return 'routingComplexitySimple'
}
