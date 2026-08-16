#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const Module = require('node:module').Module
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-worker-immutable-usage-'))
const outDir = path.join(tempRoot, 'compiled')
const baseRoot = path.join(tempRoot, 'base')
const unresolvedRoot = path.join(tempRoot, 'unresolved')
const missingCostRoot = path.join(tempRoot, 'missing-cost')
const corruptRoot = path.join(tempRoot, 'corrupt')
const startedAt = new Date().toISOString()
const reportRunId = startedAt.replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'digital-worker-immutable-usage')
const reportDir = path.join(reportRoot, reportRunId)
const checks = []
let failure

process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter)
Module._initPaths()

const previousMonth = new Date(2026, 0, 15, 12, 0, 0, 0).getTime()
const currentMonth = new Date(2026, 1, 15, 12, 0, 0, 0).getTime()
const nextMonth = new Date(2026, 2, 15, 12, 0, 0, 0).getTime()

try {
  compileSources()
  installElectronStub()
  const runtime = loadRuntime()
  const fixture = await createFixture(runtime, baseRoot)
  await seedImmutableAttemptChain(runtime, fixture)

  await check('cross-provider attempts retain one immutable Worker/Assignment/Run/WorkItem identity', () =>
    verifyAttemptIdentity(runtime, fixture))
  await check('monthly spend uses frozen settled Attempt costs and excludes the previous month', () =>
    verifyMonthlyBoundary(runtime, fixture))
  await check('Session and history deletion cannot reset the immutable Worker budget', () =>
    verifySessionDeletion(runtime, fixture))
  await check('Provider pricing changes cannot rewrite historical settled cost', () =>
    verifyPricingChangeIsolation(runtime, fixture))
  await check('unknown current-month Attempt outcome fails the budget closed', () =>
    verifyUnresolvedAttempt(runtime, fixture))
  await check('terminal current-month Attempt without immutable cost fails the budget closed', () =>
    verifyMissingCost(runtime, fixture))
  await check('ModelAttempt ledger tampering fails the budget closed', () =>
    verifyCorruptLedger(runtime, fixture))
  await check('unpriced prospective Provider request is denied before dispatch', () =>
    verifyUnpricedProspectiveAttempt(runtime, fixture))
  await check('fresh-process restart reads the same immutable monthly spend', () =>
    verifyFreshProcessRestart(runtime, fixture))

  process.stdout.write(`digital worker immutable usage e2e: PASS (${checks.length} checks)\n`)
} catch (error) {
  failure = serializeError(error)
  throw error
} finally {
  const report = {
    schemaVersion: 1,
    status: failure ? 'failed' : 'passed',
    runId: reportRunId,
    startedAt,
    finishedAt: new Date().toISOString(),
    gate: 'test:digital-worker-immutable-usage:required',
    checks,
    guarantees: [
      'immutable Worker and Assignment identity across provider/model successor Attempts',
      'canonical ModelAttempt accounting survives Session/history deletion and restart',
      'month boundary and settled cost attribution are deterministic',
      'unknown, unpriced, missing-cost, and corrupt ledgers fail closed'
    ],
    error: failure,
    environment: { platform: process.platform, arch: process.arch, node: process.version }
  }
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  rmSync(tempRoot, { recursive: true, force: true })
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/digital-worker/billable-action-policy.ts',
    'src/main/digital-worker/domain-store.ts',
    'src/main/digital-worker/usage-ledger.ts',
    'src/main/task/model-attempt-api.ts',
    'src/main/task/task-snapshot.ts',
    'src/main/task/workflow-ledger-api.ts',
    '--outDir', outDir,
    '--rootDir', 'src',
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installElectronStub() {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"commonjs"}\n', 'utf8')
  writeFileSync(path.join(electronDir, 'index.js'), [
    `const root = ${JSON.stringify(baseRoot)}`,
    "exports.app = { getPath: () => root, getVersion: () => '1.0.0', getName: () => 'CaoGen', isPackaged: false }",
    'exports.safeStorage = { isEncryptionAvailable: () => false }',
    'exports.BrowserWindow = class { static getAllWindows() { return [] } }',
    'exports.powerSaveBlocker = { start: () => 1, stop() {}, isStarted: () => false }'
  ].join('\n'), 'utf8')
}

function loadRuntime() {
  return {
    billable: requireCompiled('billable-action-policy.js'),
    usage: requireCompiled('usage-ledger.js'),
    worker: requireCompiled('domain-store.js'),
    attempts: requireCompiled('model-attempt-api.js'),
    snapshots: requireCompiled('task-snapshot.js'),
    workflow: requireCompiled('workflow-ledger-api.js')
  }
}

