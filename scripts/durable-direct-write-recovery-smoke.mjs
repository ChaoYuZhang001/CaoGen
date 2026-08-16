#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const Module = require('node:module').Module
process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter)
Module._initPaths()
const realFs = require('node:fs')
const realFsPromises = require('node:fs/promises')
const originalLoad = Module._load
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-durable-direct-write-'))
const buildDir = path.join(tempRoot, 'compiled')
const settingsBuildDir = path.join(tempRoot, 'compiled-settings')
const projectsBuildDir = path.join(tempRoot, 'compiled-projects')
const historyBuildDir = path.join(tempRoot, 'compiled-history')
const backupBuildDir = path.join(tempRoot, 'compiled-backup')
const activeSessionBuildDir = path.join(tempRoot, 'compiled-active-session')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'durable-direct-write-recovery', runId)
const checks = []
let fault = null
let userDataRoot = tempRoot

try {
  compileFixtures()
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'node:fs') return faultInjectingFs()
    if (request === 'node:fs/promises') return faultInjectingFsPromises()
    if (request === 'electron') return { app: { getPath: () => userDataRoot } }
    return originalLoad.call(this, request, parent, isMain)
  }
  const modelStats = require(path.join(buildDir, 'main', 'modelStats.js'))
  const pluginRegistry = require(path.join(buildDir, 'main', 'pluginRegistry.js'))
  const backup = require(path.join(backupBuildDir, 'main', 'utils', 'backup.js'))

  for (const stage of ['write', 'fsync', 'rename']) {
    await check(`ModelStats ${stage} failure preserves canonical bytes and memory`, () =>
      verifyModelStatsFailure(modelStats, stage))
    await check(`PluginRegistry ${stage} failure preserves canonical bytes`, () =>
      verifyPluginRegistryFailure(pluginRegistry, stage))
    await check(`Settings ${stage} failure preserves canonical bytes and memory`, () =>
      verifySettingsFailure(stage))
    await check(`Project Store ${stage} failure preserves canonical bytes and memory`, () =>
      verifyProjectsFailure(stage))
    await check(`History Store ${stage} failure preserves canonical bytes and memory`, () =>
      verifyHistoryFailure(stage))
    await check(`File backup ${stage} failure leaves no published or partial backup`, () =>
      verifyBackupFailure(backup, stage))
    await check(`Active Session Registry ${stage} failure preserves canonical bytes`, () =>
      verifyActiveSessionFailure(stage))
  }
  await check('Settings rejects a future schema without overwriting it', verifyFutureSettingsSchema)
  await check('Settings migrates legacy permission DSL into validated structured rules', verifyLegacyPermissionRuleMigration)
  await check('Project Store rejects a future schema without overwriting it', verifyFutureProjectsSchema)
  await check('Project Store migrates a legacy array on the first successful mutation', verifyLegacyProjectsMigration)
  await check('History Store rejects a future schema without overwriting it', verifyFutureHistorySchema)
  await check('History Store migrates a legacy array on the first successful mutation', verifyLegacyHistoryMigration)
  await check('Active Session Registry rejects a future schema without overwriting it', verifyFutureActiveSessionSchema)
  await check('Active Session Registry rejects a versionless object envelope', verifyVersionlessActiveSessionEnvelope)
  await check('Active Session Registry rejects malformed records without pruning artifacts', verifyMalformedActiveSessionRecord)
  await check('Active Session Registry rejects empty and duplicate recovery identities', verifyAmbiguousActiveSessionIdentity)
  await check('Active Session Registry blocks the whole batch after a semantic recovery failure', verifySemanticActiveSessionFailure)
  await check('Active Session Registry disposes a prepared Engine when a later factory fails', verifyActiveSessionFactoryFailureIsolation)
  await check('Active Session Registry preserves externally blocked recovery records', verifyExternallyBlockedActiveSession)
  await check('Active Session Registry preserves blocked records with a different authoritative SDK identity', verifyBlockedActiveSessionSdkMismatch)
  await check('Active Session Registry quarantine blocks pending strict and dispatch non-strict writes', verifyActiveSessionWriteQuarantine)
  await check('Active Session Registry quarantine blocks same-process restore and artifact pruning', verifyActiveSessionQuarantineRetry)
  await check('Active Session Registry reads a valid v1 recovery plan', verifyV1ActiveSessionRecoveryPlan)
  await check('Active Session Registry migrates a legacy array on the first successful mutation', verifyLegacyActiveSessionMigration)
  await check('Active Session Registry preserves a legacy empty default model during migration', verifyLegacyEmptyModelMigration)

  mkdirSync(reportDir, { recursive: true })
  const report = {
    schemaVersion: 1,
    status: 'passed',
    runId,
    checks,
    guarantees: [
      'candidate bytes are written and fsynced before canonical rename',
      'write, fsync, and rename failures preserve the previous canonical bytes',
      'ModelStats, Project Store, and History Store do not publish in-memory updates before durable commit',
      'Settings, Project Store, and History Store reject unsupported future schemas without overwriting them',
      'legacy Project and History arrays remain readable and migrate on mutation',
      'pre-edit backups are not returned until candidate bytes and the directory entry are durable',
      'the active-session restart registry migrates legacy arrays and blocks artifact pruning for future, versionless, or malformed documents'
    ]
  }
  writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`durable direct-write recovery smoke: PASS (${checks.length} checks)\n`)
} finally {
  fault = null
  Module._load = originalLoad
  rmSync(tempRoot, { recursive: true, force: true })
}

