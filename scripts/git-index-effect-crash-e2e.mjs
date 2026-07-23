import { execFileSync, fork } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const workerMode = process.argv[2]
const tempRoot = process.env.CAOGEN_INDEX_CRASH_ROOT ?? mkdtempSync(path.join(tmpdir(), 'caogen-index-crash-'))
const outDir = process.env.CAOGEN_INDEX_CRASH_COMPILED ?? path.join(tempRoot, 'compiled')
const userData = process.env.CAOGEN_INDEX_CRASH_USER_DATA ?? path.join(tempRoot, 'user-data')
const cleanGitEnv = sanitizedGitEnvironment(process.env)

process.env.CAOGEN_TEST_USER_DATA = userData
process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter)
require('node:module').Module._initPaths()

if (workerMode) {
  await runWorker(workerMode)
} else {
  try {
    compileSources()
    installElectronStub()
    prepareScenarioRepos()
    await appliedCrashCase()
    await notAppliedCrashCase()
    await divergedCrashCase()
    console.log('git index effect crash e2e: PASS')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function appliedCrashCase() {
  const crash = await runChild('applied-crash', true)
  assertEqual(crash.message.type, 'mutation-boundary')
  assertEqual(crash.message.effectStatus, 'executing')
  const resumed = await runChild('applied-resume', false)
  assertEqual(resumed.message.effectStatus, 'confirmed')
  assertEqual(resumed.message.runStatus, 'completed')
  assertEqual(resumed.message.snapshotExists, false)
  assertEqual(resumed.message.retryEvidenceCount, 0)
  assertEqual(counterLines('applied'), 1, 'confirmed crash must not replay the callback')
}

async function notAppliedCrashCase() {
  const crash = await runChild('not-applied-crash', true)
  assertEqual(crash.message.type, 'mutation-boundary')
  assertEqual(crash.message.effectStatus, 'executing')
  const resumed = await runChild('not-applied-resume', false)
  assertEqual(resumed.message.effectStatus, 'abandoned')
  assertEqual(resumed.message.runStatus, 'failed')
  assertEqual(resumed.message.snapshotExists, false)
  assertEqual(resumed.message.retryEvidenceCount, 1)
  assertEqual(resumed.message.retryStatus, 'completed')
  assert(resumed.message.retryFence > resumed.message.originalFence)
  assertEqual(counterLines('not-applied'), 2, 'retry must occur only after explicit authorization')
}

async function divergedCrashCase() {
  const crash = await runChild('diverged-crash', true)
  assertEqual(crash.message.type, 'mutation-boundary')
  const resumed = await runChild('diverged-resume', false)
  assertEqual(resumed.message.effectStatus, 'waiting_reconciliation')
  assertEqual(resumed.message.runStatus, 'waiting_reconciliation')
  assertEqual(resumed.message.snapshotExists, true)
  assertEqual(resumed.message.retryEvidenceCount, 0)
  assertEqual(resumed.message.blockedStatus, 'failed')
  assertEqual(resumed.message.blockedCallbackCount, 0)
  assertEqual(counterLines('diverged'), 1, 'unknown outcome must never auto-replay')
}

async function runWorker(mode) {
  const modules = loadModules()
  const scenario = mode.replace(/-(?:crash|resume)$/, '')
  if (mode.endsWith('-crash')) return runCrashWorker(scenario, modules)
  return runResumeWorker(scenario, modules)
}

async function runCrashWorker(scenario, { indexEffect, gateway, snapshotStore }) {
  const repo = scenarioRepo(scenario)
  const input = effectInput(repo)
  await gateway.executeInteractiveOperationEffect({
    operationId: operationId(scenario),
    kind: 'git_index_update',
    title: `${scenario} crash`,
    sourceSessionId: `${scenario}-source`,
    cwd: repo,
    toolName: input.toolName,
    toolInput: input.toolInput,
    execute: async (effect) => {
      appendFileSync(counterFile(scenario), 'callback\n')
      if (scenario === 'applied') {
        const result = indexEffect.executeGitIndexEffectTarget(effect.target, input)
        assert(result.ok, JSON.stringify(result))
      } else if (scenario === 'diverged') {
        git(repo, ['add', '--', 'b.txt'])
      }
      const snapshot = await snapshotStore.getTaskSnapshot(effect.sessionId)
      const persisted = snapshot?.run?.effects?.find((item) => item.id === effect.id)
      process.send?.({
        type: 'mutation-boundary',
        effectStatus: persisted?.status,
        fencingToken: persisted?.lease?.fencingToken
      })
      await new Promise(() => {})
    },
    isSuccess: (result) => result.ok
  })
}

async function runResumeWorker(scenario, modules) {
  const { gateway, snapshotStore, effectRuntime } = modules
  const scopeId = `operation:${operationId(scenario)}`
  const snapshot = await snapshotStore.getTaskSnapshot(scopeId)
  assert(snapshot?.run, `${scenario} recovery snapshot missing`)
  const originalFence = snapshot.run.effects[0]?.lease?.fencingToken ?? 0
  const reconciled = await effectRuntime.reconcilePersistedTaskSnapshot(snapshot)
  const effect = reconciled.run.effects[0]
  await gateway.settleStoppedInteractiveOperationSnapshot(reconciled)
  const storedAfterSettle = await snapshotStore.getTaskSnapshot(scopeId)
  const terminal = (await snapshotStore.listTaskRuns(scopeId))[0]
  if (scenario === 'not-applied') {
    return reportNotAppliedResume(modules, effect, originalFence, terminal, storedAfterSettle)
  }
  if (scenario === 'diverged') {
    return reportDivergedResume(modules, effect, terminal, storedAfterSettle)
  }
  process.send?.({
    type: 'resume-result',
    effectStatus: effect.status,
    runStatus: terminal?.status,
    snapshotExists: storedAfterSettle !== null,
    retryEvidenceCount: evidenceCount(effect, 'retry_authorized')
  })
}

async function reportNotAppliedResume(modules, effect, originalFence, terminal, snapshot) {
  const { indexEffect, gateway } = modules
  const repo = scenarioRepo('not-applied')
  const input = effectInput(repo)
  const retry = await gateway.executeInteractiveOperationEffect({
    operationId: 'crash-not-applied-explicit-retry',
    kind: 'git_index_update',
    title: 'explicit retry',
    sourceSessionId: 'not-applied-retry-source',
    cwd: repo,
    toolName: input.toolName,
    toolInput: input.toolInput,
    execute: (retryEffect) => {
      appendFileSync(counterFile('not-applied'), 'callback\n')
      return indexEffect.executeGitIndexEffectTarget(retryEffect.target, input)
    },
    isSuccess: (result) => result.ok
  })
  process.send?.({
    type: 'resume-result',
    effectStatus: effect.status,
    runStatus: terminal?.status,
    snapshotExists: snapshot !== null,
    retryEvidenceCount: evidenceCount(effect, 'retry_authorized'),
    retryStatus: retry.status,
    originalFence,
    retryFence: retry.status === 'completed' ? retry.effect.lease?.fencingToken : 0
  })
}

async function reportDivergedResume(modules, effect, terminal, snapshot) {
  const { gateway } = modules
  const repo = scenarioRepo('diverged')
  const input = effectInput(repo)
  let blockedCallbackCount = 0
  const blocked = await gateway.executeInteractiveOperationEffect({
    operationId: 'crash-diverged-blocked-retry',
    kind: 'git_index_update',
    title: 'blocked retry',
    sourceSessionId: 'diverged-retry-source',
    cwd: repo,
    toolName: input.toolName,
    toolInput: input.toolInput,
    execute: () => {
      blockedCallbackCount += 1
      return { ok: true }
    },
    isSuccess: (result) => result.ok
  })
  process.send?.({
    type: 'resume-result',
    effectStatus: effect.status,
    runStatus: terminal?.status ?? snapshot?.run?.status,
    snapshotExists: snapshot !== null,
    retryEvidenceCount: evidenceCount(effect, 'retry_authorized'),
    blockedStatus: blocked.status,
    blockedCallbackCount
  })
}

function runChild(mode, killAfterMessage) {
  return new Promise((resolve, reject) => {
    const child = fork(process.argv[1], [mode], {
      env: {
        ...process.env,
        CAOGEN_INDEX_CRASH_ROOT: tempRoot,
        CAOGEN_INDEX_CRASH_COMPILED: outDir,
        CAOGEN_INDEX_CRASH_USER_DATA: userData
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
    let stdout = ''
    let stderr = ''
    let message
    let killed = false
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${mode} timed out\n${stdout}\n${stderr}`))
    }, 30_000)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('message', (value) => {
      message = value
      if (killAfterMessage && !killed) {
        killed = true
        child.kill('SIGKILL')
      }
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
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

function prepareScenarioRepos() {
  for (const scenario of ['applied', 'not-applied', 'diverged']) {
    const repo = scenarioRepo(scenario)
    mkdirSync(repo, { recursive: true })
    git(repo, ['init', '-b', 'main'])
    git(repo, ['config', 'user.email', 'git-index-crash@example.test'])
    git(repo, ['config', 'user.name', 'Git Index Crash Test'])
    writeFileSync(path.join(repo, 'a.txt'), 'a0\n')
    writeFileSync(path.join(repo, 'b.txt'), 'b0\n')
    git(repo, ['add', '--', 'a.txt', 'b.txt'])
    git(repo, ['commit', '-m', 'base'])
    writeFileSync(path.join(repo, 'a.txt'), 'a0\na1\n')
    writeFileSync(path.join(repo, 'b.txt'), 'b0\nb1\n')
    writeFileSync(counterFile(scenario), '')
  }
}

function loadModules() {
  return {
    indexEffect: require(findCompiledModule(outDir, 'git-index-effect.js')),
    gateway: require(findCompiledModule(outDir, 'operation-effect-gateway.js')),
    snapshotStore: require(findCompiledModule(outDir, 'task-snapshot.js')),
    effectRuntime: require(findCompiledModule(outDir, 'effect-runtime.js'))
  }
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/git/git-index-effect.ts',
    'src/main/task/operation-effect-gateway.ts',
    'src/main/task/effect-runtime.ts',
    '--outDir', outDir,
    '--rootDir', 'src',
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installElectronStub() {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), 'module.exports = { app: { getPath: () => process.env.CAOGEN_TEST_USER_DATA } }\n')
}

function findCompiledModule(root, name) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledModuleOrNull(fullPath, name)
      if (found) return found
    } else if (entry.name === name) return fullPath
  }
  throw new Error(`compiled module missing: ${name}`)
}

function findCompiledModuleOrNull(root, name) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledModuleOrNull(fullPath, name)
      if (found) return found
    } else if (entry.name === name) return fullPath
  }
  return null
}

function effectInput(repo) {
  return { toolName: 'git_stage', cwd: repo, toolInput: { paths: ['a.txt'] } }
}

function operationId(scenario) {
  return `crash-${scenario}`
}

function scenarioRepo(scenario) {
  return path.join(tempRoot, `${scenario}-repo`)
}

function counterFile(scenario) {
  return path.join(tempRoot, `${scenario}-counter.txt`)
}

function counterLines(scenario) {
  return readFileSync(counterFile(scenario), 'utf8').split(/\r?\n/).filter(Boolean).length
}

function evidenceCount(effect, kind) {
  return effect.evidence.filter((item) => item.kind === kind).length
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { env: cleanGitEnv, encoding: 'utf8' })
}

function sanitizedGitEnvironment(source) {
  const env = { ...source }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') || key === 'SSH_ASKPASS') delete env[key]
  }
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
