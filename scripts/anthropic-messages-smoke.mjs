#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  attemptInput,
  blockDelta,
  blockStart,
  blockStop,
  check,
  checks,
  cleanupSmokeRuntime,
  closeServer,
  compileRuntime,
  durableImageFixture,
  eventually,
  fakeAttemptDependencies,
  jsonContentFixture,
  jsonMessage,
  jsonToolFixture,
  listenServer,
  loadRuntime,
  messageDelta,
  messagesRequest,
  messageStart,
  metaFixture,
  providerFixture,
  resultFixture,
  runFixture,
  sseResponse,
  stepFixture,
  storedTargetFixture,
  streamFixture,
  targetDependencies,
  toolBlockStart,
  toolInputDelta,
  toolUseBlock,
  validUsage
} from './lib/anthropic-messages-smoke-support.mjs'

try {
  compileRuntime()
  const runtime = loadRuntime()

  await check('saved Provider binds target and Broker credential', () => verifySavedProviderBinding(runtime))
  await check('credentialed fetch rejects redirects without leaking headers', () => verifyCredentialRedirectRejected(runtime))
  await check('Messages endpoints are constructed canonically', () => verifyEndpointConstruction(runtime))
  await check('SSE preserves thinking/text order and usage', () => verifySseAndUsage(runtime))
  await check('redacted thinking stays opaque across JSON and SSE', () => verifyRedactedThinking(runtime))
  await check('invalid redacted thinking data and deltas fail closed', () => verifyRedactedThinkingFailures(runtime))
  await check('tool definitions and tool history serialize without credentials', () => verifyToolRequestAndSse(runtime))
  await check('malformed, duplicate, and unfinished tool streams fail closed', () => verifyToolProtocolFailures(runtime))
  await check('HTTP and malformed provider responses fail closed', () => verifyProviderFailures(runtime))
  await check('each HTTP request has a distinct durable Attempt', () => verifyAttemptLifecycle(runtime))
  await check('Attempt start failure blocks provider work', () => verifyStartBarrier(runtime))
  await check('interrupt settles the Attempt as cancelled', () => verifyInterrupt(runtime))
  await check('interrupt completion persistence failure remains an unknown durable boundary', () => verifyInterruptCompletionFailure(runtime))
  await check('unsettled begin remains started for crash recovery', () => verifyCrashUnknownBoundary(runtime))
  await check('Engine emits the canonical turn event chain without secrets', () => verifyEngineHarness(runtime))
  await check('Engine redacts credentials echoed by provider errors', () => verifyEngineErrorRedaction(runtime))
  await check('failed partial turns keep live and resumed history in parity', () => verifyFailedTurnHistoryParity(runtime))

  console.log(JSON.stringify({ status: 'pass', checks }, null, 2))
} finally {
  cleanupSmokeRuntime()
}

function verifySavedProviderBinding(runtime) {
  const fixture = storedTargetFixture(runtime)
  const target = runtime.target.resolveAnthropicMessagesTarget({
    providerId: fixture.provider.id,
    model: 'claude-sonnet-4-20250514',
    baseUrl: 'https://attacker.invalid/v1',
    token: 'wrong-token'
  }, fixture.dependencies)

  assert.equal(target.baseUrl, fixture.provider.baseUrl)
  assert.equal(target.endpoint, 'https://saved.example/gateway/v1/messages')
  assert.equal(target.model, 'claude-sonnet-4-20250514')
  assert.equal(target.headers['x-api-key'], fixture.secret)
  assert.equal(target.headers['anthropic-version'], '2023-06-01')
  assert.equal(target.headers['anthropic-beta'], 'interleaved-thinking-2025-05-14')
  assert.equal(target.headers['x-route'], 'saved-route')
  assert.equal(JSON.stringify(target.headers).includes('attacker'), false)
  assert.equal(target.keyId, fixture.ref.keyId)
  assert.equal(target.keyLabel, 'primary')
}

