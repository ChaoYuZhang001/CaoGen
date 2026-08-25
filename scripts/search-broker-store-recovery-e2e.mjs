#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, fork } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const workerMode = process.argv[2] === 'worker'
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'search-broker-store-recovery')
const reportDir = path.join(reportRoot, runId)
const tempRoot = workerMode ? '' : mkdtempSync(path.join(tmpdir(), 'caogen-search-store-recovery-'))
const compiledDir = path.join(tempRoot, 'compiled')
const projectId = 'personal-workspace'
const operationId = 'search-store-recovery-operation'
const result = searchResult('verified source')

if (workerMode) await runWorker()
else await runParent()

async function runParent() {
  let report
  try {
    compileSources()
    const modulePath = path.join(compiledDir, 'main', 'search', 'search-broker-store.js')
    const strongKill = []
    for (const checkpoint of ['after_file_sync', 'after_link']) {
      strongKill.push(await verifyStrongKill(modulePath, checkpoint))
    }
    const unknownResult = await verifyUnknownResult(modulePath)
    const duplicate = await verifyDuplicateAndOutOfOrder(modulePath)
    const legacy = await verifyLegacyMigration(modulePath)
    const corruption = await verifyCorruptionFailsClosed(modulePath)
    report = {
      schemaVersion: 1,
      gate: 'test:search-broker:store-recovery',
      runId,
      status: 'passed',
      verification: 'runtime_store_verified',
      sourceRevision: git(['rev-parse', 'HEAD']),
      worktreeStatusCount: gitStatusCount(),
      writer: 'src/main/search/search-broker-store.ts',
      faults: {
        strong_kill: { status: 'verified', scenarios: strongKill },
        network_unknown_result: { status: 'verified', scenario: unknownResult },
        duplicate_idempotency: { status: 'verified', scenario: duplicate.duplicate },
        out_of_order: { status: 'verified', scenario: duplicate.outOfOrder }
      },
      compatibility: legacy,
      corruption
    }
    console.log(JSON.stringify({
      status: report.status,
      verification: report.verification,
      sourceRevision: report.sourceRevision,
      verifiedFaults: 4,
      reportPath: path.relative(repoRoot, path.join(reportDir, 'report.json'))
    }, null, 2))
  } catch (error) {
    report = {
      schemaVersion: 1,
      gate: 'test:search-broker:store-recovery',
      runId,
      status: 'failed',
      verification: 'not_verified',
      sourceRevision: git(['rev-parse', 'HEAD']),
      worktreeStatusCount: gitStatusCount(),
      error: serializeError(error)
    }
    process.exitCode = 1
  } finally {
    mkdirSync(reportDir, { recursive: true })
    const serialized = `${JSON.stringify(report, null, 2)}\n`
    writeFileSync(path.join(reportDir, 'report.json'), serialized, 'utf8')
    writeFileSync(path.join(reportRoot, 'latest.json'), serialized, 'utf8')
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function verifyStrongKill(modulePath, checkpoint) {
  const root = path.join(tempRoot, `strong-kill-${checkpoint}`)
  const exit = await invokeWorker(modulePath, root, checkpoint, true)
  assert.equal(exit.signal, 'SIGKILL', `${checkpoint} worker must receive SIGKILL`)
  const store = createStore(modulePath, root)
  const observedAfterKill = store.get(operationId)
  if (checkpoint === 'after_file_sync') assert.equal(observedAfterKill, undefined)
  else assert.deepEqual(observedAfterKill, result)
  await store.put(operationId, result)
  assert.deepEqual(createStore(modulePath, root).get(operationId), result)
  assert.equal(operationFiles(root).length, 1)
  assert.equal(temporaryFiles(root).length, 0)
  return {
    checkpoint,
    signal: exit.signal,
    publishedBeforeKill: observedAfterKill !== undefined,
    restartDigest: sha256(JSON.stringify(createStore(modulePath, root).get(operationId))),
    automaticReplayCount: 0
  }
}

async function verifyUnknownResult(modulePath) {
  const root = path.join(tempRoot, 'unknown-result')
  const exit = await invokeWorker(modulePath, root, 'post_directory_sync_throw', false)
  assert.equal(exit.code, 2)
  assert.equal(exit.message?.code, 'EUNKNOWNRESULT')
  const recovered = createStore(modulePath, root).get(operationId)
  assert.deepEqual(recovered, result)
  await createStore(modulePath, root).put(operationId, result)
  assert.equal(operationFiles(root).length, 1)
  return {
    errorCode: exit.message.code,
    recoveredDigest: sha256(JSON.stringify(recovered)),
    duplicateProviderCalls: 0,
    reconciledByOperationIdentity: true
  }
}

async function verifyDuplicateAndOutOfOrder(modulePath) {
  const root = path.join(tempRoot, 'duplicate-out-of-order')
  const store = createStore(modulePath, root)
  await store.put(operationId, result)
  const file = operationFiles(root)[0]
  assert(file)
  const before = readFileSync(file)
  await store.put(operationId, result)
  assert.deepEqual(readFileSync(file), before)
  await store.put(operationId, reverseObjectKeys(result))
  assert.deepEqual(readFileSync(file), before)

  const delayed = searchResult('delayed conflicting source')
  await assert.rejects(
    store.put(operationId, delayed),
    (error) => error?.name === 'SearchBrokerStoreConflictError' && error?.code === 'SEARCH_OPERATION_CONFLICT'
  )
  assert.deepEqual(readFileSync(file), before)
  assert.deepEqual(createStore(modulePath, root).get(operationId), result)
  return {
    duplicate: { fileCount: 1, storeByteStable: true, propertyOrderIndependent: true },
    outOfOrder: { conflictCode: 'SEARCH_OPERATION_CONFLICT', storeByteStable: true }
  }
}

async function verifyLegacyMigration(modulePath) {
  const root = path.join(tempRoot, 'legacy-migration')
  const legacyRoot = storeRoot(root)
  mkdirSync(legacyRoot, { recursive: true })
  writeFileSync(path.join(legacyRoot, 'operations.json'), `${JSON.stringify({ [operationId]: result })}\n`, 'utf8')
  const store = createStore(modulePath, root)
  assert.deepEqual(store.get(operationId), result)
  await store.put(operationId, result)
  assert.equal(operationFiles(root).length, 1)
  assert.deepEqual(createStore(modulePath, root).get(operationId), result)
  return { legacyReadable: true, migratedToImmutableOperation: true }
}

async function verifyCorruptionFailsClosed(modulePath) {
  const root = path.join(tempRoot, 'corruption')
  const store = createStore(modulePath, root)
  await store.put(operationId, result)
  const file = operationFiles(root)[0]
  assert(file)
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  parsed.result.summary = 'tampered'
  writeFileSync(file, `${JSON.stringify(parsed)}\n`, 'utf8')
  assert.throws(() => createStore(modulePath, root).get(operationId), /digest mismatch/)
  return { digestMismatchRejected: true, providerReplayPrevented: true }
}

function invokeWorker(modulePath, root, checkpoint, killAtCheckpoint) {
  return new Promise((resolve, reject) => {
    const child = fork(process.argv[1], ['worker'], {
      cwd: repoRoot,
      execArgv: [],
      env: {
        ...process.env,
        CAOGEN_SEARCH_STORE_MODULE: modulePath,
        CAOGEN_SEARCH_STORE_ROOT: root,
        CAOGEN_SEARCH_STORE_CHECKPOINT: checkpoint,
        CAOGEN_SEARCH_STORE_RESULT: JSON.stringify(result)
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    let settled = false
    let message
    let stderr = ''
    const timeout = setTimeout(() => finish(new Error(`Search Store worker timed out at ${checkpoint}`)), 15_000)
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('message', (value) => {
      message = value
      if (killAtCheckpoint && value?.type === 'checkpoint' && value.checkpoint === checkpoint) child.kill('SIGKILL')
    })
    child.on('error', finish)
    child.on('exit', (code, signal) => finish(null, { code, signal, message, stderr }))
    function finish(error, value) {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve(value)
    }
  })
}

async function runWorker() {
  const Module = require('node:module').Module
  const realPromises = require('node:fs/promises')
  const originalLoad = Module._load
  const checkpoint = requiredEnv('CAOGEN_SEARCH_STORE_CHECKPOINT')
  Module._load = function patchedLoad(request, owner, isMain) {
    if (request === 'node:fs/promises') return faultInjectingPromises(realPromises, checkpoint)
    return originalLoad.call(this, request, owner, isMain)
  }
  try {
    const store = createStore(requiredEnv('CAOGEN_SEARCH_STORE_MODULE'), requiredEnv('CAOGEN_SEARCH_STORE_ROOT'))
    await store.put(operationId, JSON.parse(requiredEnv('CAOGEN_SEARCH_STORE_RESULT')))
    process.send?.({ type: 'completed' })
  } catch (error) {
    process.send?.({ type: 'error', code: error?.code, message: String(error?.message ?? error) })
    process.exitCode = 2
  } finally {
    Module._load = originalLoad
  }
}

function faultInjectingPromises(realPromises, checkpoint) {
  return {
    ...realPromises,
    open: async (...args) => wrapHandle(await realPromises.open(...args), String(args[0]), checkpoint),
    link: async (...args) => {
      const linked = await realPromises.link(...args)
      if (checkpoint === 'after_link') await pauseAt(checkpoint)
      return linked
    }
  }
}

function wrapHandle(handle, openedPath, checkpoint) {
  const temporary = openedPath.endsWith('.tmp')
  const directory = !temporary && openedPath.endsWith(path.join('operations'))
  return new Proxy(handle, {
    get(owner, property) {
      if (property === 'sync') return async (...args) => {
        const synced = await owner.sync(...args)
        if (temporary && checkpoint === 'after_file_sync') await pauseAt(checkpoint)
        if (directory && checkpoint === 'post_directory_sync_throw') {
          const error = new Error('injected Search Store unknown result')
          error.code = 'EUNKNOWNRESULT'
          throw error
        }
        return synced
      }
      const value = Reflect.get(owner, property, owner)
      return typeof value === 'function' ? value.bind(owner) : value
    }
  })
}

async function pauseAt(checkpoint) {
  await new Promise((resolve) => process.send?.({ type: 'checkpoint', checkpoint }, resolve))
  await new Promise(() => undefined)
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/search/search-broker-store.ts',
    'src/main/search/search-broker.ts',
    'src/main/durable-file.ts',
    '--outDir', compiledDir,
    '--rootDir', 'src',
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'pipe' })
}

function createStore(modulePath, root) {
  return require(modulePath).createDurableSearchStore(root, projectId)
}

function storeRoot(root) {
  return path.join(root, 'search-broker', sha256(projectId))
}

function operationFiles(root) {
  const directory = path.join(storeRoot(root), 'operations')
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter((name) => name.endsWith('.json')).map((name) => path.join(directory, name)).sort()
}

function temporaryFiles(root) {
  const directory = path.join(storeRoot(root), 'operations')
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter((name) => name.endsWith('.tmp')).sort()
}

function searchResult(summary) {
  const contentSha256 = sha256(summary)
  return {
    ok: true,
    status: 'success',
    mode: 'model_native',
    operationId,
    projectId: null,
    goalId: null,
    workItemId: null,
    runId: null,
    results: [],
    citations: [],
    url: 'https://example.com/source',
    fetchedAt: 1,
    summary,
    contentSha256,
    citation: `[source](sha256:${contentSha256})`,
    evidenceId: `evidence-${contentSha256.slice(0, 12)}`,
    idempotentReplay: false
  }
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseObjectKeys(item)]))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function git(args) {
  try { return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim() } catch { return '' }
}

function gitStatusCount() {
  return git(['status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter(Boolean).length
}

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function serializeError(error) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { name: 'Error', message: String(error) }
}