function compileFixtures() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/modelStats.ts',
    'src/main/pluginRegistry.ts',
    '--outDir', buildDir,
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'pipe' })
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/settings.ts',
    '--outDir', settingsBuildDir,
    '--rootDir', 'src',
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'pipe' })
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/projects.ts',
    '--outDir', projectsBuildDir,
    '--rootDir', 'src',
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'pipe' })
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/history.ts',
    '--outDir', historyBuildDir,
    '--rootDir', 'src',
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'pipe' })
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/utils/backup.ts',
    '--outDir', backupBuildDir,
    '--rootDir', 'src',
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'pipe' })
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/session-active-registry.ts',
    '--outDir', activeSessionBuildDir,
    '--rootDir', 'src',
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'pipe' })
}

function verifyModelStatsFailure(modelStats, stage) {
  const root = path.join(tempRoot, `model-stats-${stage}`)
  const file = path.join(root, 'model-stats.json')
  modelStats.configureModelStatsDir(root)
  modelStats.recordModelSuccess('fixture-model', 100)
  const before = readFileSync(file, 'utf8')

  fault = { stage, target: file }
  assert.throws(() => modelStats.recordModelFailure('fixture-model'), injectedFailure(stage))
  fault = null

  assert.equal(readFileSync(file, 'utf8'), before)
  assert.equal(modelStats.getModelStat('fixture-model').failures, 0)
  modelStats._resetCacheForTest()
  assert.equal(modelStats.getModelStat('fixture-model').failures, 0)
  assertNoTemporaryFiles(root)
}

function verifyPluginRegistryFailure(pluginRegistry, stage) {
  const root = path.join(tempRoot, `plugin-registry-${stage}`)
  const file = path.join(root, 'plugin-registry-state.json')
  const original = { version: 1, items: { fixture: { enabled: false, updatedAt: new Date(0).toISOString() } } }
  const changed = { version: 1, items: { fixture: { enabled: true, updatedAt: new Date(1).toISOString() } } }
  pluginRegistry.writePluginRegistryState(file, original)
  const before = readFileSync(file, 'utf8')

  fault = { stage, target: file }
  assert.throws(() => pluginRegistry.writePluginRegistryState(file, changed), injectedFailure(stage))
  fault = null

  assert.equal(readFileSync(file, 'utf8'), before)
  assert.equal(pluginRegistry.readPluginRegistryState(file).items.fixture.enabled, false)
  assertNoTemporaryFiles(root)
}

function verifySettingsFailure(stage) {
  const root = path.join(tempRoot, `settings-${stage}`)
  const file = path.join(root, 'settings.json')
  const settings = loadSettingsModule(root)
  settings.updateSettings({ theme: 'light' })
  const before = readFileSync(file, 'utf8')
  assert.equal(JSON.parse(before)._schemaVersion, 1)

  fault = { stage, target: file }
  assert.throws(() => settings.updateSettings({ theme: 'dark' }), injectedFailure(stage))
  fault = null

  assert.equal(readFileSync(file, 'utf8'), before)
  assert.equal(settings.getSettings().theme, 'light')
  assertNoTemporaryFiles(root)
}

function verifyFutureSettingsSchema() {
  const root = path.join(tempRoot, 'settings-future-schema')
  const file = path.join(root, 'settings.json')
  mkdirSync(root, { recursive: true })
  writeFileSync(file, '{"_schemaVersion":2,"theme":"light"}\n', 'utf8')
  const before = readFileSync(file, 'utf8')
  const settings = loadSettingsModule(root)
  assert.throws(() => settings.getSettings(), /Unsupported settings schema version: 2/)
  assert.throws(() => settings.updateSettings({ theme: 'dark' }), /Unsupported settings schema version: 2/)
  assert.equal(readFileSync(file, 'utf8'), before)
}

