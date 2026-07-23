import { spawnSync, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
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
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()

if (process.env.CAOGEN_SHADOW_CHILD === '1') {
  await runCrashChild()
  process.exit(0)
}

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-ledger-shadow-write-'))
const outDir = path.join(tempRoot, 'compiled')
let storeModule
let commandModule
let bridge
let snapshots
let workflow

try {
  compileSources()
  installElectronStub()
  storeModule = await importCompiled('main/project-workspace/store.js')
  commandModule = await importCompiled('main/project-workspace/command-service.js')
  bridge = await importCompiled('main/project-workspace/ledger-migration.js')
  snapshots = await importCompiled('main/task/task-snapshot.js')
  workflow = await importCompiled('main/task/workflow-ledger-store.js')

  for (const checkpoint of [
    'after_prepare',
    'after_source_commit',
    'after_projection_before_journal_commit'
  ]) {
    await strongKillRecovery(checkpoint)
  }
  await projectionFailureContract()
  await unrelatedRevisionCanary()
  await crossInstanceSerialization()
  await postProjectionSourceRace()
  await terminalAcceptancePreflight()
  console.log('project ledger shadow write crash e2e: PASS')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
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
      CAOGEN_SHADOW_CHILD: '1',
      CAOGEN_SHADOW_COMPILED: outDir,
      CAOGEN_SHADOW_ROOT: root,
      CAOGEN_SHADOW_CHECKPOINT: checkpoint,
      CAOGEN_SHADOW_WORKSPACE: workspaceId,
      CAOGEN_SHADOW_GOAL: goalId
    },
    encoding: 'utf8'
  })
  assertEqual(child.signal, 'SIGKILL', `${checkpoint} child must be killed at the checkpoint`)
  const sourceAfterKill = readJsonState(root)
  const goalAfterKill = sourceAfterKill.goals.find((item) => item.id === goalId)
  assertEqual(Boolean(goalAfterKill), checkpoint !== 'after_prepare', `${checkpoint} JSON commit boundary`)

  const service = await openCommands(root)
  const before = await service.getShadowProjectionReadiness()
  assertEqual(before.pendingJournals, 1, `${checkpoint} must leave one recoverable journal`)
  const dbBefore = checkpoint === 'after_projection_before_journal_commit'
    ? readFileSync(snapshots.taskSnapshotsDbFile(root))
    : undefined
  const recovered = await service.reconcileShadowProjection()
  assert(recovered.ready && recovered.pendingJournals === 0, `${checkpoint} recovery must become ready`)

  if (checkpoint === 'after_prepare') {
    assertEqual(recovered.aborted, 1, 'after_prepare recovery must abort without replaying JSON mutation')
    assertEqual(await readLedgerGoal(root, goalId), null, 'after_prepare must not create a Ledger Goal')
  } else {
    const projected = await readLedgerGoal(root, goalId)
    assertEqual(projected?.revision, goalAfterKill.revision, `${checkpoint} must project committed JSON revision`)
    assertEqual(recovered.projectionCommitted, 1, `${checkpoint} journal must commit after recovery`)
  }
  if (dbBefore) {
    assertEqual(
      Buffer.compare(dbBefore, readFileSync(snapshots.taskSnapshotsDbFile(root))),
      0,
      'projection-before-journal recovery must be byte-idempotent'
    )
  }
  console.log(`[PASS] strong kill recovery ${checkpoint}`)
}

async function projectionFailureContract() {
  const root = scenarioRoot('projection-failure')
  const workspaceId = 'workspace-projection-failure'
  const goalId = 'goal-projection-failure'
  await seedWorkspace(root, workspaceId)
  const service = await openCommands(root, {
    migrate: async () => {
      const error = new Error('forced projection failure')
      error.code = 'FORCED_PROJECTION_FAILURE'
      throw error
    }
  })
  await assertRejects(
    service.createGoal({ id: goalId, projectId: workspaceId, title: 'Committed source', objective: 'Recover it' }),
    (error) => error?.code === 'ledger_projection_pending' &&
      error.details?.sourceCommitted === true && error.details?.reconciliationRequired === true,
    'projection failure must expose the committed-source recovery contract'
  )
  assert(readJsonState(root).goals.some((item) => item.id === goalId), 'projection failure must preserve JSON commit')
  const pending = await service.getShadowProjectionReadiness()
  assertEqual(pending.sourceCommitted, 1, 'projection failure must retain source_committed journal')
  const recovered = await (await openCommands(root)).reconcileShadowProjection()
  assert(recovered.ready, 'default migration must reconcile a failed projection')
  assert(await readLedgerGoal(root, goalId), 'reconciliation must project the preserved Goal')
  console.log('[PASS] projection failure is explicit and recoverable')
}

