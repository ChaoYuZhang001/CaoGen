import type { Provider, SessionMeta } from '../shared/types'
import type {
  ProviderCredentialLease,
  ProviderCredentialLeaseScope
} from './providerCredentialBroker'
import { redeemProviderCredentialLease } from './providerCredentialRuntime'
import { providerCredentialHeaders } from './provider/providerCredentialHeaders'

type RuntimeCredentialProvider = Pick<
  Provider,
  'authMode' | 'baseUrl' | 'credentialMigrationRequired' | 'customHeaders' | 'credentialHeaderNames'
>

export function mergeProviderCredentialHeaders(
  provider: RuntimeCredentialProvider | undefined,
  token: string,
  headers: Record<string, string>
): Record<string, string> {
  return { ...headers, ...providerCredentialHeaders(provider, token) }
}

export interface ProviderCredentialFetchInput {
  provider: RuntimeCredentialProvider | undefined
  lease?: ProviderCredentialLease
  scope: ProviderCredentialLeaseScope
  url: string
  init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> }
  fetch?: typeof fetch
}

export async function fetchWithProviderCredentialLease(
  input: ProviderCredentialFetchInput
): Promise<Response> {
  const authMode = input.provider?.authMode === 'none' ? 'none' : 'api-key'
  if (authMode !== 'none' && !input.lease) {
    throw new Error('Provider credential lease is unavailable')
  }
  const token = input.lease
    ? redeemProviderCredentialLease(input.lease, input.scope).token
    : ''
  const headers = mergeProviderCredentialHeaders(input.provider, token, input.init.headers ?? {})
  return (input.fetch ?? fetch)(input.url, { ...input.init, headers })
}

export function providerCredentialScopeForSession(
  meta: Pick<SessionMeta, 'id' | 'workspaceId' | 'projectId'>,
  providerId: string,
  operationId: string
): ProviderCredentialLeaseScope {
  return {
    providerId,
    projectId: meta.workspaceId?.trim() || meta.projectId?.trim() || `unassigned:${meta.id}`,
    sessionId: meta.id,
    operationId
  }
}
