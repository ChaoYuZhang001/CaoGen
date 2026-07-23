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
const reportRoot = path.join(repoRoot, 'test-results', 'native-runtime-contract')
const reportDir = path.join(reportRoot, runId)
const reportPath = path.join(reportDir, 'report.json')
const latestPath = path.join(reportRoot, 'latest.json')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-native-runtime-contract-'))
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
  const engineModule = require(findCompiled('engine.js'))
  const enginesModule = require(findCompiled('engines.js'))
  const contractModule = require(findCompiled('native-runtime-contract.js'))
  const guardModule = require(findCompiled('native-runtime-guard.js'))
  const boundModule = require(findCompiled('native-runtime-engine.js'))

  enginesModule.registerBuiltinEngines()
  const adapters = engineModule.listNativeRuntimeAdapters()
  assert.deepEqual(adapters.map((adapter) => adapter.engineKind), ['claude', 'anthropic', 'openai'])
  checks.push('three-builtin-adapter-identities')

  assert.equal(contractModule.isNativeRuntimeFrozen(), true)
  assert.equal(Object.isFrozen(contractModule.NATIVE_RUNTIME_CONTRACT), true)
  for (const adapter of adapters) {
    assert.equal(Object.isFrozen(adapter), true)
    contractModule.assertNativeRuntimeAdapterDeclaration(adapter, adapter.engineKind)
  }
  checks.push('deep-frozen-contract-and-declarations')

  const capabilityProjections = adapters.map((adapter) => JSON.stringify(adapter.capabilities))
  assert.equal(new Set(capabilityProjections).size, 1)
  checks.push('provider-neutral-capability-parity')

  const snapshots = []
  const serialized = []
  for (const adapter of adapters) {
    const meta = sessionMeta(adapter.engineKind)
    const emitted = []
    const engine = engineModule.createEngine(
      adapter.engineKind,
      meta,
      (event, seq, identity) => emitted.push({ event, seq, identity })
    )
    engines.push(engine)
    assert.equal(boundModule.isNativeRuntimeBoundEngine(engine), true)
    assert.equal(engine.nativeRuntimeAdapter.engineKind, adapter.engineKind)
    assert.equal(typeof engine.restoreCheckpoint, 'function')
    assert.equal(typeof engine.rewindFiles, 'function')
    engine.bindNativeRun(taskRun(meta.id, `run-${adapter.engineKind}`))
    executeCanonicalTrace(engine, meta)
    const snapshot = engine.getNativeRuntimeSnapshot()
    assert.equal(emitted.length, 17)
    assert(emitted.every((entry, index) =>
      entry.seq === index + 1 && entry.identity?.seq === entry.seq && entry.identity?.schemaVersion === 1
    ))
    assert.equal(snapshot.run?.status, 'completed')
    assert.equal(snapshot.context.active, false)
    assert.deepEqual(snapshot.tools.activeIds, [])
    assert.deepEqual(snapshot.permissions.pendingIds, [])
    assert.deepEqual(snapshot.usage, {
      input: 11,
      output: 7,
      cacheRead: 3,
      cacheCreation: 2,
      costUsd: 0.01
    })
    assert.equal(snapshot.tools.failed, 1)
    assert.equal(snapshot.error, null)
    assert.equal(snapshot.checkpoint.lastMessageId, 'checkpoint-1')
    assert.equal(snapshot.checkpoint.restores, 1)
    assert.equal(snapshot.hook.lastEvent, 'after-tool')
    assert.equal(Object.isFrozen(snapshot), true)
    assert.equal(Object.isFrozen(snapshot.tools.activeIds), true)
    snapshots.push(snapshot)
    serialized.push(engine.serializeNativeRuntime())
  }
  checks.push('three-real-engine-contract-execution')
  checks.push('session-run-context-tool-permission-state')
  checks.push('usage-error-checkpoint-hook-state')
  checks.push('runtime-event-identity-and-order')
  assert.deepEqual(snapshots.map(normalizeSnapshot), [normalizeSnapshot(snapshots[0]), normalizeSnapshot(snapshots[0]), normalizeSnapshot(snapshots[0])])
  checks.push('three-engine-runtime-state-parity')

  verifyRestartSequence(guardModule, adapters[0], sessionMeta('claude'), serialized[0])
  checks.push('restart-serialization-stability')
  checks.push('restart-stream-and-sequence-boundary')

  verifyAdapterFailures(contractModule, adapters)
  checks.push('missing-capability-fails-closed')
  checks.push('forged-adapter-identity-fails-closed')

  verifyRuntimeFailures(guardModule, adapters[0])
  checks.push('missing-event-identity-fails-closed')
  checks.push('forged-session-and-run-fail-closed')
  checks.push('missing-event-field-fails-closed')
  checks.push('mid-run-stream-switch-fails-closed')

  verifySnapshotFailures(guardModule, adapters[0], sessionMeta('claude'), serialized[0])
  checks.push('missing-snapshot-field-fails-closed')
  checks.push('snapshot-adapter-tamper-fails-closed')

  result = {
    status: 'PASS',
    engines: adapters.map((adapter) => ({
      engineKind: adapter.engineKind,
      protocol: adapter.protocol,
      contractId: adapter.contractId
    })),
    checks,
    parityEventCount: snapshots[0].eventCount,
    finalSequence: snapshots[0].cursor.seq
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
    gate: 'test:native-runtime-contract:required',
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    result: result ?? null,
    error: failure ?? null,
    environment: { platform: process.platform, arch: process.arch, node: process.version }
  })
}

