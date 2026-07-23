#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ts from 'typescript'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const Module = require('node:module').Module
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-claude-model-attempt-'))
const runtimeOut = path.join(tempRoot, 'runtime')
const userData = path.join(tempRoot, 'user-data')
const nativeSetTimeout = globalThis.setTimeout
const checks = []

process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter)
Module._initPaths()

class StubPushable {
  push() {}
  end() {}
}

class StubTranscriptWriter {
  constructor(_resumeId, initialSeq = 0) {
    this.seq = initialSeq
    this.entries = []
  }
  nextEntry(event) {
    const entry = { seq: ++this.seq, event }
    this.entries.push(entry)
    return entry
  }
  read() { return [...this.entries] }
}

try {
  compileRuntime()
  const electronStub = createElectronStub()
  const { runtime, claudeRuntime, sessionRuntime, resultRuntime, streamRuntime } = loadRuntime(electronStub)
  const harness = loadAgentSession(
    runtime,
    claudeRuntime,
    sessionRuntime,
    resultRuntime,
    streamRuntime,
    electronStub
  )

  await check('durable begin barriers, protocol, and TaskStep selection', () =>
    verifyBeginBarriers(runtime, claudeRuntime, harness))
  await check('AUTO model requires a verified routed model', () =>
    verifyAutoModelFailClosed(claudeRuntime, harness))
  await check('setModel normalizes AUTO for the SDK while preserving session meta', () =>
    verifyAutoModelSetModelNormalization(harness))
  await check('success maps usage and cumulative cost delta', () =>
    verifySuccessUsageAndCost(claudeRuntime, harness))
  await check('error settles before failover and links successor', () =>
    verifyErrorFailoverOrdering(claudeRuntime, harness))
  await check('stream iterator failure settles before failover', () =>
    verifyStreamThrowOrdering(claudeRuntime, harness))
  await check('completion persistence failure blocks failover and turn-result', () =>
    verifyCompletionPersistenceFailure(claudeRuntime, harness))
  await check('interrupt/result race settles once and cancels queued checkpoints', () =>
    verifyInterruptSingleSettlement(claudeRuntime, harness))
  await check('concurrent sends run sequentially without payload loss', () =>
    verifySequentialTurnQueue(claudeRuntime, harness))
  await check('stale generation and dispose remain pending reconciliation', () =>
    verifyStaleAndDispose(claudeRuntime, harness))

  console.log(JSON.stringify({ status: 'pass', checks }, null, 2))
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

async function verifyBeginBarriers(runtime, claudeRuntime, harness) {
  const startFailure = fakeDependencies({ startError: new Error('start fsync failed') })
  const failed = harness.createSession({ dependencies: startFailure })
  failed.setRun(runFixture(failed.meta.id, [stepFixture('step-start-failure', 'message-start-failure')]))
  await failed.session.pushUserMessage(payload('start failure', 'message-start-failure'))
  assert.equal(failed.providerHits(), 0, 'provider must not run when durable begin fails')
  assert.equal(startFailure.calls.start.length, 1)

  const missingRunDependencies = fakeDependencies()
  const missingRun = harness.createSession({ dependencies: missingRunDependencies })
  await missingRun.session.pushUserMessage(payload('missing run', 'message-missing-run'))
  assert.equal(missingRun.providerHits(), 0)
  assert.equal(missingRunDependencies.calls.start.length, 0)

  const missingStepDependencies = fakeDependencies()
  const missingStep = harness.createSession({ dependencies: missingStepDependencies })
  missingStep.setRun(runFixture(missingStep.meta.id, []))
  await missingStep.session.pushUserMessage(payload('missing step', 'message-missing-step'))
  assert.equal(missingStep.providerHits(), 0)
  assert.equal(missingStepDependencies.calls.start.length, 0)

  const order = []
  const exactDependencies = fakeDependencies({ order })
  const exact = harness.createSession({
    dependencies: exactDependencies,
    onProviderPush: () => order.push('provider-push')
  })
  exact.setRun(runFixture(exact.meta.id, [
    stepFixture('step-oldest', 'message-oldest'),
    stepFixture('step-exact', 'message-exact')
  ]))
  await exact.session.pushUserMessage(payload('exact step', 'message-exact'))
  assert.deepEqual(order.slice(0, 2), ['durable-start', 'provider-push'])
  assert.equal(exactDependencies.calls.start[0].input.stepId, 'step-exact')
  assert.equal(exactDependencies.calls.start[0].input.protocol, 'claude-agent-sdk.turn')
  await exact.tracker.completeTurn({ generation: exact.session.generation })

  const oldestDependencies = fakeDependencies()
  const oldest = harness.createSession({ dependencies: oldestDependencies })
  oldest.setRun(runFixture(oldest.meta.id, [
    { ...stepFixture('step-terminal', 'message-terminal'), status: 'completed', finishedAt: 5 },
    stepFixture('step-oldest-unfinished', 'message-other'),
    stepFixture('step-newer-unfinished', 'message-newer')
  ]))
  await oldest.session.pushUserMessage(payload('oldest fallback', 'message-not-yet-indexed'))
  assert.equal(oldestDependencies.calls.start[0].input.stepId, 'step-oldest-unfinished')
  assert.equal(oldestDependencies.calls.start[0].input.protocol, claudeRuntime.CLAUDE_MODEL_ATTEMPT_PROTOCOL)
  await oldest.tracker.cancelTurn({ generation: oldest.session.generation })

  assert(runtime.ModelAttemptPersistenceError, 'runtime error class must be loaded')
}

async function verifyAutoModelFailClosed(claudeRuntime, harness) {
  const dependencies = fakeDependencies()
  const fixture = harness.createSession({ dependencies, model: harness.AUTO_MODEL })
  fixture.session.turns.rememberVerifiedModel('stale-provider-model')
  fixture.setRun(runFixture(fixture.meta.id, []))
  fixture.session.send('auto model without a routing decision')
  await eventually(() => fixture.meta.status === 'error', 'AUTO fail-closed status')
  assert.equal(dependencies.calls.start.length, 0)
  assert.equal(fixture.providerHits(), 0)
  assert.match(fixture.meta.lastError ?? '', /active Claude model is missing/)
  assert.equal(fixture.session.pendingCheckpointUserMessageIds.length, 0)
  assert.equal(claudeRuntime.CLAUDE_MODEL_ATTEMPT_PROTOCOL, 'claude-agent-sdk.turn')
}

async function verifyAutoModelSetModelNormalization(harness) {
  const fixture = harness.createSession()
  const sdkModels = []
  fixture.session.query = {
    setModel(model) {
      sdkModels.push(model)
    }
  }

  await fixture.session.setModel('claude-sonnet-4')
  await fixture.session.setModel(harness.AUTO_MODEL)

  assert.deepEqual(sdkModels, ['claude-sonnet-4', undefined])
  assert.equal(fixture.meta.model, harness.AUTO_MODEL)
  const metaEvents = fixture.events.filter((event) => event.kind === 'meta')
  assert.equal(metaEvents.at(-1)?.meta.model, harness.AUTO_MODEL)
}

async function verifySuccessUsageAndCost(claudeRuntime, harness) {
  const dependencies = fakeDependencies()
  const fixture = harness.createSession({ dependencies })
  fixture.setRun(runFixture(fixture.meta.id, [stepFixture('step-success', 'message-success')]))
  await fixture.session.pushUserMessage(payload('success one', 'message-success'))
  await fixture.session.handleMessage(resultMessage({
    usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
    total_cost_usd: 1.25
  }), fixture.session.generation)
  assert.deepEqual(dependencies.calls.complete[0].input.usage, {
    inputTokens: 10,
    outputTokens: 4,
    cacheReadTokens: 3,
    cacheWriteTokens: 2
  })
  assert.equal(dependencies.calls.complete[0].input.costUsd, 1.25)

  await fixture.session.pushUserMessage(payload('success two', 'message-success'))
  await fixture.session.handleMessage(resultMessage({ total_cost_usd: 1.5 }), fixture.session.generation)
  assert.equal(dependencies.calls.complete[1].input.costUsd, 0.25)
  assert.equal(fixture.meta.costUsd, 1.5)
  assert.equal(fixture.events.filter((event) => event.kind === 'turn-result').length, 2)
  assert.equal(claudeRuntime.claudeModelAttemptCostDelta(1.25, 1.5), 0.25)
}

async function verifyErrorFailoverOrdering(claudeRuntime, harness) {
  const order = []
  const dependencies = fakeDependencies({ order })
  const fixture = harness.createSession({
    dependencies,
    onProviderPush: () => order.push('provider-push')
  })
  const message = payload('retry me', 'message-retry')
  fixture.setRun(runFixture(fixture.meta.id, [stepFixture('step-retry', message.messageId)]))
  fixture.session.turns.beginPayload(message, false)
  fixture.meta.status = 'running'
  await fixture.session.pushUserMessage(message)
  fixture.session.tryProviderKeyFailover = async () => {
    assert.equal(dependencies.calls.complete.length, 1, 'Attempt must complete before key failover')
    order.push('key-failover')
    return false
  }
  fixture.session.tryFailover = async () => {
    assert.equal(dependencies.calls.complete.length, 1, 'Attempt must complete before provider failover')
    order.push('provider-failover')
    fixture.session.advanceGeneration()
    fixture.session.turns.appendRouteReason('Provider failover: unavailable')
    fixture.session.turns.appendRouteReason('Smart route: claude-backup')
    await fixture.session.pushUserMessage(message)
    return true
  }
  await fixture.session.handleMessage(resultMessage({
    subtype: 'error_during_execution',
    is_error: true,
    result: 'HTTP 503 unavailable'
  }), fixture.session.generation)
  assert(order.indexOf('durable-complete') < order.indexOf('key-failover'))
  assert(order.indexOf('durable-complete') < order.indexOf('provider-failover'))
  assert.equal(dependencies.calls.start.length, 2)
  assert.equal(dependencies.calls.start[1].input.requestId, dependencies.calls.start[0].input.requestId)
  assert.equal(dependencies.calls.start[1].input.failoverFromAttemptId, dependencies.calls.start[0].input.id)
  assert.match(dependencies.calls.start[1].input.routeReason, /Provider failover: unavailable/)
  assert.match(dependencies.calls.start[1].input.routeReason, /Smart route: claude-backup/)
  assert.match(dependencies.calls.start[1].input.routeReason, /predecessor recorded/)
  await fixture.tracker.cancelTurn({ generation: fixture.session.generation })
  assert.equal(claudeRuntime.CLAUDE_MODEL_ATTEMPT_PROTOCOL, dependencies.calls.start[1].input.protocol)
}

async function verifyStreamThrowOrdering(claudeRuntime, harness) {
  const order = []
  const dependencies = fakeDependencies({ order })
  const fixture = harness.createSession({ dependencies })
  const message = payload('stream failure', 'message-stream')
  fixture.setRun(runFixture(fixture.meta.id, [stepFixture('step-stream', message.messageId)]))
  fixture.session.turns.beginPayload(message, false)
  fixture.meta.status = 'running'
  await fixture.session.pushUserMessage(message)
  fixture.session.tryProviderKeyFailover = async () => {
    assert.equal(dependencies.calls.complete.length, 1)
    order.push('stream-key-failover')
    return false
  }
  fixture.session.tryFailover = async () => {
    assert.equal(dependencies.calls.complete.length, 1)
    order.push('stream-provider-failover')
    return true
  }
  fixture.session.query = throwingQuery(new Error('HTTP 503 stream exploded'))
  await fixture.session.consume(fixture.session.generation)
  assert(order.indexOf('durable-complete') < order.indexOf('stream-key-failover'))
  assert(order.indexOf('durable-complete') < order.indexOf('stream-provider-failover'))
  assert.equal(dependencies.calls.complete[0].input.status, 'failed')
  assert.equal(claudeRuntime.CLAUDE_MODEL_ATTEMPT_PROTOCOL, dependencies.calls.start[0].input.protocol)
}

async function verifyCompletionPersistenceFailure(claudeRuntime, harness) {
  const dependencies = fakeDependencies({ completeError: new Error('completion fsync failed') })
  const fixture = harness.createSession({ dependencies })
  const message = payload('completion failure', 'message-completion-failure')
  fixture.setRun(runFixture(fixture.meta.id, [stepFixture('step-completion-failure', message.messageId)]))
  fixture.session.turns.beginPayload(message, false)
  fixture.meta.status = 'running'
  await fixture.session.pushUserMessage(message)
  let failoverCalls = 0
  fixture.session.tryProviderKeyFailover = async () => { failoverCalls += 1; return false }
  fixture.session.tryFailover = async () => { failoverCalls += 1; return false }
  fixture.session.query = yieldingQuery(resultMessage({
    subtype: 'error_during_execution',
    is_error: true,
    result: 'HTTP 503 unavailable'
  }))
  await fixture.session.consume(fixture.session.generation)
  assert.equal(failoverCalls, 0)
  assert.equal(fixture.events.some((event) => event.kind === 'turn-result'), false)
  assert.equal(fixture.meta.status, 'error')
  assert.equal(fixture.tracker.activeAttempt?.id, dependencies.calls.start[0].input.id)
  assert.equal(dependencies.calls.complete.length, 1)
  assert.equal(claudeRuntime.CLAUDE_MODEL_ATTEMPT_PROTOCOL, dependencies.calls.start[0].input.protocol)
}

async function verifyInterruptSingleSettlement(claudeRuntime, harness) {
  let releaseCompletion = () => undefined
  const completionWait = new Promise((resolve) => { releaseCompletion = resolve })
  const dependencies = fakeDependencies({ completeWait: completionWait })
  const fixture = harness.createSession({ dependencies })
  fixture.setRun(runFixture(fixture.meta.id, []))
  fixture.session.send('interrupt current')
  fixture.session.send('cancel queued')
  await eventually(() => dependencies.calls.start.length === 1, 'interrupt Attempt start')
  assert.equal(fixture.providerHits(), 1)
  assert.equal(fixture.session.pendingCheckpointUserMessageIds.length, 2)

  let resultPromise
  fixture.session.query = {
    interrupt() {
      resultPromise = fixture.session.handleMessage(resultMessage(), fixture.session.generation)
      return new Promise(() => undefined)
    }
  }
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = (callback) => {
    queueMicrotask(callback)
    return 1
  }
  globalThis.clearTimeout = () => undefined
  try {
    const interruptPromise = fixture.session.interrupt()
    await eventually(() => dependencies.calls.complete.length === 1, 'interrupt durable completion')
    releaseCompletion()
    await interruptPromise
    await resultPromise
    await Promise.resolve()
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }

  assert.equal(dependencies.calls.complete.length, 1, 'interrupt/result may settle only once')
  assert.equal(dependencies.calls.complete[0].input.status, 'cancelled')
  assert.equal(dependencies.calls.complete[0].input.outcome, 'cancelled')
  const results = fixture.events.filter((event) => event.kind === 'turn-result')
  assert.equal(results.length, 1)
  assert.equal(results[0].subtype, 'cancelled')
  assert.equal(results[0].isError, true)
  assert.equal(fixture.session.pendingCheckpointUserMessageIds.length, 0)
  assert.equal(fixture.session.turns.queuedCount, 0)
  assert.equal(fixture.meta.status, 'idle')
  assert.equal(claudeRuntime.CLAUDE_MODEL_ATTEMPT_PROTOCOL, dependencies.calls.start[0].input.protocol)
}

async function verifySequentialTurnQueue(claudeRuntime, harness) {
  const dependencies = fakeDependencies()
  const fixture = harness.createSession({ dependencies })
  fixture.setRun(runFixture(fixture.meta.id, []))
  fixture.session.send('first queued turn')
  fixture.session.send('second queued turn')
  await eventually(() => dependencies.calls.start.length === 1, 'first queued turn start')
  assert.equal(fixture.providerHits(), 1)
  assert.equal(fixture.session.turns.queuedCount, 1)
  const userMessages = fixture.events.filter((event) => event.kind === 'user-message')
  assert.equal(userMessages.length, 2)
  const firstStep = fixture.run().steps.find((step) => step.messageId === userMessages[0].messageId)
  const secondStep = fixture.run().steps.find((step) => step.messageId === userMessages[1].messageId)
  assert.equal(dependencies.calls.start[0].input.stepId, firstStep.id)

  await fixture.session.handleMessage(resultMessage(), fixture.session.generation)
  await eventually(() => dependencies.calls.start.length === 2, 'second queued turn start')
  assert.equal(fixture.providerHits(), 2)
  assert.equal(dependencies.calls.start[1].input.stepId, secondStep.id)
  assert.match(providerText(fixture.providerMessages[0]), /first queued turn/)
  assert.match(providerText(fixture.providerMessages[1]), /second queued turn/)
  await fixture.session.handleMessage(resultMessage(), fixture.session.generation)
  assert.equal(fixture.session.turns.queuedCount, 0)
  assert.equal(fixture.session.pendingCheckpointUserMessageIds.length, 0)
  assert.equal(fixture.meta.status, 'idle')
  assert.equal(claudeRuntime.CLAUDE_MODEL_ATTEMPT_PROTOCOL, dependencies.calls.start[1].input.protocol)
}

async function verifyStaleAndDispose(claudeRuntime, harness) {
  const staleDependencies = fakeDependencies()
  const stale = harness.createSession({ dependencies: staleDependencies })
  const message = payload('stale generation', 'message-stale')
  stale.setRun(runFixture(stale.meta.id, [stepFixture('step-stale', message.messageId)]))
  await stale.session.pushUserMessage(message)
  const staleGeneration = stale.session.generation
  stale.session.advanceGeneration()
  await stale.session.handleMessage(resultMessage(), staleGeneration)
  assert.equal(staleDependencies.calls.complete.length, 0)
  await stale.session.pushUserMessage(message)
  assert.equal(staleDependencies.calls.start.length, 1)
  assert.equal(stale.providerHits(), 1)
  assert.match(stale.meta.lastError ?? '', /requires reconciliation/)

  const disposeDependencies = fakeDependencies()
  const tracker = new claudeRuntime.ClaudeModelAttemptTracker(disposeDependencies)
  const disposing = harness.createSession({ dependencies: disposeDependencies, tracker })
  const disposeMessage = payload('dispose generation', 'message-dispose')
  const disposeRun = runFixture(
    disposing.meta.id,
    [stepFixture('step-dispose', disposeMessage.messageId)]
  )
  disposing.setRun(disposeRun)
  await disposing.session.pushUserMessage(disposeMessage)
  await disposing.session.dispose()
  assert.equal(disposeDependencies.calls.complete.length, 0)

  const successor = harness.createSession({ dependencies: disposeDependencies, tracker })
  successor.setRun({
    ...disposeRun,
    sessionId: successor.meta.id,
    steps: disposeRun.steps.map((step) => ({ ...step, sessionId: successor.meta.id }))
  })
  await successor.session.pushUserMessage(disposeMessage)
  assert.equal(disposeDependencies.calls.start.length, 1)
  assert.equal(successor.providerHits(), 0)
  assert.match(successor.meta.lastError ?? '', /requires reconciliation/)
}

function loadAgentSession(
  runtime,
  claudeRuntime,
  sessionRuntime,
  resultRuntime,
  streamRuntime,
  electronStub
) {
  const AUTO_MODEL = 'auto'
  const providers = [providerFixture('provider-a', 'claude-fixed')]
  const runs = new Map()
  const settings = {
    autoSkillLearningEnabled: false,
    failoverEnabled: true,
    preventDisplaySleep: false,
    smartModelRoutingEnabled: false,
    schedulerStrategy: 'balanced',
    sandboxMode: 'workspace-write',
    persona: '',
    allowedTools: '',
    disallowedTools: ''
  }
  const taskRuntimeRegistry = {
    get: (sessionId) => runs.get(sessionId),
    set: (sessionId, run) => runs.set(sessionId, run),
    delete: (sessionId) => runs.delete(sessionId),
    clear: () => runs.clear()
  }
  const modules = createAgentSessionModules({
    AUTO_MODEL,
    providers,
    settings,
    taskRuntimeRegistry,
    runtime,
    claudeRuntime,
    sessionRuntime,
    resultRuntime,
    streamRuntime,
    electronStub
  })
  const AgentSession = evaluateAgentSession(modules)
  return createSessionFactory({ AUTO_MODEL, AgentSession, claudeRuntime, taskRuntimeRegistry, runs })
}

function createAgentSessionModules(context) {
  const noop = () => undefined
  const asyncNoop = async () => undefined
  return new Map([
    ['./pushable', { Pushable: StubPushable }],
    ['./transcript', { TranscriptWriter: StubTranscriptWriter }],
    ['./providers', {
      getProvider: (id) => context.providers.find((provider) => provider.id === id),
      listProviders: () => context.providers,
      markProviderKeyUsed: noop,
      recordProviderKeySuccess: noop,
      resolveProviderToken: () => ({ token: 'token-for-smoke-claude-canary', keyId: 'key-a', keyLabel: 'Key A' }),
      rotateProviderKey: () => undefined
    }],
    ['./providerRuntimeAuth', { applyClaudeProviderEnvironment: noop }],
    ['./provider/claudeRuntimePolicy', {
      assertClaudeRuntimeLaunchPolicy: noop,
      buildClaudeRuntimeEnvironment: () => ({}),
      createClaudeRuntimeLaunchPolicy: (env) => ({ env, settingSources: [], strictMcpConfig: true })
    }],
    ['./memoryInject', { buildMemorySystemAppend: async () => '' }],
    ['./agent/context-loader', { buildProjectContextSystemAppend: async () => '' }],
    ['./agent/context-compressor', {
      evaluateContextUsage: ({ usedTokens }) => ({
        usedTokens,
        windowTokens: 100_000,
        remainingTokens: 100_000 - usedTokens,
        usageRatio: usedTokens / 100_000,
        pressure: 'normal',
        shouldWarn: false
      })
    }],
    ['./sdkAgents', { loadSdkAgentDefinitions: () => undefined }],
    ['./checkpoints', { latestUserTextUuid: () => '' }],
    ['./model/claude-auto-route', { resolveClaudeAutoRoute: () => null }],
    ['./providerKeyRouting', { canRotateProviderKey: () => false }],
    ['./permission/audit-log', { writeAuditLog: noop }],
    ['./permission/tool-permission', { evaluateToolPermission: () => ({ risk: { level: 'low', reasons: [] } }) }],
    ['./task/task-runtime-registry', { taskRuntimeRegistry: context.taskRuntimeRegistry }],
    ['./task/claude-model-attempt-runtime', context.claudeRuntime],
    ['./task/claude-agent-session-runtime', context.sessionRuntime],
    ['./task/claude-result-runtime', context.resultRuntime],
    ['./task/claude-stream-failure-runtime', context.streamRuntime],
    ['./claude-user-message', {
      prepareClaudeUserMessage: async ({ payload, meta, lastProjectContextAppend }) => ({
        message: {
          type: 'user',
          message: {
            role: 'user',
            content: payload.text ? [{ type: 'text', text: payload.text }] : []
          },
          parent_tool_use_id: null,
          session_id: meta.sdkSessionId ?? ''
        },
        projectContextAppend: lastProjectContextAppend
      })
    }],
    ['./claude-sdk-loader', {
      claudeExecutablePath: () => undefined,
      loadClaudeSdk: async () => { throw new Error('SDK launch is outside the ModelAttempt smoke boundary') }
    }],
    ['./claude-session-codec', {
      asRecordInput: (value) => value && typeof value === 'object' ? value : {},
      compactUserAttachments: (images) => images,
      normalizeBlocks: (value) => Array.isArray(value) ? value : [],
      normalizeClaudeToolInput: (_name, input) => input,
      normalizeClaudeToolName: (name) => name,
      providerTokenFingerprint: () => 'model-attempt-smoke-fingerprint',
      splitList: (value) => String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean),
      toolResultText: (value) => typeof value === 'string' ? value : JSON.stringify(value),
      userMessageText: (payload) => payload.text
    }],
    ['./stable-message-payload', {
      normalizeStableMessagePayload: (input) => typeof input === 'string'
        ? { text: input.trim(), images: [] }
        : {
            text: typeof input.text === 'string' ? input.text.trim() : '',
            images: Array.isArray(input.images) ? input.images : [],
            ...(typeof input.messageId === 'string' && input.messageId.trim()
              ? { messageId: input.messageId.trim() }
              : {})
          }
    }],
    ['./task/effect-runtime', {
      cancelEffectExecution: asyncNoop,
      completeEffectExecution: asyncNoop,
      markEffectExecutionStarted: asyncNoop,
      prepareEffectExecution: async () => null
    }],
    ['./task/tool-idempotency', { isSideEffectingToolCall: () => false }],
    ['./digital-worker/tool-action-policy', {
      digitalWorkerToolPermissionDecision: (_meta, _tool, _input, _root, fallback) => fallback()
    }],
    ['./digital-worker/session-action-policy', { assertDigitalWorkerProviderDispatchAllowed: noop }],
    ['./permission/permission-manager', {
      decideGuiPermission: () => ({ kind: 'allow' }),
      GUI_TEMPORARY_GRANT_MESSAGE: '',
      grantTemporaryGuiAutomation: noop
    }],
    ['./scheduler', {
      classifyFailure: (message) => ({ switchable: true, label: String(message) }),
      pickFailoverTarget: () => undefined
    }],
    ['./settings', { getSettings: () => context.settings }],
    ['./model/drive', { settingsForCaoGenDrive: (value) => value }],
    ['../shared/types', { AUTO_MODEL: context.AUTO_MODEL }],
    ['./session-meta', { newSessionMeta: (options) => options }],
    ['electron', context.electronStub]
  ])
}

