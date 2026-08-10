import type { AgentEvent } from '../../../shared/types'
import type { SessionState } from '../store'

export interface ProviderKeyFailoverChatItem {
  id: string
  kind: 'provider-key-failover'
  providerName: string
  fromKeyLabel: string
  toKeyLabel: string
  reason: string
}

export interface ProviderModelFailoverChatItem {
  id: string
  kind: 'provider-model-failover'
  providerName: string
  fromModel: string
  toModel: string
  reason: string
}

export interface ProviderProtocolFailoverChatItem {
  id: string
  kind: 'provider-protocol-failover'
  providerName: string
  model: string
  fromProtocol: 'responses'
  toProtocol: 'chat'
  reason: string
}

export interface ProviderRecoveryExhaustedChatItem {
  id: string
  kind: 'provider-recovery-exhausted'
  engine: import('../../../shared/types').EngineKind
  providerName: string
  model: string
  reason: string
}

function reduceProviderKeyFailover(
  state: SessionState,
  event: Extract<AgentEvent, { kind: 'provider-key-failover' }>,
  id: string
): SessionState {
  return {
    ...state,
    streamText: '',
    streamThinking: '',
    runningTools: {},
    items: [...state.items, {
      id,
      kind: 'provider-key-failover',
      providerName: event.providerName,
      fromKeyLabel: event.fromKeyLabel,
      toKeyLabel: event.toKeyLabel,
      reason: event.reason
    }]
  }
}

function reduceProviderModelFailover(
  state: SessionState,
  event: Extract<AgentEvent, { kind: 'provider-model-failover' }>,
  id: string
): SessionState {
  return {
    ...state,
    streamText: '',
    streamThinking: '',
    runningTools: {},
    effectiveModel: event.toModel,
    items: [...state.items, {
      id,
      kind: 'provider-model-failover',
      providerName: event.providerName,
      fromModel: event.fromModel,
      toModel: event.toModel,
      reason: event.reason
    }]
  }
}

function reduceProviderProtocolFailover(
  state: SessionState,
  event: Extract<AgentEvent, { kind: 'provider-protocol-failover' }>,
  id: string
): SessionState {
  return {
    ...state,
    streamText: '',
    streamThinking: '',
    runningTools: {},
    items: [...state.items, {
      id,
      kind: 'provider-protocol-failover',
      providerName: event.providerName,
      model: event.model,
      fromProtocol: event.fromProtocol,
      toProtocol: event.toProtocol,
      reason: event.reason
    }]
  }
}

function reduceProviderRecoveryExhausted(
  state: SessionState,
  event: Extract<AgentEvent, { kind: 'provider-recovery-exhausted' }>,
  id: string
): SessionState {
  return {
    ...state,
    items: [...state.items, {
      id,
      kind: 'provider-recovery-exhausted',
      engine: event.engine,
      providerName: event.providerName,
      model: event.model,
      reason: event.reason
    }]
  }
}

export function reduceProviderFailover(
  state: SessionState,
  event: AgentEvent,
  id: () => string
): SessionState | undefined {
  if (event.kind === 'provider-key-failover') return reduceProviderKeyFailover(state, event, id())
  if (event.kind === 'provider-model-failover') return reduceProviderModelFailover(state, event, id())
  if (event.kind === 'provider-protocol-failover') return reduceProviderProtocolFailover(state, event, id())
  if (event.kind === 'provider-recovery-exhausted') return reduceProviderRecoveryExhausted(state, event, id())
  return undefined
}
