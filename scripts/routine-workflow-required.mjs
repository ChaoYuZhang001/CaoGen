import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const repoRoot = process.cwd()
const startedAt = new Date().toISOString()
const reportId = startedAt.replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'routine-workflow')
const reportDir = path.join(reportRoot, reportId)
const reportPath = path.join(reportDir, 'report.json')
const latestPath = path.join(reportRoot, 'latest.json')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-routine-workflow-'))
const outDir = path.join(tempRoot, 'compiled')
const workspaceRoot = path.join(tempRoot, 'user-data')
const routineRoot = path.join(workspaceRoot, 'routines')
const projectCwd = path.join(tempRoot, 'project')
const require = createRequire(import.meta.url)
const Module = require('node:module')
const originalLoad = Module._load

const PROJECT_ID = 'routine-required-project'
const GOAL_TEMPLATE_ID = 'routine-required-goal-template'
const ROUTINE_ID = 'routine-required-hourly-review'
const FIRST_DUE_AT = 1_800_000_000_000
const SECOND_DUE_AT = FIRST_DUE_AT + 7_200_000

process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
Module.Module._initPaths()
mkdirSync(projectCwd, { recursive: true })

let reportResult
let reportError

try {
  compileProductionSources()
  installElectronStub()
  const api = await loadProductionApi()
  const notifications = []
  const sessions = createDurableSessionBoundary(api)
  let lifecycle = loadRoutineLifecycle(api, sessions.manager, notifications)
  const executor = loadRoutineExecutor(api, sessions.manager, lifecycle, notifications)

  const workspaceStore = await new api.workspace.ProjectWorkspaceStore(workspaceRoot).open()
  await workspaceStore.createWorkspace({
    id: PROJECT_ID,
    name: 'Routine Required Project',
    kind: 'software',
    ownerId: 'local-user'
  })
  const commands = api.commands.createProjectWorkspaceCommandService(workspaceStore, { rootDir: workspaceRoot })
  await commands.reconcileShadowProjection()
  await commands.createGoal({
    id: GOAL_TEMPLATE_ID,
    projectId: PROJECT_ID,
    title: 'Produce an accepted routine report',
    status: 'draft',
    contract: {
      objective: 'Produce a durable routine result and route it through local acceptance.',
      constraints: ['Use the canonical Project workflow.'],
      successCriteria: ['A persisted report is available for review.'],
      riskLevel: 'medium',
      forbiddenActions: [],
      acceptance: [{ id: 'routine-report', criterion: 'The routine report is persisted and reviewable.', required: true }]
    }
  })
  await api.routineStore.createRoutine(routineRoot, {
    id: ROUTINE_ID,
    name: 'Hourly Project Review',
    prompt: 'Inspect the project and produce the scheduled review report.',
    projectId: PROJECT_ID,
    goalTemplateId: GOAL_TEMPLATE_ID,
    projectCwd,
    schedule: 'every 1h',
    permissionMode: 'default',
    notification: { enabled: true, onSuccess: true, onFailure: true },
    nextRunAt: FIRST_DUE_AT - 1
  })

  const first = await triggerDueAttempt(api, executor, FIRST_DUE_AT)
  assertEqual(first.status, 'running', 'first due attempt must remain active after prompt acceptance')
  assertEqual(first.dispatchState, 'prompt_accepted', 'first due attempt must persist prompt acceptance')
  assert(first.sessionId && first.workflowRunId && first.workItemId && first.goalId, 'first attempt must bind canonical identities')
  await failSessionTaskRun(api, sessions, first, 'planned provider failure')
  const firstFailed = await waitForRoutineRun(api, first.id, (run) => run.status === 'failed', 'first failure')
  assertEqual(firstFailed.inboxStatus, 'failed', 'failed attempt must enter Project Inbox failure state')
  assertIncludes(firstFailed.error, 'planned provider failure', 'failed attempt must preserve its cause')
  await assertCanonicalAttemptState(api, firstFailed, 'failed')
  await waitForNotification(notifications, 'Routine 失败: Hourly Project Review')

  await api.routineStore.updateRoutine(routineRoot, ROUTINE_ID, { nextRunAt: SECOND_DUE_AT - 1 })
  const second = await triggerDueAttempt(api, executor, SECOND_DUE_AT)
  assertEqual(second.status, 'running', 'retry attempt must remain active after prompt acceptance')
  assertEqual(second.dispatchState, 'prompt_accepted', 'retry attempt must persist prompt acceptance')
  assertDistinctAttemptIdentities(firstFailed, second)

  await requestPermission(api, sessions, second)
  const waitingApproval = await waitForRoutineRun(
    api,
    second.id,
    (run) => run.inboxStatus === 'waiting_approval',
    'permission request'
  )
  assertEqual(
    (await (await api.workspace.openProjectWorkspaceStore(workspaceRoot)).getWorkItem(waitingApproval.workItemId)).status,
    'waiting_approval',
    'permission request must project to the canonical WorkItem'
  )
  await resolvePermission(api, sessions, second)
  const resumed = await waitForRoutineRun(api, second.id, (run) => run.inboxStatus === 'running', 'permission resolution')
  assertEqual(
    (await (await api.workspace.openProjectWorkspaceStore(workspaceRoot)).getWorkItem(resumed.workItemId)).status,
    'running',
    'permission approval must resume the canonical WorkItem'
  )

  const beforeRestart = await durableIdentitySnapshot(api)
  lifecycle.disposeRoutineSessionLifecycle()
  await sessions.rehydrateFromDisk()
  lifecycle = loadRoutineLifecycle(api, sessions.manager, notifications)
  await lifecycle.reconcileRoutineRunsAtStartup(routineRoot, workspaceRoot)
  const afterRestart = await durableIdentitySnapshot(api)
  assertDeepEqual(afterRestart, beforeRestart, 'startup reconciliation must not duplicate durable identities')
  const bindingRecovery = await api.canonicalBinding.recoverWorkflowRunCanonicalBindings(
    await api.taskSnapshot.listTaskSnapshots(workspaceRoot),
    workspaceRoot
  )
  assertDeepEqual(bindingRecovery.failures, [], 'startup Run binding reconciliation must not fail')
  assertEqual(bindingRecovery.attached.length, 0, 'startup reconciliation must not attach duplicate Run identities')
  assert(bindingRecovery.existing.includes(firstFailed.workflowRunId), 'failed Run binding must survive restart')
  assert(bindingRecovery.existing.includes(second.workflowRunId), 'retry Run binding must survive restart')

  await completeSessionTaskRun(api, sessions, second, '# Scheduled review\n\nAll canonical checks completed.')
  const succeeded = await waitForRoutineRun(api, second.id, (run) => run.status === 'succeeded', 'result finalization')
  assertEqual(succeeded.inboxStatus, 'needs_review', 'successful Routine must enter Project Inbox review state')
  assert(succeeded.artifactId && succeeded.evidenceId, 'successful Routine must bind Artifact and Evidence')
  await waitForNotification(notifications, 'Routine 待验收: Hourly Project Review')
  const verifyingStore = await api.workspace.openProjectWorkspaceStore(workspaceRoot)
  assertEqual(
    (await verifyingStore.getWorkItem(succeeded.workItemId)).status,
    'verifying',
    'successful Routine must project a reviewable WorkItem into Project Inbox'
  )

  const reviewed = await api.review.reviewRoutineRun(
    routineRoot,
    workspaceRoot,
    succeeded.id,
    { decision: 'accept', note: 'Required gate accepted the persisted result.' }
  )
  assertEqual(reviewed.inboxStatus, 'accepted', 'review must close the Routine Inbox entry')
  assertEqual(reviewed.reviewDecision, 'accepted', 'review decision must be durable')
  const finalStore = await api.workspace.openProjectWorkspaceStore(workspaceRoot)
  const finalWorkItem = await finalStore.getWorkItem(reviewed.workItemId)
  const finalGoal = await finalStore.getGoal(reviewed.goalId)
  assertEqual(finalWorkItem.status, 'done', 'accepted Routine WorkItem must be done')
  assertEqual(finalGoal.status, 'completed', 'accepted Routine Goal must be completed')
  assertEqual(finalWorkItem.acceptance?.status, 'passed', 'WorkItem Acceptance must pass')
  assertEqual(finalGoal.acceptanceResult?.status, 'passed', 'Goal Acceptance must pass')
  assert(finalWorkItem.acceptance.evidenceRefs.includes(reviewed.evidenceId), 'WorkItem Acceptance must cite Routine Evidence')
  assert(finalGoal.acceptanceResult.evidenceRefs.includes(reviewed.evidenceId), 'Goal Acceptance must cite Routine Evidence')

  const history = await api.runner.listRoutineRuns(routineRoot, ROUTINE_ID)
  assertEqual(history.length, 2, 'failure plus retry must preserve exactly two Routine history records')
  assertEqual(new Set(history.map((run) => run.id)).size, 2, 'Routine history ids must remain unique')
  assertEqual(new Set(history.map((run) => run.sessionId)).size, 2, 'Session history ids must remain unique')
  assertEqual(new Set(history.map((run) => run.workflowRunId)).size, 2, 'TaskRun history ids must remain unique')
  assertEqual(new Set(history.map((run) => run.workItemId)).size, 2, 'WorkItem history ids must remain unique')

  const ledger = await api.workflow.listPersistedWorkflowLedger({ projectId: PROJECT_ID }, workspaceRoot)
  const workflowEvidence = await api.workflow.listWorkflowEvidence({ projectId: PROJECT_ID }, workspaceRoot)
  assert(ledger.runs.items.some((run) => run.id === firstFailed.workflowRunId), 'Workflow Ledger must retain failed TaskRun')
  assert(ledger.runs.items.some((run) => run.id === reviewed.workflowRunId), 'Workflow Ledger must retain successful TaskRun')
  assert(ledger.artifacts.items.some((artifact) => artifact.id === reviewed.artifactId), 'Workflow Ledger must retain Routine Artifact')
  assert(workflowEvidence.some((evidence) => evidence.evidenceId === reviewed.evidenceId), 'Workflow Ledger must retain Routine Evidence')
  const verification = await api.workflow.verifyPersistedWorkflowLedger(workspaceRoot)
  assertEqual(verification.valid, true, 'final Workflow Ledger integrity must verify')

  reportResult = {
    dueTriggers: 2,
    retry: { failedRunId: firstFailed.id, succeededRunId: reviewed.id },
    permission: { waitingApproval: true, resumed: true },
    restart: { identitiesReused: true, existingRunBindings: bindingRecovery.existing.length },
    notifications: notifications.map(({ title, sessionId }) => ({ title, sessionId })),
    history: {
      routineRuns: history.length,
      sessions: new Set(history.map((run) => run.sessionId)).size,
      taskRuns: new Set(history.map((run) => run.workflowRunId)).size,
      workItems: new Set(history.map((run) => run.workItemId)).size
    },
    canonical: {
      projectId: PROJECT_ID,
      goalId: reviewed.goalId,
      workItemId: reviewed.workItemId,
      workflowRunId: reviewed.workflowRunId,
      artifactId: reviewed.artifactId,
      evidenceId: reviewed.evidenceId,
      acceptance: finalWorkItem.acceptance?.status,
      inbox: reviewed.inboxStatus
    },
    ledger: {
      goals: ledger.goals.total,
      workItems: ledger.workItems.total,
      runs: ledger.runs.total,
      artifacts: ledger.artifacts.total,
      evidence: workflowEvidence.length,
      acceptances: ledger.acceptances.total,
      valid: verification.valid
    }
  }
  console.log('routine workflow required: PASS')
} catch (error) {
  reportError = serializeError(error)
  throw error
} finally {
  try { Module._load = originalLoad } catch {}
  try { rmSync(tempRoot, { recursive: true, force: true }) } catch {}
  writeReport({
    schemaVersion: 1,
    gate: 'test:routine-workflow:required',
    status: reportResult ? 'passed' : 'failed',
    startedAt,
    finishedAt: new Date().toISOString(),
    git: gitIdentity(),
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    result: reportResult ?? null,
    error: reportError ?? null
  })
}

