const assert = require('node:assert/strict')
const { execFileSync, fork, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '../..')
const workerFile = path.join(repoRoot, 'scripts', 'task-dag-finalization-crash-e2e.cjs')
const tempRoot = process.env.CAOGEN_DAG_FINALIZATION_ROOT
  ?? fs.mkdtempSync(path.join(os.tmpdir(), 'caogen-dag-finalization-crash-'))
const buildDir = process.env.CAOGEN_DAG_FINALIZATION_BUILD ?? path.join(tempRoot, 'build')
const crashBoundaryTimeoutMs = Math.max(
  30_000,
  Number(process.env.CAOGEN_DAG_CRASH_BOUNDARY_TIMEOUT_MS) || 60_000
)

function finalizationSnapshot({ snapshotStore, finalization, project, record }) {
  const execution = {
    ...record.terminalExecution,
    finalization: finalization.taskDagFinalizationView(record)
  }
  return snapshotStore.buildTaskSnapshot({
    meta: sessionMeta(record.parentSessionId, project),
    transcript: [{
      seq: 1,
      eventId: 'barrier-user-event',
      streamId: 'barrier-stream',
      occurredAt: 1000,
      event: { kind: 'user-message', messageId: 'barrier-user-message', text: 'finalize DAG' }
    }],
    lastSeq: 1,
    lastEventId: 'barrier-user-event',
    lastEventKind: 'task-dag-update',
    eventCount: 1,
    reason: 'important-event',
    dagExecutions: [execution],
    dagRuntimes: [],
    now: record.updatedAt
  })
}

function assertTerminalFinalizationSnapshot(snapshot, phase, revision) {
  assert(snapshot, 'terminal finalization snapshot must exist')
  assert.equal(snapshot.dagExecutions.length, 1)
  assert.equal(snapshot.dagExecutions[0].status, 'success')
  assert.equal(typeof snapshot.dagExecutions[0].completedAt, 'number')
  assert.equal(snapshot.dagExecutions[0].finalization.phase, phase)
  assert.equal(snapshot.dagExecutions[0].finalization.revision, revision)
  assert.equal(
    snapshot.dagRuntimes.some((runtime) => runtime.executionId === snapshot.dagExecutions[0].id),
    false,
    'terminal snapshot barrier must remove the live DAG runtime sidecar'
  )
}

function terminalExecution(id, parentSessionId) {
  const task = {
    id: 'write-once',
    title: 'Write once',
    description: 'Create finalization.txt once.',
    dependencies: [],
    role: 'backend',
    prompt: 'write once'
  }
  return {
    id,
    parentSessionId,
    dag: {
      id,
      title: 'Durable finalization fixture',
      source: 'crash e2e',
      complexity: 'single',
      createdAt: 1000,
      tasks: [task]
    },
    status: 'success',
    maxRetries: 0,
    startedAt: 1000,
    completedAt: 1100,
    layers: [['write-once']],
    tasks: [{
      task,
      status: 'success',
      attempts: 1,
      sessionIds: ['child-write-once'],
      startedAt: 1010,
      completedAt: 1090,
      resultText: 'done'
    }],
    summary: '1/1 tasks succeeded'
  }
}

function sessionMeta(id, cwd) {
  return {
    id,
    title: id,
    cwd,
    sourceCwd: cwd,
    isolated: false,
    engine: 'openai',
    model: 'fake-model',
    providerId: 'fake-provider',
    permissionMode: 'default',
    unassigned: true,
    digitalWorkerBinding: { kind: 'unscoped' },
    status: 'idle',
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    sdkSessionId: `fake-sdk-${id}`,
    createdAt: 1000
  }
}

function oneTaskDag(mode) {
  return {
    id: `dag-${mode}`,
    title: mode,
    source: 'durable finalization crash e2e',
    complexity: 'single',
    createdAt: Date.now(),
    tasks: [{
      id: 'write-once',
      title: 'Write once',
      description: 'Create finalization.txt in a managed worktree.',
      dependencies: [],
      role: 'backend',
      prompt: 'write finalization.txt once'
    }]
  }
}