function verifyLegacyPermissionRuleMigration() {
  const root = path.join(tempRoot, 'settings-permission-migration')
  const file = path.join(root, 'settings.json')
  mkdirSync(root, { recursive: true })
  writeFileSync(file, `${JSON.stringify({
    _schemaVersion: 1,
    permissionAllowlist: 'tool=write_file path=src/**',
    permissionDenylist: 'tool=bash risk>=high',
    permissionTemporaryAllowlist: 'tool=git_commit until=4102444800000'
  })}\n`, 'utf8')
  const settings = loadSettingsModule(root)
  const migrated = settings.getSettings()
  assert.equal(migrated.permissionRulesVersion, 2)
  assert.equal(migrated.permissionRules.length, 3)
  assert.equal(migrated.permissionDenylist, '')
  assert.equal(migrated.permissionAllowlist, '')
  assert.equal(migrated.permissionTemporaryAllowlist, '')
  assert.equal(migrated.permissionRules[0].effect, 'deny')
  assert.equal(migrated.permissionRules[1].expiresAt, 4102444800000)
  assert.equal(migrated.permissionRules[2].pathPattern, 'src/**')
  assert(migrated.permissionRules.every((rule) => rule.capabilityScope.length === 0))

  settings.updateSettings({ theme: 'light' })
  const persisted = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(persisted.permissionRules.length, 3)
  assert.equal(persisted.permissionDenylist, '')
  settings.updateSettings({ permissionAllowlist: 'tool=write_file path=src/**' })
  assert.equal(settings.getSettings().permissionRules.length, 3)
  const beforeInvalidPatch = readFileSync(file, 'utf8')
  assert.throws(() => settings.updateSettings({
    permissionRules: [{
      id: 'invalid-rule', enabled: true, effect: 'allow', toolPattern: '', pathPattern: '',
      riskOperator: 'exact', misspelledSelector: 'bash'
    }]
  }), /未知字段 misspelledSelector/)
  assert.equal(readFileSync(file, 'utf8'), beforeInvalidPatch)

  const reloaded = loadSettingsModule(root).getSettings()
  assert.equal(reloaded.permissionRules.length, 3)
  assertNoTemporaryFiles(root)
}

function verifyProjectsFailure(stage) {
  const root = path.join(tempRoot, `projects-${stage}`)
  const file = path.join(root, 'projects.json')
  const projects = loadProjectsModule(root)
  const project = projects.touchProject('/workspace/fixture')
  const before = readFileSync(file, 'utf8')

  fault = { stage, target: file }
  assert.throws(() => projects.updateProject(project.id, { archived: true }), injectedFailure(stage))
  fault = null

  assert.equal(readFileSync(file, 'utf8'), before)
  assert.equal(projects.getProject(project.id).archived, undefined)
  const reloaded = loadProjectsModule(root)
  assert.equal(reloaded.getProject(project.id).archived, undefined)
  assertNoTemporaryFiles(root)
}

function verifyFutureProjectsSchema() {
  const root = path.join(tempRoot, 'projects-future-schema')
  const file = path.join(root, 'projects.json')
  mkdirSync(root, { recursive: true })
  writeFileSync(file, '{"schemaVersion":2,"projects":[]}\n', 'utf8')
  const before = readFileSync(file, 'utf8')
  const projects = loadProjectsModule(root)
  assert.throws(() => projects.listProjects(), /Unsupported Project Store schema version: 2/)
  assert.throws(() => projects.touchProject('/workspace/future'), /Unsupported Project Store schema version: 2/)
  assert.equal(readFileSync(file, 'utf8'), before)
}

function verifyLegacyProjectsMigration() {
  const root = path.join(tempRoot, 'projects-legacy-array')
  const file = path.join(root, 'projects.json')
  const legacyProject = {
    id: 'legacy-project',
    name: 'legacy',
    path: '/workspace/legacy',
    lastUsedAt: 1
  }
  mkdirSync(root, { recursive: true })
  writeFileSync(file, `${JSON.stringify([legacyProject], null, 2)}\n`, 'utf8')

  const projects = loadProjectsModule(root)
  assert.equal(projects.listProjects()[0].id, legacyProject.id)
  projects.updateProject(legacyProject.id, { archived: true })

  const migrated = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(migrated.schemaVersion, 1)
  assert.equal(migrated.projects.length, 1)
  assert.equal(migrated.projects[0].id, legacyProject.id)
  assert.equal(migrated.projects[0].archived, true)
  assertNoTemporaryFiles(root)
}

