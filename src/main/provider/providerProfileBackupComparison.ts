import type { Provider, ProviderView } from '../../shared/types'

function comparableProvider(provider: Provider | ProviderView): Record<string, unknown> {
  return {
    name: provider.name,
    baseUrl: provider.baseUrl,
    models: provider.models,
    authMode: provider.authMode,
    engine: provider.engine,
    customHeaders: provider.customHeaders ?? '',
    credentialHeaderNames: provider.credentialHeaderNames ?? [],
    credentialRoutingMode: provider.credentialRoutingMode ?? 'preferred',
    budgetUsd: provider.budgetUsd ?? 0,
    openaiProtocol: provider.openaiProtocol ?? '',
    note: provider.note ?? '',
    authorization: provider.authorization ?? null,
    advancedConfig: provider.advancedConfig ?? null
  }
}

export function providerBackupChangedFields(backup: Provider, current: ProviderView): string[] {
  const before = comparableProvider(backup)
  const now = comparableProvider(current)
  return Object.keys(before).filter((field) => JSON.stringify(before[field]) !== JSON.stringify(now[field]))
}
