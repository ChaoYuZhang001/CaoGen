#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (file) => readFileSync(path.join(root, file), 'utf8')
const packageJson = JSON.parse(read('package.json'))

assert.deepEqual(
  Object.keys(packageJson.dependencies ?? {}).filter((name) => name.includes('claude-agent-sdk')),
  [],
  'Claude Agent SDK must not be a production dependency'
)
assert.equal(packageJson.scripts?.['prepare:mac-binaries'], undefined)
assert.equal(packageJson.build?.afterPack, undefined)
assert(
  !(packageJson.build?.asarUnpack ?? []).some((entry) => entry.includes('claude-agent-sdk')),
  'Claude Agent SDK must not be unpacked into distributions'
)

for (const file of [
  'src/main/agentSession.ts',
  'src/main/claude-sdk-loader.ts',
  'src/main/protocol-adapters/claude-agent-sdk.ts',
  'src/main/provider/claudeRuntimePolicy.ts',
  'src/main/task/claude-model-attempt-runtime.ts',
  'scripts/prepare-mac-binaries.cjs',
  'scripts/after-pack.cjs'
]) {
  assert.equal(existsSync(path.join(root, file)), false, `${file} must be removed`)
}

const sharedTypes = read('src/shared/types.ts')
assert.match(sharedTypes, /export type EngineKind = 'anthropic' \| 'gemini' \| 'openai'/)
assert.doesNotMatch(sharedTypes, /EngineKind = [^\n]*'claude'/)

const engines = read('src/main/engines.ts')
assert.match(engines, /kind: 'anthropic'/)
assert.match(engines, /OPENAI_NATIVE_RUNTIME_ADAPTER/)
assert.doesNotMatch(engines, /AgentSession|kind: 'claude'|CLAUDE_/)

const providerEditor = read('src/renderer/src/components/ProviderEditor.tsx')
assert.match(providerEditor, /<option value="anthropic">/)
assert.match(providerEditor, /<option value="openai">/)
assert.doesNotMatch(providerEditor, /<option value="claude">/)

const providerPresets = read('src/renderer/src/store.ts')
assert.doesNotMatch(providerPresets, /engine: 'claude'/)
assert.match(read('src/main/providers.ts'), /engine === 'claude'\) return 'anthropic'/)
assert.doesNotMatch(read('package-lock.json'), /claude-agent-sdk/)
assert.doesNotMatch(read('electron-builder.release.cjs'), /claude-agent-sdk|Anthropic CLI/)

console.log('native engine surface smoke ok')