async function createFixture(runtime, root) {
  mkdirSync(root, { recursive: true })
  const store = new runtime.worker.DigitalWorkerStore(root)
  const role = await store.createRoleTemplate({
    id: 'role-immutable-usage',
    name: 'Immutable Usage Worker',
    purpose: 'Verify release-bound immutable accounting'
  })
  const proposed = await store.createDigitalWorker({
    id: 'worker-immutable-usage',
    projectId: 'project-immutable-usage',
    roleTemplateId: role.id,
    displayName: 'Immutable Usage Worker',
    budgetPolicy: { monthlyUsd: 5 },
    concurrencyLimit: 4
  })
  const worker = await store.activateDigitalWorker(proposed.id, {
    expectedRevision: proposed.revision,
    now: previousMonth - 10_000
  })
  const assignment = await store.createAssignment({
    id: 'assignment-immutable-usage',
    projectId: worker.projectId,
    workItemId: 'work-immutable-usage',
    assigneeKind: 'digital_worker',
    assigneeId: worker.id,
    assignedBy: 'immutable-usage-gate',
    assignedAt: previousMonth - 5_000
  })
  const binding = { kind: 'assigned', workerId: worker.id, assignmentId: assignment.id }
  const meta = sessionMeta(root, assignment, binding)
  const run = taskRun(meta, binding)
  await runtime.workflow.createWorkflowWorkItem({
    id: assignment.workItemId,
    projectId: assignment.projectId,
    title: 'Immutable usage WorkItem',
    type: 'testing',
    status: 'ready'
  }, root)
  await runtime.snapshots.saveTaskSnapshot(runtime.snapshots.buildTaskSnapshot({
    meta,
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run,
    now: previousMonth
  }), root)
  return { root, store, worker, assignment, binding, meta, run }
}

function sessionMeta(root, assignment, binding) {
  return {
    id: 'session-immutable-usage',
    title: 'Immutable usage fixture',
    cwd: root,
    projectId: assignment.projectId,
    workspaceId: assignment.projectId,
    workItemId: assignment.workItemId,
    childTaskId: assignment.workItemId,
    model: 'gpt-4o-mini',
    providerId: 'openai',
    engine: 'openai',
    permissionMode: 'default',
    status: 'idle',
    sdkSessionId: 'sdk-session-immutable-usage',
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt: previousMonth,
    digitalWorkerBinding: binding
  }
}

function taskRun(meta, binding) {
  return {
    schemaVersion: 1,
    id: 'run-immutable-usage',
    sessionId: meta.id,
    taskId: meta.childTaskId,
    status: 'executing',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: previousMonth,
    updatedAt: previousMonth,
    steps: [],
    toolExecutions: [],
    effects: [],
    digitalWorkerBinding: binding
  }
}

async function seedImmutableAttemptChain(runtime, fixture) {
  await terminalAttempt(runtime, fixture.root, {
    id: 'attempt-previous-month',
    requestId: 'request-previous-month',
    providerId: 'openai',
    model: 'gpt-4o-mini',
    protocol: 'openai.responses',
    startedAt: previousMonth,
    completedAt: previousMonth + 100,
    costUsd: 9,
    status: 'succeeded'
  })
  const source = await terminalAttempt(runtime, fixture.root, {
    id: 'attempt-current-openai',
    requestId: 'request-current-chain',
    providerId: 'openai',
    model: 'gpt-4o-mini',
    protocol: 'openai.responses',
    startedAt: currentMonth,
    completedAt: currentMonth + 100,
    costUsd: 2,
    status: 'failed'
  })
  await terminalAttempt(runtime, fixture.root, {
    id: 'attempt-current-anthropic',
    requestId: 'request-current-chain',
    providerId: 'anthropic',
    model: 'claude-fixture',
    protocol: 'anthropic.messages',
    failoverFromAttemptId: source.id,
    startedAt: currentMonth + 200,
    completedAt: currentMonth + 300,
    costUsd: 3,
    status: 'succeeded'
  })
}

async function terminalAttempt(runtime, root, input) {
  const attempt = await runtime.attempts.startPersistedModelAttempt({
    id: input.id,
    commandId: `${input.id}:start`,
    requestId: input.requestId,
    runId: 'run-immutable-usage',
    providerId: input.providerId,
    model: input.model,
    protocol: input.protocol,
    adapterVersion: 'immutable-usage-v1',
    contextDigest: `sha256:${'a'.repeat(64)}`,
    routeReason: 'Selected by the immutable usage acceptance fixture.',
    startedAt: input.startedAt,
    ...(input.failoverFromAttemptId ? { failoverFromAttemptId: input.failoverFromAttemptId } : {})
  }, root)
  return runtime.attempts.completePersistedModelAttempt(attempt.id, {
    commandId: `${input.id}:complete`,
    expectedRevision: attempt.revision,
    status: input.status,
    completedAt: input.completedAt,
    usage: { inputTokens: 100, outputTokens: 20 },
    ...(input.costUsd === undefined ? {} : { costUsd: input.costUsd }),
    ...(input.status === 'failed' ? { outcome: 'rate_limited', errorClass: 'provider_rate_limit' } : {})
  }, root)
}

