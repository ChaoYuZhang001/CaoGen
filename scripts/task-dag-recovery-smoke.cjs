#!/usr/bin/env node
const assert = require('node:assert/strict')
const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

const repo = path.resolve(__dirname, '..')
process.env.NODE_PATH = [path.join(repo, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter)
Module._initPaths()

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caogen-dag-recovery-'))
const buildDir = path.join(tmpRoot, 'build')
const userData = path.join(tmpRoot, 'userData')
const fakeWindows = []
const sentInputs = []
const completeInitialTaskIds = new Set(['prep-a'])
let autoCompleteRecoveredRoots = false
let lateDisposeSessionId = null

async function main() {
let restoreModuleLoad = () => {}
try {
  compileMain()
  restoreModuleLoad = installModuleStubs()

  const engineMod = M('main/engine.js')
  engineMod.registerEngine({
    kind: 'openai',
    label: 'DAG Recovery Fake',
    available: () => true,
    create: (meta, emit, resumeSdkSessionId) => new DagRecoveryFakeEngine(meta, emit, resumeSdkSessionId)
  })

  const firstManager = M('main/sessionManager.js').sessionManager
  const snapshotStore = M('main/task/task-snapshot.js')
  const repoDir = mkRepo('repo')
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(
    path.join(userData, 'providers.json'),
    JSON.stringify([
      {
        id: 'fake-provider',
        name: 'DAG Recovery Fake',
        baseUrl: 'http://127.0.0.1:1',
        encryptedToken: `b64:${Buffer.from('fake-token').toString('base64')}`,
        models: ['fake-model'],
        openaiProtocol: 'responses',
        createdAt: Date.now()
      }
    ])
  )
  const preShutdownEvents = []
  firstManager.subscribe((payload) => preShutdownEvents.push(payload))
  const parent = firstManager.create({
    cwd: repoDir,
    isolated: false,
    engine: 'openai',
    model: 'fake-model',
    providerId: 'fake-provider',
    permissionMode: 'default',
    title: 'DAG recovery parent'
  })

  const dag = {
    id: 'dag-recovery-smoke',
    title: 'DAG recovery smoke',
    source: 'smoke',
    complexity: 'multi',
    createdAt: Date.now(),
    tasks: [
      {
        id: 'prep-a',
        title: 'Prepare A',
        description: 'Prepare A result',
        dependencies: [],
        role: 'backend',
        prompt: 'prepare A'
      },
      {
        id: 'prep-b',
        title: 'Prepare B',
        description: 'Prepare B result',
        dependencies: [],
        role: 'backend',
        prompt: 'prepare B'
      },
      {
        id: 'verify',
        title: 'Verify',
        description: 'Verify recovered dependencies',
        dependencies: ['prep-a', 'prep-b'],
        role: 'qa',
        prompt: 'verify dependencies'
      }
    ]
  }

  firstManager.dispatchTaskDag(parent.id, {
    dag,
    cwd: repoDir,
    isolated: false,
    engine: 'openai',
    model: 'fake-model',
    providerId: 'fake-provider',
    permissionMode: 'default',
    maxRetries: 1,
    taskTimeoutMs: 0,
    autoMerge: true,
    verificationCommand: 'echo verify'
  })

  await waitFor(() => sentInputs.filter((item) => item.taskId === 'prep-a' || item.taskId === 'prep-b').length === 2)
  await waitFor(() => {
    const latest = latestDagUpdate(preShutdownEvents, parent.id)
    return latest?.tasks.find((task) => task.task.id === 'prep-a')?.status === 'success'
  }, 5000, 'prep-a initial success')
  lateDisposeSessionId = parent.id
  await firstManager.disposeAll()
  await delay(30)
  await snapshotStore.flushTaskSnapshotMutations(userData)
  lateDisposeSessionId = null

  const snapshotsAfterShutdown = await snapshotStore.listTaskSnapshots(userData)
  const taskRunsAfterShutdown = await snapshotStore.listTaskRuns(undefined, userData)
  const parentSnapshot = snapshotsAfterShutdown.find((snapshot) => snapshot.sessionId === parent.id)
  if (!parentSnapshot) {
    const dbFile = snapshotStore.taskSnapshotsDbFile(userData)
    console.error('snapshots after shutdown:', snapshotsAfterShutdown.map((snapshot) => ({
      sessionId: snapshot.sessionId,
      childTaskId: snapshot.meta?.childTaskId,
      title: snapshot.title,
      dagExecutions: snapshot.dagExecutions?.length,
      dagRuntimes: snapshot.dagRuntimes?.length
    })))
    console.error('snapshot db:', {
      dbFile,
      exists: fs.existsSync(dbFile),
      bytes: fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0
    })
    if (fs.existsSync(dbFile)) await debugRawSnapshots(dbFile)
  }
  assert(parentSnapshot, 'parent snapshot should exist after shutdown')
  assert.equal(parentSnapshot.dagExecutions.length, 1, 'parent snapshot should keep DAG execution view')
  assert.equal(parentSnapshot.dagRuntimes.length, 1, 'parent snapshot should keep DAG runtime sidecar')
  assert.equal(parentSnapshot.dagExecutions[0].status, 'running')
  assert.equal(statusOf(parentSnapshot.dagExecutions[0], 'prep-a'), 'success')
  assert.equal(statusOf(parentSnapshot.dagExecutions[0], 'prep-b'), 'running')
  assert.equal(statusOf(parentSnapshot.dagExecutions[0], 'verify'), 'waiting')
  assert.deepEqual(
    parentSnapshot.dagRuntimes[0].runningTasks.map((task) => task.taskId).sort(),
    ['prep-b']
  )
  assert(
    parentSnapshot.dagRuntimes[0].mergeSessions.some(
      (session) => session.taskId === 'prep-a' && session.resultText === 'prep-a initial result'
    ),
    'runtime sidecar should preserve completed child merge metadata'
  )
  assert.equal(parentSnapshot.dagRuntimes[0].autoMerge.enabled, true)
  assert.equal(parentSnapshot.dagRuntimes[0].autoMerge.verificationCommand, 'echo verify')
  assert(
    taskRunsAfterShutdown.some((run) => run.taskId === 'prep-a' && run.status === 'completed'),
    'completed DAG child TaskRun should remain in SQLite history after its recovery snapshot is removed'
  )
  assert(
    taskRunsAfterShutdown.some((run) => run.taskId === 'prep-b' && !['completed', 'cancelled'].includes(run.status)),
    'unfinished DAG child TaskRun should remain recoverable at shutdown'
  )

  delete require.cache[require.resolve(path.join(buildDir, 'main/sessionManager.js'))]
  const freshManager = M('main/sessionManager.js').sessionManager
  const recoveredEvents = []
  freshManager.subscribe((payload) => recoveredEvents.push(payload))
  autoCompleteRecoveredRoots = true
  await freshManager.init()
  assert.equal(
    freshManager.get(parent.id),
    undefined,
    'legacy active-session registry must not auto-restore a session that has a richer task snapshot'
  )
  engineMod.registerEngine({
    kind: 'openai',
    label: 'DAG Recovery Fake',
    available: () => true,
    create: (meta, emit, resumeSdkSessionId) => new DagRecoveryFakeEngine(meta, emit, resumeSdkSessionId)
  })
  await freshManager.recoverTaskSnapshot(parent.id)

  await waitFor(() => sentInputs.some((item) => item.taskId === 'verify'), 5000, 'verify task dispatch')
  const verifyInput = sentInputs.find((item) => item.taskId === 'verify')
  assert(verifyInput.text.includes('prep-a initial result'), 'verify prompt should include prep-a result')
  assert(verifyInput.text.includes('prep-b recovered result'), 'verify prompt should include prep-b result')

  await waitFor(() => {
    const final = latestDagUpdate(recoveredEvents, parent.id)
    return final?.status === 'success' && final.tasks.every((task) => task.status === 'success')
  }, 5000, 'final recovered DAG success')
  const final = latestDagUpdate(recoveredEvents, parent.id)
  assert(final.tasks.find((task) => task.task.id === 'verify').resultText.includes('verify completed'))
  const taskRunsAfterRecovery = await snapshotStore.listTaskRuns(undefined, userData)
  const verifyRun = taskRunsAfterRecovery.find((run) => run.taskId === 'verify' && run.status === 'completed')
  assert(verifyRun, 'recovered DAG verification child should persist a completed TaskRun')
  assert.equal(verifyRun.toolExecutions.length, 1, 'verification TaskRun should persist its tool execution')
  assert.equal(verifyRun.toolExecutions[0].status, 'succeeded')
  assert.match(verifyRun.toolExecutions[0].idempotencyKey, /^tool-v1:/)
  assert.equal(typeof verifyRun.toolExecutions[0].inputDigest, 'string')
  assert.equal(typeof verifyRun.toolExecutions[0].outputDigest, 'string')

  await freshManager.disposeAll()
  await snapshotStore.flushTaskSnapshotMutations(userData)

  console.log('task-dag recovery smoke: PASS')
} finally {
  restoreModuleLoad()
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}
}

function compileMain() {
  const files = []
  for (const dir of ['src/main', 'src/shared']) {
    for (const file of fs.readdirSync(path.join(repo, dir))) {
      if (file.endsWith('.ts')) files.push(path.join(dir, file))
    }
  }
  const result = spawnSync(
    process.execPath,
    [
      path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc'),
      ...files,
      '--outDir',
      buildDir,
      '--module',
      'commonjs',
      '--target',
      'es2022',
      '--moduleResolution',
      'node',
      '--skipLibCheck',
      '--esModuleInterop'
    ],
    { cwd: repo, encoding: 'utf8' }
  )
  if (result.error || !fs.existsSync(path.join(buildDir, 'main/sessionManager.js'))) {
    console.error(result.stdout ?? '')
    console.error(result.stderr ?? '')
    console.error(result.error ?? `tsc exited with status ${result.status}`)
    throw new Error('failed to compile main modules for DAG recovery smoke')
  }
  if (result.status !== 0) {
    console.warn('[task-dag-recovery-smoke] transient tsc diagnostics while emitting CommonJS test build; npm.cmd run typecheck remains the strict gate.')
  }
}

function installModuleStubs() {
  const electronStub = {
    app: {
      getPath: (name) => (name === 'userData' ? userData : tmpRoot),
      isPackaged: false,
      setName() {},
      setPath() {},
      getName: () => 'CaoGen-DagRecoverySmoke'
    },
    safeStorage: { isEncryptionAvailable: () => false },
    powerSaveBlocker: { start: () => 1, stop() {}, isStarted: () => false },
    Notification: class {
      on() {}
      once() {}
      show() {}
      static isSupported() { return true }
    },
    BrowserWindow: { getAllWindows: () => fakeWindows, fromWebContents: () => null },
    WebContentsView: class {},
    ipcMain: { handle() {} },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { showItemInFolder() {}, openExternal: async () => {} }
  }
  const sdkStub = { query: () => ({ async *[Symbol.asyncIterator]() {} }) }
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electronStub
    if (request === '@anthropic-ai/claude-agent-sdk') return sdkStub
    if (request === './terminal' || request.endsWith('/terminal')) {
      return {
        terminalManager: {
          subscribe: () => () => {},
          list: () => [],
          start: async () => ({
            id: 'terminal-mock',
            cwd: tmpRoot,
            shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
            backend: 'pipe',
            cols: 80,
            rows: 24,
            startedAt: Date.now()
          }),
          write() {},
          resize() {},
          close() {}
        }
      }
    }
    return originalLoad.apply(this, arguments)
  }
  return () => {
    Module._load = originalLoad
  }
}

