#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-provider-runtime-target-'))
try {
  execFileSync(process.execPath, [
    path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--outDir', tempRoot,
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--types', 'node', '--skipLibCheck', 'src/main/provider/providerRuntimeTarget.ts'
  ], { cwd: root, stdio: 'inherit' })
  const api = await import(pathToFileURL(findCompiled(tempRoot, 'providerRuntimeTarget.js')).href)
  const provider = {
    baseUrl: 'https://base.example/v1',
    models: ['vendor-model'],
    openaiProtocol: 'chat',
    advancedConfig: {
      schemaVersion: 1,
      endpoints: [
        { id: 'slow', url: 'https://slow.example/v1', priority: 20 },
        { id: 'primary', url: 'https://primary.example/v1', priority: 1, protocol: 'responses' }
      ],
      modelProfiles: [{ model: 'vendor-model', aliases: ['latest'] }],
      appBindings: { openai: { endpointId: 'primary', modelMap: { fast: 'latest' } } }
    }
  }
  assert.deepEqual(api.resolveProviderRuntimeTarget(provider, { appId: 'openai', model: 'fast' }), {
    baseUrl: 'https://primary.example/v1', model: 'vendor-model', protocol: 'responses', endpointId: 'primary', appBindingId: 'openai', accountId: undefined
  })
  assert.equal(api.resolveProviderRuntimeTarget(provider, { appId: 'anthropic', model: 'latest' }).baseUrl, 'https://primary.example/v1', 'unbound apps use the highest-priority enabled endpoint')
  assert.throws(() => api.resolveProviderRuntimeTarget({ ...provider, advancedConfig: { ...provider.advancedConfig, endpoints: provider.advancedConfig.endpoints.map((endpoint) => endpoint.id === 'slow' ? { ...endpoint, enabled: false } : endpoint), appBindings: { openai: { endpointId: 'slow' } } } }, { appId: 'openai', model: 'vendor-model' }), 'disabled endpoint binding must fail')
  console.log('provider runtime target smoke ok: 3/3 checks passed')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function findCompiled(rootDir, fileName) {
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const full = path.join(rootDir, entry.name)
    if (entry.isDirectory()) {
      try { return findCompiled(full, fileName) } catch { /* keep searching */ }
    } else if (entry.isFile() && entry.name === fileName) return full
  }
  throw new Error(`compiled ${fileName} not found`)
}