function evaluateAgentSession(modules) {
  const source = readFileSync(path.join(repoRoot, 'src/main/agentSession.ts'), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: 'agentSession.ts'
  }).outputText
  const module = { exports: {} }
  const localRequire = (request) => {
    if (modules.has(request)) return modules.get(request)
    if (request.startsWith('.')) throw new Error(`unmapped AgentSession dependency: ${request}`)
    return require(request)
  }
  new Function('require', 'module', 'exports', output)(localRequire, module, module.exports)
  return module.exports.AgentSession
}

function createSessionFactory(context) {
  let sessionSequence = 0
  return {
    AUTO_MODEL: context.AUTO_MODEL,
    createSession(options = {}) {
      sessionSequence += 1
      const sessionId = `session-${sessionSequence}`
      const meta = metaFixture(sessionId, options.model ?? 'claude-fixed')
      const events = []
      const providerMessages = []
      const dependencies = options.dependencies ?? fakeDependencies()
      const tracker = options.tracker ?? new context.claudeRuntime.ClaudeModelAttemptTracker(dependencies)
      const emit = (event) => {
        events.push(event)
        if (event.kind === 'user-message') {
          const run = context.runs.get(sessionId)
          if (run && !(run.steps ?? []).some((step) => step.messageId === event.messageId)) {
            run.steps ??= []
            run.steps.push(stepFixture(`step-${run.steps.length + 1}`, event.messageId, run.id, sessionId))
          }
        }
      }
      const session = new context.AgentSession(meta, emit, undefined, 0, tracker)
      session.input = {
        push(message) {
          providerMessages.push(message)
          options.onProviderPush?.(message)
        },
        end() {}
      }
      return {
        session,
        meta,
        events,
        tracker,
        dependencies,
        providerMessages,
        providerHits: () => providerMessages.length,
        setRun: (run) => context.taskRuntimeRegistry.set(sessionId, run),
        run: () => context.taskRuntimeRegistry.get(sessionId)
      }
    }
  }
}

