#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const repoRoot = path.resolve(__dirname, '..')
const workerMode = process.argv[2]
const tempRoot = process.env.CAOGEN_DAG_FINALIZATION_ROOT
  ?? fs.mkdtempSync(path.join(os.tmpdir(), 'caogen-dag-finalization-crash-'))
const buildDir = process.env.CAOGEN_DAG_FINALIZATION_BUILD ?? path.join(tempRoot, 'build')
process.env.CAOGEN_DAG_FINALIZATION_ROOT = tempRoot
process.env.CAOGEN_DAG_FINALIZATION_BUILD = buildDir
const {
  assertOperationEffect,
  assertTerminalFinalizationSnapshot,
  childTaskFile,
  compileSources,
  compiled,
  delay,
  finalizationSnapshot,
  fixtureFromEnvironment,
  git,
  installModuleStubs,
  lineCount,
  mutationFileCount,
  oneTaskDag,
  onlyRecord,
  operationDirectionCount,
  operationEffectEvidence,
  operationTaskCount,
  patchMutationFile,
  prepareScenario,
  readLines,
  runCrashWorker,
  runResumeWorker,
  sendAndExit,
  sessionMeta,
  signalBoundary,
  terminalExecution,
  transcriptMessageCount,
  twoTaskRollbackDag,
  verificationCommand,
  verificationFailureCommand,
  waitFor,
  waitForRecord,
  workerFailure
} = require('./lib/task-dag-finalization-crash-support.cjs')
const p1Cases = require('./lib/task-dag-finalization-p1-cases.cjs')

const FORWARD_PATCH_MUTATION_MODES = new Set([
  'patch-crash',
  'patch-resume',
  'rollback-crash',
  'rollback-resume',
  'partial-rollback-crash',
  'partial-rollback-resume',
  'verify-crash',
  'verify-before-command-crash',
  'manual-verification-passed',
  'manual-verification-failed',
  'manual-verification-not-started',
  'manual-finalization-abandoned',
  'effect-resolution-forward-confirmed_applied',
  'effect-resolution-forward-confirmed_not_applied',
  'effect-resolution-reverse-confirmed_applied',
  'effect-resolution-reverse-confirmed_not_applied'
])
const REVERSE_PATCH_MUTATION_MODES = new Set([
  'rollback-crash',
  'rollback-resume',
  'partial-rollback-crash',
  'partial-rollback-resume',
  'manual-verification-failed',
  'effect-resolution-reverse-confirmed_applied',
  'effect-resolution-reverse-confirmed_not_applied'
])
process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter)
Module._initPaths()

