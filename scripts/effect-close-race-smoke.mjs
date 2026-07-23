import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-effect-close-race-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'userData')
const project = path.join(tempRoot, 'project')
const require = createRequire(import.meta.url)
process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter)
require('node:module').Module._initPaths()

mkdirSync(userData, { recursive: true })
mkdirSync(project, { recursive: true })
writeFileSync(path.join(project, 'state.txt'), 'before\n', 'utf8')
writeFileSync(
  path.join(userData, 'providers.json'),
  JSON.stringify([
    {
      id: 'effect-close-provider',
      name: 'Effect close provider',
      baseUrl: 'http://unused.invalid',
      encryptedToken: `b64:${Buffer.from('test-key').toString('base64')}`,
      models: ['test-model'],
      createdAt: 1
    }
  ]),
  'utf8'
)

const electronStub = {
  app: {
    getPath: () => userData,
    isPackaged: false,
    focus() {}
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    decryptString: () => ''
  },
  BrowserWindow: {
    getAllWindows: () => []
  },
  powerSaveBlocker: {
    start: () => 1,
    stop() {},
    isStarted: () => false
  },
  Notification: class {
    static isSupported() { return false }
    once() {}
    show() {}
  }
}

const originalLoad = require('node:module').Module._load

try {
  const compile = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/sessionManager.ts',
      '--outDir',
      outDir,
      '--rootDir',
      'src',
      '--target',
      'ES2022',
      '--module',
      'commonjs',
      '--moduleResolution',
      'node',
      '--types',
      'node',
      '--skipLibCheck',
      '--esModuleInterop'
    ],
    { cwd: repoRoot, encoding: 'utf8' }
  )
  if (!findCompiledModule(outDir, 'sessionManager.js')) {
    process.stderr.write(compile.stdout ?? '')
    process.stderr.write(compile.stderr ?? '')
    throw new Error('failed to compile SessionManager close-race smoke')
  }

  require('node:module').Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electronStub
    return originalLoad.call(this, request, parent, isMain)
  }

  const sessionManagerModule = require(findCompiledModule(outDir, 'sessionManager.js'))
  const engineModule = require(findCompiledModule(outDir, 'engine.js'))
  const effectRuntime = require(findCompiledModule(outDir, 'effect-runtime.js'))
  const snapshotStore = require(findCompiledModule(outDir, 'task-snapshot.js'))

  const controls = new Map()
  engineModule.registerEngine({
    kind: 'openai',
    label: 'Delayed effect test',
    available: () => true,
    create(meta, emit) {
      let seq = 0
      let releaseStop
      let releaseInterrupt
      let disposePromise
      const transcript = []
      const stopped = new Promise((resolve) => {
        releaseStop = resolve
      })
      const interrupted = new Promise((resolve) => {
        releaseInterrupt = resolve
      })
      const push = (event) => {
        const entry = { seq: ++seq, event }
        transcript.push(entry)
        emit(event, entry.seq, entry)
      }
      const control = {
        push,
        releaseStop,
        releaseInterrupt,
        disposeStarted: false,
        interruptStarted: false
      }
      controls.set(meta.id, control)
      return {
        meta,
        async start() {
          meta.sdkSessionId = `delayed-${meta.id}`
          meta.status = 'idle'
          push({ kind: 'init', sdkSessionId: meta.sdkSessionId })
          push({ kind: 'status', status: 'idle' })
        },
        send(input) {
          const text = typeof input === 'string' ? input : input.text
          meta.status = 'running'
          push({ kind: 'user-message', messageId: 'close-race-message', text })
          push({ kind: 'status', status: 'running' })
        },
        rejectSend(message) {
          push({ kind: 'status', status: 'error', error: message })
        },
        interrupt() {
          control.interruptStarted = true
          return interrupted
        },
        respondPermission() {},
        pendingPermissions: () => [],
        getTranscript: () => [...transcript],
        async setPermissionMode(mode) { meta.permissionMode = mode },
        async setModel(model) { meta.model = model },
        rename(title) { meta.title = title },
        dispose() {
          if (disposePromise) return disposePromise
          control.disposeStarted = true
          meta.status = 'closed'
          push({ kind: 'status', status: 'closed' })
          disposePromise = stopped
          return disposePromise
        }
      }
    }
  })

  const manager = sessionManagerModule.sessionManager
  const meta = await manager.create({
    cwd: project,
    isolated: false,
    engine: 'openai',
    providerId: 'effect-close-provider',
    model: 'test-model',
    permissionMode: 'bypassPermissions',
    title: 'Effect close race'
  })
  await waitFor(() => manager.get(meta.id)?.meta.sdkSessionId, 2000, 'session start')
  const control = controls.get(meta.id)
  assert(control, 'missing close-race engine control')
  manager.send(meta.id, 'perform delayed write')
  const toolInput = { path: 'state.txt', content: 'after\n' }
  control.push({
    kind: 'assistant-message',
    blocks: [{ type: 'tool_use', id: 'delayed-write', name: 'write_file', input: toolInput }]
  })
  await seedRecoverySnapshot(manager, snapshotStore, meta.id)
  const handle = await effectRuntime.prepareEffectExecution({
    sessionId: meta.id,
    cwd: project,
    toolUseId: 'delayed-write',
    toolName: 'write_file',
    toolInput
  })
  await effectRuntime.markEffectExecutionStarted(handle, {
    sessionId: meta.id,
    cwd: project,
    toolUseId: 'delayed-write',
    toolName: 'write_file',
    toolInput
  })
  await snapshotStore.flushTaskSnapshotMutations(userData)

  const closePromise = manager.close(meta.id)
  assert(control.disposeStarted, 'close must request executor stop')
  assert(manager.get(meta.id), 'session must remain active until executor termination is confirmed')

  const duringClose = (await manager.listTaskSnapshots()).find((item) => item.sessionId === meta.id)
  assert(duringClose?.run, 'active closing session must retain its recovery snapshot')
  const duringEffect = duringClose.run.effects.find((item) => item.toolUseId === 'delayed-write')
  assertEqual(duringEffect?.status, 'executing')
  assertEqual(duringEffect?.evidence.filter((item) => item.kind === 'retry_authorized').length, 0)
  const recoveredWhileActive = await manager.recoverTaskSnapshot(duringClose.id)
  assertEqual(recoveredWhileActive.id, meta.id)
  assert(manager.get(meta.id), 'recovery during close must return the active session, not start a retry')

  writeFileSync(path.join(project, 'state.txt'), 'after\n', 'utf8')
  const completed = await effectRuntime.completeEffectExecution(handle, { ok: true, output: 'write completed' })
  assertEqual(completed?.status, 'confirmed')
  control.push({
    kind: 'tool-result',
    toolUseId: 'delayed-write',
    content: 'write completed',
    isError: false,
    effectStatus: completed?.status
  })
  control.releaseStop()
  await closePromise

  assertEqual(manager.get(meta.id), undefined)
  assertEqual(readFileSync(path.join(project, 'state.txt'), 'utf8'), 'after\n')
  const persistedRuns = await snapshotStore.listTaskRuns(meta.id, userData)
  const persistedEffect = persistedRuns.flatMap((run) => run.effects ?? []).find((item) => item.toolUseId === 'delayed-write')
  assertEqual(persistedEffect?.status, 'confirmed')
  assertEqual(persistedEffect?.evidence.filter((item) => item.kind === 'retry_authorized').length, 0)
  assertEqual((await snapshotStore.listTaskSnapshots(userData)).some((item) => item.sessionId === meta.id), false)

  writeFileSync(path.join(project, 'state.txt'), 'before\n', 'utf8')
  const interruptMeta = await manager.create({
    cwd: project,
    isolated: false,
    engine: 'openai',
    providerId: 'effect-close-provider',
    model: 'test-model',
    permissionMode: 'bypassPermissions',
    title: 'Effect interrupt race'
  })
  await waitFor(() => manager.get(interruptMeta.id)?.meta.sdkSessionId, 2000, 'interrupt session start')
  const interruptControl = controls.get(interruptMeta.id)
  assert(interruptControl, 'missing interrupt-race engine control')
  manager.send(interruptMeta.id, 'perform interrupted write')
  interruptControl.push({
    kind: 'assistant-message',
    blocks: [{ type: 'tool_use', id: 'interrupted-write', name: 'write_file', input: toolInput }]
  })
  await seedRecoverySnapshot(manager, snapshotStore, interruptMeta.id)
  const interruptedHandle = await effectRuntime.prepareEffectExecution({
    sessionId: interruptMeta.id,
    cwd: project,
    toolUseId: 'interrupted-write',
    toolName: 'write_file',
    toolInput
  })
  await effectRuntime.markEffectExecutionStarted(interruptedHandle, {
    sessionId: interruptMeta.id,
    cwd: project,
    toolUseId: 'interrupted-write',
    toolName: 'write_file',
    toolInput
  })
  await snapshotStore.flushTaskSnapshotMutations(userData)

  const interruptPromise = manager.interrupt(interruptMeta.id)
  assert(interruptControl.interruptStarted, 'interrupt must request current executor stop')
  const interruptDuring = (await manager.listTaskSnapshots()).find((item) => item.sessionId === interruptMeta.id)
  assertEqual(interruptDuring?.run?.effects.find((item) => item.toolUseId === 'interrupted-write')?.status, 'executing')
  interruptControl.releaseInterrupt()
  interruptControl.releaseStop()
  await interruptPromise

  const interruptedSnapshot = (await manager.listTaskSnapshots()).find((item) => item.sessionId === interruptMeta.id)
  const waitingEffect = interruptedSnapshot?.run?.effects.find((item) => item.toolUseId === 'interrupted-write')
  assertEqual(waitingEffect?.status, 'waiting_reconciliation')
  assertEqual(waitingEffect?.evidence.filter((item) => item.kind === 'retry_authorized').length, 0)
  assertEqual(manager.get(interruptMeta.id), undefined)

  await manager.resolveTaskEffect(
    interruptedSnapshot.id,
    waitingEffect.id,
    waitingEffect.revision,
    'confirmed_not_applied'
  )
  assert(await manager.deleteTaskSnapshot(interruptedSnapshot.id), 'resolved interrupt snapshot should be deletable')

  const blockedMeta = await manager.create({
    cwd: project,
    isolated: false,
    engine: 'openai',
    providerId: 'effect-close-provider',
    model: 'test-model',
    permissionMode: 'bypassPermissions',
    title: 'Effect send gate'
  })
  await waitFor(() => manager.get(blockedMeta.id)?.meta.sdkSessionId, 2000, 'blocked-send session start')
  const blockedControl = controls.get(blockedMeta.id)
  assert(blockedControl, 'missing blocked-send engine control')
  manager.send(blockedMeta.id, 'perform unresolved write')
  const blockedToolInput = { path: 'state.txt', content: 'blocked\n' }
  blockedControl.push({
    kind: 'assistant-message',
    blocks: [{ type: 'tool_use', id: 'blocked-send-write', name: 'write_file', input: blockedToolInput }]
  })
  await seedRecoverySnapshot(manager, snapshotStore, blockedMeta.id)
  const blockedHandle = await effectRuntime.prepareEffectExecution({
    sessionId: blockedMeta.id,
    cwd: project,
    toolUseId: 'blocked-send-write',
    toolName: 'write_file',
    toolInput: blockedToolInput
  })
  await effectRuntime.markEffectExecutionStarted(blockedHandle, {
    sessionId: blockedMeta.id,
    cwd: project,
    toolUseId: 'blocked-send-write',
    toolName: 'write_file',
    toolInput: blockedToolInput
  })
  const beforeBlockedRun = manager.taskRuns.get(blockedMeta.id)
  const beforeBlockedEffect = beforeBlockedRun.effects.find((item) => item.toolUseId === 'blocked-send-write')
  const beforeUserMessages = manager
    .getTranscript(blockedMeta.id)
    .filter((entry) => entry.event.kind === 'user-message').length

  manager.send(blockedMeta.id, 'this retry must be blocked')

  const afterBlockedRun = manager.taskRuns.get(blockedMeta.id)
  const afterBlockedEffect = afterBlockedRun.effects.find((item) => item.toolUseId === 'blocked-send-write')
  assertEqual(afterBlockedRun.id, beforeBlockedRun.id)
  assertEqual(afterBlockedRun.status, 'waiting_reconciliation')
  assertEqual(afterBlockedEffect.status, beforeBlockedEffect.status)
  assertEqual(afterBlockedEffect.revision, beforeBlockedEffect.revision)
  assertEqual(
    manager.getTranscript(blockedMeta.id).filter((entry) => entry.event.kind === 'user-message').length,
    beforeUserMessages
  )
  assert(
    manager.getTranscript(blockedMeta.id).some(
      (entry) => entry.event.kind === 'status' && entry.event.status === 'error' && String(entry.event.error).includes('对账')
    ),
    'blocked send must expose a reconciliation error without creating another task run'
  )

  await effectRuntime.cancelEffectExecution(blockedHandle, 'test confirmed the blocked effect was never delivered')
  const blockedClose = manager.close(blockedMeta.id)
  blockedControl.releaseStop()
  await blockedClose
  console.log('effect close race smoke ok')
} finally {
  require('node:module').Module._load = originalLoad
  rmSync(tempRoot, { recursive: true, force: true })
}

