import type {
  ProviderApiKey,
  ProviderCredentialPolicy,
  ProviderCredentialRoutingMode
} from '../shared/types'
import type { FailureClass } from './providerHealth'

export const PROVIDER_KEY_FAILURE_COOLDOWN_MS = 5 * 60_000
export const DEFAULT_PROVIDER_CREDENTIAL_POLICY: ProviderCredentialPolicy = Object.freeze({
  priority: 50,
  monthlyBudgetUsd: 0,
  minimumBalanceUsd: 0,
  failureCooldownMinutes: 5
})

export interface ProviderCredentialMetrics {
  monthlySpendUsd?: number
  balanceRemainingUsd?: number
}

export interface ProviderCredentialRoutingDecision {
  key?: ProviderApiKey
  reason: string
  blocked: ReadonlyMap<string, string>
}

export function normalizeProviderCredentialRoutingMode(value: unknown): ProviderCredentialRoutingMode {
  return value === 'manual' || value === 'automatic' ? value : 'preferred'
}

export function normalizeProviderCredentialPolicy(value: unknown): ProviderCredentialPolicy {
  const policy = value && typeof value === 'object' ? value as Partial<ProviderCredentialPolicy> : {}
  return {
    priority: boundedInteger(policy.priority, 1, 100, DEFAULT_PROVIDER_CREDENTIAL_POLICY.priority),
    monthlyBudgetUsd: nonNegative(policy.monthlyBudgetUsd),
    minimumBalanceUsd: nonNegative(policy.minimumBalanceUsd),
    failureCooldownMinutes: boundedInteger(
      policy.failureCooldownMinutes,
      1,
      1440,
      DEFAULT_PROVIDER_CREDENTIAL_POLICY.failureCooldownMinutes
    )
  }
}

export function selectProviderKey(
  keys: ProviderApiKey[],
  options: {
    activeKeyId?: string
    routingMode?: ProviderCredentialRoutingMode
    excludedKeyIds?: ReadonlySet<string>
    metrics?: ReadonlyMap<string, ProviderCredentialMetrics>
    available?: (key: ProviderApiKey) => boolean
    now?: number
  } = {}
): ProviderCredentialRoutingDecision {
  const now = options.now ?? Date.now()
  const mode = normalizeProviderCredentialRoutingMode(options.routingMode)
  const excluded = options.excludedKeyIds ?? new Set<string>()
  const blocked = new Map<string, string>()
  const candidates = keys.flatMap((key) => {
    const reason = credentialBlockedReason(key, {
      now,
      excluded,
      metrics: options.metrics?.get(key.id),
      available: options.available
    })
    if (reason) {
      blocked.set(key.id, reason)
      return []
    }
    return [{ key, policy: normalizeProviderCredentialPolicy(key.policy), metrics: options.metrics?.get(key.id) }]
  })
  const active = candidates.find((candidate) => candidate.key.id === options.activeKeyId)
  if (mode === 'manual') {
    return active
      ? { key: active.key, reason: '手动模式使用指定凭据', blocked }
      : { reason: options.activeKeyId ? blocked.get(options.activeKeyId) ?? '手动凭据不可用' : '手动模式未指定凭据', blocked }
  }
  if (mode === 'preferred' && active) {
    return { key: active.key, reason: '首选模式使用指定凭据', blocked }
  }
  candidates.sort(compareCandidates)
  const selected = candidates[0]
  if (!selected) return { reason: '没有满足可用性、预算、余额和冷却约束的凭据', blocked }
  const spend = nonNegative(selected.metrics?.monthlySpendUsd)
  const budget = selected.policy.monthlyBudgetUsd
  const budgetText = budget > 0 ? `，本月 $${spend.toFixed(2)} / $${budget.toFixed(2)}` : ''
  const prefix = mode === 'preferred' ? '首选凭据不可用，自动切换' : '自动路由'
  return {
    key: selected.key,
    reason: `${prefix}到优先级 ${selected.policy.priority}${budgetText}`,
    blocked
  }
}

