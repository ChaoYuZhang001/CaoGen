import assert from 'node:assert/strict'
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
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()

if (process.argv[2] === 'durable-start-worker') {
  await runDurableStartWorker()
} else {
  await runSuite()
}

async function runSuite() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-model-attempt-crash-'))
  const outDir = path.join(tempRoot, 'compiled')
  try {
    compileSources(outDir)
    installElectronStub(outDir)
    const modules = await loadModules(outDir)
    verifySessionManagerWiring()
    await verifyRetryRecovery(tempRoot, outDir, modules)
    await verifyCancelRecovery(tempRoot, outDir, modules)
    await verifyMissingSnapshotRecovery(tempRoot, outDir, modules)
    console.log(JSON.stringify({
      status: 'pass',
      checks: [
        'sigkill-after-durable-start', 'startup-three-way-waiting-projection',
        'active-started-hidden-orphan-shown', 'blocked-session-and-notification-count',
        'ordinary-send-recover-delete-blocked',
        'retry-authorization-does-not-call-provider', 'single-recovery-replay-allowance',
        'successor-second-crash-no-auto-replay', 'explicit-root-isolated-from-default',
        'successor-consumes-exact-predecessor-once', 'cancel-never-calls-provider',
        'multi-orphan-cancel-keeps-run-waiting', 'missing-snapshot-retry-fails-closed',
        'missing-snapshot-cancel-converges'
      ]
    }, null, 2))
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function verifyRetryRecovery(tempRoot, outDir, modules) {
  const root = path.join(tempRoot, 'retry-root')
  const decoyRoot = path.join(tempRoot, 'retry-decoy-root')
  const hits = path.join(tempRoot, 'retry-provider-hits.log')
  const fixture = await createFixture(modules.snapshotStore, root, {
    runId: 'run-retry-crash', sessionId: 'session-retry-crash', taskId: 'task-retry-crash',
    stepIds: ['step-retry-crash']
  })
  await crashAfterDurableStart(outDir, root, hits, attemptInput({
    id: 'attempt-retry-crash', runId: fixture.runId, requestId: 'request-retry-crash',
    stepId: fixture.stepIds[0]
  }))
  assert.equal(providerHits(hits), 0, 'crash before operation must not call Provider')

  await prepareInitialRetryReplay({ root, decoyRoot, hits, fixture, modules })

  await crashAfterDurableStart(outDir, root, hits, attemptInput({
    id: 'attempt-retry-successor',
    runId: fixture.runId,
    requestId: 'request-must-be-replaced',
    stepId: fixture.stepIds[0],
    context: { prompt: 'recovery replay' },
    routeReason: 'Authorized crash recovery replay.'
  }))
  assert.equal(providerHits(hits), 0, 'second crash before operation must not call Provider')
  const crashedChain = await modules.api.queryPersistedModelAttempts({
    runId: fixture.runId, requestId: 'request-retry-crash'
  }, root)
  assert.equal(crashedChain.attempts.length, 2)
  assert.equal(crashedChain.attempts[0].nextAttemptId, 'attempt-retry-successor')
  assert.equal(crashedChain.attempts[1].failoverFromAttemptId, 'attempt-retry-crash')
  assert.equal(crashedChain.attempts[1].status, 'started')
  assert.equal((await modules.api.listPersistedModelAttemptRetryAuthorizations({
    runId: fixture.runId
  }, root)).length, 0, 'durable successor start must consume predecessor authorization')

  const restartedGate = new modules.gateModule.ModelAttemptRecoveryGate()
  const restarted = await restartedGate.initialize(root)
  assert.deepEqual(restarted.reconciliations.map((view) => view.attempt.id), ['attempt-retry-successor'])
  assert.equal(restarted.retryAuthorizations.length, 0)
  const successorSnapshot = await requireSnapshot(modules.snapshotStore, root, fixture.sessionId)
  assert.equal(restartedGate.decideSend(fixture.sessionId, successorSnapshot.run, true).allowed, false)
  await assert.rejects(restartedGate.prepareRecovery(successorSnapshot, root), /Provider 结果未知|ModelAttempt/)
  assert.equal(providerHits(hits), 0, 'restart must not replay consumed authorization')
  await assertRootHasNoAttempts(modules.api, decoyRoot)

  await restartedGate.resolve('attempt-retry-successor', 1, 'retry_authorized', root, () => false)
  assert.equal(providerHits(hits), 0, 'second authorization must also remain side-effect free')
  const secondAuthorizedSnapshot = await requireSnapshot(modules.snapshotStore, root, fixture.sessionId)
  await restartedGate.prepareRecovery(secondAuthorizedSnapshot, root)
  const secondReplay = restartedGate.decideSend(fixture.sessionId, secondAuthorizedSnapshot.run, true)
  assert.equal(secondReplay.allowed, true)
  assert.equal(secondReplay.consumeReplay, true)
  restartedGate.acceptedSend(fixture.sessionId, secondReplay)

  let operationCalls = 0
  await modules.runtime.executePersistedModelAttempt({
    id: 'attempt-retry-final',
    runId: fixture.runId,
    requestId: 'request-final-replaced',
    stepId: fixture.stepIds[0],
    providerId: 'openai',
    model: 'gpt-crash-fixture',
    protocol: 'openai.responses',
    adapterVersion: 'adapter-v1',
    context: { prompt: 'second authorized recovery replay' },
    routeReason: 'Second explicit crash recovery authorization.',
    rootDir: root
  }, async () => {
    operationCalls += 1
    appendFileSync(hits, 'provider-hit\n')
    return { ok: true }
  })
  assert.equal(operationCalls, 1)
  assert.equal(providerHits(hits), 1)
  const chain = await modules.api.queryPersistedModelAttempts({
    runId: fixture.runId, requestId: 'request-retry-crash'
  }, root)
  assert.equal(chain.attempts.length, 3)
  assert.equal(chain.attempts[1].nextAttemptId, 'attempt-retry-final')
  assert.equal(chain.attempts[2].failoverFromAttemptId, 'attempt-retry-successor')
  assert.equal(chain.attempts[2].stepId, fixture.stepIds[0])

  await assert.rejects(
    modules.runtime.executePersistedModelAttempt({
      id: 'attempt-retry-duplicate',
      runId: fixture.runId,
      requestId: 'request-duplicate',
      stepId: fixture.stepIds[0],
      providerId: 'openai',
      model: 'gpt-crash-fixture',
      protocol: 'openai.responses',
      adapterVersion: 'adapter-v1',
      context: { prompt: 'must not replay twice' },
      routeReason: 'Duplicate recovery replay must fail closed.',
      rootDir: root
    }, async () => {
      appendFileSync(hits, 'unexpected-provider-hit\n')
      return { unexpected: true }
    }),
    (error) => error instanceof modules.runtime.ModelAttemptPersistenceError &&
      error.phase === 'start' && error.operationStarted === false
  )
  assert.equal(providerHits(hits), 1, 'consumed authorization must not call Provider twice')
  await assertRootHasNoAttempts(modules.api, decoyRoot)
}

async function prepareInitialRetryReplay({ root, decoyRoot, hits, fixture, modules }) {
  useDefaultRoot(decoyRoot)
  const gate = new modules.gateModule.ModelAttemptRecoveryGate()
  const startup = await gate.initialize(root)
  assert.equal(startup.reconciliations.length, 1)
  assert.equal(startup.retryAuthorizations.length, 0)
  assert.equal((await gate.list()).length, 1, 'Gate list must retain its explicit root')
  await assertRootHasNoAttempts(modules.api, decoyRoot)
  const activeSessions = new Set([fixture.sessionId])
  assert.equal(publicReconciliations(startup.reconciliations, activeSessions).length, 0)
  const blocked = new Set()
  gate.blockActiveSessions(blocked)
  assert.deepEqual([...blocked], [fixture.sessionId])
  for (const sessionId of blocked) activeSessions.delete(sessionId)
  assert.equal(publicReconciliations(startup.reconciliations, activeSessions).length, 1)
  assert.equal(gate.recoverableSessionCount([]), 1, 'notification count must include orphan session')
  await assertProjectionStatus(modules.snapshotStore, root, fixture, 'waiting_reconciliation', true)

  const waitingSnapshot = await requireSnapshot(modules.snapshotStore, root, fixture.sessionId)
  assert.equal(gate.decideSend(fixture.sessionId, waitingSnapshot.run, false).allowed, false)
  await assert.rejects(gate.prepareRecovery(waitingSnapshot, root), /Provider 结果未知|ModelAttempt/)
  await assert.rejects(gate.assertSnapshotDeletable(waitingSnapshot, root), /不能删除恢复入口/)
  assert.equal(providerHits(hits), 0)

  const resolved = await gate.resolve('attempt-retry-crash', 1, 'retry_authorized', root, () => false)
  assert.equal(resolved.view.attempt.status, 'failed')
  assert.equal(resolved.view.attempt.outcome, 'unknown')
  assert.equal(resolved.view.attempt.errorClass, 'runtime_result_unknown')
  assert.equal(resolved.run.status, 'waiting_reconciliation')
  assert.equal(providerHits(hits), 0, 'authorization must not call Provider')
  await assertProjectionStatus(modules.snapshotStore, root, fixture, 'waiting_reconciliation', true)
  const authorizedSnapshot = await requireSnapshot(modules.snapshotStore, root, fixture.sessionId)
  await assert.rejects(gate.assertSnapshotDeletable(authorizedSnapshot, root), /不能删除恢复入口/)

  await gate.prepareRecovery(authorizedSnapshot, root)
  const replay = gate.decideSend(fixture.sessionId, authorizedSnapshot.run, true)
  assert.equal(replay.allowed, true)
  assert.equal(replay.consumeReplay, true)
  gate.acceptedSend(fixture.sessionId, replay)
  assert.equal(
    gate.decideSend(fixture.sessionId, authorizedSnapshot.run, true).allowed,
    false,
    'one authorization must grant one recovery replay'
  )
}

async function verifyCancelRecovery(tempRoot, outDir, modules) {
  const root = path.join(tempRoot, 'cancel-root')
  const decoyRoot = path.join(tempRoot, 'cancel-decoy-root')
  const hits = path.join(tempRoot, 'cancel-provider-hits.log')
  const fixture = await createFixture(modules.snapshotStore, root, {
    runId: 'run-cancel-crash', sessionId: 'session-cancel-crash', taskId: 'task-cancel-crash',
    stepIds: ['step-cancel-one', 'step-cancel-two']
  })
  await crashAfterDurableStart(outDir, root, hits, attemptInput({
    id: 'attempt-cancel-one', runId: fixture.runId, requestId: 'request-cancel-one',
    stepId: fixture.stepIds[0]
  }))
  await crashAfterDurableStart(outDir, root, hits, attemptInput({
    id: 'attempt-cancel-two', runId: fixture.runId, requestId: 'request-cancel-two',
    stepId: fixture.stepIds[1]
  }))
  useDefaultRoot(decoyRoot)
  const gate = new modules.gateModule.ModelAttemptRecoveryGate()
  const startup = await gate.initialize(root)
  assert.equal(startup.reconciliations.length, 2)
  await assertProjectionStatus(modules.snapshotStore, root, fixture, 'waiting_reconciliation', true)

  const first = await gate.resolve('attempt-cancel-one', 1, 'cancelled_by_user', root, () => false)
  assert.equal(first.view.attempt.status, 'cancelled')
  assert.equal(first.reconciliations.length, 1)
  assert.equal(first.run.status, 'waiting_reconciliation')
  await assertProjectionStatus(modules.snapshotStore, root, fixture, 'waiting_reconciliation', true)
  const stillWaiting = await requireSnapshot(modules.snapshotStore, root, fixture.sessionId)
  await assert.rejects(gate.assertSnapshotDeletable(stillWaiting, root), /不能删除恢复入口/)

  const second = await gate.resolve('attempt-cancel-two', 1, 'cancelled_by_user', root, () => false)
  assert.equal(second.view.attempt.status, 'cancelled')
  assert.equal(second.reconciliations.length, 0)
  assert.equal(second.retryAuthorizations.length, 0)
  assert.equal(second.run.status, 'cancelled')
  await assertProjectionStatus(modules.snapshotStore, root, fixture, 'cancelled', true)
  const cancelledSnapshot = await requireSnapshot(modules.snapshotStore, root, fixture.sessionId)
  await gate.assertSnapshotDeletable(cancelledSnapshot, root)
  assert.equal(providerHits(hits), 0, 'cancellation must never call Provider')
  await assertRootHasNoAttempts(modules.api, decoyRoot)
}

async function verifyMissingSnapshotRecovery(tempRoot, outDir, modules) {
  const root = path.join(tempRoot, 'missing-snapshot-root')
  const decoyRoot = path.join(tempRoot, 'missing-snapshot-decoy-root')
  const hits = path.join(tempRoot, 'missing-snapshot-provider-hits.log')
  const fixture = await createFixture(modules.snapshotStore, root, {
    runId: 'run-missing-snapshot', sessionId: 'session-missing-snapshot', taskId: 'task-missing-snapshot',
    stepIds: ['step-missing-snapshot']
  })
  await crashAfterDurableStart(outDir, root, hits, attemptInput({
    id: 'attempt-missing-snapshot', runId: fixture.runId, requestId: 'request-missing-snapshot',
    stepId: fixture.stepIds[0]
  }))
  await removeRecoverySnapshot(modules.snapshotStore, root, fixture.sessionId)
  useDefaultRoot(decoyRoot)
  const gate = new modules.gateModule.ModelAttemptRecoveryGate()
  await gate.initialize(root)
  await assertProjectionStatus(modules.snapshotStore, root, fixture, 'waiting_reconciliation', false)

  await assert.rejects(
    gate.resolve('attempt-missing-snapshot', 1, 'retry_authorized', root, () => false),
    /缺少匹配的可恢复任务快照/
  )
  const unchanged = await modules.api.getPersistedModelAttempt('attempt-missing-snapshot', root)
  assert.equal(unchanged?.status, 'started', 'failed retry authorization must leave Attempt started')
  assert.equal(providerHits(hits), 0)

  const cancelled = await gate.resolve(
    'attempt-missing-snapshot', 1, 'cancelled_by_user', root, () => false
  )
  assert.equal(cancelled.view.attempt.status, 'cancelled')
  assert.equal(cancelled.run.status, 'cancelled')
  await assertProjectionStatus(modules.snapshotStore, root, fixture, 'cancelled', false)
  assert.equal(providerHits(hits), 0, 'missing-snapshot cancellation must never call Provider')
  await assertRootHasNoAttempts(modules.api, decoyRoot)
}

async function runDurableStartWorker() {
  const api = await import(process.env.CAOGEN_ATTEMPT_API_MODULE)
  const runtime = await import(process.env.CAOGEN_ATTEMPT_RUNTIME_MODULE)
  const input = JSON.parse(process.env.CAOGEN_ATTEMPT_INPUT)
  await runtime.executePersistedModelAttempt(input, async () => {
    appendFileSync(process.env.CAOGEN_PROVIDER_HITS, 'unexpected-provider-hit\n')
    return { unexpected: true }
  }, {
    dependencies: {
      start: async (startInput, rootDir) => {
        const attempt = await api.startPersistedModelAttempt(startInput, rootDir)
        process.send?.({ kind: 'durable-start', attemptId: attempt.id })
        await new Promise(() => {})
        return attempt
      }
    }
  })
}

function crashAfterDurableStart(outDir, root, hits, input) {
  return new Promise((resolve, reject) => {
    const child = fork(process.argv[1], ['durable-start-worker'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CAOGEN_TEST_USER_DATA: root,
        CAOGEN_PROVIDER_HITS: hits,
        CAOGEN_ATTEMPT_INPUT: JSON.stringify({ ...input, rootDir: root }),
        CAOGEN_ATTEMPT_API_MODULE: pathToFileURL(findCompiledModule(outDir, 'model-attempt-api.js')).href,
        CAOGEN_ATTEMPT_RUNTIME_MODULE: pathToFileURL(findCompiledModule(outDir, 'model-attempt-runtime.js')).href
      },
      execArgv: [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
    let stdout = ''
    let stderr = ''
    let killRequested = false
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`durable-start worker timed out\n${stdout}\n${stderr}`))
    }, 20_000)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('message', (message) => {
      if (message?.kind !== 'durable-start' || killRequested) return
      killRequested = true
      child.kill('SIGKILL')
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timeout)
      if (!killRequested) return reject(new Error(`worker exited before durable start: ${code}/${signal}\n${stdout}\n${stderr}`))
      if (process.platform !== 'win32' && signal !== 'SIGKILL') {
        return reject(new Error(`worker was not SIGKILLed: ${code}/${signal}\n${stdout}\n${stderr}`))
      }
      resolve()
    })
  })
}