async function loadProductionApi() {
  const load = async (fileName, suffix) => import(pathToFileURL(
    suffix ? findCompiledBySuffix(outDir, suffix) : findCompiled(outDir, fileName)
  ).href)
  return {
    scheduler: await load('routineScheduler.js'),
    routineStore: await load('routineStore.js'),
    runner: await load('routine-runner.js'),
    projectRuntime: await load('routine-project-runtime.js'),
    resultArtifact: await load('routine-result-artifact.js'),
    review: await load('routine-review.js'),
    personalOs: await load('personal-os.js'),
    workspace: await load(undefined, path.join('project-workspace', 'store.js')),
    commands: await load(undefined, path.join('project-workspace', 'command-service.js')),
    taskRun: await load('task-run.js'),
    taskSnapshot: await load('task-snapshot.js'),
    workflow: await load('workflow-ledger-api.js'),
    canonicalBinding: await load('workflow-run-canonical-binding.js')
  }
}

function createDurableSessionBoundary(api) {
  const listeners = new Set()
  const sessions = new Map()
  const taskRuns = new Map()
  let sequence = 0

  const manager = {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async createManaged(options, lifecycle = {}) {
      const id = `routine-required-session-${++sequence}`
      const meta = {
        id,
        title: options.title ?? `Routine Session ${sequence}`,
        cwd: options.cwd,
        projectId: options.workspaceId,
        workspaceId: options.workspaceId,
        goalId: options.goalId,
        workItemId: options.workItemId,
        childTaskId: `routine-required-task-${sequence}`,
        isolated: false,
        model: options.model ?? 'fixture-model',
        providerId: options.providerId ?? 'fixture-provider',
        engine: options.engine ?? 'openai',
        permissionMode: 'default',
        status: 'running',
        sdkSessionId: `sdk-${id}`,
        costUsd: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        contextTokens: 0,
        createdAt: Date.now()
      }
      await lifecycle.beforeStart?.(meta)
      sessions.set(id, { meta })
      return meta
    },
    async send(sessionId) {
      const session = sessions.get(sessionId)
      if (!session) return false
      let run = taskRuns.get(sessionId)
      if (!run) {
        run = api.taskRun.createTaskRun({
          id: `routine-required-run-${sequence}`,
          sessionId,
          taskId: session.meta.childTaskId,
          now: Date.now()
        })
        run = api.taskRun.transitionTaskRun(run, 'executing', { now: Date.now() })
        const snapshot = api.taskSnapshot.buildTaskSnapshot({
          meta: session.meta,
          transcript: [],
          lastSeq: 0,
          eventCount: 0,
          reason: 'created',
          run,
          now: Date.now()
        })
        await api.taskSnapshot.saveTaskSnapshot(snapshot, workspaceRoot)
        await api.canonicalBinding.bindWorkflowRunToCanonicalWorkItem(session.meta, run, workspaceRoot)
        taskRuns.set(sessionId, run)
      }
      return true
    },
    getTaskRun(sessionId) {
      const run = taskRuns.get(sessionId)
      return run ? structuredClone(run) : undefined
    },
    async persistTaskRunLifecycleBarrier(sessionId) {
      const run = taskRuns.get(sessionId)
      if (!run) return undefined
      const persisted = await api.taskSnapshot.saveTaskRunBarrier(run, workspaceRoot)
      taskRuns.set(sessionId, persisted)
      return structuredClone(persisted)
    },
    get(sessionId) {
      return sessions.get(sessionId)
    },
    async close(sessionId) {
      const session = sessions.get(sessionId)
      if (session) session.meta.status = 'closed'
    }
  }

  return {
    manager,
    getRun(sessionId) {
      return taskRuns.get(sessionId)
    },
    async setRun(sessionId, run) {
      const persisted = await api.taskSnapshot.saveTaskRunBarrier(run, workspaceRoot)
      taskRuns.set(sessionId, persisted)
      return persisted
    },
    emit(payload) {
      for (const listener of [...listeners]) listener(payload)
    },
    async rehydrateFromDisk() {
      sessions.clear()
      taskRuns.clear()
      listeners.clear()
      for (const snapshot of await api.taskSnapshot.listTaskSnapshots(workspaceRoot)) {
        sessions.set(snapshot.sessionId, { meta: structuredClone(snapshot.meta) })
        if (snapshot.run) taskRuns.set(snapshot.sessionId, structuredClone(snapshot.run))
      }
    }
  }
}

