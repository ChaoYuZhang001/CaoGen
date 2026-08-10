import type { ProviderUsageCostSourceSummary } from './provider-usage-types'

export type ProviderBillingStatementSource = 'provider-api' | 'provider-console' | 'invoice' | 'balance-export' | 'other'

export interface ProviderBillingStatementInput {
  providerId: string
  periodStart: number
  periodEnd: number
  billedCostUsd: number
  source: ProviderBillingStatementSource
}

export interface ProviderBillingStatementView extends ProviderBillingStatementInput {
  schemaVersion: 1
  id: string
  createdAt: number
  updatedAt: number
  digest: string
}

export type ProviderBillingReconciliationStatus = 'matched' | 'mismatch' | 'incomplete'
export type ProviderBillingIncompleteReason =
  | 'no-local-data'
  | 'usage-truncated'
  | 'unpriced-requests'
  | 'non-reported-costs'

export interface ProviderBillingReconciliationView {
  statement: ProviderBillingStatementView
  status: ProviderBillingReconciliationStatus
  comparedAt: number
  localCostUsd: number
  differenceUsd: number
  differencePercent?: number
  toleranceUsd: number
  localRequests: number
  pricedRequests: number
  unpricedRequests: number
  usageTruncated: boolean
  incompleteReasons: ProviderBillingIncompleteReason[]
  costSources: ProviderUsageCostSourceSummary[]
}