async function createFixture(snapshotStore, root, input) {
  mkdirSync(root, { recursive: true })
  const now = Date.now()
  const run = {
    schemaVersion: 1,
    id: input.runId,
    sessionId: input.sessionId,
    taskId: input.taskId,
    status: 'executing',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    steps: input.stepIds.map((stepId, index) => ({
      id: stepId,
      runId: input.runId,
      sessionId: input.sessionId,
      sequence: index + 1,
      status: 'executing',
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      requestText: `fixture step ${index + 1}`
    })),
    toolExecutions: [],
    effects: []
  }
  const snapshot = snapshotStore.buildTaskSnapshot({
    meta: {
      id: input.sessionId,
      title: input.sessionId,
      cwd: root,
      projectId: `project-${input.sessionId}`,
      childTaskId: input.taskId,
      model: 'gpt-crash-fixture',
      providerId: 'openai',
      permissionMode: 'default',
      status: 'running',
      sdkSessionId: `sdk-${input.sessionId}`,
      costUsd: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      contextTokens: 0,
      createdAt: now
    },
    transcript: [{ seq: 1, event: { kind: 'user-message', messageId: `message-${input.sessionId}`, text: 'resume fixture' } }],
    lastSeq: 1,
    eventCount: 1,
    reason: 'shutdown',
    run,
    now
  })
  await snapshotStore.saveTaskSnapshot(snapshot, root)
  return { ...input, snapshotId: snapshot.id }
}