function twoTaskRollbackDag(mode) {
  return {
    id: `dag-${mode}`,
    title: mode,
    source: 'durable partial rollback crash e2e',
    complexity: 'multi',
    createdAt: Date.now(),
    tasks: [
      {
        id: 'write-one',
        title: 'Write rollback one',
        description: 'Create rollback-one.txt in a managed worktree.',
        dependencies: [],
        role: 'backend',
        prompt: 'write rollback-one.txt'
      },
      {
        id: 'write-two',
        title: 'Write rollback two',
        description: 'Create rollback-two.txt in a managed worktree.',
        dependencies: ['write-one'],
        role: 'backend',
        prompt: 'write rollback-two.txt'
      }
    ]
  }
}

function childTaskFile(taskId) {
  if (taskId === 'write-one') return 'rollback-one.txt'
  if (taskId === 'write-two') return 'rollback-two.txt'
  return 'finalization.txt'
}

function prepareScenario(name) {
  const root = path.join(tempRoot, name)
  const userData = path.join(root, 'user-data')
  const project = path.join(root, 'repo')
  fs.mkdirSync(userData, { recursive: true })
  fs.mkdirSync(project, { recursive: true })
  git(project, ['init', '-q', '-b', 'main'])
  git(project, ['config', 'user.email', 'dag-finalization@example.test'])
  git(project, ['config', 'user.name', 'DAG Finalization Crash E2E'])
  fs.writeFileSync(path.join(project, 'README.md'), `# ${name}\n`, 'utf8')
  git(project, ['add', 'README.md'])
  git(project, ['commit', '-qm', 'initial'])
  fs.writeFileSync(
    path.join(userData, 'providers.json'),
    `${JSON.stringify([{
      id: 'fake-provider',
      name: 'DAG Finalization Fake',
      baseUrl: 'http://127.0.0.1:1',
      encryptedToken: `b64:${Buffer.from('fake-token').toString('base64')}`,
      models: ['fake-model'],
      engine: 'openai',
      openaiProtocol: 'responses',
      createdAt: Date.now()
    }], null, 2)}\n`,
    'utf8'
  )
  const fixture = {
    name,
    root,
    userData,
    project,
    boundaryFile: path.join(root, 'boundary.json'),
    parentIdFile: path.join(root, 'parent-id.txt'),
    patchCounter: path.join(root, 'patch-mutations.log'),
    reverseCounter: path.join(root, 'reverse-mutations.log'),
    operationCounter: path.join(root, 'patch-operations.log'),
    summaryCounter: path.join(root, 'summary-sends.log'),
    replayCounter: path.join(root, 'replay-sends.log'),
    blockedHookCounter: path.join(root, 'finalizer-blocked-hooks.log'),
    verificationCounter: path.join(root, 'verification-runs.log'),
    phaseLog: path.join(root, 'finalization-phases.log'),
    verifierFile: path.join(root, 'verification-worker.cjs')
  }
  fs.writeFileSync(
    fixture.verifierFile,
    "const fs = require('node:fs')\n" +
      "fs.appendFileSync(process.argv[2], 'verify\\n')\n" +
      "if (process.argv[3] === 'fail') process.exit(1)\n" +
      'setTimeout(() => {}, 2000)\n',
    'utf8'
  )
  return fixture
}

function fixtureFromEnvironment() {
  const root = requireEnv('CAOGEN_DAG_SCENARIO_ROOT')
  return {
    name: path.basename(root),
    root,
    userData: requireEnv('CAOGEN_DAG_USER_DATA'),
    project: requireEnv('CAOGEN_DAG_PROJECT'),
    boundaryFile: requireEnv('CAOGEN_DAG_BOUNDARY_FILE'),
    parentIdFile: requireEnv('CAOGEN_DAG_PARENT_ID_FILE'),
    patchCounter: requireEnv('CAOGEN_DAG_PATCH_COUNTER'),
    reverseCounter: requireEnv('CAOGEN_DAG_REVERSE_COUNTER'),
    operationCounter: requireEnv('CAOGEN_DAG_OPERATION_COUNTER'),
    summaryCounter: requireEnv('CAOGEN_DAG_SUMMARY_COUNTER'),
    replayCounter: requireEnv('CAOGEN_DAG_REPLAY_COUNTER'),
    blockedHookCounter: requireEnv('CAOGEN_DAG_BLOCKED_HOOK_COUNTER'),
    verificationCounter: requireEnv('CAOGEN_DAG_VERIFY_COUNTER'),
    phaseLog: requireEnv('CAOGEN_DAG_PHASE_LOG'),
    verifierFile: requireEnv('CAOGEN_DAG_VERIFIER_FILE')
  }
}

