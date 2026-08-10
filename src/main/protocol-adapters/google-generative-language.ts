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

export const GOOGLE_GENERATIVE_LANGUAGE_PROTOCOL_ADAPTER = defineNativeProtocolAdapter({
  id: 'google.generative-language.v1beta',
  engineKind: 'gemini',
  protocol: 'google.generative-language',
  decodeStreamChunk: decodeGoogleChunk,
  normalizeToolCall: normalizeGoogleToolCall,
  normalizeUsage: normalizeGoogleUsage,
  normalizeError: normalizeGoogleError
})

function decodeGoogleChunk(value: unknown): ProtocolStreamSignal[] {
  const response = requiredRecord(value, 'Google response')
  const candidates = Array.isArray(response.candidates) ? response.candidates : []
  const signals: ProtocolStreamSignal[] = []
  for (const rawCandidate of candidates) {
    const candidate = requiredRecord(rawCandidate, 'Google candidate')
    const content = requiredRecord(candidate.content ?? {}, 'Google content')
    const parts = Array.isArray(content.parts) ? content.parts : []
    for (const rawPart of parts) signals.push(...decodeGooglePart(rawPart))
    if (typeof candidate.finishReason === 'string') {
      signals.push({ kind: 'done', stopReason: candidate.finishReason })
    }
  }
  const usage = normalizeGoogleUsage(response.usageMetadata)
  if (usage) signals.push({ kind: 'usage', usage })
  return signals
}

function decodeGooglePart(value: unknown): ProtocolStreamSignal[] {
  const part = requiredRecord(value, 'Google part')
  if (typeof part.text === 'string') {
    return [{ kind: part.thought === true ? 'thinking' : 'text', text: part.text }]
  }
  if (part.functionCall) {
    const call = requiredRecord(part.functionCall, 'Google function call')
    return [{
      kind: 'tool',
      tool: normalizeGoogleToolCall({ ...call, id: optionalText(call.id) ?? requiredText(call.name, 'Google function call name') })
    }]
  }
  return []
}

function normalizeGoogleToolCall(value: unknown): ProtocolToolCall {
  const call = requiredRecord(value, 'Google function call')
  const name = requiredText(call.name, 'Google function call name')
  return {
    id: requiredText(call.id, 'Google function call id'),
    name,
    input: parseToolInput(call.args ?? call.input ?? {}, 'Google function call args')
  }
}

function normalizeGoogleUsage(value: unknown): UsageTotals | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const usage = value as Record<string, unknown>
  const hasUsage = ['input', 'output', 'cacheRead', 'cacheCreation', 'promptTokenCount',
    'candidatesTokenCount', 'thoughtsTokenCount', 'cachedContentTokenCount']
    .some((key) => typeof usage[key] === 'number')
  if (!hasUsage) return null
  return {
    input: nonNegativeNumber(usage.input ?? usage.promptTokenCount),
    output: nonNegativeNumber(usage.output ?? usage.candidatesTokenCount)
      + nonNegativeNumber(usage.thoughtsTokenCount),
    cacheRead: nonNegativeNumber(usage.cacheRead ?? usage.cachedContentTokenCount),
    cacheCreation: nonNegativeNumber(usage.cacheCreation)
  }
}

function normalizeGoogleError(value: unknown) {
  if (value instanceof Error) return protocolError(value.name, value.message)
  if (typeof value === 'string') return protocolError('google_error', value)
  const outer = requiredRecord(value, 'Google error')
  const inner = outer.error && typeof outer.error === 'object'
    ? requiredRecord(outer.error, 'Google nested error') : outer
  const status = typeof outer.status === 'number' ? outer.status
    : typeof inner.code === 'number' ? inner.code : undefined
  return protocolError(
    optionalText(inner.status) ?? 'google_error',
    optionalText(inner.message) ?? optionalText(outer.message) ?? 'Google Generative Language error',
    status
  )
}