function fakeDependencies(options = {}) {
  const calls = { start: [], complete: [], getRetryAuthorization: [], order: options.order ?? [] }
  let sequence = 0
  return {
    calls,
    now: () => 200 + sequence,
    randomId: () => `attempt-${++sequence}`,
    start: async (input, rootDir) => {
      calls.order.push('durable-start')
      calls.start.push({ input, rootDir })
      if (options.startError) throw options.startError
      return startedRecord(input)
    },
    complete: async (attemptId, input, rootDir) => {
      calls.order.push('durable-complete')
      calls.complete.push({ attemptId, input, rootDir })
      if (options.completeWait) await options.completeWait
      if (options.completeError) throw options.completeError
      const start = calls.start.find((call) => call.input.id === attemptId)
      assert(start, `missing start for ${attemptId}`)
      return { ...startedRecord(start.input), ...input, id: attemptId, revision: 2 }
    },
    getRetryAuthorization: async (query, rootDir) => {
      calls.getRetryAuthorization.push({ query, rootDir })
      return null
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

function metaFixture(id, model) {
  return {
    id,
    title: 'Smoke session',
    cwd: repoRoot,
    model,
    providerId: 'provider-a',
    permissionMode: 'bypassPermissions',
    status: 'idle',
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt: 1
  }
}

function providerFixture(id, model) {
  return {
    id,
    name: id,
    baseUrl: 'http://provider.invalid',
    customHeaders: '',
    credentialHeaderNames: [],
    models: [model],
    hasToken: true
  }
}

function runFixture(sessionId, steps) {
  const runId = `run-${sessionId}`
  return {
    schemaVersion: 1,
    id: runId,
    sessionId,
    taskId: sessionId,
    status: 'executing',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: 1,
    updatedAt: 1,
    steps: steps.map((step) => ({ ...step, runId, sessionId }))
  }
}

function stepFixture(id, messageId, runId = 'run-fixture', sessionId = 'session-fixture') {
  return {
    id,
    runId,
    sessionId,
    sequence: 1,
    status: 'executing',
    createdAt: 1,
    updatedAt: 1,
    messageId
  }
}

function payload(text, messageId) {
  return { text, images: [], messageId }
}

function resultMessage(overrides = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ok',
    usage: {},
    ...overrides
  }
}

function providerText(message) {
  return message.message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

function throwingQuery(error) {
  return {
    async *[Symbol.asyncIterator]() {
      throw error
    }
  }
}

function yieldingQuery(message) {
  return {
    async *[Symbol.asyncIterator]() {
      yield message
    }
  }
}

async function eventually(predicate, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => nativeSetTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function check(name, fn) {
  const startedAt = Date.now()
  await fn()
  checks.push({ name, status: 'pass', durationMs: Date.now() - startedAt })
}

function compileRuntime() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/task/model-attempt-runtime.ts',
    'src/main/task/claude-model-attempt-runtime.ts',
    'src/main/task/claude-agent-session-runtime.ts',
    'src/main/task/claude-result-runtime.ts',
    'src/main/task/claude-stream-failure-runtime.ts',
    '--outDir', runtimeOut,
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function loadRuntime(electronStub) {
  const originalLoad = Module._load
  try {
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'electron') return electronStub
      return originalLoad.call(this, request, parent, isMain)
    }
    return {
      runtime: require(findCompiled(runtimeOut, 'model-attempt-runtime.js')),
      claudeRuntime: require(findCompiled(runtimeOut, 'claude-model-attempt-runtime.js')),
      sessionRuntime: require(findCompiled(runtimeOut, 'claude-agent-session-runtime.js')),
      resultRuntime: require(findCompiled(runtimeOut, 'claude-result-runtime.js')),
      streamRuntime: require(findCompiled(runtimeOut, 'claude-stream-failure-runtime.js'))
    }
  } finally {
    Module._load = originalLoad
  }
}

function createElectronStub() {
  return {
    app: { getPath: () => userData, isPackaged: false },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => ''
    },
    powerSaveBlocker: {
      start: () => 1,
      stop() {},
      isStarted: () => false
    }
  }
}

function findCompiled(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledOrNull(fullPath, fileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  throw new Error(`compiled file not found: ${fileName}`)
}

function findCompiledOrNull(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledOrNull(fullPath, fileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  return null
}