async function unrelatedRevisionCanary() {
  const root = scenarioRoot('unrelated-canary')
  const workspaceId = 'workspace-unrelated-canary'
  await seedWorkspace(root, workspaceId)
  const commands = await openCommands(root)
  const target = await commands.createGoal({
    id: 'goal-canary-target', projectId: workspaceId, title: 'Target', objective: 'Must remain unchanged'
  })
  const unrelated = await commands.createGoal({
    id: 'goal-canary-unrelated', projectId: workspaceId, title: 'Other', objective: 'Advance independently'
  })
  const faulted = await openCommands(root, { faultAt: 'after_prepare' })
  await assertRejects(
    faulted.updateGoal(target.id, { title: 'Must never commit' }, target.revision),
    (error) => error?.code === 'ledger_shadow_fault_injected' && error.details?.sourceCommitted === false,
    'after_prepare fault must stop before target mutation'
  )
  const direct = await openStore(root)
  await direct.updateGoal(unrelated.id, { title: 'Direct unrelated advance' }, unrelated.revision)
  const recovered = await (await openCommands(root)).reconcileShadowProjection()
  assertEqual(recovered.aborted, 1, 'unchanged target intent must be aborted despite unrelated Store revision')
  const targetSource = await direct.getGoal(target.id)
  const targetLedger = await readLedgerGoal(root, target.id)
  assertEqual(targetSource.revision, target.revision, 'recovery must not replay target JSON update')
  assertEqual(targetLedger.revision, target.revision, 'recovery must not project a fabricated target revision')
  console.log('[PASS] unrelated Store advance cannot impersonate prepared command commit')
}

async function crossInstanceSerialization() {
  const root = scenarioRoot('cross-instance')
  const workspaceId = 'workspace-cross-instance'
  await seedWorkspace(root, workspaceId)
  let activeMigrations = 0
  let maxActiveMigrations = 0
  const migrate = async (...args) => {
    activeMigrations += 1
    maxActiveMigrations = Math.max(maxActiveMigrations, activeMigrations)
    await delay(40)
    try {
      return await bridge.migrateProjectWorkspaceToWorkflowLedger(...args)
    } finally {
      activeMigrations -= 1
    }
  }
  const left = await openCommands(root, { migrate })
  const right = await openCommands(root, { migrate })
  const [goalA, goalB] = await Promise.all([
    left.createGoal({ id: 'goal-cross-a', projectId: workspaceId, title: 'A', objective: 'A' }),
    right.createGoal({ id: 'goal-cross-b', projectId: workspaceId, title: 'B', objective: 'B' })
  ])
  assertEqual(maxActiveMigrations, 1, 'cross-instance migration sections must be serialized')
  assertEqual((await readLedgerGoal(root, goalA.id))?.revision, goalA.revision, 'left Goal must project')
  assertEqual((await readLedgerGoal(root, goalB.id))?.revision, goalB.revision, 'right Goal must project')
  const readiness = await left.getShadowProjectionReadiness()
  assert(readiness.ready && readiness.projectionCommitted === 2, 'both concurrent journals must commit')
  console.log('[PASS] cross-instance commands serialize through durable lock')
}

async function postProjectionSourceRace() {
  const root = scenarioRoot('post-projection-race')
  const workspaceId = 'workspace-post-projection-race'
  await seedWorkspace(root, workspaceId)
  const initial = await (await openCommands(root)).createGoal({
    id: 'goal-post-projection-race', projectId: workspaceId, title: 'Initial', objective: 'Race safely'
  })
  const direct = await openStore(root)
  let injected = false
  const migrate = async (...args) => {
    const result = await bridge.migrateProjectWorkspaceToWorkflowLedger(...args)
    if (!injected) {
      injected = true
      const current = await direct.getGoal(initial.id)
      await direct.updateGoal(initial.id, { title: 'Direct writer won the return race' }, current.revision)
    }
    return result
  }
  const racing = await openCommands(root, { migrate })
  await assertRejects(
    racing.updateGoal(initial.id, { title: 'Command result became stale' }, initial.revision),
    (error) => error?.code === 'ledger_source_result_superseded' &&
      error.details?.sourceCommitted === true && error.details?.reconciliationRequired === false,
    'post-projection source advance must prevent stale command success'
  )
  const source = await direct.getGoal(initial.id)
  const projected = await readLedgerGoal(root, initial.id)
  assertEqual(projected.revision, source.revision, 'race recovery must reproject the latest source revision')
  assertEqual(projected.title, source.title, 'race recovery must reproject latest source content')
  assert((await racing.getShadowProjectionReadiness()).ready, 'superseded result must leave no pending projection')
  console.log('[PASS] post-projection source drift is reprojected and stale success is rejected')
}

