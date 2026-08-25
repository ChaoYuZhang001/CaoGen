#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const scriptPath = fileURLToPath(import.meta.url)
const mode = process.argv[2]
const PROJECT_ID = 'domain-restart-project'
const GOAL_ID = 'domain-restart-goal'
const WORK_ITEM_ID = 'domain-restart-work-item'
const SESSION_ID = 'domain-restart-session'
const RUN_ID = 'domain-restart-run'
const TOOL_USE_ID = 'domain-restart-opaque-effect'
const HUMAN_OWNER_ID = 'domain-restart-owner'
const SUPERVISOR_OWNER_ID = 'domain-restart-crashed-worker'
const SUPERVISOR_BASE_NOW = 10_000
const SUPERVISOR_LEASE_TTL_MS = 100
const SUPERVISOR_RESTART_NOW = SUPERVISOR_BASE_NOW + SUPERVISOR_LEASE_TTL_MS + 1
const OPAQUE_TOOL_INPUT = { command: 'fixture:opaque-domain-operation' }

if (mode === '--crash-worker' || mode === '--restart-probe') {
  const payload = decodePayload(process.argv[3])
  configureWorkerEnvironment(payload)
  if (mode === '--crash-worker') await runCrashWorker(payload)
  else await runRestartProbe(payload)
  process.exit(0)
} else {
  await runParent()
}

