#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const startedAt = new Date().toISOString()
const runId = startedAt.replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'supervisor-session-control-smoke')
const reportDir = path.join(reportRoot, runId)
const reportPath = path.join(reportDir, 'report.json')
const latestPath = path.join(reportRoot, 'latest.json')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-supervisor-session-control-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
const projectDir = path.join(tempRoot, 'project')
const require = createRequire(import.meta.url)
process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter)
require('node:module').Module._initPaths()

mkdirSync(userData, { recursive: true })
mkdirSync(projectDir, { recursive: true })
writeFileSync(
  path.join(userData, 'providers.json'),
  JSON.stringify([{
    id: 'supervisor-control-provider',
    name: 'Supervisor control fixture',
    baseUrl: 'http://unused.invalid',
    encryptedToken: `b64:${Buffer.from('wrong-token').toString('base64')}`,
    models: ['fixture-model'],
    createdAt: 1
  }]),
  'utf8'
)
writeFileSync(
  path.join(userData, 'projects.json'),
  JSON.stringify([{
    id: 'control-project', name: 'Control Project', path: projectDir, lastUsedAt: 1
  }]),
  'utf8'
)

const electronStub = {
  app: { getPath: () => userData, isPackaged: false, focus() {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    decryptString: () => ''
  },
  BrowserWindow: { getAllWindows: () => [] },
  powerSaveBlocker: { start: () => 1, stop() {}, isStarted: () => false },
  Notification: class {
    static isSupported() { return false }
    once() {}
    show() {}
  }
}

const originalLoad = require('node:module').Module._load
let smokeResult
let failure

try {
  compileSources()
  require('node:module').Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electronStub
    return originalLoad.call(this, request, parent, isMain)
  }

  const managerModulePath = findCompiledModule(outDir, 'sessionManager.js')
  const managerModule = require(managerModulePath)
  const engineModule = require(findCompiledModule(outDir, 'engine.js'))
  const workspaceModule = require(findCompiledModule(outDir, 'store.js', 'project-workspace'))
  const commandModule = require(findCompiledModule(outDir, 'command-service.js', 'project-workspace'))
  const supervisorModule = require(findCompiledModule(outDir, 'supervisor-state.js'))
  const snapshotModule = require(findCompiledModule(outDir, 'task-snapshot.js'))

  const controls = new Map()
  engineModule.registerEngine(controlledEngineFactory(controls))

  const workspaceStore = await new workspaceModule.ProjectWorkspaceStore(userData).open()
  const project = await workspaceStore.createWorkspace({
    id: 'control-project', name: 'Control Project', kind: 'software'
  })
  const goal = await workspaceStore.createGoal({
    id: 'control-goal', projectId: project.id, title: 'Control Goal', objective: 'Control canonical runs'
  })
  const commands = commandModule.createProjectWorkspaceCommandService(workspaceStore, { rootDir: userData })
  const supervisor = new supervisorModule.SupervisorStateStore(userData)
  let manager = managerModule.sessionManager

  const first = await createCanonicalSession('lifecycle')
  const firstControl = controls.get(first.meta.id)
  const firstStarted = await startSupervisorRun(first.run.id, 'worker-a')
  const paused = await manager.controlSupervisorRun(supervisor, {
    action: 'pause', runId: first.run.id, options: leaseOptions(firstStarted)
  })
  assert.equal(paused.effect, 'cooperative_interrupt')
  assert.equal(paused.supervisorRun.status, 'paused')
  assert.equal(firstControl.interruptCount, 1)
  assert.equal(manager.taskRuns.get(first.meta.id).id, first.run.id)
  assert.equal(manager.taskRuns.get(first.meta.id).status, 'recovering')

  const sendsWhilePaused = firstControl.sendCount
  assert.equal(manager.send(first.meta.id, 'must not bypass Supervisor pause'), false)
  assert.equal(firstControl.sendCount, sendsWhilePaused)

  const resumeLease = await supervisor.acquireLease(first.run.id, {
    ownerId: 'worker-b', expectedRevision: paused.supervisorRun.revision, ttlMs: 30_000
  })
  const resumed = await manager.controlSupervisorRun(supervisor, {
    action: 'resume', runId: first.run.id, options: leaseOptions(resumeLease)
  })
  assert.equal(resumed.effect, 'replay_dispatched')
  assert.equal(resumed.supervisorRun.status, 'running')
  assert.equal(firstControl.sendCount, sendsWhilePaused + 1)
  assert.equal(manager.taskRuns.get(first.meta.id).id, first.run.id)

  const reassigned = await manager.controlSupervisorRun(supervisor, {
    action: 'reassign',
    runId: first.run.id,
    newOwnerId: 'worker-c',
    options: leaseOptions(resumed.supervisorRun)
  })
  assert.equal(reassigned.effect, 'lease_reassigned')
  assert.equal(reassigned.supervisorRun.lease.ownerId, 'worker-c')
  assert(firstControl.events.some((event) =>
    event.kind === 'hook-event' && event.event === 'supervisor-lease-reassigned'))

  const cancelled = await manager.controlSupervisorRun(supervisor, {
    action: 'cancel',
    runId: first.run.id,
    options: { expectedRevision: reassigned.supervisorRun.revision }
  })
  assert.equal(cancelled.effect, 'cooperative_interrupt')
  assert.equal(cancelled.supervisorRun.status, 'cancelled')
  assert.equal(manager.taskRuns.get(first.meta.id).status, 'cancelled')
  assert.equal(firstControl.interruptCount, 2)

  const second = await createCanonicalSession('retry')
  const secondControl = controls.get(second.meta.id)
  const secondStarted = await startSupervisorRun(second.run.id, 'retry-worker')
  secondControl.fail('fixture provider failure')
  await waitFor(
    () => manager.taskRuns.get(second.meta.id)?.status === 'failed',
    2_000,
    'failed TaskRun projection'
  )
  await snapshotModule.flushTaskSnapshotMutations(userData)
  const failedSupervisor = await supervisor.failRun(
    second.run.id,
    'fixture provider failure',
    leaseOptions(secondStarted)
  )

  const retried = await manager.controlSupervisorRun(supervisor, {
    action: 'retry',
    runId: second.run.id,
    options: { expectedRevision: failedSupervisor.revision }
  })
  assert.equal(retried.effect, 'retry_prepared')
  assert.equal(retried.supervisorRun.status, 'queued')
  assert.equal(manager.taskRuns.get(second.meta.id).id, second.run.id)
  assert.equal(manager.taskRuns.get(second.meta.id).status, 'recovering')

  const sendsBeforeRetryResume = secondControl.sendCount
  assert.equal(manager.send(second.meta.id, 'must wait for retry resume'), false)
  assert.equal(secondControl.sendCount, sendsBeforeRetryResume)

  const retryLease = await supervisor.acquireLease(second.run.id, {
    ownerId: 'retry-worker-2', expectedRevision: retried.supervisorRun.revision, ttlMs: 30_000
  })
  const retryResumed = await manager.controlSupervisorRun(supervisor, {
    action: 'resume', runId: second.run.id, options: leaseOptions(retryLease)
  })
  assert.equal(retryResumed.supervisorRun.status, 'running')
  assert.equal(manager.taskRuns.get(second.meta.id).id, second.run.id)
  assert.equal(secondControl.sendCount, sendsBeforeRetryResume + 1)

  const originalWorkItemId = manager.get(second.meta.id).meta.workItemId
  manager.get(second.meta.id).meta.workItemId = 'forged-work-item'
  const beforeConflict = await supervisor.read()
  const interruptsBeforeConflict = secondControl.interruptCount
  await assert.rejects(
    manager.controlSupervisorRun(supervisor, {
      action: 'cancel',
      runId: second.run.id,
      options: { expectedRevision: retryResumed.supervisorRun.revision }
    }),
    /canonical WorkItem ownership does not match/
  )
  assert.equal((await supervisor.read()).revision, beforeConflict.revision)
  assert.equal(secondControl.interruptCount, interruptsBeforeConflict)
  manager.get(second.meta.id).meta.workItemId = originalWorkItemId

  const secondCancelled = await manager.controlSupervisorRun(supervisor, {
    action: 'cancel',
    runId: second.run.id,
    options: { expectedRevision: retryResumed.supervisorRun.revision }
  })
  assert.equal(secondCancelled.supervisorRun.status, 'cancelled')

  const stale = await createCanonicalSession('stale-pause')
  const staleControl = controls.get(stale.meta.id)
  const staleStarted = await startSupervisorRun(stale.run.id, 'stale-worker')
  await assert.rejects(
    manager.controlSupervisorRun(supervisor, {
      action: 'pause',
      runId: stale.run.id,
      options: { ownerId: staleStarted.lease.ownerId, expectedRevision: staleStarted.revision }
    }),
    (error) => error?.code === 'invalid_input' && /leaseId and fencingToken/.test(error.message)
  )
  assert.equal(staleControl.interruptCount, 0)
  const originalPauseRun = supervisor.pauseRun.bind(supervisor)
  supervisor.pauseRun = async (id, options) => {
    const current = await supervisor.getRun(id)
    await supervisor.heartbeatLease(id, {
      ...leaseOptions(current),
      ttlMs: 30_000
    })
    return originalPauseRun(id, options)
  }
  await assert.rejects(
    manager.controlSupervisorRun(supervisor, {
      action: 'pause', runId: stale.run.id, options: leaseOptions(staleStarted)
    }),
    (error) => error?.code === 'stale_revision'
  )
  supervisor.pauseRun = originalPauseRun
  assert.equal(staleControl.interruptCount, 0)
  const staleRevisionPreventedRuntimeAction = staleControl.interruptCount === 0
  assert.equal((await supervisor.getRun(stale.run.id)).status, 'running')
  assert.notEqual(manager.taskRuns.get(stale.meta.id).status, 'recovering')
  const staleCurrent = await supervisor.getRun(stale.run.id)
  await manager.controlSupervisorRun(supervisor, {
    action: 'cancel', runId: stale.run.id, options: { expectedRevision: staleCurrent.revision }
  })

  const retryPreflight = await createCanonicalSession('retry-preflight')
  const retryPreflightControl = controls.get(retryPreflight.meta.id)
  const retryPreflightStarted = await startSupervisorRun(retryPreflight.run.id, 'retry-preflight-worker')
  retryPreflightControl.fail('fixture retry preflight failure')
  await waitFor(
    () => manager.taskRuns.get(retryPreflight.meta.id)?.status === 'failed',
    2_000,
    'retry preflight failed TaskRun projection'
  )
  await snapshotModule.flushTaskSnapshotMutations(userData)
  const retryPreflightFailed = await supervisor.failRun(
    retryPreflight.run.id,
    'fixture retry preflight failure',
    leaseOptions(retryPreflightStarted)
  )
  await assert.rejects(
    manager.controlSupervisorRun(supervisor, {
      action: 'retry', runId: retryPreflight.run.id, options: {}
    }),
    (error) => error?.code === 'invalid_input' && /expectedRevision/.test(error.message)
  )
  await snapshotModule.deleteTaskSnapshot(retryPreflight.meta.id)
  await assert.rejects(
    manager.controlSupervisorRun(supervisor, {
      action: 'retry',
      runId: retryPreflight.run.id,
      options: { expectedRevision: retryPreflightFailed.revision }
    }),
    /no matching canonical recovery snapshot/
  )
  const retryAfterMissingSnapshot = await supervisor.getRun(retryPreflight.run.id)
  assert.equal(retryAfterMissingSnapshot.status, 'failed')
  assert.equal(retryAfterMissingSnapshot.revision, retryPreflightFailed.revision)
  assert.equal(retryAfterMissingSnapshot.retryCount, retryPreflightFailed.retryCount)

  const resumeFailure = await createCanonicalSession('resume-failure')
  const resumeFailureControl = controls.get(resumeFailure.meta.id)
  const resumeFailureStarted = await startSupervisorRun(resumeFailure.run.id, 'resume-failure-worker')
  const resumeFailurePaused = await manager.controlSupervisorRun(supervisor, {
    action: 'pause', runId: resumeFailure.run.id, options: leaseOptions(resumeFailureStarted)
  })
  const resumeFailureLease = await supervisor.acquireLease(resumeFailure.run.id, {
    ownerId: 'resume-failure-worker-2',
    expectedRevision: resumeFailurePaused.supervisorRun.revision,
    ttlMs: 30_000
  })
  resumeFailureControl.failNextSend('fixture resume send failure')
  await assert.rejects(
    manager.controlSupervisorRun(supervisor, {
      action: 'resume', runId: resumeFailure.run.id, options: leaseOptions(resumeFailureLease)
    }),
    /fixture resume send failure/
  )
  const blockedAfterResumeFailure = await supervisor.getRun(resumeFailure.run.id)
  assert.equal(blockedAfterResumeFailure.status, 'blocked')
  const sendsAfterResumeFailure = resumeFailureControl.sendCount
  assert.equal(manager.send(resumeFailure.meta.id, 'must remain gated after failed resume'), false)
  assert.equal(resumeFailureControl.sendCount, sendsAfterResumeFailure)
  await manager.controlSupervisorRun(supervisor, {
    action: 'cancel',
    runId: resumeFailure.run.id,
    options: { expectedRevision: blockedAfterResumeFailure.revision }
  })

  const restartGate = await createCanonicalSession('restart-gate')
  const restartGateStarted = await startSupervisorRun(restartGate.run.id, 'restart-gate-worker')
  const restartGatePaused = await manager.controlSupervisorRun(supervisor, {
    action: 'pause', runId: restartGate.run.id, options: leaseOptions(restartGateStarted)
  })
  await manager.disposeAll()
  delete require.cache[managerModulePath]
  manager = require(managerModulePath).sessionManager
  await manager.recoverTaskSnapshot(restartGate.meta.id)
  await waitFor(() => manager.get(restartGate.meta.id)?.meta.sdkSessionId, 2_000, 'restart-gated recovery')
  const recoveredControl = controls.get(restartGate.meta.id)
  const sendsBeforeExplicitResume = recoveredControl.sendCount
  assert.equal(manager.send(restartGate.meta.id, 'must remain gated after process restart'), false)
  assert.equal(recoveredControl.sendCount, sendsBeforeExplicitResume)
  const restartGateLease = await supervisor.acquireLease(restartGate.run.id, {
    ownerId: 'restart-gate-worker-2',
    expectedRevision: restartGatePaused.supervisorRun.revision,
    ttlMs: 30_000
  })
  const restartGateResumed = await manager.controlSupervisorRun(supervisor, {
    action: 'resume', runId: restartGate.run.id, options: leaseOptions(restartGateLease)
  })
  assert.equal(restartGateResumed.supervisorRun.status, 'running')
  assert.equal(recoveredControl.sendCount, sendsBeforeExplicitResume + 1)
  await manager.controlSupervisorRun(supervisor, {
    action: 'cancel',
    runId: restartGate.run.id,
    options: { expectedRevision: restartGateResumed.supervisorRun.revision }
  })

  const legacy = await supervisor.createRun({
    id: 'coordination-only', projectId: 'legacy-project', workItemId: 'legacy-work'
  })
  const unbound = await manager.controlSupervisorRun(supervisor, {
    action: 'cancel', runId: legacy.id, options: { expectedRevision: legacy.revision }
  })
  assert.equal(unbound, null)
  assert.equal((await supervisor.getRun(legacy.id)).status, 'queued')

  smokeResult = {
    status: 'PASS',
    lifecycle: {
      runId: first.run.id,
      effects: [paused.effect, resumed.effect, reassigned.effect, cancelled.effect],
      interruptCount: firstControl.interruptCount,
      replayCount: firstControl.sendCount - 1
    },
    retry: {
      runId: second.run.id,
      identityPreserved: retried.taskRunId === second.run.id && retryResumed.taskRunId === second.run.id,
      effects: [retried.effect, retryResumed.effect],
      conflictFailedClosed: true
    },
    boundary: {
      coordinationOnlyFallbackRequired: unbound === null,
      cooperativeCancellationObserved: true,
      staleRevisionPreventedRuntimeAction,
      failedResumeBlockedAndGated: blockedAfterResumeFailure.status === 'blocked',
      strongLeaseFenceRequired: true,
      retrySnapshotPreflightPreservedState: retryAfterMissingSnapshot.status === 'failed',
      restartGateRequiredExplicitResume: true,
      providerCompletionClaimed: false
    }
  }
  console.log(JSON.stringify(smokeResult, null, 2))

  async function createCanonicalSession(suffix) {
    const workItem = await commands.createWorkItem({
      id: `control-work-${suffix}`,
      projectId: project.id,
      goalId: goal.id,
      title: `Control Work ${suffix}`
    })
    const meta = await manager.create({
      cwd: projectDir,
      isolated: false,
      engine: 'openai',
      providerId: 'supervisor-control-provider',
      model: 'fixture-model',
      permissionMode: 'bypassPermissions',
      title: `Supervisor ${suffix}`,
      projectId: project.id,
      workspaceId: project.id,
      goalId: goal.id,
      workItemId: workItem.id
    })
    await waitFor(() => manager.get(meta.id)?.meta.sdkSessionId, 2_000, `${suffix} session start`)
    assert(manager.send(meta.id, `execute ${suffix}`), `${suffix} initial send was rejected`)
    const run = manager.taskRuns.get(meta.id)
    assert(run, `${suffix} TaskRun was not created`)
    await waitFor(() => supervisor.getRun(run.id), 4_000, `${suffix} Supervisor binding`)
    return { meta, run, workItem }
  }

  async function startSupervisorRun(id, ownerId) {
    const queued = await supervisor.getRun(id)
    const lease = await supervisor.acquireLease(id, {
      ownerId, expectedRevision: queued.revision, ttlMs: 30_000
    })
    return supervisor.startRun(id, leaseOptions(lease))
  }
} catch (error) {
  failure = serializeError(error)
  throw error
} finally {
  require('node:module').Module._load = originalLoad
  rmSync(tempRoot, { recursive: true, force: true })
  writeReport({
    schemaVersion: 1,
    status: smokeResult ? 'passed' : 'failed',
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    gate: 'test:supervisor-session-control',
    result: smokeResult ?? null,
    error: failure,
    environment: { platform: process.platform, arch: process.arch, node: process.version }
  })
}

