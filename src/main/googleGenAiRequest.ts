import type { AnthropicMessagesRequest } from './anthropicMessagesAdapter'
import type { ProviderRuntimeConfig } from '../shared/types'

export function applyGoogleRuntimeToRequest(
  request: AnthropicMessagesRequest,
  runtime: ProviderRuntimeConfig | undefined
): AnthropicMessagesRequest {
  const gemini = runtime?.gemini
  const thinking = gemini?.thinking
  const thinkingConfig = thinking
    ? compact({
        includeThoughts: thinking.includeThoughts,
        thinkingBudget: thinking.budgetTokens,
        thinkingLevel: thinking.level?.toUpperCase()
      })
    : undefined
  const generationConfig = compact({
    ...(record(request.extraBody?.generationConfig) ?? {}),
    ...(thinkingConfig && Object.keys(thinkingConfig).length > 0 ? { thinkingConfig } : {})
  })
  return {
    ...request,
    maxTokens: runtime?.maxOutputTokens ?? request.maxTokens,
    temperature: runtime?.temperature,
    topP: runtime?.topP,
    topK: gemini?.topK,
    extraBody: {
      ...(request.extraBody ?? {}),
      ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {})
    }
  }
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined))
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
