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
const tempRoot = process.env.CAOGEN_BROWSER_EFFECT_ROOT
  ?? mkdtempSync(path.join(tmpdir(), 'caogen-browser-effect-'))
const outDir = process.env.CAOGEN_BROWSER_EFFECT_COMPILED ?? path.join(tempRoot, 'compiled')
const userData = process.env.CAOGEN_BROWSER_EFFECT_USER_DATA ?? path.join(tempRoot, 'user-data')
const sessionId = 'browser-session-effect-42'
const firstUrl = 'https://browser-private.example/path/OPEN_PRIVATE_42?token=QUERY_PRIVATE_42#FRAGMENT_PRIVATE_42'
const secondUrl = 'https://next-private.example/NAVIGATE_PRIVATE_73?credential=QUERY_PRIVATE_73'

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
    console.log('browser effect crash e2e: PASS')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function successAndPrivacyCases(modules) {
  const calls = []
  let current
  const manager = browserManager(calls, () => current, (next) => { current = next })
  const observedInputs = []
  let barriers = 0
  const observingGateway = (spec) => modules.gateway.executeInteractiveOperationEffect({
    ...spec,
    execute: async (effect) => {
      const snapshot = await modules.snapshotStore.getTaskSnapshot(effect.sessionId)
      const persisted = snapshot?.run?.effects?.find((item) => item.id === effect.id)
      assertEqual(persisted?.status, 'executing', 'browser navigation must start after durable executing state')
      assertEqual(persisted?.target?.kind, 'unsupported')
      assertEqual(persisted?.target?.toolName, spec.toolName)
      assertEqual(snapshot?.run?.operation?.kind, 'browser_navigation')
      observedInputs.push({ toolName: spec.toolName, input: spec.toolInput })
      barriers += 1
      return spec.execute(effect)
    }
  })
  const context = browserContext()

  const opened = await modules.browserEffect.openBrowserWithEffect(
    context, manager, {}, firstUrl, observingGateway
  )
  assert(opened.ok, JSON.stringify(opened))
  assertEqual(opened.state.url, firstUrl)

  const noOpOpen = await modules.browserEffect.openBrowserWithEffect(
    context, manager, {}, undefined, observingGateway
  )
  assert(noOpOpen.ok, JSON.stringify(noOpOpen))
  assertEqual(barriers, 1, 'opening an existing view without a target must not create an Effect')

  const navigated = await modules.browserEffect.navigateBrowserWithEffect(
    context, manager, secondUrl, observingGateway
  )
  assert(navigated.ok, JSON.stringify(navigated))
  current = { ...current, canGoBack: true }

  const backed = await modules.browserEffect.browserGoBackWithEffect(context, manager, observingGateway)
  assert(backed.ok, JSON.stringify(backed))
  current = { ...current, canGoForward: true }

  const forwarded = await modules.browserEffect.browserGoForwardWithEffect(context, manager, observingGateway)
  assert(forwarded.ok, JSON.stringify(forwarded))

  const reloaded = await modules.browserEffect.reloadBrowserWithEffect(context, manager, observingGateway)
  assert(reloaded.ok, JSON.stringify(reloaded))
  assertEqual(barriers, 5, 'all page-mutating browser actions must cross a durable barrier')

  const expectedTools = [
    'browser_view_open',
    'browser_view_navigate',
    'browser_view_back',
    'browser_view_forward',
    'browser_view_reload'
  ]
  assertEqual(JSON.stringify(observedInputs.map((item) => item.toolName)), JSON.stringify(expectedTools))
  const openInput = observedInputs[0].input
  assertEqual(openInput.protocol, 'https:')
  assertEqual(openInput.targetDigest, sha256(firstUrl))
  assertEqual(openInput.hostDigest, sha256('browser-private.example'))
  assertEqual(openInput.hasQuery, true)
  assertEqual(openInput.hasFragment, true)
  assert(!JSON.stringify(observedInputs).includes('PRIVATE_'), 'raw browser URL entered persisted Effect input')

  assertEqual(calls.filter((item) => item.action === 'open').length, 1)
  assertEqual(calls.filter((item) => item.action === 'navigate').length, 1)
  assertEqual(calls.filter((item) => item.action === 'back').length, 1)
  assertEqual(calls.filter((item) => item.action === 'forward').length, 1)
  assertEqual(calls.filter((item) => item.action === 'reload').length, 1)
  assertDatabaseExcludes([firstUrl, secondUrl, 'OPEN_PRIVATE_42', 'NAVIGATE_PRIVATE_73'])
}

async function failureCase(modules) {
  const failureUrl = 'https://failure-private.example/FAILURE_PRIVATE_88?token=FAILURE_QUERY_PRIVATE_88'
  const failureText = `simulated browser failure for ${failureUrl}`
  const state = browserState('https://current.example/', true, false)
  const manager = {
    getState: () => ({ ...state }),
    open: async () => ({ ...state }),
    navigate: async () => { throw new Error(failureText) },
    goBack: async () => ({ ...state }),
    goForward: async () => ({ ...state }),
    reload: async () => ({ ...state })
  }
  const failed = await modules.browserEffect.navigateBrowserWithEffect(
    browserContext(), manager, failureUrl, modules.gateway.executeInteractiveOperationEffect
  )
  assert(!failed.ok, 'opaque browser navigation failure must not report success')
  assertEqual(failed.effectStatus, 'waiting_reconciliation')
  assert(typeof failed.snapshotId === 'string' && failed.snapshotId.length > 0)
  const snapshot = await modules.snapshotStore.getTaskSnapshot(failed.snapshotId)
  assertEqual(snapshot?.run?.status, 'waiting_reconciliation')
  assertEqual(snapshot?.run?.effects?.[0]?.target?.kind, 'unsupported')
  assertDatabaseExcludes([failureUrl, failureText, 'FAILURE_PRIVATE_88', 'FAILURE_QUERY_PRIVATE_88'])
}

