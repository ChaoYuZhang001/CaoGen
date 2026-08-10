export type ProviderBalanceMethod = 'GET' | 'POST'
export type ProviderBalanceCredentialMode = 'provider' | 'none'
export type ProviderBalanceSource = 'builtin' | 'custom'
export type ProviderBalanceStatus = 'ready' | 'expired' | 'unavailable'

export interface ProviderBalanceResponseConfig {
  itemsPath?: string
  labelPath?: string
  label?: string
  unitPath?: string
  unit?: string
  remainingPath?: string
  totalPath?: string
  usedPath?: string
  validPath?: string
  scale?: number
}

/** Non-secret, same-origin balance query configuration. */
export interface ProviderBalanceQueryConfig {
  path: string
  method?: ProviderBalanceMethod
  credentialMode?: ProviderBalanceCredentialMode
  keyLabel?: string
  headers?: Record<string, string>
  query?: Record<string, string>
  body?: Record<string, unknown>
  response: ProviderBalanceResponseConfig
}

export interface ProviderBalanceCapabilityView {
  providerId: string
  supported: boolean
  source?: ProviderBalanceSource
  label?: string
  credentialMode?: ProviderBalanceCredentialMode
  keyLabel?: string
}

export interface ProviderBalanceItemView {
  label?: string
  unit?: string
  remaining?: number
  total?: number
  used?: number
  valid?: boolean
}

export interface ProviderBalanceView {
  providerId: string
  status: ProviderBalanceStatus
  source?: ProviderBalanceSource
  queriedAt: number
  items: ProviderBalanceItemView[]
  errorCode?: string
}
