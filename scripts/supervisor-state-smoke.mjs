#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const startedAt = new Date().toISOString()
const runId = startedAt.replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'supervisor-state-smoke')
const reportDir = path.join(reportRoot, runId)
const reportPath = path.join(reportDir, 'report.json')
const latestPath = path.join(reportRoot, 'latest.json')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-supervisor-state-'))
const outDir = path.join(tempRoot, 'compiled')
let now = 1_000
let result
let failure

try {
  compileSources()
  const runtime = await import(pathToFileURL(path.join(outDir, 'main/task/supervisor-state.js')).href)
  const { SupervisorStateError, SupervisorStateStore } = runtime
  const store = new SupervisorStateStore(path.join(tempRoot, 'user-data'), { now: () => now })

  const first = await store.createRun({
    id: 'run-a',
    projectId: 'project-a',
    goalId: 'goal-a',
    workItemId: 'work-a',
    maxRetries: 1
  }, { actorId: 'user' })
  assert.equal(first.status, 'queued')
  assert.equal(first.revision, 1)

  const leaseA = await store.acquireLease('run-a', {
    ownerId: 'worker-a',
    expectedRevision: first.revision,
    ttlMs: 100,
    actorId: 'worker-a'
  })
  assert.equal(leaseA.lease?.fencingToken, 1)
  const running = await store.startRun('run-a', token(leaseA, 'worker-a'))
  assert.equal(running.status, 'running')

  await rejectsCode(
    store.startRun('run-a', { ...token(leaseA, 'worker-a'), expectedRevision: leaseA.revision }),
    'stale_revision'
  )

  const waiting = await store.requestApproval('run-a', { id: 'approval-a', reason: 'release gate' }, token(running, 'worker-a'))
  assert.equal(waiting.status, 'waiting_approval')
  const heartbeat = await store.heartbeatLease('run-a', { ...token(waiting, 'worker-a'), ttlMs: 100 })
  assert(heartbeat.lease?.expiresAt > now)
  const approval = await store.resolveApproval('run-a', {
    approvalId: 'approval-a',
    approved: true,
    expectedRevision: heartbeat.revision,
    actorId: 'reviewer'
  })
  assert.equal(approval.status, 'paused')
  assert.equal(approval.lease, undefined)

  const leaseB = await store.acquireLease('run-a', { ownerId: 'worker-b', expectedRevision: approval.revision, ttlMs: 100 })
  assert.equal(leaseB.lease?.fencingToken, 2)
  const resumed = await store.resumeRun('run-a', token(leaseB, 'worker-b'))
  const paused = await store.pauseRun('run-a', token(resumed, 'worker-b'))
  assert.equal(paused.status, 'paused')
  assert.equal(paused.lease, undefined)

  const leaseC = await store.acquireLease('run-a', { ownerId: 'worker-c', expectedRevision: paused.revision, ttlMs: 100 })
  const reassigned = await store.reassignLease('run-a', 'worker-d', token(leaseC, 'worker-c'))
  assert.equal(reassigned.lease?.ownerId, 'worker-d')
  assert.equal(reassigned.lease?.fencingToken, 4)
  await rejectsCode(
    store.heartbeatLease('run-a', { ...token(leaseC, 'worker-c'), expectedRevision: reassigned.revision }),
    'lease_owner'
  )
  const reassignedRunning = await store.resumeRun('run-a', token(reassigned, 'worker-d'))
  const completed = await store.completeRun('run-a', token(reassignedRunning, 'worker-d'))
  assert.equal(completed.status, 'completed')
  assert.equal(completed.lease, undefined)

  const second = await store.createRun({ id: 'run-b', projectId: 'project-a', workItemId: 'work-b', maxRetries: 1 })
  const leaseExpired = await store.acquireLease('run-b', { ownerId: 'worker-a', expectedRevision: second.revision, ttlMs: 10 })
  await store.startRun('run-b', token(leaseExpired, 'worker-a'))
  now += 11
  const recovery = await store.recoverExpiredLeases()
  assert.deepEqual(recovery.expiredRunIds, ['run-b'])
  assert.deepEqual(recovery.blockedRunIds, ['run-b'])
  const blocked = await store.getRun('run-b')
  assert.equal(blocked?.status, 'blocked')
  assert.equal(blocked?.lease, undefined)
  const retried = await store.authorizeRetry('run-b', { expectedRevision: blocked.revision, actorId: 'reviewer' })
  assert.equal(retried.status, 'queued')
  assert.equal(retried.retryCount, 1)
  const retryLease = await store.acquireLease('run-b', { ownerId: 'worker-z', expectedRevision: retried.revision, ttlMs: 100 })
  const retryRunning = await store.startRun('run-b', token(retryLease, 'worker-z'))
  const failed = await store.failRun('run-b', 'test failed', token(retryRunning, 'worker-z'))
  assert.equal(failed.status, 'failed')
  await rejectsCode(store.authorizeRetry('run-b', { expectedRevision: failed.revision }), 'retry_limit')

  const third = await store.createRun({ id: 'run-c', projectId: 'project-a', workItemId: 'work-c' })
  const race = await Promise.allSettled([
    store.acquireLease('run-c', { ownerId: 'race-a', expectedRevision: third.revision }),
    new SupervisorStateStore(path.join(tempRoot, 'user-data'), { now: () => now }).acquireLease('run-c', {
      ownerId: 'race-b', expectedRevision: third.revision
    })
  ])
  assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(race.filter((result) => result.status === 'rejected' && result.reason?.code === 'stale_revision').length, 1)

  const reopened = new SupervisorStateStore(path.join(tempRoot, 'user-data'), { now: () => now })
  const persisted = await reopened.read()
  assert.equal(persisted.runs.length, 3)
  assert(persisted.events.length >= 20)
  assert.deepEqual(persisted.events.map((event) => event.seq), persisted.events.map((_event, index) => index + 1))
  assert.equal((await reopened.getRun('run-a')).status, 'completed')

  writeFileSync(reopened.filePath, '{not-json')
  await rejectsCode(reopened.read(), 'corrupt_store')
  result = {
    status: 'PASS',
    runs: persisted.runs.length,
    events: persisted.events.length,
    fencingTokens: persisted.events.filter((event) => event.kind.startsWith('lease.')).map((event) => event.fencingToken).filter(Boolean)
  }
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  failure = serializeError(error)
  throw error
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
  writeReport({
    schemaVersion: 1,
    status: result ? 'passed' : 'failed',
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    gate: 'test:supervisor-state',
    result: result ?? null,
    error: failure,
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version
    }
  })
}

function writeReport(report) {
  try {
    mkdirSync(reportDir, { recursive: true })
    const body = `${JSON.stringify({
      ...report,
      reportDir: path.relative(repoRoot, reportDir),
      reportPath: path.relative(repoRoot, reportPath)
    }, null, 2)}\n`
    writeFileSync(reportPath, body, 'utf8')
    writeFileSync(latestPath, body, 'utf8')
  } catch (error) {
    console.error(`Supervisor state report could not be written: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    code: error && typeof error === 'object' && 'code' in error ? error.code : undefined
  }
}

function token(run, ownerId) {
  return {
    ownerId,
    leaseId: run.lease?.id,
    fencingToken: run.lease?.fencingToken,
    expectedRevision: run.revision
  }
}

async function rejectsCode(promise, code) {
  try {
    await promise
  } catch (error) {
    assert.equal(error.code, code, `expected ${code}, got ${error?.code}: ${error?.message}`)
    return
  }
  assert.fail(`expected ${code} rejection`)
}

function compileSources() {
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