async function runParent() {
  const startedAt = new Date().toISOString()
  const runId = startedAt.replace(/[:.]/g, '-')
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-domain-restart-parity-'))
  const outDir = path.join(tempRoot, 'compiled')
  const userData = path.join(tempRoot, 'user-data')
  const workspace = path.join(tempRoot, 'workspace')
  const executionLog = path.join(tempRoot, 'opaque-effect-executions.jsonl')
  const reportRoot = path.join(repoRoot, 'test-results', 'domain-restart-parity')
  const reportDir = path.join(reportRoot, runId)
  const reportPath = path.join(reportDir, 'report.json')
  const latestPath = path.join(reportRoot, 'latest.json')
  const report = {
    schemaVersion: 1,
    gate: 'test:domain-restart-parity:required',
    runId,
    status: 'failed',
    startedAt,
    finishedAt: null,
    sourceRevision: gitOutput(['rev-parse', 'HEAD']),
    worktreeStatusCount: gitOutput([
      'status', '--porcelain=v1', '--untracked-files=all'
    ]).split('\n').filter(Boolean).length,
    checks: [],
    summary: {},
    scope: {
      requirementsAdvanced: ['RUN-005', 'NFR-REC-003', 'TRUST-005', 'NFR-REC-001', 'NFR-REC-002'],
      covered: [
        'canonical Project/Goal/WorkItem ownership and Run binding',
        'TaskSnapshot/TaskRun persistence across a strong process kill',
        'Supervisor lease expiry rejection with fencing continuity',
        'opaque executing Effect reconciliation with zero automatic replay',
        'idempotent repeated recovery in a fresh process'
      ],
      explicitlyNotCovered: [
        'Artifact checkpoint recovery breadth',
        'Acceptance checkpoint recovery breadth',
        'complete RUN-005 closure'
      ]
    },
    failures: [],
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version
    }
  }

  try {
    mkdirSync(userData, { recursive: true })
    mkdirSync(workspace, { recursive: true })
    compileSources(outDir)
    installElectronStub(outDir)
    const payload = { repoRoot, outDir, userData, workspace, executionLog }
    const crash = await runHardKill(payload)

    if (process.platform !== 'win32') assert.equal(crash.childExit.signal, 'SIGKILL')
    else assert.notEqual(crash.childExit.code, 0)
    check(report, 'strong_kill_after_durable_barriers', {
      signal: crash.childExit.signal,
      taskRunStatus: crash.state.taskRun.status,
      effectStatus: crash.state.effect.status,
      supervisorStatus: crash.state.supervisor.status
    })

    assert.equal(crash.state.taskRun.status, 'executing')
    assert.equal(crash.state.effect.status, 'executing')
    assert.equal(crash.state.effect.targetKind, 'unsupported')
    assert.equal(crash.state.supervisor.status, 'running')
    assert.equal(crash.state.supervisor.lease?.ownerId, SUPERVISOR_OWNER_ID)
    assert.deepEqual(crash.state.workItem.runRefs, [RUN_ID])
    assert.equal(crash.state.executionCount, 1)
    check(report, 'canonical_chain_durable_before_kill', {
      projectId: crash.state.project.id,
      goalId: crash.state.goal.id,
      workItemId: crash.state.workItem.id,
      runId: crash.state.taskRun.id,
      supervisorFencingToken: crash.state.supervisor.fencingToken
    })

    const restart = runRestartChild(payload)
    assert.deepEqual(restart.before, crash.state)
    check(report, 'fresh_process_reads_identical_pre_kill_state', {
      workspaceStoreRevision: restart.before.workspaceStoreRevision,
      taskRunRevision: restart.before.taskRun.revision,
      effectRevision: restart.before.effect.revision,
      supervisorRevision: restart.before.supervisor.revision
    })

    assert.equal(restart.beforeClassification.disposition, 'waiting_reconciliation')
    assert.equal(restart.afterClassification.disposition, 'waiting_reconciliation')
    assert.match(restart.firstRecoveryError.message, /waiting_reconciliation/)
    assert.match(restart.secondRecoveryError.message, /waiting_reconciliation/)
    assert.equal(restart.first.taskRun.status, 'waiting_reconciliation')
    assert.equal(restart.first.effect.status, 'waiting_reconciliation')
    assert.equal(restart.first.toolExecution.status, 'unknown_outcome')
    assert.equal(restart.first.effect.reconciliationEvidenceCount, 1)
    assert.equal(restart.first.effect.retryEvidenceCount, 0)
    assert.equal(restart.duplicateDecision, 'deny')
    check(report, 'unknown_effect_is_persisted_and_blocks_resume', {
      classification: restart.afterClassification.disposition,
      taskRunStatus: restart.first.taskRun.status,
      effectStatus: restart.first.effect.status,
      toolExecutionStatus: restart.first.toolExecution.status,
      duplicateDecision: restart.duplicateDecision
    })

    assert.equal(restart.before.executionCount, 1)
    assert.equal(restart.first.executionCount, 1)
    assert.equal(restart.second.executionCount, 1)
    check(report, 'recovery_performs_zero_automatic_replays', {
      executionsBeforeRecovery: restart.before.executionCount,
      executionsAfterFirstRecovery: restart.first.executionCount,
      executionsAfterSecondRecovery: restart.second.executionCount
    })

    assert.deepEqual(restart.firstLeaseRecovery, {
      expiredRunIds: [RUN_ID],
      blockedRunIds: [RUN_ID]
    })
    assert.deepEqual(restart.secondLeaseRecovery, {
      expiredRunIds: [],
      blockedRunIds: []
    })
    assert.equal(restart.first.supervisor.status, 'blocked')
    assert.equal(restart.first.supervisor.lease, null)
    assert.equal(restart.first.supervisor.fencingToken, restart.before.supervisor.fencingToken)
    assert.equal(restart.oldLeaseRejection.code, 'lease_expired')
    assert(restart.first.supervisorEventKinds.includes('lease.expired'))
    check(report, 'supervisor_lease_is_expired_and_old_fence_is_rejected', {
      status: restart.first.supervisor.status,
      fencingToken: restart.first.supervisor.fencingToken,
      oldLeaseError: restart.oldLeaseRejection.code
    })
    assert.equal(restart.delayedObservation.status, restart.first.supervisor.status)
    assert.equal(restart.delayedObservation.revision, restart.first.supervisor.revision)
    assert.equal(restart.delayedObservation.ignored, true)
    check(report, 'out_of_order_observation_is_audited_without_state_regression', {
      status: restart.delayedObservation.status,
      revision: restart.delayedObservation.revision,
      observedAt: restart.delayedObservation.observedAt,
      ignored: restart.delayedObservation.ignored
    })

    assert.equal(restart.firstBindingRecovery.failures.length, 0)
    assert.deepEqual(restart.firstBindingRecovery.existing, [RUN_ID])
    assert.deepEqual(restart.firstBindingRecovery.observed, [RUN_ID])
    assert.equal(restart.secondBindingRecovery.failures.length, 0)
    assert.deepEqual(restart.secondBindingRecovery.existing, [RUN_ID])
    assert.deepEqual(restart.secondBindingRecovery.observed, [RUN_ID])
    check(report, 'supervisor_bridge_reuses_existing_canonical_binding', {
      disposition: 'existing',
      observedRunId: RUN_ID
    })

    assertCanonicalOwnershipStable(restart.before, restart.first)
    assert.deepEqual(restart.first.workItem.runRefs, [RUN_ID])
    assert(restart.first.taskRun.revision > restart.before.taskRun.revision)
    assert.equal(restart.first.effect.revision, restart.before.effect.revision + 1)
    assert(restart.first.supervisor.revision > restart.before.supervisor.revision)
    check(report, 'ids_ownership_and_canonical_revisions_remain_stable', {
      projectRevision: restart.first.project.revision,
      goalRevision: restart.first.goal.revision,
      workItemRevision: restart.first.workItem.revision,
      recoveredTaskRunRevision: restart.first.taskRun.revision,
      reconciledEffectRevision: restart.first.effect.revision
    })

    assert.deepEqual(restart.second, restart.first)
    assert.equal(restart.fullPersistedStateIdempotent, true)
    assert.deepEqual(restart.secondRecoveryError, restart.firstRecoveryError)
    assert.deepEqual(restart.secondClassification, restart.afterClassification)
    assert.equal(restart.secondDuplicateDecision, restart.duplicateDecision)
    check(report, 'repeated_recovery_is_fully_idempotent', {
      fullPersistedStateIdempotent: restart.fullPersistedStateIdempotent,
      taskRunRevision: restart.second.taskRun.revision,
      effectRevision: restart.second.effect.revision,
      supervisorRevision: restart.second.supervisor.revision,
      supervisorEventCount: restart.second.supervisorStore.eventCount
    })

    report.summary = {
      classification: restart.afterClassification.disposition,
      taskRunStatus: restart.first.taskRun.status,
      effectStatus: restart.first.effect.status,
      supervisorStatus: restart.first.supervisor.status,
      supervisorFencingToken: restart.first.supervisor.fencingToken,
      automaticReplayCount: restart.first.executionCount - restart.before.executionCount,
      repeatedRecoveryIdempotent: true,
      fullPersistedStateIdempotent: restart.fullPersistedStateIdempotent,
      canonicalRunRefs: restart.first.workItem.runRefs,
      closesRun005: false,
      closesArtifactRecovery: false,
      closesAcceptanceRecovery: false
    }
    report.status = 'passed'
  } catch (error) {
    report.failures.push(serializeError(error))
    process.exitCode = 1
  } finally {
    report.finishedAt = new Date().toISOString()
    mkdirSync(reportDir, { recursive: true })
    const body = `${JSON.stringify({
      ...report,
      reportDir: path.relative(repoRoot, reportDir),
      reportPath: path.relative(repoRoot, reportPath)
    }, null, 2)}\n`
    writeFileSync(reportPath, body, 'utf8')
    writeFileSync(latestPath, body, 'utf8')
    rmSync(tempRoot, { recursive: true, force: true })
  }

  console.log(JSON.stringify({
    status: report.status,
    runId,
    checks: report.checks.length,
    summary: report.summary,
    failures: report.failures,
    reportPath: path.relative(repoRoot, reportPath)
  }, null, 2))
}

