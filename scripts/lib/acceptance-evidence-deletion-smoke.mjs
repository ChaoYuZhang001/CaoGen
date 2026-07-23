import { mkdirSync } from 'node:fs'
import path from 'node:path'

const DELETION_SCENARIOS = [
  {
    name: 'workflow-evidence-row',
    evidenceOrigin: 'workflow',
    expectedReason: 'workflow_evidence_missing',
    rowKey: 'evidenceId',
    countSql: 'SELECT COUNT(*) FROM workflow_evidence WHERE evidence_id = ?',
    deleteSql: 'DELETE FROM workflow_evidence WHERE evidence_id = ?'
  },
  {
    name: 'task-evidence-row',
    expectedReason: 'task_evidence_missing',
    rowKey: 'evidenceId',
    countSql: 'SELECT COUNT(*) FROM task_evidence WHERE evidence_id = ?',
    deleteSql: 'DELETE FROM task_evidence WHERE evidence_id = ?'
  },
  {
    name: 'workflow-evidence-link-row',
    evidenceOrigin: 'workflow',
    expectedReason: 'evidence_link_missing',
    rowKey: 'linkId',
    countSql: 'SELECT COUNT(*) FROM workflow_evidence_links WHERE id = ?',
    deleteSql: 'DELETE FROM workflow_evidence_links WHERE id = ?'
  }
]

export async function assertDeletedEvidenceRowsFailClosed(input) {
  for (const scenario of DELETION_SCENARIOS) {
    await runDeletionScenario(input, scenario)
  }
}

async function runDeletionScenario(input, scenario) {
  const fixture = await createProjectFixture(input, scenario)
  await seedEvidence(input, scenario, fixture)
  const item = await passAcceptance(input.api, scenario, fixture)
  await deleteFixtureRow(input.snapshotStore, scenario, fixture)
  await assertTerminalFailure(scenario, fixture, item)
}

async function createProjectFixture(input, scenario) {
  const root = path.join(input.tempRoot, `deleted-acceptance-${scenario.name}`)
  const projectId = `project-deleted-${scenario.name}`
  const workItemId = `work-deleted-${scenario.name}`
  const runId = `run-deleted-${scenario.name}`
  const fixture = {
    root,
    projectId,
    workItemId,
    runId,
    acceptanceId: `acceptance-deleted-${scenario.name}`,
    evidenceId: scenario.evidenceOrigin === 'workflow'
      ? `workflow-evidence-deleted-${scenario.name}`
      : `evidence-${runId}`,
    linkId: `link-deleted-${scenario.name}`
  }
  mkdirSync(root, { recursive: true })
  fixture.store = new input.projectStoreApi.ProjectWorkspaceStore(root)
  await fixture.store.open()
  await fixture.store.createWorkspace({
    id: projectId,
    name: `Deleted evidence ${scenario.name}`,
    kind: 'software'
  })
  fixture.commands = input.projectCommandApi.createProjectWorkspaceCommandService(
    fixture.store,
    { rootDir: root }
  )
  fixture.item = await fixture.commands.createWorkItem({
    id: workItemId,
    projectId,
    title: `Fail closed after deleting ${scenario.name}`,
    status: 'verifying'
  })
  return fixture
}

async function seedEvidence(input, scenario, fixture) {
  if (scenario.evidenceOrigin === 'workflow') {
    await seedWorkflowEvidence(input.api, scenario, fixture)
    return
  }
  await seedTaskEvidence(input, scenario, fixture)
}

async function seedWorkflowEvidence(api, scenario, fixture) {
  await api.createWorkflowEvidence({
    evidenceId: fixture.evidenceId,
    projectId: fixture.projectId,
    workItemId: fixture.workItemId,
    kind: 'test_result',
    source: 'runtime',
    title: `Evidence for ${scenario.name}`,
    verifier: 'acceptance-gate-smoke',
    observedAt: 1_100,
    contentDigest: 'e'.repeat(64)
  }, fixture.root)
}

async function seedTaskEvidence(input, scenario, fixture) {
  const sessionId = `session-deleted-${scenario.name}`
  const taskId = `task-deleted-${scenario.name}`
  await input.snapshotStore.saveTaskSnapshot(input.snapshotStore.buildTaskSnapshot({
    meta: input.buildMeta(sessionId, fixture.projectId, {
      cwd: fixture.root,
      workspaceId: fixture.projectId,
      workItemId: fixture.workItemId,
      childTaskId: taskId
    }),
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run: input.buildRun(fixture.runId, sessionId, taskId, 1, 1_100)
  }), fixture.root)
}

