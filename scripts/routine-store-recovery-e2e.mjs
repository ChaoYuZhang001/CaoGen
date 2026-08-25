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
const reportRoot = path.join(repoRoot, 'test-results', 'routine-store-recovery')
const reportDir = path.join(reportRoot, runId)
const tempRoot = workerMode ? '' : mkdtempSync(path.join(tmpdir(), 'caogen-routine-store-recovery-'))
const compiledDir = path.join(tempRoot, 'compiled')
const writer = 'src/main/routineStore.ts'
const recoveryInput = {
  id: 'routine-recovery-create',
  name: 'Recovery create',
  prompt: 'Verify durable Routine creation.',
  projectId: 'routine-recovery-project',
  schedule: '1h',
  providerId: 'provider-recovery',
  model: 'model-recovery',
  permissionMode: 'default',
  budgetUsd: 1,
  notification: { enabled: false, onSuccess: true, onFailure: true },
  enabled: true,
  createdAt: 1_000,
  updatedAt: 1_000,
  lastRunAt: null,
  nextRunAt: 3_600_000
}
const currentInput = {
  id: 'routine-recovery-current',
  name: 'Current routine',
  prompt: 'Protect current Routine state.',
  projectId: 'routine-recovery-project',
  schedule: '2h',
  createdAt: 2_000,
  updatedAt: 2_000,
  nextRunAt: 7_200_000
}

if (workerMode) await runWorker()
else await runParent()

