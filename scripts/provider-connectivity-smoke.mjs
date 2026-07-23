import { readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const settingsModal = read('src/renderer/src/components/SettingsModal.tsx')
const providerList = read('src/renderer/src/components/settings/ProviderList.tsx')
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

assert(providers.includes('success: (providerId, latencyMs) => recordSuccess(providerId, latencyMs)'), 'fetchModels success must wire provider latency to the scheduler')
assert(providers.includes('failure: (providerId, message) => recordFailure(providerId, message)'), 'fetchModels failure must wire provider errors to the scheduler')
assert(modelDiscovery.includes('health.success(context.providerId, latencyMs)'), 'successful model discovery must report provider latency')
assert(modelDiscovery.includes('health.failure(context.providerId, message)'), 'failed model discovery must report the provider error')
assert(modelDiscovery.includes('latencyMs,') && modelDiscovery.includes('stale: false'), 'successful model discovery must expose a fresh result with latency')
assert(modelDiscovery.includes('modelFetchCache.delete(context.cacheKey)') && modelDiscovery.includes('stale: true'), 'failed model discovery must clear cache state and expose a stale result')
assert(providers.includes('decryptProviderToken(provider)'), 'saved-provider model fetch must use the active key helper')
assert(
  providers.includes('providerCredentialHeaders({ credentialHeaderNames }, token)'),
  'model discovery must inject Broker-managed credential headers'
)
assert(
  providers.includes('bindProviderModelDiscoveryInput(opts, provider)')
    && providers.includes('bound.usesStoredCredential ? provider : undefined')
    && providers.includes('discoverProviderModels(bound.input'),
  'saved-provider model discovery must bind stored credentials to the saved network target'
)
assert(providerHealth.includes('health.consecutiveFailures < 3'), 'provider health should mark repeated failures unhealthy')
assert(providerHealth.includes("'provider-health.json'"), 'provider health should persist under userData')
assert(providerHealth.includes('recentFailures'), 'provider health should retain bounded recent failure records')
assert(providerHealth.includes('sanitizeFailureMessage'), 'persisted provider failures should be sanitized')
assert(sessionManager.includes("configureProviderHealthDir(app.getPath('userData'))"), 'session startup should configure provider health persistence')

console.log('provider connectivity smoke ok')

function read(relPath) {
  return readFileSync(path.join(repoRoot, relPath), 'utf8')
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
