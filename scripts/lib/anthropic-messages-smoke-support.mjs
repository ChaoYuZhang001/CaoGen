import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const Module = require('node:module').Module
export const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-anthropic-messages-'))
const outDir = path.join(tempRoot, 'compiled')
export const userData = path.join(tempRoot, 'user-data')
export const checks = []

process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter)
Module._initPaths()

export function cleanupSmokeRuntime() {
  rmSync(tempRoot, { recursive: true, force: true })
}

export function durableImageFixture(sessionId, bytes) {
  const hash = createHash('sha256').update(bytes).digest('hex')
  const directory = path.join(userData, 'attachments', sessionId)
  const filePath = path.join(directory, `${hash}.png`)
  mkdirSync(directory, { recursive: true })
  writeFileSync(filePath, bytes)
  return { hash, path: filePath, bytes: bytes.length }
}

export function storedTargetFixture(runtime) {
  const provider = providerFixture({
    id: 'provider-saved',
    name: 'Saved Anthropic',
    baseUrl: 'https://saved.example/gateway/v1',
    customHeaders: [
      'Anthropic-Beta: interleaved-thinking-2025-05-14',
      'X-Route: saved-route'
    ].join('\n'),
    credentialHeaderNames: undefined
  })
  const secret = 'secret-for-smoke-broker-canary'
  const ref = { providerId: provider.id, keyId: 'key-primary' }
  const broker = new runtime.broker.ProviderCredentialBroker({
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => ''
  })
  const record = broker.store(ref, secret)
  return {
    provider,
    secret,
    ref,
    dependencies: {
      getProvider: (id) => id === provider.id ? provider : undefined,
      resolveProviderToken: (savedProvider) => {
        assert.equal(savedProvider, provider)
        const resolution = broker.resolve(ref, record)
        return {
          token: resolution.token,
          keyId: ref.keyId,
          keyLabel: 'primary',
          storage: resolution.storage
        }
      }
    }
  }
}

export function targetDependencies(provider, token) {
  return {
    getProvider: (id) => id === provider.id ? provider : undefined,
    resolveProviderToken: () => ({ token, keyId: 'key-endpoint', keyLabel: 'endpoint' })
  }
}

export function providerFixture(overrides = {}) {
  return {
    id: 'provider-endpoint',
    name: 'Anthropic Provider',
    baseUrl: 'https://provider.example/v1',
    encryptedToken: 'opaque',
    models: ['claude-default'],
    customHeaders: '',
    credentialHeaderNames: ['x-api-key'],
    createdAt: 1,
    ...overrides
  }
}

export function messagesRequest(text) {
  return {
    model: 'claude-smoke',
    maxTokens: 1024,
    messages: [{ role: 'user', content: text }]
  }
}

export function messageStart(id, usage = validUsage({ input_tokens: 1, output_tokens: 0 })) {
  return {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      content: [],
      usage
    }
  }
}

export function blockStart(index, contentBlock) {
  return { type: 'content_block_start', index, content_block: contentBlock }
}

export function blockDelta(index, delta) {
  return { type: 'content_block_delta', index, delta }
}

export function toolBlockStart(index, id, name = 'read_file') {
  return blockStart(index, { type: 'tool_use', id, name, input: {} })
}

export function toolUseBlock(id, input, name = 'read_file') {
  return { type: 'tool_use', id, name, input }
}

export function toolInputDelta(index, partialJson) {
  return blockDelta(index, { type: 'input_json_delta', partial_json: partialJson })
}

export function blockStop(index) {
  return { type: 'content_block_stop', index }
}

export function messageDelta(reason, usage = { output_tokens: 1 }) {
  return {
    type: 'message_delta',
    delta: { stop_reason: reason, stop_sequence: null },
    usage
  }
}

export function validUsage(overrides = {}) {
  return { input_tokens: 3, output_tokens: 2, ...overrides }
}

export function jsonMessage(id, text) {
  return {
    id,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: validUsage()
  }
}

export function jsonContentFixture(runtime, content, callbacks = {}) {
  return runtime.adapter.streamAnthropicMessage({
    endpoint: 'https://provider.example/v1/messages',
    headers: {},
    request: messagesRequest('json content fixture'),
    signal: new AbortController().signal,
    ...callbacks,
    fetch: async () => new Response(JSON.stringify({
      id: 'msg-json-content',
      type: 'message',
      role: 'assistant',
      content,
      stop_reason: 'end_turn',
      usage: validUsage()
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  })
}

export function streamFixture(runtime, events) {
  return runtime.adapter.streamAnthropicMessage({
    endpoint: 'https://provider.example/v1/messages',
    headers: {},
    request: messagesRequest('stream fixture'),
    signal: new AbortController().signal,
    fetch: async () => sseResponse(events)
  })
}

export function jsonToolFixture(runtime, content) {
  return runtime.adapter.streamAnthropicMessage({
    endpoint: 'https://provider.example/v1/messages',
    headers: {},
    request: messagesRequest('json tool failure fixture'),
    signal: new AbortController().signal,
    fetch: async () => new Response(JSON.stringify({
      id: 'msg-json-tool-failure',
      type: 'message',
      role: 'assistant',
      content,
      stop_reason: 'tool_use',
      usage: validUsage()
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  })
}

export function listenServer(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('local HTTP test server did not bind a TCP port'))
        return
      }
      resolve(address.port)
    })
  })
}

