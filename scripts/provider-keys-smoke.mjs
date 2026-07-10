import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const providers = read('src/main/providers.ts')
const types = read('src/shared/types.ts')
const editor = read('src/renderer/src/components/ProviderEditor.tsx')
const controlCenter = read('src/renderer/src/controlCenter.ts')

assert(types.includes('export interface ProviderApiKey'), 'ProviderApiKey storage type is missing')
assert(types.includes('export interface ProviderApiKeyView'), 'ProviderApiKeyView metadata type is missing')
assert(types.includes('lastFailureReason?: string'), 'Provider key view must expose sanitized failure metadata')
assert(types.includes('additionalTokens?: ProviderApiKeyInput[]'), 'ProviderInput must support adding multiple API keys')
assert(types.includes('keyUpdates?: ProviderApiKeyUpdateInput[]'), 'ProviderInput must support key metadata updates')
assert(types.includes('removeKeyIds?: string[]'), 'ProviderInput must support key removal without exposing secrets')

assert(providers.includes('function normalizedProviderKeys'), 'providers.ts must normalize legacy and multi-key storage')
assert(providers.includes('export function decryptProviderToken'), 'providers.ts must expose active-key decryption helper')
assert(providers.includes('export function rotateProviderKey'), 'providers.ts must support automatic key rotation')
assert(providers.includes('legacyKeyId(provider.id)'), 'legacy encryptedToken must migrate into a deterministic key view')
assert(providers.includes('apiKeys,'), 'create/update provider path must persist apiKeys')
assert(providers.includes('activeKeyId'), 'provider storage must track activeKeyId')
assert(providers.includes('encryptedToken: activeKey?.encryptedToken ??'), 'legacy encryptedToken mirror must follow active key')
assert(!providers.includes('caogen-relay'), 'provider key storage must not inject a hidden relay provider')

for (const file of walk(path.join(repoRoot, 'src/main'))) {
  if (!file.endsWith('.ts')) continue
  const rel = path.relative(repoRoot, file)
  const source = read(rel)
  if (rel === 'src/main/providers.ts') continue
  assert(
    !source.includes('decryptToken(provider.encryptedToken)'),
    `${rel} still decrypts provider.encryptedToken directly`
  )
}

assert(editor.includes('SavedKeyRow'), 'ProviderEditor must render saved key metadata rows')
assert(editor.includes("t('apiKeyLastFailure'"), 'ProviderEditor must show key failure metadata')
assert(editor.includes('additionalApiKeysLabel'), 'ProviderEditor must expose additional API key input')
assert(editor.includes('type="password"'), 'ProviderEditor must keep API key entry as a password field')
assert(!editor.includes('encryptedToken'), 'ProviderEditor must not render encrypted token fields')

assert(controlCenter.includes('totalKeys'), 'Control Center summary must include total key count')
assert(controlCenter.includes('activeKeyLabel'), 'Control Center provider rows must expose active key label metadata')

console.log('provider keys smoke ok')

function read(relPath) {
  return readFileSync(path.join(repoRoot, relPath), 'utf8')
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}

function walk(root) {
  const entries = []
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) entries.push(...walk(full))
    else entries.push(full)
  }
  return entries
}