function loadRoutineLifecycle(api, sessionManager, notifications) {
  const modulePath = transpileProductionModule(
    'src/main/routines/routine-session-lifecycle.ts',
    path.join(tempRoot, 'routine-session-lifecycle.cjs')
  )
  return requireWithStubs(modulePath, new Map([
    ['../desktopNotify', { showDesktopNotification: (payload) => notifications.push(structuredClone(payload)) }],
    ['../routineStore', api.routineStore],
    ['../sessionManager', { sessionManager }],
    ['../settings', { getSettings: () => ({ notificationsEnabled: true, preventDisplaySleep: false }) }],
    ['./personal-os', api.personalOs],
    ['./routine-runner', api.runner],
    ['./routine-project-runtime', api.projectRuntime],
    ['./routine-result-artifact', api.resultArtifact]
  ]))
}

function loadRoutineExecutor(api, sessionManager, lifecycle, notifications) {
  const modulePath = transpileProductionModule(
    'src/main/routines/routine-executor.ts',
    path.join(tempRoot, 'routine-executor.cjs')
  )
  return requireWithStubs(modulePath, new Map([
    ['electron', { powerSaveBlocker: { start: () => 1, stop() {}, isStarted: () => false } }],
    ['../routineScheduler', api.scheduler],
    ['../desktopNotify', { showDesktopNotification: (payload) => notifications.push(structuredClone(payload)) }],
    ['../routineStore', api.routineStore],
    ['../sessionManager', { sessionManager }],
    ['../settings', { getSettings: () => ({ notificationsEnabled: true, preventDisplaySleep: false }) }],
    ['./personal-os', api.personalOs],
    ['./routine-runner', api.runner],
    ['./routine-project-runtime', api.projectRuntime],
    ['./routine-session-lifecycle', lifecycle]
  ]))
}