async function runCrashWorker(payload) {
  const api = await loadApi(payload.outDir)
  const store = await new api.workspace.ProjectWorkspaceStore(payload.userData).open()
  const project = await store.createWorkspace({
    id: PROJECT_ID,
    name: 'Domain restart parity fixture',
    kind: 'software',
    ownerId: HUMAN_OWNER_ID,
    createdAt: 1_000,
    updatedAt: 1_000
  })
  const commands = api.commands.createProjectWorkspaceCommandService(store, {
    rootDir: payload.userData
  })
  await commands.reconcileShadowProjection()
  const goal = await commands.createGoal({
    id: GOAL_ID,
    projectId: project.id,
    title: 'Recover one canonical domain chain',
    objective: 'Preserve ownership while reconciling an unknown Effect',
    createdBy: HUMAN_OWNER_ID,
    status: 'running',
    createdAt: 1_010,
    updatedAt: 1_010
  })
  let workItem = await commands.createWorkItem({
    id: WORK_ITEM_ID,
    projectId: project.id,
    goalId: goal.id,
    title: 'Strong-kill recovery fixture',
    type: 'testing',
    status: 'ready',
    owner: { type: 'human', id: HUMAN_OWNER_ID, displayName: 'Fixture owner' },
    createdAt: 1_020,
    updatedAt: 1_020
  })
  workItem = await commands.acquireWorkItemLease(workItem.id, {
    ownerId: HUMAN_OWNER_ID,
    expectedRevision: workItem.revision,
    durationMs: 60_000
  })
  workItem = await commands.transitionWorkItem(workItem.id, 'running', {
    expectedRevision: workItem.revision
  })

  let meta = {
    id: SESSION_ID,
    title: 'Domain restart parity session',
    cwd: payload.workspace,
    driveMode: 'core',
    engine: 'openai',
    model: 'synthetic-restart-model',
    providerId: 'synthetic-restart-provider',
    permissionMode: 'default',
    status: 'running',
    sdkSessionId: 'domain-restart-sdk-session',
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt: 1_030,
    childTaskId: RUN_ID,
    workspaceId: project.id,
    goalId: goal.id,
    workItemId: workItem.id
  }
  meta = await api.activation.prepareSessionIdentityForActivation(meta, payload.userData, false)

  const userEvent = {
    kind: 'user-message',
    messageId: 'domain-restart-user-message',
    text: 'Run the opaque fixture operation.'
  }
  const assistantEvent = {
    kind: 'assistant-message',
    blocks: [{
      type: 'tool_use',
      id: TOOL_USE_ID,
      name: 'bash',
      input: OPAQUE_TOOL_INPUT
    }]
  }
  let taskRun = api.taskRun.createTaskRun({
    id: RUN_ID,
    sessionId: SESSION_ID,
    taskId: RUN_ID,
    digitalWorkerBinding: meta.digitalWorkerBinding,
    now: 1_040
  })
  taskRun = api.taskExecution.reduceTaskExecutionEvent(taskRun, userEvent, payload.workspace, 1_050)
  taskRun = api.taskExecution.reduceTaskExecutionEvent(taskRun, assistantEvent, payload.workspace, 1_060)
  taskRun = api.taskRun.transitionTaskRun(taskRun, 'executing', {
    now: 1_061,
    lastEventKind: 'assistant-message'
  })
  assert.equal(taskRun.status, 'executing')
  api.registry.taskRuntimeRegistry.set(SESSION_ID, taskRun)

  const supervisor = new api.supervisor.SupervisorStateStore(payload.userData, {
    now: () => SUPERVISOR_BASE_NOW
  })
  const reserved = await api.bridge.reserveSupervisorRunForSend(meta, taskRun, {
    rootDir: payload.userData,
    store: supervisor,
    accountingBase: { usage: meta.usage, costUsd: meta.costUsd }
  })
  assert(reserved)
  assert.deepEqual((await store.getWorkItem(WORK_ITEM_ID)).runRefs, [])

  const snapshot = api.snapshot.buildTaskSnapshot({
    meta,
    transcript: [
      ledgerEntry(1, userEvent),
      ledgerEntry(2, assistantEvent)
    ],
    lastSeq: 2,
    lastEventId: 'domain-restart:2',
    lastEventKind: 'assistant-message',
    eventCount: 2,
    reason: 'important-event',
    run: taskRun,
    now: 1_070
  })
  const persistedSnapshot = await api.snapshot.saveTaskSnapshot(snapshot, payload.userData)
  api.registry.taskRuntimeRegistry.set(SESSION_ID, persistedSnapshot.run ?? taskRun)
  const binding = await api.bridge.ensureSupervisorRunBinding(meta, persistedSnapshot.run, {
    rootDir: payload.userData,
    store: supervisor
  })
  assert.equal(binding.disposition, 'attached')
  assert(binding.supervisorRun)

  const leased = await supervisor.acquireLease(RUN_ID, {
    ownerId: SUPERVISOR_OWNER_ID,
    expectedRevision: binding.supervisorRun.revision,
    ttlMs: SUPERVISOR_LEASE_TTL_MS,
    now: SUPERVISOR_BASE_NOW
  })
  const started = await supervisor.startRun(RUN_ID, {
    ownerId: SUPERVISOR_OWNER_ID,
    leaseId: leased.lease.id,
    fencingToken: leased.lease.fencingToken,
    expectedRevision: leased.revision,
    now: SUPERVISOR_BASE_NOW
  })
  assert.equal(started.status, 'running')

  const execution = {
    sessionId: SESSION_ID,
    cwd: payload.workspace,
    toolUseId: TOOL_USE_ID,
    toolName: 'bash',
    toolInput: OPAQUE_TOOL_INPUT
  }
  const handle = await api.effectRuntime.prepareEffectExecution(execution)
  assert(handle)
  assert.equal(handle.target.kind, 'unsupported')
  await api.effectRuntime.markEffectExecutionStarted(handle, execution)
  appendDurableLine(payload.executionLog, {
    processId: process.pid,
    runId: RUN_ID,
    effectId: handle.effectId,
    phase: 'executor_entered_before_unknown_result'
  })

  const state = await captureDomainState(api, payload, supervisor)
  assert.equal(state.effect.status, 'executing')
  assert.equal(state.supervisor.status, 'running')
  assert(state.supervisor.lease)
  assert.equal(state.executionCount, 1)
  process.send?.({ kind: 'domain-restart-barrier', state })
  await new Promise((resolve) => setTimeout(resolve, 60_000))
}