function attemptInput(overrides) {
  return {
    id: 'attempt-crash-fixture',
    runId: 'run-crash-fixture',
    requestId: 'request-crash-fixture',
    stepId: 'step-crash-fixture',
    providerId: 'openai',
    model: 'gpt-crash-fixture',
    protocol: 'openai.responses',
    adapterVersion: 'adapter-v1',
    context: { prompt: 'must remain durable before Provider call' },
    routeReason: 'Crash recovery fixture.',
    ...overrides
  }
}

async function assertProjectionStatus(snapshotStore, root, fixture, status, expectSnapshot) {
  const projection = await snapshotStore.readTaskSnapshotDatabase(root, (db) => {
    const taskRun = selectOne(db, 'SELECT payload FROM task_runs WHERE id = ?', [fixture.runId])
    const workflowRun = selectOne(db, 'SELECT status, payload FROM workflow_runs WHERE id = ?', [fixture.runId])
    const snapshot = selectOne(db, 'SELECT payload FROM task_snapshots WHERE session_id = ?', [fixture.sessionId])
    return {
      taskRun: taskRun ? JSON.parse(taskRun.payload) : null,
      workflowColumnStatus: workflowRun?.status ?? null,
      workflowRun: workflowRun ? JSON.parse(workflowRun.payload) : null,
      snapshot: snapshot ? JSON.parse(snapshot.payload) : null
    }
  })
  assert.equal(projection.taskRun?.status, status, 'task_runs projection status')
  assert.equal(projection.workflowColumnStatus, status, 'workflow_runs status column')
  assert.equal(projection.workflowRun?.status, status, 'workflow_runs payload status')
  assert.equal(Boolean(projection.snapshot), expectSnapshot)
  if (expectSnapshot) assert.equal(projection.snapshot.run?.status, status, 'task_snapshots payload status')
}

