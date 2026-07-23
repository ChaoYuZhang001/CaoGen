import type {
  AgentEvent,
  EngineKind,
  SendMessagePayload,
  SessionMeta,
  UsageTotals
} from '../../shared/types'

export const PROTOCOL_ADAPTER_SCHEMA_VERSION = 1 as const

export type ProtocolAdapterResponsibility =
  | 'request'
  | 'stream'
  | 'tool'
  | 'usage'
  | 'error'

export interface ProtocolTextSignal {
  kind: 'text' | 'thinking'
  text: string
}

export interface ProtocolToolSignal {
  kind: 'tool'
  tool: ProtocolToolCall
}

export interface ProtocolUsageSignal {
  kind: 'usage'
  usage: UsageTotals
}

export interface ProtocolDoneSignal {
  kind: 'done'
  stopReason?: string
}

export interface ProtocolErrorSignal {
  kind: 'error'
  error: ProtocolAdapterError
}

export type ProtocolStreamSignal =
  | ProtocolTextSignal
  | ProtocolToolSignal
  | ProtocolUsageSignal
  | ProtocolDoneSignal
  | ProtocolErrorSignal

export interface ProtocolToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ProtocolAdapterError {
  code: string
  message: string
  status?: number
  retryable: boolean
}

export interface NativeProtocolAdapter {
  readonly schemaVersion: typeof PROTOCOL_ADAPTER_SCHEMA_VERSION
  readonly id: string
  readonly engineKind: EngineKind
  readonly protocol: string
  readonly responsibilities: readonly ProtocolAdapterResponsibility[]
  /** Product request ingress. The adapter must preserve the public payload contract. */
  prepareRequest(input: string | SendMessagePayload, meta: SessionMeta): string | SendMessagePayload
  /** Product event egress. Invalid protocol projections fail before entering the runtime. */
  normalizeEvent(event: AgentEvent): AgentEvent
  decodeStreamChunk(value: unknown): ProtocolStreamSignal[]
  normalizeToolCall(value: unknown): ProtocolToolCall
  normalizeUsage(value: unknown): UsageTotals | null
  normalizeError(value: unknown): ProtocolAdapterError
}