async function verifyAttemptIdentity(runtime, fixture) {
  const selection = await runtime.attempts.queryPersistedModelAttempts({
    runId: fixture.run.id,
    requestId: 'request-current-chain'
  }, fixture.root)
  assert.equal(selection.attempts.length, 2)
  assert.deepEqual(selection.attempts.map((item) => item.providerId), ['openai', 'anthropic'])
  assert.deepEqual(selection.attempts.map((item) => item.model), ['gpt-4o-mini', 'claude-fixture'])
  assert.equal(selection.attempts[0].nextAttemptId, selection.attempts[1].id)
  for (const attempt of selection.attempts) {
    assert.equal(attempt.runId, fixture.run.id)
    assert.equal(attempt.projectId, fixture.worker.projectId)
    assert.equal(attempt.workItemId, fixture.assignment.workItemId)
  }
  const snapshots = await runtime.snapshots.listTaskSnapshots(fixture.root)
  assert.deepEqual(snapshots[0].run.digitalWorkerBinding, fixture.binding)
}

async function verifyMonthlyBoundary(runtime, fixture) {
  assert.equal(
    await runtime.usage.readDigitalWorkerMonthlySpend(fixture.root, fixture.worker.id, currentMonth),
    5
  )
  assert.equal(
    await runtime.usage.readDigitalWorkerMonthlySpend(fixture.root, fixture.worker.id, previousMonth),
    9
  )
  assert.equal(
    await runtime.usage.readDigitalWorkerMonthlySpend(fixture.root, fixture.worker.id, nextMonth),
    0
  )
}

async function verifySessionDeletion(runtime, fixture) {
  writeFileSync(path.join(fixture.root, 'sessions.json'), JSON.stringify({
    schemaVersion: 1,
    entries: [{ ...fixture.meta, id: 'deleted-history-session', status: 'closed', costUsd: 900 }]
  }), 'utf8')
  writeFileSync(path.join(fixture.root, 'active-sessions.json'), JSON.stringify({
    schemaVersion: 1,
    sessions: [{ ...fixture.meta, id: 'deleted-active-session', status: 'closed', costUsd: 800 }]
  }), 'utf8')
  const before = await billableDecision(runtime, fixture, currentMonth)
  assertDenied(before, 'budget_exhausted')
  unlinkSync(path.join(fixture.root, 'sessions.json'))
  unlinkSync(path.join(fixture.root, 'active-sessions.json'))
  const after = await billableDecision(runtime, fixture, currentMonth)
  assertDenied(after, 'budget_exhausted')
  assert.equal(before.workerId, after.workerId)
  assert.equal(before.assignmentId, after.assignmentId)
}

async function verifyPricingChangeIsolation(runtime, fixture) {
  const providerStore = path.join(fixture.root, 'providers.json')
  const document = (inputPerMillion) => ({
    schemaVersion: 1,
    format: 'caogen.provider-store.v1',
    entries: [{
      id: 'pricing-fixture',
      name: 'Pricing Fixture',
      baseUrl: 'https://example.invalid/v1',
      models: ['fixture-model'],
      authMode: 'none',
      engine: 'openai',
      advancedConfig: {
        schemaVersion: 1,
        modelProfiles: [{
          model: 'fixture-model',
          pricing: { currency: 'USD', inputPerMillion, outputPerMillion: inputPerMillion, source: 'user' }
        }]
      }
    }]
  })
  writeFileSync(providerStore, JSON.stringify(document(1)), 'utf8')
  const before = await runtime.usage.readDigitalWorkerMonthlySpend(fixture.root, fixture.worker.id, currentMonth)
  writeFileSync(providerStore, JSON.stringify(document(10_000)), 'utf8')
  const after = await runtime.usage.readDigitalWorkerMonthlySpend(fixture.root, fixture.worker.id, currentMonth)
  assert.equal(before, 5)
  assert.equal(after, before)
}

async function verifyUnresolvedAttempt(runtime, fixture) {
  const scenario = await createFixture(runtime, unresolvedRoot)
  await seedImmutableAttemptChain(runtime, scenario)
  await runtime.attempts.startPersistedModelAttempt({
    id: 'attempt-unresolved',
    commandId: 'attempt-unresolved:start',
    requestId: 'request-unresolved',
    runId: scenario.run.id,
    providerId: 'openai',
    model: 'gpt-4o-mini',
    protocol: 'openai.responses',
    adapterVersion: 'immutable-usage-v1',
    contextDigest: `sha256:${'b'.repeat(64)}`,
    routeReason: 'Unresolved acceptance fixture.',
    startedAt: currentMonth + 400
  }, unresolvedRoot)
  await expectUsageCode(runtime, unresolvedRoot, scenario.worker.id, 'budget_untrackable')
}

