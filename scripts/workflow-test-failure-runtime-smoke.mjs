#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-test-failure-runtime-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
let clock = Date.now()

process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()
mkdirSync(userData, { recursive: true })

try {
  compileSources()
  installElectronStub()
  const producer = await loadCompiledAt('main/task/workflow-test-failure-runtime.js')
  const runBinding = await loadCompiledAt('main/task/workflow-run-canonical-binding.js')
  const ingress = await loadCompiledAt('main/task/workflow-acceptance-failure-ingress.js')
  const snapshotStore = await loadCompiledAt('main/task/task-snapshot.js')
  const workflowApi = await loadCompiledAt('main/task/workflow-ledger-api.js')
  const idempotency = await loadCompiledAt('main/task/tool-idempotency.js')
  const taskExecution = await loadCompiledAt('main/task/task-execution.js')
  const taskRun = await loadCompiledAt('main/task/task-run.js')
  const storeApi = await loadCompiledAt('main/project-workspace/store.js')
  const commandApi = await loadCompiledAt('main/project-workspace/command-service.js')

  const store = await storeApi.openProjectWorkspaceStore(userData)
  await store.createWorkspace({ id: 'project-a', name: 'Project A', kind: 'software' })
  await store.createWorkspace({ id: 'project-b', name: 'Project B', kind: 'software' })
  const commands = commandApi.createProjectWorkspaceCommandService(store, { rootDir: userData })
  await commands.reconcileShadowProjection()
  const goalA = await commands.createGoal({
    id: 'goal-a',
    projectId: 'project-a',
    title: 'Verify project A',
    objective: 'Turn trusted test failures into repair work'
  })
  const goalB = await commands.createGoal({
    id: 'goal-b',
    projectId: 'project-b',
    title: 'Verify project B',
    objective: 'Remain isolated from project A'
  })

  const harness = {
    commands,
    idempotency,
    producer,
    runBinding,
    snapshotStore,
    store,
    taskExecution,
    taskRun,
    workflowApi
  }
  verifySessionManagerFlushOrdering()

  for (const command of [
    'npm test',
    'CI=1 pnpm run test:unit -- --runInBand',
    'python -m pytest tests/unit',
    'go test ./...',
    'xcodebuild -scheme App test'
  ]) {
    assert.equal(producer.isExplicitTestCommand(command), true, `expected test command: ${command}`)
  }
  for (const command of [
    'npm run build',
    "echo 'npm test'",
    "sh -c 'npm test'",
    'cd packages/app && npx vitest run',
    'false && npm test',
    'git status',
    'npm test; false',
    'npm test && failing-poststep',
    'npm test | false'
  ]) {
    assert.equal(producer.isExplicitTestCommand(command), false, `expected non-test command: ${command}`)
  }

  const live = await createFixture(harness, goalA, {
    itemId: 'live-test-item',
    type: 'testing',
    command: 'npm run test:unit',
    output: 'FAIL src/unit.spec.ts\nexpected 1, received 2',
    exitCode: 1,
    eventId: 'native-test-event-live'
  })
  const livePlan = producer.planWorkflowTestFailureIngress(live.context)
  assert.equal(livePlan.disposition, 'ingest')
  assert.equal(livePlan.input.runId, live.context.run.id)
  assert.equal(livePlan.input.projectId, goalA.projectId)
  assert.equal(livePlan.input.goalId, goalA.id)
  assert.equal(livePlan.input.workItemId, live.item.id)
  assert.equal(livePlan.input.exitCode, 1)
  assert.equal(
    livePlan.input.contentDigest,
    createHash('sha256').update(live.context.event.content).digest('hex'),
    'producer must digest the exact emitted command output'
  )

  let barrierCount = 0
  const runtime = new producer.WorkflowTestFailureRuntime({
    context: (sessionId) => sessionId === live.context.meta.id
      ? {
          meta: live.context.meta,
          run: live.context.run,
          transcript: live.context.transcript
        }
      : undefined,
    captureEventBarrier: () => async () => {
      barrierCount += 1
      await snapshotStore.saveTaskSnapshot(live.snapshot, userData)
    },
    rootDir: userData
  })
  const first = await runtime.handleEvent(live.context.meta.id, live.context.event, live.context.identity)
  assert(first)
  assert.equal(first.ingress.replayed, false)
  assert.equal(first.ingress.acceptance.status, 'failed')
  assert.equal(first.ingress.evidence.runId, live.context.run.id)
  assert.equal(first.ingress.evidence.metadata.exitCode, 1)
  assert.equal(first.ingress.repair.disposition, 'created')
  assert.equal(barrierCount, 1, 'ingress must cross the TaskSnapshot/Run persistence barrier first')

  const evidenceBeforeReplay = await workflowApi.queryWorkflowEvidence({ workItemId: live.item.id }, userData)
  const replay = await runtime.handleEvent(live.context.meta.id, live.context.event, live.context.identity)
  assert(replay)
  assert.equal(replay.ingress.replayed, true)
  assert.equal(barrierCount, 2)
  assert.equal(
    (await workflowApi.queryWorkflowEvidence({ workItemId: live.item.id }, userData)).total,
    evidenceBeforeReplay.total,
    'event replay must not duplicate Evidence'
  )
  const ordered = await createFixture(harness, goalA, {
    itemId: 'ordered-test-item',
    type: 'testing',
    command: 'npm test',
    output: 'ordered failure A',
    exitCode: 1,
    eventId: 'native-test-event-ordered-a'
  })
  await verifyCapturedBarrierOrdering(harness, ordered, userData)
  await verifyQueueFailureLatch(harness, live, userData)

  const conflicting = withResult(live.context, harness, {
    output: 'FAIL changed output',
    eventId: live.context.identity.eventId
  })
  const conflictingRecovery = await producer.recoverWorkflowTestFailureIngresses([
    { ...live.snapshot, transcript: conflicting.transcript, run: conflicting.run }
  ], userData)
  assert.deepEqual(conflictingRecovery.existing, [], 'conflicting startup replay must not look existing')
  assert.deepEqual(conflictingRecovery.recovered, [])
  assert.deepEqual(conflictingRecovery.failures.map(({ sourceEventId }) => sourceEventId), [live.context.identity.eventId])
  const success = withResult(live.context, harness, {
    output: 'PASS',
    exitCode: 0,
    isError: false,
    eventId: 'native-test-event-success'
  })
  assert.deepEqual(
    producer.planWorkflowTestFailureIngress(success),
    { disposition: 'ignore', reason: 'successful_result' }
  )
  const missingExitCode = withResult(live.context, harness, {
    output: 'unstructured failure',
    exitCode: undefined,
    eventId: 'native-test-event-unstructured'
  })
  assert.deepEqual(
    producer.planWorkflowTestFailureIngress(missingExitCode),
    { disposition: 'malformed', reason: 'exit_code_missing' }
  )
  for (const commandTermination of ['timed_out', 'aborted', 'output_limit', 'spawn_error', 'not_started']) {
    const interrupted = withResult(live.context, harness, {
      commandTermination, eventId: `native-test-event-${commandTermination}`
    })
    assert.deepEqual(producer.planWorkflowTestFailureIngress(interrupted), {
      disposition: 'ignore', reason: 'command_not_exited'
    })
  }
  const ordinaryBash = withResult(live.context, harness, {
    command: 'git status',
    output: 'fatal: not a git repository',
    eventId: 'native-test-event-non-test'
  })
  assert.deepEqual(
    producer.planWorkflowTestFailureIngress(ordinaryBash),
    { disposition: 'ignore', reason: 'not_test_command' }
  )
  const postStepFailure = withResult(live.context, harness, {
    command: 'npm test; false',
    output: 'tests passed before a post-step failed',
    eventId: 'native-test-event-post-step'
  })
  assert.deepEqual(
    producer.planWorkflowTestFailureIngress(postStepFailure),
    { disposition: 'ignore', reason: 'not_test_command' }
  )
  const unowned = {
    ...withResult(live.context, harness, { eventId: 'native-test-event-unowned' }),
    meta: { ...live.context.meta, workspaceId: undefined, goalId: undefined, workItemId: undefined }
  }
  assert.deepEqual(
    producer.planWorkflowTestFailureIngress(unowned),
    { disposition: 'unowned', reason: 'workspace_or_work_item_missing' }
  )

  const wrongType = await createFixture(harness, goalA, {
    itemId: 'coding-item',
    type: 'coding',
    command: 'npm test',
    output: 'one test failed',
    exitCode: 2,
    eventId: 'native-test-event-wrong-type'
  })
  const wrongTypePlan = producer.planWorkflowTestFailureIngress(wrongType.context)
  assert.equal(wrongTypePlan.disposition, 'ingest')
  await expectCode(
    ingress.ingestWorkflowAcceptanceFailure(wrongTypePlan.input, userData),
    'WORKFLOW_FAILURE_WORK_ITEM_BOUNDARY'
  )
  await verifyNonRetryableIngressDoesNotLatch(
    producer,
    wrongType.context,
    'WORKFLOW_FAILURE_WORK_ITEM_BOUNDARY',
    userData
  )
  const wrongTypeRecovery = await producer.recoverWorkflowTestFailureIngresses([wrongType.snapshot], userData)
  assert.deepEqual(wrongTypeRecovery.rejected.map(({ code }) => code), ['WORKFLOW_FAILURE_WORK_ITEM_BOUNDARY'])
  assert.equal(wrongTypeRecovery.failures.length, 0)
  assert.equal((await workflowApi.queryWorkflowEvidence({ workItemId: wrongType.item.id }, userData)).total, 0)

  const noActiveAcceptance = withResult(live.context, harness, {
    eventId: 'native-test-event-no-active-acceptance'
  })
  await verifyNonRetryableIngressDoesNotLatch(
    producer,
    noActiveAcceptance,
    'WORKFLOW_FAILURE_TRANSITION_INVALID',
    userData
  )

  const foreign = await createFixture(harness, goalB, {
    itemId: 'foreign-test-item',
    type: 'testing',
    command: 'pytest',
    output: '1 failed',
    exitCode: 1,
    eventId: 'native-test-event-foreign-run'
  })
  const crossTarget = await createItem(commands, goalA, 'cross-target-item', 'testing')
  await createAcceptance(workflowApi, crossTarget, 'cross-target-acceptance')
  const crossProjectContext = {
    ...foreign.context,
    meta: {
      ...foreign.context.meta,
      projectId: goalA.projectId,
      workspaceId: goalA.projectId,
      goalId: goalA.id,
      workItemId: crossTarget.id
    }
  }
  const crossProjectPlan = producer.planWorkflowTestFailureIngress(crossProjectContext)
  assert.equal(crossProjectPlan.disposition, 'ingest')
  await expectCode(
    ingress.ingestWorkflowAcceptanceFailure(crossProjectPlan.input, userData),
    'WORKFLOW_FAILURE_RUN_BOUNDARY'
  )
  await verifyNonRetryableIngressDoesNotLatch(
    producer,
    crossProjectContext,
    'WORKFLOW_FAILURE_RUN_BOUNDARY',
    userData
  )
  assert.equal((await workflowApi.queryWorkflowEvidence({ workItemId: crossTarget.id }, userData)).total, 0)

  const staleRecovery = await createFixture(harness, goalA, {
    itemId: 'stale-recovery-test-item',
    type: 'testing',
    command: 'npm test',
    output: 'stale recovery failure',
    exitCode: 1,
    eventId: 'native-test-event-stale-recovery'
  })
  const staleAdvanced = await workflowApi.saveWorkflowAcceptance({
    ...staleRecovery.acceptance,
    status: 'verifying',
    revision: staleRecovery.acceptance.revision + 1,
    updatedAt: ++clock
  }, userData)
  const staleRecoveryResult = await producer.recoverWorkflowTestFailureIngresses(
    [staleRecovery.snapshot], userData
  )
  assert.deepEqual(
    staleRecoveryResult.rejected.map(({ code }) => code),
    ['WORKFLOW_FAILURE_TRANSITION_INVALID']
  )
  assert.equal((await workflowApi.queryWorkflowEvidence({ workItemId: staleRecovery.item.id }, userData)).total, 0)
  assert.equal(
    (await workflowApi.listWorkflowLedger({ acceptanceId: staleRecovery.acceptance.id }, userData))
      .acceptances.items[0].revision,
    staleAdvanced.revision,
    'a delayed first arrival from an older Run must not mutate a newer Acceptance revision'
  )

  const historical = await createFixture(harness, goalA, {
    itemId: 'historical-test-item',
    type: 'testing',
    command: 'npm test',
    output: 'historical test failure',
    exitCode: 1,
    eventId: 'native-test-event-historical'
  })
  const laterEventId = 'native-test-event-after-historical'
  const laterSeq = historical.context.identity.seq + 1
  const laterEventAt = ++clock
  const historicalSnapshot = {
    ...historical.snapshot,
    updatedAt: laterEventAt,
    eventCount: historical.snapshot.eventCount + 1,
    execution: {
      ...historical.snapshot.execution,
      lastSeq: laterSeq,
      cursor: { seq: laterSeq, eventId: laterEventId },
      lastEventId: laterEventId,
      lastEventKind: 'turn-result',
      lastEventAt: laterEventAt
    },
    run: {
      ...historical.snapshot.run,
      updatedAt: laterEventAt,
      lastAppliedEventId: laterEventId,
      lastAppliedEventSeq: laterSeq,
      lastEventKind: 'turn-result'
    },
    transcript: [
      ...historical.snapshot.transcript,
      {
        schemaVersion: 1,
        streamId: historical.context.identity.streamId,
        eventId: laterEventId,
        seq: laterSeq,
        occurredAt: laterEventAt,
        event: { kind: 'turn-result', subtype: 'success', isError: false, resultText: 'continued' }
      }
    ]
  }
  const historicalRecovery = await producer.recoverWorkflowTestFailureIngresses([historicalSnapshot], userData)
  assert.deepEqual(historicalRecovery.recovered, [], 'historical failures must not be recovered after a later event')
  assert.deepEqual(historicalRecovery.existing, [])
  assert.equal((await workflowApi.queryWorkflowEvidence({ workItemId: historical.item.id }, userData)).total, 0)
  const recovery = await createFixture(harness, goalA, {
    itemId: 'recovery-test-item',
    type: 'testing',
    command: 'node --test tests/recovery.test.js',
    output: 'not ok 1 - recovery',
    exitCode: 1,
    eventId: 'native-test-event-recovery'
  })
  assert.equal(
    recovery.snapshot.run.lastEventKind,
    'status',
    'real TaskRun reduction does not project tool-result into the Run status field'
  )
  for (const key of ['lastAppliedEventId', 'lastAppliedEventSeq']) {
    const missingBarrier = structuredClone(recovery.snapshot)
    delete missingBarrier.run[key]
    const blocked = await producer.recoverWorkflowTestFailureIngresses([missingBarrier], userData)
    assert.deepEqual([blocked.recovered, blocked.existing, blocked.rejected, blocked.failures], [[], [], [], []])
    assert.equal((await workflowApi.queryWorkflowEvidence({ workItemId: recovery.item.id }, userData)).total, 0)
  }
  const recovered = await producer.recoverWorkflowTestFailureIngresses([recovery.snapshot], userData)
  assert.deepEqual(recovered.recovered, [recovery.context.identity.eventId])
  assert.equal(recovered.failures.length, 0)
  const recoveredAcceptance = await workflowApi.listWorkflowLedger(
    { acceptanceId: recovery.acceptance.id },
    userData
  )
  assert.equal(recoveredAcceptance.acceptances.items[0].status, 'failed')
  const recoveredAgain = await producer.recoverWorkflowTestFailureIngresses([recovery.snapshot], userData)
  assert.deepEqual(recoveredAgain.existing, [recovery.context.identity.eventId])
  assert.equal(recoveredAgain.recovered.length, 0)
  assert.equal(
    (await workflowApi.queryWorkflowEvidence({ workItemId: recovery.item.id }, userData)).total,
    1,
    'startup recovery replay must remain idempotent'
  )
  console.log('workflow test failure runtime smoke: pass')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

async function verifyCapturedBarrierOrdering(harness, fixture, rootDir) {
  const second = withResult(fixture.context, harness, {
    output: 'ordered failure B',
    eventId: 'native-test-event-ordered-b'
  })
  let currentContext = fixture.context
  let captureCount = 0
  let releaseFirst
  const order = []
  const workItemsBefore = (await harness.store.listWorkItems(fixture.item.projectId)).length
  const runtime = new harness.producer.WorkflowTestFailureRuntime({
    context: (sessionId) => sessionId === currentContext.meta.id
      ? {
          meta: currentContext.meta,
          run: currentContext.run,
          transcript: currentContext.transcript
        }
      : undefined,
    captureEventBarrier: (_sessionId, identity) => {
      const capture = ++captureCount
      const eventId = identity.eventId
      order.push(`capture:${capture}:${eventId}`)
      return async () => {
        order.push(`persist:${capture}:start:${eventId}`)
        if (capture === 1) await new Promise((resolve) => { releaseFirst = resolve })
        order.push(`persist:${capture}:end:${eventId}`)
      }
    },
    rootDir
  })

  const first = runtime.handleEvent(fixture.context.meta.id, fixture.context.event, fixture.context.identity)
  currentContext = second
  const queued = runtime.handleEvent(second.meta.id, second.event, second.identity)
  const queuedOutcome = queued.then(
    (value) => ({ value }),
    (error) => ({ error })
  )
  assert.deepEqual(order, [
    `capture:1:${fixture.context.identity.eventId}`,
    `capture:2:${second.identity.eventId}`
  ], 'each barrier must capture synchronously before queued persistence starts')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(
    order,
    [
      `capture:1:${fixture.context.identity.eventId}`,
      `capture:2:${second.identity.eventId}`,
      `persist:1:start:${fixture.context.identity.eventId}`
    ],
    'the second barrier thunk must wait for the first ingress queue position'
  )
  releaseFirst()
  const firstResult = await first
  assert(firstResult)
  assert.equal(firstResult.ingress.replayed, false)
  const secondResult = await queuedOutcome
  assert.equal(secondResult.error?.code, 'WORKFLOW_FAILURE_TRANSITION_INVALID')
  await runtime.flush(fixture.context.meta.id)
  assert.deepEqual(order.slice(-3), [
    `persist:1:end:${fixture.context.identity.eventId}`,
    `persist:2:start:${second.identity.eventId}`,
    `persist:2:end:${second.identity.eventId}`
  ])
  assert.equal((await harness.workflowApi.queryWorkflowEvidence({ workItemId: fixture.item.id }, rootDir)).total, 1)
  assert.equal(
    (await harness.store.listWorkItems(fixture.item.projectId)).length,
    workItemsBefore + 1,
    'coalesced later failures must not create a second repair WorkItem'
  )
}

async function verifyQueueFailureLatch(harness, fixture, rootDir) {
  const producer = harness.producer
  const barrierError = new Error('synthetic persistence barrier failure')
  const second = withResult(fixture.context, harness, {
    output: 'blocked failure from a different source',
    eventId: 'native-test-event-blocked-by-latch'
  })
  const unhandled = []
  let rejectBarrier
  let rejectNext = true
  let currentContext = fixture.context
  const executedBarriers = []
  const onUnhandled = (error) => unhandled.push(error)
  const runtime = new producer.WorkflowTestFailureRuntime({
    context: (sessionId) => sessionId === currentContext.meta.id
      ? {
          meta: currentContext.meta,
          run: currentContext.run,
          transcript: currentContext.transcript
        }
      : undefined,
    captureEventBarrier: (_sessionId, identity) => async () => {
      executedBarriers.push(identity.eventId)
      if (identity.eventId !== fixture.context.identity.eventId || !rejectNext) return
      await new Promise((_, reject) => { rejectBarrier = reject })
    },
    rootDir
  })

  process.on('unhandledRejection', onUnhandled)
  try {
    const handled = runtime.handleEvent(
      fixture.context.meta.id,
      fixture.context.event,
      fixture.context.identity
    )
    currentContext = second
    const blocked = runtime.handleEvent(second.meta.id, second.event, second.identity)
    const blockedOutcome = blocked.then(
      (value) => ({ value }),
      (error) => ({ error })
    )
    const flushing = runtime.flush(fixture.context.meta.id)
    let flushSettled = false
    void flushing.then(
      () => { flushSettled = true },
      () => { flushSettled = true }
    )
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(flushSettled, false, 'flush must wait for queued ingress')
    assert.equal(typeof rejectBarrier, 'function')
    rejectBarrier(barrierError)
    await assert.rejects(handled, (error) => error === barrierError, 'handleEvent must retain the original rejection')
    const blockedResult = await blockedOutcome
    assert.equal(blockedResult.error?.name, 'WorkflowTestFailureQueueBlockedError')
    assert.equal(blockedResult.error?.cause, barrierError)
    assert.deepEqual(
      executedBarriers,
      [fixture.context.identity.eventId],
      'a different source must not execute its barrier while the crash candidate is latched'
    )
    await assert.rejects(flushing, (error) => error === barrierError, 'flush must retain settled ingress failures')
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(unhandled, [], 'queue bookkeeping must not create an unobserved rejected promise')
    await assert.rejects(
      runtime.flush(fixture.context.meta.id),
      (error) => error === barrierError,
      'flush must reject from the failure latch after the queue tail is deleted'
    )

    rejectNext = false
    currentContext = fixture.context
    const replay = await runtime.handleEvent(
      fixture.context.meta.id,
      fixture.context.event,
      fixture.context.identity
    )
    assert(replay)
    await runtime.flush(fixture.context.meta.id)
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
}

async function verifyNonRetryableIngressDoesNotLatch(producer, context, code, rootDir) {
  const runtime = new producer.WorkflowTestFailureRuntime({
    context: (sessionId) => sessionId === context.meta.id
      ? { meta: context.meta, run: context.run, transcript: context.transcript }
      : undefined,
    captureEventBarrier: () => async () => undefined,
    rootDir
  })
  await expectCode(runtime.handleEvent(context.meta.id, context.event, context.identity), code)
  await runtime.flush(context.meta.id)
}

async function createFixture(harness, goal, options) {
  const item = await createItem(harness.commands, goal, options.itemId, options.type)
  const acceptance = await createAcceptance(harness.workflowApi, item, `${options.itemId}-acceptance`)
  const sessionId = `${options.itemId}-session`
  const runId = `${options.itemId}-run`
  const context = buildContext(harness, {
    sessionId,
    runId,
    projectId: goal.projectId,
    goalId: goal.id,
    workItemId: item.id,
    command: options.command,
    output: options.output,
    exitCode: options.exitCode,
    commandTermination: options.commandTermination ?? 'exited',
    eventId: options.eventId
  })
  const snapshot = harness.snapshotStore.buildTaskSnapshot({
    meta: context.meta,
    transcript: context.transcript,
    lastSeq: context.identity.seq,
    lastEventId: context.identity.eventId,
    lastEventKind: 'tool-result',
    eventCount: context.transcript.length,
    reason: 'important-event',
    run: context.run,
    now: ++clock
  })
  const saved = await harness.snapshotStore.saveTaskSnapshot(snapshot, userData)
  const beforeBinding = await harness.workflowApi.listWorkflowLedger({ workItemId: item.id }, userData)
  const projectedRun = beforeBinding.runs.items.find((run) => run.id === saved.run.id)
  assert(projectedRun, 'Run must persist before canonical binding')
  assert.equal(projectedRun.acceptanceId, acceptance.id)
  assert.equal(projectedRun.acceptanceRevision, acceptance.revision)
  assert.equal(
    beforeBinding.workItems.items[0].runIds.includes(saved.run.id),
    false,
    'TaskRun projection must not mutate a canonical WorkItem behind its rich source'
  )
  const bound = await harness.runBinding.bindWorkflowRunToCanonicalWorkItem(saved.meta, saved.run, userData)
  assert.equal(bound.disposition, 'attached')
  const afterBinding = await harness.workflowApi.listWorkflowLedger({ workItemId: item.id }, userData)
  assert(afterBinding.workItems.items[0].runIds.includes(saved.run.id), 'canonical command must attach the Run')
  return {
    item,
    acceptance,
    snapshot: saved,
    context: { ...context, run: saved.run }
  }
}

function buildContext(harness, options) {
  const now = ++clock
  const requestEventId = `${options.eventId}:request`
  const toolUseId = `${options.eventId}:tool`
  const streamId = `stream:${options.sessionId}`
  const input = { command: options.command }
  const event = {
    kind: 'tool-result',
    toolUseId,
    content: options.output,
    isError: options.isError ?? options.exitCode !== 0,
    ...(options.commandTermination ? { commandTermination: options.commandTermination } : {}),
    ...(options.exitCode === undefined ? {} : { exitCode: options.exitCode })
  }
  const identity = {
    schemaVersion: 1,
    streamId,
    eventId: options.eventId,
    seq: 2,
    occurredAt: now,
    causationId: requestEventId
  }
  const transcript = [
    {
      schemaVersion: 1,
      streamId,
      eventId: requestEventId,
      seq: 1,
      occurredAt: now - 1,
      event: {
        kind: 'assistant-message',
        blocks: [{ type: 'tool_use', id: toolUseId, name: 'bash', input }]
      }
    },
    { ...identity, event }
  ]
  const meta = buildMeta(options.sessionId, options.projectId, {
    workspaceId: options.projectId,
    goalId: options.goalId,
    workItemId: options.workItemId,
    childTaskId: options.workItemId,
    childRole: 'testing'
  })
  let run = harness.taskRun.createTaskRun({
    id: options.runId,
    sessionId: options.sessionId,
    taskId: options.workItemId,
    now: now - 3
  })
  run = harness.taskRun.reduceTaskRunEvent(run, { kind: 'status', status: 'running' }, now - 2)
  run = applyTaskRunEvent(harness, run, transcript[0].event, transcript[0], now - 1)
  run = applyTaskRunEvent(harness, run, event, identity, now)
  return { meta, run, transcript, event, identity }
}

function applyTaskRunEvent(harness, run, event, identity, now) {
  const current = run
  let next = harness.taskExecution.reduceTaskExecutionEvent(run, event, userData, now, identity)
  next = harness.taskRun.reduceTaskRunEvent(next, event, now)
  return harness.taskRun.recordTaskRunEvent(next, identity, next === current)
}

function withResult(base, harness, overrides) {
  return buildContext(harness, {
    sessionId: base.meta.id,
    runId: base.run.id,
    projectId: base.meta.workspaceId,
    goalId: base.meta.goalId,
    workItemId: base.meta.workItemId,
    command: overrides.command ?? base.transcript[0].event.blocks[0].input.command,
    output: overrides.output ?? base.event.content,
    exitCode: Object.hasOwn(overrides, 'exitCode') ? overrides.exitCode : base.event.exitCode,
    commandTermination: overrides.commandTermination ?? base.event.commandTermination,
    isError: overrides.isError ?? base.event.isError,
    eventId: overrides.eventId
  })
}

async function createItem(commands, goal, id, type) {
  return commands.createWorkItem({
    id,
    projectId: goal.projectId,
    goalId: goal.id,
    type,
    title: id,
    status: 'verifying',
    acceptanceSpec: [{ id: `${id}-criterion`, criterion: 'targeted tests pass', required: true }]
  })
}

function createAcceptance(api, item, id) {
  return api.saveWorkflowAcceptance({
    id,
    projectId: item.projectId,
    goalId: item.goalId,
    workItemId: item.id,
    criteria: ['targeted tests pass']
  }, userData)
}

function buildMeta(id, projectId, extra = {}) {
  return {
    id,
    title: `Test ${id}`,
    cwd: userData,
    projectId,
    model: 'fixture-model',
    providerId: 'fixture-provider',
    permissionMode: 'default',
    status: 'running',
    sdkSessionId: `sdk-${id}`,
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt: ++clock,
    ...extra
  }
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code, `expected ${code}`)
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/task/workflow-test-failure-runtime.ts',
    'src/main/task/task-execution.ts',
    'src/main/task/task-run.ts',
    'src/main/task/workflow-run-canonical-binding.ts',
    'src/main/task/workflow-ledger-api.ts',
    'src/main/project-workspace/store.ts',
    'src/main/project-workspace/command-service.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function verifySessionManagerFlushOrdering() {
  const source = readFileSync(path.join(repoRoot, 'src/main/sessionManager.ts'), 'utf8')
  assertSourceOrder(
    source,
    'private async writeTaskSnapshot(',
    'private async persistBindAndDeleteActiveTaskSnapshot(',
    ['const persist = this.workflow.captureSnapshot(', 'await this.workflow.flush(sessionId)', 'await persist()']
  )
  assertSourceOrder(
    source,
    'private async persistBindAndDeleteActiveTaskSnapshot(',
    'private snapshotSubtasksFor(',
    ['await this.writeTaskSnapshot(', 'await deleteTaskSnapshot(']
  )
  assertSourceOrder(
    source,
    'private async closeAfterExecutorStops(',
    'updateWorktreeState(',
    ['await this.persistBindAndDeleteActiveTaskSnapshot(', 'this.sessions.delete(id)']
  )
  assertSourceOrder(
    source,
    'async deleteTaskSnapshot(id: string)',
    'async recoverTaskSnapshot(',
    ['if (this.sessions.has(id))', 'await this.workflow.flush(id)', 'this.workflow.assertRecoveryResolved(id)', 'return deleteTaskSnapshot(id)']
  )
  assertSourceOrder(
    source,
    'async recoverTaskSnapshot(id: string)',
    'private async activateRecoveredTaskSnapshot(',
    ['const stored = await getTaskSnapshot(id)', 'this.workflow.assertRecoveryResolved(stored.sessionId)', 'assertAgentRecoverySnapshot(stored)']
  )
  assertSourceOrder(
    source,
    'async init(): Promise<void>',
    'private async restoreDagRuntimesFromSnapshot(',
    ['const imported = await listTaskSnapshots()', 'await this.workflow.recover(imported)', 'await this.reconcileTaskSnapshots(imported, workflowRecoveryBlocks)']
  )
  assert(source.includes('this.workflow.recoveryBlocks()'), 'snapshot listing must retain startup workflow recovery blocks')
}

function assertSourceOrder(source, startMarker, endMarker, orderedMarkers) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert(start >= 0 && end > start, `missing source contract boundary: ${startMarker}`)
  const body = source.slice(start, end)
  let cursor = -1
  for (const marker of orderedMarkers) {
    const next = body.indexOf(marker, cursor + 1)
    assert(next > cursor, `source contract order missing: ${marker}`)
    cursor = next
  }
}

function installElectronStub() {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), [
    `export const app = { getPath: () => ${JSON.stringify(userData)} }`,
    'export const safeStorage = { isEncryptionAvailable: () => false }'
  ].join('\n') + '\n')
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

function loadCompiledAt(relativePath) {
  return import(pathToFileURL(path.join(outDir, relativePath)).href)
}