export function closeServer(server) {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections?.()
  })
}

export function sseResponse(events, chunkSizes = []) {
  const encoder = new TextEncoder()
  const body = events.map((event) => [
    `event: ${event.type}`,
    `data: ${JSON.stringify(event)}`,
    '',
    ''
  ].join('\n')).join('')
  const bytes = encoder.encode(body)
  const chunks = []
  let offset = 0
  for (const size of chunkSizes) {
    if (offset >= bytes.length) break
    chunks.push(bytes.slice(offset, Math.min(bytes.length, offset + size)))
    offset += size
  }
  if (offset < bytes.length) chunks.push(bytes.slice(offset))
  if (chunks.length === 0) chunks.push(bytes)
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    }
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

export function fakeAttemptDependencies(options = {}) {
  const calls = { start: [], complete: [], getRetryAuthorization: [], order: options.order ?? [] }
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
      calls.order.push(`durable-start-${calls.start.length}`)
      if (options.startError) throw options.startError
      return startedAttempt(input, calls.start.length)
    },
    complete: async (attemptId, input, rootDir) => {
      calls.complete.push({ attemptId, input, rootDir })
      calls.order.push(`durable-complete-${calls.complete.length}`)
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
    workItemId: 'work-item-smoke',
    ordinal,
    status: 'started',
    revision: 1,
    startCommandId: input.commandId,
    startPayloadDigest: 'a'.repeat(64),
    recordDigest: 'b'.repeat(64)
  }
}

export function attemptInput(signal, run) {
  return {
    run,
    providerId: 'provider-attempt',
    model: 'claude-attempt',
    endpoint: 'https://provider.example/v1/messages',
    body: messagesRequest('attempt input'),
    signal,
    auth: {
      token: 'secret-for-smoke-attempt-canary',
      keyId: 'key-attempt',
      keyLabel: 'primary'
    }
  }
}

export function resultFixture() {
  return {
    id: 'msg-result',
    text: 'ok',
    thinking: '',
    stopReason: 'end_turn',
    usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }
  }
}

export function runFixture(sessionId, steps) {
  const runId = `run-${sessionId}`
  return {
    schemaVersion: 1,
    id: runId,
    sessionId,
    taskId: `task-${sessionId}`,
    digitalWorkerBinding: { kind: 'unscoped' },
    status: 'executing',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: 1,
    updatedAt: 1,
    steps: steps.map((step) => ({ ...step, runId, sessionId }))
  }
}

export function stepFixture(id, messageId) {
  return {
    id,
    runId: 'run-fixture',
    sessionId: 'session-fixture',
    sequence: 1,
    status: 'executing',
    createdAt: 1,
    updatedAt: 1,
    messageId
  }
}

export function metaFixture(id, providerId) {
  return {
    id,
    title: '新会话',
    cwd: repoRoot,
    model: 'claude-default',
    providerId,
    permissionMode: 'bypassPermissions',
    status: 'idle',
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt: 1,
    unassigned: true,
    digitalWorkerBinding: { kind: 'unscoped' }
  }
}

export async function eventually(predicate, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

export async function check(name, fn) {
  const startedAt = Date.now()
  await fn()
  checks.push({ name, status: 'pass', durationMs: Date.now() - startedAt })
}

export function compileRuntime() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/anthropicMessagesAdapter.ts',
    'src/main/provider/anthropicMessagesTarget.ts',
    'src/main/task/anthropic-model-attempt-runtime.ts',
    'src/main/native-tool-runtime.ts',
    'src/main/anthropicEngine.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--types', 'node',
    '--lib', 'ES2022,DOM,DOM.Iterable',
    '--skipLibCheck',
    '--esModuleInterop',
    '--strict'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

export function loadRuntime() {
  const originalLoad = Module._load
  try {
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'electron') return electronStub()
      return originalLoad.call(this, request, parent, isMain)
    }
    return {
      adapter: require(findCompiled(outDir, 'anthropicMessagesAdapter.js')),
      attempt: require(findCompiled(outDir, 'anthropic-model-attempt-runtime.js')),
      broker: require(findCompiled(outDir, 'providerCredentialBroker.js')),
      engine: require(findCompiled(outDir, 'anthropicEngine.js')),
      modelAttempt: require(findCompiled(outDir, 'model-attempt-runtime.js')),
      taskRuntimeRegistry: require(findCompiled(outDir, 'task-runtime-registry.js')).taskRuntimeRegistry,
      target: require(findCompiled(outDir, 'anthropicMessagesTarget.js'))
    }
  } finally {
    Module._load = originalLoad
  }
}

function electronStub() {
  return {
    app: { getPath: () => userData, isPackaged: false },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => ''
    }
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
