import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-workflow-ingress-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
const disabledMethods = ['createWorkflowGoal', 'createWorkflowWorkItem', 'transitionWorkflowWorkItem']
const disabledChannels = [
  'workflowLedger:createGoal',
  'workflowLedger:createWorkItem',
  'workflowLedger:transitionWorkItem'
]

try {
  assertStaticIngress()
  compileHandler()
  installElectronStub()
  const electron = await import(pathToFileURL(path.join(outDir, 'node_modules', 'electron', 'index.js')).href)
  const handlersModule = await import(pathToFileURL(findCompiledModule(outDir, 'workflow-ledger-handlers.js')).href)
  handlersModule.registerWorkflowLedgerIpc()

  process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173/'
  const trustedFrame = { url: process.env.ELECTRON_RENDERER_URL }
  const trustedSender = {
    mainFrame: trustedFrame,
    getURL: () => process.env.ELECTRON_RENDERER_URL,
    isDestroyed: () => false
  }
  electron.windows.push({ webContents: trustedSender })
  const trustedEvent = {
    sender: trustedSender,
    senderFrame: trustedFrame
  }

  for (const channel of disabledChannels) {
    const handler = globalThis.__workflowIngressHandlers.get(channel)
    assert(typeof handler === 'function', `${channel} compatibility handler must remain registered`)
    await assertRejects(
      Promise.resolve().then(() => handler(trustedEvent, { arbitrary: true }, 'ignored', -1)),
      (error) => error?.code === 'LEGACY_WRITE_DISABLED' &&
        String(error?.message).includes('LEGACY_WRITE_DISABLED'),
      `${channel} must fail closed with a stable code`
    )
    await assertRejects(
      Promise.resolve().then(() => handler({
        sender: { getURL: () => 'https://remote.invalid', isDestroyed: () => false },
        senderFrame: { url: 'https://remote.invalid' }
      })),
      (error) => String(error?.message).includes('not trusted'),
      `${channel} must still authenticate the sender before reporting cutover`
    )
  }

  console.log(JSON.stringify({
    status: 'PASS',
    disabledRendererMethods: disabledMethods,
    failClosedChannels: disabledChannels,
    errorCode: handlersModule.LEGACY_WRITE_DISABLED
  }, null, 2))
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function assertStaticIngress() {
  const preload = source('src/preload/workflow-ledger.ts')
  const shared = source('src/shared/workflow-types.ts')
  const handlers = source('src/main/ipc/workflow-ledger-handlers.ts')
  const projectPreload = source('src/preload/project-workspace.ts')
  const apiStart = shared.indexOf('export interface WorkflowLedgerApi')
  assert(apiStart >= 0, 'WorkflowLedgerApi contract must exist')
  const apiContract = shared.slice(apiStart, shared.indexOf('\n}', apiStart) + 2)

  for (const method of disabledMethods) {
    assert(!preload.includes(method), `${method} must not be exposed by workflow preload`)
    assert(!apiContract.includes(method), `${method} must not be exposed by WorkflowLedgerApi`)
  }
  for (const channel of disabledChannels) {
    assert(!preload.includes(channel), `${channel} must not be invokable by workflow preload`)
    assert(handlers.includes(`'${channel}'`), `${channel} compatibility handler must remain explicit`)
  }
  assert(!handlers.includes('createWorkflowGoal'), 'renderer handler must not import the low-level Goal writer')
  assert(!handlers.includes('createWorkflowWorkItem'), 'renderer handler must not import the low-level WorkItem writer')
  assert(!handlers.includes('transitionWorkflowWorkItem'), 'renderer handler must not import the low-level transition writer')
  assert(handlers.includes('rejectLegacyWorkflowEntityWrite'), 'legacy writers must share one fail-closed helper')
  assert(projectPreload.includes('createProjectGoal'), 'ProjectWorkspace must retain the renderer Goal command ingress')
  assert(projectPreload.includes('createProjectWorkItem'), 'ProjectWorkspace must retain the renderer WorkItem command ingress')

  const rendererAndPreload = sourcesUnder(['src/renderer', 'src/preload'])
  for (const channel of disabledChannels) {
    assert(!rendererAndPreload.includes(channel), `${channel} must not occur in renderer/preload sources`)
  }
}

function compileHandler() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/ipc/workflow-ledger-handlers.ts',
    '--outDir', outDir,
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
  const moduleSource = [
    `const windows = globalThis.__workflowIngressWindows ??= []`,
    `export const app = { getPath: () => ${JSON.stringify(userData)} }`,
    `export const ipcMain = { handle: (name, handler) => { globalThis.__workflowIngressHandlers ??= new Map(); globalThis.__workflowIngressHandlers.set(name, handler) } }`,
    `export const BrowserWindow = { getAllWindows: () => globalThis.__workflowIngressWindows ?? [] }`,
    `export { windows }`
  ].join('\n') + '\n'
  writeFileSync(path.join(electronDir, 'index.js'), moduleSource)
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

function sourcesUnder(relativeRoots) {
  const chunks = []
  for (const relativeRoot of relativeRoots) collectSources(path.join(repoRoot, relativeRoot), chunks)
  return chunks.join('\n')
}

function collectSources(directory, chunks) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) collectSources(entryPath, chunks)
    else if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name)) chunks.push(readFileSync(entryPath, 'utf8'))
  }
}

function source(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function findCompiledModule(directory, name) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledModule(entryPath, name)
      if (found) return found
    } else if (entry.name === name) {
      return entryPath
    }
  }
  return undefined
}

async function assertRejects(promise, predicate, message) {
  try {
    await promise
  } catch (error) {
    if (predicate(error)) return
    throw new Error(`${message}: unexpected error ${error instanceof Error ? error.stack : String(error)}`)
  }
  throw new Error(`${message}: operation unexpectedly succeeded`)
}

function assert(value, message) {
  if (!value) throw new Error(message)
}
