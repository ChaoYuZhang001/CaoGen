import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-project-ledger-migration-'))
const outDir = path.join(tempRoot, 'compiled')
let workspaceStore
let bridge
let snapshots
let workflow
let workflowQuery

try {
  compileSources()
  installElectronStub()
  workspaceStore = await importCompiled('main/project-workspace/store.js')
  bridge = await importCompiled('main/project-workspace/ledger-migration.js')
  snapshots = await importCompiled('main/task/task-snapshot.js')
  workflow = await importCompiled('main/task/workflow-ledger-store.js')
  workflowQuery = await importCompiled('main/task/workflow-ledger-query.js')

  await basicMigrationAndIdempotency()
  await sameRevisionSourceDriftFailsClosed()
  await invalidJsonRelationsFailClosed()
  await terminalAcceptanceGuardFailsClosed()
  await crossWorkspaceRunRefFailsClosed()
  await targetOwnershipAndRevisionConflictsFailClosed()
  await migratedSourceAllowsLaterRunButRejectsDualAdvance()
  await committedTargetLossFailsClosed()
  await migratedVerifiedCrashResumesOnce()
  console.log('project workspace ledger migration smoke: PASS')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

async function basicMigrationAndIdempotency() {
  const root = scenarioRoot('basic')
  const source = await seedWorkspace(root, 'basic')
  await seedUnrelatedWorkflowHistory(root)
  const jsonPath = path.join(root, 'project-workspace.json')
  const dbPath = snapshots.taskSnapshotsDbFile(root)
  const jsonBefore = readFileSync(jsonPath)
  const existing = await readLedger(root, (db) => ({
    run: workflow.findWorkflowRun(db, 'history-run'),
    artifact: workflow.findWorkflowArtifact(db, 'history-artifact')
  }))
  assert(existing.run && existing.artifact, 'existing Run and Artifact fixtures must exist')

  const first = await bridge.migrateProjectWorkspaceToWorkflowLedger(source.workspace.id, root)
  assertEqual(first.status, 'migrated', 'first migration status')
  assertEqual(Buffer.compare(jsonBefore, readFileSync(jsonPath)), 0, 'migration must not rewrite ProjectWorkspace JSON')

  const projected = await readLedger(root, (db) => {
    const events = workflowQuery.readAndVerifyEvents(db)
    return {
      goal: workflow.findWorkflowGoal(db, source.goal.id),
      parent: workflow.findWorkflowWorkItem(db, source.parent.id),
      child: workflow.findWorkflowWorkItem(db, source.child.id),
      historyRun: workflow.findWorkflowRun(db, 'history-run'),
      historyArtifact: workflow.findWorkflowArtifact(db, 'history-artifact'),
      migrationEvents: events.filter((event) => event.kind === 'workflow.project-workspace.migrated')
    }
  })
  assertEqual(projected.goal?.revision, source.goal.revision, 'Goal revision must be preserved')
  assertEqual(projected.goal?.projectId, source.workspace.id, 'Goal Workspace ownership must be preserved')
  assertEqual(projected.parent?.revision, source.parent.revision, 'parent WorkItem revision must be preserved')
  assertEqual(projected.child?.goalId, source.goal.id, 'WorkItem Goal ownership must be preserved')
  assertEqual(projected.child?.parentId, source.parent.id, 'WorkItem parent ownership must be preserved')
  assert(projected.historyRun && projected.historyArtifact, 'existing Run and Artifact must survive migration')
  assertEqual(projected.migrationEvents.length, 1, 'first migration must append one aggregate event')
  const payload = projected.migrationEvents[0].payload
  const childAudit = payload.workItems.find((item) => item.id === source.child.id)
  assertDeepEqual(childAudit.source.dependencyIds, [source.parent.id], 'dependencyIds must survive in audit payload')
  assertEqual(childAudit.source.priority, 7, 'priority must survive in audit payload')
  assertEqual(childAudit.source.owner.id, 'worker-basic', 'owner must survive in audit payload')
  assertEqual(childAudit.source.acceptanceSpec[0].id, 'accept-basic', 'Acceptance spec must survive in audit payload')
  assertEqual(payload.source.sha256, first.sourceSha256, 'event must bind exact JSON digest')
  assertEqual(readFileSync(payload.source.backupPath).compare(jsonBefore), 0, 'journal sidecar must preserve exact JSON bytes')

  const dbAfterFirst = readFileSync(dbPath)
  const second = await bridge.ensureProjectWorkspaceLedgerProjection(source.workspace.id, root)
  assertEqual(second.status, 'already_current', 'identical projection must be idempotent')
  assertEqual(Buffer.compare(dbAfterFirst, readFileSync(dbPath)), 0, 'idempotent migration must not change SQLite bytes')
  assertEqual(Buffer.compare(jsonBefore, readFileSync(jsonPath)), 0, 'idempotent migration must not change JSON bytes')
  const eventCount = await readLedger(root, (db) => workflowQuery.readAndVerifyEvents(db)
    .filter((event) => event.kind === 'workflow.project-workspace.migrated').length)
  assertEqual(eventCount, 1, 'idempotent migration must not append a duplicate event')
  console.log('[PASS] projection preserves identity/history and is byte-idempotent')
}

async function sameRevisionSourceDriftFailsClosed() {
  const root = scenarioRoot('source-drift')
  const source = await seedWorkspace(root, 'drift')
  await bridge.migrateProjectWorkspaceToWorkflowLedger(source.workspace.id, root)
  const jsonPath = path.join(root, 'project-workspace.json')
  const dbPath = snapshots.taskSnapshotsDbFile(root)
  const state = JSON.parse(readFileSync(jsonPath, 'utf8'))
  const goal = state.goals.find((item) => item.id === source.goal.id)
  goal.title = 'changed without a revision'
  writeJson(jsonPath, state)
  const tamperedSource = readFileSync(jsonPath)
  const targetBefore = readFileSync(dbPath)
  await assertRejects(
    bridge.migrateProjectWorkspaceToWorkflowLedger(source.workspace.id, root),
    (error) => error?.code === 'SOURCE_REVISION_DRIFT',
    'same-revision source drift must fail closed'
  )
  assertEqual(Buffer.compare(targetBefore, readFileSync(dbPath)), 0, 'source drift must not change target bytes')
  assertEqual(Buffer.compare(tamperedSource, readFileSync(jsonPath)), 0, 'source drift must not rewrite JSON')
  console.log('[PASS] same-revision JSON drift is rejected without target mutation')
}

async function invalidJsonRelationsFailClosed() {
  for (const relation of ['goal', 'parent', 'dependency', 'parent-cycle', 'dependency-cycle']) {
    const root = scenarioRoot(`invalid-${relation}`)
    const source = await seedWorkspace(root, relation, { includeForeign: true })
    const jsonPath = path.join(root, 'project-workspace.json')
    const state = JSON.parse(readFileSync(jsonPath, 'utf8'))
    const child = state.workItems.find((item) => item.id === source.child.id)
    const parent = state.workItems.find((item) => item.id === source.parent.id)
    if (relation === 'goal') child.goalId = source.foreign.goal.id
    if (relation === 'parent') child.parentId = source.foreign.item.id
    if (relation === 'dependency') child.dependencyIds = [source.foreign.item.id]
    if (relation === 'parent-cycle') parent.parentId = child.id
    if (relation === 'dependency-cycle') parent.dependencyIds = [child.id]
    writeJson(jsonPath, state)
    const sourceBefore = readFileSync(jsonPath)
    await assertRejects(
      bridge.migrateProjectWorkspaceToWorkflowLedger(source.workspace.id, root),
      (error) => relation.endsWith('cycle')
        ? error?.code === 'RELATION_CYCLE'
        : error?.code === 'CROSS_WORKSPACE_REFERENCE',
      `${relation} relation must fail closed`
    )
    assertEqual(Buffer.compare(sourceBefore, readFileSync(jsonPath)), 0, `${relation} rejection must not rewrite JSON`)
    const migrationEvents = await readLedger(root, (db) => workflowQuery.readAndVerifyEvents(db)
      .filter((event) => event.kind === 'workflow.project-workspace.migrated').length)
    assertEqual(migrationEvents, 0, `${relation} rejection must not append a migration event`)
  }
  console.log('[PASS] cross-Workspace and cyclic Goal/parent/dependency relations are rejected')
}

async function terminalAcceptanceGuardFailsClosed() {
  for (const target of ['goal', 'work-item']) {
    const root = scenarioRoot(`terminal-${target}`)
    const source = await seedWorkspace(root, `terminal-${target}`)
    const jsonPath = path.join(root, 'project-workspace.json')
    const state = JSON.parse(readFileSync(jsonPath, 'utf8'))
    if (target === 'goal') state.goals.find((item) => item.id === source.goal.id).status = 'completed'
    else state.workItems.find((item) => item.id === source.child.id).status = 'done'
    writeJson(jsonPath, state)
    const jsonBefore = readFileSync(jsonPath)
    await assertRejects(
      bridge.migrateProjectWorkspaceToWorkflowLedger(source.workspace.id, root),
      (error) => error?.code === 'WORKFLOW_ACCEPTANCE_REQUIRED',
      `${target} terminal migration must require Workflow Acceptance`
    )
    assertEqual(Buffer.compare(jsonBefore, readFileSync(jsonPath)), 0, `${target} rejection must preserve JSON bytes`)
    const events = await readLedger(root, (db) => workflowQuery.readAndVerifyEvents(db)
      .filter((event) => event.kind === 'workflow.project-workspace.migrated'))
    assertEqual(events.length, 0, `${target} rejection must not append a migration event`)
  }
  console.log('[PASS] terminal Goal/WorkItem migration cannot bypass Workflow Acceptance Guard')
}

async function crossWorkspaceRunRefFailsClosed() {
  const root = scenarioRoot('cross-run')
  const source = await seedWorkspace(root, 'cross-run', { includeForeign: true })
  await bridge.migrateProjectWorkspaceToWorkflowLedger(source.foreign.workspace.id, root)
  const run = buildRun('foreign-run', 'foreign-session', 'foreign-task', 2, 100)
  await snapshots.saveTaskSnapshot(snapshots.buildTaskSnapshot({
    meta: buildMeta(root, run.sessionId, source.foreign.workspace.id, {
      workspaceId: source.foreign.workspace.id,
      goalId: source.foreign.goal.id,
      workItemId: source.foreign.item.id,
      childTaskId: run.taskId
    }),
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run,
    now: run.updatedAt
  }), root)
  const jsonPath = path.join(root, 'project-workspace.json')
  const state = JSON.parse(readFileSync(jsonPath, 'utf8'))
  state.workItems.find((item) => item.id === source.child.id).runRefs = [run.id]
  writeJson(jsonPath, state)
  const targetBefore = readFileSync(snapshots.taskSnapshotsDbFile(root))
  await assertRejects(
    bridge.migrateProjectWorkspaceToWorkflowLedger(source.workspace.id, root),
    (error) => error?.code === 'RUN_REFERENCE_OWNERSHIP',
    'cross-Workspace Run reference must fail closed'
  )
  assertEqual(Buffer.compare(targetBefore, readFileSync(snapshots.taskSnapshotsDbFile(root))), 0,
    'cross-Workspace Run rejection must preserve target bytes')
  console.log('[PASS] missing/cross-Workspace Run ownership fails closed')
}

async function targetOwnershipAndRevisionConflictsFailClosed() {
  const cases = [
    { name: 'ownership', projectId: 'foreign-project', revision: 1, code: 'TARGET_OWNERSHIP_CONFLICT' },
    { name: 'revision', projectId: undefined, revision: 3, code: 'TARGET_REVISION_CONFLICT' }
  ]
  for (const fixture of cases) {
    const root = scenarioRoot(`target-${fixture.name}`)
    const source = await seedWorkspace(root, `target-${fixture.name}`)
    await snapshots.readTaskSnapshotDatabase(root, () => undefined)
    await snapshots.mutateTaskSnapshotDatabase(root, (db) => workflow.projectGoal(db, {
      id: source.goal.id,
      projectId: fixture.projectId ?? source.workspace.id,
      title: fixture.name === 'revision' ? 'target advanced independently' : source.goal.title,
      objective: source.goal.objective,
      revision: fixture.revision,
      createdAt: source.goal.createdAt,
      updatedAt: source.goal.updatedAt + fixture.revision
    }))
    const dbPath = snapshots.taskSnapshotsDbFile(root)
    const targetBefore = readFileSync(dbPath)
    const jsonBefore = readFileSync(path.join(root, 'project-workspace.json'))
    await assertRejects(
      bridge.migrateProjectWorkspaceToWorkflowLedger(source.workspace.id, root),
      (error) => error?.code === fixture.code,
      `${fixture.name} target conflict must fail closed`
    )
    assertEqual(Buffer.compare(targetBefore, readFileSync(dbPath)), 0, `${fixture.name} conflict must preserve target bytes`)
    assertEqual(Buffer.compare(jsonBefore, readFileSync(path.join(root, 'project-workspace.json'))), 0,
      `${fixture.name} conflict must preserve JSON bytes`)
  }
  console.log('[PASS] target ownership/revision conflicts preserve both stores')
}

async function migratedSourceAllowsLaterRunButRejectsDualAdvance() {
  const root = scenarioRoot('target-ahead')
  const source = await seedWorkspace(root, 'target-ahead')
  await bridge.migrateProjectWorkspaceToWorkflowLedger(source.workspace.id, root)
  const run = buildRun('target-ahead-run', 'target-ahead-session', 'target-ahead-task', 3, 300)
  await snapshots.saveTaskSnapshot(snapshots.buildTaskSnapshot({
    meta: buildMeta(root, run.sessionId, source.workspace.id, {
      workspaceId: source.workspace.id,
      goalId: source.goal.id,
      workItemId: source.child.id,
      childTaskId: run.taskId
    }),
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run,
    now: run.updatedAt
  }), root)
  const dbPath = snapshots.taskSnapshotsDbFile(root)
  const runProjectedBytes = readFileSync(dbPath)
  const unchanged = await bridge.migrateProjectWorkspaceToWorkflowLedger(source.workspace.id, root)
  assertEqual(unchanged.status, 'already_current', 'same migrated JSON source must tolerate a later Run projection')
  assertEqual(Buffer.compare(runProjectedBytes, readFileSync(dbPath)), 0,
    'same source retry must not overwrite later Run activity')

  await snapshots.mutateTaskSnapshotDatabase(root, (db) => {
    const target = workflow.findWorkflowWorkItem(db, source.child.id)
    assert(target, 'migrated target WorkItem must exist before independent target advance')
    workflow.projectWorkItem(db, {
      ...target,
      title: 'Workflow target also advanced',
      revision: target.revision + 1,
      updatedAt: target.updatedAt + 1
    })
  })
  const store = new workspaceStore.ProjectWorkspaceStore(root)
  await store.open()
  const current = await store.getWorkItem(source.child.id)
  await store.updateWorkItem(source.child.id, { title: 'JSON also advanced' }, current.revision)
  const beforeConflict = readFileSync(dbPath)
  await assertRejects(
    bridge.migrateProjectWorkspaceToWorkflowLedger(source.workspace.id, root),
    (error) => error?.code === 'TARGET_REVISION_CONFLICT',
    'JSON and target advancing independently must fail closed'
  )
  assertEqual(Buffer.compare(beforeConflict, readFileSync(dbPath)), 0, 'dual-advance conflict must preserve newer target bytes')
  console.log('[PASS] migrated source tolerates later Run activity but rejects ambiguous dual advance')
}

async function committedTargetLossFailsClosed() {
  const missingRoot = scenarioRoot('committed-missing')
  const missingSource = await seedWorkspace(missingRoot, 'missing')
  await bridge.migrateProjectWorkspaceToWorkflowLedger(missingSource.workspace.id, missingRoot)
  const missingDb = snapshots.taskSnapshotsDbFile(missingRoot)
  rmSync(missingDb)
  await assertRejects(
    bridge.migrateProjectWorkspaceToWorkflowLedger(missingSource.workspace.id, missingRoot),
    (error) => error?.code === 'COMMITTED_TARGET_MISSING',
    'committed target deletion must fail closed'
  )
  assert(!exists(missingDb), 'missing committed target must not be silently recreated')

  const truncatedRoot = scenarioRoot('committed-truncated')
  const truncatedSource = await seedWorkspace(truncatedRoot, 'truncated')
  await bridge.migrateProjectWorkspaceToWorkflowLedger(truncatedSource.workspace.id, truncatedRoot)
  const truncatedDb = snapshots.taskSnapshotsDbFile(truncatedRoot)
  writeFileSync(truncatedDb, Buffer.from('not-a-sqlite-database'))
  const corrupt = readFileSync(truncatedDb)
  await assertRejects(
    bridge.migrateProjectWorkspaceToWorkflowLedger(truncatedSource.workspace.id, truncatedRoot),
    () => true,
    'committed target truncation must fail closed'
  )
  assertEqual(Buffer.compare(corrupt, readFileSync(truncatedDb)), 0, 'truncated committed target must not be replaced')
  console.log('[PASS] committed target deletion/truncation is fail-closed')
}

async function migratedVerifiedCrashResumesOnce() {
  const root = scenarioRoot('crash-resume')
  const source = await seedWorkspace(root, 'crash')
  await snapshots.readTaskSnapshotDatabase(root, () => undefined)
  const dbPath = snapshots.taskSnapshotsDbFile(root)
  const jsonPath = path.join(root, 'project-workspace.json')
  const targetBefore = readFileSync(dbPath)
  const jsonBefore = readFileSync(jsonPath)
  await assertRejects(
    bridge.migrateProjectWorkspaceToWorkflowLedger(source.workspace.id, root, {
      faultAt: 'after_migrated_verified'
    }),
    (error) => error?.checkpoint === 'after_migrated_verified',
    'after_migrated_verified fault must interrupt before target replacement'
  )
  assertEqual(Buffer.compare(targetBefore, readFileSync(dbPath)), 0, 'verified candidate fault must preserve target bytes')
  assertEqual(Buffer.compare(jsonBefore, readFileSync(jsonPath)), 0, 'verified candidate fault must preserve JSON bytes')

  const resumed = await bridge.migrateProjectWorkspaceToWorkflowLedger(source.workspace.id, root)
  assertEqual(resumed.status, 'migrated', 'verified candidate must resume and commit')
  const events = await readLedger(root, (db) => workflowQuery.readAndVerifyEvents(db)
    .filter((event) => event.kind === 'workflow.project-workspace.migrated'))
  assertEqual(events.length, 1, 'crash recovery must commit the migration event exactly once')
  const afterResume = readFileSync(dbPath)
  const third = await bridge.migrateProjectWorkspaceToWorkflowLedger(source.workspace.id, root)
  assertEqual(third.status, 'already_current', 'post-recovery retry must be idempotent')
  assertEqual(Buffer.compare(afterResume, readFileSync(dbPath)), 0, 'post-recovery retry must preserve target bytes')
  console.log('[PASS] after_migrated_verified crash resumes exactly once')
}

async function seedWorkspace(root, suffix, options = {}) {
  const store = new workspaceStore.ProjectWorkspaceStore(root)
  await store.open()
  const workspace = await store.createWorkspace({
    id: `workspace-${suffix}`,
    name: `Workspace ${suffix}`,
    kind: 'software',
    resources: [{ kind: 'repository', path: `/tmp/${suffix}`, metadata: { branch: 'main' } }],
    budgetPolicy: { monthlyUsd: 50 }
  })
  const goal = await store.createGoal({
    id: `goal-${suffix}`,
    projectId: workspace.id,
    title: `Goal ${suffix}`,
    objective: `Migrate ${suffix}`,
    constraints: ['preserve JSON'],
    acceptance: [{ id: `goal-accept-${suffix}`, criterion: 'migration passes' }]
  })
  const parent = await store.createWorkItem({
    id: `parent-${suffix}`,
    projectId: workspace.id,
    goalId: goal.id,
    title: `Parent ${suffix}`,
    type: 'planning',
    priority: 5
  })
  const child = await store.createWorkItem({
    id: `child-${suffix}`,
    projectId: workspace.id,
    goalId: goal.id,
    parentId: parent.id,
    dependencyIds: [parent.id],
    title: `Child ${suffix}`,
    description: 'keeps non-ledger fields in the audit event',
    type: 'coding',
    priority: 7,
    owner: { type: 'digital_worker', id: `worker-${suffix}` },
    acceptanceSpec: [{ id: `accept-${suffix}`, criterion: 'tests pass' }]
  })
  let foreign
  if (options.includeForeign) {
    const foreignWorkspace = await store.createWorkspace({
      id: `foreign-workspace-${suffix}`,
      name: `Foreign ${suffix}`
    })
    const foreignGoal = await store.createGoal({
      id: `foreign-goal-${suffix}`,
      projectId: foreignWorkspace.id,
      title: `Foreign Goal ${suffix}`,
      objective: 'Remain isolated'
    })
    const foreignItem = await store.createWorkItem({
      id: `foreign-item-${suffix}`,
      projectId: foreignWorkspace.id,
      goalId: foreignGoal.id,
      title: `Foreign Item ${suffix}`
    })
    foreign = { workspace: foreignWorkspace, goal: foreignGoal, item: foreignItem }
  }
  return { workspace, goal, parent, child, foreign }
}

async function seedUnrelatedWorkflowHistory(root) {
  const run = buildRun('history-run', 'history-session', 'history-task', 1, 50)
  const snapshot = snapshots.buildTaskSnapshot({
    meta: buildMeta(root, run.sessionId, 'history-project', { childTaskId: run.taskId }),
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run,
    now: run.updatedAt
  })
  await snapshots.saveTaskSnapshot(snapshot, root)
  await snapshots.mutateTaskSnapshotDatabase(root, (db) => {
    const projectedRun = workflow.findWorkflowRun(db, run.id)
    assert(projectedRun, 'history Run must be projected from the durable Snapshot')
    workflow.registerWorkflowArtifact(db, {
      id: 'history-artifact', projectId: 'history-project',
      workItemId: projectedRun.workItemId, runId: run.id, kind: 'report', title: 'Existing report',
      digest: 'a'.repeat(64), createdAt: 51, updatedAt: 51
    })
  })
}

function buildMeta(root, id, projectId, extra = {}) {
  return {
    id,
    title: `Workflow ${id}`,
    cwd: root,
    projectId,
    model: 'fixture-model',
    providerId: 'fixture-provider',
    permissionMode: 'default',
    status: 'running',
    sdkSessionId: `sdk-${id}`,
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt: 1,
    ...extra
  }
}

function buildRun(id, sessionId, taskId, revision, updatedAt) {
  return {
    schemaVersion: 1,
    id,
    sessionId,
    taskId,
    status: 'executing',
    revision,
    attempt: 1,
    recoveryCount: 0,
    createdAt: 1,
    updatedAt,
    steps: [],
    toolExecutions: [],
    effects: []
  }
}

async function readLedger(root, reader) {
  return snapshots.readTaskSnapshotDatabase(root, reader)
}

function scenarioRoot(name) {
  const root = path.join(tempRoot, name)
  mkdirSync(root, { recursive: true })
  return root
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function exists(filePath) {
  try {
    readFileSync(filePath)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/project-workspace/ledger-migration.ts',
    'src/main/project-workspace/store.ts',
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
  writeFileSync(path.join(electronDir, 'index.js'), `export const app = { getPath: () => ${JSON.stringify(tempRoot)} }\n`)
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

async function importCompiled(relativePath) {
  return import(pathToFileURL(path.join(outDir, relativePath)).href)
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
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assertDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
