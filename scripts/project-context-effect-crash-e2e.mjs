import { execFileSync, fork } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const workerMode = process.argv[2]
const tempRoot = process.env.CAOGEN_PROJECT_CONTEXT_EFFECT_ROOT
  ?? mkdtempSync(path.join(tmpdir(), 'caogen-project-context-effect-'))
const outDir = process.env.CAOGEN_PROJECT_CONTEXT_EFFECT_COMPILED ?? path.join(tempRoot, 'compiled')
const userData = process.env.CAOGEN_PROJECT_CONTEXT_EFFECT_USER_DATA ?? path.join(tempRoot, 'user-data')

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
    await successAndBoundaryCases()
    await confirmedCrashCase()
    await divergedCrashCase()
    console.log('project context effect crash e2e: PASS')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function successAndBoundaryCases() {
  const modules = await loadModules()
  const project = projectPath('success')
  createProject(project)
  const content = contentFor('success')
  let durableBarrierObserved = false
  const result = await modules.projectContextEffect.executeProjectContextWriteEffect(
    project,
    content,
    (spec) => modules.gateway.executeInteractiveOperationEffect({
      ...spec,
      operationId: 'project-context-success',
      execute: async (effect) => {
        const snapshot = await modules.snapshotStore.getTaskSnapshot(effect.sessionId)
        const persisted = snapshot?.run?.effects?.find((item) => item.id === effect.id)
        assertEqual(persisted?.status, 'executing', 'write must start after durable executing state')
        assertEqual(persisted?.target?.kind, 'file_content')
        assertEqual(persisted?.target?.relativePath, 'caogen.md')
        assert(snapshot?.run?.operation?.sourceSessionId.startsWith('project-context:'))
        assert(!snapshot?.run?.operation?.sourceSessionId.includes(project))
        durableBarrierObserved = true
        return spec.execute(effect)
      }
    })
  )
  assert(result.ok, JSON.stringify(result))
  assert(durableBarrierObserved, 'durable barrier was not observed')
  assertEqual(result.context.content, content)
  assertEqual(readFileSync(path.join(project, 'caogen.md'), 'utf8'), content)
  assertDatabaseExcludes(content)

  const outside = path.join(tempRoot, 'outside-rules.md')
  const symlinkProject = projectPath('symlink')
  createProject(symlinkProject)
  writeFileSync(outside, 'outside-before\n', 'utf8')
  symlinkSync(outside, path.join(symlinkProject, 'caogen.md'))
  const blocked = await modules.projectContextEffect.executeProjectContextWriteEffect(
    symlinkProject,
    'must-not-escape\n',
    modules.gateway.executeInteractiveOperationEffect
  )
  assert(!blocked.ok, 'symlink target must fail closed')
  assertEqual(readFileSync(outside, 'utf8'), 'outside-before\n')
}

async function confirmedCrashCase() {
  const crashed = await runChild('crash-confirmed', true)
  assertEqual(crashed.message.effectStatus, 'executing')
  assertEqual(crashed.message.targetKind, 'file_content')
  assertEqual(crashed.message.relativePath, 'caogen.md')
  assertEqual(readFileSync(path.join(projectPath('confirmed'), 'caogen.md'), 'utf8'), contentFor('confirmed'))
  assertDatabaseExcludes(contentFor('confirmed'))

  const resumed = await runChild('resume-confirmed', false)
  assertEqual(resumed.message.effectStatus, 'confirmed')
  assertEqual(resumed.message.snapshotExists, false)
  assertEqual(resumed.message.runStatus, 'completed')
  assertEqual(counterLines('confirmed'), 1, 'confirmed recovery must not replay the write callback')
}

async function divergedCrashCase() {
  const crashed = await runChild('crash-diverged', true)
  assertEqual(crashed.message.effectStatus, 'executing')
  const intervening = '# Project rules\nintervening-user-write\n'
  writeFileSync(path.join(projectPath('diverged'), 'caogen.md'), intervening, 'utf8')

  const resumed = await runChild('resume-diverged', false)
  assertEqual(resumed.message.effectStatus, 'waiting_reconciliation')
  assertEqual(resumed.message.snapshotExists, true)
  assertEqual(resumed.message.runStatus, 'waiting_reconciliation')
  assertEqual(readFileSync(path.join(projectPath('diverged'), 'caogen.md'), 'utf8'), intervening)
  assertEqual(counterLines('diverged'), 1, 'diverged recovery must not replay the write callback')
}

