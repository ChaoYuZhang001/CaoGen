#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import {
  cpSync,
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
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-codex-native-config-'))
const outDir = path.join(tempRoot, 'compiled')
const userDataDir = path.join(tempRoot, 'user-data')
const codexHome = path.join(tempRoot, 'codex-home')
const configPath = path.join(codexHome, 'config.toml')
const checks = []
const providerSecret = ['native', 'config', 'provider', 'secret'].join('-')
const mcpSecret = ['native', 'config', 'mcp', 'secret'].join('-')

try {
  compile()
  installRuntimeStubs()
  process.env.CODEX_HOME = codexHome
  mkdirSync(codexHome, { recursive: true })
  const service = await import(pathToFileURL(findCompiled('codexNativeConfigService.js')).href)

  const original = [
    '# keep this user comment',
    'model = "gpt-before"',
    'sandbox_mode = "workspace-write"',
    '',
    '[model_providers.private]',
    'name = "Private"',
    'base_url = "https://native.invalid/v1"',
    `experimental_bearer_token = ${JSON.stringify(providerSecret)}`,
    '',
    '[mcp_servers.echo]',
    'command = "echo"',
    `[mcp_servers.echo.env]`,
    `API_TOKEN = ${JSON.stringify(mcpSecret)}`,
    '',
    '[projects."private-project"]',
    'trust_level = "trusted"',
    '',
    '[features]',
    'multi_agent = true',
    '',
    '[[plugins]]',
    'name = "fixture"',
    ''
  ].join('\n')
  writeFileSync(configPath, original, 'utf8')

  const preview = service.previewCodexNativeConfig()
  equal(preview.configPresent, true, 'existing config is detected')
  equal(preview.protectedValueCount, 2, 'provider and MCP secrets are protected')
  equal(preview.formattingNormalized, true, 'secret-bearing config reports formatting normalization')
  assert(!preview.text.includes(providerSecret) && !preview.text.includes(mcpSecret), 'preview contains no secret values')
  assert((preview.text.match(/__CAOGEN_PROTECTED_VALUE_/g) ?? []).length === 2, 'preview contains stable protected placeholders')
  equal(preview.summary.modelProviders, 1, 'model provider summary is counted')
  equal(preview.summary.mcpServers, 1, 'MCP summary is counted')
  equal(preview.summary.projects, 1, 'project summary is counted')
  equal(preview.summary.features, 1, 'feature summary is counted')
  equal(preview.summary.plugins, 1, 'plugin summary is counted')

  const changedPlaceholder = preview.text.replace('__CAOGEN_PROTECTED_VALUE_0001__', 'changed-secret')
  assertThrows(() => service.applyCodexNativeConfig(preview.previewId, changedPlaceholder),
    'protected values cannot be changed in the raw editor')
  equal(readFileSync(configPath, 'utf8'), original, 'placeholder rejection leaves the source untouched')

  const injectedSecret = `${preview.text}\nnew_api_key = "new-secret-value"\n`
  assertThrows(() => service.applyCodexNativeConfig(preview.previewId, injectedSecret),
    'new credential-like fields are rejected')
  equal(readFileSync(configPath, 'utf8'), original, 'credential rejection leaves the source untouched')

  assertThrows(() => service.applyCodexNativeConfig(preview.previewId, 'model = [invalid\n'),
    'invalid TOML is rejected')
  equal(readFileSync(configPath, 'utf8'), original, 'invalid TOML leaves the source untouched')

  const stale = service.previewCodexNativeConfig()
  writeFileSync(configPath, `${original}\n# external change\n`, 'utf8')
  assertThrows(() => service.applyCodexNativeConfig(stale.previewId, stale.text.replace('gpt-before', 'gpt-stale')),
    'external source changes invalidate an open editor')
  writeFileSync(configPath, original, 'utf8')

  const editable = service.previewCodexNativeConfig()
  const editedText = editable.text
    .replace('model = "gpt-before"', 'model = "gpt-after"')
    .replace('sandbox_mode = "workspace-write"', 'sandbox_mode = "read-only"')
  const applied = service.applyCodexNativeConfig(editable.previewId, editedText)
  const appliedSource = readFileSync(configPath, 'utf8')
  assert(appliedSource.includes('model = "gpt-after"'), 'edited model is written')
  assert(appliedSource.includes('sandbox_mode = "read-only"'), 'edited sandbox mode is written')
  assert(appliedSource.includes(providerSecret) && appliedSource.includes(mcpSecret), 'protected values are restored only in the main process')
  equal(applied.backup.configPresent, true, 'apply records an existing-file backup')
  equal(service.listCodexNativeConfigBackups().length, 1, 'active config backup is listed')
  const backupRaw = readBackupText()
  assert(!backupRaw.includes(providerSecret) && !backupRaw.includes(mcpSecret), 'backup contains no plaintext secret values')
  assert(backupRaw.includes('"encryptedSource": "enc:'), 'backup source is system-encrypted')

  writeFileSync(configPath, `${appliedSource}\n# changed after apply\n`, 'utf8')
  assertThrows(() => service.rollbackCodexNativeConfigBackup(applied.backup.id),
    'rollback refuses to overwrite a later external change')
  writeFileSync(configPath, appliedSource, 'utf8')
  const rolledBack = service.rollbackCodexNativeConfigBackup(applied.backup.id)
  equal(rolledBack.configPresent, true, 'rollback reports restored file presence')
  equal(readFileSync(configPath, 'utf8'), original, 'rollback restores the exact original bytes and comments')
  equal(service.listCodexNativeConfigBackups().length, 0, 'rolled-back backup is no longer active')

  rmSync(configPath, { force: true })
  const missing = service.previewCodexNativeConfig()
  equal(missing.configPresent, false, 'missing config can be created')
  equal(missing.text, '', 'missing config opens as an empty editor')
  const newSource = '# new config comment\nmodel = "gpt-new"\n[features]\nmulti_agent = true\n'
  const created = service.applyCodexNativeConfig(missing.previewId, newSource)
  equal(readFileSync(configPath, 'utf8'), newSource, 'non-secret edits preserve exact text and comments')
  equal(created.preview.formattingNormalized, false, 'non-secret config remains in lossless text mode')
  service.rollbackCodexNativeConfigBackup(created.backup.id)
  assertThrows(() => readFileSync(configPath, 'utf8'), 'rollback deletes a config that did not previously exist')

  writeFileSync(configPath, newSource, 'utf8')
  const noChange = service.previewCodexNativeConfig()
  assertThrows(() => service.applyCodexNativeConfig(noChange.previewId, noChange.text), 'no-op saves are rejected')
  const newSecretPreview = service.previewCodexNativeConfig()
  assertThrows(() => service.applyCodexNativeConfig(
    newSecretPreview.previewId,
    `${newSecretPreview.text}\n[mcp_servers.private.env]\nPASSWORD = "typed-secret"\n`
  ), 'raw editor cannot introduce a new secret')

  console.log(`codex native config smoke ok: ${checks.length}/${checks.length} checks passed`)
} finally {
  delete process.env.CODEX_HOME
  rmSync(tempRoot, { recursive: true, force: true })
}

function compile() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/provider/codexNativeConfigService.ts',
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
  writeFileSync(path.join(electronRoot, 'index.js'), `'use strict'\nmodule.exports = {\n  app: { getPath(name) {\n    if (name === 'userData') return ${JSON.stringify(userDataDir)}\n    if (name === 'home') return ${JSON.stringify(tempRoot)}\n    throw new Error('unsupported Electron path: ' + name)\n  } },\n  safeStorage: {\n    isEncryptionAvailable() { return true },\n    encryptString(value) { return Buffer.from('encrypted:' + value, 'utf8') },\n    decryptString(value) { return Buffer.from(value).toString('utf8').slice('encrypted:'.length) },\n    getSelectedStorageBackend() { return 'keychain' }\n  }\n}\n`)
  cpSync(path.join(repoRoot, 'node_modules', '@iarna', 'toml'), path.join(outDir, 'node_modules', '@iarna', 'toml'), { recursive: true })
}

function readBackupText() {
  const root = path.join(userDataDir, 'codex-native-config-backups')
  return readdirSync(root).filter((name) => name.endsWith('.json'))
    .map((name) => readFileSync(path.join(root, name), 'utf8')).join('\n')
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