function executeCanonicalTrace(engine, meta) {
  const trace = [
    { kind: 'status', status: 'starting' },
    { kind: 'init', sdkSessionId: `sdk-${meta.engine}`, model: meta.model, tools: ['read_file'] },
    { kind: 'status', status: 'idle' },
    { kind: 'user-message', text: 'contract probe', messageId: 'message-1' },
    { kind: 'status', status: 'running' },
    { kind: 'tool-start', toolUseId: 'tool-1', name: 'read_file' },
    { kind: 'permission-request', request: { requestId: 'permission-1', toolName: 'read_file', input: {}, toolUseId: 'tool-1' } },
    { kind: 'permission-resolved', requestId: 'permission-1', behavior: 'allow' },
    { kind: 'tool-result', toolUseId: 'tool-1', content: 'ok', isError: false },
    { kind: 'tool-start', toolUseId: 'tool-2', name: 'read_file' },
    { kind: 'tool-result', toolUseId: 'tool-2', content: 'fixture failure', isError: true },
    { kind: 'hook-event', event: 'after-tool', toolName: 'read_file' },
    { kind: 'checkpoint', messageId: 'checkpoint-1', userMessageId: 'message-1' },
    { kind: 'turn-result', subtype: 'success', isError: false, costUsd: 0.01, usage: { input: 11, output: 7, cacheRead: 3, cacheCreation: 2 } },
    { kind: 'status', status: 'idle' },
    { kind: 'checkpoint-restore', messageId: 'checkpoint-1', mode: 'chat', filesChanged: [], chatRemovedEntries: 0 },
    { kind: 'assistant-message', blocks: [{ type: 'text', text: 'done' }] }
  ]
  for (const event of trace) engine.emitSyntheticEvent(event)
}

function verifyRestartSequence(guardModule, adapter, meta, serialized) {
  const restored = guardModule.NativeRuntimeGuard.restore(adapter, meta, serialized)
  assert.equal(restored.serialize(), serialized)
  const nextSeq = restored.snapshot().cursor.seq + 1
  restored.accept(
    { kind: 'hook-event', event: 'restart-resumed' },
    nextSeq,
    identity(nextSeq, 'restart-stream', 'restart-event')
  )
  assert.equal(restored.snapshot().recovery.generation, 1)
  rejectsCode(
    () => restored.accept(
      { kind: 'hook-event', event: 'stale' },
      nextSeq,
      identity(nextSeq, 'restart-stream', 'stale-event')
    ),
    'event_sequence'
  )
}

function verifyAdapterFailures(contractModule, adapters) {
  const missing = JSON.parse(JSON.stringify(adapters[0]))
  delete missing.capabilities.hook
  rejectsCode(() => contractModule.assertNativeRuntimeAdapterDeclaration(missing), 'adapter_capabilities')
  rejectsCode(
    () => contractModule.assertNativeRuntimeAdapterDeclaration(adapters[0], 'openai'),
    'adapter_identity'
  )
}