async function runRestartProbe(payload) {
  const api = await loadApi(payload.outDir)
  const supervisor = new api.supervisor.SupervisorStateStore(payload.userData, {
    now: () => SUPERVISOR_RESTART_NOW
  })
  const before = await captureDomainState(api, payload, supervisor)
  const oldLease = before.supervisor.lease
  assert(oldLease)
  const beforeSnapshot = await api.snapshot.getTaskSnapshot(SESSION_ID, payload.userData)
  assert(beforeSnapshot?.run)
  const beforeClassification = api.bridge.classifySupervisorRestart({
    supervisor: before.supervisor,
    taskRun: beforeSnapshot.run
  })

  const firstRecoveryError = await expectRecoveryBarrier(api, beforeSnapshot, payload.userData)
  const firstReconciled = await api.snapshot.getTaskSnapshot(SESSION_ID, payload.userData)
  assert(firstReconciled?.run)
  const firstLeaseRecovery = await supervisor.recoverExpiredLeases(SUPERVISOR_RESTART_NOW)
  const firstBindingRecovery = await api.bridge.recoverSupervisorRunBindings(
    [firstReconciled],
    { rootDir: payload.userData, store: supervisor }
  )
  assert.equal(firstBindingRecovery.failures.length, 0)
  const firstSupervisor = await supervisor.getRun(RUN_ID)
  assert(firstSupervisor)
  const delayedObservation = await supervisor.observeRun(RUN_ID, {
    taskRunStatus: 'failed',
    sourceEventId: 'domain-restart-delayed-observation',
    observedAt: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    costUsd: 0
  })
  const delayedEvents = await supervisor.listEvents(RUN_ID)
  const delayedEvent = delayedEvents.at(-1)
  assert.equal(delayedObservation.revision, firstSupervisor.revision)
  assert.equal(delayedObservation.status, firstSupervisor.status)
  assert.equal(delayedEvent?.payload?.sourceEventId, 'domain-restart-delayed-observation')
  assert.equal(delayedEvent?.payload?.outOfOrder, true)
  assert.equal(delayedEvent?.payload?.ignored, true)
  const afterClassification = api.bridge.classifySupervisorRestart({
    supervisor: firstSupervisor,
    taskRun: firstReconciled.run
  })
  const duplicateDecision = api.registry.taskRuntimeRegistry.evaluateTool({
    sessionId: SESSION_ID,
    cwd: payload.workspace,
    toolName: 'bash',
    toolInput: OPAQUE_TOOL_INPUT,
    toolUseId: 'domain-restart-automatic-replay-probe'
  }).kind
  const oldLeaseRejection = await rejectedSupervisorLease(supervisor, firstSupervisor, oldLease)
  const first = await captureDomainState(api, payload, supervisor)
  const firstPersistedDomain = await capturePersistedDomain(api, payload, supervisor)

  const secondSnapshot = await api.snapshot.getTaskSnapshot(SESSION_ID, payload.userData)
  assert(secondSnapshot?.run)
  const secondRecoveryError = await expectRecoveryBarrier(api, secondSnapshot, payload.userData)
  const secondReconciled = await api.snapshot.getTaskSnapshot(SESSION_ID, payload.userData)
  assert(secondReconciled?.run)
  const secondLeaseRecovery = await supervisor.recoverExpiredLeases(SUPERVISOR_RESTART_NOW)
  const secondBindingRecovery = await api.bridge.recoverSupervisorRunBindings(
    [secondReconciled],
    { rootDir: payload.userData, store: supervisor }
  )
  assert.equal(secondBindingRecovery.failures.length, 0)
  const secondSupervisor = await supervisor.getRun(RUN_ID)
  assert(secondSupervisor)
  const secondClassification = api.bridge.classifySupervisorRestart({
    supervisor: secondSupervisor,
    taskRun: secondReconciled.run
  })
  const secondDuplicateDecision = api.registry.taskRuntimeRegistry.evaluateTool({
    sessionId: SESSION_ID,
    cwd: payload.workspace,
    toolName: 'bash',
    toolInput: OPAQUE_TOOL_INPUT,
    toolUseId: 'domain-restart-second-automatic-replay-probe'
  }).kind
  const second = await captureDomainState(api, payload, supervisor)
  const secondPersistedDomain = await capturePersistedDomain(api, payload, supervisor)
  assert.deepEqual(secondPersistedDomain, firstPersistedDomain)

  process.stdout.write(`DOMAIN_RESTART_RESULT:${JSON.stringify({
    before,
    first,
    second,
    beforeClassification,
    afterClassification,
    secondClassification,
    firstRecoveryError,
    secondRecoveryError,
    firstLeaseRecovery,
    secondLeaseRecovery,
    firstBindingRecovery,
    secondBindingRecovery,
    oldLeaseRejection,
    delayedObservation: {
      status: delayedObservation.status,
      revision: delayedObservation.revision,
      observedAt: delayedEvent?.occurredAt,
      ignored: delayedEvent?.payload?.ignored
    },
    duplicateDecision,
    secondDuplicateDecision,
    fullPersistedStateIdempotent: true
  })}\n`)
}