function verificationCommand(fixture) {
  return [process.execPath, fixture.verifierFile, fixture.verificationCounter]
    .map(shellArg)
    .join(' ')
}

function verificationFailureCommand(fixture) {
  return [process.execPath, fixture.verifierFile, fixture.verificationCounter, 'fail']
    .map(shellArg)
    .join(' ')
}

function shellArg(value) {
  if (process.platform === 'win32') return `"${String(value).replaceAll('"', '""')}"`
  return "'" + String(value).replaceAll("'", "'\"'\"'") + "'"
}

function signalBoundary(fixture, payload, block) {
  fs.writeFileSync(fixture.boundaryFile, `${JSON.stringify(payload)}\n`, 'utf8')
  process.send?.(payload)
  if (block) blockForever()
}

function blockForever() {
  const lock = new Int32Array(new SharedArrayBuffer(4))
  while (true) Atomics.wait(lock, 0, 0, 60_000)
}

async function runCrashWorker(mode, fixture, ready) {
  fs.rmSync(fixture.boundaryFile, { force: true })
  const child = fork(workerFile, [mode], {
    cwd: repoRoot,
    env: workerEnvironment(fixture),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  let stdout = ''
  let stderr = ''
  let exitResult
  let workerMessage
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.on('message', (value) => { workerMessage = value })
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      exitResult = { code, signal }
      resolve(exitResult)
    })
  })
  const deadline = Date.now() + crashBoundaryTimeoutMs
  while (Date.now() < deadline) {
    if (exitResult) {
      throw new Error(
        `${mode} exited before crash boundary (${exitResult.code}/${exitResult.signal})\n` +
        `${workerMessage?.message ?? ''}\n${stdout}\n${stderr}`
      )
    }
    if (fs.existsSync(fixture.boundaryFile) && ready()) break
    await delay(20)
  }
  if (!fs.existsSync(fixture.boundaryFile) || !ready()) {
    killChildTree(child)
    await exited
    throw new Error(`${mode} timed out waiting for crash boundary\n${stdout}\n${stderr}`)
  }
  const payload = JSON.parse(fs.readFileSync(fixture.boundaryFile, 'utf8'))
  killChildTree(child)
  await exited
  if (!exitResult || (exitResult.code === 0 && !exitResult.signal)) {
    throw new Error(`${mode} was not forcibly terminated\n${stdout}\n${stderr}`)
  }
  return payload
}

function runResumeWorker(mode, fixture) {
  return new Promise((resolve, reject) => {
    const child = fork(workerFile, [mode], {
      cwd: repoRoot,
      env: workerEnvironment(fixture),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
    let stdout = ''
    let stderr = ''
    let message
    const timer = setTimeout(() => {
      killChildTree(child)
      reject(new Error(`${mode} timed out\n${stdout}\n${stderr}`))
    }, 30_000)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('message', (value) => {
      message = value
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(
          `${mode} failed (${code}/${signal})\n${message?.message ?? ''}\n${stdout}\n${stderr}`
        ))
        return
      }
      if (!message || message.type !== 'resume-result') {
        reject(new Error(`${mode} exited without resume evidence\n${stdout}\n${stderr}`))
        return
      }
      resolve(message)
    })
  })
}

