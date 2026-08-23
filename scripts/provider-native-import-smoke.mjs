#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-provider-native-import-'))
const outDir = path.join(tempRoot, 'compiled')
const userDataDir = path.join(tempRoot, 'user-data')
const codexHome = path.join(tempRoot, 'codex-home')
const checks = []
const importedSecret = ['native', 'import', 'secret', 'canary'].join('-')
const existingSecret = ['existing', 'provider', 'secret', 'canary'].join('-')
const oauthSecret = ['oauth', 'refresh', 'secret', 'canary'].join('-')

try {
  compile()
  installRuntimeStubs()
  process.env.CODEX_HOME = codexHome
  mkdirSync(codexHome, { recursive: true })

  const nativeImport = await import(pathToFileURL(findCompiled('providerNativeConfigImport.js')).href)
  const providers = await import(pathToFileURL(findCompiled('providers.js')).href)

  writeCodex({ authKey: importedSecret })
  const createPreview = nativeImport.previewCodexNativeProviderImport()
  equal(createPreview.defaultAction, 'create', 'new native config defaults to create')
  equal(createPreview.credentialKind, 'api-key', 'auth.json API key is detected')
  equal(createPreview.credentialImportable, true, 'new provider credential can be imported')
  assert(!JSON.stringify(createPreview).includes(importedSecret), 'preview never exposes the API key')
  assert(createPreview.ignoredSections.includes('projects'), 'unmanaged Codex sections are disclosed by name')
  equal(createPreview.runtime?.reasoningEffort, 'high', 'reasoning effort maps into typed runtime config')
  equal(createPreview.runtime?.storeResponses, false, 'response storage preference maps into typed runtime config')

  const created = nativeImport.applyCodexNativeProviderImport(createPreview.previewId, 'create')
  equal(created.provider.models[0], 'gpt-native-one', 'native model is applied')
  equal(created.provider.hasToken, true, 'imported provider has a usable credential')
  equal(providers.resolveProviderToken(providers.getProvider(created.provider.id)).token, importedSecret,
    'credential is available only through the main-process broker')
  const createBackupText = readBackupText()
  assert(!createBackupText.includes(importedSecret), 'create backup excludes plaintext credentials')
  nativeImport.rollbackProviderNativeImportBackup(created.backup.id)
  assert(!providers.listProviders().some((provider) => provider.id === created.provider.id),
    'create rollback removes the imported provider')

  writeCodex({ authKey: undefined, model: 'gpt-config-only' })
  const configOnly = nativeImport.previewCodexNativeProviderImport()
  equal(configOnly.credentialKind, 'none', 'config-only import works without auth.json')
  equal(configOnly.models[0], 'gpt-config-only', 'config-only model is previewed')
  const configOnlyResult = nativeImport.applyCodexNativeProviderImport(configOnly.previewId, 'create')
  equal(configOnlyResult.provider.hasToken, false, 'config-only provider requires later authorization')
  nativeImport.rollbackProviderNativeImportBackup(configOnlyResult.backup.id)

  writeFileSync(path.join(codexHome, 'config.toml'), 'model = [invalid\n', 'utf8')
  const beforeInvalid = providerDigest(providers.listProviders())
  assertThrows(() => nativeImport.previewCodexNativeProviderImport(), 'invalid TOML fails before preview')
  equal(providerDigest(providers.listProviders()), beforeInvalid, 'invalid TOML does not mutate providers')

  const urlSecret = ['native', 'url', 'secret', 'canary'].join('-')
  writeFileSync(path.join(codexHome, 'config.toml'), [
    'model_provider = "native"',
    '[model_providers.native]',
    `base_url = "https://user:${urlSecret}@native.invalid/v1"`,
    'wire_api = "responses"'
  ].join('\n'), 'utf8')
  const urlError = captureError(() => nativeImport.previewCodexNativeProviderImport())
  assert(urlError instanceof Error, 'credential-bearing Base URL fails before preview')
  assert(!urlError.message.includes(urlSecret), 'Base URL rejection never echoes credential material')

  writeCodex({ authKey: importedSecret, model: 'gpt-stale-source' })
  const staleSource = nativeImport.previewCodexNativeProviderImport()
  writeCodex({ authKey: importedSecret, model: 'gpt-source-changed' })
  assertThrows(
    () => nativeImport.applyCodexNativeProviderImport(staleSource.previewId, 'create'),
    'source changes after preview are rejected'
  )

  writeCodex({ authKey: importedSecret, model: 'gpt-stale-provider' })
  const staleProvider = nativeImport.previewCodexNativeProviderImport()
  const unrelated = providers.createProvider(providerInput('Unrelated', 'https://unrelated.invalid/v1', 'unrelated-model'))
  assertThrows(
    () => nativeImport.applyCodexNativeProviderImport(staleProvider.previewId, 'create'),
    'provider changes after preview are rejected'
  )
  providers.deleteProvider(unrelated.id)

  const nameConflict = providers.createProvider(providerInput('Native Gateway', 'https://different.invalid/v1', 'name-conflict'))
  writeCodex({ authKey: importedSecret, model: 'gpt-name-conflict' })
  const nameConflictPreview = nativeImport.previewCodexNativeProviderImport()
  equal(nameConflictPreview.conflict, 'name', 'same name with a different target is a name conflict')
  equal(nameConflictPreview.defaultAction, 'skip', 'name-only conflict fails closed to skip')
  assert(!nameConflictPreview.allowedActions.includes('update'), 'name-only conflict cannot reuse existing credentials')
  providers.deleteProvider(nameConflict.id)

  const existing = providers.createProvider({
    ...providerInput('Existing Native', 'https://native.invalid/v1', 'old-model'),
    token: existingSecret
  })
  writeCodex({ authKey: importedSecret, model: 'gpt-updated' })
  const preservePreview = nativeImport.previewCodexNativeProviderImport()
  equal(preservePreview.targetProviderId, existing.id, 'same target resolves to the existing provider')
  equal(preservePreview.credentialImportable, false, 'existing usable credential is preserved')
  const preserved = nativeImport.applyCodexNativeProviderImport(preservePreview.previewId, 'update')
  equal(providers.resolveProviderToken(providers.getProvider(existing.id)).token, existingSecret,
    'native update never replaces an existing credential')
  nativeImport.rollbackProviderNativeImportBackup(preserved.backup.id)
  equal(providers.getProvider(existing.id)?.models[0], 'old-model', 'update rollback restores previous models')
  equal(providers.resolveProviderToken(providers.getProvider(existing.id)).token, existingSecret,
    'update rollback preserves the pre-existing credential')
  providers.deleteProvider(existing.id)

  const keyless = providers.createProvider(providerInput('Keyless Native', 'https://native.invalid/v1', 'before-import'))
  writeCodex({ authKey: importedSecret, model: 'after-import' })
  const addKeyPreview = nativeImport.previewCodexNativeProviderImport()
  const updated = nativeImport.applyCodexNativeProviderImport(addKeyPreview.previewId, 'update')
  equal(updated.backup.addedCredentialCount, 1, 'update backup tracks only the newly imported key id')
  equal(updated.provider.hasToken, true, 'update can fill a missing provider credential')
  const updateBackupText = readBackupText()
  assert(!updateBackupText.includes(importedSecret), 'update backup excludes plaintext credentials')
  nativeImport.rollbackProviderNativeImportBackup(updated.backup.id)
  equal(providers.getProvider(keyless.id)?.models[0], 'before-import', 'update rollback restores provider configuration')
  equal(providers.listProviders().find((provider) => provider.id === keyless.id)?.hasToken, false,
    'update rollback removes the imported credential')
  providers.deleteProvider(keyless.id)

  writeCodex({ oauthToken: oauthSecret, model: 'gpt-oauth' })
  const oauthPreview = nativeImport.previewCodexNativeProviderImport()
  equal(oauthPreview.credentialKind, 'oauth', 'Codex OAuth material is detected')
  equal(oauthPreview.credentialImportable, false, 'OAuth tokens require fresh CaoGen authorization')
  assert(!JSON.stringify(oauthPreview).includes(oauthSecret), 'OAuth material never enters the renderer preview')
  assert(oauthPreview.warnings.includes('oauth_reconnect'), 'OAuth preview requires reconnect')

  console.log(`provider native import smoke ok: ${checks.length}/${checks.length} checks passed`)
} finally {
  delete process.env.CODEX_HOME
  rmSync(tempRoot, { recursive: true, force: true })
}

