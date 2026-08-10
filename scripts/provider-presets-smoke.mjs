import { readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const store = readFileSync(path.join(repoRoot, 'src/renderer/src/store.ts'), 'utf8')
const editor = readFileSync(path.join(repoRoot, 'src/renderer/src/components/ProviderEditor.tsx'), 'utf8')
const quickSetup = readFileSync(path.join(repoRoot, 'src/renderer/src/components/ProviderQuickSetup.tsx'), 'utf8')
const catalog = readFileSync(path.join(repoRoot, 'src/renderer/src/components/ProviderPresetCatalog.tsx'), 'utf8')
const settings = readFileSync(path.join(repoRoot, 'src/main/settings.ts'), 'utf8')
const providers = readFileSync(path.join(repoRoot, 'src/main/providers.ts'), 'utf8')

const relayPreset = extractPreset(store, 'caogen-relay')

assert(relayPreset, 'CaoGen relay preset is missing')
assert(relayPreset.includes("baseUrl: 'https://ciyuan2api.com'"), 'CaoGen relay preset must keep the configured Base URL')
assert(
  editor.includes("const DEFAULT_PROVIDER_BASE_URL = PROVIDER_PRESETS.find((preset) => preset.key === 'caogen-relay')?.baseUrl ?? ''") &&
    editor.includes('provider?.baseUrl ?? DEFAULT_PROVIDER_BASE_URL'),
  'new Provider editor must prefill the default Base URL without replacing an existing Provider value'
)
assert(relayPreset.includes("models: []"), 'CaoGen relay preset must not pretend to know live models before service/config is available')
assert(relayPreset.includes("openaiProtocol: 'chat'"), 'CaoGen relay preset should use the generic OpenAI-compatible Chat protocol')
assert(relayPreset.includes('请填写自己的 API Key'), 'CaoGen relay preset must tell users to configure their own API key')
assert(relayPreset.includes('再用“获取模型”确认可用模型'), 'CaoGen relay preset must require explicit model availability confirmation')
assert(settings.includes("defaultProviderId: ''"), 'settings must not default to the CaoGen relay provider')
assert(!providers.includes('caogen-relay'), 'main process must not inject the CaoGen relay as a hidden first-run provider')
assert(editor.includes('<ProviderQuickSetup'), 'new Provider flow must route through the quick setup component')
assert(quickSetup.includes('data-provider-quick-setup'), 'new Provider flow must expose the quick setup surface')
assert(quickSetup.includes("useState('caogen-relay')"), 'quick setup must select the explicit relay preset instead of a hidden provider')
assert(
  quickSetup.includes('<ProviderPresetCatalog compact presets={QUICK_API_PRESETS}'),
  'quick setup must expose the searchable Provider preset catalog'
)
assert(editor.includes('<ProviderPresetCatalog'), 'advanced setup must expose the Provider preset catalog')
assert(catalog.includes('providerCatalogSearch'), 'Provider preset catalog must support search')
assert(catalog.includes("['all', 'official', 'aggregator', 'gateway', 'local']"), 'Provider preset catalog must support category filters')
assert(catalog.includes('preset.models') && catalog.includes('preset.searchTerms'), 'Provider preset search must cover models and aliases')
assert((store.match(/category: '(?:official|aggregator|gateway|local)'/g) ?? []).length >= 8, 'Provider catalog must include classified presets')
for (const key of ['openrouter', 'groq', 'mistral', 'together', 'fireworks', 'perplexity', 'siliconflow', 'azure-openai']) {
  assert(extractPreset(store, key), `Provider catalog preset is missing: ${key}`)
}
assert(quickSetup.includes('data-provider-quick-field="base-url"'), 'quick setup must allow the preset Base URL to be edited')
assert(quickSetup.includes('providerQuickUseManualModels'), 'quick setup must allow manual models when a Provider has no model catalog')
assert(quickSetup.includes('fetchProviderModels'), 'quick setup must verify the endpoint and discover live models before saving')
assert(quickSetup.includes('defaultProviderId: created.id'), 'quick setup must make the verified Provider immediately usable')
assert(quickSetup.includes('activateLocalCompute'), 'quick setup must offer zero-key local compute activation')
assert(quickSetup.includes('providerQuickUseLocal'), 'quick setup must expose the local compute action')
assert(editor.includes('setAdvanced(true)'), 'quick setup must preserve an explicit custom Provider path')

console.log('provider presets smoke ok')

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}

function extractPreset(source, key) {
  const keyIndex = source.indexOf(`key: '${key}'`)
  if (keyIndex === -1) return ''
  const start = source.lastIndexOf('{', keyIndex)
  const end = source.indexOf('\n  },', keyIndex)
  if (start === -1 || end === -1) return ''
  return source.slice(start, end)
}
