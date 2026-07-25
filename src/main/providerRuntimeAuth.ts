import type { Provider } from '../shared/types'
import { providerCredentialHeaders } from './providers'

type RuntimeCredentialProvider = Pick<Provider, 'baseUrl' | 'customHeaders' | 'credentialHeaderNames'>

export function mergeProviderCredentialHeaders(
  provider: RuntimeCredentialProvider | undefined,
  token: string,
  headers: Record<string, string>
): Record<string, string> {
  return { ...headers, ...providerCredentialHeaders(provider, token) }
}
