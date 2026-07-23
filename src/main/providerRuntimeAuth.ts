import type { Provider } from '../shared/types'
import { providerCredentialHeaderLines, providerCredentialHeaders } from './providers'

const CLAUDE_HOST_CREDENTIAL_KEYS = [
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_HOST_CREDS_FILE',
  'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
  'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS'
] as const

type RuntimeCredentialProvider = Pick<Provider, 'baseUrl' | 'customHeaders' | 'credentialHeaderNames'>

export function applyClaudeProviderEnvironment(
  env: NodeJS.ProcessEnv,
  provider: RuntimeCredentialProvider,
  token: string
): void {
  clearClaudeHostCredentials(env)
  delete env.ANTHROPIC_CUSTOM_HEADERS
  if (provider.baseUrl) env.ANTHROPIC_BASE_URL = provider.baseUrl
  if (token) {
    env.ANTHROPIC_AUTH_TOKEN = token
    env.ANTHROPIC_API_KEY = token
  }
  const customHeaders = [
    provider.customHeaders?.trim(),
    providerCredentialHeaderLines(provider, token)
  ].filter(Boolean).join('\n')
  if (customHeaders) env.ANTHROPIC_CUSTOM_HEADERS = customHeaders
}

export function mergeProviderCredentialHeaders(
  provider: RuntimeCredentialProvider | undefined,
  token: string,
  headers: Record<string, string>
): Record<string, string> {
  return { ...headers, ...providerCredentialHeaders(provider, token) }
}

function clearClaudeHostCredentials(env: NodeJS.ProcessEnv): void {
  for (const key of CLAUDE_HOST_CREDENTIAL_KEYS) delete env[key]
}