function findCompiledModule(root, name) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledModule(fullPath, name)
      if (found) return found
    } else if (entry.isFile() && entry.name === name) {
      return fullPath
    }
  }
  return null
}

async function seedRecoverySnapshot(manager, snapshotStore, sessionId) {
  const session = manager.get(sessionId)
  const run = manager.taskRuns.get(sessionId)
  assert(session && run, 'test session must have an active TaskRun')
  const transcript = session.getTranscript()
  const lastSeq = transcript.at(-1)?.seq ?? 0
  const candidate = snapshotStore.buildTaskSnapshot({
    meta: session.meta,
    transcript,
    lastSeq,
    lastEventKind: transcript.at(-1)?.event?.kind,
    eventCount: transcript.length,
    reason: 'important-event',
    run
  })
  const persisted = await snapshotStore.saveTaskSnapshot(candidate)
  assertEqual(snapshotStore.taskSnapshotsDbFile(), snapshotStore.taskSnapshotsDbFile(userData))
  const stored = await snapshotStore.getTaskSnapshot(sessionId)
  assert(
    stored?.run?.id === run.id,
    `seeded recovery snapshot identity mismatch: ${JSON.stringify({
      registryRunId: run.id,
      registryRevision: run.revision,
      candidateRunId: candidate.run?.id,
      candidateRevision: candidate.run?.revision,
      candidateSeq: candidate.execution.lastSeq,
      persistedRunId: persisted.run?.id,
      persistedRevision: persisted.run?.revision,
      persistedSeq: persisted.execution.lastSeq,
      storedRunId: stored?.run?.id,
      storedRevision: stored?.run?.revision,
      storedSeq: stored?.execution.lastSeq
    })}`
  )
}

function waitFor(predicate, timeoutMs, label) {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        if (predicate()) {
          resolve(undefined)
          return
        }
      } catch (error) {
        reject(error)
        return
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`timeout waiting for ${label}`))
        return
      }
      setTimeout(check, 10)
    }
    check()
  })
}

function assertEqual(actual, expected) {
  assert(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
