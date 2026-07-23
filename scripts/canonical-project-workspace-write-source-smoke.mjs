import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()

if (process.env.CAOGEN_CANONICAL_WRITE_CHILD === '1') {
  await runCrashChild()
  process.exit(0)
}

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-canonical-write-source-'))
const outDir = path.join(tempRoot, 'compiled')
let storeModule
let commandModule
let migrationModule
let viewModule

try {
  compileSources()
  installElectronStub()
  storeModule = await importCompiled('main/project-workspace/store.js')
  commandModule = await importCompiled('main/project-workspace/command-service.js')
  migrationModule = await importCompiled('main/project-workspace/ledger-migration.js')
  viewModule = await importCompiled('main/project-workspace/ledger-canonical-view.js')

  await canonicalOrderingProof()
  for (const checkpoint of [
    'after_prepare',
    'after_canonical_commit',
    'after_json_commit_before_journal'
  ]) {
    await strongKillRecovery(checkpoint)
  }
  console.log('canonical ProjectWorkspace write-source smoke: PASS')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

async function canonicalOrderingProof() {
  const root = scenarioRoot('ordering')
  const workspaceId = 'workspace-ordering'
  const goalId = 'goal-ordering'
  await seedWorkspace(root, workspaceId)
  let observedPreProjection = false
  const store = await openStore(root)
  const commands = commandModule.createProjectWorkspaceCommandService(store, {
    rootDir: root,
    canonicalWrite: {
      migrate: async (state, id, targetRoot, options) => {
        const current = readJsonState(root)
        assert(!current.goals.some((goal) => goal.id === goalId), 'JSON must remain unchanged while canonical migration runs')
        assert(state.goals.some((goal) => goal.id === goalId), 'canonical candidate must contain the planned Goal')
        observedPreProjection = true
        return migrationModule.commitProjectWorkspaceStateToWorkflowLedger(state, id, targetRoot, options)
      }
    }
  })
  const goal = await commands.createGoal({
    id: goalId,
    projectId: workspaceId,
    title: 'Canonical first',
    objective: 'Prove canonical commit ordering'
  })
  assert(observedPreProjection, 'canonical migration hook was not called')
  assert(readJsonState(root).goals.some((item) => item.id === goal.id), 'JSON projection must follow canonical commit')
  const view = await viewModule.readVerifiedCanonicalProjectWorkspaceView(workspaceId, root)
  assert(view.goals.some((item) => item.id === goal.id), 'verified canonical view must expose committed Goal')
  const readiness = await commands.getShadowProjectionReadiness()
  assert(readiness?.ready && readiness.projectionCommitted === 1, 'normal canonical command must seal its journal')
  console.log('[PASS] canonical Ledger commits before JSON projection')
}

async function strongKillRecovery(checkpoint) {
  const root = scenarioRoot(`kill-${checkpoint}`)
  const workspaceId = `workspace-${checkpoint}`
  const goalId = `goal-${checkpoint}`
  await seedWorkspace(root, workspaceId)
  const child = spawnSync(process.execPath, [new URL(import.meta.url).pathname], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CAOGEN_CANONICAL_WRITE_CHILD: '1',
      CAOGEN_CANONICAL_WRITE_COMPILED: outDir,
      CAOGEN_CANONICAL_WRITE_ROOT: root,
      CAOGEN_CANONICAL_WRITE_CHECKPOINT: checkpoint,
      CAOGEN_CANONICAL_WRITE_WORKSPACE: workspaceId,
      CAOGEN_CANONICAL_WRITE_GOAL: goalId
    },
    encoding: 'utf8'
  })
  assertEqual(child.signal, 'SIGKILL', `${checkpoint} child must be killed at the checkpoint`)

  const jsonAfterKill = readJsonState(root)
  const jsonHasGoal = jsonAfterKill.goals.some((goal) => goal.id === goalId)
  assertEqual(jsonHasGoal, checkpoint === 'after_json_commit_before_journal', `${checkpoint} JSON boundary`)
  const canonicalHasGoal = await canonicalGoalExists(root, workspaceId, goalId)
  assertEqual(canonicalHasGoal, checkpoint !== 'after_prepare', `${checkpoint} canonical boundary`)

  const commands = await createCommands(root)
  const before = await commands.getShadowProjectionReadiness()
  assertEqual(before?.pendingJournals, 1, `${checkpoint} must leave one pending journal`)
  const recovered = await commands.reconcileShadowProjection()
  assert(recovered?.ready && recovered.pendingJournals === 0, `${checkpoint} recovery must become ready`)

  const finalJson = readJsonState(root)
  const finalCanonical = await canonicalGoalExists(root, workspaceId, goalId)
  if (checkpoint === 'after_prepare') {
    assert(!finalJson.goals.some((goal) => goal.id === goalId), 'after_prepare must not replay the command')
    assert(!finalCanonical, 'after_prepare must not create a canonical Goal')
    assertEqual(recovered.aborted, 1, 'after_prepare journal must abort')
  } else {
    assert(finalJson.goals.some((goal) => goal.id === goalId), `${checkpoint} must recover JSON projection`)
    assert(finalCanonical, `${checkpoint} must retain canonical Goal`)
    assertEqual(recovered.projectionCommitted, 1, `${checkpoint} journal must seal after recovery`)
  }
  console.log(`[PASS] strong kill recovery ${checkpoint}`)
}

