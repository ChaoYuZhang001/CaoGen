import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-provider-target-binding-'))
const outDir = path.join(tempRoot, 'compiled')
const draftTokenFixture = 'draft-only'

try {
  compile(outDir)
  const binding = await import(pathToFileURL(findCompiled(outDir, 'modelDiscoveryBinding.js')).href)
  const provider = savedProvider()

  const stored = binding.bindProviderModelDiscoveryInput({
    baseUrl: `${provider.baseUrl}/`,
    providerId: provider.id,
    customHeaders: provider.customHeaders,
    credentialHeaderNames: ['X-API-Key'],
    openaiProtocol: provider.openaiProtocol
  }, provider)
  assert(stored.usesStoredCredential, 'matching saved-provider probe must use the stored credential')
  equal(stored.input.baseUrl, provider.baseUrl, 'stored probe target must come from the saved provider')
  equal(stored.input.customHeaders, provider.customHeaders, 'stored routing headers must come from the saved provider')
  assert(stored.input.token === undefined, 'stored credential plaintext must not enter the bound public input')

  assertThrows(
    () => binding.bindProviderModelDiscoveryInput({
      baseUrl: 'https://attacker.invalid/v1',
      providerId: provider.id
    }, provider),
    'renderer must not redirect a stored credential to another network target'
  )
  assertThrows(
    () => binding.bindProviderModelDiscoveryInput({
      baseUrl: provider.baseUrl,
      providerId: provider.id,
      customHeaders: 'X-Route: attacker-route'
    }, provider),
    'renderer must not replace saved routing headers while using a stored credential'
  )
  assertThrows(
    () => binding.bindProviderModelDiscoveryInput({
      baseUrl: provider.baseUrl,
      providerId: provider.id,
      credentialHeaderNames: ['authorization']
    }, provider),
    'renderer must not replace saved credential header names while using a stored credential'
  )
  assertThrows(
    () => binding.bindProviderModelDiscoveryInput({
      baseUrl: provider.baseUrl,
      providerId: provider.id,
      openaiProtocol: 'responses'
    }, provider),
    'renderer must not replace the saved protocol while using a stored credential'
  )
  assertThrows(
    () => binding.bindProviderModelDiscoveryInput({
      baseUrl: provider.baseUrl,
      providerId: 'missing-provider'
    }, undefined),
    'unknown provider ids must fail closed before credential resolution'
  )

  const draft = binding.bindProviderModelDiscoveryInput({
    baseUrl: 'https://draft.example/v1',
    providerId: provider.id,
    token: draftTokenFixture,
    customHeaders: 'X-Route: draft'
  }, provider)
  assert(!draft.usesStoredCredential, 'an explicit draft token must not select the saved credential')
  equal(draft.input.providerId, provider.id, 'draft probes must preserve existing cache and UI identity')
  equal(draft.input.baseUrl, 'https://draft.example/v1', 'draft probes may use their explicitly supplied target')
  equal(draft.input.token, draftTokenFixture, 'draft probes must retain only the explicitly supplied token')

  console.log('provider credential target binding smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function savedProvider() {
  return {
    id: 'provider-saved',
    name: 'Saved Provider',
    baseUrl: 'https://saved.example/v1',
    encryptedToken: 'enc:opaque',
    models: ['saved-model'],
    engine: 'openai',
    customHeaders: 'X-Route: saved',
    credentialHeaderNames: ['x-api-key'],
    openaiProtocol: 'chat',
    createdAt: 1
  }
}

function compile(outDirPath) {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/provider/modelDiscoveryBinding.ts',
      'src/main/providerCredentialBroker.ts',
      '--outDir',
      outDirPath,
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--types',
      'node',
      '--skipLibCheck'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )
}

function findCompiled(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledOptional(fullPath, fileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  throw new Error(`compiled ${fileName} not found`)
}

function findCompiledOptional(root, fileName) {
  try {
    return findCompiled(root, fileName)
  } catch {
    return null
  }
}

function assertThrows(fn, message) {
  let errorText = ''
  try {
    fn()
  } catch (error) {
    errorText = error instanceof Error ? error.message : String(error)
  }
  assert(errorText === '已保存 Provider 的模型探测必须使用其已保存的网络目标和鉴权配置', message)
}

function equal(actual, expected, message) {
  assert(actual === expected, `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
