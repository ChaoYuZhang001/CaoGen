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
  assert.equal((await store.authorizeTurn('run-a')).status, 'running')

  await rejectsCode(
    store.startRun('run-a', { ...token(leaseA, 'worker-a'), expectedRevision: leaseA.revision }),
    'stale_revision'
  )

  const waiting = await store.requestApproval('run-a', { id: 'approval-a', reason: 'release gate' }, token(running, 'worker-a'))
  assert.equal(waiting.status, 'waiting_approval')
  await assertRejectedWithoutMutation(store, () => store.authorizeTurn('run-a'), 'invalid_transition')
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
  await assertRejectedWithoutMutation(store, () => store.authorizeTurn('run-a'), 'invalid_transition')

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
  await assertRejectedWithoutMutation(store, () => store.authorizeTurn('run-b'), 'invalid_transition')
  const retried = await store.authorizeRetry('run-b', { expectedRevision: blocked.revision, actorId: 'reviewer' })
  assert.equal(retried.status, 'queued')
  assert.equal(retried.retryCount, 1)
  const retryLease = await store.acquireLease('run-b', { ownerId: 'worker-z', expectedRevision: retried.revision, ttlMs: 100 })
  const retryRunning = await store.startRun('run-b', token(retryLease, 'worker-z'))
  const failed = await store.failRun('run-b', 'test failed', token(retryRunning, 'worker-z'))
  assert.equal(failed.status, 'failed')
  await rejectsCode(store.authorizeRetry('run-b', { expectedRevision: failed.revision }), 'retry_limit')

  const reconciliation = await store.createRun({
    id: 'run-reconciliation', projectId: 'project-a', workItemId: 'work-reconciliation'
  })
  const reconciliationLease = await store.acquireLease(reconciliation.id, {
    ownerId: 'worker-r', expectedRevision: reconciliation.revision
  })
  const reconciliationRunning = await store.startRun(
    reconciliation.id,
    token(reconciliationLease, 'worker-r')
  )
  await store.markWaitingReconciliation(
    reconciliation.id,
    token(reconciliationRunning, 'worker-r')
  )
  await assertRejectedWithoutMutation(
    store,
    () => store.authorizeTurn(reconciliation.id),
    'invalid_transition'
  )

  const third = await store.createRun({ id: 'run-c', projectId: 'project-a', workItemId: 'work-c' })
  const race = await Promise.allSettled([
    store.acquireLease('run-c', { ownerId: 'race-a', expectedRevision: third.revision }),
    new SupervisorStateStore(path.join(tempRoot, 'user-data'), { now: () => now }).acquireLease('run-c', {
      ownerId: 'race-b', expectedRevision: third.revision
    })
  ])
  assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(race.filter((result) => result.status === 'rejected' && result.reason?.code === 'stale_revision').length, 1)

  const recoveryStore = new SupervisorStateStore(path.join(tempRoot, 'manual-recovery-data'), { now: () => now })
  const manualRecoveryRun = await recoveryStore.createRun({
    id: 'manual-expired', projectId: 'recovery-project', workItemId: 'manual-work'
  })
  const taskRunRecoveryRun = await recoveryStore.createRun({
    id: 'task-run-expired', projectId: 'recovery-project', workItemId: 'task-run-work', origin: 'task_run'
  })
  const manualRecoveryLease = await recoveryStore.acquireLease(manualRecoveryRun.id, {
    ownerId: 'manual-worker', expectedRevision: manualRecoveryRun.revision, ttlMs: 10
  })
  const taskRunRecoveryLease = await recoveryStore.acquireLease(taskRunRecoveryRun.id, {
    ownerId: 'task-run-worker', expectedRevision: taskRunRecoveryRun.revision, ttlMs: 10
  })
  await recoveryStore.startRun(manualRecoveryRun.id, token(manualRecoveryLease, 'manual-worker'))
  await recoveryStore.startRun(taskRunRecoveryRun.id, token(taskRunRecoveryLease, 'task-run-worker'))
  now += 11
  const manualRecovery = await recoveryStore.recoverExpiredManualLeases()
  assert.deepEqual(manualRecovery, {
    expiredRunIds: [manualRecoveryRun.id],
    blockedRunIds: [manualRecoveryRun.id]
  })
  assert.equal((await recoveryStore.getRun(taskRunRecoveryRun.id)).status, 'running')
  assert((await recoveryStore.getRun(taskRunRecoveryRun.id)).lease)
  const startupRecovery = await recoveryStore.recoverExpiredLeases()
  assert.deepEqual(startupRecovery, {
    expiredRunIds: [taskRunRecoveryRun.id],
    blockedRunIds: [taskRunRecoveryRun.id]
  })

  const budgetStore = new SupervisorStateStore(path.join(tempRoot, 'budget-data'), { now: () => now })
  const strictBudget = {
    amount: 1,
    currency: 'USD',
    maxTokens: 100,
    maxRuns: 2,
    maxConcurrentRuns: 1
  }
  const budgetRunA = await budgetStore.createRun({
    id: 'budget-run-a', projectId: 'budget-project', goalId: 'budget-goal',
    workItemId: 'budget-work-a', budget: strictBudget,
    accountingBase: { usage: usage(7, 3, 0, 0), costUsd: 0 }
  })
  await rejectsCode(budgetStore.createRun({
    id: 'budget-run-concurrent', projectId: 'budget-project', goalId: 'budget-goal',
    workItemId: 'budget-work-concurrent', budget: strictBudget
  }), 'concurrency_exhausted')
  const budgetLeaseA = await budgetStore.acquireLease(budgetRunA.id, {
    ownerId: 'budget-worker', expectedRevision: budgetRunA.revision
  })
  await budgetStore.startRun(budgetRunA.id, token(budgetLeaseA, 'budget-worker'))
  const budgetTurnA1 = await budgetStore.observeRun(budgetRunA.id, {
    taskRunStatus: 'executing', sourceEventId: 'budget-a-turn-1',
    usage: usage(10, 5, 1, 0), costUsd: 0.4, turnCompleted: true
  })
  assert.deepEqual(budgetTurnA1.usage, { ...usage(10, 5, 1, 0), costUsd: 0.4, turns: 1 })
  const beforeDuplicateBudgetTurn = await budgetStore.read()
  const duplicateBudgetTurn = await budgetStore.observeRun(budgetRunA.id, {
    taskRunStatus: 'executing', sourceEventId: 'budget-a-turn-1',
    usage: usage(90, 90, 90, 90), costUsd: 0.9, turnCompleted: true
  })
  const afterDuplicateBudgetTurn = await budgetStore.read()
  assert.equal(duplicateBudgetTurn.revision, budgetTurnA1.revision)
  assert.deepEqual(duplicateBudgetTurn.usage, budgetTurnA1.usage)
  assert.equal(afterDuplicateBudgetTurn.revision, beforeDuplicateBudgetTurn.revision)
  assert.equal(afterDuplicateBudgetTurn.events.length, beforeDuplicateBudgetTurn.events.length)
  const statusOnly = await budgetStore.observeRun(budgetRunA.id, {
    taskRunStatus: 'executing', sourceEventId: 'budget-a-status-only',
    usage: usage(999, 999, 999, 999), costUsd: 0.2
  })
  assert.deepEqual(statusOnly.usage, budgetTurnA1.usage)
  const budgetTurnA2 = await budgetStore.observeRun(budgetRunA.id, {
    taskRunStatus: 'executing', sourceEventId: 'budget-a-turn-2',
    usage: usage(20, 10, 2, 1), costUsd: 0.75, turnCompleted: true
  })
  assert.deepEqual(budgetTurnA2.usage, { ...usage(30, 15, 3, 1), costUsd: 0.75, turns: 2 })
  const budgetReopened = new SupervisorStateStore(path.join(tempRoot, 'budget-data'), { now: () => now })
  assert.deepEqual((await budgetReopened.getRun(budgetRunA.id)).usage, budgetTurnA2.usage)
  await budgetStore.completeRun(budgetRunA.id, token(budgetTurnA2, 'budget-worker'))

  const budgetRunB = await budgetStore.createRun({
    id: 'budget-run-b', projectId: 'budget-project', goalId: 'budget-goal',
    workItemId: 'budget-work-b', budget: strictBudget,
    accountingBase: { usage: usage(20, 10, 2, 1), costUsd: 0.75 }
  })
  await rejectsCode(budgetStore.createRun({
    id: 'budget-run-over-limit', projectId: 'budget-project', goalId: 'budget-goal',
    workItemId: 'budget-work-over-limit', budget: strictBudget
  }), 'budget_exhausted')
  const budgetTurnB1 = await budgetStore.observeRun(budgetRunB.id, {
    taskRunStatus: 'executing', sourceEventId: 'budget-b-turn-1',
    usage: usage(30, 15, 3, 3), costUsd: 1, turnCompleted: true
  })
  assert.deepEqual(budgetTurnB1.usage, { ...usage(30, 15, 3, 3), costUsd: 0.25, turns: 1 })
  await rejectsCode(budgetStore.authorizeTurn(budgetRunB.id), 'budget_exhausted')

  const usdStore = new SupervisorStateStore(path.join(tempRoot, 'usd-budget-data'), { now: () => now })
  const usdBudget = { amount: 1, currency: 'USD' }
  const usdRunA = await usdStore.createRun({
    id: 'usd-run-a', projectId: 'budget-project', goalId: 'usd-goal',
    workItemId: 'usd-work-a', budget: usdBudget,
    accountingBase: { usage: usage(0, 0, 0, 0), costUsd: 0 }
  })
  await usdStore.observeRun(usdRunA.id, {
    taskRunStatus: 'completed', sourceEventId: 'usd-a-turn-1',
    usage: usage(1, 1, 0, 0), costUsd: 0.6, turnCompleted: true
  })
  const usdRunB = await usdStore.createRun({
    id: 'usd-run-b', projectId: 'budget-project', goalId: 'usd-goal',
    workItemId: 'usd-work-b', budget: usdBudget,
    accountingBase: { usage: usage(1, 1, 0, 0), costUsd: 0.6 }
  })
  await usdStore.observeRun(usdRunB.id, {
    taskRunStatus: 'executing', sourceEventId: 'usd-b-turn-1',
    usage: usage(1, 1, 0, 0), costUsd: 1.05, turnCompleted: true
  })
  await rejectsCode(usdStore.authorizeTurn(usdRunB.id), 'budget_exhausted')
  await rejectsCode(usdStore.createRun({
    id: 'eur-run', projectId: 'budget-project', goalId: 'eur-goal',
    workItemId: 'eur-work', budget: { amount: 1, currency: 'EUR' }
  }), 'budget_exhausted')

  const retryStore = new SupervisorStateStore(path.join(tempRoot, 'retry-budget-data'), { now: () => now })
  const retryConcurrencyBudget = { maxConcurrentRuns: 1 }
  const retryRunA = await retryStore.createRun({
    id: 'retry-run-a', projectId: 'retry-project', goalId: 'retry-goal',
    workItemId: 'retry-work-a', budget: retryConcurrencyBudget, maxRetries: 1
  })
  await retryStore.observeRun(retryRunA.id, {
    taskRunStatus: 'failed', sourceEventId: 'retry-a-failed',
    usage: usage(0, 0, 0, 0), costUsd: 0
  })
  await retryStore.createRun({
    id: 'retry-run-b', projectId: 'retry-project', goalId: 'retry-goal',
    workItemId: 'retry-work-b', budget: retryConcurrencyBudget
  })
  await rejectsCode(retryStore.authorizeRetry(retryRunA.id, {
    expectedRevision: (await retryStore.getRun(retryRunA.id)).revision
  }), 'concurrency_exhausted')
  const exhaustedRetryRun = await retryStore.createRun({
    id: 'retry-token-run', projectId: 'retry-project', goalId: 'retry-token-goal',
    workItemId: 'retry-token-work', budget: { maxTokens: 10 }, maxRetries: 1
  })
  const failedExhaustedRetryRun = await retryStore.observeRun(exhaustedRetryRun.id, {
    taskRunStatus: 'failed', sourceEventId: 'retry-token-failed',
    usage: usage(5, 5, 0, 0), costUsd: 0, turnCompleted: true
  })
  await rejectsCode(retryStore.authorizeRetry(exhaustedRetryRun.id, {
    expectedRevision: failedExhaustedRetryRun.revision
  }), 'budget_exhausted')

  const reopened = new SupervisorStateStore(path.join(tempRoot, 'user-data'), { now: () => now })
  const persisted = await reopened.read()
  assert.equal(persisted.runs.length, 4)
  assert(persisted.events.length >= 20)
  assert.deepEqual(persisted.events.map((event) => event.seq), persisted.events.map((_event, index) => index + 1))
  assert.equal((await reopened.getRun('run-a')).status, 'completed')

  writeFileSync(reopened.filePath, '{not-json')
  await rejectsCode(reopened.read(), 'corrupt_store')
  result = {
    status: 'PASS',
    runs: persisted.runs.length,
    events: persisted.events.length,
    budget: {
      runATokens: totalTokens(budgetTurnA2.usage),
      aggregateTokens: totalTokens(budgetTurnA2.usage) + totalTokens(budgetTurnB1.usage),
      duplicateEventIdempotent: duplicateBudgetTurn.revision === budgetTurnA1.revision,
      restartUsagePreserved: true,
      usdAggregate: 1.05
    },
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

function usage(input, output, cacheRead, cacheCreation) {
  return { input, output, cacheRead, cacheCreation }
}

function totalTokens(value) {
  return value.input + value.output + value.cacheRead + value.cacheCreation
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

async function assertRejectedWithoutMutation(store, action, code) {
  const before = await store.read()
  await rejectsCode(action(), code)
  const after = await store.read()
  assert.equal(after.revision, before.revision)
  assert.equal(after.events.length, before.events.length)
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
