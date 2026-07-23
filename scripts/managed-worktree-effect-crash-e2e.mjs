import { execFileSync, fork } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  appendFileSync,
  existsSync,
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
const tempRoot = process.env.CAOGEN_WORKTREE_CRASH_ROOT
  ?? mkdtempSync(path.join(tmpdir(), 'caogen-worktree-crash-'))
const outDir = process.env.CAOGEN_WORKTREE_CRASH_COMPILED ?? path.join(tempRoot, 'compiled')
const userData = process.env.CAOGEN_WORKTREE_CRASH_USER_DATA ?? path.join(tempRoot, 'user-data')
const cleanGitEnv = sanitizedGitEnvironment(process.env)

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
    prepareRepos()
    await createCrashCase()
    await removeCrashCase()
    console.log('managed worktree effect crash e2e: PASS')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function createCrashCase() {
  const crashed = await runChild('create-crash', true)
  assertEqual(crashed.message.type, 'mutation-boundary')
  assertEqual(crashed.message.effectStatus, 'executing')
  assertEqual(crashed.message.registryState, 'absent')
  assertEqual(crashed.message.pathExists, true)

  const resumed = await runChild('create-resume', false)
  assertEqual(resumed.message.effectStatus, 'confirmed')
  assertEqual(resumed.message.runStatus, 'completed')
  assertEqual(resumed.message.snapshotExists, false)
  assertEqual(resumed.message.registryState, 'active')
  assertEqual(resumed.message.pathExists, true)
  assertEqual(resumed.message.branchState, 'present')
  assertEqual(counterLines('create'), 1, 'create recovery must not replay the Git mutation')
}

async function removeCrashCase() {
  const setup = await runChild('remove-setup', false)
  assertEqual(setup.message.status, 'completed')
  assertEqual(setup.message.registryState, 'active')

  const crashed = await runChild('remove-crash', true)
  assertEqual(crashed.message.type, 'mutation-boundary')
  assertEqual(crashed.message.effectStatus, 'executing')
  assertEqual(crashed.message.registryState, 'active')
  assertEqual(crashed.message.pathExists, false)
  assertEqual(crashed.message.branchState, 'absent')

  const resumed = await runChild('remove-resume', false)
  assertEqual(resumed.message.effectStatus, 'confirmed')
  assertEqual(resumed.message.runStatus, 'completed')
  assertEqual(resumed.message.snapshotExists, false)
  assertEqual(resumed.message.registryState, 'removed')
  assertEqual(resumed.message.pathExists, false)
  assertEqual(resumed.message.branchState, 'absent')
  assertEqual(counterLines('remove'), 1, 'remove recovery must not replay the Git mutation')
}

async function runWorker(mode) {
  const modules = loadModules()
  if (mode === 'create-crash') return runCreateCrash(modules)
  if (mode === 'create-resume') return runResume('create', modules)
  if (mode === 'remove-setup') return runRemoveSetup(modules)
  if (mode === 'remove-crash') return runRemoveCrash(modules)
  if (mode === 'remove-resume') return runResume('remove', modules)
  throw new Error(`unknown worker mode: ${mode}`)
}

async function runCreateCrash({ lifecycle, worktreeEffect, gateway, snapshotStore }) {
  const prepared = lifecycle.prepareManagedWorktreeCreateEffect({
    sessionId: sessionId('create'),
    cwd: scenarioRepo('create'),
    isolated: true
  })
  assert(prepared.ok && prepared.isolated && prepared.plan, JSON.stringify(prepared))
  await runLifecycleEffect('create', prepared.plan, gateway, async (effect) => {
    appendFileSync(counterFile('create'), 'callback\n')
    const result = worktreeEffect.executeManagedWorktreeCreateTarget(effect.target)
    assert(result.ok, JSON.stringify(result))
    await reportMutationBoundary('create', effect, prepared.plan.record, lifecycle, snapshotStore)
    await new Promise(() => {})
  })
}

async function runRemoveSetup({ lifecycle, worktreeEffect, gateway }) {
  const prepared = lifecycle.prepareManagedWorktreeCreateEffect({
    sessionId: sessionId('remove'),
    cwd: scenarioRepo('remove'),
    isolated: true
  })
  assert(prepared.ok && prepared.isolated && prepared.plan, JSON.stringify(prepared))
  const outcome = await runLifecycleEffect('remove-setup', prepared.plan, gateway, (effect) =>
    worktreeEffect.executeManagedWorktreeCreateTarget(effect.target)
  )
  const record = lifecycle.managedWorktreeRecordForSession(sessionId('remove'))
  process.send?.({ status: outcome.status, registryState: record?.state ?? 'absent' })
}

