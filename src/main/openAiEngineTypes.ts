import type { OpenAIProtocol, ResponsesConversationContext } from '../shared/types'

export type ChatContent = string | Array<Record<string, unknown>>

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: ChatContent | null
  tool_calls?: Array<Record<string, unknown>>
  tool_call_id?: string
}

export interface PendingToolCall {
  id: string
  name: string
  argsText: string
}

export interface TurnToolFailure {
  toolName: string
  toolUseId: string
  detail: string
}

export interface OpenAIErrorContext {
  providerId: string
  providerName: string
  baseUrl: string
  model: string
  protocol: OpenAIProtocol
}

export function isResponsesConversationContext(value: unknown): value is ResponsesConversationContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (!isNonEmptyString(record.responseId)) return false
  if (!isNonEmptyString(record.providerId)) return false
  if (!isNonEmptyString(record.model)) return false
  if (record.protocol !== 'responses') return false
  if (record.keyId !== undefined && typeof record.keyId !== 'string') return false
  if (!isPositiveInteger(record.generation)) return false
  return typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim())
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

export function formatProviderErrorContext(context: OpenAIErrorContext): string {
  return `Provider: ${context.providerName} (${context.providerId}); baseUrl: ${context.baseUrl}; model: ${context.model}; protocol: ${context.protocol}`
}
