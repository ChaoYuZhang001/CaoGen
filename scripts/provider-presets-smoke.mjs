import { readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const store = readFileSync(path.join(repoRoot, 'src/renderer/src/store.ts'), 'utf8')
const settings = readFileSync(path.join(repoRoot, 'src/main/settings.ts'), 'utf8')
const providers = readFileSync(path.join(repoRoot, 'src/main/providers.ts'), 'utf8')

const relayPreset = extractPreset(store, 'caogen-relay')

assert(relayPreset, 'CaoGen relay preset is missing')
assert(relayPreset.includes("baseUrl: 'https://gpt.zhangrui.xyz/dashboard'"), 'CaoGen relay preset must keep the configured Base URL')
assert(relayPreset.includes("models: []"), 'CaoGen relay preset must not pretend to know live models before service/config is available')
assert(relayPreset.includes("openaiProtocol: 'chat'"), 'CaoGen relay preset should use the generic OpenAI-compatible Chat protocol')
assert(relayPreset.includes('请填写自己的 API Key'), 'CaoGen relay preset must tell users to configure their own API key')
assert(relayPreset.includes('再用“获取模型”确认可用模型'), 'CaoGen relay preset must require explicit model availability confirmation')
assert(settings.includes("defaultProviderId: ''"), 'settings must not default to the CaoGen relay provider')
assert(!providers.includes('caogen-relay'), 'main process must not inject the CaoGen relay as a hidden first-run provider')

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