function selectOne(db, sql, values) {
  const stmt = db.prepare(sql)
  try {
    stmt.bind(values)
    return stmt.step() ? stmt.getAsObject() : null
  } finally {
    stmt.free()
  }
}

async function requireSnapshot(snapshotStore, root, sessionId) {
  const snapshots = await snapshotStore.listTaskSnapshots(root)
  const snapshot = snapshots.find((candidate) => candidate.sessionId === sessionId)
  assert(snapshot, `snapshot ${sessionId} must exist`)
  return snapshot
}

async function removeRecoverySnapshot(snapshotStore, root, sessionId) {
  await snapshotStore.mutateTaskSnapshotDatabase(root, (db) => {
    db.run('DELETE FROM workflow_recovery_sessions WHERE session_id = ?', [sessionId])
    db.run('DELETE FROM task_snapshots WHERE session_id = ?', [sessionId])
  })
}

function providerHits(file) {
  if (!existsSync(file)) return 0
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).length
}

function useDefaultRoot(root) {
  process.env.CAOGEN_TEST_USER_DATA = root
}

async function assertRootHasNoAttempts(api, root) {
  const selection = await api.queryPersistedModelAttempts({}, root)
  assert.equal(selection.attempts.length, 0, `default root ${root} must remain isolated`)
}

