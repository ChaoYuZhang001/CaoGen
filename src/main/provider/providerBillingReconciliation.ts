import type { ProviderBillingIncompleteReason, ProviderBillingReconciliationView, ProviderBillingStatementView } from '../../shared/provider-billing-types'
import type { ProviderUsageSummary } from '../../shared/provider-usage-types'

export function reconcileProviderBillingStatement(
  statement: ProviderBillingStatementView,
  usage: ProviderUsageSummary,
  comparedAt = Date.now()
): ProviderBillingReconciliationView {
  const differenceUsd = round(statement.billedCostUsd - usage.costUsd)
  const toleranceUsd = round(Math.max(0.01, statement.billedCostUsd * 0.005))
  const incompleteReasons: ProviderBillingIncompleteReason[] = []
  if (usage.requests === 0) incompleteReasons.push('no-local-data')
  if (usage.truncated) incompleteReasons.push('usage-truncated')
  if (usage.unpricedRequests > 0) incompleteReasons.push('unpriced-requests')
  const reportedRequests = usage.costSources
    .filter((source) => source.source === 'reported')
    .reduce((total, source) => total + source.requests, 0)
  if (usage.requests > 0 && reportedRequests !== usage.requests) incompleteReasons.push('non-reported-costs')

  return {
    statement,
    status: incompleteReasons.length > 0
      ? 'incomplete'
      : Math.abs(differenceUsd) <= toleranceUsd ? 'matched' : 'mismatch',
    comparedAt,
    localCostUsd: usage.costUsd,
    differenceUsd,
    ...(statement.billedCostUsd > 0
      ? { differencePercent: round(differenceUsd / statement.billedCostUsd * 100) }
      : {}),
    toleranceUsd,
    localRequests: usage.requests,
    pricedRequests: usage.pricedRequests,
    unpricedRequests: usage.unpricedRequests,
    usageTruncated: usage.truncated,
    incompleteReasons,
    costSources: usage.costSources.map((source) => ({ ...source }))
  }
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
