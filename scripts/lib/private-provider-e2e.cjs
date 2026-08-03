const path = require('node:path')
const { pathToFileURL } = require('node:url')

const REAL_PROVIDER_OPT_IN_ENV = 'CAOGEN_REAL_PROVIDER_E2E'
const rawStdoutWrite = process.stdout.write.bind(process.stdout)

async function loadPrivateChatProvider(repoRoot, options = {}) {
  const enabled = options.enabled ?? process.env[REAL_PROVIDER_OPT_IN_ENV] === '1'
  if (!enabled) return { state: 'skipped', code: 'real_provider_opt_in_required' }

  try {
    const helperUrl = pathToFileURL(path.join(repoRoot, 'scripts', 'lib', 'private-provider-config.mjs')).href
    const { resolvePrivateProviderConfig } = await import(helperUrl)
    const resolved = resolvePrivateProviderConfig({
      repoRoot,
      ...(options.homeDirectory ? { homeDirectory: options.homeDirectory } : {})
    })
    const providers = JSON.parse(resolved.text.replace(/^\uFEFF/, ''))
    const provider = selectPrivateChatProvider(providers)
    return provider
      ? { state: 'ready', provider }
      : { state: 'blocked', code: 'private_chat_provider_missing' }
  } catch {
    return { state: 'blocked', code: 'private_provider_config_unavailable' }
  }
}

function selectPrivateChatProvider(providers) {
  if (!Array.isArray(providers)) return undefined
  const candidates = providers.flatMap((item, index) => {
    if (!item || typeof item !== 'object' || item.apiFormat !== 'openai-compatible') return []
    const baseUrl = privateString(item.baseUrl)
    const model = privateString(item.model)
    const apiKey = privateString(item.apiKey)
    if (!baseUrl || !model || !apiKey) return []
    return [{
      baseUrl,
      model,
      apiKey,
      priority: item.group === 'baseline' ? 0 : 1,
      index
    }]
  })
  candidates.sort((left, right) => left.priority - right.priority || left.index - right.index)
  const selected = candidates[0]
  return selected
    ? { baseUrl: selected.baseUrl, model: selected.model, apiKey: selected.apiKey }
    : undefined
}

function privateString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function suppressRuntimeConsole() {
  console.log = () => undefined
  console.info = () => undefined
  console.warn = () => undefined
  console.error = () => undefined
}

function writePublicLine(value = '') {
  rawStdoutWrite(`${String(value)}\n`)
}

module.exports = {
  REAL_PROVIDER_OPT_IN_ENV,
  loadPrivateChatProvider,
  suppressRuntimeConsole,
  writePublicLine
}
