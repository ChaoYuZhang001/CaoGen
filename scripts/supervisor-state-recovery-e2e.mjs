#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = process.cwd()
const scriptPath = fileURLToPath(import.meta.url)
const require = createRequire(import.meta.url)
const workerMode = process.argv[2] === '--worker'
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'supervisor-state-recovery')
const reportDir = path.join(reportRoot, runId)
const tempRoot = workerMode ? '' : mkdtempSync(path.join(tmpdir(), 'caogen-supervisor-state-recovery-'))
const compiledDir = path.join(tempRoot, 'compiled')
const writer = 'src/main/task/supervisor-state.ts'

if (workerMode) await runWorker()
else await runParent()

async function runParent() {
  let report
  try {
    compileSources()
    const modulePath = path.join(compiledDir, 'main', 'task', 'supervisor-state.js')
    const strongKill = []
    for (const checkpoint of ['after_write', 'after_file_sync', 'after_publish']) {
      strongKill.push(await verifyStrongKill(modulePath, checkpoint))
    }
    report = {
      schemaVersion: 1,
      gate: 'test:supervisor-state-recovery',
      runId,
      status: 'passed',
      verification: 'runtime_store_verified',
      sourceRevision: git(['rev-parse', 'HEAD']),
      worktreeStatusCount: gitStatusCount(),
      writer,
      scope: 'Supervisor Run state publication, restart reconciliation, observation idempotency and revision fencing',
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
      gate: 'test:supervisor-state-recovery',
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
    const body = `${JSON.stringify(report, null, 2)}\n`
    writeFileSync(path.join(reportDir, 'report.json'), body, 'utf8')
    writeFileSync(path.join(reportRoot, 'latest.json'), body, 'utf8')
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
  const exit = await invokeWorker(modulePath, root, checkpoint, true)
  assert.equal(exit.signal, 'SIGKILL', `${checkpoint} worker must receive SIGKILL`)
  const target = statePath(root)
  const publishedBeforeKill = checkpoint === 'after_publish'
  assert.equal(existsSync(target), publishedBeforeKill)

  const runtime = require(modulePath)
  const store = new runtime.SupervisorStateStore(root, { now: () => 2_000 })
  const existing = await store.getRun('fault-run')
  if (existing) {
    assert.equal(existing.projectId, 'fault-project')
    await rejectsCode(store.createRun(runInput()), 'already_exists')
  } else {
    await store.createRun(runInput())
  }
  const recovered = await store.observeRun('fault-run', observation('recovery-observation', 2_000))
  assert.equal(recovered.status, 'running')
  assert.deepEqual(temporaryFiles(root), [])
  assert.equal(existsSync(lockPath(root)), false)
  return {
    checkpoint,
    signal: exit.signal,
    publishedBeforeKill,
    restartObservedPublishedRun: existing !== undefined,
    orphanTemporaryCount: 0,
    finalDigest: sha256(readFileSync(target))
  }
}

async function verifyUnknownResult(modulePath) {
  const root = scenarioRoot('unknown-result')
  const exit = await invokeWorker(modulePath, root, 'post_directory_sync_throw', false)
  assert.equal(exit.code, 2)
  assert.equal(exit.messages.find((message) => message?.type === 'error')?.code, 'EUNKNOWNRESULT')
  const target = statePath(root)
  assert.equal(existsSync(target), true)

  const runtime = require(modulePath)
  const store = new runtime.SupervisorStateStore(root, { now: () => 2_000 })
  const published = await store.getRun('fault-run')
  assert.equal(published?.projectId, 'fault-project')
  const before = fileIdentity(target)
  await rejectsCode(store.createRun(runInput()), 'already_exists')
  assert.deepEqual(fileIdentity(target), before)
  const reconciled = await store.observeRun('fault-run', observation('unknown-result-readback', 2_000))
  assert.equal(reconciled.status, 'running')
  assert.deepEqual(temporaryFiles(root), [])
  return {
    injectedErrorCode: 'EUNKNOWNRESULT',
    publishedIdentityReadBack: true,
    conflictingReplayRejected: true,
    finalDigest: sha256(readFileSync(target))
  }
}

async function verifyDuplicate(modulePath) {
  const root = scenarioRoot('duplicate')
  const runtime = require(modulePath)
  const store = new runtime.SupervisorStateStore(root, { now: () => 2_000 })
  await store.createRun(runInput())
  const first = await store.observeRun('fault-run', observation('stable-source-event', 2_000))
  const before = fileIdentity(statePath(root))
  const replay = await store.observeRun('fault-run', observation('stable-source-event', 2_000))
  assert.equal(replay.revision, first.revision)
  assert.deepEqual(replay.usage, first.usage)
  assert.deepEqual(fileIdentity(statePath(root)), before)
  return {
    sourceEventId: 'stable-source-event',
    runRevisionStable: true,
    fileIdentityStable: true,
    finalDigest: before.digest
  }
}

async function verifyOutOfOrder(modulePath) {
  const root = scenarioRoot('out-of-order')
  const runtime = require(modulePath)
  const firstStore = new runtime.SupervisorStateStore(root, { now: () => 3_000 })
  const secondStore = new runtime.SupervisorStateStore(root, { now: () => 3_000 })
  await firstStore.createRun(runInput())
  const current = await firstStore.observeRun('fault-run', observation('newer-observation', 3_000, 10))
  const delayed = await firstStore.observeRun('fault-run', {
    taskRunStatus: 'failed',
    sourceEventId: 'delayed-observation',
    observedAt: 2_000,
    usage: { input: 99, output: 99, cacheRead: 0, cacheCreation: 0 },
    costUsd: 99,
    turnCompleted: true
  })
  assert.equal(delayed.status, 'running')
  assert.equal(delayed.revision, current.revision)
  assert.deepEqual(delayed.usage, current.usage)
  const delayedEvent = (await firstStore.listEvents('fault-run'))
    .find((event) => event.payload.sourceEventId === 'delayed-observation')
  assert.equal(delayedEvent?.payload.ignored, true)

  const race = await Promise.allSettled([
    firstStore.acquireLease('fault-run', { ownerId: 'writer-a', expectedRevision: current.revision }),
    secondStore.acquireLease('fault-run', { ownerId: 'writer-b', expectedRevision: current.revision })
  ])
  assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(race.filter((result) => result.status === 'rejected' && result.reason?.code === 'stale_revision').length, 1)
  const final = await firstStore.getRun('fault-run')
  assert.equal(final?.fencingToken, 1)
  return {
    delayedObservationAudited: true,
    canonicalStateNotRegressed: true,
    concurrentWinnerCount: 1,
    staleWriterRejected: true,
    fencingToken: final.fencingToken,
    finalDigest: sha256(readFileSync(statePath(root)))
  }
}

function invokeWorker(modulePath, root, checkpoint, killAtCheckpoint) {
  return new Promise((resolve, reject) => {
    const child = fork(scriptPath, ['--worker'], {
      cwd: repoRoot,
      execArgv: [],
      env: {
        ...process.env,
        CAOGEN_SUPERVISOR_STATE_MODULE: modulePath,
        CAOGEN_SUPERVISOR_STATE_ROOT: root,
        CAOGEN_SUPERVISOR_STATE_CHECKPOINT: checkpoint
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    const messages = []
    let settled = false
    let stderr = ''
    const timeout = setTimeout(() => finish(new Error(`Supervisor state worker timed out at ${checkpoint}`)), 15_000)
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('message', (message) => {
      messages.push(message)
      if (killAtCheckpoint && message?.type === 'checkpoint' && message.checkpoint === checkpoint) {
        child.kill('SIGKILL')
      }
    })
    child.on('error', finish)
    child.on('exit', (code, signal) => finish(null, { code, signal, messages, stderr }))
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
  const root = path.resolve(requiredEnv('CAOGEN_SUPERVISOR_STATE_ROOT'))
  const target = statePath(root)
  const parent = path.dirname(target)
  const checkpoint = requiredEnv('CAOGEN_SUPERVISOR_STATE_CHECKPOINT')
  Module._load = function patchedLoad(request, owner, isMain) {
    if (request === 'node:fs/promises') {
      return faultInjectingPromises(realPromises, target, parent, checkpoint)
    }
    return originalLoad.call(this, request, owner, isMain)
  }
  try {
    const runtime = require(requiredEnv('CAOGEN_SUPERVISOR_STATE_MODULE'))
    const store = new runtime.SupervisorStateStore(root, { now: () => 1_000 })
    await store.createRun(runInput())
    process.send?.({ type: 'completed' })
  } catch (error) {
    process.send?.({ type: 'error', code: error?.code, message: String(error?.message ?? error) })
    process.exitCode = 2
  } finally {
    Module._load = originalLoad
  }
}

function faultInjectingPromises(realPromises, target, parent, checkpoint) {
  return {
    ...realPromises,
    open: async (...args) => wrapHandle(
      await realPromises.open(...args),
      path.resolve(String(args[0])),
      target,
      parent,
      checkpoint
    ),
    rename: async (...args) => {
      const result = await realPromises.rename(...args)
      if (checkpoint === 'after_publish' && path.resolve(String(args[1])) === target) {
        await pauseAt(checkpoint)
      }
      return result
    }
  }
}

function wrapHandle(handle, openedPath, target, parent, checkpoint) {
  const temporary = openedPath !== target && path.dirname(openedPath) === parent &&
    path.basename(openedPath).startsWith(`.${path.basename(target)}.`) && openedPath.endsWith('.tmp')
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
          throw Object.assign(new Error('injected Supervisor state unknown result'), { code: 'EUNKNOWNRESULT' })
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

function runInput() {
  return { id: 'fault-run', projectId: 'fault-project', goalId: 'fault-goal', workItemId: 'fault-work' }
}

function observation(sourceEventId, observedAt, tokens = 1) {
  return {
    taskRunStatus: 'running',
    sourceEventId,
    observedAt,
    usage: { input: tokens, output: 0, cacheRead: 0, cacheCreation: 0 },
    costUsd: 0,
    turnCompleted: false
  }
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code)
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/shared/supervisor-types.ts',
    'src/main/durable-file.ts',
    'src/main/task/supervisor-state.ts',
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

function statePath(root) { return path.join(root, 'supervisor-state.json') }
function lockPath(root) { return `${statePath(root)}.lock` }
function temporaryFiles(root) {
  if (!existsSync(root)) return []
  const prefix = '.supervisor-state.json.'
  return readdirSync(root).filter((name) => name.startsWith(prefix) && name.endsWith('.tmp')).sort()
}
function fileIdentity(file) {
  const info = statSync(file)
  return { device: String(info.dev), inode: String(info.ino), size: info.size, digest: sha256(readFileSync(file)) }
}
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function git(args) { try { return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim() } catch { return '' } }
function gitStatusCount() { return git(['status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter(Boolean).length }
function requiredEnv(name) { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value }
function serializeError(error) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { name: 'Error', message: String(error) }
}
