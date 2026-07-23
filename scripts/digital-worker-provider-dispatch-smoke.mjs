#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const Module = require('node:module').Module
const originalLoad = Module._load
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-worker-provider-dispatch-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
const startedAt = new Date().toISOString()
const runId = startedAt.replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'digital-worker-provider-dispatch', runId)
const checks = []
let failure

process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter)
Module._initPaths()

try {
  compileRuntime()
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electronStub()
    return originalLoad.call(this, request, parent, isMain)
  }
  const runtime = loadRuntime()
  await check('runtime helper requires a canonical Run with the same frozen binding', () =>
    verifyFrozenBinding(runtime))
  await check('OpenAI denial precedes Attempt persistence and network', () =>
    verifyOpenAIInitialDenial(runtime))
  await check('OpenAI retry rechecks policy before the successor Attempt', () =>
    verifyOpenAIRetryRecheck(runtime))
  await check('Anthropic denial precedes Attempt persistence and Provider operation', () =>
    verifyAnthropicInitialDenial(runtime))
  await check('Anthropic successor request rechecks policy', () =>
    verifyAnthropicSuccessorRecheck(runtime))
  await check('all three production engines wire the pre-dispatch guard', verifyProductionWiring)
  process.stdout.write(`digital worker provider dispatch smoke: PASS (${checks.length} checks)\n`)
} catch (error) {
  failure = error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) }
  throw error
} finally {
  Module._load = originalLoad
  rmSync(tempRoot, { recursive: true, force: true })
  const report = {
    schemaVersion: 1,
    status: failure ? 'failed' : 'passed',
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    gate: 'test:digital-worker-provider-dispatch:required',
    checks,
    guarantees: [
      'OpenAI retries and tool-loop requests recheck before ModelAttempt persistence',
      'Anthropic requests and failover successors recheck before ModelAttempt persistence',
      'Claude queued turns recheck before Attempt persistence and SDK input dispatch',
      'policy denial produces no Provider request'
    ],
    error: failure
  }
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(
    path.join(repoRoot, 'test-results', 'digital-worker-provider-dispatch', 'latest.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8'
  )
}

function compileRuntime() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/digital-worker/session-action-policy.ts',
    'src/main/task/openai-model-attempt-runtime.ts',
    'src/main/task/anthropic-model-attempt-runtime.ts',
    'src/main/task/task-run.ts',
    '--outDir', outDir,
    '--rootDir', 'src',
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'pipe' })
}

function loadRuntime() {
  return {
    policy: require(path.join(outDir, 'main', 'digital-worker', 'session-action-policy.js')),
    registry: require(path.join(outDir, 'main', 'task', 'task-runtime-registry.js')),
    taskRun: require(path.join(outDir, 'main', 'task', 'task-run.js')),
    openai: require(path.join(outDir, 'main', 'task', 'openai-model-attempt-runtime.js')),
    anthropic: require(path.join(outDir, 'main', 'task', 'anthropic-model-attempt-runtime.js'))
  }
}

function verifyFrozenBinding(runtime) {
  const { meta, run } = unscopedFixture(runtime, 'binding')
  runtime.registry.taskRuntimeRegistry.set(meta.id, run)
  assert.doesNotThrow(() => runtime.policy.assertDigitalWorkerProviderDispatchAllowed(meta, userData))

  runtime.registry.taskRuntimeRegistry.clear()
  assert.throws(
    () => runtime.policy.assertDigitalWorkerProviderDispatchAllowed(meta, userData),
    runtime.policy.DigitalWorkerProviderDispatchDeniedError
  )

  runtime.registry.taskRuntimeRegistry.set(meta.id, {
    ...run,
    digitalWorkerBinding: { kind: 'assigned', workerId: 'tampered-worker', assignmentId: 'tampered-assignment' }
  })
  assert.throws(
    () => runtime.policy.assertDigitalWorkerProviderDispatchAllowed(meta, userData),
    runtime.policy.DigitalWorkerProviderDispatchDeniedError
  )
  runtime.registry.taskRuntimeRegistry.clear()
}

