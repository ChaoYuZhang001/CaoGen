import type { UsageTotals } from '../../shared/types'
import {
  defineNativeProtocolAdapter,
  nonNegativeNumber,
  optionalText,
  parseToolInput,
  protocolError,
  requiredRecord,
  requiredText
} from './shared'
import type { ProtocolStreamSignal, ProtocolToolCall } from './types'

export const ANTHROPIC_MESSAGES_PROTOCOL_ADAPTER = defineNativeProtocolAdapter({
  id: 'anthropic.messages.v1',
  engineKind: 'anthropic',
  protocol: 'anthropic.messages',
  decodeStreamChunk: decodeAnthropicStreamChunk,
  normalizeToolCall: normalizeAnthropicToolCall,
  normalizeUsage: normalizeAnthropicUsage,
  normalizeError: normalizeAnthropicError
})

function decodeAnthropicStreamChunk(value: unknown): ProtocolStreamSignal[] {
  const event = requiredRecord(value, 'Anthropic stream event')
  if (event.type === 'message_start') return usageSignals(requiredRecord(event.message, 'Anthropic message'))
  if (event.type === 'content_block_start') return decodeContentBlock(event.content_block)
  if (event.type === 'content_block_delta') return decodeContentDelta(event.delta)
  if (event.type === 'message_delta') return decodeMessageDelta(event)
  if (event.type === 'message_stop' || event.type === 'ping' || event.type === 'content_block_stop') return []
  if (event.type === 'message') return decodeCompletedMessage(event)
  if (event.type === 'error') return [{ kind: 'error', error: normalizeAnthropicError(event) }]
  return []
}

function decodeContentBlock(value: unknown): ProtocolStreamSignal[] {
  const block = requiredRecord(value, 'Anthropic content block')
  if (block.type === 'text') return textSignal('text', block.text)
  if (block.type === 'thinking') return textSignal('thinking', block.thinking)
  if (block.type !== 'tool_use') return []
  const input = parseToolInput(block.input, 'Anthropic tool input')
  return Object.keys(input).length > 0
    ? [{ kind: 'tool', tool: normalizeAnthropicToolCall(block) }]
    : []
}

function decodeContentDelta(value: unknown): ProtocolStreamSignal[] {
  const delta = requiredRecord(value, 'Anthropic content delta')
  if (delta.type === 'text_delta') return textSignal('text', delta.text)
  if (delta.type === 'thinking_delta') return textSignal('thinking', delta.thinking)
  return []
}

function decodeMessageDelta(event: Record<string, unknown>): ProtocolStreamSignal[] {
  const signals = usageSignals(event)
  const delta = requiredRecord(event.delta, 'Anthropic message delta')
  signals.push({ kind: 'done', stopReason: optionalText(delta.stop_reason) })
  return signals
}

function decodeCompletedMessage(message: Record<string, unknown>): ProtocolStreamSignal[] {
  const signals: ProtocolStreamSignal[] = []
  const content = Array.isArray(message.content) ? message.content : []
  for (const block of content) signals.push(...decodeCompletedBlock(block))
  signals.push(...usageSignals(message))
  signals.push({ kind: 'done', stopReason: optionalText(message.stop_reason) })
  return signals
}

function decodeCompletedBlock(value: unknown): ProtocolStreamSignal[] {
  const block = requiredRecord(value, 'Anthropic response content block')
  if (block.type === 'tool_use') {
    return [{ kind: 'tool', tool: normalizeAnthropicToolCall(block) }]
  }
  return decodeContentBlock(block)
}

function textSignal(kind: 'text' | 'thinking', value: unknown): ProtocolStreamSignal[] {
  return typeof value === 'string' ? [{ kind, text: value }] : []
}

function usageSignals(value: unknown): ProtocolStreamSignal[] {
  const record = requiredRecord(value, 'Anthropic usage envelope')
  const usage = normalizeAnthropicUsage(record.usage)
  return usage ? [{ kind: 'usage', usage }] : []
}

function normalizeAnthropicToolCall(value: unknown): ProtocolToolCall {
  const call = requiredRecord(value, 'Anthropic tool call')
  return {
    id: requiredText(call.id ?? call.tool_use_id, 'Anthropic tool call id'),
    name: requiredText(call.name ?? call.tool_name, 'Anthropic tool call name'),
    input: parseToolInput(call.input, 'Anthropic tool input')
  }
}

function normalizeAnthropicUsage(value: unknown): UsageTotals | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const usage = value as Record<string, unknown>
  return {
    input: nonNegativeNumber(usage.input ?? usage.input_tokens),
    output: nonNegativeNumber(usage.output ?? usage.output_tokens),
    cacheRead: nonNegativeNumber(usage.cacheRead ?? usage.cache_read_input_tokens),
    cacheCreation: nonNegativeNumber(usage.cacheCreation ?? usage.cache_creation_input_tokens)
  }
}

function normalizeAnthropicError(value: unknown) {
  if (typeof value === 'string') return protocolError('anthropic_error', value)
  const outer = errorRecord(value)
  const inner = outer.error && typeof outer.error === 'object'
    ? requiredRecord(outer.error, 'Anthropic nested error')
    : outer
  const status = numberField(outer.status) ?? numberField(inner.status)
  return protocolError(
    optionalText(inner.code) ?? optionalText(inner.type) ?? optionalText(outer.name) ?? 'anthropic_error',
    optionalText(inner.message) ?? optionalText(outer.message) ?? 'Anthropic Messages error',
    status
  )
}

function errorRecord(value: unknown): Record<string, unknown> {
  if (value instanceof Error) {
    const status = 'status' in value ? numberField(value.status) : undefined
    return { name: value.name, message: value.message, ...(status === undefined ? {} : { status }) }
  }
  return requiredRecord(value, 'Anthropic error')
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}