class DagRecoveryFakeEngine {
  constructor(meta, emit, resumeSdkSessionId) {
    this.meta = meta
    this.emit = emit
    this.resumeSdkSessionId = resumeSdkSessionId
    this.seq = 0
    this.transcript = []
  }

  async start() {
    this.meta.status = 'idle'
    this.meta.sdkSessionId ||= `fake-sdk-${this.meta.id}`
    this.push({ kind: 'init', sdkSessionId: this.meta.sdkSessionId, model: this.meta.model, tools: [] })
    this.push({ kind: 'status', status: 'idle' })
  }

  send(input) {
    const text = typeof input === 'string' ? input : input.text
    sentInputs.push({ sessionId: this.meta.id, taskId: this.meta.childTaskId, text })
    this.push({ kind: 'user-message', messageId: `msg-${this.meta.id}-${this.seq + 1}`, text })
    if (!autoCompleteRecoveredRoots && completeInitialTaskIds.has(this.meta.childTaskId)) {
      setTimeout(() => this.finish(`${this.meta.childTaskId} initial result`), 20)
      return
    }
    if (autoCompleteRecoveredRoots && (this.meta.childTaskId === 'prep-a' || this.meta.childTaskId === 'prep-b')) {
      setTimeout(() => this.finish(`${this.meta.childTaskId} recovered result`), 20)
      return
    }
    if (this.meta.childTaskId === 'verify') {
      assert(text.includes('prep-a initial result'), 'verify prompt missing prep-a dependency result')
      assert(text.includes('prep-b recovered result'), 'verify prompt missing prep-b dependency result')
      const toolUseId = `verify-tool-${this.meta.id}`
      this.push({ kind: 'tool-start', toolUseId, name: 'write_file' })
      this.push({
        kind: 'assistant-message',
        blocks: [{ type: 'tool_use', id: toolUseId, name: 'write_file', input: { path: 'verification.txt', content: 'verified' } }]
      })
      this.push({ kind: 'tool-result', toolUseId, content: 'write ok', isError: false })
      setTimeout(() => this.finish('verify completed after recovered dependencies'), 20)
    }
  }