function publicReconciliations(reconciliations, activeSessions) {
  return reconciliations.filter((view) => !activeSessions.has(view.sessionId))
}

function verifySessionManagerWiring() {
  const source = readFileSync(path.join(repoRoot, 'src/main/sessionManager.ts'), 'utf8')
  assertOrdered(source, '  send(\n    id: string,', 'async interrupt(', ['decideSend(', 'session.send(input)'])
  assertOrdered(source, 'async deleteTaskSnapshot(', 'async recoverTaskSnapshot(', [
    'assertSnapshotDeletable(', 'return deleteTaskSnapshot('
  ])
  assertOrdered(source, 'async recoverTaskSnapshot(', 'private async activateRecoveredTaskSnapshot(', [
    'prepareRecovery(', 'prepareTaskSnapshotRecovery(', 'activateRecoveredTaskSnapshot('
  ])
  assert.match(
    source,
    /listModelAttemptReconciliations\(\)[\s\S]{0,180}\.filter\(\(view\) => !this\.sessions\.has\(view\.sessionId\)\)/,
    'public reconciliation list must hide active in-flight Attempts'
  )
}

function assertOrdered(source, startMarker, endMarker, markers) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert(start >= 0 && end > start, `missing source scope ${startMarker}`)
  const scope = source.slice(start, end)
  let cursor = -1
  for (const marker of markers) {
    const index = scope.indexOf(marker, cursor + 1)
    assert(index > cursor, `${marker} must be ordered in ${startMarker}`)
    cursor = index
  }
}