async function runCrashChild() {
  const compiled = requiredEnv('CAOGEN_CANONICAL_WRITE_COMPILED')
  const root = requiredEnv('CAOGEN_CANONICAL_WRITE_ROOT')
  const checkpoint = requiredEnv('CAOGEN_CANONICAL_WRITE_CHECKPOINT')
  const workspaceId = requiredEnv('CAOGEN_CANONICAL_WRITE_WORKSPACE')
  const goalId = requiredEnv('CAOGEN_CANONICAL_WRITE_GOAL')
  const storeApi = await import(pathToFileURL(path.join(compiled, 'main/project-workspace/store.js')).href)
  const commandApi = await import(pathToFileURL(path.join(compiled, 'main/project-workspace/command-service.js')).href)
  const store = await new storeApi.ProjectWorkspaceStore(root).open()
  const commands = commandApi.createProjectWorkspaceCommandService(store, {
    rootDir: root,
    canonicalWrite: {
      faultAt: checkpoint,
      onFault: () => process.kill(process.pid, 'SIGKILL')
    }
  })
  await commands.createGoal({
    id: goalId,
    projectId: workspaceId,
    title: checkpoint,
    objective: 'Recover canonical-first write'
  })
}

async function canonicalGoalExists(root, workspaceId, goalId) {
  try {
    const view = await viewModule.readVerifiedCanonicalProjectWorkspaceView(workspaceId, root)
    return view.goals.some((goal) => goal.id === goalId)
  } catch (error) {
    if (String(error?.code ?? '').includes('MIGRATION_EVENT_MISSING')) return false
    throw error
  }
}

async function seedWorkspace(root, workspaceId) {
  const store = await openStore(root)
  await store.createWorkspace({ id: workspaceId, name: workspaceId, kind: 'software' })
}

async function openStore(root) {
  return new storeModule.ProjectWorkspaceStore(root).open()
}

async function createCommands(root) {
  const store = await openStore(root)
  return commandModule.createProjectWorkspaceCommandService(store, { rootDir: root })
}

function readJsonState(root) {
  return JSON.parse(readFileSync(path.join(root, 'project-workspace.json'), 'utf8'))
}

function scenarioRoot(name) {
  const root = path.join(tempRoot, name)
  mkdirSync(root, { recursive: true })
  return root
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/project-workspace/command-service.ts',
    'src/main/project-workspace/canonical-read-service.ts',
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
  writeFileSync(path.join(electronDir, 'index.js'), `module.exports = { app: { getPath: () => '' } }\n`)
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"commonjs"}\n')
}

function importCompiled(relativePath) {
  return import(pathToFileURL(path.join(outDir, relativePath)).href)
}

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`)
}