function verifyHistoryFailure(stage) {
  const root = path.join(tempRoot, `history-${stage}`)
  const file = path.join(root, 'sessions.json')
  const history = loadHistoryModule(root)
  const entry = historyFixture()
  history.upsertHistory(entry)
  const before = readFileSync(file, 'utf8')

  fault = { stage, target: file }
  assert.throws(() => history.renameHistory(entry.id, 'changed'), injectedFailure(stage))
  fault = null

  assert.equal(readFileSync(file, 'utf8'), before)
  assert.equal(history.listHistory()[0].title, entry.title)
  const reloaded = loadHistoryModule(root)
  assert.equal(reloaded.listHistory()[0].title, entry.title)
  assertNoTemporaryFiles(root)
}

function verifyFutureHistorySchema() {
  const root = path.join(tempRoot, 'history-future-schema')
  const file = path.join(root, 'sessions.json')
  mkdirSync(root, { recursive: true })
  writeFileSync(file, '{"schemaVersion":2,"entries":[]}\n', 'utf8')
  const before = readFileSync(file, 'utf8')
  const history = loadHistoryModule(root)
  assert.throws(() => history.listHistory(), /Unsupported History Store schema version: 2/)
  assert.throws(() => history.upsertHistory(historyFixture()), /Unsupported History Store schema version: 2/)
  assert.equal(readFileSync(file, 'utf8'), before)
}

function verifyLegacyHistoryMigration() {
  const root = path.join(tempRoot, 'history-legacy-array')
  const file = path.join(root, 'sessions.json')
  const legacyEntry = { ...historyFixture(), engine: 'claude' }
  mkdirSync(root, { recursive: true })
  writeFileSync(file, `${JSON.stringify([legacyEntry], null, 2)}\n`, 'utf8')

  const history = loadHistoryModule(root)
  const loaded = history.listHistory()[0]
  assert.equal(loaded.engine, 'anthropic')
  assert.equal(loaded.taskStrategy, 'execute')
  history.renameHistory(legacyEntry.id, 'migrated')

  const migrated = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(migrated.schemaVersion, 1)
  assert.equal(migrated.entries.length, 1)
  assert.equal(migrated.entries[0].title, 'migrated')
  assert.equal(migrated.entries[0].engine, 'anthropic')
  assert.equal(migrated.entries[0].taskStrategy, 'execute')
  assertNoTemporaryFiles(root)
}

function historyFixture() {
  return {
    id: 'history-fixture',
    title: 'fixture',
    cwd: '/workspace/fixture',
    model: 'fixture-model',
    providerId: 'fixture-provider',
    permissionMode: 'default',
    sdkSessionId: 'fixture-sdk-session',
    createdAt: 1,
    updatedAt: 1,
    costUsd: 0
  }
}

async function verifyBackupFailure(backup, stage) {
  const root = path.join(tempRoot, `backup-${stage}`)
  const target = path.join(root, 'fixture.txt')
  const backupDirectory = path.join(root, '.caogen', 'tmp', 'backup')
  mkdirSync(root, { recursive: true })
  writeFileSync(target, 'canonical bytes\n', 'utf8')

  fault = { stage, root: backupDirectory, asyncBackup: true }
  await assert.rejects(
    () => backup.createFileBackup(root, target, Buffer.from('canonical bytes\n')),
    injectedFailure(stage)
  )
  fault = null

  assert.equal(readFileSync(target, 'utf8'), 'canonical bytes\n')
  assert.equal(readdirSync(backupDirectory).length, 0)
}

function verifyActiveSessionFailure(stage) {
  const root = path.join(tempRoot, `active-session-${stage}`)
  const file = path.join(root, 'active-sessions.json')
  const registry = loadActiveSessionModule(root)
  const record = activeSessionFixture()
  registry.writeActiveSessionRegistry([record], true)
  const before = readFileSync(file, 'utf8')

  fault = { stage, target: file }
  assert.throws(
    () => registry.writeActiveSessionRegistry([{ ...record, title: 'changed' }], true),
    injectedFailure(stage)
  )
  fault = null

  assert.equal(readFileSync(file, 'utf8'), before)
  assertNoTemporaryFiles(root)
}

function verifyFutureActiveSessionSchema() {
  const root = path.join(tempRoot, 'active-session-future-schema')
  const file = path.join(root, 'active-sessions.json')
  mkdirSync(root, { recursive: true })
  writeFileSync(file, '{"schemaVersion":2,"sessions":[]}\n', 'utf8')
  const before = readFileSync(file, 'utf8')
  const registry = loadActiveSessionModule(root)
  assert.throws(
    () => registry.writeActiveSessionRegistry([activeSessionFixture()], true),
    /Unsupported Active Session Registry schema version: 2/
  )
  const plan = registry.planActiveSessionRecovery(new Set(), new Set())
  assert.match(plan.registryReadError, /Unsupported Active Session Registry schema version: 2/)
  assert.equal(registry.activeSessionArtifactsCanBePruned(plan), false)
  assert.equal(readFileSync(file, 'utf8'), before)
}

