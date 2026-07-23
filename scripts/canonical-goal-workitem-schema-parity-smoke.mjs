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

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-canonical-goal-workitem-parity-'))
const outDir = path.join(tempRoot, 'compiled')
let workspaceStore
let commandsModule
let canonicalView
let snapshots
let workflow
let workflowCodec
let workflowRecovery
let workflowSql
let workflowQuery
let forgedEventSequence = 0

try {
  assertReaderDoesNotReadCurrentJson()
  compileSources()
  installElectronStub()
  workspaceStore = await importCompiled('main/project-workspace/store.js')
  commandsModule = await importCompiled('main/project-workspace/command-service.js')
  canonicalView = await importCompiled('main/project-workspace/ledger-canonical-view.js')
  snapshots = await importCompiled('main/task/task-snapshot.js')
  workflow = await importCompiled('main/task/workflow-ledger-store.js')
  workflowCodec = await importCompiled('main/task/workflow-ledger-codec.js')
  workflowRecovery = await importCompiled('main/task/workflow-ledger-recovery.js')
  workflowSql = await importCompiled('main/task/workflow-ledger-sql.js')
  workflowQuery = await importCompiled('main/task/workflow-ledger-query.js')

  await richParitySurvivesCurrentJsonLoss()
  await multipleWorkspacesRemainIsolated()
  await sourceDigestTamperingFailsClosed()
  await ledgerDigestTamperingFailsClosed()
  await identityRevisionStatusAndRunTamperingFailClosed()
  await descriptorEntitySetMismatchFailsClosed()
  await extraExplicitLedgerEntitiesFailClosed()
  await richRelationCyclesFailClosed()
  await invalidRunReferencesFailClosed()
  await slimRowTamperingFailsClosed()
  console.log('canonical Goal/WorkItem schema parity smoke: PASS')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

async function richParitySurvivesCurrentJsonLoss() {
  const root = scenarioRoot('rich-parity')
  const seeded = await seedRichWorkspace(root, 'rich', { includeRun: true })
  const view = await canonicalView.readVerifiedCanonicalProjectWorkspaceView(seeded.workspace.id, root)
  const persisted = await seeded.store.getState()
  const expectedGoals = persisted.goals.filter((goal) => goal.projectId === seeded.workspace.id).sort(byId)
  const expectedItems = persisted.workItems.filter((item) => item.projectId === seeded.workspace.id).sort(byId)

  assertDeepEqual([...view.goals].sort(byId), expectedGoals, 'rich Goal fields must be available from the verified view')
  assertDeepEqual([...view.workItems].sort(byId), expectedItems, 'rich WorkItem fields must be available from the verified view')
  const goal = view.goals.find((item) => item.id === seeded.goal.id)
  const parent = view.workItems.find((item) => item.id === seeded.parent.id)
  const child = view.workItems.find((item) => item.id === seeded.child.id)
  assert(goal && parent && child, 'rich parity fixtures must be queryable')
  assertEqual(goal.background, 'Updated background', 'Goal background must survive canonical projection')
  assertEqual(goal.contract.budget.maxTokens, 120_000, 'Goal budget contract must survive canonical projection')
  assertEqual(goal.acceptanceResult.status, 'passed', 'Goal Acceptance result must survive canonical projection')
  assertEqual(parent.owner.id, 'worker-rich-parent', 'WorkItem owner must survive canonical projection')
  assert(Number.isFinite(parent.boardOrder), 'WorkItem boardOrder must survive canonical projection')
  assert(child.boardOrder > parent.boardOrder, 'canonical WorkItem boardOrder must preserve creation order')
  assert(parent.lease?.fencingToken === 1, 'WorkItem lease/fencing must survive canonical projection')
  assertDeepEqual(child.dependencyIds, [parent.id], 'WorkItem dependencies must survive canonical projection')
  assertDeepEqual(child.artifactRefs, ['artifact-rich-a', 'artifact-rich-b'], 'Artifact refs must survive canonical projection')
  assertDeepEqual(child.runRefs, [seeded.run.id], 'Run refs must survive canonical projection')
  assertDeepEqual(child.inheritedGoalContract, goal.contract, 'inherited Goal Contract must match the current rich Goal')

  writeFileSync(path.join(root, 'project-workspace.json'), '{not-current-json', { mode: 0o600 })
  const withoutJson = await canonicalView.readVerifiedCanonicalProjectWorkspaceView(seeded.workspace.id, root)
  assertDeepEqual(withoutJson, view, 'verified rich view must not depend on the current ProjectWorkspace JSON')
  console.log('[PASS] full rich schema is verified from Ledger events and survives current JSON loss')
}

async function multipleWorkspacesRemainIsolated() {
  const root = scenarioRoot('workspace-isolation')
  const left = await seedRichWorkspace(root, 'left')
  const right = await seedRichWorkspace(root, 'right')
  const leftView = await canonicalView.readVerifiedCanonicalProjectWorkspaceView(left.workspace.id, root)
  const rightView = await canonicalView.readVerifiedCanonicalProjectWorkspaceView(right.workspace.id, root)
  assert(leftView.goals.every((goal) => goal.projectId === left.workspace.id), 'left Goal view must stay isolated')
  assert(leftView.workItems.every((item) => item.projectId === left.workspace.id), 'left WorkItem view must stay isolated')
  assert(rightView.goals.every((goal) => goal.projectId === right.workspace.id), 'right Goal view must stay isolated')
  assert(rightView.workItems.every((item) => item.projectId === right.workspace.id), 'right WorkItem view must stay isolated')
  console.log('[PASS] verified rich views remain Workspace-scoped')
}

async function sourceDigestTamperingFailsClosed() {
  const root = scenarioRoot('source-digest')
  const seeded = await seedRichWorkspace(root, 'source-digest')
  await appendForgedMigration(root, seeded.workspace.id, (payload) => {
    payload.goals[0].sourceDigest = '0'.repeat(64)
  })
  await assertViewRejects(root, seeded.workspace.id, 'SOURCE_DIGEST_MISMATCH', 'source digest tampering')
  console.log('[PASS] migration sourceDigest tampering fails closed')
}

async function ledgerDigestTamperingFailsClosed() {
  const root = scenarioRoot('ledger-digest')
  const seeded = await seedRichWorkspace(root, 'ledger-digest')
  await appendForgedMigration(root, seeded.workspace.id, (payload) => {
    payload.workItems[0].ledgerDigest = 'f'.repeat(64)
  })
  await assertViewRejects(root, seeded.workspace.id, 'LEDGER_DIGEST_MISMATCH', 'Ledger digest tampering')
  console.log('[PASS] migration ledgerDigest tampering fails closed')
}

async function identityRevisionStatusAndRunTamperingFailClosed() {
  await forgedSourceScenario('identity', (source) => {
    source.projectId = 'other-workspace'
  }, 'IDENTITY_MISMATCH')
  await forgedSourceScenario('revision', (source, descriptor) => {
    source.revision += 1
    descriptor.sourceRevision = source.revision
  }, 'REVISION_MISMATCH')
  await forgedSourceScenario('status', (source) => {
    source.status = 'blocked'
  }, 'STATUS_MISMATCH')
  await forgedSourceScenario('run-mapping', (source) => {
    source.runRefs = ['forged-run']
  }, 'RUN_MAPPING_MISMATCH')
  console.log('[PASS] identity/revision/status/Run mapping tampering fails closed')
}

async function descriptorEntitySetMismatchFailsClosed() {
  const root = scenarioRoot('descriptor-omission')
  const seeded = await seedRichWorkspace(root, 'descriptor-omission')
  await appendForgedMigration(root, seeded.workspace.id, (payload) => {
    payload.workItems = payload.workItems.filter((item) => item.id !== seeded.child.id)
    refreshProjectionDigest(payload)
  })
  await assertViewRejects(root, seeded.workspace.id, 'ENTITY_SET_MISMATCH', 'descriptor omission')
  console.log('[PASS] migration descriptors must close over every current explicit Ledger entity')
}

async function extraExplicitLedgerEntitiesFailClosed() {
  const goalRoot = scenarioRoot('extra-explicit-goal')
  const goalSeeded = await seedRichWorkspace(goalRoot, 'extra-explicit-goal')
  await snapshots.mutateTaskSnapshotDatabase(goalRoot, (db) => {
    workflow.projectGoal(db, {
      id: 'goal-extra-explicit',
      projectId: goalSeeded.workspace.id,
      title: 'Uncommitted explicit Goal',
      objective: 'Must not bypass the migration descriptor closure',
      status: 'draft',
      revision: 1,
      source: 'explicit',
      createdAt: 30,
      updatedAt: 30
    })
  })
  await assertViewRejects(
    goalRoot,
    goalSeeded.workspace.id,
    'ENTITY_SET_MISMATCH',
    'extra explicit Goal outside migration descriptors'
  )

  const itemRoot = scenarioRoot('extra-explicit-work-item')
  const itemSeeded = await seedRichWorkspace(itemRoot, 'extra-explicit-work-item')
  await snapshots.mutateTaskSnapshotDatabase(itemRoot, (db) => {
    workflow.projectWorkItem(db, {
      id: 'work-item-extra-explicit',
      projectId: itemSeeded.workspace.id,
      goalId: itemSeeded.goal.id,
      type: 'coding',
      title: 'Uncommitted explicit WorkItem',
      description: 'Must not bypass the migration descriptor closure',
      status: 'backlog',
      revision: 1,
      source: 'explicit',
      runIds: [],
      createdAt: 31,
      updatedAt: 31
    })
  })
  await assertViewRejects(
    itemRoot,
    itemSeeded.workspace.id,
    'ENTITY_SET_MISMATCH',
    'extra explicit WorkItem outside migration descriptors'
  )
  console.log('[PASS] extra explicit Goal/WorkItem projections invalidate the committed entity set')
}

async function richRelationCyclesFailClosed() {
  const dependencyRoot = scenarioRoot('dependency-cycle')
  const dependencySeeded = await seedRichWorkspace(dependencyRoot, 'dependency-cycle')
  await appendForgedMigration(dependencyRoot, dependencySeeded.workspace.id, (payload) => {
    const parent = payload.workItems.find((item) => item.id === dependencySeeded.parent.id)
    assert(parent, 'dependency cycle parent descriptor must exist')
    parent.source.dependencyIds = [dependencySeeded.child.id]
    parent.sourceDigest = workflowCodec.digest(parent.source)
    refreshProjectionDigest(payload)
  })
  await assertViewRejects(
    dependencyRoot,
    dependencySeeded.workspace.id,
    'RELATION_CYCLE',
    'rich dependency cycle'
  )

  const parentRoot = scenarioRoot('parent-cycle')
  const parentSeeded = await seedRichWorkspace(parentRoot, 'parent-cycle')
  let cyclicParent
  await snapshots.mutateTaskSnapshotDatabase(parentRoot, (db) => {
    const current = workflow.findWorkflowWorkItem(db, parentSeeded.parent.id)
    assert(current, 'parent cycle slim fixture must exist')
    cyclicParent = {
      ...current,
      parentId: parentSeeded.child.id,
      revision: current.revision + 1,
      updatedAt: current.updatedAt + 1
    }
    workflowSql.insertWorkItem(db, cyclicParent)
    workflow.appendWorkflowEvent(db, {
      eventId: `workflow:work-item:${cyclicParent.id}:revision:${cyclicParent.revision}`,
      streamId: `work-item:${cyclicParent.id}`,
      entityType: 'work_item',
      entityId: cyclicParent.id,
      kind: 'work_item.updated',
      payload: { ...cyclicParent },
      occurredAt: cyclicParent.updatedAt
    }, {
      projectId: cyclicParent.projectId,
      goalId: cyclicParent.goalId,
      workItemId: cyclicParent.id
    })
  })
  await appendForgedMigration(parentRoot, parentSeeded.workspace.id, (payload) => {
    const descriptor = payload.workItems.find((item) => item.id === parentSeeded.parent.id)
    assert(descriptor && cyclicParent, 'parent cycle rich descriptor must exist')
    descriptor.parentId = parentSeeded.child.id
    descriptor.source.parentId = parentSeeded.child.id
    descriptor.source.revision = cyclicParent.revision
    descriptor.source.updatedAt = cyclicParent.updatedAt
    descriptor.sourceRevision = cyclicParent.revision
    descriptor.sourceDigest = workflowCodec.digest(descriptor.source)
    descriptor.ledgerDigest = workflowCodec.digest(cyclicParent)
    refreshProjectionDigest(payload)
  })
  await assertViewRejects(parentRoot, parentSeeded.workspace.id, 'RELATION_CYCLE', 'rich parent cycle')
  console.log('[PASS] rich WorkItem parent and dependency cycles fail closed')
}

async function invalidRunReferencesFailClosed() {
  const missingRoot = scenarioRoot('missing-run')
  const missingSeeded = await seedRichWorkspace(missingRoot, 'missing-run', { includeRun: true })
  await appendForgedMigration(missingRoot, missingSeeded.workspace.id, (payload) => {
    replaceDescriptorRun(payload, missingSeeded.child.id, 'run-does-not-exist')
  })
  await assertViewRejects(
    missingRoot,
    missingSeeded.workspace.id,
    'RUN_REFERENCE_INVALID',
    'missing Run reference'
  )

  const ownershipRoot = scenarioRoot('cross-owned-run')
  const owner = await seedRichWorkspace(ownershipRoot, 'run-owner', { includeRun: true })
  const foreign = await seedRichWorkspace(ownershipRoot, 'run-foreign', { includeRun: true })
  await appendForgedMigration(ownershipRoot, owner.workspace.id, (payload) => {
    replaceDescriptorRun(payload, owner.child.id, foreign.run.id)
  })
  await assertViewRejects(
    ownershipRoot,
    owner.workspace.id,
    'RUN_REFERENCE_INVALID',
    'cross-owned Run reference'
  )
  console.log('[PASS] missing and cross-owned Run references fail closed before slim mapping')
}

function replaceDescriptorRun(payload, workItemId, runId) {
  const descriptor = payload.workItems.find((item) => item.id === workItemId)
  assert(descriptor, `Run reference descriptor must exist for ${workItemId}`)
  descriptor.source.runRefs = [runId]
  descriptor.runRefs = [runId]
  descriptor.sourceDigest = workflowCodec.digest(descriptor.source)
  refreshProjectionDigest(payload)
}

function refreshProjectionDigest(payload) {
  payload.projectionDigest = workflowCodec.digest({
    workspace: payload.workspace,
    goals: payload.goals.map((item) => item.source).sort(byId),
    workItems: payload.workItems.map((item) => item.source).sort(byId)
  })
}

async function forgedSourceScenario(name, mutate, expectedCode) {
  const root = scenarioRoot(`forged-${name}`)
  const seeded = await seedRichWorkspace(root, `forged-${name}`)
  await appendForgedMigration(root, seeded.workspace.id, (payload) => {
    const descriptor = payload.workItems.at(-1)
    mutate(descriptor.source, descriptor)
    descriptor.sourceDigest = workflowCodec.digest(descriptor.source)
  })
  await assertViewRejects(root, seeded.workspace.id, expectedCode, `${name} source tampering`)
}

async function slimRowTamperingFailsClosed() {
  const root = scenarioRoot('slim-row')
  const seeded = await seedRichWorkspace(root, 'slim-row')
  await snapshots.mutateTaskSnapshotDatabase(root, (db) => {
    const item = workflow.findWorkflowWorkItem(db, seeded.child.id)
    assert(item, 'slim row tamper fixture must exist')
    const payload = JSON.stringify({ ...item, title: 'tampered without projection event' })
    db.run('UPDATE workflow_work_items SET payload = ? WHERE id = ?', [payload, item.id])
  })
  await assertViewRejects(root, seeded.workspace.id, 'MIGRATION_EVENT_INVALID', 'slim row tampering')
  console.log('[PASS] direct slim-row tampering fails before rich data is returned')
}

async function seedRichWorkspace(root, suffix, options = {}) {
  const store = new workspaceStore.ProjectWorkspaceStore(root)
  await store.open()
  const workspace = await store.createWorkspace({
    id: `workspace-${suffix}`,
    name: `Workspace ${suffix}`,
    kind: 'software',
    resources: [{ kind: 'repository', path: `/tmp/${suffix}` }]
  })
  const commands = await commandsModule.openProjectWorkspaceCommandService(root)
  let goal = await commands.createGoal({
    id: `goal-${suffix}`,
    projectId: workspace.id,
    title: `Goal ${suffix}`,
    objective: `Deliver ${suffix}`,
    background: 'Initial background',
    constraints: ['local-only', 'preserve history'],
    successCriteria: ['verified rich view'],
    budget: { amount: 25, currency: 'USD', maxTokens: 120_000, maxRuns: 8 },
    dueAt: 4_000_000_000_000,
    riskLevel: 'high',
    forbiddenActions: ['delete evidence'],
    acceptance: [
      { id: `goal-accept-${suffix}`, criterion: 'all fields survive', required: true },
      { id: `goal-optional-${suffix}`, criterion: 'optional review', required: false }
    ],
    createdBy: `human-${suffix}`
  })
  goal = await commands.setGoalAcceptance(goal.id, {
    status: 'passed',
    evidenceRefs: [`goal-evidence-${suffix}`],
    verifiedBy: `reviewer-${suffix}`,
    verifiedAt: 100
  }, goal.revision)

  let parent = await commands.createWorkItem({
    id: `parent-${suffix}`,
    projectId: workspace.id,
    goalId: goal.id,
    title: `Parent ${suffix}`,
    description: 'Parent with owner, acceptance, artifacts, and lease',
    type: 'planning',
    priority: 9,
    owner: { type: 'digital_worker', id: `worker-${suffix}-parent`, displayName: `Worker ${suffix}` },
    dueAt: 3_999_999_000_000,
    acceptanceSpec: [{ id: `parent-accept-${suffix}`, criterion: 'parent passes', required: true }],
    artifactRefs: [`artifact-${suffix}-parent`]
  })
  parent = await commands.transitionWorkItem(parent.id, 'ready', parent.revision)
  parent = await commands.acquireWorkItemLease(parent.id, {
    expectedRevision: parent.revision,
    ownerId: parent.owner.id,
    leaseId: `lease-${suffix}`,
    durationMs: 86_400_000
  })
  parent = await commands.setWorkItemAcceptance(parent.id, {
    status: 'passed', evidenceRefs: [`parent-evidence-${suffix}`]
  }, parent.revision)

  let child = await commands.createWorkItem({
    id: `child-${suffix}`,
    projectId: workspace.id,
    goalId: goal.id,
    parentId: parent.id,
    dependencyIds: [parent.id],
    title: `Child ${suffix}`,
    description: 'Child with dependency and Run mapping',
    type: 'coding',
    priority: 7,
    owner: { type: 'human', id: `human-${suffix}`, displayName: `Human ${suffix}` },
    dueAt: 3_999_998_000_000,
    acceptanceSpec: [{ id: `child-accept-${suffix}`, criterion: 'child passes', required: true }],
    artifactRefs: [`artifact-${suffix}-a`, `artifact-${suffix}-b`]
  })
  let run
  if (options.includeRun) {
    run = await seedWorkflowRun(root, workspace.id, goal.id, child.id, suffix)
    child = await commands.updateWorkItem(child.id, { runRefs: [run.id] }, child.revision)
  }
  goal = await commands.updateGoal(goal.id, {
    background: 'Updated background',
    constraints: ['local-only', 'preserve history', 'fail closed']
  }, goal.revision)
  const finalParent = await store.getWorkItem(parent.id)
  const finalChild = await store.getWorkItem(child.id)
  assert(finalParent && finalChild, `rich WorkItem fixtures must survive for ${suffix}`)
  return { store, workspace, goal, parent: finalParent, child: finalChild, run }
}

async function seedWorkflowRun(root, projectId, goalId, workItemId, suffix) {
  const taskRun = {
    schemaVersion: 1,
    id: `run-${suffix}`,
    sessionId: `session-${suffix}`,
    taskId: `task-${suffix}`,
    status: 'failed',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: 10,
    updatedAt: 20,
    error: 'fixture terminal Run',
    steps: [],
    toolExecutions: [],
    effects: []
  }
  const record = {
    schemaVersion: 1,
    id: taskRun.id,
    projectId,
    goalId,
    workItemId,
    sessionId: taskRun.sessionId,
    taskId: taskRun.taskId,
    status: taskRun.status,
    revision: taskRun.revision,
    attempt: taskRun.attempt,
    createdAt: taskRun.createdAt,
    updatedAt: taskRun.updatedAt,
    error: taskRun.error,
    taskRun
  }
  const snapshot = snapshots.buildTaskSnapshot({
    meta: {
      id: taskRun.sessionId,
      title: `Run ${suffix}`,
      cwd: root,
      projectId,
      workspaceId: projectId,
      goalId,
      workItemId,
      childTaskId: taskRun.taskId,
      model: 'fixture-model',
      providerId: 'fixture-provider',
      permissionMode: 'default',
      status: 'error',
      sdkSessionId: `sdk-${suffix}`,
      costUsd: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      contextTokens: 0,
      createdAt: taskRun.createdAt
    },
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run: taskRun,
    now: taskRun.updatedAt
  })
  await snapshots.mutateTaskSnapshotDatabase(root, (db) => {
    db.run(
      'INSERT INTO task_runs(id, session_id, updated_at, payload) VALUES (?, ?, ?, ?)',
      [taskRun.id, taskRun.sessionId, taskRun.updatedAt, JSON.stringify(taskRun)]
    )
    db.run(
      'INSERT INTO task_snapshots(id, session_id, updated_at, payload) VALUES (?, ?, ?, ?)',
      [snapshot.id, snapshot.sessionId, snapshot.updatedAt, JSON.stringify(snapshot)]
    )
    workflowRecovery.upsertWorkflowRecoverySession(db, snapshot)
    workflowSql.insertRun(db, record)
    workflow.appendWorkflowEvent(db, {
      eventId: `workflow:run:${record.id}:revision:${record.revision}`,
      streamId: `run:${record.id}`,
      entityType: 'run',
      entityId: record.id,
      kind: 'run.projected',
      payload: {
        runId: record.id,
        workItemId,
        taskId: record.taskId,
        status: record.status,
        revision: record.revision,
        attempt: record.attempt
      },
      occurredAt: record.updatedAt
    }, { projectId, goalId, workItemId, runId: record.id, sessionId: record.sessionId })
  })
  return record
}

async function appendForgedMigration(root, workspaceId, mutate) {
  await snapshots.mutateTaskSnapshotDatabase(root, (db) => {
    const original = workflowQuery.readAndVerifyEvents(db).filter((event) =>
      event.kind === 'workflow.project-workspace.migrated' && event.entityId === workspaceId
    ).at(-1)
    assert(original, `migration event fixture must exist for ${workspaceId}`)
    const payload = structuredClone(original.payload)
    mutate(payload)
    forgedEventSequence += 1
    workflow.appendWorkflowEvent(db, {
      eventId: `workflow:test:forged-project-workspace:${workspaceId}:${forgedEventSequence}`,
      streamId: original.streamId,
      entityType: 'system',
      entityId: workspaceId,
      kind: original.kind,
      payload,
      occurredAt: original.occurredAt + forgedEventSequence,
      correlationId: `forged-${forgedEventSequence}`
    }, { projectId: workspaceId })
  })
}

async function assertViewRejects(root, workspaceId, code, label) {
  await assertRejects(
    canonicalView.readVerifiedCanonicalProjectWorkspaceView(workspaceId, root),
    (error) => error?.code === code,
    `${label} must fail closed with ${code}`
  )
}

function assertReaderDoesNotReadCurrentJson() {
  const source = readFileSync(path.join(repoRoot, 'src/main/project-workspace/ledger-canonical-view.ts'), 'utf8')
  for (const forbidden of [
    'readProjectWorkspaceState',
    'projectWorkspaceFile',
    "from './persistence'",
    'project-workspace.json'
  ]) {
    assert(!source.includes(forbidden), `verified canonical reader must not use current JSON path: ${forbidden}`)
  }
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/project-workspace/ledger-canonical-view.ts',
    'src/main/project-workspace/command-service.ts',
    'src/main/project-workspace/store.ts',
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
  writeFileSync(path.join(electronDir, 'index.js'), `export const app = { getPath: () => ${JSON.stringify(tempRoot)} }\n`)
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

async function importCompiled(relativePath) {
  return import(pathToFileURL(path.join(outDir, relativePath)).href)
}

function scenarioRoot(name) {
  const root = path.join(tempRoot, name)
  mkdirSync(root, { recursive: true })
  return root
}

function byId(left, right) {
  return left.id.localeCompare(right.id)
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