async function expectRecoveryBarrier(api, snapshot, rootDir) {
  let caught
  try {
    await api.recovery.prepareTaskSnapshotRecovery(snapshot, rootDir, () => false)
  } catch (error) {
    caught = error
  }
  if (!caught) throw new Error('TaskSnapshot recovery unexpectedly authorized automatic resume')
  const serialized = serializeError(caught)
  if (!serialized.message.includes('waiting_reconciliation')) {
    throw new Error(`TaskSnapshot recovery failed for an unexpected reason: ${serialized.message}`)
  }
  return {
    name: serialized.name,
    message: serialized.message,
    code: serialized.code
  }
}

async function rejectedSupervisorLease(supervisor, current, oldLease) {
  try {
    await supervisor.heartbeatLease(RUN_ID, {
      ownerId: oldLease.ownerId,
      leaseId: oldLease.id,
      fencingToken: oldLease.fencingToken,
      expectedRevision: current.revision,
      ttlMs: SUPERVISOR_LEASE_TTL_MS,
      now: SUPERVISOR_RESTART_NOW
    })
  } catch (error) {
    const serialized = serializeError(error)
    if (serialized.code !== 'lease_expired') {
      throw new Error(`expired Supervisor lease returned ${serialized.code ?? serialized.message}`)
    }
    return serialized
  }
  throw new Error('expired Supervisor lease heartbeat unexpectedly succeeded')
}