async function triggerDueAttempt(api, executor, now) {
  const attempt = new Promise((resolve, reject) => {
    api.scheduler.startRoutineScheduler({
      rootDir: routineRoot,
      intervalMs: 60_000,
      now: () => now,
      onTrigger: async (routine, nextRunAt) => {
        try {
          resolve(await executor.executeRoutine(routineRoot, routine, {
            nextRunAt,
            sendDelayMs: 0,
            workspaceRoot
          }))
        } catch (error) {
          reject(error)
        }
      }
    })
  })
  try {
    return await withTimeout(attempt, 15_000, 'due Routine was not dispatched')
  } finally {
    api.scheduler.stopRoutineScheduler()
  }
}

async function failSessionTaskRun(api, sessions, record, message) {
  const current = sessions.getRun(record.sessionId)
  assert(current, 'failed attempt TaskRun is missing')
  const failed = api.taskRun.transitionTaskRun(current, 'failed', {
    now: Date.now(),
    lastEventKind: 'status',
    error: message
  })
  await sessions.setRun(record.sessionId, failed)
  sessions.emit({ sessionId: record.sessionId, event: { kind: 'status', status: 'error', error: message } })
}

async function requestPermission(api, sessions, record) {
  const current = sessions.getRun(record.sessionId)
  assert(current, 'permission request TaskRun is missing')
  const waiting = api.taskRun.transitionTaskRun(current, 'waiting_approval', {
    now: Date.now(),
    lastEventKind: 'permission-request',
    pendingPermissionRequestId: 'routine-required-permission'
  })
  await sessions.setRun(record.sessionId, waiting)
  sessions.emit({
    sessionId: record.sessionId,
    event: {
      kind: 'permission-request',
      request: { requestId: 'routine-required-permission', toolName: 'Write', input: { path: 'report.md' } }
    }
  })
}

