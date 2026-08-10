#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const sourceRoot = path.join(homedir(), '.cc-switch')
const databasePath = path.join(sourceRoot, 'cc-switch.db')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-cc-switch-real-apply-'))
const outDir = path.join(tempRoot, 'compiled')
const userDataDir = path.join(tempRoot, 'user-data')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'cc-switch-real-apply', runId)
const checks = []

try {
  if (!existsSync(databasePath)) throw new Error('CC Switch database is not installed')
  const sourceBefore = databaseIdentity()
  compile()
  installRuntimeDependencies()
  process.env.CAOGEN_CC_SWITCH_HOME = sourceRoot
  const service = await import(pathToFileURL(findCompiled('ccSwitchProviderImport.js')).href)
  const providers = await import(pathToFileURL(findCompiled('providers.js')).href)

  const preview = service.previewCcSwitchProviderImport()
  assert(preview.importableCount > 0, 'real CC Switch sample contains importable Providers')
  assert(preview.credentialCount > 0, 'real CC Switch sample contains credential-bearing Providers')
  assert(!containsCredentialShape(preview), 'real preview contains no credential fields')

  const applied = service.applyCcSwitchProviderImport(preview.previewId, [])
  equal(applied.created, preview.importableCount, 'real sample creates every importable Provider in isolation')
  const views = providers.listProviders()
  equal(views.length, preview.importableCount, 'isolated Provider Store contains the imported real sample')
  equal(views.filter((provider) => provider.hasToken).length, preview.credentialCount,
    'real sample credentials are available through encrypted Provider records')
  assert(views.every((provider) => !Object.hasOwn(provider, 'token')), 'Provider views expose no plaintext credential property')
  assert(applied.backup?.id, 'real sample apply creates a rollback backup')

  const persisted = readUserDataText()
  for (const view of views.filter((provider) => provider.hasToken)) {
    const resolved = providers.resolveProviderToken(providers.getProvider(view.id))
    assert(resolved?.token && !persisted.includes(resolved.token), 'real credential is absent from plaintext disk state')
  }
  assert(!/"(?:token|apiKey|secretAccessKey|password)"\s*:/i.test(readBackupText()),
    'real sample rollback backup contains no credential fields')

  service.rollbackCcSwitchProviderImportBackup(applied.backup.id)
  equal(providers.listProviders().length, 0, 'real sample rollback restores the empty isolated Provider Store')
  equal(databaseIdentity(), sourceBefore, 'source CC Switch database remains byte-identical after apply and rollback')

  const report = {
    generatedAt: new Date().toISOString(),
    status: 'passed',
    sourceDatabaseUnchanged: true,
    providerCount: preview.providerCount,
    importableCount: preview.importableCount,
    credentialCount: preview.credentialCount,
    createdCount: applied.created,
    rollbackRestoredEmptyStore: true,
    checks
  }
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`CC Switch real isolated apply passed: ${checks.length}/${checks.length}`)
} finally {
  delete process.env.CAOGEN_CC_SWITCH_HOME
  rmSync(tempRoot, { recursive: true, force: true })
}

function compile() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/provider/ccSwitchProviderImport.ts', '--outDir', outDir,
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--types', 'node', '--skipLibCheck'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installRuntimeDependencies() {
  const electronRoot = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronRoot, { recursive: true })
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(path.join(electronRoot, 'package.json'), JSON.stringify({
    name: 'electron', version: '0.0.0-real-apply', main: 'index.js'
  }))
  writeFileSync(path.join(electronRoot, 'index.js'), `'use strict'\nmodule.exports = {
  app: { getPath(name) {
    if (name === 'userData') return ${JSON.stringify(userDataDir)}
    if (name === 'home') return ${JSON.stringify(homedir())}
    throw new Error('unsupported Electron path: ' + name)
  } },
  safeStorage: {
    isEncryptionAvailable() { return true },
    encryptString(value) { return Buffer.from('protected:' + Buffer.from(value, 'utf8').toString('base64'), 'utf8') },
    decryptString(value) {
      const raw = Buffer.from(value).toString('utf8').slice('protected:'.length)
      return Buffer.from(raw, 'base64').toString('utf8')
    },
    getSelectedStorageBackend() { return 'keychain' }
  }
}\n`)
  cpSync(path.join(repoRoot, 'node_modules', '@iarna', 'toml'), path.join(outDir, 'node_modules', '@iarna', 'toml'), { recursive: true })
}

function databaseIdentity() {
  const stat = statSync(databasePath)
  return `${stat.size}:${stat.mtimeMs}:${sha256(readFileSync(databasePath))}`
}

function readUserDataText() {
  return readFiles(userDataDir).map((file) => readFileSync(file, 'utf8')).join('\n')
}

function readBackupText() {
  const root = path.join(userDataDir, 'provider-profile', 'cc-switch-import-backups')
  return existsSync(root) ? readFiles(root).map((file) => readFileSync(file, 'utf8')).join('\n') : ''
}

function readFiles(root) {
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...readFiles(candidate))
    else if (entry.isFile() && statSync(candidate).size <= 8 * 1024 * 1024) files.push(candidate)
  }
  return files
}

function containsCredentialShape(value) {
  return /"(?:token|apiKey|secretAccessKey|password)"\s*:/i.test(JSON.stringify(value))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function findCompiled(fileName) {
  const queue = [outDir]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name)
      if (entry.isDirectory()) queue.push(candidate)
      else if (entry.name === fileName) return candidate
    }
  }
  throw new Error(`compiled module missing: ${fileName}`)
}

function assert(condition, message) {
  checks.push({ name: message, status: condition ? 'pass' : 'fail' })
  if (!condition) throw new Error(message)
}

function equal(actual, expected, message) {
  assert(Object.is(actual, expected), `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