async function verifyCredentialRedirectRejected(runtime) {
  const received = { initial: null, redirected: null }
  const sink = createServer((request, response) => {
    received.redirected = request.headers
    request.resume()
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(jsonMessage('redirected-response', 'must not arrive')))
  })
  const sinkPort = await listenServer(sink)
  const redirect = createServer((request, response) => {
    received.initial = request.headers
    request.resume()
    response.writeHead(307, { location: `http://127.0.0.1:${sinkPort}/credential-sink` })
    response.end()
  })
  const redirectPort = await listenServer(redirect)

  try {
    await assert.rejects(() => runtime.adapter.streamAnthropicMessage({
      endpoint: `http://127.0.0.1:${redirectPort}/v1/messages`,
      headers: {
        'x-api-key': 'redirect-x-api-key-secret',
        authorization: 'Bearer redirect-authorization-secret',
        'x-auth-token': 'redirect-custom-secret'
      },
      request: messagesRequest('redirect must fail closed'),
      signal: new AbortController().signal
    }))
    assert.equal(received.initial?.['x-api-key'], 'redirect-x-api-key-secret')
    assert.equal(received.initial?.authorization, 'Bearer redirect-authorization-secret')
    assert.equal(received.initial?.['x-auth-token'], 'redirect-custom-secret')
    assert.equal(received.redirected, null, 'redirect target must not receive any request or credential header')
  } finally {
    await Promise.all([closeServer(redirect), closeServer(sink)])
  }
}

function verifyEndpointConstruction(runtime) {
  const cases = [
    ['https://api.example', 'https://api.example/v1/messages'],
    ['https://api.example/v1/', 'https://api.example/v1/messages'],
    ['https://api.example/proxy', 'https://api.example/proxy/v1/messages'],
    ['https://api.example/proxy/v1/messages/', 'https://api.example/proxy/v1/messages']
  ]
  for (const [baseUrl, endpoint] of cases) {
    const provider = providerFixture({ baseUrl })
    const target = runtime.target.resolveAnthropicMessagesTarget(
      { providerId: provider.id },
      targetDependencies(provider, 'endpoint-secret')
    )
    assert.equal(target.endpoint, endpoint)
  }
}