async function resolvePermission(api, sessions, record) {
  const current = sessions.getRun(record.sessionId)
  assert(current, 'permission resolution TaskRun is missing')
  const executing = api.taskRun.transitionTaskRun(current, 'executing', {
    now: Date.now(),
    lastEventKind: 'permission-resolved'
  })
  await sessions.setRun(record.sessionId, executing)
  sessions.emit({
    sessionId: record.sessionId,
    event: { kind: 'permission-resolved', requestId: 'routine-required-permission', behavior: 'allow' }
  })
}

async function completeSessionTaskRun(api, sessions, record, resultText) {
  const current = sessions.getRun(record.sessionId)
  assert(current, 'successful attempt TaskRun is missing')
  const completed = api.taskRun.transitionTaskRun(current, 'completed', {
    now: Date.now(),
    lastEventKind: 'turn-result'
  })
  await sessions.setRun(record.sessionId, completed)
  sessions.emit({
    sessionId: record.sessionId,
    event: { kind: 'turn-result', subtype: 'success', isError: false, resultText }
  })
}

async function assertCanonicalAttemptState(api, record, expectedStatus) {
  const store = await api.workspace.openProjectWorkspaceStore(workspaceRoot)
  assertEqual((await store.getWorkItem(record.workItemId)).status, expectedStatus, 'canonical WorkItem terminal state')
  assertEqual((await store.getGoal(record.goalId)).status, expectedStatus, 'canonical Goal terminal state')
}

