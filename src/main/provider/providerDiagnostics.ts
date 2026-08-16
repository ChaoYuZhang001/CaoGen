import type {
  Provider,
  ProviderApiKey,
  ProviderAuthMode,
  ProviderDiagnosticCredentialSource,
  ProviderGenerationProbeInput,
  ProviderGenerationProbeResult,
  ProviderModelFetchInput,
  ProviderModelFetchResult
} from '../../shared/types'
import { inspectProviderCustomHeaders } from '../providerCredentialBroker'
import { normalizeProviderAuthMode } from './providerAuthMode'
import { normalizedCredentialHeaderNames, providerCredentialHeaders } from './providerCredentialHeaders'
import { executeProviderGenerationProbe } from './generationProbe'
import { discoverProviderModels, parseProviderHeaderLines } from './modelDiscovery'
import { bindProviderModelDiscoveryInput } from './modelDiscoveryBinding'

export interface ProviderDiagnosticsDependencies {
  getProvider(id: string): Provider | undefined
  providerAuthMode(provider: Provider | undefined): ProviderAuthMode
  decryptProviderToken(provider: Provider | undefined): string
  selectedKey(provider: Provider): ProviderApiKey | undefined
  recordProbeSuccess(providerId: string, latencyMs?: number): void
  recordProbeFailure(providerId: string, message?: string): void
}

export async function fetchProviderModels(
  opts: ProviderModelFetchInput,
  dependencies: ProviderDiagnosticsDependencies
): Promise<ProviderModelFetchResult> {
  const provider = savedProviderFor(opts, dependencies)
  const bound = bindProviderModelDiscoveryInput(opts, provider)
  const input = {
    ...bound.input,
    authMode: normalizeProviderAuthMode(bound.input.authMode, bound.input.baseUrl, 'openai')
  }
  const credentialProvider = bound.usesStoredCredential ? provider : undefined
  return discoverProviderModels(
    input,
    () => resolveModelDiscoveryCredentials(input, credentialProvider, dependencies),
    {
      success: dependencies.recordProbeSuccess,
      failure: dependencies.recordProbeFailure
    }
  )
}

export async function probeProviderGenerationTarget(
  opts: ProviderGenerationProbeInput,
  dependencies: ProviderDiagnosticsDependencies
): Promise<ProviderGenerationProbeResult> {
  const provider = savedProviderFor(opts, dependencies)
  const bound = bindProviderModelDiscoveryInput(opts, provider)
  const input: ProviderGenerationProbeInput = {
    ...bound.input,
    model: opts.model,
    authMode: normalizeProviderAuthMode(bound.input.authMode, bound.input.baseUrl, bound.input.engine ?? 'openai')
  }
  const credentialProvider = bound.usesStoredCredential ? provider : undefined
  const credentials = resolveModelDiscoveryCredentials(input, credentialProvider, dependencies)
  if (credentials.customHeaderRejections.length > 0) {
    throw new Error('Provider generation probe headers are invalid')
  }
  return executeProviderGenerationProbe(input, {
    headers: credentials.headers,
    headerNames: credentials.credentialHeaderNames ?? [],
    source: credentials.source,
    label: credentials.label,
    available: credentials.authMode === 'none' || Boolean(credentials.token)
  })
}

function savedProviderFor(
  opts: ProviderModelFetchInput,
  dependencies: ProviderDiagnosticsDependencies
): Provider | undefined {
  const providerId = opts.providerId?.trim()
  return providerId ? dependencies.getProvider(providerId) : undefined
}

function resolveModelDiscoveryCredentials(
  opts: ProviderModelFetchInput,
  provider: Provider | undefined,
  dependencies: ProviderDiagnosticsDependencies
) {
  const authMode = normalizeProviderAuthMode(
    dependencies.providerAuthMode(provider) === 'none' || opts.authMode === 'none' ? 'none' : 'api-key',
    opts.baseUrl,
    'openai'
  )
  const token = resolvedDiagnosticToken(opts, provider, authMode, dependencies)
  const credentialHeaderNames = normalizedCredentialHeaderNames(
    opts.credentialHeaderNames ?? provider?.credentialHeaderNames
  )
  const inspectedCustomHeaders = inspectProviderCustomHeaders(opts.customHeaders ?? provider?.customHeaders ?? '')
  const selectedKey = provider && authMode !== 'none' ? dependencies.selectedKey(provider) : undefined
  const source: ProviderDiagnosticCredentialSource = authMode === 'none'
    ? 'none'
    : provider
      ? 'stored-active'
      : 'explicit'
  return {
    authMode,
    token,
    source,
    label: selectedKey?.label,
    credentialHeaderNames,
    customHeaderRejections: inspectedCustomHeaders.rejectedNames,
    headers: {
      ...parseProviderHeaderLines(inspectedCustomHeaders.safeValue),
      ...providerCredentialHeaders({ credentialHeaderNames, authMode }, token)
    }
  }
}

function resolvedDiagnosticToken(
  opts: ProviderModelFetchInput,
  provider: Provider | undefined,
  authMode: ProviderAuthMode,
  dependencies: ProviderDiagnosticsDependencies
): string {
  if (authMode === 'none') return ''
  return opts.token?.trim() || (provider ? dependencies.decryptProviderToken(provider) : '')
}
