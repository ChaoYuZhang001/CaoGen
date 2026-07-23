import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const startedAt = new Date().toISOString()
const runId = startedAt.replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'session-workitem-ownership')
const reportDir = path.join(reportRoot, runId)
const reportPath = path.join(reportDir, 'report.json')
const latestPath = path.join(reportRoot, 'latest.json')
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-session-workitem-ownership-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
const explicitRoot = path.join(tempRoot, 'explicit')
const legacyRoot = path.join(tempRoot, 'legacy')
const missingRoot = path.join(tempRoot, 'missing-work-item')
const unseededRoot = path.join(tempRoot, 'unseeded-work-item')
const aggregateRoot = path.join(tempRoot, 'project-workspace')
const activationRoot = path.join(tempRoot, 'session-activation')
const activationFailureRoot = path.join(tempRoot, 'session-activation-failure')
const unscopedActivationRoot = path.join(tempRoot, 'unscoped-session-activation')
const canonicalRunRoot = path.join(tempRoot, 'canonical-run-invariant')
let result
let failure
mkdirSync(userData, { recursive: true })

try {
  compileSources()
  installElectronStub()

  const lifecycle = await import(pathToFileURL(findCompiledModule(outDir, 'session-create-lifecycle.js')).href)
  const activation = await import(pathToFileURL(findCompiledModule(outDir, 'session-domain-activation.js')).href)
  const snapshotRecovery = await import(pathToFileURL(
    findCompiledModule(outDir, 'task-snapshot-recovery-lifecycle.js')
  ).href)
  const snapshotStore = await import(pathToFileURL(findCompiledModule(outDir, 'task-snapshot.js')).href)
  const workflowApi = await import(pathToFileURL(findCompiledModule(outDir, 'workflow-ledger-api.js')).href)
  const workflowStore = await import(pathToFileURL(findCompiledModule(outDir, 'workflow-ledger-store.js')).href)
  const readinessParity = await import(pathToFileURL(
    findCompiledModule(outDir, 'workflow-ledger-readiness-parity.js')
  ).href)
  const workspaceStore = await import(pathToFileURL(
    findCompiledModuleBySuffix(outDir, path.join('project-workspace', 'store.js'))
  ).href)
  const canonicalBinding = await import(pathToFileURL(
    findCompiledModule(outDir, 'workflow-run-canonical-binding.js')
  ).href)

  await assertOwnershipResolution(lifecycle, workspaceStore)
  await assertActivationProjection(activation, workspaceStore, workflowApi)
  await assertActivationProjectionFailsClosed(activation, workspaceStore, workflowApi)
  await assertUnscopedActivationSkipsProjection(activation)
  await assertSnapshotRecoveryProjection(snapshotRecovery, workspaceStore, snapshotStore, workflowApi)
  assertSessionManagerRunGuard()
  await assertWorkspaceRunRequiresWorkItem(snapshotStore, workflowApi)
  await assertExplicitAndLegacyProjection(snapshotStore, workflowApi, workflowStore, readinessParity)
  await assertCanonicalRunInvariant(
    activation,
    snapshotStore,
    workflowApi,
    canonicalBinding,
    workspaceStore
  )

  result = {
    status: 'PASS',
    canonicalWorkItems: 2,
    sharedWorkItemRuns: 2,
    startupBindingsReused: 2,
    crossWorkItemConflictRejected: true
  }
  console.log('session workitem ownership smoke: PASS')
} catch (error) {
  failure = serializeError(error)
  throw error
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
  writeReport({
    schemaVersion: 1,
    status: result ? 'passed' : 'failed',
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    gate: 'test:session-workitem-ownership:required',
    result: result ?? null,
    error: failure,
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version
    }
  })
}

