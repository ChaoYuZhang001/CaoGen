import { readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const settingsModal = read('src/renderer/src/components/SettingsModal.tsx')
const providers = read('src/main/providers.ts')
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
assert(settingsModal.includes("t('providerProbe')"), 'provider list should render a probe button')

assert(providers.includes('recordSuccess(providerId, latencyMs)'), 'fetchModels success must record provider latency')
assert(providers.includes('recordFailure(providerId, message)'), 'fetchModels failure must record provider error')
assert(providers.includes('decryptProviderToken(p)'), 'saved-provider model fetch must use the active key helper')
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