function verifyVersionlessActiveSessionEnvelope() {
  const root = path.join(tempRoot, 'active-session-versionless-envelope')
  const file = path.join(root, 'active-sessions.json')
  mkdirSync(root, { recursive: true })
  writeFileSync(file, '{"sessions":[]}\n', 'utf8')
  const before = readFileSync(file, 'utf8')
  const registry = loadActiveSessionModule(root)
  const plan = registry.planActiveSessionRecovery(new Set(), new Set())
  assert.match(plan.registryReadError, /document is invalid/)
  assert.equal(registry.activeSessionArtifactsCanBePruned(plan), false)
  assert.throws(
    () => registry.writeActiveSessionRegistry([activeSessionFixture()], true),
    /document is invalid/
  )
  assert.equal(readFileSync(file, 'utf8'), before)
}

function verifyMalformedActiveSessionRecord() {
  const root = path.join(tempRoot, 'active-session-malformed-record')
  const file = path.join(root, 'active-sessions.json')
  mkdirSync(root, { recursive: true })
  writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, sessions: [{ id: 'incomplete' }] }, null, 2)}\n`, 'utf8')
  const before = readFileSync(file, 'utf8')
  const registry = loadActiveSessionModule(root)
  const plan = registry.planActiveSessionRecovery(new Set(), new Set())
  assert.match(plan.registryReadError, /session at index 0 is invalid/)
  assert.equal(registry.activeSessionArtifactsCanBePruned(plan), false)
  assert.throws(
    () => registry.writeActiveSessionRegistry([activeSessionFixture()], true),
    /session at index 0 is invalid/
  )
  assert.equal(readFileSync(file, 'utf8'), before)
}

function verifyAmbiguousActiveSessionIdentity() {
  for (const fixture of [
    {
      name: 'empty-id',
      sessions: [activeSessionFixture('/workspace/fixture', { id: '' })],
      error: /session at index 0 is invalid/
    },
    {
      name: 'duplicate-id',
      sessions: [
        activeSessionFixture('/workspace/fixture', { id: 'duplicate', sdkSessionId: 'sdk-duplicate-a' }),
        activeSessionFixture('/workspace/fixture', { id: 'duplicate', sdkSessionId: 'sdk-duplicate-b' })
      ],
      error: /session at index 1 has duplicate id: duplicate/
    },
    {
      name: 'duplicate-sdk-session-id',
      sessions: [
        activeSessionFixture('/workspace/fixture', { id: 'sdk-owner-a', sdkSessionId: 'duplicate-sdk' }),
        activeSessionFixture('/workspace/fixture', { id: 'sdk-owner-b', sdkSessionId: 'duplicate-sdk' })
      ],
      error: /session at index 1 has duplicate sdkSessionId: duplicate-sdk/
    }
  ]) {
    const root = path.join(tempRoot, `active-session-${fixture.name}`)
    const file = path.join(root, 'active-sessions.json')
    mkdirSync(root, { recursive: true })
    writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, sessions: fixture.sessions }, null, 2)}\n`, 'utf8')
    const before = readFileSync(file, 'utf8')
    const registry = loadActiveSessionModule(root)
    const plan = registry.planActiveSessionRecovery(new Set(), new Set())
    assert.match(plan.registryReadError, fixture.error)
    assert.equal(registry.activeSessionArtifactsCanBePruned(plan), false)
    assert.throws(() => registry.writeActiveSessionRegistry([activeSessionFixture()], true), fixture.error)
    assert.equal(readFileSync(file, 'utf8'), before)
  }
}

