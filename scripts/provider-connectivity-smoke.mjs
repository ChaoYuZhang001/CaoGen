import { readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const settingsModal = read('src/renderer/src/components/SettingsModal.tsx')
const providerList = read('src/renderer/src/components/settings/ProviderList.tsx')
const providerDiagnostic = read('src/renderer/src/components/ProviderConnectionDiagnostic.tsx')
const providers = read('src/main/providers.ts')
const modelDiscovery = read('src/main/provider/modelDiscovery.ts')
const providerHealth = read('src/main/providerHealth.ts')
const sessionManager = read('src/main/sessionManager.ts')

assert(settingsModal.includes('const probeProvider = async (p: ProviderView)'), 'SettingsModal must expose a provider connectivity probe')
assert(settingsModal.includes('window.agentDesk.fetchProviderModels'), 'provider probe must call the existing model fetch/health path')
assert(settingsModal.includes('providerId: p.id'), 'provider probe must use saved providerId instead of requiring plaintext token')
assert(!settingsModal.includes('token: p.'), 'provider probe must not pass provider token metadata from the renderer')
assert(settingsModal.includes('await updateProvider(p.id, { models: result.models })'), 'successful probe should sync fetched models into provider config')
assert(settingsModal.includes('window.agentDesk.listProviderHealth'), 'provider probe should refresh health after success/failure')
assert(settingsModal.includes("t('providerProbeOk'"), 'provider probe should show a success message')
assert(settingsModal.includes("t('providerProbeFailed'"), 'provider probe should show an explicit failure message')
assert(settingsModal.includes('onProbe={(provider) => void probeProvider(provider)}'), 'SettingsModal must wire the probe handler into ProviderList')
assert(providerList.includes('onClick={() => onProbe(provider)}'), 'provider list should invoke the probe handler for its provider')
assert(providerList.includes("t('providerProbe')"), 'provider list should render a probe button')
assert(providerDiagnostic.includes('error.diagnosticContext'), 'connection diagnostics must consume the main-process diagnostic context')
assert(providerDiagnostic.includes('context.generationEndpointPath'), 'connection diagnostics must expose the actual task request path')
assert(providerDiagnostic.includes('context.credentialSource'), 'connection diagnostics must expose whether the entered or saved credential was used')
assert(providerDiagnostic.includes("t('providerDiagnosticCatalogScope')"), 'connection diagnostics must disclose that model discovery is catalog-only')

assert(providers.includes('success: (providerId, latencyMs) => recordProbeSuccess(providerId, latencyMs)'), 'fetchModels success must record probe telemetry without resetting generation health')
assert(providers.includes('failure: (providerId, message) => recordProbeFailure(providerId, message)'), 'fetchModels failure must record probe telemetry without poisoning generation health')
assert(providerHealth.includes('export function recordProbeSuccess'), 'provider health must expose probe-success telemetry')
assert(providerHealth.includes('export function recordProbeFailure'), 'provider health must expose probe-failure telemetry')
assert(modelDiscovery.includes('health.success(context.providerId, latencyMs)'), 'successful model discovery must report provider latency')
assert(modelDiscovery.includes('health.failure(context.providerId, message)'), 'failed model discovery must report the provider error')
assert(modelDiscovery.includes('latencyMs,') && modelDiscovery.includes('stale: false'), 'successful model discovery must expose a fresh result with latency')
assert(modelDiscovery.includes('modelFetchCache.delete(context.cacheKey)') && modelDiscovery.includes('stale: true'), 'failed model discovery must clear cache state and expose a stale result')
assert(providers.includes('decryptProviderToken(provider)'), 'saved-provider model fetch must use the active key helper')
assert(
  providers.includes('providerCredentialHeaders({ credentialHeaderNames, authMode }, token)'),
  'model discovery must inject Broker-managed credential headers'
)
assert(
  !modelDiscovery.includes("...(token ? { 'x-api-key': token, authorization: `Bearer ${token}` } : {})")
    && modelDiscovery.includes('tryFetchModelsFrom(url, credentials.headers'),
  'model discovery must send only the resolved managed credential headers'
)
assert(
  providers.includes('bindProviderModelDiscoveryInput(opts, provider)')
    && providers.includes('const credentialProvider = bound.usesStoredCredential ? provider : undefined')
    && providers.includes('resolveModelDiscoveryCredentials(input, credentialProvider)')
    && providers.includes('discoverProviderModels(input,'),
  'saved-provider model discovery must bind stored credentials to the saved network target'
)
assert(
  providerHealth.includes("health.circuitState === 'closed'")
    && providerHealth.includes('health.consecutiveFailures >= config.failureThreshold')
    && providerHealth.includes('health.circuitTotalRequests >= config.minRequests')
    && providerHealth.includes('errorRate >= config.errorRateThreshold')
    && providerHealth.includes('transitionToOpen(health, now)'),
  'provider health should open the circuit after its configured consecutive-failure or error-rate threshold'
)
assert(providerHealth.includes("'provider-health.json'"), 'provider health should persist under userData')
assert(providerHealth.includes('recentFailures'), 'provider health should retain bounded recent failure records')
assert(providerHealth.includes('sanitizeFailureMessage'), 'persisted provider failures should be sanitized')
assert(
  sessionManager.includes("configureProviderHealthDir(app.getPath('userData'), getSettings().providerCircuitBreaker)"),
  'session startup should configure provider health persistence and circuit policy'
)

console.log('provider connectivity smoke ok')

function read(relPath) {
  return readFileSync(path.join(repoRoot, relPath), 'utf8')
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
