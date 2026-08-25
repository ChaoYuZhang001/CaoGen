#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const workerMode = process.argv[2] === 'worker'
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'layered-memory-store-recovery')
const reportDir = path.join(reportRoot, runId)
const tempRoot = workerMode ? '' : mkdtempSync(path.join(tmpdir(), 'caogen-layered-memory-recovery-'))
const compiledDir = path.join(tempRoot, 'compiled')
const writer = 'src/main/memory/memory-manager.ts'
const recoveryInput = {
  id: 'layered-memory-recovery-create',
  layer: 'user',
  title: 'Recovery memory',
  body: 'Preserve this Memory entry across uncertain publication.',
  source: 'recovery-e2e',
  tags: ['recovery', 'durability']
}
const currentInput = {
  id: 'layered-memory-recovery-current',
  layer: 'project',
  projectRoot: '/tmp/caogen-layered-memory-project',
  title: 'Current memory',
  body: 'Reject delayed edits to this Memory entry.',
  source: 'recovery-e2e',
  tags: ['current']
}

if (workerMode) await runWorker()
else await runParent()

async function runParent() {
  let report
  try {
    compileSources()
    const modulePath = path.join(compiledDir, 'main', 'memory', 'memory-manager.js')
    const strongKill = []
    for (const checkpoint of ['after_write', 'after_file_sync', 'after_rename']) {
      strongKill.push(await verifyStrongKill(modulePath, checkpoint))
    }
    report = {
      schemaVersion: 1,
      gate: 'test:layered-memory-store-recovery',
      runId,
      status: 'passed',
      verification: 'runtime_store_verified',
      sourceRevision: git(['rev-parse', 'HEAD']),
      worktreeStatusCount: gitStatusCount(),
      writer,
      scope: 'Layered Memory add, update, delete, and Store revision handling',
      concurrency: await verifyConcurrentSerialization(modulePath),
      faults: {
        strong_kill: { status: 'verified', scenarios: strongKill },
        network_unknown_result: { status: 'verified', scenario: await verifyUnknownResult(modulePath) },
        duplicate_idempotency: { status: 'verified', scenario: await verifyDuplicate(modulePath) },
        out_of_order: { status: 'verified', scenario: await verifyOutOfOrder(modulePath) }
      }
    }
  } catch (error) {
    report = {
      schemaVersion: 1,
      gate: 'test:layered-memory-store-recovery',
      runId,
      status: 'failed',
      verification: 'not_verified',
      sourceRevision: git(['rev-parse', 'HEAD']),
      worktreeStatusCount: gitStatusCount(),
      writer,
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

  console.log(JSON.stringify({
    status: report.status,
    verification: report.verification,
    sourceRevision: report.sourceRevision,
    verifiedFaults: report.status === 'passed' ? 4 : 0,
    reportPath: path.relative(repoRoot, path.join(reportDir, 'report.json')),
    error: report.error
  }, null, 2))
}

async function verifyConcurrentSerialization(modulePath) {
  const root = scenarioRoot('concurrent-serialization')
  await seed(modulePath, root)
  const runtime = require(modulePath)
  const [left, right] = await Promise.all([
    runtime.addMemory(root, { ...recoveryInput, id: 'layered-memory-concurrent-left', title: 'Concurrent left' }),
    runtime.addMemory(root, { ...recoveryInput, id: 'layered-memory-concurrent-right', title: 'Concurrent right' })
  ])
  const document = readDocument(root)
  assert.equal(document.entries.length, 3, 'serialized concurrent writes must preserve both entries')
  assert.equal(document.revision, 3)
  assert(document.entries.some((entry) => entry.id === left.id))
  assert(document.entries.some((entry) => entry.id === right.id))
  return { status: 'verified', recordCount: 3, storeRevision: 3, lostUpdates: 0 }
}

async function verifyStrongKill(modulePath, checkpoint) {
  const root = scenarioRoot(`strong-kill-${checkpoint}`)
  await seed(modulePath, root)
  const exit = await invokeWorker(modulePath, root, checkpoint, true)
  assert.equal(exit.signal, 'SIGKILL', `${checkpoint} worker must receive SIGKILL`)
  const observed = readDocument(root)
  assert([1, 2].includes(observed.entries.length), `${checkpoint} left a partial Store generation`)
  assert([1, 2].includes(observed.revision), `${checkpoint} left an invalid Store revision`)
  assert(observed.entries.every((entry) => Number.isSafeInteger(entry.revision) && entry.revision >= 1))

  const runtime = require(modulePath)
  const recovered = await runtime.addMemory(root, recoveryInput)
  assert.equal(recovered.id, recoveryInput.id)
  const finalDocument = readDocument(root)
  assert.equal(finalDocument.version, 2)
  assert.equal(finalDocument.revision, 2)
  assert.equal(finalDocument.entries.filter((entry) => entry.id === recoveryInput.id).length, 1)
  assert.deepEqual(temporaryFiles(root), [])
  return {
    checkpoint,
    signal: exit.signal,
    publishedBeforeKill: observed.entries.length === 2,
    recoveredStoreRevision: finalDocument.revision,
    canonicalDigest: sha256(readFileSync(storePath(root))),
    orphanTemporaryCount: 0
  }
}

async function verifyUnknownResult(modulePath) {
  const root = scenarioRoot('unknown-result')
  await seed(modulePath, root)
  const exit = await invokeWorker(modulePath, root, 'post_directory_sync_throw', false)
  assert.equal(exit.code, 2)
  assert.equal(exit.message?.code, 'EUNKNOWNRESULT')
  assert.equal(exit.message?.replayByteStable, true)
  assert.equal(exit.message?.recoveredRevision, 1)
  const document = readDocument(root)
  assert.equal(document.revision, 2)
  assert.equal(document.entries.length, 2)
  assert.deepEqual(temporaryFiles(root), [])
  return {
    errorCode: exit.message.code,
    recoveredRevision: exit.message.recoveredRevision,
    replayByteStable: true,
    storeRevision: document.revision,
    orphanTemporaryCount: 0
  }
}

async function verifyDuplicate(modulePath) {
  const root = scenarioRoot('duplicate')
  await seed(modulePath, root)
  const runtime = require(modulePath)
  const first = await runtime.addMemory(root, recoveryInput)
  const before = fileIdentity(storePath(root))
  const second = await runtime.addMemory(root, recoveryInput)
  assert.deepEqual(second, first)
  assert.deepEqual(fileIdentity(storePath(root)), before, 'duplicate add must not republish the Store')
  await assert.rejects(
    runtime.addMemory(root, { ...recoveryInput, body: 'Conflicting duplicate content.' }),
    /already exists with different content/
  )
  assert.deepEqual(fileIdentity(storePath(root)), before, 'identity conflict must preserve canonical bytes')
  return {
    entryCount: 2,
    storeRevisionStable: true,
    identityStable: true,
    identityConflictRejected: true,
    canonicalDigest: before.digest
  }
}

async function verifyOutOfOrder(modulePath) {
  const root = scenarioRoot('out-of-order')
  const current = await seed(modulePath, root)
  const runtime = require(modulePath)
  const updated = await runtime.updateMemory(root, current.id, {
    title: 'Current accepted memory',
    expectedRevision: 1
  })
  assert.equal(updated.revision, 2)
  const before = readFileSync(storePath(root))
  await assert.rejects(
    runtime.updateMemory(root, current.id, { title: 'Delayed stale memory', expectedRevision: 1 }),
    /Memory revision conflict: expected 1, got 2/
  )
  await assert.rejects(
    runtime.deleteMemory(root, current.id, 1),
    /Memory revision conflict: expected 1, got 2/
  )
  const after = readFileSync(storePath(root))
  assert.deepEqual(after, before, 'delayed mutation replaced canonical bytes')
  const recovered = (await runtime.listMemories(root)).find((entry) => entry.id === current.id)
  assert.equal(recovered?.title, 'Current accepted memory')
  assert.equal(recovered?.revision, 2)
  return {
    delayedRevision: 1,
    canonicalRevision: 2,
    staleUpdateRejected: true,
    staleDeleteRejected: true,
    storeByteStable: true
  }
}

async function seed(modulePath, root) {
  return require(modulePath).addMemory(root, currentInput)
}

function invokeWorker(modulePath, root, checkpoint, killAtCheckpoint) {
  return new Promise((resolve, reject) => {
    const child = fork(process.argv[1], ['worker'], {
      cwd: repoRoot,
      execArgv: [],
      env: {
        ...process.env,
        CAOGEN_LAYERED_MEMORY_MODULE: modulePath,
        CAOGEN_LAYERED_MEMORY_ROOT: root,
        CAOGEN_LAYERED_MEMORY_CHECKPOINT: checkpoint
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    let settled = false
    let message
    let stderr = ''
    const timeout = setTimeout(() => finish(new Error(`Layered Memory worker timed out at ${checkpoint}`)), 15_000)
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
  const root = requiredEnv('CAOGEN_LAYERED_MEMORY_ROOT')
  const target = path.resolve(storePath(root))
  const parent = path.dirname(target)
  const checkpoint = requiredEnv('CAOGEN_LAYERED_MEMORY_CHECKPOINT')
  Module._load = function patchedLoad(request, owner, isMain) {
    if (request === 'node:fs/promises') return faultInjectingPromises(realPromises, target, parent, checkpoint)
    return originalLoad.call(this, request, owner, isMain)
  }
  let runtime
  try {
    runtime = require(requiredEnv('CAOGEN_LAYERED_MEMORY_MODULE'))
    await runtime.addMemory(root, recoveryInput)
    process.send?.({ type: 'completed' })
  } catch (error) {
    if (checkpoint === 'post_directory_sync_throw' && runtime) {
      const before = readFileSync(target)
      const recovered = await runtime.addMemory(root, recoveryInput)
      const after = readFileSync(target)
      process.send?.({
        type: 'error',
        code: error?.code,
        message: String(error?.message ?? error),
        recoveredRevision: recovered.revision,
        replayByteStable: before.equals(after)
      })
    } else {
      process.send?.({ type: 'error', code: error?.code, message: String(error?.message ?? error) })
    }
    process.exitCode = 2
  } finally {
    Module._load = originalLoad
  }
}

function faultInjectingPromises(realPromises, target, parent, checkpoint) {
  return {
    ...realPromises,
    open: async (...args) => wrapHandle(await realPromises.open(...args), path.resolve(String(args[0])), target, parent, checkpoint),
    rename: async (...args) => {
      const result = await realPromises.rename(...args)
      if (path.resolve(String(args[1])) === target && checkpoint === 'after_rename') await pauseAt(checkpoint)
      return result
    }
  }
}

function wrapHandle(handle, openedPath, target, parent, checkpoint) {
  const temporary = openedPath !== target && path.dirname(openedPath) === parent && openedPath.endsWith('.tmp')
  const directory = openedPath === parent
  return new Proxy(handle, {
    get(owner, property) {
      if (property === 'writeFile' && temporary) return async (...args) => {
        const result = await owner.writeFile(...args)
        if (checkpoint === 'after_write') await pauseAt(checkpoint)
        return result
      }
      if (property === 'sync') return async (...args) => {
        const result = await owner.sync(...args)
        if (temporary && checkpoint === 'after_file_sync') await pauseAt(checkpoint)
        if (directory && checkpoint === 'post_directory_sync_throw') {
          throw Object.assign(new Error('injected Layered Memory unknown result'), { code: 'EUNKNOWNRESULT' })
        }
        return result
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
    'src/main/memory/memory-manager.ts',
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

function scenarioRoot(name) {
  const root = path.join(tempRoot, name)
  mkdirSync(root, { recursive: true })
  return root
}

function storePath(root) {
  return path.join(root, 'memory-index.json')
}

function readDocument(root) {
  return JSON.parse(readFileSync(storePath(root), 'utf8'))
}

function temporaryFiles(root) {
  if (!existsSync(root)) return []
  return readdirSync(root).filter((name) => name.startsWith('.memory-index.json.') && name.endsWith('.tmp')).sort()
}

function fileIdentity(file) {
  const info = statSync(file)
  return { device: String(info.dev), inode: String(info.ino), size: info.size, digest: sha256(readFileSync(file)) }
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