async function runWorker(mode) {
  const modules = await loadModules()
  if (mode === 'crash-confirmed') return crashWorker(modules, 'confirmed')
  if (mode === 'crash-diverged') return crashWorker(modules, 'diverged')
  if (mode === 'resume-confirmed') return resumeWorker(modules, 'confirmed')
  if (mode === 'resume-diverged') return resumeWorker(modules, 'diverged')
  throw new Error(`unknown worker mode: ${mode}`)
}

async function crashWorker(modules, caseName) {
  const project = projectPath(caseName)
  createProject(project)
  const result = await modules.projectContextEffect.executeProjectContextWriteEffect(
    project,
    contentFor(caseName),
    (spec) => modules.gateway.executeInteractiveOperationEffect({
      ...spec,
      operationId: operationId(caseName),
      execute: async (effect) => {
        appendFileSync(counterFile(caseName), 'callback\n')
        const value = await spec.execute(effect)
        assert(value.ok, JSON.stringify(value))
        const snapshot = await modules.snapshotStore.getTaskSnapshot(effect.sessionId)
        const persisted = snapshot?.run?.effects?.find((item) => item.id === effect.id)
        process.send?.({
          effectStatus: persisted?.status,
          targetKind: persisted?.target?.kind,
          relativePath: persisted?.target?.relativePath
        })
        await new Promise(() => {})
      }
    })
  )
  throw new Error(`crash worker unexpectedly completed: ${JSON.stringify(result)}`)
}

async function resumeWorker(modules, caseName) {
  const scopeId = `operation:${operationId(caseName)}`
  const snapshot = await modules.snapshotStore.getTaskSnapshot(scopeId)
  assert(snapshot?.run, 'project context recovery snapshot missing')
  const reconciled = await modules.effectRuntime.reconcilePersistedTaskSnapshot(snapshot)
  const effectStatus = reconciled.run?.effects?.[0]?.status
  await modules.gateway.settleStoppedInteractiveOperationSnapshot(reconciled)
  const current = await modules.snapshotStore.getTaskSnapshot(scopeId)
  const terminal = (await modules.snapshotStore.listTaskRuns(scopeId))[0]
  process.send?.({
    effectStatus,
    snapshotExists: current !== null,
    runStatus: current?.run?.status ?? terminal?.status
  })
}

function runChild(mode, killAfterMessage) {
  return new Promise((resolve, reject) => {
    const child = fork(process.argv[1], [mode], {
      env: {
        ...process.env,
        CAOGEN_PROJECT_CONTEXT_EFFECT_ROOT: tempRoot,
        CAOGEN_PROJECT_CONTEXT_EFFECT_COMPILED: outDir,
        CAOGEN_PROJECT_CONTEXT_EFFECT_USER_DATA: userData
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
    'src/main/projectContextEffect.ts',
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
    projectContextEffect: await importModule('main/projectContextEffect.js'),
    gateway: await importModule('main/task/operation-effect-gateway.js'),
    effectRuntime: await importModule('main/task/effect-runtime.js'),
    snapshotStore: await importModule('main/task/task-snapshot.js')
  }
}

function importModule(relativePath) {
  return import(pathToFileURL(path.join(outDir, relativePath)).href)
}

function createProject(project) {
  mkdirSync(project, { recursive: true })
  const packageFile = path.join(project, 'package.json')
  if (!existsSync(packageFile)) writeFileSync(packageFile, '{"name":"effect-project"}\n', 'utf8')
}

function projectPath(caseName) {
  return path.join(tempRoot, `${caseName}-project`)
}

function operationId(caseName) {
  return `project-context-${caseName}`
}

function contentFor(caseName) {
  return `# Project rules\nPROJECT_CONTEXT_${caseName.toUpperCase()}_SENSITIVE_CANARY\n`
}

function counterFile(caseName) {
  return path.join(tempRoot, `${caseName}-write-count.txt`)
}

function counterLines(caseName) {
  if (!existsSync(counterFile(caseName))) return 0
  return readFileSync(counterFile(caseName), 'utf8').split('\n').filter(Boolean).length
}

function assertDatabaseExcludes(value) {
  const dbPath = path.join(userData, 'task-snapshots.db')
  assert(existsSync(dbPath), 'task snapshot database missing')
  assert(!readFileSync(dbPath).includes(Buffer.from(value)), 'raw project context leaked into task database')
}

function assertEqual(actual, expected, message = '') {
  if (actual !== expected) throw new Error(`${message ? `${message}: ` : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