function writeReport(report) {
  try {
    mkdirSync(reportDir, { recursive: true })
    const body = `${JSON.stringify({
      ...report,
      reportDir: path.relative(repoRoot, reportDir),
      reportPath: path.relative(repoRoot, reportPath)
    }, null, 2)}\n`
    writeFileSync(reportPath, body, 'utf8')
    writeFileSync(latestPath, body, 'utf8')
  } catch (error) {
    console.error(`Session WorkItem ownership report could not be written: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    code: error && typeof error === 'object' && 'code' in error ? error.code : undefined
  }
}

async function assertActivationProjection(activation, workspaceStore, workflowApi) {
  const source = await seedActivationAggregate(workspaceStore, activationRoot, 'activation')
  const ownership = await activation.prepareSessionDomainOwnershipForActivation({
    workspaceId: source.workspace.id,
    workItemId: source.workItem.id
  }, activationRoot)
  assertDeepEqual(ownership, {
    workspaceId: source.workspace.id,
    goalId: source.goal.id,
    workItemId: source.workItem.id
  }, 'activation gate must retain canonical ownership and infer the persisted Goal')

  let ledger = await workflowApi.listPersistedWorkflowLedger({ projectId: source.workspace.id }, activationRoot)
  assertEqual(ledger.goals.total, 1, 'activation gate must project the Workspace Goal before activation')
  assertEqual(ledger.workItems.total, 1, 'activation gate must project the WorkItem before activation')
  assertEqual(activationMigrationEvents(ledger), 1, 'activation gate must append one migration event')

  await activation.prepareSessionDomainOwnershipForActivation(ownership, activationRoot)
  ledger = await workflowApi.listPersistedWorkflowLedger({ projectId: source.workspace.id }, activationRoot)
  assertEqual(activationMigrationEvents(ledger), 1, 'repeated activation must reuse the idempotent projection')
}

async function assertActivationProjectionFailsClosed(activation, workspaceStore, workflowApi) {
  const local = await seedActivationAggregate(workspaceStore, activationFailureRoot, 'local')
  const foreign = await seedActivationAggregate(workspaceStore, activationFailureRoot, 'foreign')
  const file = path.join(activationFailureRoot, 'project-workspace.json')
  const state = JSON.parse(readFileSync(file, 'utf8'))
  state.workItems.find((item) => item.id === local.workItem.id).dependencyIds = [foreign.workItem.id]
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`)

  await assertRejects(
    activation.prepareSessionDomainOwnershipForActivation({
      workspaceId: local.workspace.id,
      goalId: local.goal.id,
      workItemId: local.workItem.id
    }, activationFailureRoot),
    (error) => error?.code === 'CROSS_WORKSPACE_REFERENCE',
    'activation must fail closed when the Workspace aggregate cannot be projected'
  )
  const ledger = await workflowApi.listPersistedWorkflowLedger({}, activationFailureRoot)
  assertEqual(ledger.goals.total, 0, 'failed activation projection must not persist a partial Goal')
  assertEqual(ledger.workItems.total, 0, 'failed activation projection must not persist a partial WorkItem')
  assertEqual(activationMigrationEvents(ledger), 0, 'failed activation projection must not append a migration event')
}

async function assertUnscopedActivationSkipsProjection(activation) {
  assertDeepEqual(
    await activation.prepareSessionDomainOwnershipForActivation({}, unscopedActivationRoot),
    {},
    'session without Workspace ownership must bypass migration'
  )
  assertDeepEqual(
    await activation.prepareSessionDomainOwnershipForActivation({ unassigned: true }, unscopedActivationRoot),
    {},
    'unassigned session must bypass migration'
  )
  assert(
    !existsSync(path.join(unscopedActivationRoot, 'project-workspace.json')),
    'unscoped activation must not create ProjectWorkspace persistence'
  )
}

async function seedActivationAggregate(workspaceStore, root, suffix) {
  const store = await new workspaceStore.ProjectWorkspaceStore(root).open()
  const workspace = await store.createWorkspace({
    id: `workspace-${suffix}`,
    name: `Workspace ${suffix}`,
    kind: 'software'
  })
  const goal = await store.createGoal({
    id: `goal-${suffix}`,
    projectId: workspace.id,
    title: `Goal ${suffix}`,
    objective: `Activate ${suffix}`
  })
  const workItem = await store.createWorkItem({
    id: `work-item-${suffix}`,
    projectId: workspace.id,
    goalId: goal.id,
    title: `WorkItem ${suffix}`
  })
  return { workspace, goal, workItem }
}

function activationMigrationEvents(ledger) {
  return ledger.events.items.filter((event) => event.kind === 'workflow.project-workspace.migrated').length
}

async function assertSnapshotRecoveryProjection(recovery, workspaceStore, snapshotStore, workflowApi) {
  const source = await seedActivationAggregate(workspaceStore, userData, 'snapshot-recovery')
  const digitalWorkerBinding = { kind: 'unscoped' }
  const run = {
    ...buildRun('run-snapshot-recovery', 'session-snapshot-recovery', 'task-snapshot-recovery', 1, 800),
    digitalWorkerBinding
  }
  const stored = buildSnapshot(snapshotStore, run, {
    workspaceId: source.workspace.id,
    workItemId: source.workItem.id,
    digitalWorkerBinding
  }, 800)
  const prepared = await recovery.prepareTaskSnapshotRecovery(stored, userData, () => false)

  assertEqual(prepared.snapshot.meta.goalId, source.goal.id, 'Snapshot recovery must retain the inferred Goal ownership')
  assertEqual(prepared.recoveredRun.status, 'recovering', 'Snapshot recovery must construct a recovering Run')
  const ledger = await workflowApi.listPersistedWorkflowLedger({ projectId: source.workspace.id }, userData)
  assertEqual(ledger.workItems.total, 1, 'Snapshot recovery must project the WorkItem before persisting the Run')
  assertEqual(ledger.runs.total, 1, 'Snapshot recovery must persist exactly one owned Run')
  assertEqual(ledger.runs.items[0].workItemId, source.workItem.id, 'recovered Run must bind the projected WorkItem')
}

async function assertOwnershipResolution(lifecycle, workspaceStore) {
  const created = assertResolvedOwnershipClaims(lifecycle)
  assertInvalidOwnershipClaims(lifecycle, created)
  const store = await seedOwnershipAggregate(workspaceStore)
  await assertPersistedOwnershipClaims(lifecycle, store)
}

function assertResolvedOwnershipClaims(lifecycle) {
  const created = lifecycle.resolveSessionDomainOwnership({
    workspaceId: 'workspace-a',
    goalId: 'goal-a',
    workItemId: 'work-item-a'
  })
  assertDeepEqual(created, {
    workspaceId: 'workspace-a',
    goalId: 'goal-a',
    workItemId: 'work-item-a'
  }, 'new session must retain explicit canonical ownership')

  const inherited = lifecycle.resolveSessionDomainOwnership({}, undefined, created)
  assertDeepEqual(inherited, created, 'child session must inherit parent canonical ownership')

  const restored = lifecycle.resolveSessionDomainOwnership(
    {},
    { ...created, unassigned: false },
    undefined
  )
  assertDeepEqual(restored, created, 'History recovery must restore canonical ownership')

  const childOverride = lifecycle.resolveSessionDomainOwnership(
    { goalId: 'goal-b', workItemId: 'work-item-b' },
    undefined,
    created
  )
  assertDeepEqual(childOverride, {
    workspaceId: 'workspace-a',
    goalId: 'goal-b',
    workItemId: 'work-item-b'
  }, 'child may select another Goal/WorkItem inside the inherited Workspace')

  return created
}

function assertInvalidOwnershipClaims(lifecycle, created) {
  assertThrows(
    () => lifecycle.resolveSessionDomainOwnership(
      { workspaceId: 'workspace-b' },
      undefined,
      created
    ),
    /workspace ownership cannot change/,
    'child session must reject a cross-Workspace ownership claim'
  )
  assertThrows(
    () => lifecycle.resolveSessionDomainOwnership(
      { workspaceId: 'workspace-b' },
      { ...created, unassigned: false }
    ),
    /workspace ownership cannot change/,
    'History recovery must reject a cross-Workspace ownership claim'
  )
  assertThrows(
    () => lifecycle.resolveSessionDomainOwnership(
      { workspaceId: 'workspace-a', goalId: 'goal-b' },
      { ...created, unassigned: false }
    ),
    /resumed session cannot change canonical goalId/,
    'History recovery must reject a changed Goal claim'
  )
  assertThrows(
    () => lifecycle.resolveSessionDomainOwnership({ goalId: 'goal-orphan' }),
    /requires workspaceId/,
    'Goal ownership without a Workspace must fail closed'
  )
  assertThrows(
    () => lifecycle.resolveSessionDomainOwnership({ workItemId: 'work-item-orphan' }),
    /requires workspaceId/,
    'WorkItem ownership without a Workspace must fail closed'
  )
  assertThrows(
    () => lifecycle.assertSessionDomainOwnership({ workspaceId: 'workspace-a', unassigned: true }),
    /unassigned session cannot claim/,
    'unassigned sessions must not claim a Workspace'
  )
}

async function seedOwnershipAggregate(workspaceStore) {
  const store = await new workspaceStore.ProjectWorkspaceStore(aggregateRoot).open()
  await store.createWorkspace({ id: 'workspace-a', name: 'Workspace A', kind: 'software' })
  await store.createWorkspace({ id: 'workspace-b', name: 'Workspace B', kind: 'software' })
  await store.createGoal({
    id: 'goal-a', projectId: 'workspace-a', title: 'Goal A', objective: 'Validate ownership A'
  })
  await store.createGoal({
    id: 'goal-b', projectId: 'workspace-b', title: 'Goal B', objective: 'Validate ownership B'
  })
  await store.createWorkItem({
    id: 'work-item-a',
    projectId: 'workspace-a',
    goalId: 'goal-a',
    title: 'WorkItem A'
  })
  await store.createWorkItem({
    id: 'work-item-b',
    projectId: 'workspace-b',
    goalId: 'goal-b',
    title: 'WorkItem B'
  })
  return store
}

async function assertPersistedOwnershipClaims(lifecycle, store) {
  const persisted = await lifecycle.assertPersistedSessionDomainOwnership({
    workspaceId: 'workspace-a',
    workItemId: 'work-item-a'
  }, aggregateRoot)
  assertDeepEqual(persisted, {
    workspaceId: 'workspace-a',
    goalId: 'goal-a',
    workItemId: 'work-item-a'
  }, 'persisted WorkItem must supply and verify its canonical Goal ownership')

  await assertRejects(
    lifecycle.assertPersistedSessionDomainOwnership({ workspaceId: 'workspace-missing' }, aggregateRoot),
    (error) => String(error).includes('Workspace does not exist'),
    'session activation must reject a missing Workspace'
  )
  await assertRejects(
    lifecycle.assertPersistedSessionDomainOwnership({
      workspaceId: 'workspace-a',
      goalId: 'goal-missing'
    }, aggregateRoot),
    (error) => String(error).includes('Goal does not exist'),
    'session activation must reject a missing Goal'
  )
  await assertRejects(
    lifecycle.assertPersistedSessionDomainOwnership({
      workspaceId: 'workspace-a',
      workItemId: 'work-item-missing'
    }, aggregateRoot),
    (error) => String(error).includes('WorkItem does not exist'),
    'session activation must reject a missing WorkItem'
  )
  await assertRejects(
    lifecycle.assertPersistedSessionDomainOwnership({
      workspaceId: 'workspace-a',
      goalId: 'goal-b'
    }, aggregateRoot),
    (error) => String(error).includes('Goal crosses Workspace boundary'),
    'session activation must reject a Goal from another Workspace'
  )
  await assertRejects(
    lifecycle.assertPersistedSessionDomainOwnership({
      workspaceId: 'workspace-a',
      workItemId: 'work-item-b'
    }, aggregateRoot),
    (error) => String(error).includes('WorkItem crosses Workspace boundary'),
    'session activation must reject a WorkItem from another Workspace'
  )
  await store.archiveWorkspace('workspace-b')
  await assertRejects(
    lifecycle.assertPersistedSessionDomainOwnership({ workspaceId: 'workspace-b' }, aggregateRoot),
    (error) => String(error).includes('Workspace is not active'),
    'session activation must reject an archived Workspace'
  )
}

function assertSessionManagerRunGuard() {
  const source = readFileSync(path.join(repoRoot, 'src/main/sessionManager.ts'), 'utf8')
  const activationSource = readFileSync(path.join(repoRoot, 'src/main/session-domain-activation.ts'), 'utf8')
  const recoverySource = readFileSync(
    path.join(repoRoot, 'src/main/task/task-snapshot-recovery-lifecycle.ts'),
    'utf8'
  )
  assert(
    source.includes('session.meta.workspaceId && !session.meta.workItemId') &&
      source.includes('已阻止创建脱离业务任务的 Run'),
    'SessionManager.send must fail closed before creating a Workspace Run without WorkItem ownership'
  )
  assert(
    recoverySource.includes('snapshot.meta.workspaceId && !snapshot.meta.workItemId') &&
      recoverySource.includes('已阻止创建或恢复孤立 Run'),
    'Task Snapshot recovery must reject a Workspace Run without WorkItem ownership'
  )
  assert(
    (source.match(/await prepareSessionIdentityForActivation\(/g) ?? []).length === 2,
    'SessionManager must gate normal creation and pending recovery'
  )
  assertCallOrder(source, 'private async validatedSessionCreationDraft', 'private activateSessionCreation', [
    'prepareSessionIdentityForActivation', 'return {'
  ], 'normal Session creation must project ownership before activation')
  assertCallOrder(source, 'private async restorePendingSessionCreation', 'async deleteTaskSnapshot', [
    'prepareSessionIdentityForActivation', 'managedSessionPlacement'
  ], 'pending creation recovery must project ownership before placement/activation')
  assertCallOrder(source, 'async recoverTaskSnapshot', 'private async activateRecoveredTaskSnapshot', [
    'prepareTaskSnapshotRecovery', 'activateRecoveredTaskSnapshot'
  ], 'SessionManager must use the Snapshot recovery lifecycle before Engine activation')
  assertCallOrder(recoverySource, 'export async function prepareTaskSnapshotRecovery', 'async function settleTerminalRecoverySnapshot', [
    'assertWorkspaceSnapshotOwnership',
    'prepareSessionDomainOwnershipForActivation',
    'reconcilePersistedTaskSnapshot',
    'recoveredTaskRun'
  ], 'Snapshot recovery must project ownership before persistence and Run recovery')
  assertCallOrder(activationSource, 'export async function prepareSessionDomainOwnershipForActivation', undefined, [
    'assertPersistedSessionDomainOwnership',
    'ensureProjectWorkspaceLedgerProjection',
    'return assertPersistedSessionDomainOwnership'
  ], 'activation gate must validate, project and revalidate ownership')
  assert(
    activationSource.includes('!ownership.workspaceId || claim.unassigned === true'),
    'activation gate must skip migration for unscoped and unassigned Sessions'
  )
}

function assertCallOrder(source, startMarker, endMarker, markers, message) {
  const start = source.indexOf(startMarker)
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length
  assert(start >= 0 && end > start, `${message}: source section is missing`)
  const section = source.slice(start, end)
  let cursor = -1
  for (const marker of markers) {
    const next = section.indexOf(marker, cursor + 1)
    assert(next > cursor, `${message}: missing or out-of-order ${marker}`)
    cursor = next
  }
}

async function assertWorkspaceRunRequiresWorkItem(snapshotStore, workflowApi) {
  const run = buildRun('run-missing-work-item', 'session-missing-work-item', 'task-missing-work-item', 1, 100)
  const snapshot = buildSnapshot(snapshotStore, run, {
    workspaceId: 'workspace-a',
    goalId: 'goal-a'
  }, 100)
  await assertRejects(
    snapshotStore.saveTaskSnapshot(snapshot, missingRoot),
    (error) => String(error).includes('workspace-bound Run is missing canonical workItemId'),
    'Workspace-bound Run without WorkItem must fail closed'
  )
  const ledger = await workflowApi.listPersistedWorkflowLedger({}, missingRoot)
  assertEqual(ledger.workItems.total, 0, 'failed Workspace Run must not persist a WorkItem')
  assertEqual(ledger.runs.total, 0, 'failed Workspace Run must not persist a WorkflowRun')
}

async function assertExplicitAndLegacyProjection(snapshotStore, workflowApi, workflowStore, readinessParity) {
  const explicitOwnership = explicitSessionOwnership()
  await assertMissingExplicitWorkItemRejected(snapshotStore, workflowApi, workflowStore, explicitOwnership)
  await seedExplicitWorkflowOwnership(snapshotStore, workflowStore)
  const stableState = await assertExplicitRunSharing(snapshotStore, workflowApi, explicitOwnership, readinessParity)
  await assertExplicitOwnershipDriftRejected(snapshotStore, workflowApi, explicitOwnership, stableState)
  await assertLegacyDagProjection(snapshotStore, workflowApi)
}

function explicitSessionOwnership() {
  return {
    projectId: 'legacy-directory-project',
    workspaceId: 'workspace-a',
    goalId: 'goal-a',
    workItemId: 'work-item-explicit',
    orchestrationId: 'dag-explicit',
    childTaskId: 'task-explicit',
    childRole: 'development'
  }
}

async function assertMissingExplicitWorkItemRejected(snapshotStore, workflowApi, workflowStore, explicitOwnership) {
  await snapshotStore.mutateTaskSnapshotDatabase(unseededRoot, (db) => {
    workflowStore.setupWorkflowLedgerSchema(db)
    workflowStore.projectGoal(db, {
      id: 'goal-a',
      projectId: 'workspace-a',
      title: 'Goal A',
      objective: 'Validate ownership A',
      source: 'explicit'
    })
  })
  await assertRejects(
    snapshotStore.saveTaskSnapshot(
      buildSnapshot(
        snapshotStore,
        buildRun('run-unseeded-explicit', 'session-unseeded-explicit', 'task-explicit', 1, 150),
        explicitOwnership,
        150
      ),
      unseededRoot
    ),
    (error) => String(error).includes('references missing explicit work item work-item-explicit'),
    'Run projection must not create a missing explicit business WorkItem'
  )
  const unseededLedger = await workflowApi.listPersistedWorkflowLedger({}, unseededRoot)
  assertEqual(unseededLedger.workItems.total, 0, 'rejected Run must leave the explicit WorkItem absent')
  assertEqual(unseededLedger.runs.total, 0, 'rejected Run must leave the WorkflowRun absent')
}

async function seedExplicitWorkflowOwnership(snapshotStore, workflowStore) {
  await snapshotStore.mutateTaskSnapshotDatabase(explicitRoot, (db) => {
    workflowStore.setupWorkflowLedgerSchema(db)
    workflowStore.projectGoal(db, {
      id: 'goal-a',
      projectId: 'workspace-a',
      title: 'Goal A',
      objective: 'Validate ownership A',
      status: 'running',
      revision: 1,
      source: 'explicit',
      createdAt: 1,
      updatedAt: 1
    })
    workflowStore.projectWorkItem(db, {
      id: 'work-item-explicit',
      projectId: 'workspace-a',
      goalId: 'goal-a',
      type: 'coding',
      title: 'Explicit WorkItem',
      status: 'running',
      revision: 1,
      source: 'explicit',
      runIds: [],
      createdAt: 1,
      updatedAt: 1
    })
  })
}

async function assertExplicitRunSharing(snapshotStore, workflowApi, explicitOwnership, readinessParity) {
  const beforeRun = await workflowApi.listPersistedWorkflowLedger({ projectId: 'workspace-a' }, explicitRoot)
  assertEqual(beforeRun.workItems.total, 1, 'migration seed must create the canonical business WorkItem before any Run')
  assertEqual(beforeRun.runs.total, 0, 'migration seed must not fabricate a Run')

  const firstRun = buildRun('run-explicit-1', 'session-explicit-1', 'task-explicit', 1, 200)
  const firstSnapshot = buildSnapshot(snapshotStore, firstRun, explicitOwnership, 200)
  await snapshotStore.saveTaskSnapshot(firstSnapshot, explicitRoot)

  let ledger = await workflowApi.listPersistedWorkflowLedger({ projectId: 'workspace-a' }, explicitRoot)
  assertEqual(ledger.workItems.total, 1, 'first explicit Run must bind the existing WorkItem without creating another')
  assertEqual(ledger.runs.total, 1, 'first explicit Run must create one WorkflowRun')
  assertEqual(ledger.workItems.items[0].id, 'work-item-explicit', 'explicit WorkItem must override DAG derivation')
  assertEqual(ledger.workItems.items[0].source, 'explicit', 'explicit WorkItem must retain explicit source')
  assertEqual(ledger.workItems.items[0].projectId, 'workspace-a', 'Workspace must replace legacy projectId as scope')
  assert(
    !ledger.workItems.items.some((item) => item.id === 'work-item:dag:dag-explicit:task-explicit'),
    'explicit ownership must not create a duplicate DAG-derived WorkItem'
  )
  const readinessDiagnostics = []
  readinessParity.assessWorkflowReadinessParity({
    taskRuns: [firstRun],
    snapshots: [firstSnapshot],
    workflowRuns: ledger.runs.items,
    recoverySessions: [firstSnapshot],
    evidence: []
  }, readinessDiagnostics)
  assert(
    !readinessDiagnostics.some((item) => item.code === 'snapshot_workflow_project_mismatch'),
    'readiness parity must compare canonical workspaceId instead of the legacy directory projectId'
  )

  const secondRun = buildRun('run-explicit-2', 'session-explicit-2', 'task-explicit', 1, 300)
  await snapshotStore.saveTaskSnapshot(
    buildSnapshot(snapshotStore, secondRun, explicitOwnership, 300),
    explicitRoot
  )
  ledger = await workflowApi.listPersistedWorkflowLedger({ workItemId: 'work-item-explicit' }, explicitRoot)
  assertEqual(ledger.workItems.total, 1, 'two Runs with the same explicit ownership must share one WorkItem')
  assertEqual(ledger.runs.total, 2, 'two Runs with the same explicit ownership must both persist')
  assertEqual(ledger.workItems.items[0].runIds.length, 2, 'shared explicit WorkItem must retain both Run IDs')
  assertDeepEqual(
    [...ledger.workItems.items[0].runIds].sort(),
    ['run-explicit-1', 'run-explicit-2'],
    'shared explicit WorkItem must retain the exact Run identities'
  )

  return ledgerState(ledger)
}

async function assertExplicitOwnershipDriftRejected(snapshotStore, workflowApi, explicitOwnership, stableState) {
  const crossWorkspaceRun = buildRun('run-explicit-cross-workspace', 'session-explicit-cross-workspace', 'task-explicit', 1, 400)
  await assertRejects(
    snapshotStore.saveTaskSnapshot(buildSnapshot(snapshotStore, crossWorkspaceRun, {
      ...explicitOwnership,
      workspaceId: 'workspace-b'
    }, 400), explicitRoot),
    (error) => /scope differs|ownership changed|crosses project boundary/.test(String(error)),
    'existing WorkItem must reject a cross-Workspace Run'
  )
  assertEqual(
    ledgerState(await workflowApi.listPersistedWorkflowLedger({ workItemId: 'work-item-explicit' }, explicitRoot)),
    stableState,
    'cross-Workspace WorkItem rejection must leave canonical state unchanged'
  )

  const crossGoalRun = buildRun('run-explicit-cross-goal', 'session-explicit-cross-goal', 'task-explicit', 1, 500)
  await assertRejects(
    snapshotStore.saveTaskSnapshot(buildSnapshot(snapshotStore, crossGoalRun, {
      ...explicitOwnership,
      goalId: 'goal-b'
    }, 500), explicitRoot),
    (error) => /goal scope differs|ownership changed|goal\/work item ownership differs/.test(String(error)),
    'existing WorkItem must reject a cross-Goal Run'
  )
  assertEqual(
    ledgerState(await workflowApi.listPersistedWorkflowLedger({ workItemId: 'work-item-explicit' }, explicitRoot)),
    stableState,
    'cross-Goal WorkItem rejection must leave canonical state unchanged'
  )

  const updatedFirstRun = buildRun('run-explicit-1', 'session-explicit-1', 'task-explicit', 2, 600)
  await assertRejects(
    snapshotStore.saveTaskSnapshot(buildSnapshot(snapshotStore, updatedFirstRun, {
      ...explicitOwnership,
      workspaceId: 'workspace-b'
    }, 600), explicitRoot),
    (error) => /ownership differs from WorkflowRun|scope differs/.test(String(error)),
    'persisted Run must reject changed Workspace ownership'
  )
  assertEqual(
    ledgerState(await workflowApi.listPersistedWorkflowLedger({ workItemId: 'work-item-explicit' }, explicitRoot)),
    stableState,
    'cross-Workspace Run rejection must leave canonical state unchanged'
  )
}

async function assertLegacyDagProjection(snapshotStore, workflowApi) {
  const legacyRun = buildRun('run-legacy-dag', 'session-legacy-dag', 'task-legacy', 1, 700)
  const ownership = {
    projectId: 'legacy-project',
    orchestrationId: 'dag-legacy',
    childTaskId: 'task-legacy',
    childRole: 'testing'
  }
  await snapshotStore.saveTaskSnapshot(
    buildSnapshot(snapshotStore, legacyRun, ownership, 700), legacyRoot
  )
  const secondRun = buildRun('run-legacy-dag-2', 'session-legacy-dag-2', 'task-legacy', 1, 710)
  await snapshotStore.saveTaskSnapshot(
    buildSnapshot(snapshotStore, secondRun, ownership, 710), legacyRoot
  )
  const legacyLedger = await workflowApi.listPersistedWorkflowLedger({ projectId: 'legacy-project' }, legacyRoot)
  assertEqual(legacyLedger.workItems.total, 1, 'legacy DAG Run must still create one WorkItem')
  assertEqual(legacyLedger.runs.total, 2, 'independent legacy Sessions must retain both Runs')
  assertDeepEqual(
    [...legacyLedger.workItems.items[0].runIds].sort(),
    ['run-legacy-dag', 'run-legacy-dag-2'],
    'independent legacy Sessions must share one derived WorkItem'
  )
  assertEqual(
    legacyLedger.workItems.items[0].id,
    'work-item:dag:dag-legacy:task-legacy',
    'legacy DAG compatibility must retain work-item:dag:* identity'
  )
  assertEqual(legacyLedger.workItems.items[0].source, 'dag', 'legacy DAG WorkItem must retain DAG source')
}

async function assertCanonicalRunInvariant(
  activation,
  snapshotStore,
  workflowApi,
  canonicalBinding,
  workspaceStore
) {
  const store = await new workspaceStore.ProjectWorkspaceStore(canonicalRunRoot).open()
  const workspace = await store.createWorkspace({
    id: 'canonical-run-workspace', name: 'Canonical Run Workspace', kind: 'software'
  })
  const goal = await store.createGoal({
    id: 'canonical-run-goal',
    projectId: workspace.id,
    title: 'Canonical Run Goal',
    objective: 'Share one WorkItem across independent Sessions'
  })
  const workItem = await store.createWorkItem({
    id: 'canonical-run-work-item',
    projectId: workspace.id,
    goalId: goal.id,
    title: 'Shared WorkItem'
  })
  const otherWorkItem = await store.createWorkItem({
    id: 'canonical-run-other-work-item',
    projectId: workspace.id,
    goalId: goal.id,
    title: 'Other WorkItem'
  })
  const ownership = {
    projectId: workspace.id,
    workspaceId: workspace.id,
    goalId: goal.id,
    workItemId: workItem.id,
    childTaskId: 'canonical-task'
  }
  await activation.prepareSessionDomainOwnershipForActivation(ownership, canonicalRunRoot)

  const firstRun = buildRun('canonical-run-1', 'canonical-session-1', 'canonical-task', 1, 800)
  const secondRun = buildRun('canonical-run-2', 'canonical-session-2', 'canonical-task', 1, 810)
  const firstMeta = buildMeta(firstRun.sessionId, ownership)
  const secondMeta = buildMeta(secondRun.sessionId, ownership)
  await snapshotStore.saveTaskSnapshot(
    buildSnapshot(snapshotStore, firstRun, ownership, 800), canonicalRunRoot
  )
  await snapshotStore.saveTaskSnapshot(
    buildSnapshot(snapshotStore, secondRun, ownership, 810), canonicalRunRoot
  )
  const [firstBinding, secondBinding] = await Promise.all([
    canonicalBinding.bindWorkflowRunToCanonicalWorkItem(firstMeta, firstRun, canonicalRunRoot),
    canonicalBinding.bindWorkflowRunToCanonicalWorkItem(secondMeta, secondRun, canonicalRunRoot)
  ])
  assertEqual(firstBinding.disposition, 'attached', 'first canonical Session Run must attach to its WorkItem')
  assertEqual(secondBinding.disposition, 'attached', 'second canonical Session Run must attach to the same WorkItem')

  // Startup replays both durable snapshots. The binding must remain
  // idempotent and must not create a Session-shaped WorkItem.
  const replay = await canonicalBinding.recoverWorkflowRunCanonicalBindings(
    await snapshotStore.listTaskSnapshots(canonicalRunRoot),
    canonicalRunRoot
  )
  assertDeepEqual(replay.failures, [], 'canonical Run recovery must have no binding failures')
  assertEqual(replay.existing.length, 2, 'canonical Run recovery must reuse both existing bindings')

  const persisted = await store.getWorkItem(workItem.id)
  assert(persisted, 'canonical WorkItem must remain readable after Run binding')
  assertDeepEqual(
    [...persisted.runRefs].sort(),
    ['canonical-run-1', 'canonical-run-2'],
    'one canonical WorkItem must retain both Session Run refs exactly once'
  )
  const canonicalItems = await store.listWorkItems(workspace.id)
  assertEqual(canonicalItems.length, 2, 'Run ingress must not create a ProjectWorkspace WorkItem')
  assert(
    !canonicalItems.some((item) => item.id.startsWith('work-item:dag:') || item.id.startsWith('work-item:legacy:')),
    'canonical Session Runs must not create a derived WorkItem identity'
  )
  const ledger = await workflowApi.listPersistedWorkflowLedger({ projectId: workspace.id }, canonicalRunRoot)
  assertEqual(ledger.workItems.total, 2, 'canonical Ledger must retain only the two seeded WorkItems')
  assertEqual(ledger.runs.total, 2, 'canonical Ledger must expose both Session Runs')
  const ledgerItem = ledger.workItems.items.find((item) => item.id === workItem.id)
  assert(ledgerItem, 'canonical Ledger must retain the shared WorkItem')
  assertDeepEqual(
    [...ledgerItem.runIds].sort(),
    ['canonical-run-1', 'canonical-run-2'],
    'canonical Ledger WorkItem must map both Run refs'
  )

  await assertRejects(
    canonicalBinding.bindWorkflowRunToCanonicalWorkItem(
      { ...firstMeta, workItemId: otherWorkItem.id }, firstRun, canonicalRunRoot
    ),
    (error) => error?.code === 'run_reference_conflict' || /already claimed by WorkItem/.test(String(error)),
    'a Run already attached to one WorkItem must not be attached to another'
  )
  assertDeepEqual(
    (await store.getWorkItem(otherWorkItem.id)).runRefs,
    [],
    'failed cross-WorkItem Run binding must leave the target WorkItem unchanged'
  )
  await assertRejects(
    store.createWorkItem({
      id: 'canonical-run-conflicting-create',
      projectId: workspace.id,
      goalId: goal.id,
      title: 'Conflicting Run owner',
      runRefs: ['canonical-run-1']
    }),
    (error) => error?.code === 'run_reference_conflict' || /already claimed by WorkItem/.test(String(error)),
    'creating a second WorkItem for an existing Run must fail closed'
  )
}

function buildSnapshot(snapshotStore, run, ownership, now) {
  return snapshotStore.buildTaskSnapshot({
    meta: buildMeta(run.sessionId, {
      ...ownership,
      childTaskId: ownership.childTaskId ?? run.taskId
    }),
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run,
    now
  })
}

function buildMeta(id, ownership) {
  return {
    id,
    title: `Ownership ${id}`,
    cwd: userData,
    model: 'fixture-model',
    providerId: 'fixture-provider',
    permissionMode: 'default',
    status: 'running',
    sdkSessionId: `sdk-${id}`,
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt: 1,
    ...ownership
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

function ledgerState(ledger) {
  return JSON.stringify({
    workItems: ledger.workItems.items.map((item) => ({
      id: item.id,
      projectId: item.projectId,
      goalId: item.goalId,
      runIds: item.runIds,
      currentRunId: item.currentRunId,
      revision: item.revision
    })),
    runs: ledger.runs.items.map((run) => ({
      id: run.id,
      projectId: run.projectId,
      goalId: run.goalId,
      workItemId: run.workItemId,
      revision: run.revision
    })),
    eventCount: ledger.events.total
  })
}

function compileSources() {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/session-create-lifecycle.ts',
      'src/main/session-domain-activation.ts',
      'src/main/task/task-snapshot-recovery-lifecycle.ts',
      'src/main/task/task-snapshot.ts',
      'src/main/task/workflow-ledger-api.ts',
      'src/main/task/workflow-ledger-readiness-parity.ts',
      'src/main/task/workflow-run-canonical-binding.ts',
      '--outDir', outDir,
      '--target', 'ES2022',
      '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext',
      '--types', 'node',
      '--skipLibCheck',
      '--esModuleInterop'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )
}

function installElectronStub() {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), [
    `export const app = { getPath: () => ${JSON.stringify(userData)} }`,
    'export const safeStorage = {',
    '  isEncryptionAvailable: () => false,',
    "  encryptString: (value) => Buffer.from(String(value), 'utf8'),",
    "  decryptString: (value) => Buffer.from(value).toString('utf8')",
    '}',
    'export const powerSaveBlocker = { start: () => 1, stop: () => undefined, isStarted: () => false }'
  ].join('\n'))
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

function findCompiledModule(root, name) {
  const found = findCompiledModuleOptional(root, name)
  if (found) return found
  throw new Error(`compiled ${name} not found under ${root}`)
}

function findCompiledModuleOptional(root, name) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledModuleOptional(fullPath, name)
      if (found) return found
    } else if (entry.isFile() && entry.name === name) {
      return fullPath
    }
  }
  return undefined
}

function findCompiledModuleBySuffix(root, suffix) {
  const normalizedSuffix = path.normalize(suffix)
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        const found = visit(fullPath)
        if (found) return found
      } else if (entry.isFile() && path.normalize(fullPath).endsWith(normalizedSuffix)) {
        return fullPath
      }
    }
    return undefined
  }
  const found = visit(root)
  if (found) return found
  throw new Error(`compiled *${suffix} not found under ${root}`)
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

function assertThrows(action, pattern, message) {
  try {
    action()
  } catch (error) {
    if (pattern.test(String(error))) return
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

function assertDeepEqual(actual, expected, message) {
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), message)
}