if (workerMode) {
  runWorker(workerMode).catch((error) => workerFailure(error))
} else {
  runParent().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

async function runParent() {
  const restoreModuleLoad = installModuleStubs()
  try {
    compileSources()
    await runBarrierCasCase()
    await runPatchReplayCase()
    await runUndefinedVerificationCase()
    await runRollbackReplayCase()
    await runPartialRollbackReplayCase()
    await runSummaryReceiptCase()
    await runVerificationCrashCase()
    await runWaitingReplayBlockedCase()
    await runManualResolutionCases()
    await runSummaryNotDeliveredResolutionCase()
    await p1Cases.runSummaryAttemptBarrierCase()
    await p1Cases.runEffectResolutionCases()
    await p1Cases.runLegacyReceiptMigrationCases()
    await p1Cases.runCorruptFinalizerMigrationCase()
    console.log('task-dag durable finalization crash e2e: PASS')
  } finally {
    restoreModuleLoad()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function runBarrierCasCase() {
  const root = path.join(tempRoot, 'barrier-cas')
  const userData = path.join(root, 'user-data')
  const project = path.join(root, 'repo')
  fs.mkdirSync(userData, { recursive: true })
  fs.mkdirSync(project, { recursive: true })
  process.env.CAOGEN_DAG_FINALIZATION_USER_DATA = userData

  const snapshotStore = compiled('main/task/task-snapshot.js')
  const finalization = compiled('main/agent/dag-finalization.js')
  const execution = terminalExecution('dag-barrier-cas', 'parent-barrier')
  const prepared = finalization.createTaskDagFinalizationRecord({
    terminalExecution: execution,
    autoMergeOptions: { enabled: true }
  })
  const preparedSnapshot = finalizationSnapshot({
    snapshotStore,
    finalization,
    project,
    record: prepared
  })

  const persistedPrepared = await snapshotStore.saveTaskDagFinalizationBarrier(
    preparedSnapshot,
    prepared,
    { expectedRevision: 0, rootDir: userData }
  )
  assert.equal(persistedPrepared.finalization.phase, 'prepared')
  assert.equal(persistedPrepared.finalization.revision, 1)
  assertTerminalFinalizationSnapshot(persistedPrepared.snapshot, 'prepared', 1)

  const merging = finalization.transitionTaskDagFinalization(prepared, 'merging')
  const mergingSnapshot = finalizationSnapshot({
    snapshotStore,
    finalization,
    project,
    record: merging
  })
  await assert.rejects(
    snapshotStore.saveTaskDagFinalizationBarrier(
      mergingSnapshot,
      merging,
      { expectedRevision: 0, rootDir: userData }
    ),
    /stale_revision/
  )
  const afterRejectedCas = await snapshotStore.getTaskDagFinalization(prepared.executionId, userData)
  const rejectedSnapshot = await snapshotStore.getTaskSnapshot(prepared.parentSessionId, userData)
  assert.equal(afterRejectedCas.phase, 'prepared', 'failed CAS must preserve the previous finalizer revision')
  assertTerminalFinalizationSnapshot(rejectedSnapshot, 'prepared', 1)

  const persistedMerging = await snapshotStore.saveTaskDagFinalizationBarrier(
    mergingSnapshot,
    merging,
    { expectedRevision: 1, rootDir: userData }
  )
  assert.equal(persistedMerging.finalization.phase, 'merging')
  assert.equal(persistedMerging.finalization.revision, 2)
  assertTerminalFinalizationSnapshot(persistedMerging.snapshot, 'merging', 2)
  console.log('[PASS] prepared/store CAS and terminal snapshot barrier')
}

async function runPatchReplayCase() {
  const fixture = prepareScenario('patch-replay')
  const boundary = await runCrashWorker('patch-crash', fixture, () => lineCount(fixture.patchCounter) === 1)
  assert.equal(boundary.type, 'patch-confirmed')
  assert.equal(boundary.phase, 'merging')
  assert.equal(boundary.effectStatus, 'confirmed')
  assert.equal(lineCount(fixture.patchCounter), 1, 'the patch mutation must execute once before the crash')

  const snapshotStore = compiled('main/task/task-snapshot.js')
  const recordsAfterCrash = await snapshotStore.listTaskDagFinalizations(undefined, fixture.userData)
  const crashedRecord = onlyRecord(recordsAfterCrash, 'patch crash finalizer')
  assert.equal(crashedRecord.phase, 'merging')
  const operationRuns = await snapshotStore.listTaskRuns(
    `operation:${boundary.operationId}`,
    fixture.userData
  )
  const effects = operationRuns.flatMap((run) => run.effects ?? [])
  assert.equal(effects.length, 1, 'the deterministic operation must own one Effect')
  assert.equal(effects[0].status, 'confirmed')

  const resumed = await runResumeWorker('patch-resume', fixture)
  assert.equal(resumed.phase, 'completed')
  assert.equal(resumed.patchOperationId, boundary.operationId)
  assert.equal(resumed.effectCount, 1)
  assert.equal(resumed.effectStatus, 'confirmed')
  assert.equal(resumed.summaryMessageCount, 1)
  assert.equal(resumed.summarySendCount, 1)
  assert.equal(lineCount(fixture.patchCounter), 1, 'recovery must replay the receipt, not reapply the patch')
  assert.equal(fs.readFileSync(path.join(fixture.project, 'finalization.txt'), 'utf8'), 'applied-once\n')
  console.log('[PASS] confirmed patch crash resumes through deterministic operation replay without reapply')
}

async function runRollbackReplayCase() {
  const fixture = prepareScenario('rollback-replay')
  const boundary = await runCrashWorker(
    'rollback-crash',
    fixture,
    () => lineCount(fixture.patchCounter) === 1 && lineCount(fixture.reverseCounter) === 0
  )
  assert.equal(boundary.type, 'rollback-persisted')
  assert.equal(boundary.phase, 'rollback_pending')
  assert.equal(boundary.rollbackPlanCount, 1)
  assert.equal(lineCount(fixture.patchCounter), 1, 'forward patch must apply once before rollback persistence')
  assert.equal(lineCount(fixture.reverseCounter), 0, 'crash boundary must precede the first reverse mutation')
  assert.equal(operationDirectionCount(fixture.operationCounter, 'apply'), 1)
  assert.equal(operationDirectionCount(fixture.operationCounter, 'reverse'), 0)

  const snapshotStore = compiled('main/task/task-snapshot.js')
  const crashedRecord = onlyRecord(
    await snapshotStore.listTaskDagFinalizations(undefined, fixture.userData),
    'rollback crash finalizer'
  )
  assert.equal(crashedRecord.phase, 'rollback_pending')
  assert.equal(crashedRecord.verification.status, 'settled')
  assert.equal(crashedRecord.verification.result?.status, 'failed')
  assert.equal(crashedRecord.rollbackPatches.length, 1)
  assert.deepEqual(crashedRecord.patchOperationIds, [boundary.forwardOperationId])
  assert.deepEqual(crashedRecord.rollbackOperationIds, [boundary.reverseOperationId])
  await assertOperationEffect(snapshotStore, boundary.forwardOperationId, fixture.userData, 'confirmed')
  assert.equal(
    (await snapshotStore.listTaskRuns(`operation:${boundary.reverseOperationId}`, fixture.userData)).length,
    0,
    'reverse operation must not exist before the crash boundary'
  )

  const resumed = await runResumeWorker('rollback-resume', fixture)
  assert.equal(resumed.phase, 'completed')
  assert.equal(resumed.patchOperationId, boundary.forwardOperationId)
  assert.equal(resumed.patchEffectCount, 1)
  assert.equal(resumed.patchEffectStatus, 'confirmed')
  assert.equal(resumed.rollbackOperationId, boundary.reverseOperationId)
  assert.equal(resumed.rollbackEffectCount, 1)
  assert.equal(resumed.rollbackEffectStatus, 'confirmed')
  assert.equal(resumed.autoMergeStatus, 'rolled-back')
  assert.equal(resumed.rollbackOk, true)
  assert.equal(resumed.verificationResultStatus, 'failed')
  assert.equal(resumed.summaryMessageCount, 1)
  assert.equal(resumed.summarySendCount, 1)
  assert.equal(lineCount(fixture.patchCounter), 1, 'recovery must not reapply the forward patch')
  assert.equal(lineCount(fixture.reverseCounter), 1, 'recovery must apply the frozen reverse plan once')
  assert.equal(operationDirectionCount(fixture.operationCounter, 'apply'), 1)
  assert.equal(operationDirectionCount(fixture.operationCounter, 'reverse'), 1)
  assert.equal(fs.existsSync(path.join(fixture.project, 'finalization.txt')), false)
  console.log('[PASS] rollback_pending crash resumes frozen reverse plan without duplicate operations')
}

async function runPartialRollbackReplayCase() {
  const fixture = prepareScenario('partial-rollback-replay')
  const boundary = await runCrashWorker(
    'partial-rollback-crash',
    fixture,
    () => lineCount(fixture.patchCounter) === 2 && lineCount(fixture.reverseCounter) === 1
  )
  assert.equal(boundary.type, 'partial-rollback-first-confirmed')
  assert.equal(boundary.phase, 'rollback_pending')
  assert.deepEqual(boundary.forwardTaskIds, ['write-one', 'write-two'])
  assert.deepEqual(boundary.reverseTaskIds, ['write-two', 'write-one'])
  assert.equal(boundary.firstReverseTaskId, 'write-two')
  assert.equal(boundary.firstReverseOperationId, boundary.reverseOperationIds[0])
  assert.equal(mutationFileCount(fixture.patchCounter, 'rollback-one.txt'), 1)
  assert.equal(mutationFileCount(fixture.patchCounter, 'rollback-two.txt'), 1)
  assert.equal(mutationFileCount(fixture.reverseCounter, 'rollback-two.txt'), 1)
  assert.equal(mutationFileCount(fixture.reverseCounter, 'rollback-one.txt'), 0)

  const snapshotStore = compiled('main/task/task-snapshot.js')
  const crashedRecord = onlyRecord(
    await snapshotStore.listTaskDagFinalizations(undefined, fixture.userData),
    'partial rollback crash finalizer'
  )
  assert.equal(crashedRecord.phase, 'rollback_pending')
  assert.equal(crashedRecord.rollbackPatches.length, 2)
  assert.deepEqual(crashedRecord.patchOperationIds, boundary.forwardOperationIds)
  assert.deepEqual(crashedRecord.rollbackOperationIds, boundary.reverseOperationIds)
  for (const operationId of boundary.forwardOperationIds) {
    await assertOperationEffect(snapshotStore, operationId, fixture.userData, 'confirmed')
  }
  await assertOperationEffect(
    snapshotStore,
    boundary.firstReverseOperationId,
    fixture.userData,
    'confirmed'
  )
  assert.equal(
    (await snapshotStore.listTaskRuns(`operation:${boundary.reverseOperationIds[1]}`, fixture.userData)).length,
    0,
    'second reverse operation must not exist before the crash'
  )

  const resumed = await runResumeWorker('partial-rollback-resume', fixture)
  assert.equal(resumed.phase, 'completed')
  assert.equal(resumed.autoMergeStatus, 'rolled-back')
  assert.equal(resumed.rollbackOk, true)
  assert.equal(resumed.verificationResultStatus, 'failed')
  const completedRecord = onlyRecord(
    await snapshotStore.listTaskDagFinalizations(undefined, fixture.userData),
    'partial rollback completed finalizer'
  )
  assert.deepEqual(completedRecord.patchOperationIds, boundary.forwardOperationIds)
  assert.deepEqual(completedRecord.rollbackOperationIds, boundary.reverseOperationIds)
  for (const operationId of [...boundary.forwardOperationIds, ...boundary.reverseOperationIds]) {
    await assertOperationEffect(snapshotStore, operationId, fixture.userData, 'confirmed')
  }
  assert.equal(mutationFileCount(fixture.patchCounter, 'rollback-one.txt'), 1)
  assert.equal(mutationFileCount(fixture.patchCounter, 'rollback-two.txt'), 1)
  assert.equal(mutationFileCount(fixture.reverseCounter, 'rollback-two.txt'), 1)
  assert.equal(mutationFileCount(fixture.reverseCounter, 'rollback-one.txt'), 1)
  assert.equal(operationTaskCount(fixture.operationCounter, 'apply', 'write-one'), 1)
  assert.equal(operationTaskCount(fixture.operationCounter, 'apply', 'write-two'), 1)
  assert.equal(
    operationTaskCount(fixture.operationCounter, 'reverse', 'write-two'),
    2,
    'restart must call the deterministic gateway again to replay the first reverse receipt'
  )
  assert.equal(operationTaskCount(fixture.operationCounter, 'reverse', 'write-one'), 1)
  assert.equal(fs.existsSync(path.join(fixture.project, 'rollback-one.txt')), false)
  assert.equal(fs.existsSync(path.join(fixture.project, 'rollback-two.txt')), false)
  assert.equal(resumed.summaryMessageCount, 1)
  assert.equal(resumed.summarySendCount, 1)
  console.log('[PASS] partial rollback crash replays first reverse receipt and completes remaining reverse once')
}

async function runSummaryReceiptCase() {
  const fixture = prepareScenario('summary-receipt')
  const boundary = await runCrashWorker('summary-crash', fixture, () => lineCount(fixture.summaryCounter) === 1)
  assert.equal(boundary.type, 'summary-receipt')
  assert.equal(lineCount(fixture.summaryCounter), 1)

  const snapshotStore = compiled('main/task/task-snapshot.js')
  const crashedRecord = onlyRecord(
    await snapshotStore.listTaskDagFinalizations(undefined, fixture.userData),
    'summary crash finalizer'
  )
  assert.equal(crashedRecord.phase, 'summary_pending')
  assert.equal(crashedRecord.summary.messageId, boundary.messageId)
  assert.equal(
    transcriptMessageCount(fixture.userData, boundary.sdkSessionId, boundary.messageId),
    1,
    'stable summary message must be durable before the finalizer receipt transition'
  )

  const resumed = await runResumeWorker('summary-resume', fixture)
  assert.equal(resumed.phase, 'completed')
  assert.equal(resumed.summaryMessageId, boundary.messageId)
  assert.equal(resumed.summaryMessageCount, 1)
  assert.equal(resumed.summarySendCount, 1, 'receipt recovery must not call Engine.send again')
  console.log('[PASS] durable transcript receipt closes summary_pending without duplicate send')
}

async function runVerificationCrashCase() {
  const fixture = prepareScenario('verification-crash')
  const boundary = await runCrashWorker(
    'verify-crash',
    fixture,
    () => lineCount(fixture.verificationCounter) === 1
  )
  assert.equal(boundary.type, 'verifying-persisted')
  assert.equal(boundary.phase, 'verifying')
  assert.equal(lineCount(fixture.verificationCounter), 1, 'verification command must start before the crash')

  const snapshotStore = compiled('main/task/task-snapshot.js')
  const crashedRecord = onlyRecord(
    await snapshotStore.listTaskDagFinalizations(undefined, fixture.userData),
    'verification crash finalizer'
  )
  assert.equal(crashedRecord.phase, 'verifying')
  assert.equal(crashedRecord.verification.status, 'started')

  const resumed = await runResumeWorker('verify-resume', fixture)
  assert.equal(resumed.phase, 'waiting_reconciliation')
  assert.match(resumed.error, /结果未知|禁止自动重跑/)
  await delay(2300)
  assert.equal(
    lineCount(fixture.verificationCounter),
    1,
    'recovery from an interrupted verification must not launch the command again'
  )
  console.log('[PASS] interrupted verification becomes waiting_reconciliation without rerun')
}

async function runUndefinedVerificationCase() {
  const fixture = prepareScenario('undefined-verification')
  const completed = await runResumeWorker('undefined-verification', fixture)
  assert.equal(completed.phase, 'completed')
  assert.equal(completed.verificationResultStatus, 'skipped')
  assert.equal(completed.summaryMessageCount, 1)
  assert.equal(completed.summarySendCount, 1)
  assert.equal(completed.persistedPhases.includes('verifying'), false)
  assert.equal(completed.persistedPhases.includes('waiting_reconciliation'), false)
  assert.equal(completed.persistedPhases.at(-1), 'completed')
  console.log('[PASS] undefined verification command skips verifying and completes without permanent waiting')
}

async function runWaitingReplayBlockedCase() {
  const fixture = prepareScenario('waiting-replay-blocked')
  await seedWaitingReplayScenario(fixture)

  const resumed = await runResumeWorker('waiting-replay-blocked', fixture)
  assert.equal(resumed.phase, 'waiting_reconciliation')
  assert.equal(resumed.replaySendCount, 0, 'waiting finalizer must suppress parent replay prompts')
  assert.equal(resumed.blockedHookCount, 1, 'waiting finalizer must expose exactly one blocked hook')
  assert.equal(resumed.snapshotRetained, true)
  assert.equal(resumed.snapshotFinalizationPhase, 'waiting_reconciliation')
  assert.equal(resumed.summarySendCount, 0)
  console.log('[PASS] waiting finalizer preempts recovered parent replay and exposes one blocked hook')
}

async function runManualResolutionCases() {
  const cases = [
    {
      resolution: 'verification_passed',
      mode: 'manual-verification-passed',
      autoMergeStatus: 'success',
      verificationStatus: 'passed',
      reverseMutations: 0,
      verificationRuns: 1,
      finalizationFileExists: true,
      staleProbe: true
    },
    {
      resolution: 'verification_failed',
      mode: 'manual-verification-failed',
      autoMergeStatus: 'rolled-back',
      verificationStatus: 'failed',
      reverseMutations: 1,
      verificationRuns: 1,
      finalizationFileExists: false
    },
    {
      resolution: 'verification_not_started',
      mode: 'manual-verification-not-started',
      autoMergeStatus: 'success',
      verificationStatus: 'passed',
      reverseMutations: 0,
      verificationRuns: 1,
      finalizationFileExists: true
    },
    {
      resolution: 'finalization_abandoned',
      mode: 'manual-finalization-abandoned',
      autoMergeStatus: 'failed',
      verificationStatus: 'not-run',
      reverseMutations: 0,
      verificationRuns: 1,
      finalizationFileExists: true
    }
  ]

  for (const testCase of cases) {
    const fixture = prepareScenario(testCase.mode)
    const crashMode = testCase.resolution === 'verification_not_started'
      ? 'verify-before-command-crash'
      : 'verify-crash'
    await runCrashWorker(
      crashMode,
      fixture,
      () => testCase.resolution === 'verification_not_started'
        ? lineCount(fixture.verificationCounter) === 0
        : lineCount(fixture.verificationCounter) === 1
    )
    const resolved = await runResumeWorker(testCase.mode, fixture)
    assert.equal(resolved.resolution, testCase.resolution)
    assert.equal(resolved.phase, 'completed')
    assert.equal(resolved.autoMergeStatus, testCase.autoMergeStatus)
    assert.equal(resolved.verificationResultStatus, testCase.verificationStatus)
    assert.equal(resolved.patchMutationCount, 1, `${testCase.resolution} must not duplicate the forward patch`)
    assert.equal(resolved.patchEffectCount, 1)
    assert.equal(resolved.patchEffectStatus, 'confirmed')
    assert.equal(resolved.reverseMutationCount, testCase.reverseMutations)
    assert.equal(resolved.rollbackEffectCount, testCase.reverseMutations)
    assert.equal(
      resolved.rollbackEffectStatus,
      testCase.reverseMutations === 1 ? 'confirmed' : undefined
    )
    assert.equal(resolved.verificationRunCount, testCase.verificationRuns)
    assert.equal(resolved.summarySendCount, 1)
    assert.equal(resolved.summaryMessageCount, 1)
    assert.equal(resolved.finalizationFileExists, testCase.finalizationFileExists)
    if (testCase.staleProbe) {
      assert.equal(resolved.staleRevisionRejected, true)
      assert.equal(resolved.staleRecordUnchanged, true)
      assert.equal(resolved.staleSideEffectsUnchanged, true)
    }
  }
  console.log('[PASS] manual verification/finalization resolutions persist terminal state with CAS side-effect bounds')
}

async function runSummaryNotDeliveredResolutionCase() {
  const fixture = prepareScenario('manual-summary-not-delivered')
  const boundary = await runCrashWorker(
    'summary-no-receipt-crash',
    fixture,
    () => lineCount(fixture.summaryCounter) === 1
  )
  assert.equal(boundary.type, 'summary-without-receipt')
  assert.equal(boundary.phase, 'summary_pending')
  assert.equal(boundary.deliveryAttempts, 1)
  assert.match(boundary.error, /尚未产生可验证 transcript receipt/)
  assert.equal(
    transcriptMessageCount(fixture.userData, boundary.sdkSessionId, boundary.messageId),
    0,
    'first summary attempt must not have a durable receipt'
  )

  const resolved = await runResumeWorker('manual-summary-not-delivered', fixture)
  assert.equal(resolved.resolution, 'summary_not_delivered')
  assert.equal(resolved.phase, 'completed')
  assert.equal(resolved.summaryMessageId, boundary.messageId)
  assert.equal(resolved.summaryDeliveryAttempts, 2)
  assert.equal(resolved.summarySendCount, 2, 'manual authorization must permit exactly one retry')
  assert.equal(resolved.summaryMessageCount, 1)
  console.log('[PASS] summary_not_delivered authorizes one stable-message retry and completes')
}

async function runWorker(mode) {
  const fixture = fixtureFromEnvironment()
  process.env.CAOGEN_DAG_FINALIZATION_USER_DATA = fixture.userData
  const restoreModuleLoad = installModuleStubs()
  try {
    const snapshotStore = compiled('main/task/task-snapshot.js')
    const worktreeMerge = compiled('main/worktreeMerge.js')
    instrumentPatchMutation(mode, fixture, worktreeMerge)
    instrumentUnresolvedPatch(mode, fixture, worktreeMerge)

    const worktreeHandlers = compiled('main/ipc/worktree-operation-handlers.js')
    instrumentPatchBoundary(mode, fixture, snapshotStore, worktreeHandlers)
    instrumentPatchOperationCounter(mode, fixture, worktreeHandlers)
    instrumentVerificationBoundary(mode, fixture, snapshotStore)
    instrumentRollbackBoundary(mode, fixture, snapshotStore)
    instrumentPartialRollbackBoundary(mode, fixture, snapshotStore, worktreeHandlers)
    instrumentSummaryNoReceiptBoundary(mode, fixture, snapshotStore)
    instrumentSummaryAttemptBarrierBoundary(mode, fixture, snapshotStore)
    instrumentFinalizationPhaseLog(mode, fixture, snapshotStore)

    const transcript = compiled('main/transcript.js')
    const engineModule = compiled('main/engine.js')
    const builtinEngines = compiled('main/engines.js')
    builtinEngines.registerBuiltinEngines = () => {}
    engineModule.registerEngine(fakeEngineFactory(mode, fixture, transcript))

    const manager = compiled('main/sessionManager.js').sessionManager
    if (mode === 'waiting-replay-blocked') {
      await runWaitingReplayBlockedWorker(fixture, manager, snapshotStore)
      return
    }
    if (mode === 'summary-attempt-barrier-resume') {
      await p1Cases.runSummaryAttemptBarrierWorker({ fixture, manager, snapshotStore })
      return
    }
    if (mode.startsWith('effect-resolution-')) {
      await p1Cases.runEffectResolutionWorker({ mode, fixture, manager, snapshotStore, startScenario })
      return
    }
    if (mode.startsWith('legacy-migration')) {
      await p1Cases.executeLegacyMigrationWorker({ mode, fixture, snapshotStore })
      return
    }
    if (mode.startsWith('manual-')) {
      await runManualResolutionWorker(mode, fixture, manager, snapshotStore)
      return
    }
    if (mode.endsWith('-resume')) {
      await resumeScenario(mode, fixture, manager, snapshotStore)
      return
    }
    if (mode === 'undefined-verification') {
      await startScenario(mode, fixture, manager)
      await resumeScenario(mode, fixture, manager, snapshotStore, true)
      return
    }
    await startScenario(mode, fixture, manager)
    await delay(30_000)
    throw new Error(`${mode} did not reach its crash boundary`)
  } finally {
    restoreModuleLoad()
  }
}

async function startScenario(mode, fixture, manager) {
  await manager.init()
  const parent = await manager.create({
    cwd: fixture.project,
    isolated: false,
    engine: 'openai',
    model: 'fake-model',
    providerId: 'fake-provider',
    permissionMode: 'default',
    title: `${mode} parent`
  })
  await waitFor(() => manager.get(parent.id)?.meta.status === 'idle', 5000, 'parent engine idle')
  assert.equal(manager.send(parent.id, 'durable finalization crash e2e'), true)
  await waitFor(() => manager.get(parent.id)?.meta.status === 'idle', 5000, 'parent bootstrap turn')
  fs.writeFileSync(fixture.parentIdFile, parent.id, 'utf8')

  await manager.dispatchTaskDag(parent.id, {
    dag: mode === 'partial-rollback-crash' ? twoTaskRollbackDag(mode) : oneTaskDag(mode),
    cwd: fixture.project,
    isolated: true,
    engine: 'openai',
    model: 'fake-model',
    providerId: 'fake-provider',
    permissionMode: 'default',
    maxRetries: 0,
    taskTimeoutMs: 0,
    autoMerge: mode !== 'summary-crash' && mode !== 'summary-no-receipt-crash',
    ...(mode === 'verify-crash' || mode === 'verify-before-command-crash'
      ? { verificationCommand: verificationCommand(fixture) }
      : mode === 'rollback-crash' || mode === 'partial-rollback-crash' || mode.includes('effect-resolution-reverse-')
        ? { verificationCommand: verificationFailureCommand(fixture) }
      : {})
  })
}

async function runWaitingReplayBlockedWorker(fixture, manager, snapshotStore) {
  await manager.init()
  const record = await waitForRecord(snapshotStore, 'waiting_reconciliation', 5000)
  await waitFor(() => manager.get(record.parentSessionId)?.meta.status === 'idle', 5000, 'blocked parent idle')
  await waitFor(() => lineCount(fixture.blockedHookCounter) >= 1, 5000, 'finalizer blocked hook')
  await delay(100)
  const snapshot = await snapshotStore.getTaskSnapshot(record.parentSessionId)
  const finalizationPhase = snapshot?.dagExecutions
    .find((execution) => execution.id === record.executionId)
    ?.finalization?.phase
  sendAndExit({
    type: 'resume-result',
    mode: 'waiting-replay-blocked',
    phase: record.phase,
    replaySendCount: lineCount(fixture.replayCounter),
    blockedHookCount: lineCount(fixture.blockedHookCounter),
    snapshotRetained: Boolean(snapshot),
    snapshotFinalizationPhase: finalizationPhase,
    summarySendCount: lineCount(fixture.summaryCounter)
  })
}

async function runManualResolutionWorker(mode, fixture, manager, snapshotStore) {
  const resolution = manualResolutionForMode(mode)
  await manager.init()
  let record = resolution === 'summary_not_delivered'
    ? await waitForRecord(snapshotStore, 'summary_pending', 5000)
    : await waitForRecord(snapshotStore, 'waiting_reconciliation', 5000)
  await waitFor(() => manager.get(record.parentSessionId)?.meta.status === 'idle', 5000, 'manual resolution parent idle')

  let staleRevisionRejected = false
  let staleRecordUnchanged = false
  let staleSideEffectsUnchanged = false
  if (mode === 'manual-verification-passed') {
    const before = await snapshotStore.getTaskDagFinalization(record.executionId)
    const countersBefore = manualSideEffectCounters(fixture)
    await assert.rejects(
      manager.resolveTaskDagFinalization(record.executionId, record.revision - 1, resolution),
      /stale_revision/
    )
    staleRevisionRejected = true
    const after = await snapshotStore.getTaskDagFinalization(record.executionId)
    staleRecordUnchanged = JSON.stringify(after) === JSON.stringify(before)
    staleSideEffectsUnchanged = JSON.stringify(manualSideEffectCounters(fixture)) === JSON.stringify(countersBefore)
    assert.equal(staleRecordUnchanged, true, 'stale resolver CAS must preserve the finalizer record')
    assert.equal(staleSideEffectsUnchanged, true, 'stale resolver CAS must not trigger side effects')
    record = after
  }

  await manager.resolveTaskDagFinalization(record.executionId, record.revision, resolution)
  const completed = await waitForRecord(snapshotStore, 'completed', 20_000)
  const snapshot = await snapshotStore.getTaskSnapshot(completed.parentSessionId)
  const sdkSessionId = snapshot?.execution.sdkSessionId ?? snapshot?.meta.sdkSessionId
  const summaryMessageId = completed.summary?.messageId
  const patchEffect = await operationEffectEvidence(
    snapshotStore,
    completed.patchOperationIds[0],
    fixture.userData
  )
  const rollbackEffect = await operationEffectEvidence(
    snapshotStore,
    completed.rollbackOperationIds[0],
    fixture.userData
  )
  sendAndExit({
    type: 'resume-result',
    mode,
    resolution,
    phase: completed.phase,
    autoMergeStatus: completed.autoMergeResult?.status,
    verificationResultStatus: completed.verification.result?.status,
    patchMutationCount: lineCount(fixture.patchCounter),
    patchEffectCount: patchEffect.count,
    patchEffectStatus: patchEffect.status,
    reverseMutationCount: lineCount(fixture.reverseCounter),
    rollbackEffectCount: rollbackEffect.count,
    rollbackEffectStatus: rollbackEffect.status,
    verificationRunCount: lineCount(fixture.verificationCounter),
    summarySendCount: lineCount(fixture.summaryCounter),
    summaryMessageId,
    summaryMessageCount: summaryMessageId && sdkSessionId
      ? transcriptMessageCount(fixture.userData, sdkSessionId, summaryMessageId)
      : 0,
    summaryDeliveryAttempts: completed.summary?.deliveryAttempts,
    finalizationFileExists: fs.existsSync(path.join(fixture.project, 'finalization.txt')),
    staleRevisionRejected,
    staleRecordUnchanged,
    staleSideEffectsUnchanged
  })
}

function manualResolutionForMode(mode) {
  const resolutions = {
    'manual-verification-passed': 'verification_passed',
    'manual-verification-failed': 'verification_failed',
    'manual-verification-not-started': 'verification_not_started',
    'manual-finalization-abandoned': 'finalization_abandoned',
    'manual-summary-not-delivered': 'summary_not_delivered'
  }
  const resolution = resolutions[mode]
  if (!resolution) throw new Error(`unknown manual finalizer mode: ${mode}`)
  return resolution
}

function manualSideEffectCounters(fixture) {
  return {
    patch: lineCount(fixture.patchCounter),
    reverse: lineCount(fixture.reverseCounter),
    verification: lineCount(fixture.verificationCounter),
    summary: lineCount(fixture.summaryCounter),
    finalizationFileExists: fs.existsSync(path.join(fixture.project, 'finalization.txt'))
  }
}

async function resumeScenario(mode, fixture, manager, snapshotStore, initialized = false) {
  if (!initialized) await manager.init()
  const expectedPhase = mode === 'verify-resume' ? 'waiting_reconciliation' : 'completed'
  const record = await waitForRecord(snapshotStore, expectedPhase, 20_000)
  const snapshot = await snapshotStore.getTaskSnapshot(record.parentSessionId)
  assert(snapshot, 'parent finalization snapshot must survive restart')
  const sdkSessionId = snapshot.execution.sdkSessionId ?? snapshot.meta.sdkSessionId
  assert(sdkSessionId, 'recovered parent must retain sdkSessionId')
  const messageId = record.summary?.messageId
  const patchOperationId = record.patchOperationIds[0]
  const rollbackOperationId = record.rollbackOperationIds[0]
  const patchEffect = await operationEffectEvidence(snapshotStore, patchOperationId, fixture.userData)
  const rollbackEffect = await operationEffectEvidence(snapshotStore, rollbackOperationId, fixture.userData)
  const payload = {
    type: 'resume-result',
    mode,
    phase: record.phase,
    error: record.error,
    patchOperationId,
    effectCount: patchEffect.count,
    effectStatus: patchEffect.status,
    patchEffectCount: patchEffect.count,
    patchEffectStatus: patchEffect.status,
    rollbackOperationId,
    rollbackEffectCount: rollbackEffect.count,
    rollbackEffectStatus: rollbackEffect.status,
    autoMergeStatus: record.autoMergeResult?.status,
    rollbackOk: record.autoMergeResult?.rollback?.ok,
    verificationResultStatus: record.verification.result?.status,
    summaryMessageId: messageId,
    summaryMessageCount: messageId
      ? transcriptMessageCount(fixture.userData, sdkSessionId, messageId)
      : 0,
    summarySendCount: lineCount(fixture.summaryCounter),
    persistedPhases: readLines(fixture.phaseLog)
  }
  sendAndExit(payload)
}
async function seedWaitingReplayScenario(fixture) {
  process.env.CAOGEN_DAG_FINALIZATION_USER_DATA = fixture.userData
  const snapshotStore = compiled('main/task/task-snapshot.js')
  const finalization = compiled('main/agent/dag-finalization.js')
  const taskRun = compiled('main/task/task-run.js')
  const parentSessionId = 'parent-waiting-replay'
  const execution = terminalExecution('dag-waiting-replay', parentSessionId)
  const prepared = finalization.createTaskDagFinalizationRecord({
    terminalExecution: execution,
    autoMergeOptions: { enabled: true, verificationCommand: 'echo verify' },
    now: 2000
  })
  const replayText = 'resume the interrupted parent request only after finalizer reconciliation'
  const transcript = [{
    seq: 1,
    eventId: 'waiting-replay-user-event',
    streamId: 'waiting-replay-stream',
    occurredAt: 2010,
    event: { kind: 'user-message', messageId: 'waiting-replay-message', text: replayText }
  }]
  const meta = {
    ...sessionMeta(parentSessionId, fixture.project),
    sourceCwd: undefined,
    status: 'running'
  }
  const run = taskRun.transitionTaskRun(
    taskRun.createTaskRun({
      id: 'waiting-replay-run',
      sessionId: parentSessionId,
      taskId: parentSessionId,
      digitalWorkerBinding: meta.digitalWorkerBinding,
      now: 2000
    }),
    'executing',
    { now: 2010, messageId: 'waiting-replay-message', lastEventKind: 'user-message' }
  )
  const snapshotFor = (record) => snapshotStore.buildTaskSnapshot({
    meta,
    transcript,
    lastSeq: 1,
    lastEventId: 'waiting-replay-user-event',
    lastEventKind: 'task-dag-update',
    eventCount: 1,
    reason: 'important-event',
    run,
    dagExecutions: [{
      ...record.terminalExecution,
      finalization: finalization.taskDagFinalizationView(record)
    }],
    dagRuntimes: [],
    now: record.updatedAt
  })
  await snapshotStore.saveTaskDagFinalizationBarrier(
    snapshotFor(prepared),
    prepared,
    { expectedRevision: 0, rootDir: fixture.userData }
  )
  const waiting = finalization.transitionTaskDagFinalization(
    prepared,
    'waiting_reconciliation',
    {
      verification: { status: 'started', command: 'echo verify', startedAt: 2020 },
      error: '验收命令结果未知，需要人工对账；禁止自动续跑父请求。'
    },
    2020
  )
  await snapshotStore.saveTaskDagFinalizationBarrier(
    snapshotFor(waiting),
    waiting,
    { expectedRevision: 1, rootDir: fixture.userData }
  )
  fs.writeFileSync(fixture.parentIdFile, parentSessionId, 'utf8')
}

function instrumentPatchMutation(mode, fixture, worktreeMerge) {
  if (!FORWARD_PATCH_MUTATION_MODES.has(mode)) return
  const originalApply = worktreeMerge.applySquashPatch
  worktreeMerge.applySquashPatch = (...args) => {
    fs.appendFileSync(fixture.patchCounter, `${patchMutationFile(args[1])}\n`)
    return originalApply(...args)
  }
  if (!REVERSE_PATCH_MUTATION_MODES.has(mode)) return
  const originalReverse = worktreeMerge.reverseSquashPatch
  worktreeMerge.reverseSquashPatch = (...args) => {
    fs.appendFileSync(fixture.reverseCounter, `${patchMutationFile(args[1])}\n`)
    return originalReverse(...args)
  }
}

function instrumentUnresolvedPatch(mode, fixture, worktreeMerge) {
  if (!mode.startsWith('effect-resolution-')) return
  const reverse = mode.includes('-reverse-')
  const noOpDirection = reverse ? 'reverse' : 'apply'
  const original = reverse ? worktreeMerge.reverseSquashPatch : worktreeMerge.applySquashPatch
  let noOp = true
  const replacement = (repoRoot, patchText) => {
    if (!noOp) return original(repoRoot, patchText)
    noOp = false
    return {
      ok: true,
      repoRoot,
      bytes: Buffer.byteLength(String(patchText), 'utf8'),
      changedFiles: 1,
      applied: true
    }
  }
  if (noOpDirection === 'reverse') worktreeMerge.reverseSquashPatch = replacement
  else worktreeMerge.applySquashPatch = replacement
}

function instrumentPatchBoundary(mode, fixture, snapshotStore, handlers) {
  if (mode !== 'patch-crash') return
  const original = handlers.executeTaskDagAutoMergePatchEffect
  let signalled = false
  handlers.executeTaskDagAutoMergePatchEffect = async (...args) => {
    const result = await original(...args)
    if (!signalled && result?.ok === true && result.effectStatus === 'confirmed') {
      signalled = true
      const record = onlyRecord(await snapshotStore.listTaskDagFinalizations(), 'patch boundary finalizer')
      signalBoundary(fixture, {
        type: 'patch-confirmed',
        phase: record.phase,
        effectStatus: result.effectStatus,
        operationId: result.operationId
      }, true)
    }
    return result
  }
}

function instrumentPatchOperationCounter(mode, fixture, handlers) {
  if (
    mode !== 'rollback-crash' &&
    mode !== 'rollback-resume' &&
    mode !== 'partial-rollback-crash' &&
    mode !== 'partial-rollback-resume'
  ) return
  const original = handlers.executeTaskDagAutoMergePatchEffect
  handlers.executeTaskDagAutoMergePatchEffect = async (input, ...args) => {
    fs.appendFileSync(fixture.operationCounter, `${input.direction ?? 'apply'}:${input.taskId}\n`)
    return original(input, ...args)
  }
}

function instrumentVerificationBoundary(mode, fixture, snapshotStore) {
  if (mode !== 'verify-crash' && mode !== 'verify-before-command-crash') return
  const original = snapshotStore.saveTaskDagFinalizationBarrier
  let signalled = false
  snapshotStore.saveTaskDagFinalizationBarrier = async (...args) => {
    const result = await original(...args)
    if (!signalled && result.finalization.phase === 'verifying') {
      signalled = true
      signalBoundary(fixture, {
        type: 'verifying-persisted',
        phase: result.finalization.phase,
        revision: result.finalization.revision
      }, mode === 'verify-before-command-crash')
    }
    return result
  }
}

function instrumentRollbackBoundary(mode, fixture, snapshotStore) {
  if (mode !== 'rollback-crash') return
  const original = snapshotStore.saveTaskDagFinalizationBarrier
  let signalled = false
  snapshotStore.saveTaskDagFinalizationBarrier = async (...args) => {
    const result = await original(...args)
    if (!signalled && result.finalization.phase === 'rollback_pending') {
      signalled = true
      const record = result.finalization
      signalBoundary(fixture, {
        type: 'rollback-persisted',
        phase: record.phase,
        rollbackPlanCount: record.rollbackPatches.length,
        forwardOperationId: record.patchOperationIds[0],
        reverseOperationId: record.rollbackOperationIds[0]
      }, true)
    }
    return result
  }
}

function instrumentPartialRollbackBoundary(mode, fixture, snapshotStore, handlers) {
  if (mode !== 'partial-rollback-crash') return
  const original = handlers.executeTaskDagAutoMergePatchEffect
  let signalled = false
  handlers.executeTaskDagAutoMergePatchEffect = async (input, ...args) => {
    const result = await original(input, ...args)
    if (
      !signalled &&
      input.direction === 'reverse' &&
      result?.ok === true &&
      result.effectStatus === 'confirmed'
    ) {
      signalled = true
      const record = onlyRecord(
        await snapshotStore.listTaskDagFinalizations(undefined, fixture.userData),
        'partial rollback boundary finalizer'
      )
      const reverseTaskIds = record.rollbackPatches.map((plan) => plan.taskId)
      signalBoundary(fixture, {
        type: 'partial-rollback-first-confirmed',
        phase: record.phase,
        forwardTaskIds: [...reverseTaskIds].reverse(),
        reverseTaskIds,
        forwardOperationIds: record.patchOperationIds,
        reverseOperationIds: record.rollbackOperationIds,
        firstReverseTaskId: input.taskId,
        firstReverseOperationId: result.operationId
      }, true)
    }
    return result
  }
}

function instrumentSummaryNoReceiptBoundary(mode, fixture, snapshotStore) {
  if (mode !== 'summary-no-receipt-crash') return
  const original = snapshotStore.saveTaskDagFinalizationBarrier
  let signalled = false
  snapshotStore.saveTaskDagFinalizationBarrier = async (...args) => {
    const result = await original(...args)
    if (
      !signalled &&
      result.finalization.phase === 'summary_pending' &&
      result.finalization.error === '父汇总消息尚未产生可验证 transcript receipt，保持待投递状态。'
    ) {
      signalled = true
      const record = result.finalization
      signalBoundary(fixture, {
        type: 'summary-without-receipt',
        phase: record.phase,
        error: record.error,
        messageId: record.summary?.messageId,
        deliveryAttempts: record.summary?.deliveryAttempts,
        sdkSessionId: result.snapshot.execution.sdkSessionId ?? result.snapshot.meta.sdkSessionId
      }, true)
    }
    return result
  }
}

function instrumentSummaryAttemptBarrierBoundary(mode, fixture, snapshotStore) {
  if (mode !== 'summary-attempt-barrier-crash') return
  const original = snapshotStore.saveTaskDagFinalizationBarrier
  let signalled = false
  snapshotStore.saveTaskDagFinalizationBarrier = async (...args) => {
    const result = await original(...args)
    const record = result.finalization
    if (
      !signalled &&
      record.phase === 'summary_pending' &&
      record.summary?.deliveryAttempts === 1 &&
      record.error === undefined
    ) {
      signalled = true
      signalBoundary(fixture, {
        type: 'summary-attempt-persisted',
        phase: record.phase,
        deliveryAttempts: record.summary.deliveryAttempts,
        messageId: record.summary.messageId,
        error: record.error
      }, true)
    }
    return result
  }
}

function instrumentFinalizationPhaseLog(mode, fixture, snapshotStore) {
  if (mode !== 'undefined-verification') return
  const original = snapshotStore.saveTaskDagFinalizationBarrier
  snapshotStore.saveTaskDagFinalizationBarrier = async (...args) => {
    const result = await original(...args)
    fs.appendFileSync(fixture.phaseLog, `${result.finalization.phase}\n`)
    return result
  }
}

function fakeEngineFactory(mode, fixture, transcriptModule) {
  return {
    kind: 'openai',
    label: 'DAG Finalization Fake',
    available: () => true,
    configured: () => true,
    create: (meta, emit, resumeSdkSessionId, initialEventSeq) =>
      new FinalizationFakeEngine({
        meta,
        emit,
        resumeSdkSessionId,
        initialEventSeq,
        mode,
        fixture,
        TranscriptWriter: transcriptModule.TranscriptWriter
      })
  }
}

class FinalizationFakeEngine {
  constructor(input) {
    this.meta = input.meta
    this.emit = input.emit
    this.mode = input.mode
    this.fixture = input.fixture
    this.writer = new input.TranscriptWriter(input.resumeSdkSessionId, input.initialEventSeq ?? 0)
  }

  async start() {
    this.meta.sdkSessionId ||= `fake-sdk-${this.meta.id}`
    this.meta.status = 'idle'
    this.push({ kind: 'init', sdkSessionId: this.meta.sdkSessionId, model: this.meta.model, tools: [] })
    this.push({ kind: 'status', status: 'idle' })
  }

  send(input) {
    const payload = typeof input === 'string' ? { text: input } : input
    const text = String(payload?.text ?? '')
    const messageId = String(payload?.messageId ?? `fake-message-${Date.now()}`)
    const isSummary = text.startsWith('[DAG 编排完成]')
    if (text.startsWith('【CaoGen 断点续跑】')) {
      fs.appendFileSync(this.fixture.replayCounter, `${messageId}\n`)
    }
    if (isSummary && this.mode === 'summary-no-receipt-crash') {
      fs.appendFileSync(this.fixture.summaryCounter, `${messageId}\n`)
      this.meta.status = 'running'
      this.push({ kind: 'status', status: 'running' })
      this.meta.status = 'idle'
      this.push({
        kind: 'turn-result',
        subtype: 'success',
        isError: false,
        resultText: 'summary accepted without durable user-message receipt',
        durationMs: 1
      })
      return
    }
    this.push({ kind: 'user-message', messageId, text })

    if (this.meta.childTaskId) {
      this.meta.status = 'running'
      this.push({ kind: 'status', status: 'running' })
      const childFile = childTaskFile(this.meta.childTaskId)
      const childContent = this.meta.childTaskId === 'write-once'
        ? 'applied-once\n'
        : `${this.meta.childTaskId}\n`
      fs.writeFileSync(path.join(this.meta.cwd, childFile), childContent, 'utf8')
      setTimeout(() => {
        this.meta.status = 'idle'
        this.push({
          kind: 'turn-result',
          subtype: 'success',
          isError: false,
          resultText: `child wrote ${childFile}`,
          durationMs: 1
        })
      }, 20)
      return
    }

    if (!isSummary) {
      this.meta.status = 'running'
      this.push({ kind: 'status', status: 'running' })
      setTimeout(() => {
        this.meta.status = 'idle'
        this.push({
          kind: 'turn-result',
          subtype: 'success',
          isError: false,
          resultText: 'parent bootstrap complete',
          durationMs: 1
        })
      }, 20)
      return
    }
    fs.appendFileSync(this.fixture.summaryCounter, `${messageId}\n`)
    if (this.mode === 'summary-crash') {
      signalBoundary(this.fixture, {
        type: 'summary-receipt',
        messageId,
        sdkSessionId: this.meta.sdkSessionId
      }, true)
    }
  }

  emitSyntheticEvent(event) {
    this.push(event)
  }

  getTranscript() {
    return this.writer.readAll()
  }

  rejectSend(message) {
    this.meta.status = 'error'
    this.push({ kind: 'status', status: 'error', error: message })
  }

  async interrupt() {}
  respondPermission() {}
  pendingPermissions() { return [] }
  async setPermissionMode(mode) { this.meta.permissionMode = mode }
  async setModel(model) { this.meta.model = model }
  rename(title) { this.meta.title = title }
  async dispose() { this.meta.status = 'closed' }

  push(event) {
    if (event.kind === 'hook-event' && event.event === 'task-dag-finalization-blocked') {
      fs.appendFileSync(this.fixture.blockedHookCounter, `${event.detail}\n`)
    }
    const entry = this.writer.nextEntry(event)
    this.emit(event, entry.seq, {
      eventId: entry.eventId,
      streamId: entry.streamId,
      occurredAt: entry.occurredAt,
      correlationId: entry.correlationId,
      causationId: entry.causationId
    })
  }
}
