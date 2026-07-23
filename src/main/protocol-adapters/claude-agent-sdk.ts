import type { UsageTotals } from '../../shared/types'
import { defineNativeProtocolAdapter, nonNegativeNumber, optionalText, parseToolInput, protocolError, requiredRecord, requiredText } from './shared'
import type { ProtocolStreamSignal, ProtocolToolCall } from './types'

export const CLAUDE_AGENT_SDK_PROTOCOL_ADAPTER = defineNativeProtocolAdapter({
  id: 'claude.agent-sdk.v1',
  engineKind: 'claude',
  protocol: 'claude.agent-sdk',
  decodeStreamChunk: decodeClaudeStreamChunk,
  normalizeToolCall: normalizeClaudeToolCall,
  normalizeUsage: normalizeClaudeUsage,
  normalizeError: normalizeClaudeError
})

function decodeClaudeStreamChunk(value: unknown): ProtocolStreamSignal[] {
  const record = requiredRecord(value, 'Claude SDK stream chunk')
  if (record.type === 'stream_event') return decodeClaudeStreamChunk(record.event)
  if (record.type === 'content_block_start') {
    const block = requiredRecord(record.content_block, 'Claude content block')
    return block.type === 'tool_use' ? [{ kind: 'tool', tool: normalizeClaudeToolCall(block) }] : []
  }
  if (record.type === 'content_block_delta') {
    const delta = requiredRecord(record.delta, 'Claude content delta')
    if (delta.type === 'text_delta') return [{ kind: 'text', text: optionalText(delta.text) ?? '' }]
    if (delta.type === 'thinking_delta') {
      return [{ kind: 'thinking', text: optionalText(delta.thinking) ?? '' }]
    }
    return []
  }
  if (record.type === 'result') return claudeResultSignals(record)
  if (record.type === 'error') return [{ kind: 'error', error: normalizeClaudeError(record) }]
  return []
}

function claudeResultSignals(record: Record<string, unknown>): ProtocolStreamSignal[] {
  const signals: ProtocolStreamSignal[] = []
  const usage = normalizeClaudeUsage(record.usage)
  if (usage) signals.push({ kind: 'usage', usage })
  if (record.is_error === true) signals.push({ kind: 'error', error: normalizeClaudeError(record) })
  signals.push({ kind: 'done', stopReason: optionalText(record.subtype) })
  return signals
}

function normalizeClaudeToolCall(value: unknown): ProtocolToolCall {
  const call = requiredRecord(value, 'Claude tool call')
  return {
    id: requiredText(call.id ?? call.tool_use_id, 'Claude tool call id'),
    name: requiredText(call.name ?? call.tool_name, 'Claude tool call name'),
    input: parseToolInput(call.input, 'Claude tool input')
  }
}

function normalizeClaudeUsage(value: unknown): UsageTotals | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const usage = value as Record<string, unknown>
  return {
    input: nonNegativeNumber(usage.input ?? usage.input_tokens),
    output: nonNegativeNumber(usage.output ?? usage.output_tokens),
    cacheRead: nonNegativeNumber(usage.cacheRead ?? usage.cache_read_input_tokens),
    cacheCreation: nonNegativeNumber(usage.cacheCreation ?? usage.cache_creation_input_tokens)
  }
}

function normalizeClaudeError(value: unknown) {
  if (value instanceof Error) return protocolError(value.name, value.message)
  if (typeof value === 'string') return protocolError('claude_error', value)
  const error = requiredRecord(value, 'Claude error')
  const status = typeof error.status === 'number' ? error.status : undefined
  return protocolError(
    optionalText(error.code) ?? optionalText(error.subtype) ?? 'claude_error',
    optionalText(error.message) ?? optionalText(error.error) ?? 'Claude SDK error',
    status
  )
}
