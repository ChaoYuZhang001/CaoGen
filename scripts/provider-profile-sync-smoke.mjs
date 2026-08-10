#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
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
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-provider-sync-'))
const outDir = path.join(tempRoot, 'compiled')
const userDataDir = path.join(tempRoot, 'user-data')
const syncDir = path.join(tempRoot, 'sync-folder')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'provider-profile-sync', runId)
const checks = []
const credentialCanary = ['provider', 'sync', 'credential', 'canary'].join('-')

try {
  compile(outDir)
  installElectronStub(outDir, userDataDir)
  mkdirSync(syncDir, { recursive: true })
  const sync = await import(pathToFileURL(findCompiled(outDir, 'providerProfileSync.js')).href)
  const providers = await import(pathToFileURL(findCompiled(outDir, 'providers.js')).href)

  providers.createProvider({
    name: 'Sync Alpha',
    baseUrl: 'https://sync.example/v1',
    engine: 'openai',
    openaiProtocol: 'chat',
    models: ['alpha-1'],
    token: credentialCanary
  })

  let status = sync.configureProviderProfileSyncDirectory(syncDir)
  equal(status.relation, 'remote_missing', 'new sync directory must start remote_missing')
  let preview = sync.previewProviderProfileSync()
  assert(preview.canPublish && !preview.canPull, 'first preview must offer publish only')
  const first = sync.publishProviderProfileSync(preview.previewId, false)
  equal(first.providerCount, 1, 'first publish provider count')
  equal(first.status.relation, 'in_sync', 'first publish must converge')
  const currentPath = path.join(syncDir, 'caogen-provider-sync.json')
  assert(existsSync(currentPath), 'current sync envelope must exist')
  assert(!readFileSync(currentPath, 'utf8').includes(credentialCanary), 'sync envelope must exclude API keys')
  equal(historyFiles(syncDir).length, 1, 'first publish must retain one history version')

  const alpha = providers.listProviders()[0]
  providers.updateProvider(alpha.id, { models: ['alpha-2'] })
  status = sync.getProviderProfileSyncStatus()
  equal(status.relation, 'local_ahead', 'local edit must be classified local_ahead')
  preview = sync.previewProviderProfileSync()
  const second = sync.publishProviderProfileSync(preview.previewId, false)
  equal(second.status.relation, 'in_sync', 'second publish must converge')
  equal(historyFiles(syncDir).length, 2, 'second publish must retain a second history version')
  const secondEnvelope = readEnvelope(currentPath)
  equal(secondEnvelope.parentRevisionId, first.revisionId, 'new revision must reference its parent')

  writeRemoteModel(currentPath, 'alpha-remote')
  status = sync.getProviderProfileSyncStatus()
  equal(status.relation, 'remote_ahead', 'remote-only edit must be classified remote_ahead')
  preview = sync.previewProviderProfileSync()
  assert(preview.canPull && preview.importPreview?.items.length === 1, 'remote edit must provide itemized pull preview')
  const remoteItem = preview.importPreview.items[0]
  const pulled = sync.applyProviderProfileSync(preview.previewId, [{ itemId: remoteItem.id, action: 'update' }])
  equal(pulled.updated, 1, 'remote pull must update one provider')
  equal(pulled.status.relation, 'in_sync', 'complete remote pull must converge')
  equal(providers.listProviders()[0].models[0], 'alpha-remote', 'remote model must be applied')

  providers.updateProvider(alpha.id, { models: ['alpha-local-diverged'] })
  writeRemoteModel(currentPath, 'alpha-remote-diverged')
  status = sync.getProviderProfileSyncStatus()
  equal(status.relation, 'diverged', 'independent local and remote edits must be classified diverged')
  preview = sync.previewProviderProfileSync()
  assert(preview.requiresConflictChoice, 'diverged preview must require an explicit direction')
  assertThrows(
    () => sync.publishProviderProfileSync(preview.previewId, false),
    /\u8fdc\u7aef|remote/i,
    'diverged publish must fail without explicit local choice'
  )
  const resolved = sync.publishProviderProfileSync(preview.previewId, true)
  equal(resolved.status.relation, 'in_sync', 'explicit local choice must converge')

  providers.updateProvider(alpha.id, { models: ['alpha-cas-local'] })
  preview = sync.previewProviderProfileSync()
  writeRemoteModel(currentPath, 'alpha-cas-remote')
  assertThrows(
    () => sync.publishProviderProfileSync(preview.previewId, true),
    /\u9884\u89c8|preview/i,
    'publish must reject a remote file changed after preview'
  )

  const valid = readEnvelope(currentPath)
  const injectedProfile = structuredClone(valid.profile)
  injectedProfile.providers[0].apiKey = credentialCanary
  writeEnvelope(currentPath, { ...valid, profile: injectedProfile })
  assertThrows(
    () => sync.getProviderProfileSyncStatus(),
    /\u51ed\u636e|credential/i,
    'remote credential fields must be rejected'
  )
  assert(!JSON.stringify(checks).includes(credentialCanary), 'test evidence must not contain the credential canary')

  writeEnvelope(currentPath, valid)
  writeRemoteModel(currentPath, 'alpha-recovery')
  const recoveredEnvelope = readEnvelope(currentPath)
  providers.updateProvider(alpha.id, { models: ['alpha-recovery'] })
  const statePath = path.join(userDataDir, 'provider-profile-sync', 'state.json')
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  delete state.lastAppliedRevisionId
  delete state.lastAppliedProfileDigest
  delete state.lastSyncAt
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
  status = sync.getProviderProfileSyncStatus()
  equal(status.relation, 'in_sync', 'equal content must reconcile an interrupted local state update')
  const recoveredState = JSON.parse(readFileSync(statePath, 'utf8'))
  equal(recoveredState.lastAppliedRevisionId, recoveredEnvelope.revisionId, 'startup reconciliation must restore revision binding')

  const corrupted = readEnvelope(currentPath)
  corrupted.payloadDigest = '0'.repeat(64)
  writeFileSync(currentPath, `${JSON.stringify(corrupted, null, 2)}\n`)
  assertThrows(
    () => sync.getProviderProfileSyncStatus(),
    /\u5b8c\u6574\u6027|integrity/i,
    'tampered envelope digest must be rejected'
  )

  mkdirSync(reportDir, { recursive: true })
  const report = {
    generatedAt: new Date().toISOString(),
    status: 'passed',
    pass: checks.length,
    total: checks.length,
    checks
  }
  writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`provider profile sync smoke ok: ${reportDir}`)
  console.log(`${checks.length}/${checks.length} checks passed`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function writeRemoteModel(filePath, model) {
  const envelope = readEnvelope(filePath)
  const profile = structuredClone(envelope.profile)
  profile.providers[0].models = [model]
  writeEnvelope(filePath, { ...envelope, profile })
}

function writeEnvelope(filePath, input) {
  const profileDigest = digest(input.profile)
  const payload = {
    kind: input.kind,
    schemaVersion: input.schemaVersion,
    revisionId: `remote-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    parentRevisionId: input.revisionId,
    createdAt: new Date().toISOString(),
    deviceId: 'remote-device',
    profileDigest,
    providerCount: input.profile.providers.length,
    profile: input.profile
  }
  writeFileSync(filePath, `${JSON.stringify({ ...payload, payloadDigest: digest(payload) }, null, 2)}\n`)
}

function readEnvelope(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function historyFiles(directory) {
  return readdirSync(path.join(directory, '.caogen-provider-history')).filter((name) => name.endsWith('.json'))
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function compile(outDirPath) {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/provider/providerProfileSync.ts',
    '--outDir', outDirPath,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installElectronStub(compiledRoot, dataRoot) {
  const electronRoot = path.join(compiledRoot, 'node_modules', 'electron')
  mkdirSync(electronRoot, { recursive: true })
  mkdirSync(dataRoot, { recursive: true })
  writeFileSync(path.join(electronRoot, 'package.json'), JSON.stringify({
    name: 'electron', version: '0.0.0-provider-sync-smoke', main: 'index.js'
  }))
  writeFileSync(path.join(electronRoot, 'index.js'), `'use strict'\nmodule.exports = {\n  app: { getPath(name) { if (name !== 'userData') throw new Error('unsupported path'); return ${JSON.stringify(dataRoot)} } },\n  safeStorage: {\n    isEncryptionAvailable() { return true },\n    encryptString(value) { return Buffer.from(value, 'utf8') },\n    decryptString(value) { return Buffer.from(value).toString('utf8') },\n    getSelectedStorageBackend() { return 'keychain' }\n  }\n}\n`)
}

function findCompiled(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      try { return findCompiled(fullPath, fileName) } catch { /* continue */ }
    } else if (entry.name === fileName) return fullPath
  }
  throw new Error(`compiled ${fileName} not found`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
  checks.push(message)
}

function equal(actual, expected, message) {
  assert(Object.is(actual, expected), `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assertThrows(action, pattern, message) {
  let error
  try { action() } catch (caught) { error = caught }
  assert(error instanceof Error && pattern.test(error.message), message)
}