async function crashRecoveryCase() {
  const crashed = await runChild('crash', true)
  assertEqual(crashed.message.type, 'browser-mutation-boundary')
  assertEqual(crashed.message.effectStatus, 'executing')
  assertEqual(crashed.message.targetKind, 'unsupported')

  const resumed = await runChild('resume', false)
  assertEqual(resumed.message.effectStatus, 'waiting_reconciliation')
  assertEqual(resumed.message.runStatus, 'waiting_reconciliation')
  assertEqual(resumed.message.snapshotExists, true)
  assertEqual(counterLines(), 1, 'opaque browser crash recovery must never replay navigation')
  assertDatabaseExcludes([crashUrl(), 'CRASH_PRIVATE_91'])
}

async function runWorker(mode) {
  const modules = await loadModules()
  if (mode === 'crash') return crashWorker(modules)
  if (mode === 'resume') return resumeWorker(modules)
  throw new Error(`unknown worker mode: ${mode}`)
}

async function crashWorker(modules) {
  const state = browserState('https://before-crash.example/', true, false)
  const manager = {
    getState: () => ({ ...state }),
    open: async () => ({ ...state }),
    navigate: async (_id, url) => {
      appendFileSync(counterFile(), 'navigate\n')
      return browserState(url, true, false)
    },
    goBack: async () => ({ ...state }),
    goForward: async () => ({ ...state }),
    reload: async () => ({ ...state })
  }
  const result = await modules.browserEffect.navigateBrowserWithEffect(
    browserContext(),
    manager,
    crashUrl(),
    (spec) => modules.gateway.executeInteractiveOperationEffect({
      ...spec,
      operationId: 'browser-navigate-crash',
      execute: async (effect) => {
        const value = await spec.execute(effect)
        const snapshot = await modules.snapshotStore.getTaskSnapshot(effect.sessionId)
        const persisted = snapshot?.run?.effects?.find((item) => item.id === effect.id)
        process.send?.({
          type: 'browser-mutation-boundary',
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
  const scopeId = 'operation:browser-navigate-crash'
  const snapshot = await modules.snapshotStore.getTaskSnapshot(scopeId)
  assert(snapshot?.run, 'browser crash recovery snapshot missing')
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

function browserManager(calls, getCurrent, setCurrent) {
  return {
    getState: () => getCurrent() ? { ...getCurrent() } : undefined,
    open: async (_owner, id, url) => {
      calls.push({ action: 'open', id, url })
      const state = browserState(url, false, false)
      setCurrent(state)
      return { ...state }
    },
    navigate: async (id, url) => {
      calls.push({ action: 'navigate', id, url })
      const state = browserState(url, true, false)
      setCurrent(state)
      return { ...state }
    },
    goBack: async (id) => {
      calls.push({ action: 'back', id })
      const state = browserState('https://back.example/', false, true)
      setCurrent(state)
      return { ...state }
    },
    goForward: async (id) => {
      calls.push({ action: 'forward', id })
      const state = browserState(secondUrl, true, false)
      setCurrent(state)
      return { ...state }
    },
    reload: async (id) => {
      calls.push({ action: 'reload', id })
      return { ...getCurrent() }
    }
  }
}

function browserContext() {
  return { sourceSessionId: sessionId, projectId: 'browser-project', cwd: tempRoot }
}

function browserState(url, canGoBack, canGoForward) {
  return {
    sessionId,
    url,
    title: 'PRIVATE_BROWSER_TITLE_NOT_PERSISTED',
    loading: false,
    canGoBack,
    canGoForward
  }
}

function runChild(mode, killAfterMessage) {
  return new Promise((resolve, reject) => {
    const child = fork(process.argv[1], [mode], {
      env: {
        ...process.env,
        CAOGEN_BROWSER_EFFECT_ROOT: tempRoot,
        CAOGEN_BROWSER_EFFECT_COMPILED: outDir,
        CAOGEN_BROWSER_EFFECT_USER_DATA: userData
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
    'src/main/browserEffect.ts',
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
    browserEffect: await importModule('main/browserEffect.js'),
    gateway: await importModule('main/task/operation-effect-gateway.js'),
    effectRuntime: await importModule('main/task/effect-runtime.js'),
    snapshotStore: await importModule('main/task/task-snapshot.js')
  }
}

function importModule(relativePath) {
  return import(pathToFileURL(path.join(outDir, relativePath)).href)
}

function counterFile() {
  return path.join(tempRoot, 'browser-navigation-count.txt')
}

function counterLines() {
  if (!existsSync(counterFile())) return 0
  return readFileSync(counterFile(), 'utf8').split('\n').filter(Boolean).length
}

function crashUrl() {
  return 'https://crash-private.example/CRASH_PRIVATE_91?token=CRASH_QUERY_PRIVATE_91'
}

function assertDatabaseExcludes(values) {
  const dbPath = path.join(userData, 'task-snapshots.db')
  assert(existsSync(dbPath), 'task snapshot database missing')
  const database = readFileSync(dbPath)
  for (const value of values) {
    assert(!database.includes(Buffer.from(value)), `browser private value leaked into task database: ${value}`)
  }
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function assertEqual(actual, expected, message = '') {
  if (actual !== expected) {
    throw new Error(`${message ? `${message}: ` : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
