const assert = require('node:assert/strict')
const fs = require('node:fs')
const support = require('./task-dag-finalization-crash-support.cjs')

const {
  compiled,
  delay,
  finalizationSnapshot,
  lineCount,
  onlyRecord,
  prepareScenario,
  runCrashWorker,
  runResumeWorker,
  sendAndExit,
  sessionMeta,
  terminalExecution,
  transcriptMessageCount,
  waitFor,
  waitForRecord
} = support

async function runSummaryAttemptBarrierCase() {
  const fixture = prepareScenario('summary-attempt-barrier')
  const boundary = await runCrashWorker('summary-attempt-barrier-crash', fixture, () => lineCount(fixture.summaryCounter) === 0)
  assert.equal(boundary.type, 'summary-attempt-persisted')
  assert.equal(boundary.phase, 'summary_pending')
  assert.equal(boundary.deliveryAttempts, 1)
  assert.equal(boundary.error, undefined)
  assert.equal(lineCount(fixture.summaryCounter), 0)
  const store = compiled('main/task/task-snapshot.js')
  const crashed = onlyRecord(await store.listTaskDagFinalizations(undefined, fixture.userData), 'summary attempt barrier')
  assert.equal(crashed.phase, 'summary_pending')
  assert.equal(crashed.summary.deliveryAttempts, 1)
  assert.equal(crashed.error, undefined)
  const resumed = await runResumeWorker('summary-attempt-barrier-resume', fixture)
  assert.equal(resumed.phase, 'completed')
  assert.equal(resumed.automaticPhase, 'summary_pending')
  assert.match(resumed.automaticError, /尚未产生可验证 transcript receipt/)
  assert.equal(resumed.automaticSummarySendCount, 0)
  assert.equal(resumed.summaryDeliveryAttempts, 2)
  assert.equal(resumed.summarySendCount, 1)
  assert.equal(resumed.summaryMessageCount, 1)
  assert.equal(resumed.summaryMessageId, boundary.messageId)
  assert.equal(resumed.staleRevisionRejected, true)
  console.log('[PASS] summary attempt barrier blocks automatic resend until current-revision authorization')
}

async function runEffectResolutionCases() {
  const cases = [
    ['forward', 'confirmed_applied'],
    ['forward', 'confirmed_not_applied'],
    ['reverse', 'confirmed_applied'],
    ['reverse', 'confirmed_not_applied']
  ]
  for (const [direction, resolution] of cases) {
    const mode = `effect-resolution-${direction}-${resolution}`
    const result = await runResumeWorker(mode, prepareScenario(mode))
    assert.equal(result.phase, 'completed')
    assert.equal(result.resolution, resolution)
    assert(result.completedRevision > result.waitingRevision)
    assert.equal(result.summarySendCount, 1)
    assert.equal(result.summaryMessageCount, 1)
    assert.equal(result.reconciliationRequired, undefined)
    assert.equal(result.entryError, undefined)
    const retry = resolution === 'confirmed_not_applied'
    if (direction === 'forward') {
      assert.equal(result.entryStatus, 'merged')
      assert.equal(result.patchMutationCount, retry ? 1 : 0)
      assert.equal(result.reverseMutationCount, 0)
    } else {
      assert.equal(result.entryStatus, 'rolled-back')
      assert.equal(result.patchMutationCount, 1)
      assert.equal(result.reverseMutationCount, retry ? 1 : 0)
    }
    assert.equal(result.effectCount, retry ? 2 : 1)
    assert.deepEqual(result.effectGenerations, retry ? [1, 2] : [1])
    if (retry) {
      assert.deepEqual(result.effectToolUseIds, [
        `operation:${result.operationId}:effect:0`,
        `operation:${result.operationId}:effect:1`
      ])
      assert.equal(result.finalEffectStatus, 'confirmed')
    }
  }
  console.log('[PASS] forward/reverse DAG operation Effect resolutions clear reconciliation and bound replay generations')
}