function compileSources(outDir) {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/task/model-attempt-recovery-gate.ts',
    'src/main/task/model-attempt-runtime.ts',
    'src/main/task/task-snapshot-recovery-lifecycle.ts',
    'src/main/task/task-snapshot.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installElectronStub(outDir) {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), [
    'export const app = { getPath: () => process.env.CAOGEN_TEST_USER_DATA }',
    'export const shell = { openPath: async () => "", openExternal: async () => {} }',
    'export const dialog = { showMessageBox: async () => ({ response: 0 }) }',
    ''
  ].join('\n'))
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

async function loadModules(outDir) {
  const load = (name) => import(pathToFileURL(findCompiledModule(outDir, name)).href)
  return {
    api: await load('model-attempt-api.js'),
    gateModule: await load('model-attempt-recovery-gate.js'),
    runtime: await load('model-attempt-runtime.js'),
    snapshotStore: await load('task-snapshot.js')
  }
}

function findCompiledModule(root, name) {
  const found = findCompiledModuleOrNull(root, name)
  if (found) return found
  throw new Error(`compiled ${name} not found under ${root}`)
}

function findCompiledModuleOrNull(root, name) {
  for (const entry of require('node:fs').readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledModuleOrNull(fullPath, name)
      if (found) return found
    } else if (entry.isFile() && entry.name === name) return fullPath
  }
  return null
}
