export type ProviderAnthropicThinkingMode = 'disabled' | 'adaptive' | 'enabled'
export type ProviderAnthropicThinkingDisplay = 'summarized' | 'omitted'
export type ProviderAnthropicPromptCacheTtl = '5m' | '1h'
export type ProviderAnthropicPromptCacheStrategy = 'automatic' | 'system' | 'tools' | 'last-user'

export interface ProviderAnthropicRuntimeConfig {
  thinking?: {
    mode: ProviderAnthropicThinkingMode
    budgetTokens?: number
    display?: ProviderAnthropicThinkingDisplay
  }
  promptCaching?: {
    enabled: boolean
    ttl?: ProviderAnthropicPromptCacheTtl
    strategy?: ProviderAnthropicPromptCacheStrategy
  }
  /** Deprecated by Anthropic for models released after Claude Opus 4.6. */
  topK?: number
}