async function runParent() {
  let report
  try {
    compileSources()
    const modulePath = findCompiledModule(compiledDir)
    const strongKill = []
    for (const checkpoint of ['after_write', 'after_file_sync', 'after_rename']) {
      strongKill.push(await verifyStrongKill(modulePath, checkpoint))
    }
    report = {
      schemaVersion: 1,
      gate: 'test:routine-store-recovery',
      runId,
      status: 'passed',
      verification: 'runtime_store_verified',
      sourceRevision: git(['rev-parse', 'HEAD']),
      worktreeStatusCount: gitStatusCount(),
      writer,
      scope: 'Routine definition create, update, and revision conflict handling',
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
      gate: 'test:routine-store-recovery',
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

async function verifyStrongKill(modulePath, checkpoint) {
  const root = scenarioRoot(`strong-kill-${checkpoint}`)
  await seed(modulePath, root)
  const exit = await invokeWorker(modulePath, root, checkpoint, true)
  assert.equal(exit.signal, 'SIGKILL', `${checkpoint} worker must receive SIGKILL`)
  const observed = readDocument(root)
  assert([1, 2].includes(observed.routines.length), `${checkpoint} left a partial Store generation`)
  assert(observed.routines.every((routine) => Number.isSafeInteger(routine.revision) && routine.revision >= 1))

  const runtime = require(modulePath)
  const recovered = await runtime.createRoutine(root, recoveryInput)
  assert.equal(recovered.id, recoveryInput.id)
  const finalDocument = readDocument(root)
  assert.equal(finalDocument.version, 2)
  assert.equal(finalDocument.routines.length, 2)
  assert.equal(finalDocument.routines.filter((routine) => routine.id === recoveryInput.id).length, 1)
  assert.deepEqual(temporaryFiles(root), [])
  return {
    checkpoint,
    signal: exit.signal,
    publishedBeforeKill: observed.routines.length === 2,
    recoveredRecordCount: finalDocument.routines.length,
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
  assert.equal(document.routines.length, 2)
  assert.deepEqual(temporaryFiles(root), [])
  return {
    errorCode: exit.message.code,
    recoveredRevision: exit.message.recoveredRevision,
    replayByteStable: true,
    recordCount: document.routines.length,
    orphanTemporaryCount: 0
  }
}

async function verifyDuplicate(modulePath) {
  const root = scenarioRoot('duplicate')
  await seed(modulePath, root)
  const runtime = require(modulePath)
  const first = await runtime.createRoutine(root, recoveryInput)
  const before = fileIdentity(storePath(root))
  const second = await runtime.createRoutine(root, recoveryInput)
  assert.deepEqual(second, first)
  assert.deepEqual(fileIdentity(storePath(root)), before, 'duplicate create must not republish the Store')
  await assert.rejects(
    runtime.createRoutine(root, { ...recoveryInput, prompt: 'Conflicting duplicate content.' }),
    /already exists with different content/
  )
  assert.deepEqual(fileIdentity(storePath(root)), before, 'identity conflict must preserve canonical bytes')
  return {
    recordCount: 2,
    revisionStable: true,
    identityStable: true,
    identityConflictRejected: true,
    canonicalDigest: before.digest
  }
}

async function verifyOutOfOrder(modulePath) {
  const root = scenarioRoot('out-of-order')
  await seed(modulePath, root)
  const runtime = require(modulePath)
  const current = await runtime.updateRoutine(root, currentInput.id, {
    name: 'Current accepted update',
    expectedRevision: 1
  })
  assert.equal(current.revision, 2)
  const before = readFileSync(storePath(root))
  await assert.rejects(
    runtime.updateRoutine(root, currentInput.id, {
      name: 'Delayed stale update',
      expectedRevision: 1
    }),
    /Routine revision conflict: expected 1, got 2/
  )
  await assert.rejects(
    runtime.deleteRoutine(root, currentInput.id, 1),
    /Routine revision conflict: expected 1, got 2/
  )
  const after = readFileSync(storePath(root))
  assert.deepEqual(after, before, 'delayed mutation replaced canonical bytes')
  const recovered = (await runtime.listRoutines(root)).find((routine) => routine.id === currentInput.id)
  assert.equal(recovered?.name, 'Current accepted update')
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
  const runtime = require(modulePath)
  return runtime.createRoutine(root, currentInput)
}

function invokeWorker(modulePath, root, checkpoint, killAtCheckpoint) {
  return new Promise((resolve, reject) => {
    const child = fork(process.argv[1], ['worker'], {
      cwd: repoRoot,
      execArgv: [],
      env: {
        ...process.env,
        CAOGEN_ROUTINE_STORE_MODULE: modulePath,
        CAOGEN_ROUTINE_STORE_ROOT: root,
        CAOGEN_ROUTINE_STORE_CHECKPOINT: checkpoint
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    let settled = false
    let message
    let stderr = ''
    const timeout = setTimeout(() => finish(new Error(`Routine Store worker timed out at ${checkpoint}`)), 15_000)
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
  const root = requiredEnv('CAOGEN_ROUTINE_STORE_ROOT')
  const target = path.resolve(storePath(root))
  const parent = path.dirname(target)
  const checkpoint = requiredEnv('CAOGEN_ROUTINE_STORE_CHECKPOINT')
  Module._load = function patchedLoad(request, owner, isMain) {
    if (request === 'node:fs/promises') return faultInjectingPromises(realPromises, target, parent, checkpoint)
    return originalLoad.call(this, request, owner, isMain)
  }
  let runtime
  try {
    runtime = require(requiredEnv('CAOGEN_ROUTINE_STORE_MODULE'))
    await runtime.createRoutine(root, recoveryInput)
    process.send?.({ type: 'completed' })
  } catch (error) {
    if (checkpoint === 'post_directory_sync_throw' && runtime) {
      const before = readFileSync(target)
      const recovered = await runtime.createRoutine(root, recoveryInput)
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
          throw Object.assign(new Error('injected Routine Store unknown result'), { code: 'EUNKNOWNRESULT' })
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
    'src/main/routineStore.ts',
    '--outDir', compiledDir,
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'pipe' })
}

function findCompiledModule(root) {
  const entries = readdirSync(root, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledModule(fullPath)
      if (found) return found
    } else if (entry.isFile() && entry.name === 'routineStore.js') return fullPath
  }
  return undefined
}

function scenarioRoot(name) {
  const root = path.join(tempRoot, name)
  mkdirSync(root, { recursive: true })
  return root
}

function storePath(root) {
  return path.join(root, 'routines.json')
}

function readDocument(root) {
  return JSON.parse(readFileSync(storePath(root), 'utf8'))
}

function temporaryFiles(root) {
  if (!existsSync(root)) return []
  return readdirSync(root).filter((name) => name.startsWith('.routines.json.') && name.endsWith('.tmp')).sort()
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