function verifyRuntimeFailures(guardModule, adapter) {
  const meta = sessionMeta('claude', 'negative-session')
  const missingIdentity = new guardModule.NativeRuntimeGuard({ adapter, meta })
  rejectsCode(() => missingIdentity.accept({ kind: 'status', status: 'idle' }, 1), 'event_identity')

  const forgedMeta = new guardModule.NativeRuntimeGuard({ adapter, meta })
  rejectsCode(
    () => forgedMeta.accept(
      { kind: 'meta', meta: { ...meta, id: 'forged-session' } },
      1,
      identity(1)
    ),
    'session_identity'
  )
  rejectsCode(
    () => forgedMeta.bindRun(taskRun('forged-session', 'run-forged')),
    'run_identity'
  )

  const missingField = new guardModule.NativeRuntimeGuard({ adapter, meta })
  rejectsCode(
    () => missingField.accept({ kind: 'tool-start', toolUseId: 'bad-tool' }, 1, identity(1)),
    'required_field'
  )

  const streamGuard = new guardModule.NativeRuntimeGuard({ adapter, meta })
  streamGuard.accept({ kind: 'status', status: 'idle' }, 1, identity(1, 'stream-a', 'event-a'))
  rejectsCode(
    () => streamGuard.accept({ kind: 'status', status: 'running' }, 2, identity(2, 'stream-b', 'event-b')),
    'event_stream'
  )
}

function verifySnapshotFailures(guardModule, adapter, meta, serialized) {
  const missing = JSON.parse(serialized)
  delete missing.context
  rejectsCode(
    () => guardModule.NativeRuntimeGuard.restore(adapter, meta, JSON.stringify(missing)),
    'snapshot_field'
  )
  const forged = JSON.parse(serialized)
  forged.adapter.engineKind = 'openai'
  rejectsCode(
    () => guardModule.NativeRuntimeGuard.restore(adapter, meta, JSON.stringify(forged)),
    'snapshot_adapter'
  )
}

function sessionMeta(engine, id = `session-${engine}`) {
  return {
    id,
    title: 'Native runtime contract fixture',
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

function taskRun(sessionId, id) {
  return {
    schemaVersion: 1,
    id,
    sessionId,
    taskId: `task-${sessionId}`,
    status: 'executing',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: 1,
    updatedAt: 1,
    steps: [],
    toolExecutions: [],
    effects: []
  }
}

function identity(seq, streamId = 'fixture-stream', eventId = `fixture-event-${seq}`) {
  return { schemaVersion: 1, streamId, eventId, seq, occurredAt: seq }
}

function normalizeSnapshot(snapshot) {
  return {
    contractId: snapshot.contractId,
    capabilities: snapshot.adapter.capabilities,
    sessionStatus: snapshot.session.status,
    run: snapshot.run && {
      status: snapshot.run.status,
      revision: snapshot.run.revision,
      attempt: snapshot.run.attempt,
      recoveryCount: snapshot.run.recoveryCount
    },
    context: snapshot.context,
    tools: snapshot.tools,
    permissions: snapshot.permissions,
    usage: snapshot.usage,
    error: snapshot.error,
    checkpoint: snapshot.checkpoint,
    hook: snapshot.hook,
    recovery: snapshot.recovery,
    seq: snapshot.cursor.seq,
    revision: snapshot.revision,
    eventCount: snapshot.eventCount
  }
}

function rejectsCode(operation, expectedCode) {
  assert.throws(operation, (error) => {
    assert.equal(error?.code, expectedCode, `expected ${expectedCode}, got ${error?.code}: ${error?.message}`)
    return true
  })
}

function compileHarness() {
  const compiled = spawnSync(process.execPath, [
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
  if (!findCompiledMaybe('engines.js')) {
    process.stderr.write(compiled.stdout ?? '')
    process.stderr.write(compiled.stderr ?? '')
    throw new Error('failed to compile native runtime contract harness')
  }
}

function installElectronStub() {
  const electronStub = {
    app: { getPath: () => userData, isPackaged: false, focus() {} },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`native-runtime:${value}`, 'utf8'),
      decryptString: (value) => value.toString('utf8').replace(/^native-runtime:/, '')
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

function findCompiled(fileName) {
  const found = findCompiledMaybe(fileName)
  if (!found) throw new Error(`compiled file not found: ${fileName}`)
  return found
}

function findCompiledMaybe(fileName, root = outDir) {
  if (!path.isAbsolute(root)) return null
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledMaybe(fileName, fullPath)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  return null
}

function writeReport(report) {
  mkdirSync(reportDir, { recursive: true })
  const body = `${JSON.stringify({
    ...report,
    reportDir: path.relative(repoRoot, reportDir),
    reportPath: path.relative(repoRoot, reportPath)
  }, null, 2)}\n`
  writeFileSync(reportPath, body, 'utf8')
  writeFileSync(latestPath, body, 'utf8')
}

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    code: error && typeof error === 'object' && 'code' in error ? error.code : undefined
  }
}
