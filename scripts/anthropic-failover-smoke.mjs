#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const Module = require('node:module').Module
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-anthropic-failover-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
const checks = []

process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter)
Module._initPaths()

let runtime
let previousSettings
try {
  compileRuntime()
  runtime = loadRuntime()
  previousSettings = { ...runtime.settings.getSettings() }
  runtime.settings.updateSettings({ sandboxMode: 'restrictedLocal' })

  await check('401 and 429 rotate keys with linked successor Attempts', verifyKeyFailover)
  await check('503 switches only to credentialed Anthropic Providers', verifyProviderFailover)
  await check('tool execution is not repeated and the next logical request gets a new id', verifyToolLoopLineage)
  await check('unresolved Effects block every automatic replay', verifyEffectReplayBlock)
  await check('partial text or thinking deltas block automatic replay', verifyPartialDeltaBlock)
  await check('Attempt ledger failures block provider work or replay', verifyLedgerFailureBlock)
  await check('abort cancels without failover', verifyAbortBlock)
  await check('all attempted credentials remain redacted across a failover chain', verifyCredentialRedaction)

  console.log(JSON.stringify({ status: 'pass', checks }, null, 2))
} finally {
  runtime?.registry.taskRuntimeRegistry.clear()
  if (runtime && previousSettings) runtime.settings.updateSettings(previousSettings)
  rmSync(tempRoot, { recursive: true, force: true })
}

async function verifyKeyFailover() {
  for (const status of [401, 429]) {
    const infra = providerInfrastructure({
      primaryKeys: [
        [`primary-${status}-key-1`, `primary-${status}-secret-1`],
        [`primary-${status}-key-2`, `primary-${status}-secret-2`]
      ]
    })
    const requests = []
    const harness = await createHarness({
      id: `anthropic-key-${status}`,
      project: projectDirectory(`key-${status}`),
      messageIds: [`key-${status}-user`],
      infra,
      streamMessage: async (input) => {
        const token = credential(input)
        requests.push({ token, body: structuredClone(input.request) })
        if (requests.length === 1) throw new Error(`HTTP ${status}: provider echoed ${token}`)
        input.onText?.(`recovered-${status}`)
        return messageResult(`key-${status}-success`, `recovered-${status}`)
      }
    })

    try {
      harness.engine.send({ text: `recover key ${status}`, images: [], messageId: `key-${status}-user` })
      await waitForTurn(harness, `key ${status}`)
      assert.equal(requests.length, 2)
      assert.equal(requests[0].token, `primary-${status}-secret-1`)
      assert.equal(requests[1].token, `primary-${status}-secret-2`)
      assertAttemptSuccessor(harness.attempts.calls.start, 0, 1)
      assert.equal(harness.attempts.calls.complete[0].input.outcome, status === 401 ? 'auth_failed' : 'rate_limited')
      assert.equal(harness.attempts.calls.complete[1].input.outcome, 'success')
      const event = harness.events.find(({ event }) => event.kind === 'provider-key-failover')?.event
      assert(event && event.kind === 'provider-key-failover')
      assert.equal(event.fromKeyId, `primary-${status}-key-1`)
      assert.equal(event.toKeyId, `primary-${status}-key-2`)
      assert.equal(harness.events.some(({ event }) => event.kind === 'failover'), false)
      assert.equal(turnResult(harness).isError, false)
      assertNoCredentialLeak(harness, requests.map((item) => item.body), infra.tokens)
    } finally {
      await disposeHarness(harness)
    }
  }
}