async function verifySemanticActiveSessionFailure() {
  const root = path.join(tempRoot, 'active-session-semantic-failure')
  const file = path.join(root, 'active-sessions.json')
  const records = [
    activeSessionFixture(root, { id: 'valid-record', sdkSessionId: 'sdk-valid-record' }),
    activeSessionFixture(path.join(root, 'missing-cwd'), {
      id: 'invalid-placement',
      sdkSessionId: 'sdk-invalid-placement'
    })
  ]
  mkdirSync(root, { recursive: true })
  writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, sessions: records }, null, 2)}\n`, 'utf8')
  const before = readFileSync(file, 'utf8')
  const registry = loadActiveSessionModule(root)
  const sessions = new Map()
  const result = await registry.restoreActiveSessionRegistry(new Set(), sessions, new Map(), () => {})
  assert.equal(result.registryChanged, false)
  assert.equal(result.artifactsCanBePruned, false)
  assert.equal(sessions.size, 0)
  assert.equal(readFileSync(file, 'utf8'), before)
}

async function verifyActiveSessionFactoryFailureIsolation() {
  const root = path.join(tempRoot, 'active-session-factory-failure')
  const file = path.join(root, 'active-sessions.json')
  const records = [
    activeSessionFixture(root, {
      id: 'factory-first', sdkSessionId: 'sdk-factory-first', engine: 'batch-failure-fixture'
    }),
    activeSessionFixture(root, {
      id: 'factory-second', sdkSessionId: 'sdk-factory-second', engine: 'batch-failure-fixture'
    })
  ]
  mkdirSync(root, { recursive: true })
  writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, sessions: records }, null, 2)}\n`, 'utf8')
  const before = readFileSync(file, 'utf8')
  let createCount = 0
  let disposeCount = 0
  let startCount = 0
  loadEngineModule().registerEngine({
    kind: 'batch-failure-fixture',
    label: 'Batch failure fixture',
    available: () => true,
    create(meta) {
      createCount += 1
      if (createCount === 2) throw new Error('injected second Engine factory failure')
      return fakeEngine(meta, {
        start: () => { startCount += 1 },
        dispose: () => { disposeCount += 1 }
      })
    }
  })

  const registry = loadActiveSessionModule(root)
  const sessions = new Map()
  const result = await registry.restoreActiveSessionRegistry(new Set(), sessions, new Map(), () => {})
  assert.equal(result.registryChanged, false)
  assert.equal(result.artifactsCanBePruned, false)
  assert.equal(sessions.size, 0)
  assert.equal(createCount, 2)
  assert.equal(disposeCount, 1)
  assert.equal(startCount, 0)
  assert.equal(existsSync(path.join(root, 'projects.json')), false)
  assert.match(registry.activeSessionRegistryWriteQuarantineReason(), /injected second Engine factory failure/)
  assert.equal(readFileSync(file, 'utf8'), before)
}

async function verifyExternallyBlockedActiveSession() {
  const root = path.join(tempRoot, 'active-session-external-recovery-block')
  const file = path.join(root, 'active-sessions.json')
  const record = activeSessionFixture(root, { id: 'ledger-blocked', sdkSessionId: 'sdk-ledger-blocked' })
  mkdirSync(root, { recursive: true })
  writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, sessions: [record] }, null, 2)}\n`, 'utf8')
  const before = readFileSync(file, 'utf8')
  const registry = loadActiveSessionModule(root)
  const blocked = new Set([record.id])
  const plan = registry.planActiveSessionRecovery(blocked, new Set())
  assert.equal(registry.activeSessionArtifactsCanBePruned(plan, true), false)
  const sessions = new Map()
  const result = await registry.restoreActiveSessionRegistry(blocked, sessions, new Map(), () => {}, {
    preserveRegistrySessionIds: blocked
  })
  assert.equal(result.registryChanged, false)
  assert.equal(result.artifactsCanBePruned, false)
  assert.equal(sessions.size, 0)
  assert.match(registry.activeSessionRegistryWriteQuarantineReason(), /external recovery blocked sessions: ledger-blocked/)
  assert.equal(readFileSync(file, 'utf8'), before)
}

async function verifyBlockedActiveSessionSdkMismatch() {
  const root = path.join(tempRoot, 'active-session-blocked-sdk-mismatch')
  const file = path.join(root, 'active-sessions.json')
  const record = activeSessionFixture(root, { id: 'sdk-mismatch', sdkSessionId: 'registry-sdk' })
  mkdirSync(root, { recursive: true })
  writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, sessions: [record] }, null, 2)}\n`, 'utf8')
  const before = readFileSync(file, 'utf8')
  const registry = loadActiveSessionModule(root)
  const blocked = new Set([record.id])
  const plan = registry.planActiveSessionRecovery(blocked, new Set())
  const preserve = registry.activeSessionRegistryPreserveIds(
    plan,
    blocked,
    new Map([[record.id, 'snapshot-sdk']])
  )
  assert.deepEqual([...preserve], [record.id])
  const result = await registry.restoreActiveSessionRegistry(blocked, new Map(), new Map(), () => {}, {
    preserveRegistrySessionIds: preserve
  })
  assert.equal(result.registryChanged, false)
  assert.equal(result.artifactsCanBePruned, false)
  assert.equal(readFileSync(file, 'utf8'), before)
}