async function captureDomainState(api, payload, supervisor) {
  const workspaceStore = await new api.workspace.ProjectWorkspaceStore(payload.userData).open()
  const [project, goal, workItem, snapshot, supervisorRun, supervisorDocument] = await Promise.all([
    workspaceStore.getWorkspace(PROJECT_ID),
    workspaceStore.getGoal(GOAL_ID),
    workspaceStore.getWorkItem(WORK_ITEM_ID),
    api.snapshot.getTaskSnapshot(SESSION_ID, payload.userData),
    supervisor.getRun(RUN_ID),
    supervisor.read()
  ])
  assert(project)
  assert(goal)
  assert(workItem)
  assert(snapshot?.run)
  assert(supervisorRun)
  const effect = snapshot.run.effects?.find((candidate) => candidate.toolUseId === TOOL_USE_ID)
  const toolExecution = snapshot.run.toolExecutions?.find((candidate) => candidate.toolUseId === TOOL_USE_ID)
  assert(effect)
  assert(toolExecution)
  const supervisorEvents = supervisorDocument.events.filter((event) => event.runId === RUN_ID)
  return {
    workspaceStoreRevision: await workspaceStore.getRevision(),
    project: {
      id: project.id,
      revision: project.revision,
      ownerId: project.ownerId ?? null,
      status: project.status
    },
    goal: {
      id: goal.id,
      projectId: goal.projectId,
      revision: goal.revision,
      createdBy: goal.createdBy ?? null,
      status: goal.status
    },
    workItem: {
      id: workItem.id,
      projectId: workItem.projectId,
      goalId: workItem.goalId ?? null,
      revision: workItem.revision,
      owner: workItem.owner ? structuredClone(workItem.owner) : null,
      status: workItem.status,
      lease: workItem.lease ? structuredClone(workItem.lease) : null,
      runRefs: [...workItem.runRefs]
    },
    snapshot: {
      id: snapshot.id,
      sessionId: snapshot.sessionId,
      workspaceId: snapshot.meta.workspaceId ?? null,
      goalId: snapshot.meta.goalId ?? null,
      workItemId: snapshot.meta.workItemId ?? null,
      digitalWorkerBinding: structuredClone(snapshot.meta.digitalWorkerBinding ?? null)
    },
    taskRun: {
      id: snapshot.run.id,
      sessionId: snapshot.run.sessionId,
      taskId: snapshot.run.taskId,
      revision: snapshot.run.revision,
      status: snapshot.run.status,
      digitalWorkerBinding: structuredClone(snapshot.run.digitalWorkerBinding ?? null),
      effectIds: (snapshot.run.effects ?? []).map((candidate) => candidate.id)
    },
    effect: {
      id: effect.id,
      runId: effect.runId,
      sessionId: effect.sessionId,
      revision: effect.revision,
      generation: effect.generation,
      status: effect.status,
      targetKind: effect.target.kind,
      reconcilability: effect.reconcilability,
      lease: effect.lease ? structuredClone(effect.lease) : null,
      evidenceKinds: effect.evidence.map((item) => item.kind),
      reconciliationEvidenceCount: effect.evidence.filter((item) => item.kind === 'reconciliation').length,
      retryEvidenceCount: effect.evidence.filter((item) => item.kind === 'retry_authorized').length
    },
    toolExecution: {
      id: toolExecution.id,
      runId: toolExecution.runId,
      sessionId: toolExecution.sessionId,
      effectId: toolExecution.effectId ?? null,
      status: toolExecution.status,
      effectStatus: toolExecution.effectStatus ?? null
    },
    supervisor: {
      id: supervisorRun.id,
      projectId: supervisorRun.projectId,
      goalId: supervisorRun.goalId ?? null,
      workItemId: supervisorRun.workItemId,
      revision: supervisorRun.revision,
      status: supervisorRun.status,
      fencingToken: supervisorRun.fencingToken,
      lease: supervisorRun.lease ? structuredClone(supervisorRun.lease) : null
    },
    supervisorStore: {
      revision: supervisorDocument.revision,
      eventCount: supervisorEvents.length
    },
    supervisorEventKinds: supervisorEvents.map((event) => event.kind),
    executionCount: countLines(payload.executionLog)
  }
}