async function runRemoveCrash({ lifecycle, worktreeEffect, gateway, snapshotStore }) {
  const prepared = lifecycle.prepareManagedWorktreeRemoveEffect(sessionId('remove'), {
    force: true,
    deleteBranch: true
  })
  assert(prepared.ok && prepared.plan, JSON.stringify(prepared))
  await runLifecycleEffect('remove', prepared.plan, gateway, async (effect) => {
    appendFileSync(counterFile('remove'), 'callback\n')
    const result = worktreeEffect.executeManagedWorktreeRemoveTarget(effect.target)
    assert(result.ok, JSON.stringify(result))
    await reportMutationBoundary('remove', effect, prepared.plan.record, lifecycle, snapshotStore)
    await new Promise(() => {})
  })
}

async function reportMutationBoundary(scenario, effect, record, lifecycle, snapshotStore) {
  const snapshot = await snapshotStore.getTaskSnapshot(effect.sessionId)
  const persisted = snapshot?.run?.effects?.find((item) => item.id === effect.id)
  const registry = lifecycle.managedWorktreeRecordForSession(record.sessionId)
  process.send?.({
    type: 'mutation-boundary',
    effectStatus: persisted?.status,
    registryState: registry?.state ?? 'absent',
    pathExists: existsSync(record.worktreePath),
    branchState: refExists(record.repoRoot, record.branch) ? 'present' : 'absent',
    scenario
  })
}

async function runResume(scenario, { lifecycle, gateway, snapshotStore }) {
  const scopeId = `operation:${operationId(scenario)}`
  const snapshot = await snapshotStore.getTaskSnapshot(scopeId)
  assert(snapshot?.run, `${scenario} recovery snapshot missing`)
  const effect = snapshot.run.effects[0]
  const record = effect.target.registryRecord
  await gateway.settleStoppedInteractiveOperationSnapshot(snapshot)
  const remaining = await snapshotStore.getTaskSnapshot(scopeId)
  const terminal = (await snapshotStore.listTaskRuns(scopeId))[0]
  const projected = lifecycle.managedWorktreeRecordForSession(record.sessionId)
  process.send?.({
    type: 'resume-result',
    effectStatus: terminal?.effects?.[0]?.status,
    runStatus: terminal?.status,
    snapshotExists: remaining !== null,
    registryState: projected?.state ?? 'absent',
    pathExists: existsSync(record.worktreePath),
    branchState: refExists(record.repoRoot, record.branch) ? 'present' : 'absent'
  })
}

function runLifecycleEffect(scenario, plan, gateway, execute) {
  const create = scenario === 'create' || scenario === 'remove-setup'
  return gateway.executeInteractiveOperationEffect({
    operationId: operationId(scenario === 'remove-setup' ? 'remove-setup' : scenario),
    ...(create ? { source: 'session_lifecycle' } : {}),
    kind: create ? 'managed_worktree_create' : 'managed_worktree_remove',
    title: `${scenario} managed worktree crash probe`,
    sourceSessionId: plan.record.sessionId,
    cwd: create ? plan.record.sourceCwd : plan.previousRecord.sourceCwd,
    toolName: create ? 'managed_worktree_create' : 'managed_worktree_remove',
    toolInput: { ...plan.toolInput },
    execute,
    isSuccess: (result) => result?.ok === true,
    resultSummary: (result) => JSON.stringify(result)
  })
}

function runChild(mode, killAfterMessage) {
  return new Promise((resolve, reject) => {
    const child = fork(process.argv[1], [mode], {
      env: {
        ...process.env,
        CAOGEN_WORKTREE_CRASH_ROOT: tempRoot,
        CAOGEN_WORKTREE_CRASH_COMPILED: outDir,
        CAOGEN_WORKTREE_CRASH_USER_DATA: userData
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

function prepareRepos() {
  for (const scenario of ['create', 'remove']) {
    const repo = scenarioRepo(scenario)
    mkdirSync(repo, { recursive: true })
    git(repo, ['init', '-b', 'main'])
    git(repo, ['config', 'user.email', 'worktree-crash@example.test'])
    git(repo, ['config', 'user.name', 'Managed Worktree Crash Test'])
    writeFileSync(path.join(repo, 'README.md'), `${scenario}\n`)
    git(repo, ['add', 'README.md'])
    git(repo, ['commit', '-m', 'base'])
    writeFileSync(counterFile(scenario), '')
  }
}

function loadModules() {
  return {
    lifecycle: require(findCompiledModule(outDir, 'managed-worktree-lifecycle.js')),
    worktreeEffect: require(findCompiledModule(outDir, 'managed-worktree-effect.js')),
    gateway: require(findCompiledModule(outDir, 'operation-effect-gateway.js')),
    snapshotStore: require(findCompiledModule(outDir, 'task-snapshot.js'))
  }
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/git/managed-worktree-effect.ts',
    'src/main/managed-worktree-lifecycle.ts',
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
  writeFileSync(
    path.join(electronDir, 'index.js'),
    'module.exports = { app: { getPath: () => process.env.CAOGEN_TEST_USER_DATA } }\n'
  )
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

function operationId(scenario) {
  return `managed-worktree-crash-${scenario}`
}

function sessionId(scenario) {
  return `managed-worktree-${scenario}`
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

function refExists(repo, branch) {
  try {
    git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
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