async function passAcceptance(api, scenario, fixture) {
  const pending = await api.saveWorkflowAcceptance({
    id: fixture.acceptanceId,
    projectId: fixture.projectId,
    workItemId: fixture.workItemId,
    criteria: [`${scenario.name} remains present through terminal transition`]
  }, fixture.root)
  const link = await api.createWorkflowEvidenceLink({
    id: fixture.linkId,
    evidenceId: fixture.evidenceId,
    ...(scenario.evidenceOrigin ? { evidenceOrigin: scenario.evidenceOrigin } : {}),
    projectId: fixture.projectId,
    ...(scenario.evidenceOrigin ? {} : { runId: fixture.runId }),
    acceptanceId: fixture.acceptanceId,
    relation: 'verifies'
  }, fixture.root)
  const checking = await api.saveWorkflowAcceptance({
    ...pending,
    status: 'verifying',
    evidenceRefs: [link.evidenceId],
    revision: pending.revision + 1,
    updatedAt: 1_200
  }, fixture.root)
  const passed = await api.saveWorkflowAcceptance({
    ...checking,
    status: 'passed',
    verifier: 'acceptance-gate-smoke',
    verifiedAt: 1_300,
    revision: checking.revision + 1,
    updatedAt: 1_300
  }, fixture.root)
  assertEqual(passed.status, 'passed', `${scenario.name} fixture Acceptance must pass before deletion`)
  return fixture.store.setWorkItemAcceptance(fixture.item.id, {
    status: 'passed',
    evidenceRefs: [fixture.evidenceId],
    verifiedBy: 'acceptance-gate-smoke',
    verifiedAt: 1_300
  }, fixture.item.revision)
}

async function deleteFixtureRow(snapshotStore, scenario, fixture) {
  const rowId = fixture[scenario.rowKey]
  const mutation = await snapshotStore.mutateTaskSnapshotDatabase(fixture.root, (db) => {
    const before = countDatabaseRows(db, scenario.countSql, [rowId])
    db.run(scenario.deleteSql, [rowId])
    const after = countDatabaseRows(db, scenario.countSql, [rowId])
    return { before, after }
  })
  assertEqual(mutation.before, 1, `${scenario.name} fixture row must exist before deletion`)
  assertEqual(mutation.after, 0, `${scenario.name} fixture row must be deleted`)
}

async function assertTerminalFailure(scenario, fixture, item) {
  await expectCanonicalEvidenceGate(
    fixture.commands.transitionWorkItem(item.id, 'done', item.revision),
    scenario.expectedReason,
    `${scenario.name} deletion must block canonical ProjectWorkspace done`
  )
  const unchanged = await fixture.store.getWorkItem(item.id)
  assert(unchanged, `${scenario.name} rejected WorkItem must remain readable`)
  assertEqual(unchanged.status, 'verifying', `${scenario.name} rejection must preserve WorkItem status`)
  assertEqual(unchanged.revision, item.revision, `${scenario.name} rejection must preserve WorkItem revision`)
  const readiness = await fixture.commands.getShadowProjectionReadiness()
  assertEqual(readiness?.ready, true, `${scenario.name} preflight rejection must not leave a pending journal`)
}

async function expectCanonicalEvidenceGate(promise, reason, message) {
  try {
    await promise
  } catch (error) {
    assertEqual(error?.code, 'canonical_acceptance_required', `${message} (code)`)
    assertEqual(error?.details?.sourceCommitted, false, `${message} must precede ProjectWorkspace commit`)
    assertEqual(error?.details?.reconciliationRequired, false, `${message} must not require reconciliation`)
    assertEqual(error?.details?.causeCode, 'WORKFLOW_ACCEPTANCE_EVIDENCE_MISSING', `${message} (causeCode)`)
    assertEqual(error?.cause?.code, 'WORKFLOW_ACCEPTANCE_EVIDENCE_MISSING', `${message} (cause code)`)
    assertEqual(error?.cause?.details?.reason, reason, `${message} (reason)`)
    return error
  }
  throw new Error(`${message}: operation unexpectedly succeeded`)
}

function countDatabaseRows(db, sql, parameters) {
  const statement = db.prepare(sql)
  try {
    statement.bind(parameters)
    return statement.step() ? Number(statement.get()[0]) : 0
  } finally {
    statement.free()
  }
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