  emitSyntheticEvent(event) {
    this.push(event)
  }

  getTranscript() {
    return [...this.transcript]
  }

  pendingPermissions() {
    return []
  }

  rejectSend(message) {
    this.push({ kind: 'status', status: 'error', error: message })
  }

  async interrupt() {}
  respondPermission() {}
  async setPermissionMode(mode) { this.meta.permissionMode = mode }
  async setModel(model) { this.meta.model = model }
  rename(title) { this.meta.title = title }
  dispose() {
    this.meta.status = 'closed'
    if (this.meta.id === lateDisposeSessionId) {
      setTimeout(() => this.finish('late provider completion after dispose'), 0)
    }
  }

  push(event) {
    this.transcript.push({ seq: ++this.seq, event })
    this.emit(event, this.seq)
  }

  finish(resultText) {
    this.meta.status = 'idle'
    this.push({ kind: 'turn-result', subtype: 'success', isError: false, resultText, durationMs: 1 })
  }
}

function M(relativePath) {
  return require(path.join(buildDir, relativePath))
}

function mkRepo(name) {
  const dir = path.join(tmpRoot, name)
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'README.md'), '# dag recovery\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })
  return dir
}

function statusOf(execution, taskId) {
  return execution.tasks.find((task) => task.task.id === taskId)?.status
}

