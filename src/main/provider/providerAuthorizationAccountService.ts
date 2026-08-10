import { createHash } from 'node:crypto'
import type {
  ProviderAuthorizationAccountPolicyUpdate,
  ProviderAuthorizationAccountView,
  ProviderAuthorizationMutation,
  ProviderAuthorizationQuotaView,
  ProviderAuthorizationService
} from '../../shared/provider-authorization-types'
import type { Provider, ProviderCredentialRoutingMode, ProviderView } from '../../shared/types'
import { getProvider, toView, updateProvider } from '../providers'
import { normalizeProviderCredentialRoutingMode } from '../providerKeyRouting'
import {
  listProviderAuthorizationAccountsFromStore,
  markStoredProviderAuthorizationAccountFailure,
  recordStoredProviderAuthorizationQuota,
  updateStoredProviderAuthorizationAccountPolicy
} from './providerAuthorizationStore'
import {
  selectProviderAuthorizationAccount,
  type ProviderAuthorizationRoutingDecision
} from './providerAuthorizationRouting'

const quotaCache = new Map<string, ProviderAuthorizationQuotaView>()

export function listProviderAuthorizationAccounts(providerId: string): ProviderAuthorizationAccountView[] {
  const provider = getProvider(providerId.trim())
  if (!provider || provider.engine !== 'openai') throw new Error('Provider was not found')
  if (!provider.authorization?.provider) return []
  const accounts = storedAccounts(provider)
  const decision = authorizationAccountDecision(provider, accounts)
  return accounts.map((account) => ({
    ...account,
    quota: quotaCache.get(quotaCacheKey(providerId, account.service, account.id)) ?? account.lastQuota,
    routingState: decision.account?.id === account.id
      ? 'selected'
      : decision.blocked.has(account.id) ? 'blocked' : 'available',
    routingReason: decision.account?.id === account.id
      ? decision.reason
      : decision.blocked.get(account.id) ?? '可用于自动路由'
  }))
}

export function updateProviderAuthorizationRoutingMode(
  providerId: string,
  mode: ProviderCredentialRoutingMode
): ProviderView {
  const provider = requireAuthorizedProvider(providerId)
  return updateProvider(providerId, {
    authorization: {
      ...provider.authorization!,
      accountRoutingMode: normalizeProviderCredentialRoutingMode(mode)
    }
  })
}

export function updateProviderAuthorizationAccountPolicy(
  providerId: string,
  input: ProviderAuthorizationAccountPolicyUpdate
): ProviderView {
  const provider = requireAuthorizedProvider(providerId)
  updateStoredProviderAuthorizationAccountPolicy(
    providerId,
    input.accountId,
    provider.authorization!.provider!,
    input.policy
  )
  return toView(provider)
}

export function applyProviderAuthorizationMutation(
  providerId: string,
  accountId: string,
  mutation: ProviderAuthorizationMutation
): ProviderView {
  return mutation.kind === 'routing-mode'
    ? updateProviderAuthorizationRoutingMode(providerId, mutation.mode)
    : updateProviderAuthorizationAccountPolicy(providerId, { accountId, policy: mutation.policy })
}

export function resolveProviderAuthorizationAccountSelection(
  provider: Provider,
  explicitAccountId?: string,
  excludedAccountIds?: ReadonlySet<string>,
  now = Date.now()
): ProviderAuthorizationRoutingDecision {
  return authorizationAccountDecision(provider, storedAccounts(provider), explicitAccountId, excludedAccountIds, now)
}

export function providerAuthorizationAccountKeyId(provider: Provider, accountId: string): string {
  const service = requireService(provider)
  const digest = createHash('sha256').update(`${provider.id}:${service}:${accountId}`).digest('hex')
  return `oauth-app-binding:${service}:${digest}`
}

export function markProviderAuthorizationAccountFailure(
  provider: Provider,
  accountId: string,
  failedAt = Date.now()
): ProviderAuthorizationRoutingDecision {
  markStoredProviderAuthorizationAccountFailure(provider.id, accountId, requireService(provider), failedAt)
  return resolveProviderAuthorizationAccountSelection(provider, undefined, new Set([accountId]), failedAt)
}

export function recordProviderAuthorizationQuota(quota: ProviderAuthorizationQuotaView, service: ProviderAuthorizationService): void {
  quotaCache.set(quotaCacheKey(quota.providerId, service, quota.accountId), quota)
  recordStoredProviderAuthorizationQuota(quota, service)
}

export function removeProviderAuthorizationRoutingState(providerId: string): void {
  for (const key of quotaCache.keys()) {
    if (key.startsWith(`${providerId}:`)) quotaCache.delete(key)
  }
}

export function markProviderAuthorizationError(
  providerId: string,
  service: ProviderAuthorizationService,
  status: 'expired' | 'error',
  code: string
): void {
  const provider = getProvider(providerId)
  if (!provider) return
  updateProvider(providerId, {
    authorization: {
      ...provider.authorization!,
      method: provider.authorization?.method ?? 'device-code',
      status,
      provider: service,
      lastErrorCode: code,
      accountRoutingMode: provider.authorization?.accountRoutingMode ?? 'preferred'
    }
  })
}

function authorizationAccountDecision(
  provider: Provider,
  accounts: ProviderAuthorizationAccountView[],
  explicitAccountId?: string,
  excludedAccountIds?: ReadonlySet<string>,
  now = Date.now()
): ProviderAuthorizationRoutingDecision {
  const quotas = new Map<string, ProviderAuthorizationQuotaView>()
  for (const account of accounts) {
    const quota = quotaCache.get(quotaCacheKey(provider.id, account.service, account.id))
    if (quota) quotas.set(account.id, quota)
  }
  return selectProviderAuthorizationAccount(accounts, {
    activeAccountId: provider.authorization?.accountId,
    routingMode: provider.authorization?.accountRoutingMode,
    explicitAccountId,
    excludedAccountIds,
    quotas,
    now
  })
}

function storedAccounts(provider: Provider): ProviderAuthorizationAccountView[] {
  return listProviderAuthorizationAccountsFromStore(
    provider.id,
    provider.authorization?.accountId,
    requireService(provider)
  )
}

function requireAuthorizedProvider(providerId: string): Provider {
  const provider = getProvider(providerId.trim())
  if (!provider || provider.engine !== 'openai') throw new Error('Provider was not found')
  requireService(provider)
  return provider
}

function requireService(provider: Provider): ProviderAuthorizationService {
  const service = provider.authorization?.provider
  if (!service) throw new Error('Provider authorization service is not configured')
  return service
}

function quotaCacheKey(providerId: string, service: ProviderAuthorizationService, accountId: string): string {
  return `${providerId}:${service}:${accountId}`
}