function controlledEngineFactory(controls) {
  return {
    kind: 'openai',
    label: 'Supervisor controlled fixture',
    available: () => true,
    create(meta, emit) {
      let seq = 0
      let sendCount = 0
      let nextSendError
      const transcript = []
      const events = []
      const push = (event) => {
        const entry = { seq: ++seq, event }
        events.push(event)
        transcript.push(entry)
        emit(event, entry.seq, entry)
      }
      const control = {
        events,
        get sendCount() { return sendCount },
        interruptCount: 0,
        failNextSend(message) {
          nextSendError = message
        },
        fail(message) {
          meta.status = 'error'
          push({ kind: 'turn-result', subtype: 'provider_error', isError: true, resultText: message })
          push({ kind: 'status', status: 'error', error: message })
        }
      }
      controls.set(meta.id, control)
      return {
        meta,
        async start() {
          meta.sdkSessionId = `supervisor-control-${meta.id}`
          meta.status = 'idle'
          push({ kind: 'init', sdkSessionId: meta.sdkSessionId, model: meta.model })
          push({ kind: 'status', status: 'idle' })
        },
        send(input) {
          if (nextSendError) {
            const message = nextSendError
            nextSendError = undefined
            throw new Error(message)
          }
          sendCount += 1
          const text = typeof input === 'string' ? input : input.text
          meta.status = 'running'
          push({ kind: 'user-message', messageId: `${meta.id}-message-${sendCount}`, text })
          push({ kind: 'status', status: 'running' })
        },
        rejectSend(message) {
          push({ kind: 'hook-event', event: 'send-rejected', detail: message })
        },
        async interrupt() {
          control.interruptCount += 1
          push({ kind: 'turn-result', subtype: 'cancelled', isError: true })
          meta.status = 'idle'
          push({ kind: 'status', status: 'idle' })
        },
        respondPermission() {},
        pendingPermissions: () => [],
        getTranscript: () => [...transcript],
        emitSyntheticEvent: push,
        async setPermissionMode(mode) { meta.permissionMode = mode },
        async setModel(model) { meta.model = model },
        rename(title) { meta.title = title },
        async dispose() {
          meta.status = 'closed'
          push({ kind: 'status', status: 'closed' })
        }
      }
    }
  }
}