function compile() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/provider/providerNativeConfigImport.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installRuntimeStubs() {
  const electronRoot = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronRoot, { recursive: true })
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(path.join(electronRoot, 'package.json'), JSON.stringify({ name: 'electron', version: '0.0.0', main: 'index.js' }))
  writeFileSync(path.join(electronRoot, 'index.js'), `'use strict'\nmodule.exports = {\n  app: { getPath(name) {\n    if (name === 'userData') return ${JSON.stringify(userDataDir)}\n    if (name === 'home') return ${JSON.stringify(tempRoot)}\n    throw new Error('unsupported Electron path: ' + name)\n  } },\n  safeStorage: {\n    isEncryptionAvailable() { return true },\n    encryptString(value) { return Buffer.from(value, 'utf8') },\n    decryptString(value) { return Buffer.from(value).toString('utf8') },\n    getSelectedStorageBackend() { return 'keychain' }\n  }\n}\n`)
  const tomlSource = path.join(repoRoot, 'node_modules', '@iarna', 'toml')
  cpSync(tomlSource, path.join(outDir, 'node_modules', '@iarna', 'toml'), { recursive: true })
  cpSync(path.join(repoRoot, 'node_modules', 'sql.js'), path.join(outDir, 'node_modules', 'sql.js'), { recursive: true })
}

