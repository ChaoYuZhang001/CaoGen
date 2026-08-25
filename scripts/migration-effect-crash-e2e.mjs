import { execFileSync, fork } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const workerMode = process.argv[2]
const tempRoot = process.env.CAOGEN_MIGRATION_EFFECT_ROOT
  ?? mkdtempSync(path.join(tmpdir(), 'caogen-migration-effect-'))
const outDir = process.env.CAOGEN_MIGRATION_EFFECT_COMPILED ?? path.join(tempRoot, 'compiled')
const userData = process.env.CAOGEN_MIGRATION_EFFECT_USER_DATA ?? path.join(tempRoot, 'user-data')
const projectRoot = path.join(tempRoot, 'project')
const sourcePath = path.join(projectRoot, '.cursorrules')
const sourceCanary = 'MIGRATION_SOURCE_CONTENT_PRIVATE_73'

process.env.CAOGEN_TEST_USER_DATA = userData
process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter)
require('node:module').Module._initPaths()

if (workerMode) {
  await runWorker(workerMode)
} else {
  try {
    mkdirSync(projectRoot, { recursive: true })
    writeFileSync(sourcePath, sourceCanary)
    compileSources()
    installElectronStub()
    const modules = await loadModules()
    await successAndPrivacyCase(modules)
    await failurePrivacyCase(modules)
    await crashRecoveryCase()
    console.log('migration effect crash e2e: PASS')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function successAndPrivacyCase(modules) {
  let barrierObserved = false
  let safeInput
  const outcome = await modules.migrationEffect.executeMigrationImportEffect(
    projectRoot,
    [sourcePath, '/NOT_SELECTED_PRIVATE_22'],
    (spec) => modules.gateway.executeInteractiveOperationEffect({
      ...spec,
      operationId: 'migration-success',
      execute: async (effect) => {
        const snapshot = await modules.snapshotStore.getTaskSnapshot(effect.sessionId)
        const persisted = snapshot?.run?.effects?.find((item) => item.id === effect.id)
        assertEqual(persisted?.status, 'executing', 'migration must cross the durable executing barrier')
        assertEqual(persisted?.target?.kind, 'unsupported')
        assertEqual(persisted?.target?.toolName, 'migration_import')
        assertEqual(snapshot?.run?.operation?.kind, 'migration_import')
        safeInput = spec.toolInput
        barrierObserved = true
        return spec.execute(effect)
      }
    })
  )
  assert(outcome.ok, JSON.stringify(outcome))
  assert(barrierObserved, 'migration durable barrier was not observed')
  assertEqual(outcome.effectStatus, 'confirmed')
  assertEqual(safeInput.assetCount, 1)
  assertEqual(safeInput.kindCounts.rules, 1)
  assert(typeof safeInput.selectionDigest === 'string' && safeInput.selectionDigest.length === 64)
  assert(!JSON.stringify(safeInput).includes(sourcePath), 'raw migration source path entered Effect input')
  assert(!JSON.stringify(safeInput).includes(sourceCanary), 'migration source content entered Effect input')
  assert(readFileSync(path.join(projectRoot, 'caogen.md'), 'utf8').includes(sourceCanary))
  assertEqual(await modules.snapshotStore.getTaskSnapshot('operation:migration-success'), null)
  assertDatabaseExcludes([sourcePath, sourceCanary, '/NOT_SELECTED_PRIVATE_22'])

  const empty = await modules.migrationEffect.executeMigrationImportEffect(
    projectRoot,
    ['/NOT_SELECTED_PRIVATE_22'],
    () => { throw new Error('empty selection must not create an Effect') }
  )
  assert(empty.ok, JSON.stringify(empty))
  assertEqual(empty.summary, '未选择任何资产')
}

async function failurePrivacyCase(modules) {
  const failureCanary = 'MIGRATION_FAILURE_PRIVATE_88'
  const failed = await modules.migrationEffect.executeMigrationImportEffect(
    projectRoot,
    [sourcePath],
    modules.gateway.executeInteractiveOperationEffect,
    () => { throw new Error(failureCanary) }
  )
  assert(!failed.ok, 'opaque migration failure must not report success')
  assertEqual(failed.effectStatus, 'waiting_reconciliation')
  assert(typeof failed.snapshotId === 'string' && failed.snapshotId.length > 0)
  assert(!failed.error.includes(failureCanary), 'raw migration failure reached the renderer')
  const snapshot = await modules.snapshotStore.getTaskSnapshot(failed.snapshotId)
  assertEqual(snapshot?.run?.status, 'waiting_reconciliation')
  assertDatabaseExcludes([failureCanary])

  const effect = snapshot?.run?.effects?.[0]
  assert(effect, 'failed migration recovery Effect is missing')
  const beforeStaleResolution = JSON.stringify(snapshot)
  let staleResolutionRejected = false
  try {
    await modules.effectRuntime.resolvePersistedTaskEffect(
      snapshot.id,
      effect.id,
      effect.revision - 1,
      'confirmed_not_applied'
    )
  } catch (error) {
    staleResolutionRejected = /revision/i.test(error instanceof Error ? error.message : String(error))
  }
  assert(staleResolutionRejected, 'out-of-order migration Effect resolution must reject a stale revision')
  assertEqual(
    JSON.stringify(await modules.snapshotStore.getTaskSnapshot(snapshot.id)),
    beforeStaleResolution,
    'stale migration Effect resolution must not mutate the recovery snapshot'
  )
  const resolved = await modules.effectRuntime.resolvePersistedTaskEffect(
    snapshot.id,
    effect.id,
    effect.revision,
    'confirmed_not_applied'
  )
  assertEqual(await modules.gateway.settleStoppedInteractiveOperationSnapshot(resolved), null)
  assertEqual(await modules.snapshotStore.getTaskSnapshot(snapshot.id), null)
}

async function crashRecoveryCase() {
  const crashed = await runChild('crash', true)
  assertEqual(crashed.message.effectStatus, 'executing')
  assertEqual(crashed.message.targetKind, 'unsupported')
  assertEqual(crashed.message.toolName, 'migration_import')

  const resumed = await runChild('resume', false)
  assertEqual(resumed.message.effectStatus, 'waiting_reconciliation')
  assertEqual(resumed.message.runStatus, 'waiting_reconciliation')
  assertEqual(resumed.message.snapshotExists, true)
  assertEqual(counterLines(), 1, 'opaque migration recovery must never replay the import callback')
  assertDatabaseExcludes([sourceCanary])
}

async function runWorker(mode) {
  const modules = await loadModules()
  if (mode === 'crash') return crashWorker(modules)
  if (mode === 'resume') return resumeWorker(modules)
  throw new Error(`unknown worker mode: ${mode}`)
}

async function crashWorker(modules) {
  const result = await modules.migrationEffect.executeMigrationImportEffect(
    projectRoot,
    [sourcePath],
    (spec) => modules.gateway.executeInteractiveOperationEffect({
      ...spec,
      operationId: 'migration-crash',
      execute: async (effect) => {
        const value = await spec.execute(effect)
        const snapshot = await modules.snapshotStore.getTaskSnapshot(effect.sessionId)
        const persisted = snapshot?.run?.effects?.find((item) => item.id === effect.id)
        process.send?.({
          effectStatus: persisted?.status,
          targetKind: persisted?.target?.kind,
          toolName: persisted?.target?.toolName
        })
        await new Promise(() => {})
        return value
      }
    }),
    () => {
      appendFileSync(counterFile(), 'import\n')
      return '已导入:crash fixture'
    }
  )
  throw new Error(`crash worker unexpectedly completed: ${JSON.stringify(result)}`)
}

async function resumeWorker(modules) {
  const scopeId = 'operation:migration-crash'
  const snapshot = await modules.snapshotStore.getTaskSnapshot(scopeId)
  assert(snapshot?.run, 'migration crash recovery snapshot missing')
  const reconciled = await modules.effectRuntime.reconcilePersistedTaskSnapshot(snapshot)
  const effectStatus = reconciled.run?.effects?.[0]?.status
  await modules.gateway.settleStoppedInteractiveOperationSnapshot(reconciled)
  const current = await modules.snapshotStore.getTaskSnapshot(scopeId)
  process.send?.({
    effectStatus,
    snapshotExists: current !== null,
    runStatus: current?.run?.status
  })
}

function runChild(mode, killAfterMessage) {
  return new Promise((resolvePromise, reject) => {
    const child = fork(process.argv[1], [mode], {
      env: {
        ...process.env,
        CAOGEN_MIGRATION_EFFECT_ROOT: tempRoot,
        CAOGEN_MIGRATION_EFFECT_COMPILED: outDir,
        CAOGEN_MIGRATION_EFFECT_USER_DATA: userData
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
    let stdout = ''
    let stderr = ''
    let message
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${mode} timed out\n${stdout}\n${stderr}`))
    }, 30_000)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('message', (value) => {
      message = value
      if (killAfterMessage) child.kill('SIGKILL')
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (!message) return reject(new Error(`${mode} exited without evidence (${code}/${signal})\n${stdout}\n${stderr}`))
      if (killAfterMessage && signal !== 'SIGKILL') return reject(new Error(`${mode} expected SIGKILL, got ${code}/${signal}`))
      if (!killAfterMessage && code !== 0) return reject(new Error(`${mode} failed (${code})\n${stdout}\n${stderr}`))
      resolvePromise({ message, stdout, stderr })
    })
  })
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/migrationEffect.ts',
    'src/main/task/operation-effect-gateway.ts',
    '--outDir', outDir,
    '--rootDir', 'src',
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installElectronStub() {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'),
    'export const app = { getPath: () => process.env.CAOGEN_TEST_USER_DATA }\n')
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

async function loadModules() {
  return {
    migrationEffect: await importModule('main/migrationEffect.js'),
    gateway: await importModule('main/task/operation-effect-gateway.js'),
    effectRuntime: await importModule('main/task/effect-runtime.js'),
    snapshotStore: await importModule('main/task/task-snapshot.js')
  }
}

function importModule(relativePath) {
  return import(pathToFileURL(path.join(outDir, relativePath)).href)
}

function counterFile() {
  return path.join(tempRoot, 'crash-import-count.txt')
}

function counterLines() {
  if (!existsSync(counterFile())) return 0
  return readFileSync(counterFile(), 'utf8').split('\n').filter(Boolean).length
}

function assertDatabaseExcludes(values) {
  const dbPath = path.join(userData, 'task-snapshots.db')
  assert(existsSync(dbPath), 'task snapshot database missing')
  const database = readFileSync(dbPath)
  for (const value of values) {
    assert(!database.includes(Buffer.from(value)), `sensitive migration value leaked into task database: ${value}`)
  }
}

function assertEqual(actual, expected, message = '') {
  if (actual !== expected) {
    throw new Error(`${message ? `${message}: ` : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
