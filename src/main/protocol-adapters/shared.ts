import type { AgentEvent, EngineKind, SendMessagePayload, SessionMeta, UsageTotals } from '../../shared/types'
import {
  PROTOCOL_ADAPTER_SCHEMA_VERSION,
  type NativeProtocolAdapter,
  type ProtocolAdapterError,
  type ProtocolAdapterResponsibility,
  type ProtocolStreamSignal,
  type ProtocolToolCall
} from './types'

const RESPONSIBILITIES = Object.freeze([
  'request', 'stream', 'tool', 'usage', 'error'
] satisfies ProtocolAdapterResponsibility[])

export class ProtocolAdapterContractError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ProtocolAdapterContractError'
    this.code = code
  }
}

interface DefineNativeProtocolAdapterInput {
  id: string
  engineKind: EngineKind
  protocol: string
  decodeStreamChunk(value: unknown): ProtocolStreamSignal[]
  normalizeToolCall(value: unknown): ProtocolToolCall
  normalizeUsage(value: unknown): UsageTotals | null
  normalizeError(value: unknown): ProtocolAdapterError
}

export function defineNativeProtocolAdapter(
  input: DefineNativeProtocolAdapterInput
): NativeProtocolAdapter {
  const adapter: NativeProtocolAdapter = Object.freeze({
    schemaVersion: PROTOCOL_ADAPTER_SCHEMA_VERSION,
    id: input.id,
    engineKind: input.engineKind,
    protocol: input.protocol,
    responsibilities: RESPONSIBILITIES,
    prepareRequest: (request: string | SendMessagePayload, meta: SessionMeta) =>
      prepareRequest(request, meta, input.engineKind),
    normalizeEvent: (event: AgentEvent) => normalizeEvent(event, adapter),
    decodeStreamChunk: input.decodeStreamChunk,
    normalizeToolCall: input.normalizeToolCall,
    normalizeUsage: input.normalizeUsage,
    normalizeError: input.normalizeError
  })
  assertNativeProtocolAdapter(adapter, input.engineKind, input.protocol)
  return adapter
}

export function assertNativeProtocolAdapter(
  value: unknown,
  expectedKind?: string,
  expectedProtocol?: string
): asserts value is NativeProtocolAdapter {
  const adapter = requiredRecord(value, 'protocol adapter')
  assertAdapterMetadata(adapter, expectedKind, expectedProtocol)
  assertAdapterResponsibilities(adapter)
  assertAdapterSurface(adapter)
}

function assertAdapterMetadata(
  adapter: Record<string, unknown>,
  expectedKind?: string,
  expectedProtocol?: string
): void {
  if (adapter.schemaVersion !== PROTOCOL_ADAPTER_SCHEMA_VERSION) {
    fail('adapter_schema', 'protocol adapter schemaVersion must be 1')
  }
  if (adapter.engineKind !== 'claude' && adapter.engineKind !== 'anthropic' && adapter.engineKind !== 'openai') {
    fail('adapter_engine', 'protocol adapter engineKind is invalid')
  }
  if (expectedKind !== undefined && adapter.engineKind !== expectedKind) {
    fail('adapter_identity', 'protocol adapter engineKind does not match its Engine factory')
  }
  if (typeof adapter.protocol !== 'string' || !adapter.protocol.trim()) {
    fail('adapter_protocol', 'protocol adapter protocol identity is required')
  }
  if (expectedProtocol !== undefined && adapter.protocol !== expectedProtocol) {
    fail('adapter_protocol', 'protocol adapter identity does not match native runtime declaration')
  }
  if (typeof adapter.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,79}$/.test(adapter.id)) {
    fail('adapter_id', 'protocol adapter id is invalid')
  }
}

function assertAdapterResponsibilities(adapter: Record<string, unknown>): void {
  if (!Array.isArray(adapter.responsibilities) || !sameStrings(adapter.responsibilities, RESPONSIBILITIES)) {
    fail('adapter_responsibilities', 'protocol adapter responsibilities are incomplete')
  }
}

function assertAdapterSurface(adapter: Record<string, unknown>): void {
  for (const method of [
    'prepareRequest', 'normalizeEvent', 'decodeStreamChunk',
    'normalizeToolCall', 'normalizeUsage', 'normalizeError'
  ]) {
    if (typeof adapter[method] !== 'function') fail('adapter_surface', `protocol adapter is missing ${method}`)
  }
}

export function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('protocol_shape', `${label} must be an object`)
  }
  return value as Record<string, unknown>
}

export function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) fail('protocol_shape', `${label} is required`)
  return value
}

export function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

export function parseToolInput(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined || value === null || value === '') return {}
  if (typeof value === 'string') {
    try {
      return requiredRecord(JSON.parse(value), label)
    } catch (error) {
      if (error instanceof ProtocolAdapterContractError) throw error
      fail('protocol_tool', `${label} is not valid JSON`)
    }
  }
  return requiredRecord(value, label)
}

export function protocolError(
  code: string,
  message: string,
  status?: number
): ProtocolAdapterError {
  const normalizedStatus = typeof status === 'number' && Number.isSafeInteger(status) ? status : undefined
  return {
    code: code.trim() || 'protocol_error',
    message: message.trim() || 'Protocol adapter error',
    ...(normalizedStatus === undefined ? {} : { status: normalizedStatus }),
    retryable: normalizedStatus === undefined || normalizedStatus === 408 || normalizedStatus === 409 ||
      normalizedStatus === 429 || normalizedStatus >= 500
  }
}

function prepareRequest(
  request: string | SendMessagePayload,
  meta: SessionMeta,
  engineKind: EngineKind
): string | SendMessagePayload {
  if (meta.engine !== engineKind) fail('request_identity', 'request Engine identity changed')
  if (typeof request === 'string') return request
  if (!request || typeof request !== 'object' || typeof request.text !== 'string') {
    fail('request_shape', 'request payload text must be a string')
  }
  if (request.images !== undefined && !Array.isArray(request.images)) {
    fail('request_shape', 'request images must be an array')
  }
  return request
}

function normalizeEvent(event: AgentEvent, adapter: NativeProtocolAdapter): AgentEvent {
  if (event.kind === 'tool-start') {
    adapter.normalizeToolCall({ id: event.toolUseId, name: event.name, input: {} })
  } else if (event.kind === 'assistant-message') {
    for (const block of event.blocks) {
      if (block.type === 'tool_use') {
        adapter.normalizeToolCall({ id: block.id, name: block.name, input: block.input })
      }
    }
  } else if (event.kind === 'turn-result' && event.usage) {
    const usage = adapter.normalizeUsage(event.usage)
    if (!usage || !sameUsage(usage, event.usage)) fail('usage_projection', 'runtime usage projection changed')
  } else if (event.kind === 'status' && event.status === 'error') {
    adapter.normalizeError(event.error ?? 'Engine error')
  } else if (event.kind === 'turn-result' && event.isError) {
    adapter.normalizeError(event.resultText ?? event.subtype)
  }
  return event
}

function sameUsage(left: UsageTotals, right: UsageTotals): boolean {
  return left.input === right.input && left.output === right.output &&
    left.cacheRead === right.cacheRead && left.cacheCreation === right.cacheCreation
}

function sameStrings(left: readonly unknown[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function fail(code: string, message: string): never {
  throw new ProtocolAdapterContractError(code, message)
}