async function verifyProviderFailover() {
  const infra = providerInfrastructure({
    primaryKeys: [['primary-key', 'primary-503-secret']],
    backupKeys: [['backup-key', 'backup-503-secret']],
    fallbackProviderId: 'openai-decoy'
  })
  const requests = []
  const harness = await createHarness({
    id: 'anthropic-provider-503',
    project: projectDirectory('provider-503'),
    messageIds: ['provider-503-user'],
    metaModel: 'auto',
    infra,
    streamMessage: async (input) => {
      const token = credential(input)
      requests.push({ token, body: structuredClone(input.request) })
      if (token === 'primary-503-secret') throw new Error(`HTTP 503: ${token}`)
      input.onText?.('backup recovered')
      return messageResult('provider-503-success', 'backup recovered')
    }
  })

  try {
    harness.engine.send({ text: 'recover provider', images: [], messageId: 'provider-503-user' })
    await waitForTurn(harness, 'provider 503')
    assert.deepEqual(requests.map((item) => item.token), ['primary-503-secret', 'backup-503-secret'])
    assertAttemptSuccessor(harness.attempts.calls.start, 0, 1)
    assert.deepEqual(
      infra.calls.pick[0].candidates.map((candidate) => candidate.id).sort(),
      ['anthropic-backup', 'anthropic-primary']
    )
    assert.equal(infra.calls.resolve.some((input) => input.providerId === 'openai-decoy'), false)
    assert.equal(infra.calls.resolve.some((input) => input.providerId === 'claude-decoy'), false)
    const failover = harness.events.find(({ event }) => event.kind === 'failover')?.event
    assert(failover && failover.kind === 'failover')
    assert.equal(failover.fromProviderId, 'anthropic-primary')
    assert.equal(failover.toProviderId, 'anthropic-backup')
    assert.equal(harness.meta.providerId, 'anthropic-backup')
    assert.equal(harness.meta.model, 'auto')
    assert.equal(harness.engine.resolvedModel, 'claude-backup')
    assert(harness.events.some(({ event }) =>
      event.kind === 'meta' && event.meta.providerId === 'anthropic-backup' && event.meta.model === 'auto'
    ))
    assert.equal(turnResult(harness).isError, false)
    assertNoCredentialLeak(harness, requests.map((item) => item.body), infra.tokens)
  } finally {
    await disposeHarness(harness)
  }
}

async function verifyToolLoopLineage() {
  const project = projectDirectory('tool-lineage')
  const outputPath = path.join(project, 'written-once.txt')
  const infra = providerInfrastructure({
    primaryKeys: [['primary-tool-key', 'primary-tool-secret']],
    backupKeys: [['backup-tool-key', 'backup-tool-secret']]
  })
  const requests = []
  const harness = await createHarness({
    id: 'anthropic-tool-lineage',
    project,
    messageIds: ['tool-lineage-user'],
    infra,
    streamMessage: async (input) => {
      const token = credential(input)
      requests.push({ token, body: structuredClone(input.request) })
      if (requests.length === 1) {
        return toolMessageResult('tool-lineage-call', 'write_file', {
          path: 'written-once.txt',
          content: 'durable write executed once\n'
        })
      }
      if (token === 'primary-tool-secret') throw new Error(`HTTP 503 ${token}`)
      input.onText?.('tool result accepted')
      return messageResult('tool-lineage-success', 'tool result accepted')
    }
  })

  try {
    harness.engine.send({ text: 'write then answer', images: [], messageId: 'tool-lineage-user' })
    await waitForTurn(harness, 'tool lineage')
    assert.equal(requests.length, 3)
    assert.equal(harness.events.filter(({ event }) => event.kind === 'tool-start').length, 1)
    assert.equal(harness.events.filter(({ event }) => event.kind === 'tool-result').length, 1)
    assert.equal(readFileSync(outputPath, 'utf8'), 'durable write executed once\n')
    const effects = currentRun(harness).effects ?? []
    assert.equal(effects.length, 1)
    assert.equal(effects[0].status, 'confirmed')
    assert.equal(effects[0].toolName, 'write_file')
    const starts = harness.attempts.calls.start
    assert.notEqual(starts[0].input.requestId, starts[1].input.requestId)
    assertAttemptSuccessor(starts, 1, 2)
    assert.deepEqual(requests[1].body.messages, requests[2].body.messages)
    const feedback = requests[2].body.messages.at(-1)
    assert.equal(feedback.role, 'user')
    assert.equal(feedback.content[0].tool_use_id, 'tool-lineage-call')
    assert.match(String(feedback.content[0].content), /written-once\.txt/)
    assert.equal(turnResult(harness).isError, false)
  } finally {
    await disposeHarness(harness)
  }
}