function workerEnvironment(fixture) {
  const env = sanitizedGitEnvironment(process.env)
  return {
    ...env,
    CAOGEN_DAG_FINALIZATION_ROOT: tempRoot,
    CAOGEN_DAG_FINALIZATION_BUILD: buildDir,
    CAOGEN_DAG_FINALIZATION_USER_DATA: fixture.userData,
    CAOGEN_DAG_SCENARIO_ROOT: fixture.root,
    CAOGEN_DAG_USER_DATA: fixture.userData,
    CAOGEN_DAG_PROJECT: fixture.project,
    CAOGEN_DAG_BOUNDARY_FILE: fixture.boundaryFile,
    CAOGEN_DAG_PARENT_ID_FILE: fixture.parentIdFile,
    CAOGEN_DAG_PATCH_COUNTER: fixture.patchCounter,
    CAOGEN_DAG_REVERSE_COUNTER: fixture.reverseCounter,
    CAOGEN_DAG_OPERATION_COUNTER: fixture.operationCounter,
    CAOGEN_DAG_SUMMARY_COUNTER: fixture.summaryCounter,
    CAOGEN_DAG_REPLAY_COUNTER: fixture.replayCounter,
    CAOGEN_DAG_BLOCKED_HOOK_COUNTER: fixture.blockedHookCounter,
    CAOGEN_DAG_VERIFY_COUNTER: fixture.verificationCounter,
    CAOGEN_DAG_PHASE_LOG: fixture.phaseLog,
    CAOGEN_DAG_VERIFIER_FILE: fixture.verifierFile
  }
}

function killChildTree(child) {
  if (!child.pid) return
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' })
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    // The worker may already have exited after reporting a failure.
  }
}

function sendAndExit(payload) {
  if (process.send) {
    process.send(payload, () => process.exit(0))
  } else {
    console.log(JSON.stringify(payload))
    process.exit(0)
  }
}

function workerFailure(error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  if (process.send) {
    process.send({ type: 'worker-error', message }, () => process.exit(1))
  } else {
    console.error(message)
    process.exit(1)
  }
}

async function waitForRecord(snapshotStore, phase, timeoutMs) {
  let latest
  try {
    await waitFor(async () => {
      const records = await snapshotStore.listTaskDagFinalizations()
      latest = records[0]
      return latest?.phase === phase
    }, timeoutMs, `finalizer phase ${phase}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}; latest=${JSON.stringify(latest)}`)
  }
  return latest
}

function waitFor(predicate, timeoutMs = 5000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        if (await predicate()) return resolve()
        if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${label}`))
        setTimeout(tick, 20)
      } catch (error) {
        reject(error)
      }
    }
    void tick()
  })
}

function onlyRecord(records, label) {
  assert.equal(records.length, 1, `${label} must contain exactly one finalization record`)
  return records[0]
}

async function assertOperationEffect(snapshotStore, operationId, userData, status) {
  const evidence = await operationEffectEvidence(snapshotStore, operationId, userData)
  assert.equal(evidence.count, 1, `${operationId} must own exactly one Effect`)
  assert.equal(evidence.status, status)
}

async function operationEffectEvidence(snapshotStore, operationId, userData) {
  if (!operationId) return { count: 0, status: undefined }
  const runs = await snapshotStore.listTaskRuns(`operation:${operationId}`, userData)
  const effects = runs.flatMap((run) => run.effects ?? [])
  return { count: effects.length, status: effects[0]?.status }
}

function transcriptMessageCount(userData, sdkSessionId, messageId) {
  const file = path.join(userData, 'transcripts', `${sdkSessionId}.jsonl`)
  if (!fs.existsSync(file)) return 0
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((entry) => entry?.event?.kind === 'user-message' && entry.event.messageId === messageId)
    .length
}

function lineCount(file) {
  if (!fs.existsSync(file)) return 0
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length
}

function readLines(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
}

function operationDirectionCount(file, direction) {
  return readLines(file).filter((line) => line === direction || line.startsWith(`${direction}:`)).length
}

function operationTaskCount(file, direction, taskId) {
  return readLines(file).filter((line) => line === `${direction}:${taskId}`).length
}

function mutationFileCount(file, changedFile) {
  return readLines(file).filter((line) => line === changedFile).length
}

function patchMutationFile(patchText) {
  const match = /^diff --git a\/(.+?) b\/(.+)$/m.exec(String(patchText ?? ''))
  return match?.[2] ?? 'unknown'
}

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    env: sanitizedGitEnvironment(process.env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`)
  }
  return result.stdout.trim()
}

