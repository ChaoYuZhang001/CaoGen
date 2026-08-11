import type { ProviderView, RoutingExpertPolicy } from '../../shared/types'

export interface RoutingExpertPolicyResult {
  providers: ProviderView[]
  warnings: string[]
}

export function applyRoutingExpertPolicy(
  providers: ProviderView[],
  policy: RoutingExpertPolicy
): RoutingExpertPolicyResult {
  const allowed = new Set(policy.allowedProviderIds)
  const scoped = allowed.size > 0
    ? providers.filter((provider) => allowed.has(provider.id))
    : providers
  const local = scoped.filter((provider) => isLocalProviderUrl(provider.baseUrl))
  const scopeWarning = allowed.size > 0
    ? [`专家策略已将候选限制为 ${allowed.size} 个 Provider。`]
    : []

  if (policy.locality === 'local_only') {
    return {
      providers: local,
      warnings: [...scopeWarning, '专家策略禁止模型数据外发，仅允许回环 Provider。']
    }
  }
  if (policy.locality === 'prefer_local' && local.length > 0) {
    return {
      providers: local,
      warnings: [...scopeWarning, '专家策略优先本地，本轮仅在可用回环 Provider 中选路。']
    }
  }
  return {
    providers: scoped,
    warnings: policy.locality === 'prefer_local'
      ? [...scopeWarning, '专家策略优先本地，但没有可用回环 Provider，已保留允许的远程候选。']
      : scopeWarning
  }
}

export function providerAllowedByRoutingExpertPolicy(
  provider: Pick<ProviderView, 'id' | 'baseUrl'>,
  policy: RoutingExpertPolicy
): boolean {
  if (policy.allowedProviderIds.length > 0 && !policy.allowedProviderIds.includes(provider.id)) return false
  return policy.locality !== 'local_only' || isLocalProviderUrl(provider.baseUrl)
}

export function assertRoutingExpertTargetAllowed(
  providerId: string,
  baseUrl: string,
  policy: RoutingExpertPolicy
): void {
  if (policy.allowedProviderIds.length > 0 && !policy.allowedProviderIds.includes(providerId)) {
    throw new Error(`Provider ${providerId} is blocked by the routing expert allowlist`)
  }
  if (policy.locality === 'local_only' && !isLocalProviderUrl(baseUrl)) {
    throw new Error(`Provider ${providerId} is blocked because model data egress is disabled`)
  }
}

export function isLocalProviderUrl(value: string): boolean {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1' || /^127(?:\.\d{1,3}){3}$/.test(host)
  } catch {
    return false
  }
}
