export type ProviderBillingQueryMethod = 'GET' | 'POST'
export type ProviderBillingCredentialMode = 'provider' | 'none'
export type ProviderBillingPeriodTarget = 'query' | 'body'
export type ProviderBillingPeriodFormat = 'unix-seconds' | 'unix-ms' | 'iso'

export type ProviderBillingPeriodParameter =
  | { target: 'query'; name: string; format: ProviderBillingPeriodFormat }
  | { target: 'body'; path: string; format: ProviderBillingPeriodFormat }

export interface ProviderBillingQueryResponseConfig {
  itemsPath?: string
  amountPath: string
  currencyPath?: string
  currency?: 'USD'
  scale?: number
}

/** Non-secret, same-origin official billing query configuration. */
export interface ProviderBillingQueryConfig {
  path: string
  method?: ProviderBillingQueryMethod
  credentialMode?: ProviderBillingCredentialMode
  keyLabel?: string
  headers?: Record<string, string>
  query?: Record<string, string>
  body?: Record<string, unknown>
  periodStart: ProviderBillingPeriodParameter
  periodEnd: ProviderBillingPeriodParameter
  response: ProviderBillingQueryResponseConfig
}

export interface ProviderBillingQueryCapabilityView {
  providerId: string
  supported: boolean
  credentialMode?: ProviderBillingCredentialMode
  keyLabel?: string
}

export interface ProviderBillingSyncInput {
  providerId: string
  periodStart: number
  periodEnd: number
}

export type ProviderBillingSyncStatus = 'ready' | 'expired' | 'unavailable'

export interface ProviderBillingSyncResult {
  providerId: string
  status: ProviderBillingSyncStatus
  queriedAt: number
  statement?: import('./provider-billing-types').ProviderBillingStatementView
  errorCode?: string
}
