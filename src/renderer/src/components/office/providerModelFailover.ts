import type { SessionState } from '../../store'

export interface OfficeProviderModelFailoverSignal {
  providerName: string
  fromModel: string
  toModel: string
  reason: string
}

export function latestProviderModelFailoverSignal(
  session: SessionState
): OfficeProviderModelFailoverSignal | undefined {
  for (let index = session.items.length - 1; index >= 0; index -= 1) {
    const item = session.items[index]
    if (item.kind !== 'provider-model-failover') continue
    return {
      providerName: item.providerName,
      fromModel: item.fromModel,
      toModel: item.toModel,
      reason: item.reason
    }
  }
  return undefined
}

export function hasOfficeFailoverSignal(signal: {
  failover?: unknown
  keyFailover?: unknown
  modelFailover?: unknown
}): boolean {
  return Boolean(signal.failover || signal.keyFailover || signal.modelFailover)
}
