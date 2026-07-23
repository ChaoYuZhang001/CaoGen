#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const startedAt = new Date().toISOString()
const runId = startedAt.replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'supervisor-restart-e2e')
const reportDir = path.join(reportRoot, runId)
const reportPath = path.join(reportDir, 'report.json')
const latestPath = path.join(reportRoot, 'latest.json')
const isWorker = process.argv[2] === 'worker'
const tempRoot = isWorker ? '' : mkdtempSync(path.join(tmpdir(), 'caogen-supervisor-restart-'))
const compiledDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
const baseNow = 10_000
const ttlMs = 100
let result
let failure

async function runSuite() {
try {
  compileSources(compiledDir)
  const modulePath = path.join(compiledDir, 'main', 'task', 'supervisor-state.js')
  const childExit = await crashWorker(modulePath)
  if (process.platform !== 'win32') assert.equal(childExit.signal, 'SIGKILL')

  const runtime = await import(pathToFileURL(modulePath).href)
  const { SupervisorStateError, SupervisorStateStore } = runtime
  const restarted = new SupervisorStateStore(userData, { now: () => baseNow + ttlMs + 1 })
  const recovery = await restarted.recoverExpiredLeases()
  assert.deepEqual(recovery, { expiredRunIds: ['strong-kill-run'], blockedRunIds: ['strong-kill-run'] })
  const blocked = await restarted.getRun('strong-kill-run')
  assert.equal(blocked?.status, 'blocked')
  assert.equal(blocked?.lease, undefined)
  assert.equal(blocked?.fencingToken, 1)

  const takeover = await restarted.acquireLease('strong-kill-run', {
    ownerId: 'restarted-worker',
    expectedRevision: blocked.revision,
    ttlMs,
    now: baseNow + ttlMs + 1
  })
  assert.equal(takeover.lease?.fencingToken, 2)
  await assert.rejects(
    restarted.heartbeatLease('strong-kill-run', {
      ownerId: 'restarted-worker',
      leaseId: takeover.lease.id,
      fencingToken: 1,
      expectedRevision: takeover.revision,
      now: baseNow + ttlMs + 1
    }),
    (error) => error instanceof SupervisorStateError && error.code === 'stale_lease'
  )
  const events = await restarted.listEvents('strong-kill-run')
  assert(events.some((event) => event.kind === 'lease.expired'))
  assert(events.some((event) => event.kind === 'lease.acquired' && event.fencingToken === 2))

  result = {
    status: 'PASS',
    classification: 'blocked_then_explicit_retry',
    childSignal: childExit.signal ?? null,
    recovery,
    fencingToken: takeover.lease?.fencingToken,
    eventCount: events.length
  }
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  failure = serializeError(error)
  throw error
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
  writeReport({
    status: result ? 'passed' : 'failed',
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    gate: 'test:supervisor-restart',
    result: result ?? null,
    error: failure,
    environment: { platform: process.platform, arch: process.arch, node: process.version }
  })
}
}

async function crashWorker(modulePath) {
  return new Promise((resolve, reject) => {
    const child = fork(process.argv[1], ['worker'], {
      cwd: repoRoot,
      env: { ...process.env, CAOGEN_SUPERVISOR_MODULE: modulePath, CAOGEN_SUPERVISOR_ROOT: userData },
      execArgv: [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
    let killed = false
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      if (!killed) child.kill('SIGKILL')
      reject(new Error(`strong-kill worker timed out\n${stdout}\n${stderr}`))
    }, 20_000)
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('message', (message) => {
      if (message?.kind !== 'lease-ready' || killed) return
      killed = true
      child.kill('SIGKILL')
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timeout)
      if (!killed) {
        reject(new Error(`worker exited before durable lease: ${code}/${signal}\n${stdout}\n${stderr}`))
        return
      }
      resolve({ code, signal })
    })
  })
}

async function runWorker() {
  const runtime = await import(pathToFileURL(process.env.CAOGEN_SUPERVISOR_MODULE).href)
  const { SupervisorStateStore } = runtime
  const store = new SupervisorStateStore(process.env.CAOGEN_SUPERVISOR_ROOT, { now: () => baseNow })
  const created = await store.createRun({
    id: 'strong-kill-run', projectId: 'restart-project', workItemId: 'restart-work'
  }, { actorId: 'worker' })
  const lease = await store.acquireLease('strong-kill-run', {
    ownerId: 'crashed-worker', expectedRevision: created.revision, ttlMs
  })
  await store.startRun('strong-kill-run', {
    ownerId: 'crashed-worker', leaseId: lease.lease.id,
    fencingToken: lease.lease.fencingToken, expectedRevision: lease.revision
  })
  process.send?.({ kind: 'lease-ready' })
  await new Promise(() => {})
}

function compileSources(outDir) {
  mkdirSync(outDir, { recursive: true })
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules/typescript/bin/tsc'),
    'src/shared/supervisor-types.ts',
    'src/main/task/supervisor-state.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function writeReport(report) {
  try {
    mkdirSync(reportDir, { recursive: true })
    const body = `${JSON.stringify({ ...report, reportPath: path.relative(repoRoot, reportPath) }, null, 2)}\n`
    writeFileSync(reportPath, body, 'utf8')
    writeFileSync(latestPath, body, 'utf8')
  } catch (error) {
    console.error(`Supervisor restart report could not be written: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    code: error && typeof error === 'object' && 'code' in error ? error.code : undefined
  }
}

if (isWorker) await runWorker()
else await runSuite()