async function verifyEffectReplayBlock() {
  for (const status of ['prepared', 'executing', 'waiting_reconciliation']) {
    const infra = providerInfrastructure()
    let providerHits = 0
    const harness = await createHarness({
      id: `anthropic-effect-${status}`,
      project: projectDirectory(`effect-${status}`),
      messageIds: [`effect-${status}-user`],
      infra,
      streamMessage: async () => {
        providerHits += 1
        throw new Error('HTTP 503 replay must be blocked')
      }
    })
    currentRun(harness).effects = [{ status }]

    try {
      harness.engine.send({ text: `block ${status}`, images: [], messageId: `effect-${status}-user` })
      await waitForTurn(harness, `effect ${status}`)
      assert.equal(providerHits, 1)
      assert.equal(harness.attempts.calls.start.length, 1)
      assert.equal(infra.calls.rotate.length, 0)
      assert.equal(infra.calls.pick.length, 0)
      assert.equal(turnResult(harness).isError, true)
    } finally {
      await disposeHarness(harness)
    }
  }
}

async function verifyPartialDeltaBlock() {
  for (const deltaKind of ['text', 'thinking']) {
    const infra = providerInfrastructure()
    let resolveCountAtFailure = 0
    const harness = await createHarness({
      id: `anthropic-partial-${deltaKind}`,
      project: projectDirectory(`partial-${deltaKind}`),
      messageIds: [`partial-${deltaKind}-user`],
      infra,
      streamMessage: async (input) => {
        resolveCountAtFailure = infra.calls.resolve.length
        if (deltaKind === 'text') input.onText?.('partial text')
        else input.onThinking?.('partial thinking')
        throw new Error(`HTTP 503 partial ${deltaKind}`)
      }
    })

    try {
      harness.engine.send({
        text: `partial ${deltaKind}`,
        images: [],
        messageId: `partial-${deltaKind}-user`
      })
      await waitForTurn(harness, `partial ${deltaKind}`)
      assert.equal(harness.attempts.calls.start.length, 1)
      assert.equal(infra.calls.rotate.length, 0)
      assert.equal(infra.calls.pick.length, 0)
      assert.equal(infra.calls.resolve.length, resolveCountAtFailure)
      assert.equal(harness.events.some(({ event }) => event.kind === 'provider-key-failover'), false)
      assert.equal(harness.events.some(({ event }) => event.kind === 'failover'), false)
      assert(harness.events.some(({ event }) => event.kind === `${deltaKind}-delta`))
      assert.equal(turnResult(harness).isError, true)
    } finally {
      await disposeHarness(harness)
    }
  }
}

async function verifyLedgerFailureBlock() {
  for (const phase of ['start', 'complete']) {
    const infra = providerInfrastructure()
    let providerHits = 0
    const harness = await createHarness({
      id: `anthropic-ledger-${phase}`,
      project: projectDirectory(`ledger-${phase}`),
      messageIds: [`ledger-${phase}-user`],
      infra,
      attemptOptions: phase === 'start'
        ? { startError: new Error('start fsync failed') }
        : { completeError: new Error('complete fsync failed') },
      streamMessage: async () => {
        providerHits += 1
        throw new Error(`HTTP 503 ${infra.tokens[0]}`)
      }
    })

    try {
      harness.engine.send({ text: `ledger ${phase}`, images: [], messageId: `ledger-${phase}-user` })
      await waitForTurn(harness, `ledger ${phase}`)
      assert.equal(providerHits, phase === 'start' ? 0 : 1)
      assert.equal(infra.calls.rotate.length, 0)
      assert.equal(infra.calls.pick.length, 0)
      const result = turnResult(harness)
      assert.equal(result.isError, true)
      assert.equal(result.subtype, 'ledger-error')
      assertNoCredentialLeak(harness, [], infra.tokens)
    } finally {
      await disposeHarness(harness)
    }
  }
}

