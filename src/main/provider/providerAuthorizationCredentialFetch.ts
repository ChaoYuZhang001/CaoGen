import { createHash, randomUUID } from 'node:crypto'
import type { Provider } from '../../shared/types'
import { issueDirectProviderCredentialLease, issueProviderCredentialLease } from '../providers'
import { fetchWithProviderCredentialLease } from '../providerRuntimeAuth'

export function providerAuthorizationAccountFetch(
  provider: Provider,
  accountId: string,
  keyId: string,
  accessToken: string,
  customHeaders: string,
  fetchImpl: typeof fetch
): typeof fetch {
  const scope = {
    providerId: provider.id,
    projectId: 'system:provider-quota',
    sessionId: `provider-quota:${provider.id}:${createHash('sha256').update(accountId).digest('hex').slice(0, 16)}`,
    operationId: randomUUID()
  }
  const credentialProvider = {
    authMode: 'api-key' as const,
    baseUrl: provider.baseUrl,
    credentialMigrationRequired: false,
    customHeaders,
    credentialHeaderNames: ['authorization']
  }
  const selection = issueDirectProviderCredentialLease(provider.id, keyId, accessToken, scope)
  if (!selection.available || !selection.lease) throw new Error('Provider authorization credential is unavailable')
  return leasedFetch(credentialProvider, selection.lease, scope, fetchImpl)
}

export function providerCredentialFetch(provider: Provider, fetchImpl: typeof fetch): typeof fetch {
  const scope = {
    providerId: provider.id,
    projectId: 'system:provider-quota',
    sessionId: `provider-quota:${provider.id}`,
    operationId: randomUUID()
  }
  const selection = issueProviderCredentialLease(provider, scope)
  if (!selection.available || !selection.lease) throw new Error('Provider authorization credential is unavailable')
  return leasedFetch(provider, selection.lease, scope, fetchImpl)
}

function leasedFetch(
  provider: Parameters<typeof fetchWithProviderCredentialLease>[0]['provider'],
  lease: NonNullable<Parameters<typeof fetchWithProviderCredentialLease>[0]['lease']>,
  scope: Parameters<typeof fetchWithProviderCredentialLease>[0]['scope'],
  fetchImpl: typeof fetch
): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const { headers, ...requestInit } = init ?? {}
    return fetchWithProviderCredentialLease({
      provider,
      lease,
      scope,
      url,
      init: { ...requestInit, headers: Object.fromEntries(new Headers(headers).entries()) },
      fetch: fetchImpl
    })
  }
}