async function verifyOpenAIInitialDenial(runtime) {
  const { run } = unscopedFixture(runtime, 'openai-deny')
  const dependencies = fakeAttemptDependencies()
  const tracker = new runtime.openai.OpenAIModelAttemptTracker(dependencies)
  tracker.startTurn('message-openai-deny')
  let networkCalls = 0
  await assert.rejects(
    tracker.fetch(openAIInput(run, {
      preflight: () => { throw new runtime.policy.DigitalWorkerProviderDispatchDeniedError('denied') },
      fetch: async () => {
        networkCalls += 1
        return new Response('', { status: 200 })
      }
    })),
    runtime.policy.DigitalWorkerProviderDispatchDeniedError
  )
  assert.equal(dependencies.calls.start.length, 0)
  assert.equal(dependencies.calls.complete.length, 0)
  assert.equal(networkCalls, 0)
}

async function verifyOpenAIRetryRecheck(runtime) {
  const { run } = unscopedFixture(runtime, 'openai-retry')
  const dependencies = fakeAttemptDependencies()
  const tracker = new runtime.openai.OpenAIModelAttemptTracker(dependencies)
  tracker.startTurn('message-openai-retry')
  let preflightCalls = 0
  let networkCalls = 0
  await assert.rejects(
    tracker.fetch(openAIInput(run, {
      preflight: () => {
        preflightCalls += 1
        if (preflightCalls === 2) {
          throw new runtime.policy.DigitalWorkerProviderDispatchDeniedError('policy changed before retry')
        }
      },
      fetch: async () => {
        networkCalls += 1
        throw new TypeError('fetch failed')
      }
    })),
    runtime.policy.DigitalWorkerProviderDispatchDeniedError
  )
  assert.equal(preflightCalls, 2)
  assert.equal(networkCalls, 1)
  assert.equal(dependencies.calls.start.length, 1)
  assert.equal(dependencies.calls.complete.length, 1)
}

async function verifyAnthropicInitialDenial(runtime) {
  const { run } = unscopedFixture(runtime, 'anthropic-deny')
  const dependencies = fakeAttemptDependencies()
  const tracker = new runtime.anthropic.AnthropicModelAttemptTracker(dependencies)
  tracker.startTurn('message-anthropic-deny')
  let operationCalls = 0
  assert.throws(
    () => tracker.execute(anthropicInput(run, {
      preflight: () => { throw new runtime.policy.DigitalWorkerProviderDispatchDeniedError('denied') },
      operation: async () => {
        operationCalls += 1
        return anthropicResult()
      }
    })),
    runtime.policy.DigitalWorkerProviderDispatchDeniedError
  )
  assert.equal(dependencies.calls.start.length, 0)
  assert.equal(dependencies.calls.complete.length, 0)
  assert.equal(operationCalls, 0)
}

async function verifyAnthropicSuccessorRecheck(runtime) {
  const { run } = unscopedFixture(runtime, 'anthropic-successor')
  const dependencies = fakeAttemptDependencies()
  const tracker = new runtime.anthropic.AnthropicModelAttemptTracker(dependencies)
  tracker.startTurn('message-anthropic-successor')
  let preflightCalls = 0
  let operationCalls = 0
  await tracker.execute(anthropicInput(run, {
    preflight: () => { preflightCalls += 1 },
    operation: async () => {
      operationCalls += 1
      return anthropicResult()
    }
  }))
  assert.throws(
    () => tracker.execute(anthropicInput(run, {
      requestId: 'model-request-anthropic-successor',
      failoverFromAttemptId: dependencies.calls.start[0].input.id,
      preflight: () => {
        preflightCalls += 1
        throw new runtime.policy.DigitalWorkerProviderDispatchDeniedError('policy changed before successor')
      },
      operation: async () => {
        operationCalls += 1
        return anthropicResult()
      }
    })),
    runtime.policy.DigitalWorkerProviderDispatchDeniedError
  )
  assert.equal(preflightCalls, 2)
  assert.equal(operationCalls, 1)
  assert.equal(dependencies.calls.start.length, 1)
  assert.equal(dependencies.calls.complete.length, 1)
}