async function runLegacyReceiptMigrationCases() {
  const single = prepareScenario('legacy-summary-migration')
  const first = await runResumeWorker('legacy-migration', single)
  assert.deepEqual(
    {
      count: first.finalizerCount,
      phase: first.phase,
      revision: first.revision,
      messageId: first.summaryMessageId,
      attempts: first.deliveryAttempts,
      seq: first.deliveredEventSeq,
      sends: first.summarySendCount,
      cleanup: first.cleanupCount,
      snapshot: first.snapshotPhase
    },
    {
      count: 1,
      phase: 'completed',
      revision: 1,
      messageId: 'legacy-summary-message-1',
      attempts: 1,
      seq: 10,
      sends: 0,
      cleanup: 1,
      snapshot: 'completed'
    }
  )
  const repeated = await runResumeWorker('legacy-migration-repeat', single)
  assert.equal(repeated.finalizerCount, 1)
  assert.equal(repeated.revision, 1)
  assert.equal(repeated.summaryMessageId, first.summaryMessageId)
  assert.equal(repeated.summarySendCount, 0)
  assert.equal(repeated.cleanupCount, 0)

  const missing = await runResumeWorker('legacy-migration-missing-time', prepareScenario('legacy-summary-missing-time'))
  assert.equal(missing.finalizerCount, 1)
  assert.equal(missing.phase, 'prepared')
  assert.equal(missing.deliveryAttempts, 0)
  assert.equal(missing.summarySendCount, 0)
  assert.equal(missing.cleanupCount, 0)

  const ambiguous = await runResumeWorker('legacy-migration-ambiguous', prepareScenario('legacy-summary-ambiguous'))
  assert.equal(ambiguous.finalizerCount, 0)
  assert.equal(ambiguous.summarySendCount, 0)
  assert.equal(ambiguous.snapshotUnchanged, true)
  console.log('[PASS] legacy terminal summary migration is atomic, idempotent, and ambiguous matches fail closed')
}

async function runCorruptFinalizerMigrationCase() {
  const fixture = prepareScenario('corrupt-finalizer-migration')
  process.env.CAOGEN_DAG_FINALIZATION_USER_DATA = fixture.userData
  const store = compiled('main/task/task-snapshot.js')
  const finalization = compiled('main/agent/dag-finalization.js')
  const Coordinator = compiled('main/task/dag-finalization-coordinator.js').TaskDagFinalizationCoordinator
  const execution = terminalExecution('corrupt-finalizer-migration-execution', 'corrupt-migration-parent')
  const record = finalization.createTaskDagFinalizationRecord({ terminalExecution: execution, autoMergeOptions: { enabled: true }, now: 3200 })
  const snapshot = finalizationSnapshot({ snapshotStore: store, finalization, project: fixture.project, record })
  await store.saveTaskDagFinalizationBarrier(snapshot, record, { expectedRevision: 0, rootDir: fixture.userData })
  const dbPath = store.taskSnapshotsDbFile(fixture.userData)
  const beforeBytes = fs.readFileSync(dbPath)
  const beforeSnapshot = await store.getTaskSnapshot(record.parentSessionId, fixture.userData)
  const SQL = await require('sql.js')({ locateFile: (file) => file.endsWith('.wasm') ? require.resolve('sql.js/dist/sql-wasm.wasm') : file })
  const db = new SQL.Database(beforeBytes)
  try {
    db.run('UPDATE dag_finalizers SET payload = ? WHERE execution_id = ?', ['{corrupt', record.executionId])
    fs.writeFileSync(dbPath, db.export())
  } finally {
    db.close()
  }
  const coordinator = new Coordinator({
    sessions: new Map(), snapshotCursor: () => undefined, snapshotSubtasks: () => [],
    snapshotDagExecutions: () => [], snapshotDagRuntimes: () => [], send: () => true,
    emitParentEvent: () => {}, updateExecution: () => {}, releaseScheduler: () => {},
    cleanupExecution: () => {}, recoverParent: async () => {}
  })
  const isCorruption = (error) => error?.code === 'DAG_FINALIZATION_CORRUPTION'
  await assert.rejects(() => coordinator.load(), isCorruption)
  await assert.rejects(() => coordinator.migrateLegacyRecords(), isCorruption)
  assert.deepEqual(fs.readFileSync(dbPath), beforeBytes)
  assert.deepEqual(await store.getTaskSnapshot(record.parentSessionId, fixture.userData), beforeSnapshot)
  console.log('[PASS] corrupt finalizer migration rejects without rewriting row or parent snapshot')
}

