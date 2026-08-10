export type ProviderCredentialRoutingMode = 'manual' | 'preferred' | 'automatic'

export interface ProviderCredentialPolicy {
  /** Lower values are selected first. */
  priority: number
  /** A zero monthly USD budget is unlimited. */
  monthlyBudgetUsd: number
  /** A zero known USD balance reserve is disabled. */
  minimumBalanceUsd: number
  /** Failure cooldown in minutes. */
  failureCooldownMinutes: number
}

export interface ProviderApiKeyInput {
  label?: string
  token: string
  disabled?: boolean
  policy?: Partial<ProviderCredentialPolicy>
}

export interface ProviderApiKeyUpdateInput {
  id: string
  label?: string
  disabled?: boolean
  policy?: Partial<ProviderCredentialPolicy>
}