async function verifyMissingCost(runtime, fixture) {
  const scenario = await createFixture(runtime, missingCostRoot)
  await seedImmutableAttemptChain(runtime, scenario)
  await terminalAttempt(runtime, missingCostRoot, {
    id: 'attempt-missing-cost',
    requestId: 'request-missing-cost',
    providerId: 'openai',
    model: 'gpt-4o-mini',
    protocol: 'openai.responses',
    startedAt: currentMonth + 500,
    completedAt: currentMonth + 600,
    status: 'succeeded'
  })
  await expectUsageCode(runtime, missingCostRoot, scenario.worker.id, 'budget_untrackable')
}

async function verifyCorruptLedger(runtime, fixture) {
  const scenario = await createFixture(runtime, corruptRoot)
  await seedImmutableAttemptChain(runtime, scenario)
  await runtime.snapshots.mutateTaskSnapshotDatabase(corruptRoot, (db) => {
    db.run("UPDATE model_attempts SET cost_usd = 999 WHERE id = 'attempt-current-openai'")
  })
  await expectUsageCode(runtime, corruptRoot, scenario.worker.id, 'policy_store_unavailable')
}

async function verifyUnpricedProspectiveAttempt(runtime, fixture) {
  const decision = await runtime.billable.preflightDigitalWorkerBillableAction({
    rootDir: fixture.root,
    meta: fixture.meta,
    action: 'provider_send',
    runId: fixture.run.id,
    runStatus: fixture.run.status,
    runBinding: fixture.binding,
    now: currentMonth
  }, {
    providerId: 'anthropic-unpriced',
    model: 'unknown-unpriced-model',
    protocol: 'anthropic.messages'
  })
  assertDenied(decision, 'budget_untrackable')
}

async function verifyFreshProcessRestart(runtime, fixture) {
  const usageModule = findCompiled(outDir, 'usage-ledger.js')
  const script = [
    'const usage = require(process.env.CAOGEN_USAGE_MODULE)',
    'usage.readDigitalWorkerMonthlySpend(process.env.CAOGEN_USAGE_ROOT, process.env.CAOGEN_WORKER_ID, Number(process.env.CAOGEN_NOW)).then((value) => process.stdout.write(JSON.stringify(value))).catch((error) => { console.error(error); process.exitCode = 1 })'
  ].join(';')
  const output = execFileSync(process.execPath, ['-e', script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_PATH: [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
      CAOGEN_USAGE_MODULE: usageModule,
      CAOGEN_USAGE_ROOT: fixture.root,
      CAOGEN_WORKER_ID: fixture.worker.id,
      CAOGEN_NOW: String(currentMonth)
    },
    encoding: 'utf8'
  })
  assert.equal(JSON.parse(output), 5)
  assert.equal(await runtime.usage.readDigitalWorkerMonthlySpend(
    fixture.root, fixture.worker.id, currentMonth
  ), 5)
}

function billableDecision(runtime, fixture, now) {
  return runtime.billable.preflightDigitalWorkerBillableAction({
    rootDir: fixture.root,
    meta: fixture.meta,
    action: 'provider_send',
    runId: fixture.run.id,
    runStatus: fixture.run.status,
    runBinding: fixture.binding,
    now
  }, {
    providerId: 'openai',
    model: 'gpt-4o-mini',
    protocol: 'openai.responses'
  })
}

async function expectUsageCode(runtime, root, workerId, code) {
  await assert.rejects(
    runtime.usage.readDigitalWorkerMonthlySpend(root, workerId, currentMonth),
    (error) => error?.code === code
  )
}

function assertDenied(decision, code) {
  assert.equal(decision.allowed, false)
  assert.equal(decision.scoped, true)
  assert.equal(decision.code, code)
}

function requireCompiled(name) {
  return require(findCompiled(outDir, name))
}

function findCompiled(root, basename) {
  const entries = require('node:fs').readdirSync(root, { withFileTypes: true })
  for (const entry of entries) {
    const candidate = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const nested = findCompiledOrUndefined(candidate, basename)
      if (nested) return nested
    } else if (entry.name === basename) return candidate
  }
  throw new Error(`compiled module not found: ${basename}`)
}

function findCompiledOrUndefined(root, basename) {
  const entries = require('node:fs').readdirSync(root, { withFileTypes: true })
  for (const entry of entries) {
    const candidate = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const nested = findCompiledOrUndefined(candidate, basename)
      if (nested) return nested
    } else if (entry.name === basename) return candidate
  }
  return undefined
}

async function check(name, action) {
  const started = Date.now()
  await action()
  checks.push({ name, status: 'passed', durationMs: Date.now() - started })
}

function serializeError(error) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { message: String(error) }
}
