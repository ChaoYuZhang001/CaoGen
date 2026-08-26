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
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const scriptPath = fileURLToPath(import.meta.url)
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()
const workerMode = process.argv[2] === '--worker'
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'task-snapshot-recovery')
const reportDir = path.join(reportRoot, runId)
const tempRoot = workerMode ? '' : mkdtempSync(path.join(tmpdir(), 'caogen-task-snapshot-recovery-'))
const compiledDir = path.join(tempRoot, 'compiled')
const writer = 'src/main/task/task-snapshot.ts'
let snapshotRuntime

if (workerMode) await runWorker()
else await runParent()

async function runParent() {
  let report
  try {
    compileSources()
    installElectronStub()
    const modulePath = path.join(compiledDir, 'main', 'task', 'task-snapshot.js')
    const runtime = await import(pathToFileURL(modulePath).href)
    snapshotRuntime = runtime
    const strongKill = []
    for (const checkpoint of ['after_write', 'after_file_sync', 'after_publish']) {
      strongKill.push(await verifyStrongKill(modulePath, runtime, checkpoint))
    }
    report = {
      schemaVersion: 1,
      gate: 'test:task-snapshot-recovery',
      runId,
      status: 'passed',
      verification: 'runtime_store_verified',
      sourceRevision: git(['rev-parse', 'HEAD']),
      worktreeStatusCount: gitStatusCount(),
      writer,
      scope: 'Task Snapshot SQLite export publication, restart recovery and merge fencing',
      faults: {
        strong_kill: { status: 'verified', scenarios: strongKill },
        network_unknown_result: { status: 'verified', scenario: await verifyUnknownResult(modulePath, runtime) },
        duplicate_idempotency: { status: 'verified', scenario: await verifyDuplicate(runtime) },
        out_of_order: { status: 'verified', scenario: await verifyOutOfOrder(runtime) }
      }
    }
  } catch (error) {
    report = {
      schemaVersion: 1,
      gate: 'test:task-snapshot-recovery',
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

async function verifyStrongKill(modulePath, runtime, checkpoint) {
  const root = scenarioRoot(`strong-kill-${checkpoint}`)
  await runtime.listTaskSnapshots(root)
  const before = fileIdentity(dbPath(root))
  const exit = await invokeWorker(modulePath, root, checkpoint, true)
  assert.equal(exit.signal, 'SIGKILL', `${checkpoint} worker must receive SIGKILL`)
  assert.equal(existsSync(dbPath(root)), true)
  const snapshots = await runtime.listTaskSnapshots(root)
  const publishedBeforeKill = checkpoint === 'after_publish'
  assert.equal(snapshots.length, publishedBeforeKill ? 1 : 0)
  const recovered = await runtime.saveTaskSnapshot(snapshot('recovered', 2_000, 2), root)
  assert.equal(recovered.id, 'snapshot-recovery')
  assert.equal((await runtime.listTaskSnapshots(root)).length, 1)
  assert.deepEqual(temporaryFiles(root), [])
  return {
    checkpoint,
    signal: exit.signal,
    priorDigest: before.digest,
    publishedBeforeKill,
    restartRows: snapshots.length,
    finalDigest: sha256(readFileSync(dbPath(root))),
    orphanTemporaryCount: 0
  }
}

async function verifyUnknownResult(modulePath, runtime) {
  const root = scenarioRoot('unknown-result')
  await runtime.listTaskSnapshots(root)
  const exit = await invokeWorker(modulePath, root, 'post_directory_sync_throw', false)
  assert.equal(exit.code, 2)
  assert.equal(exit.messages.find((message) => message?.type === 'error')?.code, 'EUNKNOWNRESULT')
  const snapshots = await runtime.listTaskSnapshots(root)
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0].id, 'snapshot-recovery')
  const before = fileIdentity(dbPath(root))
  const replay = await runtime.saveTaskSnapshot(snapshot('replayed', 2_000, 2), root)
  assert.equal(replay.id, 'snapshot-recovery')
  assert.equal((await runtime.listTaskSnapshots(root)).length, 1)
  assert.deepEqual(temporaryFiles(root), [])
  return {
    injectedErrorCode: 'EUNKNOWNRESULT',
    publishedDatabaseReadBack: true,
    replayRowCount: 1,
    priorDigest: before.digest,
    finalDigest: sha256(readFileSync(dbPath(root)))
  }
}

async function verifyDuplicate(runtime) {
  const root = scenarioRoot('duplicate')
  await runtime.listTaskSnapshots(root)
  const first = await runtime.saveTaskSnapshot(snapshot('first', 1_000, 1), root)
  const before = fileIdentity(dbPath(root))
  const second = await runtime.saveTaskSnapshot(snapshot('duplicate', 1_000, 1), root)
  const rows = await runtime.listTaskSnapshots(root)
  assert.equal(rows.length, 1)
  assert.equal(second.id, first.id)
  assert.equal(rows[0].eventCount, 1)
  assert.equal(rows[0].execution.lastSeq, 1)
  return {
    firstSnapshotId: first.id,
    duplicateSnapshotId: second.id,
    canonicalRowCount: rows.length,
    identityBeforeReplay: before,
    finalDigest: sha256(readFileSync(dbPath(root)))
  }
}

async function verifyOutOfOrder(runtime) {
  const root = scenarioRoot('out-of-order')
  await runtime.listTaskSnapshots(root)
  await runtime.saveTaskSnapshot(snapshot('newer', 3_000, 9), root)
  const stale = await runtime.saveTaskSnapshot(snapshot('stale', 2_000, 2), root)
  const rows = await runtime.listTaskSnapshots(root)
  assert.equal(rows.length, 1)
  assert.equal(stale.updatedAt, 3_000)
  assert.equal(rows[0].updatedAt, 3_000)
  assert.equal(rows[0].eventCount, 9)
  assert.equal(rows[0].execution.lastSeq, 9)
  return {
    delayedWriterAudited: true,
    canonicalStateNotRegressed: true,
    updatedAt: rows[0].updatedAt,
    eventCount: rows[0].eventCount,
    finalDigest: sha256(readFileSync(dbPath(root)))
  }
}

function invokeWorker(modulePath, root, checkpoint, killAtCheckpoint) {
  return new Promise((resolve, reject) => {
    const child = fork(scriptPath, ['--worker'], {
      cwd: repoRoot,
      execArgv: [],
      env: {
        ...process.env,
        CAOGEN_TASK_SNAPSHOT_MODULE: modulePath,
        CAOGEN_TASK_SNAPSHOT_ROOT: root,
        CAOGEN_TASK_SNAPSHOT_CHECKPOINT: checkpoint
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    const messages = []
    let settled = false
    let stderr = ''
    const timeout = setTimeout(() => finish(new Error(`Task Snapshot worker timed out at ${checkpoint}`)), 20_000)
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
  const root = path.resolve(requiredEnv('CAOGEN_TASK_SNAPSHOT_ROOT'))
  const target = dbPath(root)
  const parent = path.dirname(target)
  const checkpoint = requiredEnv('CAOGEN_TASK_SNAPSHOT_CHECKPOINT')
  Module._load = function patchedLoad(request, owner, isMain) {
    if (request === 'node:fs/promises') return faultInjectingPromises(realPromises, target, parent, checkpoint)
    return originalLoad.call(this, request, owner, isMain)
  }
  try {
    const runtime = require(requiredEnv('CAOGEN_TASK_SNAPSHOT_MODULE'))
    await runtime.saveTaskSnapshot(runtime.buildTaskSnapshot({
      meta: meta('snapshot-recovery', 'running'),
      transcript: [],
      lastSeq: 1,
      eventCount: 1,
      reason: 'event-batch',
      now: 1_000
    }), root)
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
      if (checkpoint === 'after_publish' && path.resolve(String(args[1])) === target) await pauseAt(checkpoint)
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
          throw Object.assign(new Error('injected Task Snapshot unknown result'), { code: 'EUNKNOWNRESULT' })
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

function snapshot(marker, updatedAt, eventCount) {
  const runtime = snapshotRuntime
  return runtime.buildTaskSnapshot({
    meta: meta('snapshot-recovery', 'running'),
    transcript: [],
    lastSeq: eventCount,
    eventCount,
    reason: marker === 'stale' ? 'recovered' : 'event-batch',
    now: updatedAt
  })
}

function meta(id, status) {
  return {
    id,
    title: 'Task Snapshot recovery fixture',
    cwd: repoRoot,
    sourceCwd: repoRoot,
    model: 'recovery-model',
    providerId: 'recovery-provider',
    engine: 'openai',
    taskStrategy: 'execute',
    permissionMode: 'default',
    status,
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt: 1_000
  }
}

function installElectronStub() {
  const electronDir = path.join(compiledDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), 'module.exports = { app: { getPath: () => process.cwd() } }\n')
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"commonjs"}\n')
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/task/task-snapshot.ts',
    '--outDir', compiledDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
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
function dbPath(root) { return path.join(root, 'task-snapshots.db') }
function temporaryFiles(root) {
  if (!existsSync(root)) return []
  return readdirSync(root).filter((name) => name.startsWith('.task-snapshots.db.') && name.endsWith('.tmp')).sort()
}
function fileIdentity(file) {
  const info = statSync(file)
  return { device: String(info.dev), inode: String(info.ino), size: info.size, digest: sha256(readFileSync(file)) }
}
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function git(args) { try { return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim() } catch { return '' } }
function gitStatusCount() { return git(['status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter(Boolean).length }
function requiredEnv(name) { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value }
function serializeError(error) { return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { name: 'Error', message: String(error) } }