export function canRotateProviderKey(failure: FailureClass): boolean {
  return ['quota', 'rate_limit', 'auth', 'forbidden'].includes(failure.kind)
}

export function pickNextProviderKey(
  keys: ProviderApiKey[],
  options: {
    activeKeyId?: string
    failedKeyId?: string
    excludedKeyIds?: ReadonlySet<string>
    now?: number
    cooldownMs?: number
    routingMode?: ProviderCredentialRoutingMode
    metrics?: ReadonlyMap<string, ProviderCredentialMetrics>
    available?: (key: ProviderApiKey) => boolean
  }
): ProviderApiKey | undefined {
  const now = options.now ?? Date.now()
  const failedKeyId = options.failedKeyId || options.activeKeyId
  const excluded = new Set(options.excludedKeyIds ?? [])
  if (failedKeyId) excluded.add(failedKeyId)
  const adjusted = options.cooldownMs === undefined ? keys : keys.map((key) => ({
    ...key,
    policy: { ...normalizeProviderCredentialPolicy(key.policy), failureCooldownMinutes: options.cooldownMs! / 60_000 }
  }))
  return selectProviderKey(adjusted, {
    activeKeyId: options.activeKeyId,
    routingMode: options.routingMode === 'manual' ? 'manual' : 'automatic',
    excludedKeyIds: excluded,
    metrics: options.metrics,
    available: options.available,
    now
  }).key
}

function credentialBlockedReason(
  key: ProviderApiKey,
  options: {
    now: number
    excluded: ReadonlySet<string>
    metrics?: ProviderCredentialMetrics
    available?: (key: ProviderApiKey) => boolean
  }
): string | undefined {
  if (key.disabled) return '已禁用'
  if (!key.encryptedToken && key.sessionOnly !== true) return '缺少凭据'
  if (options.excluded.has(key.id)) return '本次请求已尝试或失败'
  if (options.available && !options.available(key)) return '凭据当前不可解密'
  const policy = normalizeProviderCredentialPolicy(key.policy)
  const cooldownMs = policy.failureCooldownMinutes * 60_000
  if (key.lastFailureAt && options.now - key.lastFailureAt < cooldownMs) return '失败冷却中'
  const spend = nonNegative(options.metrics?.monthlySpendUsd)
  if (policy.monthlyBudgetUsd > 0 && spend >= policy.monthlyBudgetUsd) return '已达到月度预算'
  const balance = optionalNonNegative(options.metrics?.balanceRemainingUsd)
  if (balance !== undefined && policy.minimumBalanceUsd > 0 && balance < policy.minimumBalanceUsd) {
    return '余额低于保留底线'
  }
  return undefined
}

function compareCandidates(
  left: { key: ProviderApiKey; policy: ProviderCredentialPolicy; metrics?: ProviderCredentialMetrics },
  right: { key: ProviderApiKey; policy: ProviderCredentialPolicy; metrics?: ProviderCredentialMetrics }
): number {
  const priority = left.policy.priority - right.policy.priority
  if (priority !== 0) return priority
  const utilization = budgetUtilization(left.policy, left.metrics) - budgetUtilization(right.policy, right.metrics)
  if (utilization !== 0) return utilization
  const balance = (right.metrics?.balanceRemainingUsd ?? 0) - (left.metrics?.balanceRemainingUsd ?? 0)
  if (balance !== 0) return balance
  const lastUsed = (left.key.lastUsedAt ?? 0) - (right.key.lastUsedAt ?? 0)
  if (lastUsed !== 0) return lastUsed
  const created = left.key.createdAt - right.key.createdAt
  return created !== 0 ? created : left.key.id.localeCompare(right.key.id)
}

function budgetUtilization(policy: ProviderCredentialPolicy, metrics: ProviderCredentialMetrics | undefined): number {
  if (policy.monthlyBudgetUsd <= 0) return 0
  return nonNegative(metrics?.monthlySpendUsd) / policy.monthlyBudgetUsd
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback
}

function nonNegative(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

function optionalNonNegative(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  return nonNegative(value)
}
