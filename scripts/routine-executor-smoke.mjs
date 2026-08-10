import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ts from 'typescript'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-routine-executor-'))
const require = createRequire(import.meta.url)
const Module = require('node:module')
const originalLoad = Module._load
const calls = []
let acceptPrompt = true
let sessionSequence = 0

const sessionManager = {
  async createManaged(options) {
    const id = `routine-session-${++sessionSequence}`
    calls.push({ kind: 'create', id, options })
    return { id }
  },
  send(id, prompt) {
    calls.push({ kind: 'send', id, prompt })
    return acceptPrompt
  },
  async close(id) {
    calls.push({ kind: 'close', id })
  },
  getTaskRun() {
    return undefined
  }
}

const stubs = new Map([
  ['electron', {
    powerSaveBlocker: { start: () => 1, stop() {}, isStarted: () => false }
  }],
  ['../routineScheduler', { computeNextRun: () => null }],
  ['../desktopNotify', { showDesktopNotification() {} }],
  ['../routineStore', { listRoutines: async () => [] }],
  ['../sessionManager', { sessionManager }],
  ['../settings', { getSettings: () => ({ preventDisplaySleep: false, notificationsEnabled: false }) }],
  ['./personal-os', {
    buildRoutineRunNotification: () => null,
    runWithPersonalOsPowerBlocker: async (_options, task) => task()
  }],
  ['./routine-runner', {
    runRoutineWithHistory: async (_rootDir, routine, callback, nextRunAt) => {
      const base = {
        id: `run-${sessionSequence + 1}`,
        routineId: routine.id,
        routineName: routine.name,
        projectCwd: routine.projectCwd,
        startedAt: Date.now(),
        nextRunAt
      }
      try {
        const result = await callback(routine)
        return { ...base, status: 'succeeded', sessionId: result?.sessionId, finishedAt: Date.now() }
      } catch (error) {
        return {
          ...base,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          finishedAt: Date.now()
        }
      }
    },
    setRoutineRunDispatchState: async () => null,
    setRoutineRunExecutionBinding: async () => true,
    settleRoutineRun: async (_rootDir, runId, patch) => ({ id: runId, ...patch })
  }],
  ['./routine-project-runtime', {
    prepareRoutineProjectExecution: async (_workspaceRoot, routine) => ({
      projectId: 'routine-project',
      goalId: 'routine-goal',
      workItemId: 'routine-work-item',
      cwd: routine.projectCwd
    }),
    transitionRoutineGoal: async () => undefined,
    transitionRoutineWorkItem: async () => undefined
  }],
  ['./routine-session-lifecycle', {
    initializeRoutineSessionLifecycle() {}
  }]
])

try {
  const source = readFileSync(path.join(repoRoot, 'src/main/routines/routine-executor.ts'), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true
    }
  }).outputText
  const modulePath = path.join(tempRoot, 'routine-executor.cjs')
  writeFileSync(modulePath, output, 'utf8')

  Module._load = function loadWithRoutineStubs(request, parent, isMain) {
    if (stubs.has(request)) return stubs.get(request)
    return originalLoad.call(this, request, parent, isMain)
  }

  const { executeRoutine } = require(modulePath)
  const routine = {
    id: 'delivery-contract',
    name: 'Delivery Contract',
    projectCwd: tempRoot,
    prompt: 'run the scheduled check',
    schedule: 'every 1h',
    model: '',
    providerId: '',
    budgetUsd: 0,
    engine: 'openai',
    permissionMode: 'default',
    notification: { enabled: false, onSuccess: true, onFailure: true }
  }

  acceptPrompt = false
  const rejected = await executeRoutine(tempRoot, routine, { nextRunAt: null, sendDelayMs: 0 })
  assertEqual(rejected.status, 'failed', 'rejected prompt must fail the Routine run')
  assertIncludes(rejected.error, 'Routine prompt was rejected before execution started')
  assertKinds(calls, ['create', 'send', 'close'], 'rejected prompt must close the empty session')

  calls.length = 0
  acceptPrompt = true
  const accepted = await executeRoutine(tempRoot, routine, { nextRunAt: null, sendDelayMs: 0 })
  assertEqual(accepted.status, 'succeeded', 'accepted prompt should succeed')
  assertEqual(accepted.sessionId, 'routine-session-2', 'accepted run must retain its session id')
  assertKinds(calls, ['create', 'send'], 'accepted prompt must not close its active session')

  console.log('routine executor smoke: PASS')
} finally {
  Module._load = originalLoad
  rmSync(tempRoot, { recursive: true, force: true })
}

function assertKinds(actual, expected, message) {
  assertEqual(actual.map((entry) => entry.kind).join(','), expected.join(','), message)
}

function assertIncludes(actual, expected) {
  if (typeof actual !== 'string' || !actual.includes(expected)) {
    throw new Error(`expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`)
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
