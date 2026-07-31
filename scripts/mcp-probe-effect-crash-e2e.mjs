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
const tempRoot = process.env.CAOGEN_MCP_PROBE_EFFECT_ROOT
  ?? mkdtempSync(path.join(tmpdir(), 'caogen-mcp-probe-effect-'))
const outDir = process.env.CAOGEN_MCP_PROBE_EFFECT_COMPILED ?? path.join(tempRoot, 'compiled')
const userData = process.env.CAOGEN_MCP_PROBE_EFFECT_USER_DATA ?? path.join(tempRoot, 'user-data')

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
    await successCase()
    await crashCase()
    console.log('mcp probe effect crash e2e: PASS')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function successCase() {
  const modules = await loadModules()
  const inputs = sensitiveInputs('success')
  let durableBarrierObserved = false
  const result = await modules.mcpProbeEffect.executeMcpProbeEffect(
    effectContext('success'),
    inputs,
    (spec) => modules.gateway.executeInteractiveOperationEffect({
      ...spec,
      operationId: 'mcp-probe-success',
      execute: async (effect) => {
        const snapshot = await modules.snapshotStore.getTaskSnapshot(effect.sessionId)
        const persisted = snapshot?.run?.effects?.find((item) => item.id === effect.id)
        assertEqual(persisted?.status, 'executing', 'probe must start after durable executing state')
        assertEqual(persisted?.target?.kind, 'unsupported')
        assertEqual(persisted?.target?.toolName, 'mcp_runtime_probe')
        durableBarrierObserved = true
        return spec.execute(effect)
      }
    }),
    async (received) => probeResults(received, 'success')
  )
  assert(result.ok, JSON.stringify(result))
  assert(durableBarrierObserved, 'durable barrier was not observed')
  assertEqual(result.effectStatus, 'confirmed')
  assertEqual(result.results.length, 1)
  assertEqual(result.results[0].ok, false, 'unreachable server is a completed probe result')
  assertEqual(await modules.snapshotStore.getTaskSnapshot('operation:mcp-probe-success'), null)
  assertDatabaseExcludes(sensitiveCanaries('success'))
}

async function crashCase() {
  const crashed = await runChild('crash', true)
  assertEqual(crashed.message.effectStatus, 'executing')
  assertEqual(crashed.message.targetKind, 'unsupported')
  assertEqual(crashed.message.toolName, 'mcp_runtime_probe')
  assertDatabaseExcludes(sensitiveCanaries('crash'))

  const resumed = await runChild('resume', false)
  assertEqual(resumed.message.effectStatus, 'waiting_reconciliation')
  assertEqual(resumed.message.snapshotExists, true)
  assertEqual(resumed.message.runStatus, 'waiting_reconciliation')
  assertEqual(counterLines(), 1, 'opaque recovery must not replay the MCP probe callback')
}

async function runWorker(mode) {
  const modules = await loadModules()
  if (mode === 'crash') return crashWorker(modules)
  if (mode === 'resume') return resumeWorker(modules)
  throw new Error(`unknown worker mode: ${mode}`)
}

async function crashWorker(modules) {
  const result = await modules.mcpProbeEffect.executeMcpProbeEffect(
    effectContext('crash'),
    sensitiveInputs('crash'),
    (spec) => modules.gateway.executeInteractiveOperationEffect({
      ...spec,
      operationId: 'mcp-probe-crash',
      execute: async (effect) => {
        appendFileSync(counterFile(), 'callback\n')
        const value = await spec.execute(effect)
        assertEqual(value.length, 1)
        const snapshot = await modules.snapshotStore.getTaskSnapshot(effect.sessionId)
        const persisted = snapshot?.run?.effects?.find((item) => item.id === effect.id)
        process.send?.({
          effectStatus: persisted?.status,
          targetKind: persisted?.target?.kind,
          toolName: persisted?.target?.toolName
        })
        await new Promise(() => {})
      }
    }),
    async (received) => probeResults(received, 'crash')
  )
  throw new Error(`crash worker unexpectedly completed: ${JSON.stringify(result)}`)
}

async function resumeWorker(modules) {
  const scopeId = 'operation:mcp-probe-crash'
  const snapshot = await modules.snapshotStore.getTaskSnapshot(scopeId)
  assert(snapshot?.run, 'MCP probe recovery snapshot missing')
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
        CAOGEN_MCP_PROBE_EFFECT_ROOT: tempRoot,
        CAOGEN_MCP_PROBE_EFFECT_COMPILED: outDir,
        CAOGEN_MCP_PROBE_EFFECT_USER_DATA: userData
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
      if (killAfterMessage && signal !== 'SIGKILL') return reject(new Error(`${mode} expected SIGKILL, got ${code}/${signal}`))
      if (!killAfterMessage && code !== 0) return reject(new Error(`${mode} failed (${code})\n${stdout}\n${stderr}`))
      resolve({ message, stdout, stderr })
    })
  })
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/mcpProbeEffect.ts',
    'src/main/task/operation-effect-gateway.ts',
    '--outDir', outDir,
    '--rootDir', 'src',
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
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
    mcpProbeEffect: await importModule('main/mcpProbeEffect.js'),
    gateway: await importModule('main/task/operation-effect-gateway.js'),
    effectRuntime: await importModule('main/task/effect-runtime.js'),
    snapshotStore: await importModule('main/task/task-snapshot.js')
  }
}

function importModule(relativePath) {
  return import(pathToFileURL(path.join(outDir, relativePath)).href)
}

function effectContext(caseName) {
  return {
    sourceSessionId: `mcp-probe:test-${caseName}`,
    cwd: tempRoot
  }
}

function sensitiveInputs(caseName) {
  const canaries = sensitiveCanaries(caseName)
  return [{
    id: canaries.id,
    config: {
      url: `https://probe.invalid/${canaries.url}`,
      command: canaries.command,
      args: [canaries.argument],
      env: { MCP_TOKEN: canaries.token },
      headers: { Authorization: canaries.header }
    }
  }]
}

function probeResults(inputs, caseName) {
  assertEqual(inputs.length, 1)
  return [{
    id: inputs[0].id,
    ok: false,
    transport: 'http',
    error: sensitiveCanaries(caseName).resultError
  }]
}

function sensitiveCanaries(caseName) {
  const suffix = caseName.toUpperCase()
  return {
    id: `MCP_ID_${suffix}_SENSITIVE`,
    url: `MCP_URL_${suffix}_SENSITIVE`,
    command: `MCP_COMMAND_${suffix}_SENSITIVE`,
    argument: `MCP_ARGUMENT_${suffix}_SENSITIVE`,
    token: `MCP_TOKEN_${suffix}_SENSITIVE`,
    header: `MCP_HEADER_${suffix}_SENSITIVE`,
    resultError: `MCP_RESULT_ERROR_${suffix}_SENSITIVE`
  }
}

function counterFile() {
  return path.join(tempRoot, 'crash-probe-count.txt')
}

function counterLines() {
  if (!existsSync(counterFile())) return 0
  return readFileSync(counterFile(), 'utf8').split('\n').filter(Boolean).length
}

function assertDatabaseExcludes(values) {
  const dbPath = path.join(userData, 'task-snapshots.db')
  assert(existsSync(dbPath), 'task snapshot database missing')
  const database = readFileSync(dbPath)
  for (const value of Object.values(values)) {
    assert(!database.includes(Buffer.from(value)), `sensitive MCP probe value leaked into task database: ${value}`)
  }
}

function assertEqual(actual, expected, message = '') {
  if (actual !== expected) throw new Error(`${message ? `${message}: ` : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