function leaseOptions(run) {
  assert(run.lease, `Supervisor Run ${run.id} is missing its lease`)
  return {
    ownerId: run.lease.ownerId,
    leaseId: run.lease.id,
    fencingToken: run.lease.fencingToken,
    expectedRevision: run.revision
  }
}

function compileSources() {
  mkdirSync(outDir, { recursive: true })
  const compile = spawnSync(process.execPath, [
    path.join(repoRoot, 'node_modules/typescript/bin/tsc'),
    'src/main/sessionManager.ts',
    '--outDir', outDir,
    '--rootDir', 'src',
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, encoding: 'utf8' })
  if (compile.status !== 0 || !findCompiledModule(outDir, 'sessionManager.js')) {
    process.stderr.write(compile.stdout ?? '')
    process.stderr.write(compile.stderr ?? '')
    throw new Error('failed to compile Supervisor SessionManager control smoke')
  }
}

function findCompiledModule(root, name, parentName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledModule(fullPath, name, parentName)
      if (found) return found
    } else if (
      entry.isFile() &&
      entry.name === name &&
      (!parentName || path.basename(path.dirname(fullPath)) === parentName)
    ) {
      return fullPath
    }
  }
  return null
}

async function waitFor(producer, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await producer()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
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
    console.error(`Supervisor session control report could not be written: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    code: error && typeof error === 'object' && 'code' in error ? error.code : undefined
  }
}
