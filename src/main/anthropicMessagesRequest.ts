import type {
  AnthropicMessagesPromptCachingConfig,
  AnthropicMessagesRequest,
  AnthropicMessagesThinkingConfig
} from './anthropicMessagesAdapter'
import type { ProviderRuntimeConfig } from '../shared/types'
import { mergeProviderRequestBody } from './provider/providerRequestOverrides'

export function applyAnthropicRuntimeToRequest(
  request: AnthropicMessagesRequest,
  runtime: ProviderRuntimeConfig | undefined
): AnthropicMessagesRequest {
  const anthropic = runtime?.anthropic
  return {
    ...request,
    maxTokens: runtime?.maxOutputTokens ?? request.maxTokens,
    temperature: runtime?.temperature,
    topP: runtime?.topP,
    topK: anthropic?.topK,
    thinking: anthropic?.thinking,
    promptCaching: anthropic?.promptCaching
  }
}

export function anthropicRuntimeRequiresThinkingSignature(
  runtime: ProviderRuntimeConfig | undefined
): boolean {
  const mode = runtime?.anthropic?.thinking?.mode
  return mode === 'enabled' || mode === 'adaptive'
}

/** Build the exact JSON body sent to the Anthropic Messages endpoint. */
export function buildAnthropicMessagesWireBody(
  request: AnthropicMessagesRequest
): Record<string, unknown> {
  const maxTokens = positiveInteger(request.maxTokens, 8192)
  const body = mergeProviderRequestBody({
    model: request.model,
    max_tokens: maxTokens,
    messages: cloneValue(request.messages),
    stream: true,
    ...(request.tools ? { tools: cloneValue(request.tools) } : {}),
    ...(request.system?.trim() ? { system: request.system.trim() } : {}),
    ...(request.temperature !== undefined
      ? { temperature: numberInRange(request.temperature, 0, 1, 'Anthropic temperature') }
      : {}),
    ...(request.topP !== undefined
      ? { top_p: numberInRange(request.topP, 0, 1, 'Anthropic top P') }
      : {}),
    ...(request.topK !== undefined
      ? { top_k: integerInRange(request.topK, 1, 1_000_000, 'Anthropic top K') }
      : {})
  }, request.extraBody)
  if (request.thinking) body.thinking = thinkingWireConfig(request.thinking, maxTokens)
  return applyPromptCaching(body, request.promptCaching)
}

function thinkingWireConfig(
  config: AnthropicMessagesThinkingConfig,
  maxTokens: number
): Record<string, unknown> {
  if (config.mode === 'disabled') {
    if (config.budgetTokens !== undefined || config.display !== undefined) {
      throw new Error('Anthropic disabled thinking cannot configure budget or display')
    }
    return { type: 'disabled' }
  }
  if (config.mode === 'adaptive') {
    if (config.budgetTokens !== undefined) {
      throw new Error('Anthropic adaptive thinking cannot configure a token budget')
    }
    return { type: 'adaptive', ...(config.display ? { display: config.display } : {}) }
  }
  if (config.mode !== 'enabled') throw new Error('Anthropic thinking mode is invalid')
  const budgetTokens = integerInRange(
    config.budgetTokens,
    1_024,
    1_000_000,
    'Anthropic thinking budget'
  )
  if (budgetTokens >= maxTokens) {
    throw new Error('Anthropic thinking budget must be less than max_tokens')
  }
  return {
    type: 'enabled',
    budget_tokens: budgetTokens,
    ...(config.display ? { display: config.display } : {})
  }
}

function applyPromptCaching(
  body: Record<string, unknown>,
  config: AnthropicMessagesPromptCachingConfig | undefined
): Record<string, unknown> {
  if (!config?.enabled) return body
  const cacheControl = { type: 'ephemeral', ...(config.ttl ? { ttl: config.ttl } : {}) }
  const strategy = config.strategy ?? 'automatic'
  delete body.cache_control
  if (strategy === 'automatic') {
    body.cache_control = cacheControl
    return body
  }
  if (strategy === 'system') {
    body.system = markSystemCacheBreakpoint(body.system, cacheControl)
    return body
  }
  if (strategy === 'tools') {
    body.tools = markLastArrayBlock(body.tools, cacheControl, 'Anthropic tools')
    return body
  }
  if (strategy === 'last-user') {
    body.messages = markLastUserCacheBreakpoint(body.messages, cacheControl)
    return body
  }
  throw new Error('Anthropic prompt cache strategy is invalid')
}

function markSystemCacheBreakpoint(system: unknown, cacheControl: Record<string, unknown>): unknown {
  if (typeof system === 'string' && system.trim()) {
    return [{ type: 'text', text: system, cache_control: cacheControl }]
  }
  return markLastArrayBlock(system, cacheControl, 'Anthropic system prompt')
}

function markLastArrayBlock(
  value: unknown,
  cacheControl: Record<string, unknown>,
  label: string
): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} has no cacheable block`)
  }
  const blocks = cloneValue(value)
  const index = blocks.length - 1
  if (!isRecord(blocks[index])) throw new Error(`${label} cache target is invalid`)
  blocks[index] = { ...blocks[index], cache_control: cacheControl }
  return blocks
}

function markLastUserCacheBreakpoint(
  value: unknown,
  cacheControl: Record<string, unknown>
): unknown[] {
  if (!Array.isArray(value)) throw new Error('Anthropic messages are invalid')
  const messages = cloneValue(value)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = isRecord(messages[index]) ? messages[index] : undefined
    if (!message || message.role !== 'user') continue
    if (typeof message.content === 'string') {
      messages[index] = {
        ...message,
        content: [{ type: 'text', text: message.content, cache_control: cacheControl }]
      }
      return messages
    }
    messages[index] = {
      ...message,
      content: markLastArrayBlock(message.content, cacheControl, 'Anthropic last user message')
    }
    return messages
  }
  throw new Error('Anthropic messages have no user cache target')
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function integerInRange(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} is invalid`)
  }
  return value as number
}

function numberInRange(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneValue) as T
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)])) as T
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
