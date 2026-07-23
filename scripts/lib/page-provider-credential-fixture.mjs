import { statSync } from 'node:fs'
import path from 'node:path'

export function assertRelayProviderPersistence({
  settingsBefore,
  settingsAfter,
  providers,
  providerListText,
  userDataDir,
  legacyProviderId,
  assert
}) {
  assert(settingsAfter.defaultProviderId === settingsBefore.defaultProviderId, 'relay template save should not set a default provider')
  assert(settingsAfter.defaultModel === settingsBefore.defaultModel, 'relay template save should not set a default model')

  const relay = providers.find((provider) => provider.name === 'CaoGen Relay UI Smoke')
  assert(relay, 'saved relay provider not found')
  assert(relay.id !== 'caogen-relay', 'preset key must not be persisted as a hidden provider id')
  assert(relay.baseUrl === 'https://gpt.zhangrui.xyz/dashboard', `unexpected relay baseUrl: ${relay.baseUrl}`)
  assert(relay.openaiProtocol === 'chat', `unexpected relay protocol: ${relay.openaiProtocol}`)
  assert(
    JSON.stringify(relay.credentialHeaderNames) === JSON.stringify(['api-key', 'ocp-apim-subscription-key']),
    `managed credential header names were not persisted safely: ${JSON.stringify(relay.credentialHeaderNames)}`
  )
  assert(JSON.stringify(relay.models) === JSON.stringify(['caogen-relay-fast', 'caogen-relay-strong']), `unexpected relay models: ${JSON.stringify(relay.models)}`)
  assert(Array.isArray(relay.apiKeys), `relay key metadata must be an array: ${JSON.stringify(relay.apiKeys)}`)
  const relayIsSessionOnly = providerListText.includes('仅本次运行')
  const relayHasMixedStorage = providerListText.includes('混合存储状态')
  if (relayIsSessionOnly) {
    assert(relay.apiKeys.length === 0, `session-only relay must persist zero keys: ${JSON.stringify(relay.apiKeys)}`)
  } else if (relayHasMixedStorage) {
    assert(relay.apiKeys.length === 1, `mixed relay must persist only its encrypted key: ${JSON.stringify(relay.apiKeys)}`)
  } else {
    assert(relay.apiKeys.length === 2, `secure relay must persist primary + backup keys: ${JSON.stringify(relay.apiKeys)}`)
  }
  assert(relay.apiKeys.every((key) => /^enc:/.test(key.encryptedToken)), 'persisted relay keys must use secure encryption only')
  assert(relay.apiKeys.every((key) => key.sessionOnly !== true), 'session-only markers must not be persisted')
  assert(!JSON.stringify(relay).includes('sk-page-smoke'), 'relay provider must not persist plaintext API keys')
  assert(!JSON.stringify(relay).includes('b64:'), 'relay provider must not persist reversible base64 credentials')
  if (relay.apiKeys.length > 0) {
    assert(relay.activeKeyId === relay.apiKeys[0].id, 'first securely persisted relay key should be active after creation')
  } else {
    assert(!relay.activeKeyId, 'session-only provider must not persist an active key reference')
  }
  const legacyFixture = providers.find((provider) => provider.id === legacyProviderId)
  assert(legacyFixture, 'legacy provider fixture must remain present after startup migration')
  if (JSON.stringify(legacyFixture).includes('b64:')) {
    assert(providerListText.includes('旧密钥待迁移'), 'unmigrated legacy key must be visible as pending migration')
  } else {
    assert(JSON.stringify(legacyFixture).includes('enc:'), 'legacy key must migrate to encrypted storage when secure storage is available')
  }
  if (process.platform !== 'win32') {
    const mode = statSync(path.join(userDataDir, 'providers.json')).mode & 0o777
    assert(mode === 0o600, `providers.json permissions must be 0600, got ${mode.toString(8)}`)
  }
}