async function verifyAbortBlock() {
  const infra = providerInfrastructure()
  let providerStarted = false
  const harness = await createHarness({
    id: 'anthropic-abort-failover',
    project: projectDirectory('abort-failover'),
    messageIds: ['abort-failover-user'],
    infra,
    streamMessage: ({ signal }) => new Promise((resolve, reject) => {
      providerStarted = true
      signal.addEventListener('abort', () => {
        const error = new Error('request aborted')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    })
  })

  try {
    harness.engine.send({ text: 'abort without failover', images: [], messageId: 'abort-failover-user' })
    await eventually(() => providerStarted, 'abort provider start')
    await harness.engine.interrupt()
    await eventually(() => turnResults(harness.events).length === 1, 'abort turn result')
    assert.equal(harness.attempts.calls.start.length, 1)
    assert.equal(infra.calls.rotate.length, 0)
    assert.equal(infra.calls.pick.length, 0)
    assert.equal(turnResult(harness).subtype, 'interrupted')
  } finally {
    await disposeHarness(harness)
  }
}

async function verifyCredentialRedaction() {
  const infra = providerInfrastructure({
    primaryKeys: [
      ['chain-key-1', 'chain-secret-one'],
      ['chain-key-2', 'chain-secret-two']
    ],
    backupKeys: [['chain-backup-key', 'chain-secret-three']]
  })
  const requestBodies = []
  let hit = 0
  const harness = await createHarness({
    id: 'anthropic-credential-chain',
    project: projectDirectory('credential-chain'),
    messageIds: ['credential-chain-user'],
    infra,
    streamMessage: async (input) => {
      hit += 1
      const token = credential(input)
      requestBodies.push(structuredClone(input.request))
      const status = hit === 1 ? 401 : 503
      throw new Error(`HTTP ${status}: upstream echoed ${token}`)
    }
  })

  try {
    harness.engine.send({ text: 'exhaust recovery chain', images: [], messageId: 'credential-chain-user' })
    await waitForTurn(harness, 'credential chain')
    assert.equal(hit, 3)
    assert.equal(harness.events.filter(({ event }) => event.kind === 'provider-key-failover').length, 1)
    assert.equal(harness.events.filter(({ event }) => event.kind === 'failover').length, 1)
    assertAttemptSuccessor(harness.attempts.calls.start, 0, 1)
    assertAttemptSuccessor(harness.attempts.calls.start, 1, 2)
    assert.equal(turnResult(harness).isError, true)
    assertNoCredentialLeak(harness, requestBodies, infra.tokens)
    assert.equal(JSON.stringify(infra.calls.failure).includes('chain-secret'), false)
    assert.equal((harness.meta.lastError ?? '').includes('chain-secret'), false)
  } finally {
    await disposeHarness(harness)
  }
}

async function createHarness(options) {
  const meta = metaFixture(options.id, options.project, options.metaModel)
  const run = runFixture(options.id, options.messageIds)
  runtime.registry.taskRuntimeRegistry.set(meta.id, run)
  const attempts = fakeAttemptDependencies(options.attemptOptions)
  const events = []
  const dependencies = {
    ...options.infra.dependencies,
    getRun: () => runtime.registry.taskRuntimeRegistry.get(meta.id),
    modelAttempts: new runtime.attempt.AnthropicModelAttemptTracker(attempts),
    streamMessage: options.streamMessage
  }
  const engine = new runtime.engine.AnthropicEngine(
    meta,
    (event, seq, identity) => events.push({ event, seq, identity }),
    undefined,
    0,
    dependencies
  )
  await engine.start()
  const persisted = await runtime.snapshot.saveTaskSnapshot(runtime.snapshot.buildTaskSnapshot({
    meta,
    transcript: engine.getTranscript(),
    lastSeq: events.at(-1)?.seq ?? 0,
    lastEventKind: events.at(-1)?.event.kind,
    eventCount: events.length,
    reason: 'important-event',
    run
  }), userData)
  runtime.registry.taskRuntimeRegistry.set(meta.id, persisted.run ?? run)
  return { meta, engine, events, attempts, infra: options.infra }
}

function providerInfrastructure(options = {}) {
  const primaryKeys = options.primaryKeys ?? [['primary-key', 'primary-secret']]
  const backupKeys = options.backupKeys ?? [['backup-key', 'backup-secret']]
  const keys = new Map([
    ['anthropic-primary', primaryKeys.map(([id, token], index) => ({ id, token, label: `primary-${index + 1}` }))],
    ['anthropic-backup', backupKeys.map(([id, token], index) => ({ id, token, label: `backup-${index + 1}` }))]
  ])
  const active = new Map([['anthropic-primary', 0], ['anthropic-backup', 0]])
  const providers = [
    providerView('anthropic-primary', 'Primary Anthropic', 'anthropic', true, ['claude-primary']),
    providerView('anthropic-backup', 'Backup Anthropic', 'anthropic', true, ['claude-backup']),
    providerView('openai-decoy', 'OpenAI decoy', 'openai', true, ['gpt-decoy']),
    providerView('claude-decoy', 'Claude SDK decoy', 'claude', true, ['claude-decoy']),
    providerView('anthropic-no-token', 'Anthropic no token', 'anthropic', false, ['claude-empty'])
  ]
  const calls = {
    resolve: [], rotate: [], pick: [], used: [], keySuccess: [], failure: [], success: []
  }
  const resolveTarget = (input) => {
    calls.resolve.push({ ...input })
    const provider = providers.find((candidate) => candidate.id === input.providerId)
    const providerKeys = keys.get(input.providerId)
    if (!provider || !providerKeys?.length) throw new Error(`missing target ${input.providerId}`)
    const key = providerKeys[active.get(input.providerId) ?? 0]
    const model = input.model && input.model !== 'auto' ? input.model : provider.models[0]
    return {
      providerId: provider.id,
      providerName: provider.name,
      baseUrl: provider.baseUrl,
      endpoint: `${provider.baseUrl}/v1/messages`,
      model,
      headers: { 'content-type': 'application/json', 'x-api-key': key.token },
      token: key.token,
      keyId: key.id,
      keyLabel: key.label
    }
  }
  const rotate = (input) => {
    calls.rotate.push(input)
    const providerKeys = keys.get(input.providerId) ?? []
    const currentIndex = providerKeys.findIndex((key) => key.id === input.failedKeyId)
    const nextIndex = providerKeys.findIndex((key, index) =>
      index !== currentIndex && !input.excludedKeyIds?.has(key.id)
    )
    if (currentIndex < 0 || nextIndex < 0) return null
    active.set(input.providerId, nextIndex)
    return {
      providerId: input.providerId,
      providerName: providers.find((provider) => provider.id === input.providerId)?.name ?? input.providerId,
      fromKeyId: providerKeys[currentIndex].id,
      fromKeyLabel: providerKeys[currentIndex].label,
      toKeyId: providerKeys[nextIndex].id,
      toKeyLabel: providerKeys[nextIndex].label
    }
  }
  return {
    calls,
    tokens: [...keys.values()].flat().map((key) => key.token),
    dependencies: {
      resolveTarget,
      listProviders: () => structuredClone(providers),
      getSettings: () => ({
        failoverEnabled: true,
        fallbackProviderId: options.fallbackProviderId ?? 'anthropic-backup',
        fallbackModel: options.fallbackModel ?? 'claude-backup'
      }),
      rotateProviderKey: rotate,
      pickFailoverTarget: (input) => {
        calls.pick.push(input)
        return runtime.scheduler.pickFailoverTarget(input)
      },
      markProviderKeyUsed: (providerId, keyId) => calls.used.push({ providerId, keyId }),
      recordProviderKeySuccess: (providerId, keyId) => calls.keySuccess.push({ providerId, keyId }),
      recordFailure: (providerId, error) => calls.failure.push({ providerId, error }),
      recordSuccess: (providerId, latencyMs) => calls.success.push({ providerId, latencyMs })
    }
  }
}

function providerView(id, name, engine, hasToken, models) {
  return {
    id,
    name,
    engine,
    hasToken,
    models,
    baseUrl: `https://${id}.invalid`,
    budgetUsd: 0,
    createdAt: 1,
    credentialStorage: hasToken ? 'memory' : 'none'
  }
}

function credential(input) {
  return input.headers['x-api-key']
}

function messageResult(id, text) {
  return {
    id,
    text,
    thinking: '',
    contentBlocks: [{ type: 'text', text }],
    toolUses: [],
    stopReason: 'end_turn',
    usage: { input: 2, output: 1, cacheRead: 0, cacheCreation: 0 }
  }
}

function toolMessageResult(id, name, input) {
  const toolUse = { type: 'tool_use', id, name, input }
  return {
    id: `message-${id}`,
    text: '',
    thinking: '',
    contentBlocks: [toolUse],
    toolUses: [toolUse],
    stopReason: 'tool_use',
    usage: { input: 2, output: 1, cacheRead: 0, cacheCreation: 0 }
  }
}

function assertAttemptSuccessor(starts, predecessorIndex, successorIndex) {
  const predecessor = starts[predecessorIndex].input
  const successor = starts[successorIndex].input
  assert.equal(successor.requestId, predecessor.requestId)
  assert.equal(successor.failoverFromAttemptId, predecessor.id)
  assert.equal(typeof successor.routeReason, 'string')
  assert(successor.routeReason.trim().length > 0)
}

function assertNoCredentialLeak(harness, requestBodies, tokens) {
  const serialized = JSON.stringify({
    events: harness.events,
    attempts: harness.attempts.calls,
    requestBodies
  })
  for (const token of tokens) assert.equal(serialized.includes(token), false, `credential leaked: ${token}`)
}

function currentRun(harness) {
  const run = runtime.registry.taskRuntimeRegistry.get(harness.meta.id)
  assert(run)
  return run
}

async function disposeHarness(harness) {
  if (!harness) return
  await harness.engine.dispose().catch(() => undefined)
  runtime.registry.taskRuntimeRegistry.delete(harness.meta.id)
}

function metaFixture(id, project, model = 'claude-primary') {
  return {
    id,
    title: 'Anthropic failover smoke',
    cwd: project,
    model,
    providerId: 'anthropic-primary',
    engine: 'anthropic',
    permissionMode: 'bypassPermissions',
    status: 'idle',
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt: Date.now(),
    isolated: false,
    unassigned: true,
    digitalWorkerBinding: { kind: 'unscoped' }
  }
}

function runFixture(sessionId, messageIds) {
  const run = runtime.taskRun.createTaskRun({
    id: `run-${sessionId}`,
    sessionId,
    taskId: sessionId,
    digitalWorkerBinding: { kind: 'unscoped' }
  })
  return {
    ...run,
    status: 'executing',
    steps: messageIds.map((messageId, index) => ({
      id: `step-${sessionId}-${index + 1}`,
      runId: run.id,
      sessionId,
      sequence: index + 1,
      status: 'executing',
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      messageId
    }))
  }
}

function fakeAttemptDependencies(options = {}) {
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
      if (options.startError) throw options.startError
      return startedAttempt(input, calls.start.length)
    },
    complete: async (attemptId, input, rootDir) => {
      calls.complete.push({ attemptId, input, rootDir })
      if (options.completeError) throw options.completeError
      const start = calls.start.find((call) => call.input.id === attemptId)
      assert(start, `missing Attempt start for ${attemptId}`)
      return {
        ...startedAttempt(start.input, calls.start.indexOf(start) + 1),
        ...input,
        id: attemptId,
        revision: 2
      }
    }
  }
}

