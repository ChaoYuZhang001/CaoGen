#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const startedAt = new Date().toISOString()
const runId = startedAt.replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'protocol-adapter-boundary')
const reportDir = path.join(reportRoot, runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-protocol-adapter-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
const projectDir = path.join(tempRoot, 'project')
const require = createRequire(import.meta.url)
const checks = []
const engines = []
let restoreModuleLoad = () => undefined
let result
let failure

process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter)
require('node:module').Module._initPaths()
mkdirSync(userData, { recursive: true })
mkdirSync(projectDir, { recursive: true })

try {
  compileHarness()
  restoreModuleLoad = installElectronStub()
  const engineModule = require(compiled('main/engine.js'))
  const enginesModule = require(compiled('main/engines.js'))
  const runtimeModule = require(compiled('main/native-runtime-contract.js'))
  const boundModule = require(compiled('main/native-runtime-engine.js'))
  const anthropicModule = require(compiled('main/protocol-adapters/anthropic-messages.js'))
  const claudeModule = require(compiled('main/protocol-adapters/claude-agent-sdk.js'))
  const openaiModule = require(compiled('main/protocol-adapters/openai-compatible.js'))

  enginesModule.registerBuiltinEngines()
  verifyFactoryBindings(engineModule, boundModule)
  checks.push('three-production-factories-bind-protocol-adapters')
  checks.push('production-request-and-event-boundaries-fail-closed')
  verifyResumeSequenceBootstrap(engineModule)
  checks.push('production-resume-sequence-bootstraps-from-transcript')

  verifyFactoryMismatch(engineModule, runtimeModule, claudeModule)
  checks.push('runtime-protocol-identity-mismatch-fails-closed')

  verifyAnthropicAdapter(anthropicModule.ANTHROPIC_MESSAGES_PROTOCOL_ADAPTER)
  checks.push('anthropic-request-stream-tool-usage-error-normalization')
  checks.push('anthropic-malformed-tool-input-fails-closed')

  verifyOtherAdapters(
    claudeModule.CLAUDE_AGENT_SDK_PROTOCOL_ADAPTER,
    openaiModule.OPENAI_COMPATIBLE_PROTOCOL_ADAPTER
  )
  checks.push('claude-and-openai-adapter-regression-boundaries')

  const remainingOwners = verifyPartialIsolation()
  checks.push('remaining-engine-protocol-ownership-recorded')
  result = {
    status: 'PASS',
    boundaryStatus: 'passed',
    isolationStatus: 'partial',
    checks,
    adapters: engineModule.listProtocolAdapters().map(adapterIdentity),
    remainingEngineProtocolOwners: remainingOwners,
    limitation: 'Raw provider stream parsing and fragmented tool-call assembly still live inside the three engines.'
  }
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  failure = serializeError(error)
  throw error
} finally {
  await Promise.allSettled(engines.map((engine) => engine.dispose()))
  restoreModuleLoad()
  rmSync(tempRoot, { recursive: true, force: true })
  writeReport({
    schemaVersion: 1,
    status: result ? 'passed' : 'failed',
    gate: 'test:protocol-adapter-boundary:required',
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    result: result ?? null,
    error: failure ?? null
  })
}

function verifyFactoryBindings(engineModule, boundModule) {
  const adapters = engineModule.listProtocolAdapters()
  assert.deepEqual(adapters.map((adapter) => adapter.engineKind), ['claude', 'anthropic', 'openai'])
  assert.deepEqual(adapters.map((adapter) => adapter.protocol), [
    'claude.agent-sdk', 'anthropic.messages', 'openai.compatible'
  ])
  for (const adapter of adapters) {
    assert.equal(Object.isFrozen(adapter), true)
    const emitted = []
    const meta = sessionMeta(adapter.engineKind)
    const engine = engineModule.createEngine(
      adapter.engineKind,
      meta,
      (event) => emitted.push(event)
    )
    engines.push(engine)
    assert.equal(boundModule.isNativeRuntimeBoundEngine(engine), true)
    assert.equal(engine.protocolAdapter, adapter)
    assert.equal(engine.nativeRuntimeAdapter.protocol, adapter.protocol)
    engine.emitSyntheticEvent({ kind: 'status', status: 'idle' })
    assert.deepEqual(emitted, [{ kind: 'status', status: 'idle' }])
    rejectsCode(() => engine.send({ text: 42 }), 'request_shape')
    rejectsCode(
      () => engine.emitSyntheticEvent({
        kind: 'assistant-message',
        blocks: [{ type: 'tool_use', id: '', name: 'invalid_tool', input: {} }]
      }),
      'protocol_shape'
    )
    assert.equal(emitted.length, 1)
  }
}