function verifyProductionWiring() {
  const openai = source('src/main/openaiEngine.ts')
  const anthropic = source('src/main/anthropicEngine.ts')
  const claude = source('src/main/agentSession.ts')
  assert.match(openai, /preflight:\s*\(\) => assertDigitalWorkerProviderDispatchAllowed\(this\.meta\)/)
  assert.match(anthropic, /preflight:\s*\(\) => assertDigitalWorkerProviderDispatchAllowed\(this\.meta\)/)

  const start = claude.indexOf('private async pushUserMessage(')
  const end = claude.indexOf('\n  async interrupt()', start)
  assert(start >= 0 && end > start)
  const dispatch = claude.slice(start, end)
  assertOrder(
    dispatch,
    'assertDigitalWorkerProviderDispatchAllowed(',
    'this.turns.attempts.beginTurn(',
    'Claude policy recheck must precede Attempt persistence'
  )
  assertOrder(
    dispatch,
    'this.turns.attempts.beginTurn(',
    'this.input.push(',
    'Claude Attempt persistence must precede SDK dispatch'
  )
}

function unscopedFixture(runtime, suffix) {
  const now = Date.now()
  const id = `session-${suffix}`
  const meta = {
    id,
    title: suffix,
    cwd: tempRoot,
    model: 'fixture-model',
    providerId: 'fixture-provider',
    engine: 'openai',
    permissionMode: 'default',
    status: 'running',
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    createdAt: now,
    unassigned: true,
    digitalWorkerBinding: { kind: 'unscoped' }
  }
  const run = runtime.taskRun.createTaskRun({
    id: `run-${suffix}`,
    sessionId: id,
    taskId: id,
    now,
    digitalWorkerBinding: { kind: 'unscoped' }
  })
  return { meta, run: { ...run, status: 'executing' } }
}

function openAIInput(run, overrides) {
  return {
    run,
    providerId: 'fixture-provider',
    model: 'fixture-model',
    protocol: 'openai.responses',
    url: 'https://example.invalid/v1/responses',
    init: { method: 'POST', body: '{}' },
    signal: new AbortController().signal,
    auth: { token: 'test-only' },
    readUsage: () => undefined,
    consume: async () => undefined,
    ...overrides
  }
}

function anthropicInput(run, overrides) {
  return {
    run,
    providerId: 'fixture-provider',
    model: 'fixture-model',
    endpoint: 'https://example.invalid/v1/messages',
    body: { messages: [] },
    signal: new AbortController().signal,
    auth: { token: 'test-only' },
    ...overrides
  }
}

function anthropicResult() {
  return {
    id: 'message-fixture',
    model: 'fixture-model',
    stopReason: 'end_turn',
    content: [],
    text: 'done',
    thinking: '',
    usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }
  }
}

function fakeAttemptDependencies() {
  const calls = { start: [], complete: [], getRetryAuthorization: [] }
  let sequence = 0
  return {
    calls,
    now: () => 1_000 + sequence,
    randomId: () => `attempt-${++sequence}`,
    getRetryAuthorization: async (query, rootDir) => {
      calls.getRetryAuthorization.push({ query, rootDir })
      return null
    },
    start: async (input, rootDir) => {
      calls.start.push({ input, rootDir })
      return startedAttempt(input, calls.start.length)
    },
    complete: async (attemptId, input, rootDir) => {
      calls.complete.push({ attemptId, input, rootDir })
      const started = calls.start.find((call) => call.input.id === attemptId)
      assert(started)
      return { ...startedAttempt(started.input, calls.start.indexOf(started) + 1), ...input, revision: 2 }
    }
  }
}

function startedAttempt(input, ordinal) {
  return {
    schemaVersion: 1,
    ...input,
    workItemId: 'work-item-provider-dispatch',
    ordinal,
    status: 'started',
    revision: 1,
    startCommandId: input.commandId,
    startPayloadDigest: 'a'.repeat(64),
    recordDigest: 'b'.repeat(64)
  }
}

function electronStub() {
  return {
    app: { getPath: () => userData, getVersion: () => '1.0.0', getName: () => 'CaoGen', isPackaged: false },
    safeStorage: { isEncryptionAvailable: () => false },
    BrowserWindow: class { static getAllWindows() { return [] } },
    powerSaveBlocker: { start: () => 1, stop() {}, isStarted: () => false }
  }
}

async function check(name, fn) {
  const start = Date.now()
  await fn()
  checks.push({ name, status: 'passed', durationMs: Date.now() - start })
}

function source(relative) {
  return readFileSync(path.join(repoRoot, relative), 'utf8')
}

function assertOrder(value, first, second, message) {
  const left = value.indexOf(first)
  const right = value.indexOf(second)
  assert(left >= 0 && right > left, message)
}
