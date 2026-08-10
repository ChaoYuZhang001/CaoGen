import type { Provider } from '../../shared/types'
import type {
  ProviderBillingQueryCapabilityView,
  ProviderBillingSyncInput,
  ProviderBillingSyncResult
} from '../../shared/provider-billing-query-types'
import { getProvider, issueProviderCredentialLease } from '../providers'
import type { ProviderCredentialLease } from '../providerCredentialBroker'
import { fetchWithProviderCredentialLease } from '../providerRuntimeAuth'
import { ensureProviderAuthorizationFresh } from './providerAuthorizationService'
import { saveStoredProviderBillingStatement } from './providerBillingStore'
import {
  buildProviderBillingRequest as buildBillingRequest,
  executeProviderBillingRequest,
  resolveProviderBillingKeyId
} from './providerBillingQuery'

export {
  buildProviderBillingRequest,
  executeProviderBillingRequest,
  extractProviderBilledCostUsd,
  resolveProviderBillingKeyId
} from './providerBillingQuery'

export function inspectProviderBillingQuery(providerId: string): ProviderBillingQueryCapabilityView {
  const provider = requireProvider(providerId)
  const config = provider.advancedConfig?.billingQuery
  if (!config) return { providerId: provider.id, supported: false }
  return {
    providerId: provider.id,
    supported: true,
    credentialMode: config.credentialMode ?? 'provider',
    ...(config.keyLabel ? { keyLabel: config.keyLabel } : {})
  }
}

export async function syncProviderBillingStatement(
  input: ProviderBillingSyncInput,
  fetchImpl: typeof fetch = fetch,
  now = Date.now()
): Promise<ProviderBillingSyncResult> {
  const period = validPeriod(input, now)
  let provider = requireProvider(input.providerId)
  if (provider.authorization?.provider && provider.authorization.status === 'authorized') {
    await ensureProviderAuthorizationFresh(provider.id, fetchImpl, now).catch(() => undefined)
    provider = requireProvider(provider.id)
  }
  const config = provider.advancedConfig?.billingQuery
  if (!config) return unavailable(provider.id, now, 'billing_query_not_configured')

  let requestProvider: Provider = provider
  let lease: ProviderCredentialLease | undefined
  const scope = {
    providerId: provider.id,
    projectId: 'system:provider-billing',
    sessionId: `provider-billing:${provider.id}`,
    operationId: `billing:${period.periodStart}:${period.periodEnd}`
  }
  if ((config.credentialMode ?? 'provider') === 'provider' && provider.authMode !== 'none') {
    const keyId = resolveProviderBillingKeyId(provider, config.keyLabel)
    if (config.keyLabel && !keyId) return unavailable(provider.id, now, 'billing_key_not_found')
    const selection = issueProviderCredentialLease(provider, scope, {}, keyId)
    if (!selection.available || !selection.lease) return unavailable(provider.id, now, 'credential_unavailable')
    lease = selection.lease
  } else if ((config.credentialMode ?? 'provider') === 'none') {
    requestProvider = { ...provider, authMode: 'none' }
  }

  const request = buildBillingRequest(provider.baseUrl, config, period)
  if (!request) return unavailable(provider.id, now, 'billing_endpoint_untrusted')
  const result = await executeProviderBillingRequest(request, config.response, (url, init) =>
    fetchWithProviderCredentialLease({
      provider: requestProvider,
      lease,
      scope,
      url,
      init,
      fetch: fetchImpl
    }))
  if (result.status !== 'ready') return unavailable(provider.id, now, result.errorCode, result.status)
  const statement = saveStoredProviderBillingStatement({
    providerId: provider.id,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    billedCostUsd: result.billedCostUsd,
    source: 'provider-api'
  }, now)
  return { providerId: provider.id, status: 'ready', queriedAt: now, statement }
}

function validPeriod(input: ProviderBillingSyncInput, now: number): ProviderBillingSyncInput {
  const providerId = input.providerId.trim()
  if (!providerId || !Number.isSafeInteger(input.periodStart) || !Number.isSafeInteger(input.periodEnd)
    || input.periodStart < 0 || input.periodEnd <= input.periodStart || input.periodEnd > now + 5 * 60_000
    || input.periodEnd - input.periodStart > 5 * 366 * 24 * 60 * 60_000) {
    throw new Error('Provider billing sync period is invalid')
  }
  return { providerId, periodStart: input.periodStart, periodEnd: input.periodEnd }
}

function requireProvider(providerId: string): Provider {
  const provider = getProvider(providerId.trim())
  if (!provider) throw new Error('Provider was not found')
  return provider
}

function unavailable(
  providerId: string,
  queriedAt: number,
  errorCode: string,
  status: ProviderBillingSyncResult['status'] = 'unavailable'
): ProviderBillingSyncResult {
  return { providerId, status, queriedAt, errorCode }
}