function verifyFactoryMismatch(engineModule, runtimeModule, claudeModule) {
  assert.throws(
    () => engineModule.registerEngine({
      kind: 'anthropic',
      label: 'forged factory',
      available: () => true,
      nativeRuntime: runtimeModule.ANTHROPIC_NATIVE_RUNTIME_ADAPTER,
      protocolAdapter: claudeModule.CLAUDE_AGENT_SDK_PROTOCOL_ADAPTER,
      create: () => { throw new Error('must not create forged engine') }
    }),
    (error) => error?.code === 'adapter_identity'
  )
}

function verifyResumeSequenceBootstrap(engineModule) {
  const sdkSessionId = 'protocol-resume-fixture'
  const transcriptDir = path.join(userData, 'transcripts')
  mkdirSync(transcriptDir, { recursive: true })
  writeFileSync(path.join(transcriptDir, `${sdkSessionId}.jsonl`), `${JSON.stringify({
    schemaVersion: 1,
    streamId: 'resume-stream',
    eventId: 'resume-event-5',
    seq: 5,
    occurredAt: 5,
    event: { kind: 'user-message', text: 'resume context', messageId: 'resume-message' }
  })}\n`, 'utf8')
  const emitted = []
  const engine = engineModule.createEngine(
    'claude',
    sessionMeta('claude'),
    (event, seq) => emitted.push({ event, seq }),
    sdkSessionId
  )
  engines.push(engine)
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].event.kind, 'init')
  assert.equal(emitted[0].seq, 6)
  assert.equal(engine.getNativeRuntimeSnapshot().cursor.seq, 6)
  assert.equal(engine.getNativeRuntimeSnapshot().recovery.hydratedEvents, 1)
}

function verifyAnthropicAdapter(adapter) {
  assert.deepEqual(adapter.decodeStreamChunk({
    type: 'message_start',
    message: { usage: { input_tokens: 9, output_tokens: 0, cache_read_input_tokens: 2 } }
  }), [{ kind: 'usage', usage: { input: 9, output: 0, cacheRead: 2, cacheCreation: 0 } }])
  assert.deepEqual(adapter.decodeStreamChunk({
    type: 'content_block_delta',
    delta: { type: 'text_delta', text: 'hello' }
  }), [{ kind: 'text', text: 'hello' }])
  assert.deepEqual(adapter.decodeStreamChunk({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 4 }
  }), [
    { kind: 'usage', usage: { input: 0, output: 4, cacheRead: 0, cacheCreation: 0 } },
    { kind: 'done', stopReason: 'end_turn' }
  ])
  const completed = adapter.decodeStreamChunk({
    type: 'message',
    content: [
      { type: 'text', text: 'done' },
      { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'README.md' } }
    ],
    usage: { input_tokens: 9, output_tokens: 4 },
    stop_reason: 'tool_use'
  })
  assert.equal(completed[0].kind, 'text')
  assert.deepEqual(completed[1], {
    kind: 'tool',
    tool: { id: 'tool-1', name: 'read_file', input: { path: 'README.md' } }
  })
  assert.equal(completed.at(-1)?.kind, 'done')
  assert.deepEqual(adapter.decodeStreamChunk({
    type: 'content_block_start',
    content_block: { type: 'tool_use', id: 'tool-stream', name: 'read_file', input: {} }
  }), [])
  assert.deepEqual(adapter.normalizeError({
    status: 429,
    error: { type: 'rate_limit_error', message: 'slow down' }
  }), {
    code: 'rate_limit_error', message: 'slow down', status: 429, retryable: true
  })
  rejectsCode(
    () => adapter.normalizeToolCall({ id: 'bad', name: 'read_file', input: '{' }),
    'protocol_tool'
  )
}