function writeCodex({ authKey, oauthToken, model = 'gpt-native-one' }) {
  mkdirSync(codexHome, { recursive: true })
  writeFileSync(path.join(codexHome, 'config.toml'), [
    'model_provider = "native"',
    `model = ${JSON.stringify(model)}`,
    'model_reasoning_effort = "high"',
    'disable_response_storage = true',
    '',
    '[model_providers.native]',
    'name = "Native Gateway"',
    'base_url = "https://native.invalid/v1"',
    'wire_api = "responses"',
    '',
    '[projects."redacted-project"]',
    'trust_level = "trusted"',
    ''
  ].join('\n'), 'utf8')
  const authPath = path.join(codexHome, 'auth.json')
  if (authKey) writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: authKey }), 'utf8')
  else if (oauthToken) writeFileSync(authPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: oauthToken } }), 'utf8')
  else rmSync(authPath, { force: true })
}

function providerInput(name, baseUrl, model) {
  return { name, baseUrl, models: [model], engine: 'openai', authMode: 'api-key', openaiProtocol: 'responses' }
}

function readBackupText() {
  const root = path.join(userDataDir, 'provider-native-import-backups')
  return readdirSync(root).filter((name) => name.endsWith('.json'))
    .map((name) => readFileSync(path.join(root, name), 'utf8')).join('\n')
}

function providerDigest(value) {
  return JSON.stringify(value.map((provider) => ({ id: provider.id, name: provider.name, models: provider.models })))
}

function findCompiled(fileName) {
  const visit = (root) => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const full = path.join(root, entry.name)
      if (entry.isDirectory()) {
        const found = visit(full)
        if (found) return found
      } else if (entry.name === fileName) return full
    }
    return ''
  }
  const found = visit(outDir)
  if (!found) throw new Error(`compiled ${fileName} not found`)
  return found
}

function assert(condition, message) {
  checks.push({ name: message, status: condition ? 'pass' : 'fail' })
  if (!condition) throw new Error(message)
}

function equal(actual, expected, message) {
  assert(actual === expected, `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assertThrows(action, message) {
  let threw = false
  try { action() } catch { threw = true }
  assert(threw, message)
}

function captureError(action) {
  try { action(); return null } catch (error) { return error }
}