async function capturePersistedDomain(api, payload, supervisor) {
  const workspaceStore = await new api.workspace.ProjectWorkspaceStore(payload.userData).open()
  const [workspaceState, snapshot, taskRuns, supervisorDocument] = await Promise.all([
    workspaceStore.getState(),
    api.snapshot.getTaskSnapshot(SESSION_ID, payload.userData),
    api.snapshot.listTaskRuns(undefined, payload.userData),
    supervisor.read()
  ])
  return {
    workspaceState,
    snapshot,
    taskRuns,
    supervisorDocument,
    executionLog: existsSync(payload.executionLog)
      ? readFileSync(payload.executionLog, 'utf8')
      : ''
  }
}

function assertCanonicalOwnershipStable(before, after) {
  assert.deepEqual(after.project, before.project)
  assert.deepEqual(after.goal, before.goal)
  assert.deepEqual(after.workItem, before.workItem)
  assert.equal(after.workspaceStoreRevision, before.workspaceStoreRevision)
  assert.equal(after.snapshot.id, before.snapshot.id)
  assert.equal(after.snapshot.sessionId, before.snapshot.sessionId)
  assert.equal(after.snapshot.workspaceId, PROJECT_ID)
  assert.equal(after.snapshot.goalId, GOAL_ID)
  assert.equal(after.snapshot.workItemId, WORK_ITEM_ID)
  assert.deepEqual(after.snapshot.digitalWorkerBinding, before.snapshot.digitalWorkerBinding)
  assert.equal(after.taskRun.id, before.taskRun.id)
  assert.equal(after.taskRun.sessionId, before.taskRun.sessionId)
  assert.equal(after.taskRun.taskId, before.taskRun.taskId)
  assert.deepEqual(after.taskRun.digitalWorkerBinding, before.taskRun.digitalWorkerBinding)
  assert.deepEqual(after.taskRun.effectIds, before.taskRun.effectIds)
  assert.equal(after.effect.id, before.effect.id)
  assert.equal(after.effect.runId, before.effect.runId)
  assert.equal(after.effect.sessionId, before.effect.sessionId)
  assert.equal(after.supervisor.id, before.supervisor.id)
  assert.equal(after.supervisor.projectId, before.supervisor.projectId)
  assert.equal(after.supervisor.goalId, before.supervisor.goalId)
  assert.equal(after.supervisor.workItemId, before.supervisor.workItemId)
}

function runHardKill(payload) {
  return new Promise((resolve, reject) => {
    const child = fork(scriptPath, ['--crash-worker', encodePayload(payload)], {
      cwd: repoRoot,
      env: workerEnv(payload),
      execArgv: [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
    let barrier
    let killRequested = false
    let settled = false
    let stdout = ''
    let stderr = ''
    const finish = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback()
    }
    const timer = setTimeout(() => {
      if (!killRequested) child.kill('SIGKILL')
      finish(() => reject(new Error(`domain restart crash worker timed out\n${stdout}\n${stderr}`)))
    }, 30_000)
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.once('error', (error) => finish(() => reject(error)))
    child.on('message', (message) => {
      if (settled || barrier || message?.kind !== 'domain-restart-barrier') return
      barrier = message
      killRequested = true
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' })
      } else if (!child.kill('SIGKILL')) {
        finish(() => reject(new Error(`failed to SIGKILL domain restart worker ${child.pid}`)))
      }
    })
    child.once('exit', (code, signal) => {
      if (settled) return
      if (!barrier || !killRequested) {
        finish(() => reject(new Error(
          `domain restart worker exited before durable barrier (${code}/${signal})\n${stdout}\n${stderr}`
        )))
        return
      }
      if (process.platform !== 'win32' && signal !== 'SIGKILL') {
        finish(() => reject(new Error(
          `domain restart worker was not SIGKILLed (${code}/${signal})\n${stdout}\n${stderr}`
        )))
        return
      }
      finish(() => resolve({ ...barrier, childExit: { code, signal } }))
    })
  })
}

function runRestartChild(payload) {
  const stdout = execFileSync(
    process.execPath,
    [scriptPath, '--restart-probe', encodePayload(payload)],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: workerEnv(payload),
      timeout: 30_000
    }
  )
  const marker = stdout.split('\n').find((line) => line.startsWith('DOMAIN_RESTART_RESULT:'))
  if (!marker) throw new Error(`domain restart probe did not emit a result marker:\n${stdout}`)
  return JSON.parse(marker.slice('DOMAIN_RESTART_RESULT:'.length))
}