function startedAttempt(input, ordinal) {
  return {
    schemaVersion: 1,
    ...input,
    workItemId: 'work-item-anthropic-failover',
    ordinal,
    status: 'started',
    revision: 1,
    startCommandId: input.commandId,
    startPayloadDigest: 'a'.repeat(64),
    recordDigest: 'b'.repeat(64)
  }
}

function turnResults(events) {
  return events.filter(({ event }) => event.kind === 'turn-result').map(({ event }) => event)
}

function turnResult(harness) {
  const result = turnResults(harness.events)[0]
  assert(result)
  return result
}

async function waitForTurn(harness, label, timeoutMs = 10_000) {
  await eventually(() => turnResults(harness.events).length === 1, `${label} turn`, timeoutMs)
  await eventually(() => harness.engine.abort === null, `${label} cleanup`, timeoutMs)
}

async function eventually(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function check(name, fn) {
  const startedAt = Date.now()
  await fn()
  checks.push({ name, status: 'pass', durationMs: Date.now() - startedAt })
}

function projectDirectory(name) {
  const project = path.join(tempRoot, name)
  mkdirSync(project, { recursive: true })
  return project
}

function compileRuntime() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/anthropicEngine.ts',
    'src/main/task/anthropic-model-attempt-runtime.ts',
    'src/main/task/task-run.ts',
    'src/main/task/task-snapshot.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--types', 'node',
    '--lib', 'ES2022,DOM,DOM.Iterable',
    '--strict',
    '--skipLibCheck',
    '--esModuleInterop',
    '--resolveJsonModule'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function loadRuntime() {
  const originalLoad = Module._load
  try {
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'electron') return electronStub()
      return originalLoad.call(this, request, parent, isMain)
    }
    return {
      attempt: require(findCompiled(outDir, 'anthropic-model-attempt-runtime.js')),
      engine: require(findCompiled(outDir, 'anthropicEngine.js')),
      registry: require(findCompiled(outDir, 'task-runtime-registry.js')),
      scheduler: require(findCompiled(outDir, 'scheduler.js')),
      settings: require(findCompiled(outDir, 'settings.js')),
      snapshot: require(findCompiled(outDir, 'task-snapshot.js')),
      taskRun: require(findCompiled(outDir, 'task-run.js'))
    }
  } finally {
    Module._load = originalLoad
  }
}

function electronStub() {
  class BrowserWindow {
    static getAllWindows() { return [] }
    static getFocusedWindow() { return null }
  }
  return {
    app: {
      getPath: () => userData,
      getAppPath: () => repoRoot,
      getVersion: () => '1.0.0-smoke',
      isPackaged: false,
      focus() {}
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => ''
    },
    BrowserWindow,
    clipboard: { readText: () => '', writeText() {} },
    desktopCapturer: { getSources: async () => [] },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    screen: { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 } }) },
    shell: { openExternal: async () => undefined, openPath: async () => '' },
    systemPreferences: { isTrustedAccessibilityClient: () => false }
  }
}

function findCompiled(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledOptional(fullPath, fileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  throw new Error(`compiled file not found: ${fileName}`)
}

function findCompiledOptional(root, fileName) {
  try {
    return findCompiled(root, fileName)
  } catch {
    return null
  }
}