async function verifyActiveSessionWriteQuarantine() {
  const root = path.join(tempRoot, 'active-session-write-quarantine')
  const file = path.join(root, 'active-sessions.json')
  const record = activeSessionFixture(root, { id: 'protected-session', sdkSessionId: 'sdk-protected-session' })
  mkdirSync(root, { recursive: true })
  writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, sessions: [record] }, null, 2)}\n`, 'utf8')
  const before = readFileSync(file, 'utf8')
  const registry = loadActiveSessionModule(root)
  const blocked = new Set([record.id])
  await registry.restoreActiveSessionRegistry(blocked, new Map(), new Map(), () => {}, {
    preserveRegistrySessionIds: blocked
  })

  assert.throws(
    () => registry.writeActiveSessionRegistry([{ ...record, title: 'pending-creation-overwrite' }], true),
    /write quarantine is active: external recovery blocked sessions: protected-session/
  )
  registry.writeActiveSessionRegistry([{ ...record, title: 'dispatch-overwrite' }])
  assert.equal(readFileSync(file, 'utf8'), before)
}

async function verifyActiveSessionQuarantineRetry() {
  const root = path.join(tempRoot, 'active-session-quarantine-retry')
  const file = path.join(root, 'active-sessions.json')
  mkdirSync(root, { recursive: true })
  writeFileSync(file, '{"schemaVersion":2,"sessions":[]}\n', 'utf8')
  const registry = loadActiveSessionModule(root)
  const failedPlan = registry.planActiveSessionRecovery(new Set(), new Set())
  assert.equal(registry.activeSessionArtifactsCanBePruned(failedPlan), false)

  const record = activeSessionFixture(root, { id: 'retry-session', sdkSessionId: 'retry-sdk' })
  writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, sessions: [record] }, null, 2)}\n`, 'utf8')
  const repairedPlan = registry.planActiveSessionRecovery(new Set(), new Set())
  assert.equal(repairedPlan.restorable.length, 1)
  assert.equal(registry.activeSessionArtifactsCanBePruned(repairedPlan), false)
  const sessions = new Map()
  const result = await registry.restoreActiveSessionRegistry(new Set(), sessions, new Map(), () => {})
  assert.equal(result.registryChanged, false)
  assert.equal(result.artifactsCanBePruned, false)
  assert.equal(sessions.size, 0)
}

