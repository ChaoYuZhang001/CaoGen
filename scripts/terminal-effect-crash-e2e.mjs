import { createHash } from 'node:crypto'
import { execFileSync, fork } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const workerMode = process.argv[2]
const tempRoot = process.env.CAOGEN_TERMINAL_EFFECT_ROOT
  ?? mkdtempSync(path.join(tmpdir(), 'caogen-terminal-effect-'))
const outDir = process.env.CAOGEN_TERMINAL_EFFECT_COMPILED ?? path.join(tempRoot, 'compiled')
const userData = process.env.CAOGEN_TERMINAL_EFFECT_USER_DATA ?? path.join(tempRoot, 'user-data')
const commandCanary = 'printf TERMINAL_COMMAND_PRIVATE_42'
const terminalIdCanary = 'terminal-id-private-42'

process.env.CAOGEN_TEST_USER_DATA = userData
process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter)
require('node:module').Module._initPaths()

if (workerMode) {
  await runWorker(workerMode)
} else {
  try {
    compileSources()
    installElectronStub()
    const modules = await loadModules()
    await successAndPrivacyCases(modules)
    await failureCase(modules)
    await crashRecoveryCase()
    console.log('terminal effect crash e2e: PASS')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function successAndPrivacyCases(modules) {
  const calls = []
  const info = terminalInfo(terminalIdCanary, 'terminal-session-success')
  let current = info
  const manager = {
    get: (id) => current?.id === id ? { ...current } : undefined,
    start: async (options) => {
      calls.push({ action: 'start', options })
      current = { ...info, cols: options.cols, rows: options.rows }
      return { ...current }
    },
    write: (id, data) => calls.push({ action: 'write', id, data }),
    resize: (id, cols, rows) => calls.push({ action: 'resize', id, cols, rows }),
    close: (id) => {
      calls.push({ action: 'close', id })
      current = undefined
    }
  }
  const observedInputs = []
  let barriers = 0
  const observingGateway = (spec) => modules.gateway.executeInteractiveOperationEffect({
    ...spec,
    execute: async (effect) => {
      const snapshot = await modules.snapshotStore.getTaskSnapshot(effect.sessionId)
      const persisted = snapshot?.run?.effects?.find((item) => item.id === effect.id)
      assertEqual(persisted?.status, 'executing', 'terminal action must start after durable executing state')
      assertEqual(persisted?.target?.kind, 'unsupported')
      assertEqual(persisted?.target?.toolName, spec.toolName)
      assertEqual(snapshot?.run?.operation?.kind, 'terminal_action')
      observedInputs.push({ toolName: spec.toolName, input: spec.toolInput })
      barriers += 1
      return spec.execute(effect)
    }
  })

  const started = await modules.terminalEffect.startTerminalWithEffect(
    { sourceSessionId: info.sessionId, projectId: 'terminal-project', cwd: info.cwd },
    manager,
    { cols: 100.8, rows: 28.9, reuse: true },
    observingGateway
  )
  assert(started.ok, JSON.stringify(started))
  assertEqual(started.terminal.id, terminalIdCanary)
  assertEqual(calls[0].options.cols, 100)
  assertEqual(calls[0].options.rows, 28)

  const written = await modules.terminalEffect.writeTerminalWithEffect(
    manager,
    terminalIdCanary,
    `${commandCanary}\n`,
    observingGateway
  )
  assert(written.ok, JSON.stringify(written))
  const writeInput = observedInputs.find((item) => item.toolName === 'terminal_write')?.input
  assert(writeInput, 'terminal write input summary missing')
  assertEqual(
    writeInput.dataSha256,
    createHash('sha256').update(`${commandCanary}\n`, 'utf8').digest('hex')
  )
  assertEqual(writeInput.bytes, Buffer.byteLength(`${commandCanary}\n`, 'utf8'))
  assert(!JSON.stringify(writeInput).includes(commandCanary), 'terminal command entered persisted Effect input')
  assert(!JSON.stringify(writeInput).includes(terminalIdCanary), 'raw terminal id entered persisted Effect input')

  const resized = await modules.terminalEffect.resizeTerminalWithEffect(
    manager,
    terminalIdCanary,
    5000,
    Number.NaN,
    observingGateway
  )
  assert(resized.ok, JSON.stringify(resized))
  const resizeCall = calls.find((item) => item.action === 'resize')
  assertEqual(resizeCall.cols, 1000)
  assertEqual(resizeCall.rows, 28)

  const closed = await modules.terminalEffect.closeTerminalWithEffect(
    manager,
    terminalIdCanary,
    observingGateway
  )
  assert(closed.ok, JSON.stringify(closed))
  assertEqual(barriers, 4, 'all terminal mutations must cross a durable barrier')

  const missingWrite = await modules.terminalEffect.writeTerminalWithEffect(
    manager,
    terminalIdCanary,
    'not-executed',
    observingGateway
  )
  assert(!missingWrite.ok)
  const repeatedClose = await modules.terminalEffect.closeTerminalWithEffect(
    manager,
    terminalIdCanary,
    observingGateway
  )
  assert(repeatedClose.ok, 'closing an already absent terminal must remain idempotent')
  assertEqual(barriers, 4, 'non-mutating missing-terminal paths must not create Effects')

  assertDatabaseExcludes([commandCanary, terminalIdCanary])
}

async function failureCase(modules) {
  const failureCommand = 'TERMINAL_FAILURE_COMMAND_PRIVATE_73'
  const failingInfo = terminalInfo('terminal-id-failure-private-73', 'terminal-session-failure')
  const failingManager = {
    get: () => ({ ...failingInfo }),
    start: async () => ({ ...failingInfo }),
    write: () => { throw new Error('simulated terminal stream failure') },
    resize: () => undefined,
    close: () => undefined
  }
  const failed = await modules.terminalEffect.writeTerminalWithEffect(
    failingManager,
    failingInfo.id,
    failureCommand,
    modules.gateway.executeInteractiveOperationEffect
  )
  assert(!failed.ok, 'opaque terminal write failure must not report success')
  assertEqual(failed.effectStatus, 'waiting_reconciliation')
  assert(typeof failed.snapshotId === 'string' && failed.snapshotId.length > 0)
  const failureSnapshot = await modules.snapshotStore.getTaskSnapshot(failed.snapshotId)
  assertEqual(failureSnapshot?.run?.status, 'waiting_reconciliation')
  assertEqual(failureSnapshot?.run?.effects?.[0]?.target?.kind, 'unsupported')

  const runs = await modules.snapshotStore.listTaskRuns()
  const terminalRuns = runs.filter((run) => run.operation?.kind === 'terminal_action')
  assert(terminalRuns.length >= 5, 'terminal operation history missing')
  assert(terminalRuns.filter((run) => run.status === 'completed').every(
    (run) => run.effects.length === 1 && run.effects[0].status === 'confirmed'
  ), 'successful terminal effects did not settle confirmed')
  assertDatabaseExcludes([failureCommand, failingInfo.id])
}

async function crashRecoveryCase() {
  const crashed = await runChild('crash', true)
  assertEqual(crashed.message.type, 'terminal-mutation-boundary')
  assertEqual(crashed.message.effectStatus, 'executing')
  assertEqual(crashed.message.targetKind, 'unsupported')

  const resumed = await runChild('resume', false)
  assertEqual(resumed.message.effectStatus, 'waiting_reconciliation')
  assertEqual(resumed.message.runStatus, 'waiting_reconciliation')
  assertEqual(resumed.message.snapshotExists, true)
  assertEqual(counterLines(), 1, 'opaque terminal crash recovery must never replay terminal input')
  assertDatabaseExcludes([crashCommand(), crashTerminalId()])
}

async function runWorker(mode) {
  const modules = await loadModules()
  if (mode === 'crash') return crashWorker(modules)
  if (mode === 'resume') return resumeWorker(modules)
  throw new Error(`unknown worker mode: ${mode}`)
}

async function crashWorker(modules) {
  const info = terminalInfo(crashTerminalId(), 'terminal-session-crash')
  const manager = {
    get: () => ({ ...info }),
    start: async () => ({ ...info }),
    write: () => appendFileSync(counterFile(), 'write\n'),
    resize: () => undefined,
    close: () => undefined
  }
  const result = await modules.terminalEffect.writeTerminalWithEffect(
    manager,
    info.id,
    crashCommand(),
    (spec) => modules.gateway.executeInteractiveOperationEffect({
      ...spec,
      operationId: 'terminal-write-crash',
      execute: async (effect) => {
        const value = await spec.execute(effect)
        const snapshot = await modules.snapshotStore.getTaskSnapshot(effect.sessionId)
        const persisted = snapshot?.run?.effects?.find((item) => item.id === effect.id)
        process.send?.({
          type: 'terminal-mutation-boundary',
          effectStatus: persisted?.status,
          targetKind: persisted?.target?.kind
        })
        await new Promise(() => {})
        return value
      }
    })
  )
  throw new Error(`crash worker unexpectedly completed: ${JSON.stringify(result)}`)
}

async function resumeWorker(modules) {
  const scopeId = 'operation:terminal-write-crash'
  const snapshot = await modules.snapshotStore.getTaskSnapshot(scopeId)
  assert(snapshot?.run, 'terminal crash recovery snapshot missing')
  const reconciled = await modules.effectRuntime.reconcilePersistedTaskSnapshot(snapshot)
  const effectStatus = reconciled.run?.effects?.[0]?.status
  await modules.gateway.settleStoppedInteractiveOperationSnapshot(reconciled)
  const current = await modules.snapshotStore.getTaskSnapshot(scopeId)
  process.send?.({
    effectStatus,
    snapshotExists: current !== null,
    runStatus: current?.run?.status
  })
}

function runChild(mode, killAfterMessage) {
  return new Promise((resolve, reject) => {
    const child = fork(process.argv[1], [mode], {
      env: {
        ...process.env,
        CAOGEN_TERMINAL_EFFECT_ROOT: tempRoot,
        CAOGEN_TERMINAL_EFFECT_COMPILED: outDir,
        CAOGEN_TERMINAL_EFFECT_USER_DATA: userData
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
    let stdout = ''
    let stderr = ''
    let message
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${mode} timed out\n${stdout}\n${stderr}`))
    }, 30_000)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('message', (value) => {
      message = value
      if (killAfterMessage) child.kill('SIGKILL')
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (!message) return reject(new Error(`${mode} exited without evidence (${code}/${signal})\n${stdout}\n${stderr}`))
      if (killAfterMessage && signal !== 'SIGKILL') {
        return reject(new Error(`${mode} expected SIGKILL, got ${code}/${signal}`))
      }
      if (!killAfterMessage && code !== 0) return reject(new Error(`${mode} failed (${code})\n${stdout}\n${stderr}`))
      resolve({ message, stdout, stderr })
    })
  })
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/terminalEffect.ts',
    'src/main/task/operation-effect-gateway.ts',
    '--outDir', outDir,
    '--rootDir', 'src',
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop',
    '--strict'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installElectronStub() {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'),
    'export const app = { getPath: () => process.env.CAOGEN_TEST_USER_DATA }\n')
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

async function loadModules() {
  return {
    terminalEffect: await importModule('main/terminalEffect.js'),
    gateway: await importModule('main/task/operation-effect-gateway.js'),
    effectRuntime: await importModule('main/task/effect-runtime.js'),
    snapshotStore: await importModule('main/task/task-snapshot.js')
  }
}

function importModule(relativePath) {
  return import(pathToFileURL(path.join(outDir, relativePath)).href)
}

function terminalInfo(id, sessionId) {
  return {
    id,
    sessionId,
    cwd: tempRoot,
    shell: '/bin/zsh',
    pid: 4242,
    backend: 'pty',
    cols: 100,
    rows: 28,
    startedAt: Date.now()
  }
}

function counterFile() {
  return path.join(tempRoot, 'terminal-write-count.txt')
}

function counterLines() {
  if (!existsSync(counterFile())) return 0
  return readFileSync(counterFile(), 'utf8').split('\n').filter(Boolean).length
}

function crashCommand() {
  return 'TERMINAL_CRASH_COMMAND_PRIVATE_91'
}

function crashTerminalId() {
  return 'terminal-id-crash-private-91'
}

function assertDatabaseExcludes(values) {
  const dbPath = path.join(userData, 'task-snapshots.db')
  assert(existsSync(dbPath), 'task snapshot database missing')
  const database = readFileSync(dbPath)
  for (const value of values) {
    assert(!database.includes(Buffer.from(value)), `terminal private value leaked into task database: ${value}`)
  }
}

function assertEqual(actual, expected, message = '') {
  if (actual !== expected) {
    throw new Error(`${message ? `${message}: ` : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