async function runSummaryAttemptBarrierWorker({ fixture, manager, snapshotStore }) {
  await manager.init()
  let pending = await waitForRecord(snapshotStore, 'summary_pending', 10_000)
  await waitFor(async () => {
    pending = await snapshotStore.getTaskDagFinalization(pending.executionId)
    return pending?.error === '父汇总消息尚未产生可验证 transcript receipt，保持待投递状态。'
  }, 10_000, 'summary attempt barrier recovery block')
  const automatic = { phase: pending.phase, error: pending.error, sends: lineCount(fixture.summaryCounter) }
  await delay(100)
  assert.equal(lineCount(fixture.summaryCounter), 0)
  await assert.rejects(
    manager.resolveTaskDagFinalization(pending.executionId, pending.revision - 1, 'summary_not_delivered'),
    /stale_revision/
  )
  pending = await snapshotStore.getTaskDagFinalization(pending.executionId)
  await manager.resolveTaskDagFinalization(pending.executionId, pending.revision, 'summary_not_delivered')
  const completed = await waitForRecord(snapshotStore, 'completed', 20_000)
  const snapshot = await snapshotStore.getTaskSnapshot(completed.parentSessionId)
  const sdk = snapshot?.execution.sdkSessionId ?? snapshot?.meta.sdkSessionId
  sendAndExit({
    type: 'resume-result', mode: 'summary-attempt-barrier-resume', phase: completed.phase,
    automaticPhase: automatic.phase, automaticError: automatic.error, automaticSummarySendCount: automatic.sends,
    summaryDeliveryAttempts: completed.summary?.deliveryAttempts, summaryMessageId: completed.summary?.messageId,
    summaryMessageCount: sdk && completed.summary?.messageId ? transcriptMessageCount(fixture.userData, sdk, completed.summary.messageId) : 0,
    summarySendCount: lineCount(fixture.summaryCounter), staleRevisionRejected: true
  })
}

async function runEffectResolutionWorker({ mode, fixture, manager, snapshotStore, startScenario }) {
  await manager.init()
  await startScenario(mode, fixture, manager)
  const waiting = await waitForRecord(snapshotStore, 'waiting_reconciliation', 20_000)
  const operationId = mode.includes('-reverse-') ? waiting.rollbackOperationIds[0] : waiting.patchOperationIds[0]
  assert(operationId)
  const operationSnapshot = (await snapshotStore.listTaskSnapshots()).find(
    (snapshot) => snapshot.run?.operation?.operationId === operationId
  )
  const effect = operationSnapshot?.run?.effects?.at(-1)
  assert.equal(effect?.status, 'waiting_reconciliation')
  const resolution = mode.endsWith('confirmed_applied') ? 'confirmed_applied' : 'confirmed_not_applied'
  await manager.resolveTaskEffect(operationSnapshot.id, effect.id, effect.revision, resolution)
  const completed = await waitForRecord(snapshotStore, 'completed', 20_000)
  const effects = (await snapshotStore.listTaskRuns(`operation:${operationId}`)).flatMap((run) => run.effects ?? [])
  const entries = mode.includes('-reverse-') ? completed.autoMergeResult?.rollback?.entries : completed.autoMergeResult?.entries
  const entry = entries?.find((candidate) => candidate.operationId === operationId)
  const snapshot = await snapshotStore.getTaskSnapshot(completed.parentSessionId)
  const sdk = snapshot?.execution.sdkSessionId ?? snapshot?.meta.sdkSessionId
  sendAndExit({
    type: 'resume-result', mode, phase: completed.phase, resolution, waitingRevision: waiting.revision,
    completedRevision: completed.revision, operationId, effectCount: effects.length,
    effectGenerations: effects.map((item) => item.generation), effectToolUseIds: effects.map((item) => item.toolUseId),
    finalEffectStatus: effects.at(-1)?.status, entryStatus: entry?.status,
    reconciliationRequired: entry?.reconciliationRequired, entryError: entry?.error,
    patchMutationCount: lineCount(fixture.patchCounter), reverseMutationCount: lineCount(fixture.reverseCounter),
    summarySendCount: lineCount(fixture.summaryCounter),
    summaryMessageCount: sdk && completed.summary?.messageId ? transcriptMessageCount(fixture.userData, sdk, completed.summary.messageId) : 0
  })
}