async function terminalAcceptancePreflight() {
  const root = scenarioRoot('terminal-preflight')
  const workspaceId = 'workspace-terminal-preflight'
  await seedWorkspace(root, workspaceId)
  const commands = await openCommands(root)
  let goal = await commands.createGoal({
    id: 'goal-terminal-preflight', projectId: workspaceId, title: 'Goal terminal', objective: 'Require canonical acceptance'
  })
  goal = await commands.transitionGoal(goal.id, 'planned', goal.revision)
  goal = await commands.transitionGoal(goal.id, 'running', goal.revision)
  goal = await commands.transitionGoal(goal.id, 'verifying', goal.revision)
  goal = await commands.setGoalAcceptance(goal.id, {
    status: 'passed', evidenceRefs: ['json-only-evidence'], verifiedBy: 'json-verifier', verifiedAt: Date.now()
  }, goal.revision)
  await assertTerminalRejected(
    commands.transitionGoal(goal.id, 'completed', goal.revision), root, 'goal', goal.id, goal.revision, 'verifying'
  )

  let item = await commands.createWorkItem({
    id: 'work-item-terminal-preflight', projectId: workspaceId, title: 'Work item terminal', status: 'verifying'
  })
  item = await commands.setWorkItemAcceptance(item.id, {
    status: 'passed', evidenceRefs: ['json-only-work-evidence'], verifiedBy: 'json-verifier', verifiedAt: Date.now()
  }, item.revision)
  await assertTerminalRejected(
    commands.transitionWorkItem(item.id, 'done', item.revision), root, 'work_item', item.id, item.revision, 'verifying'
  )

  const direct = await openStore(root)
  const completed = await direct.transitionGoal(goal.id, 'completed', goal.revision)
  await assertTerminalRejected(
    commands.archiveGoal(goal.id, completed.revision), root, 'goal', goal.id, completed.revision, 'completed'
  )
  const archived = await direct.archiveGoal(goal.id, completed.revision)
  await assertTerminalRejected(
    commands.restoreGoal(goal.id, archived.revision), root, 'goal', goal.id, archived.revision, 'archived'
  )
  assert((await commands.getShadowProjectionReadiness()).ready, 'preflight rejection must not create pending journals')
  console.log('[PASS] terminal, completed archive, and completed restore fail before JSON commit')
}

async function assertTerminalRejected(promise, root, entityType, id, revision, status) {
  await assertRejects(
    promise,
    (error) => error?.code === 'canonical_acceptance_required' && error.details?.sourceCommitted === false,
    `${entityType} terminal mutation must require canonical Acceptance before JSON write`
  )
  const state = readJsonState(root)
  const collection = entityType === 'goal' ? state.goals : state.workItems
  const entity = collection.find((item) => item.id === id)
  assertEqual(entity.revision, revision, `${entityType} preflight rejection must preserve revision`)
  assertEqual(entity.status, status, `${entityType} preflight rejection must preserve status`)
}

async function runCrashChild() {
  const compiled = requiredEnv('CAOGEN_SHADOW_COMPILED')
  const root = requiredEnv('CAOGEN_SHADOW_ROOT')
  const checkpoint = requiredEnv('CAOGEN_SHADOW_CHECKPOINT')
  const workspaceId = requiredEnv('CAOGEN_SHADOW_WORKSPACE')
  const goalId = requiredEnv('CAOGEN_SHADOW_GOAL')
  const storeApi = await import(pathToFileURL(path.join(compiled, 'main/project-workspace/store.js')).href)
  const commandApi = await import(pathToFileURL(path.join(compiled, 'main/project-workspace/command-service.js')).href)
  const store = new storeApi.ProjectWorkspaceStore(root)
  await store.open()
  const commands = commandApi.createProjectWorkspaceCommandService(store, {
    ledgerShadow: {
      faultAt: checkpoint,
      onFault: () => process.kill(process.pid, 'SIGKILL')
    }
  })
  await commands.createGoal({ id: goalId, projectId: workspaceId, title: checkpoint, objective: 'Crash recovery' })
}

async function seedWorkspace(root, workspaceId) {
  const store = await openStore(root)
  await store.createWorkspace({ id: workspaceId, name: workspaceId, kind: 'software' })
}

async function openStore(root) {
  const store = new storeModule.ProjectWorkspaceStore(root)
  await store.open()
  return store
}

async function openCommands(root, ledgerShadow) {
  const store = await openStore(root)
  return commandModule.createProjectWorkspaceCommandService(store, { ledgerShadow })
}

async function readLedgerGoal(root, goalId) {
  return snapshots.readTaskSnapshotDatabase(root, (db) => workflow.findWorkflowGoal(db, goalId))
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
    'src/main/project-workspace/store.ts',
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
  writeFileSync(path.join(electronDir, 'index.js'),
    `module.exports = { app: { getPath: () => ${JSON.stringify(tempRoot)} } }\n`)
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

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
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

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
