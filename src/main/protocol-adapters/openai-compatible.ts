import type { UsageTotals } from '../../shared/types'
import { defineNativeProtocolAdapter, nonNegativeNumber, optionalText, parseToolInput, protocolError, requiredRecord, requiredText } from './shared'
import type { ProtocolStreamSignal, ProtocolToolCall } from './types'

export const OPENAI_COMPATIBLE_PROTOCOL_ADAPTER = defineNativeProtocolAdapter({
  id: 'openai.compatible.v1',
  engineKind: 'openai',
  protocol: 'openai.compatible',
  decodeStreamChunk: decodeOpenAIStreamChunk,
  normalizeToolCall: normalizeOpenAIToolCall,
  normalizeUsage: normalizeOpenAIUsage,
  normalizeError: normalizeOpenAIError
})

function decodeOpenAIStreamChunk(value: unknown): ProtocolStreamSignal[] {
  const record = requiredRecord(value, 'OpenAI stream chunk')
  if (typeof record.type === 'string' && record.type.startsWith('response.')) {
    return decodeResponsesEvent(record)
  }
  const signals = decodeChatEvent(record)
  if (record.error) signals.push({ kind: 'error', error: normalizeOpenAIError(record.error) })
  return signals
}

function decodeResponsesEvent(record: Record<string, unknown>): ProtocolStreamSignal[] {
  if (record.type === 'response.output_text.delta') {
    return [{ kind: 'text', text: optionalText(record.delta) ?? '' }]
  }
  if (record.type === 'response.reasoning_summary_text.delta') {
    return [{ kind: 'thinking', text: optionalText(record.delta) ?? '' }]
  }
  if (record.type === 'response.output_item.added') {
    const item = requiredRecord(record.item, 'OpenAI response item')
    return item.type === 'function_call' ? [{ kind: 'tool', tool: normalizeOpenAIToolCall(item) }] : []
  }
  if (record.type === 'response.completed') {
    const response = requiredRecord(record.response, 'OpenAI completed response')
    const usage = normalizeOpenAIUsage(response.usage)
    return usage ? [{ kind: 'usage', usage }, { kind: 'done' }] : [{ kind: 'done' }]
  }
  if (record.type === 'response.failed' || record.type === 'error') {
    return [{ kind: 'error', error: normalizeOpenAIError(record) }]
  }
  return []
}

function decodeChatEvent(record: Record<string, unknown>): ProtocolStreamSignal[] {
  const signals: ProtocolStreamSignal[] = []
  const choices = Array.isArray(record.choices) ? record.choices : []
  for (const rawChoice of choices) {
    const choice = requiredRecord(rawChoice, 'OpenAI chat choice')
    const delta = requiredRecord(choice.delta ?? {}, 'OpenAI chat delta')
    if (typeof delta.content === 'string') signals.push({ kind: 'text', text: delta.content })
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        signals.push({ kind: 'tool', tool: normalizeOpenAIToolCall(call) })
      }
    }
    if (typeof choice.finish_reason === 'string') {
      signals.push({ kind: 'done', stopReason: choice.finish_reason })
    }
  }
  const usage = normalizeOpenAIUsage(record.usage)
  if (usage) signals.push({ kind: 'usage', usage })
  return signals
}

function normalizeOpenAIToolCall(value: unknown): ProtocolToolCall {
  const call = requiredRecord(value, 'OpenAI tool call')
  const fn = call.function && typeof call.function === 'object'
    ? requiredRecord(call.function, 'OpenAI tool function')
    : call
  return {
    id: requiredText(call.call_id ?? call.id, 'OpenAI tool call id'),
    name: requiredText(call.name ?? fn.name, 'OpenAI tool call name'),
    input: parseToolInput(call.arguments ?? fn.arguments ?? call.input, 'OpenAI tool arguments')
  }
}

function normalizeOpenAIUsage(value: unknown): UsageTotals | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const usage = value as Record<string, unknown>
  const inputDetails = usage.input_tokens_details && typeof usage.input_tokens_details === 'object'
    ? usage.input_tokens_details as Record<string, unknown>
    : usage.prompt_tokens_details as Record<string, unknown> | undefined
  return {
    input: nonNegativeNumber(usage.input ?? usage.input_tokens ?? usage.prompt_tokens),
    output: nonNegativeNumber(usage.output ?? usage.output_tokens ?? usage.completion_tokens),
    cacheRead: nonNegativeNumber(usage.cacheRead ?? inputDetails?.cached_tokens),
    cacheCreation: nonNegativeNumber(usage.cacheCreation)
  }
}

function normalizeOpenAIError(value: unknown) {
  if (value instanceof Error) return protocolError(value.name, value.message)
  if (typeof value === 'string') return protocolError('openai_error', value)
  const outer = requiredRecord(value, 'OpenAI error')
  const inner = outer.error && typeof outer.error === 'object'
    ? requiredRecord(outer.error, 'OpenAI nested error')
    : outer
  const status = typeof outer.status === 'number' ? outer.status
    : typeof inner.status === 'number' ? inner.status : undefined
  return protocolError(
    optionalText(inner.code) ?? optionalText(inner.type) ?? 'openai_error',
    optionalText(inner.message) ?? optionalText(outer.message) ?? 'OpenAI-compatible error',
    status
  )
}