function sanitizedGitEnvironment(source) {
  const env = { ...source }
  for (const key of Object.keys(env)) {
    if (
      key === 'GIT_DIR' ||
      key === 'GIT_WORK_TREE' ||
      key === 'GIT_INDEX_FILE' ||
      key === 'GIT_COMMON_DIR' ||
      key === 'GIT_OBJECT_DIRECTORY' ||
      key === 'GIT_ALTERNATE_OBJECT_DIRECTORIES' ||
      key === 'GIT_CONFIG' ||
      key === 'GIT_CONFIG_GLOBAL' ||
      key === 'GIT_CONFIG_SYSTEM' ||
      key === 'GIT_CONFIG_NOSYSTEM' ||
      key.startsWith('GIT_CONFIG_KEY_') ||
      key.startsWith('GIT_CONFIG_VALUE_')
    ) {
      delete env[key]
    }
  }
  return env
}

function compileSources() {
  fs.mkdirSync(buildDir, { recursive: true })
  const result = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/sessionManager.ts',
      'src/main/task/task-snapshot.ts',
      'src/main/agent/dag-finalization.ts',
      'src/main/ipc/worktree-operation-handlers.ts',
      'src/main/transcript.ts',
      '--outDir', buildDir,
      '--rootDir', 'src',
      '--module', 'commonjs',
      '--target', 'es2022',
      '--moduleResolution', 'node',
      '--types', 'node',
      '--skipLibCheck',
      '--esModuleInterop'
    ],
    { cwd: repoRoot, encoding: 'utf8' }
  )
  const sessionManagerPath = path.join(buildDir, 'main', 'sessionManager.js')
  if (!fs.existsSync(sessionManagerPath)) {
    throw new Error(`failed to compile DAG finalization harness\n${result.stdout}\n${result.stderr}`)
  }
  if (result.status !== 0) {
    console.warn('[task-dag-finalization-crash-e2e] tsc emitted diagnostics; strict typecheck remains a separate gate.')
  }
}

function compiled(relativePath) {
  const target = path.join(buildDir, relativePath)
  if (!fs.existsSync(target)) throw new Error(`compiled module missing: ${relativePath}`)
  return require(target)
}

function installModuleStubs() {
  const originalLoad = Module._load
  const electronStub = {
    app: {
      getPath: () => process.env.CAOGEN_DAG_FINALIZATION_USER_DATA ?? tempRoot,
      getName: () => 'CaoGen-DagFinalizationCrashE2E',
      getVersion: () => '0.0.0-test',
      isPackaged: false,
      setName() {},
      setPath() {}
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: () => { throw new Error('safeStorage unavailable in crash harness') },
      decryptString: () => { throw new Error('safeStorage unavailable in crash harness') }
    },
    powerSaveBlocker: { start: () => 1, stop() {}, isStarted: () => false },
    Notification: class {
      static isSupported() { return false }
      on() {}
      once() {}
      show() {}
    },
    BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
    WebContentsView: class {},
    ipcMain: { handle() {} },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { showItemInFolder() {}, openExternal: async () => {} }
  }
  const sdkStub = { query: () => ({ async *[Symbol.asyncIterator]() {} }) }
  Module._load = function patchedLoad(request) {
    if (request === 'electron') return electronStub
    if (request === '@anthropic-ai/claude-agent-sdk') return sdkStub
    if (request === './terminal' || request.endsWith('/terminal')) {
      return {
        terminalManager: {
          subscribe: () => () => {},
          list: () => [],
          start: async () => ({
            id: 'terminal-test',
            cwd: tempRoot,
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

function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`missing worker environment: ${name}`)
  return value
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

module.exports = {
  finalizationSnapshot,
  assertTerminalFinalizationSnapshot,
  terminalExecution,
  sessionMeta,
  oneTaskDag,
  twoTaskRollbackDag,
  childTaskFile,
  prepareScenario,
  fixtureFromEnvironment,
  verificationCommand,
  verificationFailureCommand,
  signalBoundary,
  runCrashWorker,
  runResumeWorker,
  sendAndExit,
  workerFailure,
  waitForRecord,
  waitFor,
  onlyRecord,
  assertOperationEffect,
  operationEffectEvidence,
  transcriptMessageCount,
  lineCount,
  readLines,
  operationDirectionCount,
  operationTaskCount,
  mutationFileCount,
  patchMutationFile,
  git,
  compileSources,
  compiled,
  installModuleStubs,
  delay
}