function latestDagUpdate(events, parentSessionId) {
  return events
    .filter((payload) => payload.sessionId === parentSessionId && payload.event.kind === 'task-dag-update')
    .map((payload) => payload.event.execution)
    .at(-1)
}

function waitFor(predicate, timeoutMs = 3000, label = 'condition') {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (predicate()) return resolve()
      } catch (error) {
        return reject(error)
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`timed out waiting for ${label}`))
      }
      setTimeout(tick, 20)
    }
    tick()
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function debugRawSnapshots(dbFile) {
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs({
    locateFile: (file) => (file.endsWith('.wasm') ? require.resolve('sql.js/dist/sql-wasm.wasm') : file)
  })
  const db = new SQL.Database(fs.readFileSync(dbFile))
  try {
    const rows = []
    const stmt = db.prepare('SELECT id, session_id, payload FROM task_snapshots ORDER BY updated_at DESC')
    while (stmt.step()) {
      const row = stmt.getAsObject()
      const payload = JSON.parse(row.payload)
      rows.push({
        id: row.id,
        sessionId: row.session_id,
        metaId: payload.meta?.id,
        metaStatus: payload.meta?.status,
        childTaskId: payload.meta?.childTaskId,
        eventCount: payload.eventCount,
        transcriptKinds: payload.transcript?.map((entry) => entry.event?.kind),
        dagExecutions: payload.dagExecutions?.map((execution) => ({
          id: execution.id,
          status: execution.status,
          tasks: execution.tasks?.map((task) => ({
            id: task.task?.id,
            status: task.status,
            attempts: task.attempts,
            sessionIds: task.sessionIds
          }))
        })),
        dagRuntimes: payload.dagRuntimes
      })
    }
    stmt.free()
    console.error('raw snapshot rows:', JSON.stringify(rows, null, 2))
  } finally {
    db.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