function verifyOtherAdapters(claude, openai) {
  assert.deepEqual(claude.decodeStreamChunk({
    type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'plan' }
  }), [{ kind: 'thinking', text: 'plan' }])
  assert.deepEqual(openai.decodeStreamChunk({
    type: 'response.output_text.delta', delta: 'answer'
  }), [{ kind: 'text', text: 'answer' }])
}

function verifyPartialIsolation() {
  const ownership = [
    ['src/main/agentSession.ts', 'sdk.query({'],
    ['src/main/anthropicEngine.ts', 'streamAnthropicMessage'],
    ['src/main/openaiEngine.ts', 'res.body.getReader()']
  ]
  for (const [file, marker] of ownership) {
    assert(readFileSync(path.join(repoRoot, file), 'utf8').includes(marker), `${file} ownership marker missing`)
  }
  return ownership.map(([file]) => file)
}

function sessionMeta(engine) {
  return {
    id: `protocol-session-${engine}`,
    title: 'Protocol adapter fixture',
    cwd: projectDir,
    unassigned: true,
    model: 'fixture-model',
    providerId: 'fixture-provider',
    engine,
    permissionMode: 'bypassPermissions',
    status: 'starting',
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt: 1
  }
}

function adapterIdentity(adapter) {
  return { id: adapter.id, engineKind: adapter.engineKind, protocol: adapter.protocol }
}

function rejectsCode(operation, expectedCode) {
  assert.throws(operation, (error) => {
    assert.equal(error?.code, expectedCode, `expected ${expectedCode}, got ${error?.code}: ${error?.message}`)
    return true
  })
}

function compileHarness() {
  const compiledProcess = spawnSync(process.execPath, [
    path.join(repoRoot, 'node_modules/typescript/bin/tsc'),
    'src/main/engines.ts',
    '--outDir', outDir,
    '--rootDir', 'src',
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, encoding: 'utf8' })
  if (!existsSync(compiled('main/engines.js'))) {
    process.stderr.write(compiledProcess.stdout ?? '')
    process.stderr.write(compiledProcess.stderr ?? '')
    throw new Error('failed to compile protocol adapter boundary harness')
  }
}

function installElectronStub() {
  const electronStub = {
    app: { getPath: () => userData, isPackaged: false, focus() {} },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`protocol-adapter:${value}`, 'utf8'),
      decryptString: (value) => value.toString('utf8').replace(/^protocol-adapter:/, '')
    },
    BrowserWindow: { getAllWindows: () => [] },
    powerSaveBlocker: { start: () => 1, stop() {}, isStarted: () => false },
    Notification: class { static isSupported() { return false } }
  }
  const moduleApi = require('node:module')
  const originalLoad = moduleApi.Module._load
  moduleApi.Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electronStub
    return originalLoad.call(this, request, parent, isMain)
  }
  return () => { moduleApi.Module._load = originalLoad }
}

function compiled(relativePath) {
  return path.join(outDir, relativePath)
}

function writeReport(report) {
  mkdirSync(reportDir, { recursive: true })
  const body = `${JSON.stringify({
    ...report,
    reportDir: path.relative(repoRoot, reportDir)
  }, null, 2)}\n`
  writeFileSync(path.join(reportDir, 'report.json'), body, 'utf8')
  writeFileSync(path.join(reportRoot, 'latest.json'), body, 'utf8')
}

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    code: error && typeof error === 'object' && 'code' in error ? error.code : undefined
  }
}
