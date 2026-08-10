export type ProviderGeminiThinkingLevel = 'minimal' | 'low' | 'medium' | 'high'

export interface ProviderGeminiRuntimeConfig {
  topK?: number
  thinking?: {
    includeThoughts?: boolean
    /** -1 lets the model choose dynamically; 0 disables thinking where supported. */
    budgetTokens?: number
    level?: ProviderGeminiThinkingLevel
  }
}