function assertDistinctAttemptIdentities(first, second) {
  for (const field of ['id', 'sessionId', 'workflowRunId', 'goalId', 'workItemId']) {
    assert(first[field] && second[field] && first[field] !== second[field], `retry must allocate a distinct ${field}`)
  }
}

async function durableIdentitySnapshot(api) {
  const runs = await api.runner.listRoutineRuns(routineRoot, ROUTINE_ID)
  const snapshots = await api.taskSnapshot.listTaskSnapshots(workspaceRoot)
  const store = await api.workspace.openProjectWorkspaceStore(workspaceRoot)
  const state = await store.getState()
  return {
    routineRunIds: runs.map((run) => run.id).sort(),
    sessionIds: snapshots.map((snapshot) => snapshot.sessionId).sort(),
    taskRunIds: snapshots.flatMap((snapshot) => snapshot.run ? [snapshot.run.id] : []).sort(),
    goalIds: state.goals.filter((goal) => goal.createdBy === `routine:${ROUTINE_ID}`).map((goal) => goal.id).sort(),
    workItemIds: state.workItems.filter((item) => item.title === 'Routine: Hourly Project Review').map((item) => item.id).sort()
  }
}

async function waitForRoutineRun(api, runId, predicate, phase) {
  let lastSeen
  return withTimeout((async () => {
    while (true) {
      const run = (await api.runner.listRoutineRuns(routineRoot)).find((candidate) => candidate.id === runId)
      lastSeen = run
      if (run && predicate(run)) return run
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  })(), 15_000, () => `Routine Run ${runId} did not reach ${phase}; last state: ${JSON.stringify(lastSeen)}`)
}

async function waitForNotification(notifications, title) {
  return withTimeout((async () => {
    while (true) {
      const notification = notifications.find((entry) => entry.title === title)
      if (notification) return notification
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  })(), 15_000, `Routine notification was not emitted: ${title}`)
}

function withTimeout(promise, timeoutMs, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(typeof message === 'function' ? message() : message)), timeoutMs)
    })
  ]).finally(() => clearTimeout(timer))
}

