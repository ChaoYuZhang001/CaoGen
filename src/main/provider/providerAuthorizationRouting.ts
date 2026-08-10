import type {
  ProviderAuthorizationAccountPolicy,
  ProviderAuthorizationAccountView,
  ProviderAuthorizationQuotaView
} from '../../shared/provider-authorization-types'
import type { ProviderCredentialRoutingMode } from '../../shared/types'
import { normalizeProviderCredentialRoutingMode } from '../providerKeyRouting'

export const DEFAULT_PROVIDER_AUTHORIZATION_ACCOUNT_POLICY: ProviderAuthorizationAccountPolicy = Object.freeze({
  enabled: true,
  priority: 50,
  minimumQuotaRemainingPercent: 0,
  requireKnownQuota: false,
  failureCooldownMinutes: 5
})

export interface ProviderAuthorizationRoutingDecision {
  account?: ProviderAuthorizationAccountView
  reason: string
  blocked: ReadonlyMap<string, string>
}

export function normalizeProviderAuthorizationAccountPolicy(
  value: unknown
): ProviderAuthorizationAccountPolicy {
  const policy = value && typeof value === 'object'
    ? value as Partial<ProviderAuthorizationAccountPolicy>
    : {}
  return {
    enabled: policy.enabled !== false,
    priority: boundedInteger(policy.priority, 1, 100, DEFAULT_PROVIDER_AUTHORIZATION_ACCOUNT_POLICY.priority),
    minimumQuotaRemainingPercent: boundedNumber(
      policy.minimumQuotaRemainingPercent,
      0,
      100,
      DEFAULT_PROVIDER_AUTHORIZATION_ACCOUNT_POLICY.minimumQuotaRemainingPercent
    ),
    requireKnownQuota: policy.requireKnownQuota === true,
    failureCooldownMinutes: boundedInteger(
      policy.failureCooldownMinutes,
      1,
      1440,
      DEFAULT_PROVIDER_AUTHORIZATION_ACCOUNT_POLICY.failureCooldownMinutes
    )
  }
}

export function selectProviderAuthorizationAccount(
  accounts: ProviderAuthorizationAccountView[],
  options: {
    activeAccountId?: string
    routingMode?: ProviderCredentialRoutingMode
    explicitAccountId?: string
    excludedAccountIds?: ReadonlySet<string>
    quotas?: ReadonlyMap<string, ProviderAuthorizationQuotaView>
    now?: number
  } = {}
): ProviderAuthorizationRoutingDecision {
  const now = options.now ?? Date.now()
  const mode = normalizeProviderCredentialRoutingMode(options.routingMode)
  const activeAccountId = options.explicitAccountId ?? options.activeAccountId
  const blocked = new Map<string, string>()
  const candidates = accounts.flatMap((account) => {
    const quota = options.quotas?.get(account.id) ?? account.quota
    const policy = normalizeProviderAuthorizationAccountPolicy(account.policy)
    const reason = blockedReason(account, policy, quota, options.excludedAccountIds, now)
    if (reason) {
      blocked.set(account.id, reason)
      return []
    }
    return [{ account, policy, quota }]
  })
  const active = candidates.find(({ account }) => account.id === activeAccountId)

  if (options.explicitAccountId || mode === 'manual') {
    return active
      ? { account: active.account, reason: options.explicitAccountId ? '应用绑定使用指定授权账号' : '手动模式使用指定授权账号', blocked }
      : { reason: activeAccountId ? blocked.get(activeAccountId) ?? '指定授权账号不可用' : '手动模式未指定授权账号', blocked }
  }
  if (mode === 'preferred' && active) {
    return { account: active.account, reason: '首选模式使用绑定授权账号', blocked }
  }

  candidates.sort(compareCandidates)
  const selected = candidates[0]
  if (!selected) return { reason: '没有满足凭据、配额和冷却约束的授权账号', blocked }
  const remaining = quotaRemainingPercent(selected.quota)
  const quotaText = remaining === undefined ? '' : `，已知剩余 ${remaining.toFixed(0)}%`
  return {
    account: selected.account,
    reason: `${mode === 'preferred' ? '首选账号不可用，自动切换' : '自动路由'}到优先级 ${selected.policy.priority}${quotaText}`,
    blocked
  }
}

export function quotaRemainingPercent(quota: ProviderAuthorizationQuotaView | undefined): number | undefined {
  if (!quota || quota.status !== 'ready' || quota.tiers.length === 0) return undefined
  const highestUtilization = Math.max(...quota.tiers.map((tier) => boundedNumber(tier.utilization, 0, 100, 100)))
  return Math.max(0, 100 - highestUtilization)
}

function blockedReason(
  account: ProviderAuthorizationAccountView,
  policy: ProviderAuthorizationAccountPolicy,
  quota: ProviderAuthorizationQuotaView | undefined,
  excluded: ReadonlySet<string> | undefined,
  now: number
): string | undefined {
  if (!policy.enabled) return '已禁用'
  if (account.requiresReauth) return '需要重新授权'
  if (excluded?.has(account.id)) return '本次请求已尝试或失败'
  if (account.lastFailureAt && now - account.lastFailureAt < policy.failureCooldownMinutes * 60_000) {
    return '失败冷却中'
  }
  if (quota?.status === 'expired') return '授权或配额已过期'
  const remaining = quotaRemainingPercent(quota)
  if (policy.requireKnownQuota && remaining === undefined) return '缺少可用配额数据'
  if (remaining !== undefined && remaining < policy.minimumQuotaRemainingPercent) return '剩余配额低于保留底线'
  return undefined
}

function compareCandidates(
  left: { account: ProviderAuthorizationAccountView; policy: ProviderAuthorizationAccountPolicy; quota?: ProviderAuthorizationQuotaView },
  right: { account: ProviderAuthorizationAccountView; policy: ProviderAuthorizationAccountPolicy; quota?: ProviderAuthorizationQuotaView }
): number {
  const priority = left.policy.priority - right.policy.priority
  if (priority !== 0) return priority
  const quota = (quotaRemainingPercent(right.quota) ?? -1) - (quotaRemainingPercent(left.quota) ?? -1)
  if (quota !== 0) return quota
  const updated = left.account.updatedAt - right.account.updatedAt
  return updated !== 0 ? updated : left.account.id.localeCompare(right.account.id)
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  return Math.round(boundedNumber(value, min, max, fallback))
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback
}
