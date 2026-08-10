import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-model-attempt-runtime-'))
const outDir = path.join(tempRoot, 'compiled')
const openAiCredentialFixture = '<openai-runtime-credential-fixture>'
process.env.OPENAI_API_KEY = openAiCredentialFixture
process.env.OPENAI_BASE_URL = 'http://model-attempt-runtime.test'

try {
  compileRuntime()
  installElectronStub()
  const runtime = await import(pathToFileURL(findCompiledModule(outDir, 'model-attempt-runtime.js')).href)
  const openaiRuntime = await import(pathToFileURL(findCompiledModule(outDir, 'openai-model-attempt-runtime.js')).href)
  const dagRuntime = await import(pathToFileURL(findCompiledModule(outDir, 'model-dag-decomposer.js')).href)
  const taskDecomposer = await import(pathToFileURL(findCompiledModule(outDir, 'task-decomposer.js')).href)
  await verifySplitPhaseRuntime(runtime)
  await verifyStartBarrier(runtime)
  await verifyRetryAuthorizationConsumption(runtime)
  await verifyRetryAuthorizationLookupFailure(runtime)
  await verifyNoRetryAuthorization(runtime)
  await verifyExplicitFailoverSource(runtime)
  await verifyCompletionBoundary(runtime)
  await verifyClockRollback(runtime)
  await verifyProviderFailure(runtime)
  await verifyDagPersistenceBoundary(runtime, dagRuntime, taskDecomposer)
  await verifyInvalidDagIsFailed(runtime, dagRuntime)
  verifyRedactionAndClassification(runtime)
  verifyUsageDelta(openaiRuntime)
  verifyRuntimeWiring()
  console.log(JSON.stringify({
    status: 'pass',
    checks: [
      'durable-start-before-operation',
      'split-phase-success-failure-cancel-and-single-settlement',
      'authorized-retry-consumed-before-operation',
      'retry-authorization-lookup-fails-closed',
      'no-authorization-preserves-logical-request',
      'explicit-failover-source-bypasses-lookup',
      'completion-failure-is-not-provider-failure',
      'completion-clock-rollback-clamped',
      'provider-failure-is-durably-completed',
      'dag-persistence-error-does-not-fallback',
      'invalid-dag-completes-as-failed',
      'stable-key-hash-without-secret',
      'usage-without-invented-cost',
      'per-attempt-usage-is-not-cumulative',
      'openai-and-dag-runtime-wiring'
    ]
  }, null, 2))
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

async function verifySplitPhaseRuntime(runtime) {
  const successDependencies = fakeDependencies()
  let providerHit = false
  const successHandle = await runtime.beginPersistedModelAttempt(baseInput(), {
    dependencies: successDependencies
  })
  assert.equal(successDependencies.calls.start.length, 1)
  assert.equal(providerHit, false, 'provider work must remain outside and after durable begin')
  providerHit = true
  const completed = await successHandle.succeed({
    usage: runtime.modelAttemptUsage({ input: 9, output: 4, cacheWrite: 2 }),
    costUsd: 0.012
  })
  assert.equal(providerHit, true)
  assert.equal(completed.status, 'succeeded')
  assert.deepEqual(successDependencies.calls.complete[0].input.usage, {
    inputTokens: 9,
    outputTokens: 4,
    cacheWriteTokens: 2
  })
  assert.equal(successDependencies.calls.complete[0].input.costUsd, 0.012)

  const failureDependencies = fakeDependencies()
  const failureHandle = await runtime.beginPersistedModelAttempt(baseInput(), {
    dependencies: failureDependencies
  })
  const providerError = new Error('HTTP 503 upstream unavailable')
  await failureHandle.fail(runtime.classifyRuntimeModelFailure(providerError), providerError)
  assert.equal(failureDependencies.calls.complete[0].input.status, 'failed')
  assert.equal(failureDependencies.calls.complete[0].input.outcome, 'unavailable')
  assert.equal(failureDependencies.calls.complete[0].input.errorClass, 'provider_unavailable')

  const diagnosticDependencies = fakeDependencies({ completeError: new Error('completion fsync failed') })
  const diagnosticHandle = await runtime.beginPersistedModelAttempt(baseInput(), {
    dependencies: diagnosticDependencies
  })
  await assert.rejects(
    diagnosticHandle.fail(runtime.classifyRuntimeModelFailure(providerError), providerError),
    (error) => error instanceof runtime.ModelAttemptPersistenceError &&
      error.phase === 'complete' &&
      error.operationStarted === true &&
      error.message.includes('HTTP 503 upstream unavailable')
  )

  const cancelDependencies = fakeDependencies()
  const cancelHandle = await runtime.beginPersistedModelAttempt(baseInput(), {
    dependencies: cancelDependencies
  })
  await cancelHandle.cancel(new Error('user interrupted'))
  assert.equal(cancelDependencies.calls.complete[0].input.status, 'cancelled')
  assert.equal(cancelDependencies.calls.complete[0].input.outcome, 'cancelled')

  const settlementDependencies = fakeDependencies()
  const settlementHandle = await runtime.beginPersistedModelAttempt(baseInput(), {
    dependencies: settlementDependencies
  })
  const firstSettlement = settlementHandle.succeed()
  await assert.rejects(
    settlementHandle.cancel(),
    (error) => error instanceof runtime.ModelAttemptSettlementError &&
      error.attemptId === settlementHandle.attempt.id
  )
  await firstSettlement
  await assert.rejects(
    settlementHandle.fail(runtime.classifyRuntimeModelFailure(new Error('late failure'))),
    (error) => error instanceof runtime.ModelAttemptSettlementError
  )
  assert.equal(settlementDependencies.calls.complete.length, 1)
}

async function verifyStartBarrier(runtime) {
  let operationCalls = 0
  const dependencies = fakeDependencies({ startError: new Error('disk unavailable') })
  await assert.rejects(
    runtime.executePersistedModelAttempt(baseInput(), async () => {
      operationCalls += 1
      return 'unexpected'
    }, { dependencies }),
    (error) => error instanceof runtime.ModelAttemptPersistenceError &&
      error.phase === 'start' && error.operationStarted === false
  )
  assert.equal(operationCalls, 0, 'failed durable start must prevent the provider operation')
  assert.equal(dependencies.calls.complete.length, 0, 'failed start must not write completion')
}

async function verifyRetryAuthorizationConsumption(runtime) {
  let operationCalls = 0
  const authorization = retryAuthorizationFixture()
  const dependencies = fakeDependencies({ retryAuthorization: authorization })
  const input = {
    ...baseInput(),
    requestId: 'caller-request-id',
    rootDir: '/tmp/runtime-retry-authorization'
  }
  await runtime.executePersistedModelAttempt(input, async () => {
    operationCalls += 1
    return { ok: true }
  }, { dependencies })
  assert.equal(operationCalls, 1)
  assert.deepEqual(dependencies.calls.getRetryAuthorization, [{
    query: { runId: input.runId, stepId: input.stepId },
    rootDir: input.rootDir
  }])
  assert.equal(dependencies.calls.start.length, 1)
  assert.equal(dependencies.calls.start[0].input.requestId, authorization.attempt.requestId)
  assert.equal(dependencies.calls.start[0].input.stepId, authorization.attempt.stepId)
  assert.equal(
    dependencies.calls.start[0].input.failoverFromAttemptId,
    authorization.attempt.id
  )
}

async function verifyRetryAuthorizationLookupFailure(runtime) {
  for (const retryAuthorizationError of [
    new Error('Retry authorization query matches multiple Attempts'),
    new Error('retry authorization database unavailable')
  ]) {
    let operationCalls = 0
    const dependencies = fakeDependencies({ retryAuthorizationError })
    await assert.rejects(
      runtime.executePersistedModelAttempt(baseInput(), async () => {
        operationCalls += 1
        return 'unexpected'
      }, { dependencies }),
      (error) => error instanceof runtime.ModelAttemptPersistenceError &&
        error.phase === 'start' &&
        error.operationStarted === false &&
        error.attemptId === undefined &&
        error.message.includes('retry authorization lookup failed')
    )
    assert.equal(operationCalls, 0, 'authorization query failure must prevent provider operation')
    assert.equal(dependencies.calls.start.length, 0, 'authorization query failure must prevent start')
    assert.equal(dependencies.calls.complete.length, 0, 'authorization query failure must prevent completion')
    assert.equal(dependencies.calls.getRetryAuthorization.length, 1)
  }
}

async function verifyNoRetryAuthorization(runtime) {
  const dependencies = fakeDependencies()
  const input = { ...baseInput(), requestId: 'request-without-authorization' }
  await runtime.executePersistedModelAttempt(input, async () => ({ ok: true }), { dependencies })
  assert.equal(dependencies.calls.getRetryAuthorization.length, 1)
  assert.equal(dependencies.calls.start[0].input.requestId, input.requestId)
  assert.equal(dependencies.calls.start[0].input.stepId, input.stepId)
  assert.equal(dependencies.calls.start[0].input.failoverFromAttemptId, undefined)
}

async function verifyExplicitFailoverSource(runtime) {
  const dependencies = fakeDependencies({
    retryAuthorizationError: new Error('explicit failover must not query authorization')
  })
  const input = {
    ...baseInput(),
    requestId: 'explicit-request-id',
    failoverFromAttemptId: 'attempt-explicit-source'
  }
  await runtime.executePersistedModelAttempt(input, async () => ({ ok: true }), { dependencies })
  assert.equal(dependencies.calls.getRetryAuthorization.length, 0)
  assert.equal(dependencies.calls.start[0].input.requestId, input.requestId)
  assert.equal(dependencies.calls.start[0].input.stepId, input.stepId)
  assert.equal(dependencies.calls.start[0].input.failoverFromAttemptId, input.failoverFromAttemptId)
}

async function verifyCompletionBoundary(runtime) {
  let operationCalls = 0
  const dependencies = fakeDependencies({ completeError: new Error('completion fsync failed') })
  await assert.rejects(
    runtime.executePersistedModelAttempt(baseInput(), async () => {
      operationCalls += 1
      return { ok: true }
    }, { dependencies }),
    (error) => error instanceof runtime.ModelAttemptPersistenceError &&
      error.phase === 'complete' && error.operationStarted === true
  )
  assert.equal(operationCalls, 1, 'completion failure must not replay the provider operation')
  assert.equal(dependencies.calls.start.length, 1)
  assert.equal(dependencies.calls.complete.length, 1)
}

async function verifyClockRollback(runtime) {
  const dependencies = fakeDependencies({ now: 50 })
  await runtime.executePersistedModelAttempt(baseInput(), async () => ({ ok: true }), { dependencies })
  assert.equal(
    dependencies.calls.complete[0].input.completedAt,
    100,
    'completion time must not precede the persisted start when the wall clock moves backward'
  )
}

async function verifyProviderFailure(runtime) {
  const dependencies = fakeDependencies()
  await assert.rejects(
    runtime.executePersistedModelAttempt(baseInput(), async () => {
      throw new Error('HTTP 429 rate limit')
    }, { dependencies }),
    (error) => error instanceof runtime.ModelAttemptOperationError && error.attemptId === 'attempt-fixture'
  )
  assert.equal(dependencies.calls.complete.length, 1)
  const completion = dependencies.calls.complete[0].input
  assert.equal(completion.status, 'failed')
  assert.equal(completion.outcome, 'rate_limited')
  assert.equal(completion.errorClass, 'provider_rate_limit')
  const persistedStart = dependencies.calls.start[0].input
  assert.match(persistedStart.keyLabel, /^sha256:[0-9a-f]{64}$/)
  assert.equal(JSON.stringify(persistedStart).includes(openAiCredentialFixture), false)

  const successDependencies = fakeDependencies()
  await runtime.executePersistedModelAttempt(baseInput(), async () => ({ usage: true }), {
    dependencies: successDependencies,
    success: () => ({ usage: runtime.modelAttemptUsage({ input: 12, output: 3, cacheRead: 2 }) })
  })
  const success = successDependencies.calls.complete[0].input
  assert.deepEqual(success.usage, { inputTokens: 12, outputTokens: 3, cacheReadTokens: 2 })
  assert.equal(success.costUsd, undefined, 'runtime must not invent cost without a trusted source')
}

function verifyRedactionAndClassification(runtime) {
  const credentialFixture = '<runtime-key-material-fixture>'
  const first = runtime.stableModelKeyLabel({ providerId: 'provider-a', token: credentialFixture })
  const second = runtime.stableModelKeyLabel({ providerId: 'provider-a', token: credentialFixture })
  const otherProvider = runtime.stableModelKeyLabel({ providerId: 'provider-b', token: credentialFixture })
  assert.equal(first, second, 'same key identity must produce a stable label')
  assert.notEqual(first, otherProvider, 'provider identity must contribute to the stable label')
  assert.match(first, /^sha256:[0-9a-f]{64}$/)
  assert.equal(first.includes(credentialFixture), false, 'raw credential material must never enter keyLabel')
  assert.equal(runtime.classifyRuntimeModelFailure(new Error('HTTP 503')).outcome, 'unavailable')
  assert.equal(runtime.classifyRuntimeModelFailure(new Error('abort'), { timedOut: true }).outcome, 'timeout')
}

function verifyUsageDelta(openaiRuntime) {
  const usage = openaiRuntime.modelAttemptUsageDelta(
    { input: 10, output: 2, cacheRead: 1, cacheCreation: 0 },
    { input: 14, output: 5, cacheRead: 3, cacheCreation: 1 }
  )
  assert.deepEqual(usage, {
    inputTokens: 4,
    outputTokens: 3,
    cacheReadTokens: 2,
    cacheWriteTokens: 1
  })
}

function verifyRuntimeWiring() {
  const openai = readFileSync(path.join(repoRoot, 'src/main/openaiEngine.ts'), 'utf8')
  const openaiRuntime = readFileSync(path.join(repoRoot, 'src/main/task/openai-model-attempt-runtime.ts'), 'utf8')
  const dag = readFileSync(path.join(repoRoot, 'src/main/agent/model-dag-decomposer.ts'), 'utf8')
  assert.match(openai, /modelAttempts\.fetch/, 'OpenAI engine must route model requests through its Attempt tracker')
  assert.doesNotMatch(openai, /(^|[^.\w])fetch\s*\(/m, 'OpenAI engine must not retain an untracked direct fetch')
  assert.match(openaiRuntime, /executePersistedModelAttempt/, 'OpenAI tracker must use the persisted Attempt wrapper')
  assert.match(openaiRuntime, /\(input\.fetch \?\? fetch\)/, 'OpenAI tracker must contain the physical fetch')
  assert.match(dag, /executePersistedModelAttempt/, 'DAG decomposer must use persisted ModelAttempt wrapper')
  assert.match(dag, /return \{ payload: parse\(json\), usage:/, 'DAG semantic parse must remain inside the wrapper')
  const dagWrapper = dag.indexOf('const result = await executePersistedModelAttempt')
  const dagFetch = dag.indexOf('runtime.fetch(', dagWrapper)
  const dagParse = dag.indexOf('payload: parse(json)', dagFetch)
  assert(dagWrapper >= 0 && dagFetch > dagWrapper && dagParse > dagFetch, 'DAG fetch and parse must stay contained')
  assert.match(openai, /setRouteReason\(smart\.reason\)/, 'smart router reason must reach the Attempt ledger')
  assert.match(openai, /setRouteReason\(decision\.reason\)/, 'legacy router reason must reach the Attempt ledger')
  assert.match(openai, /setRouteReason\((?:target|recovery)\.routeReason\)/, 'provider failover reason must reach the Attempt ledger')
  assert.match(openai, /setRouteReason\(`Provider key failover:/, 'key failover reason must reach the Attempt ledger')
  assert.match(
    openai,
    /const json = \(await res\.json\(\)\.catch\(\(\) => null\)\)[\s\S]{0,160}this\.applyChatUsage\(json\)/,
    'summary usage must be included in the turn and its ModelAttempt delta'
  )
  assert.match(openai, /addUsageTotals\(this\.turnUsage, usage\)/, 'turn usage must accumulate across model requests')
}

async function verifyDagPersistenceBoundary(runtime, dagRuntime, taskDecomposer) {
  let fetchCalls = 0
  const dependencies = fakeDependencies({ completeError: new Error('dag completion fsync failed') })
  const modelDecomposer = dagRuntime.createModelDagDecomposer(
    complexRequest(),
    dagAttemptContext(),
    {
      fetch: async () => {
        fetchCalls += 1
        return dagResponse(validDag())
      },
      attempt: dependencies
    }
  )
  await assert.rejects(
    taskDecomposer.decomposeTask(complexRequest(), { modelDecomposer }),
    (error) => error instanceof runtime.ModelAttemptPersistenceError && error.phase === 'complete'
  )
  assert.equal(fetchCalls, 1, 'completion failure must not replay DAG provider request')
  assert.equal(dependencies.calls.complete.length, 1)
}

async function verifyInvalidDagIsFailed(runtime, dagRuntime) {
  const dependencies = fakeDependencies()
  const decomposer = dagRuntime.createModelDagDecomposer(
    complexRequest(),
    dagAttemptContext(),
    { fetch: async () => dagResponse({ title: 'invalid', tasks: [] }), attempt: dependencies }
  )
  await assert.rejects(
    decomposer.decompose(),
    (error) => error instanceof runtime.ModelAttemptOperationError
  )
  assert.equal(dependencies.calls.complete.length, 1)
  assert.equal(dependencies.calls.complete[0].input.status, 'failed')
  assert.equal(dependencies.calls.complete[0].input.outcome, 'error')
}

function complexRequest() {
  return {
    request: '实现完整前端 UI、后端 API 和数据库，并补充测试验证与端到端 E2E',
    model: 'gpt-runtime-fixture'
  }
}

function dagAttemptContext() {
  return { runId: 'run-fixture', requestId: 'request-dag-fixture', stepId: 'step-fixture' }
}

function validDag() {
  return {
    title: 'Runtime fixture',
    tasks: [{
      id: 'implementation', title: 'Implement', description: 'Implement the fixture',
      dependencies: [], role: 'backend'
    }]
  }
}

function dagResponse(payload) {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(payload) } }],
    usage: { prompt_tokens: 10, completion_tokens: 3 }
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function baseInput() {
  return {
    id: 'attempt-fixture',
    runId: 'run-fixture',
    requestId: 'request-fixture',
    stepId: 'step-fixture',
    providerId: 'provider-fixture',
    model: 'model-fixture',
    protocol: 'openai.responses',
    adapterVersion: 'runtime-smoke-v1',
    context: { prompt: 'fixture' },
    routeReason: 'runtime smoke fixture',
    keyIdentity: { providerId: 'provider-fixture', token: openAiCredentialFixture },
    startedAt: 100
  }
}

function retryAuthorizationFixture() {
  return {
    attempt: {
      id: 'attempt-retry-authorized',
      runId: 'run-fixture',
      requestId: 'request-retry-authorized',
      stepId: 'step-fixture'
    },
    runId: 'run-fixture',
    sessionId: 'session-fixture',
    requestId: 'request-retry-authorized'
  }
}

function fakeDependencies(options = {}) {
  const calls = { start: [], complete: [], getRetryAuthorization: [] }
  let randomSequence = 0
  return {
    calls,
    now: () => options.now ?? 200,
    randomId: () => {
      randomSequence += 1
      return randomSequence === 1 ? 'attempt-fixture' : `attempt-fixture-${randomSequence}`
    },
    start: async (input, rootDir) => {
      calls.start.push({ input, rootDir })
      if (options.startError) throw options.startError
      return startedRecord(input)
    },
    complete: async (attemptId, input, rootDir) => {
      calls.complete.push({ attemptId, input, rootDir })
      if (options.completeWait) await options.completeWait
      if (options.completeError) throw options.completeError
      const start = calls.start.find((call) => call.input.id === attemptId)
      assert(start, `missing start fixture for completion ${attemptId}`)
      return { ...startedRecord(start.input), ...input, id: attemptId, revision: 2 }
    },
    getRetryAuthorization: async (query, rootDir) => {
      calls.getRetryAuthorization.push({ query, rootDir })
      if (options.retryAuthorizationError) throw options.retryAuthorizationError
      return options.retryAuthorization ?? null
    }
  }
}

function startedRecord(input) {
  return {
    schemaVersion: 1,
    ...input,
    workItemId: 'work-item-fixture',
    ordinal: 1,
    status: 'started',
    revision: 1,
    startCommandId: input.commandId,
    startPayloadDigest: 'a'.repeat(64),
    recordDigest: 'b'.repeat(64)
  }
}

function compileRuntime() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/task/model-attempt-runtime.ts',
    'src/main/task/openai-model-attempt-runtime.ts',
    'src/main/agent/task-decomposer.ts',
    'src/main/agent/model-dag-decomposer.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installElectronStub() {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), [
    `export const app = { getPath: () => ${JSON.stringify(tempRoot)} }`,
    "export const safeStorage = { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' }"
  ].join('\n'))
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

function findCompiledModule(root, name) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledModuleOrNull(fullPath, name)
      if (found) return found
    } else if (entry.isFile() && entry.name === name) return fullPath
  }
  throw new Error(`compiled ${name} not found under ${root}`)
}

function findCompiledModuleOrNull(root, name) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledModuleOrNull(fullPath, name)
      if (found) return found
    } else if (entry.isFile() && entry.name === name) return fullPath
  }
  return null
}