function compileProductionSources() {
  const compiler = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')
  const result = spawnSync(process.execPath, [
    compiler,
    'src/main/routineScheduler.ts',
    'src/main/routineStore.ts',
    'src/main/routines/routine-runner.ts',
    'src/main/routines/routine-project-runtime.ts',
    'src/main/routines/routine-result-artifact.ts',
    'src/main/routines/routine-review.ts',
    'src/main/routines/personal-os.ts',
    'src/main/project-workspace/store.ts',
    'src/main/project-workspace/command-service.ts',
    'src/main/task/task-run.ts',
    'src/main/task/task-snapshot.ts',
    'src/main/task/workflow-ledger-api.ts',
    'src/main/task/workflow-run-canonical-binding.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop',
    '--strict'
  ], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (result.status !== 0) {
    const details = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
    throw new Error(`Routine workflow production source compilation failed\n${details}`)
  }
}

function installElectronStub() {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), [
    `export const app = { getPath: () => ${JSON.stringify(workspaceRoot)} }`,
    'export const BrowserWindow = { getAllWindows: () => [] }',
    'export const ipcMain = { handle() {} }',
    'export const powerSaveBlocker = { start: () => 1, stop() {}, isStarted: () => false }',
    'export const safeStorage = {',
    '  isEncryptionAvailable: () => false,',
    "  encryptString: (value) => Buffer.from(String(value), 'utf8'),",
    "  decryptString: (value) => Buffer.from(value).toString('utf8')",
    '}'
  ].join('\n') + '\n', 'utf8')
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n', 'utf8')
}

function transpileProductionModule(relativePath, outputPath) {
  const source = readFileSync(path.join(repoRoot, relativePath), 'utf8')
  const output = ts.transpileModule(source, {
    fileName: relativePath,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true
    }
  }).outputText
  writeFileSync(outputPath, output, 'utf8')
  return outputPath
}

function requireWithStubs(modulePath, stubs) {
  delete require.cache[require.resolve(modulePath)]
  Module._load = function loadWithStubs(request, parent, isMain) {
    if (stubs.has(request)) return stubs.get(request)
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    return require(modulePath)
  } finally {
    Module._load = originalLoad
  }
}

function findCompiled(root, fileName) {
  const found = findCompiledOptional(root, (fullPath, entry) => entry.name === fileName)
  if (!found) throw new Error(`compiled ${fileName} not found under ${root}`)
  return found
}

function findCompiledBySuffix(root, suffix) {
  const normalized = path.normalize(suffix)
  const found = findCompiledOptional(root, (fullPath) => path.normalize(fullPath).endsWith(normalized))
  if (!found) throw new Error(`compiled *${suffix} not found under ${root}`)
  return found
}

function findCompiledOptional(root, matches) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledOptional(fullPath, matches)
      if (found) return found
    } else if (entry.isFile() && matches(fullPath, entry)) {
      return fullPath
    }
  }
  return undefined
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
    console.error(`Routine workflow report could not be written: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function gitIdentity() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: repoRoot,
    encoding: 'utf8'
  }).trim()
  return {
    commit,
    worktreeClean: status === '',
    statusDigest: createHash('sha256').update(status).digest('hex')
  }
}

function serializeError(error) {
  const material = error instanceof Error ? error.stack ?? error.message : String(error)
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    fingerprint: createHash('sha256').update(material).digest('hex')
  }
}

function assertIncludes(actual, expected, message) {
  assert(typeof actual === 'string' && actual.includes(expected), `${message}: ${JSON.stringify(actual)}`)
}

function assertDeepEqual(actual, expected, message) {
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assert(value, message) {
  if (!value) throw new Error(message)
}