function verifyV1ActiveSessionRecoveryPlan() {
  const root = path.join(tempRoot, 'active-session-v1-plan')
  const file = path.join(root, 'active-sessions.json')
  const record = activeSessionFixture(root)
  mkdirSync(root, { recursive: true })
  writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, sessions: [record] }, null, 2)}\n`, 'utf8')
  const registry = loadActiveSessionModule(root)
  const plan = registry.planActiveSessionRecovery(new Set(), new Set())
  assert.equal(plan.registryReadError, undefined)
  assert.equal(plan.skippedErrors.length, 0)
  assert.equal(plan.restorable.length, 1)
  assert.equal(plan.restorable[0].id, record.id)
  assert.equal(registry.activeSessionArtifactsCanBePruned(plan), true)
}

function verifyLegacyActiveSessionMigration() {
  const root = path.join(tempRoot, 'active-session-legacy-array')
  const file = path.join(root, 'active-sessions.json')
  const record = activeSessionFixture(root)
  mkdirSync(root, { recursive: true })
  writeFileSync(file, `${JSON.stringify([record], null, 2)}\n`, 'utf8')

  const registry = loadActiveSessionModule(root)
  const plan = registry.planActiveSessionRecovery(new Set(), new Set())
  assert.equal(plan.registryReadError, undefined)
  assert.equal(plan.restorable.length, 1)
  registry.writeActiveSessionRegistry([{ ...record, title: 'migrated' }], true)

  const migrated = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(migrated.schemaVersion, 1)
  assert.equal(migrated.sessions.length, 1)
  assert.equal(migrated.sessions[0].title, 'migrated')
  assertNoTemporaryFiles(root)
}

async function verifyLegacyEmptyModelMigration() {
  const root = path.join(tempRoot, 'active-session-legacy-empty-model')
  const file = path.join(root, 'active-sessions.json')
  const record = activeSessionFixture(root, {
    model: '', engine: 'empty-model-fixture', unassigned: true
  })
  mkdirSync(root, { recursive: true })
  writeFileSync(file, `${JSON.stringify([record], null, 2)}\n`, 'utf8')

  const registry = loadActiveSessionModule(root)
  let startedModel
  loadEngineModule().registerEngine({
    kind: 'empty-model-fixture',
    label: 'Empty model fixture',
    available: () => true,
    create(meta) {
      return fakeEngine(meta, { start: () => { startedModel = meta.model } })
    }
  })
  const plan = registry.planActiveSessionRecovery(new Set(), new Set())
  assert.equal(plan.registryReadError, undefined)
  assert.equal(plan.skippedErrors.length, 0)
  assert.equal(plan.restorable.length, 1)
  assert.equal(plan.restorable[0].model, '')
  const sessions = new Map()
  const restored = await registry.restoreActiveSessionRegistry(new Set(), sessions, new Map(), () => {})
  assert.equal(restored.registryChanged, true)
  assert.equal(sessions.size, 1)
  assert.equal(startedModel, '')
  registry.writeActiveSessionRegistry([record], true)

  const migrated = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(migrated.schemaVersion, 1)
  assert.equal(migrated.sessions[0].model, '')
  assertNoTemporaryFiles(root)
}

function activeSessionFixture(cwd = '/workspace/fixture', overrides = {}) {
  return {
    id: 'active-session-fixture',
    title: 'fixture',
    cwd,
    model: 'fixture-model',
    providerId: 'fixture-provider',
    permissionMode: 'default',
    status: 'idle',
    sdkSessionId: 'active-sdk-session',
    costUsd: 0,
    createdAt: 1,
    ...overrides
  }
}

function loadSettingsModule(root) {
  userDataRoot = root
  const modulePath = path.join(settingsBuildDir, 'main', 'settings.js')
  delete require.cache[require.resolve(modulePath)]
  return require(modulePath)
}

function loadProjectsModule(root) {
  userDataRoot = root
  const modulePath = path.join(projectsBuildDir, 'main', 'projects.js')
  delete require.cache[require.resolve(modulePath)]
  return require(modulePath)
}

function loadHistoryModule(root) {
  userDataRoot = root
  const modulePath = path.join(historyBuildDir, 'main', 'history.js')
  delete require.cache[require.resolve(modulePath)]
  return require(modulePath)
}

function loadActiveSessionModule(root) {
  userDataRoot = root
  const modulePath = path.join(activeSessionBuildDir, 'main', 'session-active-registry.js')
  delete require.cache[require.resolve(modulePath)]
  return require(modulePath)
}

function loadEngineModule() {
  return require(path.join(activeSessionBuildDir, 'main', 'engine.js'))
}

function fakeEngine(meta, hooks = {}) {
  return {
    meta,
    start: async () => { hooks.start?.() },
    send() {},
    rejectSend() {},
    interrupt: async () => {},
    respondPermission() {},
    pendingPermissions: () => [],
    getTranscript: () => [],
    setPermissionMode: async () => {},
    setTaskStrategy: async () => {},
    setModel: async () => {},
    rename() {},
    dispose: async () => { hooks.dispose?.() }
  }
}

function faultInjectingFs() {
  return {
    ...realFs,
    writeFileSync(target, ...args) {
      if (fault?.stage === 'write' && typeof target === 'number') throw injectedError('write')
      return realFs.writeFileSync(target, ...args)
    },
    fsyncSync(descriptor) {
      if (fault?.stage === 'fsync') throw injectedError('fsync')
      return realFs.fsyncSync(descriptor)
    },
    renameSync(source, target) {
      if (fault?.stage === 'rename' && target === fault.target) throw injectedError('rename')
      return realFs.renameSync(source, target)
    }
  }
}

function faultInjectingFsPromises() {
  return {
    ...realFsPromises,
    async open(target, ...args) {
      const handle = await realFsPromises.open(target, ...args)
      const candidate = fault?.asyncBackup === true && typeof target === 'string' &&
        target.startsWith(fault.root) && target.endsWith('.tmp')
      if (!candidate) return handle
      return {
        writeFile: async (...writeArgs) => {
          if (fault?.stage === 'write') throw injectedError('write')
          return handle.writeFile(...writeArgs)
        },
        sync: async () => {
          if (fault?.stage === 'fsync') throw injectedError('fsync')
          return handle.sync()
        },
        close: () => handle.close()
      }
    },
    async rename(source, target) {
      if (fault?.asyncBackup === true && fault.stage === 'rename' &&
        typeof target === 'string' && target.startsWith(fault.root)) {
        throw injectedError('rename')
      }
      return realFsPromises.rename(source, target)
    }
  }
}

function injectedFailure(stage) {
  return (error) => error?.code === `CAOGEN_TEST_${stage.toUpperCase()}`
}

function injectedError(stage) {
  return Object.assign(new Error(`injected ${stage} failure`), {
    code: `CAOGEN_TEST_${stage.toUpperCase()}`
  })
}

function assertNoTemporaryFiles(root) {
  assert.equal(readdirSync(root).some((name) => name.endsWith('.tmp')), false)
}

async function check(name, run) {
  await run()
  checks.push({ name, status: 'passed' })
}