async function verifySseAndUsage(runtime) {
  const fixture = storedTargetFixture(runtime)
  const target = runtime.target.resolveAnthropicMessagesTarget(
    { providerId: fixture.provider.id },
    fixture.dependencies
  )
  const deltas = []
  const requests = []
  const request = messagesRequest('hello from smoke')
  const result = await runtime.adapter.streamAnthropicMessage({
    endpoint: target.endpoint,
    headers: target.headers,
    request,
    signal: new AbortController().signal,
    onThinking: (text) => deltas.push(`thinking:${text}`),
    onText: (text) => deltas.push(`text:${text}`),
    fetch: async (url, init) => {
      requests.push({ url, init })
      return sseResponse([
        messageStart('msg-smoke', { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 3 }),
        blockStart(0, { type: 'thinking', thinking: 'plan ' }),
        blockDelta(0, { type: 'thinking_delta', thinking: 'first' }),
        blockStop(0),
        blockStart(1, { type: 'text', text: 'answer ' }),
        blockDelta(1, { type: 'text_delta', text: 'now' }),
        blockStop(1),
        messageDelta('end_turn', { output_tokens: 7, cache_creation_input_tokens: 2 }),
        { type: 'message_stop' }
      ], [11, 37, 5, 83])
    }
  })

  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://saved.example/gateway/v1/messages')
  assert.equal(requests[0].init.method, 'POST')
  assert.equal(requests[0].init.headers['x-api-key'], fixture.secret)
  assert.equal(String(requests[0].init.body).includes(fixture.secret), false)
  assert.deepEqual(deltas, [
    'thinking:plan ',
    'thinking:first',
    'text:answer ',
    'text:now'
  ])
  assert.deepEqual(result, {
    id: 'msg-smoke',
    text: 'answer now',
    thinking: 'plan first',
    contentBlocks: [
      { type: 'thinking', thinking: 'plan first' },
      { type: 'text', text: 'answer now' }
    ],
    toolUses: [],
    stopReason: 'end_turn',
    usage: { input: 12, output: 7, cacheRead: 3, cacheCreation: 2 }
  })

  const jsonResult = await runtime.adapter.streamAnthropicMessage({
    endpoint: target.endpoint,
    headers: target.headers,
    request,
    signal: new AbortController().signal,
    fetch: async () => new Response(JSON.stringify(jsonMessage('msg-json', 'json answer')), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  })
  assert.deepEqual(jsonResult, {
    id: 'msg-json',
    text: 'json answer',
    thinking: '',
    contentBlocks: [{ type: 'text', text: 'json answer' }],
    toolUses: [],
    stopReason: 'end_turn',
    usage: { input: 3, output: 2, cacheRead: 0, cacheCreation: 0 }
  })
}

async function verifyRedactedThinking(runtime) {
  const sseData = 'opaque-sse-thinking-payload'
  const historyData = 'opaque-history-thinking-payload'
  const callbacks = []
  let sentBody
  const result = await runtime.adapter.streamAnthropicMessage({
    endpoint: 'https://provider.example/v1/messages',
    headers: {},
    request: {
      model: 'claude-redacted-smoke',
      maxTokens: 1024,
      messages: [
        { role: 'user', content: 'continue the prior answer' },
        { role: 'assistant', content: [{ type: 'redacted_thinking', data: historyData }] },
        { role: 'user', content: 'continue' }
      ]
    },
    signal: new AbortController().signal,
    onThinking: (text) => callbacks.push(`thinking:${text}`),
    onText: (text) => callbacks.push(`text:${text}`),
    fetch: async (_url, init) => {
      sentBody = JSON.parse(String(init.body))
      return sseResponse([
        messageStart('msg-redacted-sse'),
        blockStart(0, { type: 'redacted_thinking', data: sseData }),
        blockStop(0),
        blockStart(1, { type: 'text', text: 'visible ' }),
        blockDelta(1, { type: 'text_delta', text: 'answer' }),
        blockStop(1),
        messageDelta('end_turn', { output_tokens: 4 }),
        { type: 'message_stop' }
      ])
    }
  })

  assert.deepEqual(sentBody.messages[1].content, [{ type: 'redacted_thinking', data: historyData }])
  assert.deepEqual(callbacks, ['text:visible ', 'text:answer'])
  assert.equal(result.text, 'visible answer')
  assert.equal(result.thinking, '')
  assert.deepEqual(result.contentBlocks, [
    { type: 'redacted_thinking', data: sseData },
    { type: 'text', text: 'visible answer' }
  ])

  const jsonData = 'opaque-json-thinking-payload'
  const jsonCallbacks = []
  const jsonResult = await jsonContentFixture(runtime, [
    { type: 'redacted_thinking', data: jsonData },
    { type: 'text', text: 'json visible answer' }
  ], {
    onThinking: (text) => jsonCallbacks.push(`thinking:${text}`),
    onText: (text) => jsonCallbacks.push(`text:${text}`)
  })
  assert.deepEqual(jsonCallbacks, ['text:json visible answer'])
  assert.equal(jsonResult.text, 'json visible answer')
  assert.equal(jsonResult.thinking, '')
  assert.deepEqual(jsonResult.contentBlocks, [
    { type: 'redacted_thinking', data: jsonData },
    { type: 'text', text: 'json visible answer' }
  ])
}

async function verifyRedactedThinkingFailures(runtime) {
  for (const data of ['', '   ', null, 42, {}]) {
    await assert.rejects(
      () => jsonContentFixture(runtime, [{ type: 'redacted_thinking', data }]),
      (error) => error instanceof runtime.adapter.AnthropicMessagesProtocolError
        && error.message.includes('redacted_thinking data')
    )
    await assert.rejects(
      () => streamFixture(runtime, [
        messageStart('msg-redacted-invalid-data'),
        blockStart(0, { type: 'redacted_thinking', data })
      ]),
      (error) => error instanceof runtime.adapter.AnthropicMessagesProtocolError
        && error.message.includes('redacted_thinking data')
    )
  }

  const disallowedDeltas = [
    { type: 'thinking_delta', thinking: 'must not be accepted' },
    { type: 'signature_delta', signature: 'must not be accepted' },
    { type: 'text_delta', text: 'must not be accepted' },
    { type: 'input_json_delta', partial_json: '{}' }
  ]
  for (const delta of disallowedDeltas) {
    await assert.rejects(
      () => streamFixture(runtime, [
        messageStart(`msg-redacted-${delta.type}`),
        blockStart(0, { type: 'redacted_thinking', data: 'opaque-valid-payload' }),
        blockDelta(0, delta)
      ]),
      (error) => error instanceof runtime.adapter.AnthropicMessagesProtocolError
        && error.message.includes(`received ${delta.type} for redacted_thinking`)
    )
  }
}

async function verifyToolRequestAndSse(runtime) {
  const credential = 'tool-request-header-credential-canary'
  const tool = {
    name: 'read_file',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  }
  const request = {
    model: 'claude-tool-smoke', maxTokens: 2048, tools: [tool],
    messages: [
      { role: 'user', content: 'Read the prior file.' },
      { role: 'assistant', content: [toolUseBlock('tool-prior', { path: 'OLD.md' })] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-prior', content: 'old contents' }] }
    ]
  }
  let sentBody
  const textDeltas = []
  const result = await runtime.adapter.streamAnthropicMessage({
    endpoint: 'https://provider.example/v1/messages',
    headers: { 'x-api-key': credential, authorization: `Bearer ${credential}` },
    request,
    signal: new AbortController().signal,
    onText: (text) => textDeltas.push(text),
    fetch: async (_url, init) => {
      sentBody = JSON.parse(String(init.body))
      return sseResponse([
        messageStart('msg-tool-sse', { input_tokens: 21, output_tokens: 0 }),
        blockStart(0, { type: 'text', text: 'I will ' }),
        blockDelta(0, { type: 'text_delta', text: 'inspect it.' }),
        blockStop(0),
        toolBlockStart(1, 'tool-current', 'read_file'),
        toolInputDelta(1, '{"path":'), toolInputDelta(1, '"README.md","line":'), toolInputDelta(1, '42}'),
        blockStop(1),
        toolBlockStart(2, 'tool-empty', 'read_file'), blockStop(2),
        messageDelta('tool_use', { output_tokens: 9 }),
        { type: 'message_stop' }
      ], [1, 2, 17, 41, 7])
    }
  })
  assert.deepEqual(sentBody.tools, [tool])
  assert.deepEqual(sentBody.messages, request.messages)
  assert.equal(sentBody.stream, true)
  assert.equal(JSON.stringify(sentBody).includes(credential), false)
  assert.deepEqual(['headers', 'x-api-key', 'authorization'].filter((key) => Object.hasOwn(sentBody, key)), [])
  assert.deepEqual(textDeltas, ['I will ', 'inspect it.'])
  const toolUse = toolUseBlock('tool-current', { path: 'README.md', line: 42 })
  const emptyToolUse = toolUseBlock('tool-empty', {})
  assert.equal(result.text, 'I will inspect it.')
  assert.deepEqual(result.contentBlocks, [{ type: 'text', text: result.text }, toolUse, emptyToolUse])
  assert.deepEqual(result.toolUses, [toolUse, emptyToolUse])
  assert.equal(result.stopReason, 'tool_use')

  const jsonToolUse = toolUseBlock('tool-json', { path: 'result.txt', content: 'done' }, 'write_file')
  const jsonResult = await jsonToolFixture(runtime, [
    { type: 'thinking', thinking: 'Need to write.', signature: 'signed-thinking' }, jsonToolUse])
  assert.equal(jsonResult.thinking, 'Need to write.')
  assert.deepEqual(jsonResult.contentBlocks, [
    { type: 'thinking', thinking: jsonResult.thinking, signature: 'signed-thinking' }, jsonToolUse])
  assert.deepEqual(jsonResult.toolUses, [jsonToolUse])
}

async function verifyToolProtocolFailures(runtime) {
  const begun = (id) => [messageStart(`msg-${id}`), toolBlockStart(0, id)]
  const cases = [
    [[...begun('tool-malformed'), toolInputDelta(0, '{"path":'), blockStop(0)], 'not valid JSON'],
    [[...begun('tool-array'), toolInputDelta(0, '[]'), blockStop(0)], 'must be a JSON object'],
    [[...begun('tool-wrong-delta'), blockDelta(0, { type: 'text_delta', text: '{}' })],
      'received text_delta for tool_use'],
    [[...begun('tool-unfinished'), toolInputDelta(0, '{}')], 'before message_stop'],
    [[...begun('tool-duplicate'), toolInputDelta(0, '{}'), blockStop(0),
      toolBlockStart(1, 'tool-duplicate')], 'appeared more than once'],
    [[messageStart('msg-tool-index-gap'), toolBlockStart(1, 'tool-gap')], 'started out of order']
  ]
  for (const [events, expected] of cases) {
    await assert.rejects(
      () => streamFixture(runtime, events),
      (error) => error instanceof runtime.adapter.AnthropicMessagesProtocolError
        && error.message.includes(expected)
    )
  }
  const duplicate = toolUseBlock('tool-json-duplicate', {})
  await assert.rejects(
    () => jsonToolFixture(runtime, [duplicate, duplicate]),
    (error) => error instanceof runtime.adapter.AnthropicMessagesProtocolError
      && error.message.includes('appeared more than once')
  )
}

async function verifyProviderFailures(runtime) {
  for (const status of [401, 429, 503]) {
    await assert.rejects(
      () => runtime.adapter.streamAnthropicMessage({
        endpoint: 'https://provider.example/v1/messages',
        headers: {},
        request: messagesRequest('failure'),
        signal: new AbortController().signal,
        fetch: async () => new Response(
          JSON.stringify({ error: { message: `provider-${status}` } }),
          { status, headers: { 'content-type': 'application/json' } }
        )
      }),
      (error) => error instanceof runtime.adapter.AnthropicMessagesHttpError
        && error.status === status
        && error.message.includes(`provider-${status}`)
    )
  }

  await assert.rejects(
    () => streamFixture(runtime, [
      messageStart('msg-error'),
      { type: 'error', error: { message: 'stream exploded' } }
    ]),
    (error) => error instanceof runtime.adapter.AnthropicMessagesProtocolError
      && error.message.includes('stream exploded')
  )

  await assert.rejects(
    () => streamFixture(runtime, [
      messageStart('msg-truncated'),
      blockStart(0, { type: 'text', text: '' }),
      blockDelta(0, { type: 'text_delta', text: 'partial' })
    ]),
    (error) => error instanceof runtime.adapter.AnthropicMessagesProtocolError
      && error.message.includes('message_stop')
  )

  await assert.rejects(
    () => streamFixture(runtime, [{ type: 'message_stop' }]),
    (error) => error instanceof runtime.adapter.AnthropicMessagesProtocolError
      && error.message.includes('before message_start')
  )

  await assert.rejects(
    () => streamFixture(runtime, [
      messageDelta('end_turn', { output_tokens: 1 }),
      { type: 'message_stop' }
    ]),
    (error) => error instanceof runtime.adapter.AnthropicMessagesProtocolError
      && error.message.includes('before message_start')
  )

  await assert.rejects(
    () => streamFixture(runtime, [
      { type: 'message_start', message: { type: 'message', role: 'assistant', content: [], usage: validUsage() } },
      { type: 'message_stop' }
    ]),
    (error) => error instanceof runtime.adapter.AnthropicMessagesProtocolError
      && error.message.includes('message_start id')
  )

  await assert.rejects(
    () => runtime.adapter.streamAnthropicMessage({
      endpoint: 'https://provider.example/v1/messages',
      headers: {},
      request: messagesRequest('empty json response'),
      signal: new AbortController().signal,
      fetch: async () => new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }),
    (error) => error instanceof runtime.adapter.AnthropicMessagesProtocolError
      && error.message.includes('envelope')
  )

  const attemptDependencies = fakeAttemptDependencies()
  const tracker = new runtime.attempt.AnthropicModelAttemptTracker(attemptDependencies)
  const controller = new AbortController()
  tracker.startTurn('message-invalid-protocol-attempt')
  await assert.rejects(
    () => tracker.execute({
      ...attemptInput(controller.signal, runFixture('session-invalid-protocol-attempt', [
        stepFixture('step-invalid-protocol-attempt', 'message-invalid-protocol-attempt')
      ])),
      operation: () => streamFixture(runtime, [{ type: 'message_stop' }])
    }),
    (error) => error instanceof runtime.modelAttempt.ModelAttemptOperationError
  )
  assert.equal(attemptDependencies.calls.complete[0].input.status, 'failed')
  assert.equal(attemptDependencies.calls.complete[0].input.outcome, 'error')
}

async function verifyAttemptLifecycle(runtime) {
  const secret = 'secret-for-smoke-attempt-canary'
  const order = []
  const dependencies = fakeAttemptDependencies({ order })
  const tracker = new runtime.attempt.AnthropicModelAttemptTracker(dependencies)
  const run = runFixture('session-attempt', [
    stepFixture('step-exact', 'message-attempt'),
    stepFixture('step-newer-unfinished', 'another-message')
  ])
  tracker.startTurn('message-attempt')

  for (let index = 1; index <= 2; index += 1) {
    const controller = new AbortController()
    const request = messagesRequest(`attempt-${index}`)
    const result = await tracker.execute({
      run,
      providerId: 'provider-attempt',
      model: 'claude-attempt',
      endpoint: 'https://provider.example/v1/messages',
      body: request,
      signal: controller.signal,
      auth: { token: secret, keyId: 'key-attempt', keyLabel: 'primary' },
      operation: () => runtime.adapter.streamAnthropicMessage({
        endpoint: 'https://provider.example/v1/messages',
        headers: { 'x-api-key': secret },
        request,
        signal: controller.signal,
        fetch: async () => {
          order.push(`fetch-${index}`)
          return sseResponse([
            messageStart(`msg-${index}`, { input_tokens: index * 2, output_tokens: 0 }),
            blockStart(0, { type: 'text', text: '' }),
            blockDelta(0, { type: 'text_delta', text: `ok-${index}` }),
            blockStop(0),
            messageDelta('end_turn', { output_tokens: index }),
            { type: 'message_stop' }
          ])
        }
      })
    })
    assert.equal(result.text, `ok-${index}`)
  }

  assert.equal(dependencies.calls.start.length, 2)
  assert.equal(dependencies.calls.complete.length, 2)
  assert.notEqual(dependencies.calls.start[0].input.id, dependencies.calls.start[1].input.id)
  assert.notEqual(dependencies.calls.start[0].input.requestId, dependencies.calls.start[1].input.requestId)
  for (const call of dependencies.calls.start) {
    assert.equal(call.input.stepId, 'step-exact')
    assert.equal(call.input.protocol, 'anthropic.messages')
    assert.equal(call.input.adapterVersion, 'anthropic-messages-v1')
    assert.match(call.input.keyLabel, /^sha256:[0-9a-f]{64}$/)
  }
  assert(order.indexOf('durable-start-1') < order.indexOf('fetch-1'))
  assert(order.indexOf('durable-start-2') < order.indexOf('fetch-2'))
  assert.deepEqual(dependencies.calls.complete[0].input.usage, {
    inputTokens: 2,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0
  })
  assert.equal(JSON.stringify(dependencies.calls).includes(secret), false)
}

async function verifyStartBarrier(runtime) {
  let providerHits = 0
  const dependencies = fakeAttemptDependencies({ startError: new Error('start fsync failed') })
  const tracker = new runtime.attempt.AnthropicModelAttemptTracker(dependencies)
  const controller = new AbortController()
  tracker.startTurn('message-start-failure')
  await assert.rejects(
    () => tracker.execute({
      ...attemptInput(controller.signal, runFixture('session-start-failure', [
        stepFixture('step-start-failure', 'message-start-failure')
      ])),
      operation: async () => {
        providerHits += 1
        return resultFixture()
      }
    }),
    (error) => error instanceof runtime.modelAttempt.ModelAttemptPersistenceError
      && error.phase === 'start'
      && error.operationStarted === false
  )
  assert.equal(providerHits, 0)
  assert.equal(dependencies.calls.complete.length, 0)
}

async function verifyInterrupt(runtime) {
  const dependencies = fakeAttemptDependencies()
  const tracker = new runtime.attempt.AnthropicModelAttemptTracker(dependencies)
  const controller = new AbortController()
  let providerStarted = false
  tracker.startTurn('message-interrupt')
  const execution = tracker.execute({
    ...attemptInput(controller.signal, runFixture('session-interrupt', [
      stepFixture('step-interrupt', 'message-interrupt')
    ])),
    operation: () => new Promise((resolve, reject) => {
      providerStarted = true
      controller.signal.addEventListener('abort', () => {
        const error = new Error('request aborted')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    })
  })
  await eventually(() => providerStarted, 'provider start before interrupt')
  controller.abort()
  await assert.rejects(
    execution,
    (error) => error instanceof runtime.modelAttempt.ModelAttemptOperationError
  )
  assert.equal(dependencies.calls.complete.length, 1)
  assert.equal(dependencies.calls.complete[0].input.status, 'cancelled')
  assert.equal(dependencies.calls.complete[0].input.outcome, 'cancelled')
}

async function verifyInterruptCompletionFailure(runtime) {
  const fixture = storedTargetFixture(runtime)
  const target = runtime.target.resolveAnthropicMessagesTarget(
    { providerId: fixture.provider.id },
    fixture.dependencies
  )
  const dependencies = fakeAttemptDependencies({ completeError: new Error('complete fsync failed') })
  const events = []
  const messageId = 'message-interrupt-complete-failure'
  const meta = metaFixture('session-interrupt-complete-failure', fixture.provider.id)
  const run = registerRun(
    runtime,
    runFixture(meta.id, [stepFixture('step-interrupt-complete-failure', messageId)])
  )
  let providerStarted = false
  const engine = new runtime.engine.AnthropicEngine(
    meta,
    (event) => events.push(event),
    undefined,
    0,
    {
      resolveTarget: () => target,
      getRun: () => run,
      modelAttempts: new runtime.attempt.AnthropicModelAttemptTracker(dependencies),
      streamMessage: ({ signal }) => new Promise((resolve, reject) => {
        providerStarted = true
        signal.addEventListener('abort', () => {
          const error = new Error('request aborted')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    }
  )

  await engine.start()
  engine.send({ text: 'interrupt with broken completion', images: [], messageId })
  await eventually(() => providerStarted, 'provider start before completion failure interrupt')
  await engine.interrupt()

  const result = events.find((event) => event.kind === 'turn-result')
  assert(result && result.kind === 'turn-result')
  assert.equal(result.isError, true)
  assert.equal(result.subtype, 'ledger-error')
  assert.match(result.resultText ?? '', /账本完成落盘失败/)
  assert.doesNotMatch(result.resultText ?? '', /^已中断$/)
  assert.equal(dependencies.calls.complete.length, 1)
  assert.equal(dependencies.calls.start.length, 1)
  await engine.dispose()
}

async function verifyCrashUnknownBoundary(runtime) {
  const dependencies = fakeAttemptDependencies()
  const tracker = new runtime.attempt.AnthropicModelAttemptTracker(dependencies)
  const controller = new AbortController()
  tracker.startTurn('message-crash')
  const handle = await tracker.begin(attemptInput(
    controller.signal,
    runFixture('session-crash', [stepFixture('step-crash', 'message-crash')])
  ))
  assert.equal(handle.attempt.status, 'started')
  assert.equal(dependencies.calls.start.length, 1)
  assert.equal(dependencies.calls.complete.length, 0)
}

async function verifyEngineHarness(runtime) {
  const fixture = storedTargetFixture(runtime)
  const target = runtime.target.resolveAnthropicMessagesTarget(
    { providerId: fixture.provider.id },
    fixture.dependencies
  )
  const attemptDependencies = fakeAttemptDependencies()
  const tracker = new runtime.attempt.AnthropicModelAttemptTracker(attemptDependencies)
  const events = []
  const requests = []
  const messageId = 'message-engine'
  const followupMessageId = 'message-engine-followup'
  const meta = metaFixture('session-engine', fixture.provider.id)
  const run = registerRun(runtime, runFixture(meta.id, [
    stepFixture('step-engine', messageId),
    stepFixture('step-engine-followup', followupMessageId)
  ]))
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const image = durableImageFixture(meta.id, imageBytes)
  const engine = new runtime.engine.AnthropicEngine(
    meta,
    (event, seq, identity) => events.push({ event, seq, identity }),
    undefined,
    0,
    {
      resolveTarget: () => target,
      getRun: () => run,
      modelAttempts: tracker,
      streamMessage: async (input) => {
        requests.push(input)
        input.onThinking?.('inspect')
        input.onText?.('completed')
        return {
          id: 'msg-engine',
          text: 'completed',
          thinking: 'inspect',
          contentBlocks: [
            { type: 'thinking', thinking: 'inspect', signature: 'signed-engine-thinking' },
            { type: 'text', text: 'completed' }
          ],
          toolUses: [],
          stopReason: 'end_turn',
          usage: { input: 9, output: 4, cacheRead: 1, cacheCreation: 2 }
        }
      }
    }
  )

  await engine.start()
  engine.send({
    text: 'engine request',
    images: [{
      id: image.hash,
      hash: image.hash,
      path: image.path,
      mime: 'image/png',
      bytes: image.bytes,
      createdAt: '2026-07-21T00:00:00.000Z'
    }],
    messageId
  })
  await eventually(
    () => events.some(({ event }) => event.kind === 'turn-result'),
    'Anthropic Engine turn result'
  )
  await eventually(() => engine.abort === null, 'Anthropic Engine first turn cleanup')
  engine.send({ text: 'follow up', images: [], messageId: followupMessageId })
  await eventually(
    () => events.filter(({ event }) => event.kind === 'turn-result').length === 2,
    'Anthropic Engine follow-up result'
  )

  const kinds = events.map(({ event }) => event.kind)
  for (const kind of [
    'init',
    'user-message',
    'thinking-delta',
    'text-delta',
    'assistant-message',
    'turn-result'
  ]) {
    assert(kinds.includes(kind), `missing Engine event ${kind}`)
  }
  assert.equal(requests.length, 2)
  assert.equal(requests[0].headers['x-api-key'], fixture.secret)
  assert.equal(attemptDependencies.calls.start.length, 2)
  assert.equal(attemptDependencies.calls.complete[0].input.status, 'succeeded')
  const retainedImageContent = requests[1].request.messages[0].content
  assert(Array.isArray(retainedImageContent))
  assert.equal(retainedImageContent.some((block) => block.type === 'image'), true)
  assert.equal(JSON.stringify(events).includes(fixture.secret), false)
  assert.equal(JSON.stringify(attemptDependencies.calls).includes(fixture.secret), false)
  assert.equal(JSON.stringify(requests[0].request).includes(fixture.secret), false)
  await engine.dispose()
}

async function verifyEngineErrorRedaction(runtime) {
  const fixture = storedTargetFixture(runtime)
  const target = runtime.target.resolveAnthropicMessagesTarget(
    { providerId: fixture.provider.id },
    fixture.dependencies
  )
  const attemptDependencies = fakeAttemptDependencies()
  const events = []
  const messageId = 'message-engine-error'
  const meta = metaFixture('session-engine-error', fixture.provider.id)
  const run = registerRun(runtime, runFixture(meta.id, [stepFixture('step-engine-error', messageId)]))
  const engine = new runtime.engine.AnthropicEngine(
    meta,
    (event) => events.push(event),
    undefined,
    0,
    {
      resolveTarget: () => target,
      getRun: () => run,
      modelAttempts: new runtime.attempt.AnthropicModelAttemptTracker(attemptDependencies),
      streamMessage: async () => {
        throw new Error(`HTTP 401 provider echoed ${fixture.secret}`)
      }
    }
  )

  await engine.start()
  engine.send({ text: 'trigger provider error', images: [], messageId })
  await eventually(
    () => events.some((event) => event.kind === 'turn-result'),
    'Anthropic Engine redacted error result'
  )

  assert.equal(JSON.stringify(events).includes(fixture.secret), false)
  assert.equal((meta.lastError ?? '').includes(fixture.secret), false)
  assert.match(meta.lastError ?? '', /\[REDACTED\]/)
  assert.equal(attemptDependencies.calls.complete[0].input.outcome, 'auth_failed')
  await engine.dispose()
}

async function verifyFailedTurnHistoryParity(runtime) {
  const fixture = storedTargetFixture(runtime)
  const target = runtime.target.resolveAnthropicMessagesTarget(
    { providerId: fixture.provider.id },
    fixture.dependencies
  )
  const dependencies = fakeAttemptDependencies()
  const tracker = new runtime.attempt.AnthropicModelAttemptTracker(dependencies)
  const events = []
  const requests = []
  const firstMessageId = 'message-partial-failure'
  const followupMessageId = 'message-after-partial-failure'
  const meta = metaFixture('session-partial-history', fixture.provider.id)
  const run = registerRun(runtime, runFixture(meta.id, [
    stepFixture('step-partial-failure', firstMessageId),
    stepFixture('step-after-partial-failure', followupMessageId)
  ]))
  let operationCount = 0
  const engine = new runtime.engine.AnthropicEngine(
    meta,
    (event, seq) => events.push({ event, seq }),
    undefined,
    0,
    {
      resolveTarget: () => target,
      getRun: () => run,
      modelAttempts: tracker,
      streamMessage: async (input) => {
        operationCount += 1
        requests.push(input.request)
        if (operationCount === 1) {
          input.onText?.('partial response that must not replay')
          throw new runtime.adapter.AnthropicMessagesProtocolError('stream ended before message_stop')
        }
        input.onText?.('recovered answer')
        return {
          id: 'msg-recovered',
          text: 'recovered answer',
          thinking: '',
          stopReason: 'end_turn',
          usage: { input: 4, output: 2, cacheRead: 0, cacheCreation: 0 }
        }
      }
    }
  )

  await engine.start()
  engine.send({ text: 'partial request', images: [], messageId: firstMessageId })
  await eventually(
    () => events.some(({ event }) => event.kind === 'turn-result' && event.isError),
    'failed partial turn result'
  )
  await eventually(() => engine.abort === null, 'failed partial turn cleanup')
  assert.equal(events.some(({ event }) => event.kind === 'assistant-message'), false)
  assert.deepEqual(engine.history, [])
  assert.equal(dependencies.calls.complete[0].input.status, 'failed')
  assert.equal(dependencies.calls.complete[0].input.outcome, 'error')

  engine.send({ text: 'follow up after failure', images: [], messageId: followupMessageId })
  await eventually(
    () => events.filter(({ event }) => event.kind === 'turn-result').length === 2,
    'follow-up turn result after partial failure'
  )
  await eventually(() => engine.abort === null, 'follow-up turn cleanup after partial failure')

  assert.equal(requests.length, 2)
  assert.deepEqual(requests[1].messages, [{
    role: 'user',
    content: [{ type: 'text', text: 'follow up after failure' }]
  }])
  const liveHistory = structuredClone(engine.history)
  assert.equal(JSON.stringify(liveHistory).includes('partial request'), false)
  assert.equal(JSON.stringify(liveHistory).includes('partial response'), false)
  assert.equal(events.filter(({ event }) => event.kind === 'assistant-message').length, 1)

  const resumeSdkSessionId = meta.sdkSessionId
  assert(resumeSdkSessionId)
  const lastSeq = Math.max(...events.map(({ seq }) => seq))
  await engine.dispose()
  const resumed = new runtime.engine.AnthropicEngine(
    metaFixture(meta.id, fixture.provider.id),
    () => undefined,
    resumeSdkSessionId,
    lastSeq,
    {
      resolveTarget: () => target,
      getRun: () => run,
      modelAttempts: new runtime.attempt.AnthropicModelAttemptTracker(fakeAttemptDependencies())
    }
  )
  assert.deepEqual(resumed.history, liveHistory)
  assert.equal(JSON.stringify(resumed.history).includes('partial'), false)
  await resumed.dispose()
}

function registerRun(runtime, run) {
  runtime.taskRuntimeRegistry.set(run.sessionId, run)
  return run
}