function compileSources(outDir) {
  mkdirSync(outDir, { recursive: true })
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/project-workspace/store.ts',
    'src/main/project-workspace/command-service.ts',
    'src/main/session-domain-activation.ts',
    'src/main/task/supervisor-state.ts',
    'src/main/task/supervisor-taskrun-bridge.ts',
    'src/main/task/task-run.ts',
    'src/main/task/task-execution.ts',
    'src/main/task/task-snapshot.ts',
    'src/main/task/task-runtime-registry.ts',
    'src/main/task/effect-runtime.ts',
    'src/main/task/task-snapshot-recovery-lifecycle.ts',
    '--outDir', outDir,
    '--rootDir', 'src',
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop',
    '--strict'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installElectronStub(outDir) {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), `module.exports = {
  app: { getPath: () => process.env.CAOGEN_DOMAIN_RESTART_USER_DATA },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value) => Buffer.from(String(value), 'utf8'),
    decryptString: (value) => Buffer.from(value).toString('utf8')
  },
  powerSaveBlocker: {
    start: () => 1,
    stop: () => undefined,
    isStarted: () => false
  }
}\n`, 'utf8')
}

async function loadApi(outDir) {
  const imported = await Promise.all([
    importCompiled(outDir, 'main/project-workspace/store.js'),
    importCompiled(outDir, 'main/project-workspace/command-service.js'),
    importCompiled(outDir, 'main/session-domain-activation.js'),
    importCompiled(outDir, 'main/task/supervisor-state.js'),
    importCompiled(outDir, 'main/task/supervisor-taskrun-bridge.js'),
    importCompiled(outDir, 'main/task/task-run.js'),
    importCompiled(outDir, 'main/task/task-execution.js'),
    importCompiled(outDir, 'main/task/task-snapshot.js'),
    importCompiled(outDir, 'main/task/task-runtime-registry.js'),
    importCompiled(outDir, 'main/task/effect-runtime.js'),
    importCompiled(outDir, 'main/task/task-snapshot-recovery-lifecycle.js')
  ])
  const [
    workspace,
    commands,
    activation,
    supervisor,
    bridge,
    taskRun,
    taskExecution,
    snapshot,
    registry,
    effectRuntime,
    recovery
  ] = imported
  return {
    workspace,
    commands,
    activation,
    supervisor,
    bridge,
    taskRun,
    taskExecution,
    snapshot,
    registry,
    effectRuntime,
    recovery
  }
}

function importCompiled(outDir, relativePath) {
  return import(pathToFileURL(path.join(outDir, relativePath)).href)
}

function configureWorkerEnvironment(payload) {
  process.env.CAOGEN_DOMAIN_RESTART_USER_DATA = payload.userData
  process.env.NODE_PATH = [path.join(payload.repoRoot, 'node_modules'), process.env.NODE_PATH]
    .filter(Boolean)
    .join(path.delimiter)
  const require = createRequire(import.meta.url)
  require('node:module').Module._initPaths()
}

function workerEnv(payload) {
  return {
    ...process.env,
    CAOGEN_DOMAIN_RESTART_USER_DATA: payload.userData,
    NODE_PATH: [path.join(payload.repoRoot, 'node_modules'), process.env.NODE_PATH]
      .filter(Boolean)
      .join(path.delimiter)
  }
}

function ledgerEntry(seq, event) {
  return {
    schemaVersion: 1,
    streamId: 'domain-restart-stream',
    eventId: `domain-restart:${seq}`,
    seq,
    occurredAt: 1_040 + seq,
    event
  }
}

function appendDurableLine(filePath, value) {
  const descriptor = openSync(filePath, 'a', 0o600)
  try {
    writeSync(descriptor, `${JSON.stringify(value)}\n`, null, 'utf8')
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function countLines(filePath) {
  if (!existsSync(filePath)) return 0
  return readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).length
}

function check(report, id, evidence) {
  report.checks.push({ id, status: 'passed', evidence })
}

function gitOutput(args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function encodePayload(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodePayload(value) {
  if (!value) throw new Error('domain restart worker payload is required')
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
}

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    code: error && typeof error === 'object' && 'code' in error ? error.code : undefined,
    stack: error instanceof Error ? error.stack : undefined
  }
}