async function executeLegacyMigrationWorker({ mode, fixture, snapshotStore }) {
  const finalization = compiled('main/agent/dag-finalization.js')
  const Coordinator = compiled('main/task/dag-finalization-coordinator.js').TaskDagFinalizationCoordinator
  const parentSessionId = `legacy-parent-${fixture.name}`
  const execution = terminalExecution(`legacy-execution-${fixture.name}`, parentSessionId)
  const summary = finalization.buildTaskDagFinalizationSummary(execution)
  const count = mode.includes('ambiguous') ? 2 : 1
  const transcript = Array.from({ length: count }, (_, index) => ({
    seq: 10 + index, eventId: `legacy-summary-event-${index}`, streamId: `legacy-summary-stream-${index}`,
    ...(mode.includes('missing-time') ? {} : { occurredAt: execution.completedAt + 10 + index }),
    event: { kind: 'user-message', messageId: `legacy-summary-message-${index + 1}`, text: summary.text }
  }))
  const snapshot = snapshotStore.buildTaskSnapshot({
    meta: sessionMeta(parentSessionId, fixture.project), transcript, lastSeq: 10 + count - 1,
    lastEventId: transcript.at(-1).eventId, lastEventKind: 'user-message', eventCount: 10 + count - 1,
    reason: 'shutdown', dagExecutions: [execution], dagRuntimes: [], now: execution.completedAt + 20
  })
  await snapshotStore.saveTaskSnapshot(snapshot, fixture.userData)
  const before = JSON.stringify(await snapshotStore.getTaskSnapshot(parentSessionId, fixture.userData))
  let sends = 0
  let cleanups = 0
  const coordinator = new Coordinator({
    sessions: new Map(), snapshotCursor: () => undefined, snapshotSubtasks: () => [],
    snapshotDagExecutions: () => [], snapshotDagRuntimes: () => [], send: () => { sends += 1; return true },
    emitParentEvent: () => {}, updateExecution: () => {}, releaseScheduler: () => {},
    cleanupExecution: () => { cleanups += 1 }, recoverParent: async () => {}
  })
  await coordinator.migrateLegacyRecords()
  const records = await snapshotStore.listTaskDagFinalizations(undefined, fixture.userData)
  const record = records[0]
  sendAndExit({
    type: 'resume-result', mode, finalizerCount: records.length, phase: record?.phase, revision: record?.revision,
    summaryMessageId: record?.summary?.messageId, deliveryAttempts: record?.summary?.deliveryAttempts,
    deliveredEventSeq: record?.summary?.deliveredEventSeq, summarySendCount: sends, cleanupCount: cleanups,
    snapshotPhase: (await snapshotStore.getTaskSnapshot(parentSessionId, fixture.userData))?.dagExecutions?.[0]?.finalization?.phase,
    snapshotUnchanged: JSON.stringify(await snapshotStore.getTaskSnapshot(parentSessionId, fixture.userData)) === before
  })
}

module.exports = {
  runSummaryAttemptBarrierCase,
  runEffectResolutionCases,
  runLegacyReceiptMigrationCases,
  runCorruptFinalizerMigrationCase,
  runSummaryAttemptBarrierWorker,
  runEffectResolutionWorker,
  executeLegacyMigrationWorker
}
