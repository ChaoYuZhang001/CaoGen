import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-workflow-ledger-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
const multiRunBackfillRoot = path.join(tempRoot, 'multi-run-backfill')
mkdirSync(userData, { recursive: true })

try {
  compileSources()
  installElectronStub()
  const snapshotStore = await import(pathToFileURL(findCompiledModule(outDir, 'task-snapshot.js')).href)
  const workflowApi = await import(pathToFileURL(findCompiledModule(outDir, 'workflow-ledger-api.js')).href)
  const workflowStore = await import(pathToFileURL(findCompiledModule(outDir, 'workflow-ledger-store.js')).href)
  const workflowProjection = await import(pathToFileURL(findCompiledModule(outDir, 'workflow-ledger-projection.js')).href)
  const evidenceProjection = await import(pathToFileURL(findCompiledModule(outDir, 'workflow-ledger-evidence-projection.js')).href)
  const workflowEvidenceCoverage = await import(
    pathToFileURL(findCompiledModule(outDir, 'workflow-evidence-event-coverage.js')).href
  )

  const snapshot = snapshotStore.buildTaskSnapshot({
    meta: buildMeta('session-1', 'project-1', { childTaskId: 'task-1' }),
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run: buildRun('run-1', 'session-1', 'task-1', 1, 100)
  })
  await snapshotStore.saveTaskSnapshot(snapshot, userData)

  let ledger = await workflowApi.listPersistedWorkflowLedger({}, userData)
  assertEqual(ledger.workItems.total, 1, 'first TaskRun must create one WorkItem')
  assertEqual(ledger.runs.total, 1, 'first TaskRun must create one WorkflowRun')
  assert(ledger.events.total >= 2, 'projection must append WorkItem and Run events')
  assertEqual((await workflowApi.verifyPersistedWorkflowLedger(userData)).valid, true, 'fresh ledger must verify')

  const effectEvidence = await workflowApi.listPersistedWorkflowLedger({
    runId: 'run-1',
    eventKind: 'workflow.effect.evidence'
  }, userData)
  assertEqual(effectEvidence.events.total, 1, 'Task evidence must project into one queryable workflow event')
  const effectEvidenceEvent = effectEvidence.events.items[0]
  assertEqual(effectEvidenceEvent.entityType, 'run', 'Task evidence event must be owned by its WorkflowRun')
  assertEqual(effectEvidenceEvent.entityId, 'run-1', 'Task evidence event must point at the source Run')
  assertEqual(effectEvidenceEvent.payload.evidenceId, 'evidence-run-1', 'Task evidence event must preserve evidence identity')
  for (const forbidden of ['input', 'output', 'toolInput', 'toolOutput', 'content']) {
    assert(!(forbidden in effectEvidenceEvent.payload), `Task evidence event must not expose raw ${forbidden}`)
  }
  const firstOpenEventCount = ledger.events.total
  await snapshotStore.saveTaskSnapshot(snapshot, userData)
  ledger = await workflowApi.listPersistedWorkflowLedger({}, userData)
  assertEqual(ledger.events.total, firstOpenEventCount, 'repeated save/open must not duplicate workflow events')
  assertEqual(
    (await workflowApi.listPersistedWorkflowLedger({}, userData)).events.total,
    firstOpenEventCount,
    'read-only reopen must keep the event count stable'
  )

  const multiRunSessionId = 'session-multi-run-backfill'
  const firstHistoricalRun = buildRun('run-multi-first', multiRunSessionId, multiRunSessionId, 1, 100)
  const firstHistoricalSnapshot = snapshotStore.buildTaskSnapshot({
    meta: buildMeta(multiRunSessionId, 'project-multi-run'),
    transcript: [],
    lastSeq: 4,
    lastEventId: 'multi-run-event-4',
    eventCount: 4,
    reason: 'important-event',
    run: firstHistoricalRun,
    now: 100
  })
  await snapshotStore.saveTaskSnapshot(firstHistoricalSnapshot, multiRunBackfillRoot)
  const currentRun = buildRun('run-multi-current', multiRunSessionId, multiRunSessionId, 1, 200)
  const currentSnapshot = snapshotStore.buildTaskSnapshot({
    meta: buildMeta(multiRunSessionId, 'project-multi-run'),
    transcript: [],
    lastSeq: 5,
    lastEventId: 'multi-run-event-5',
    eventCount: 5,
    reason: 'important-event',
    run: currentRun,
    now: 200
  })
  await snapshotStore.saveTaskSnapshot(currentSnapshot, multiRunBackfillRoot)
  await snapshotStore.mutateTaskSnapshotDatabase(multiRunBackfillRoot, (db) => {
    db.run('DELETE FROM workflow_events')
    db.run('DELETE FROM workflow_runs')
    db.run('DELETE FROM workflow_work_items')
    db.run('DELETE FROM workflow_goals')
    assertEqual(
      workflowProjection.backfillWorkflowLedger(
        db,
        [firstHistoricalRun, currentRun],
        [currentSnapshot]
      ),
      true,
      'multi-run rebuild must project historical and current Runs without sharing the current Snapshot'
    )
    evidenceProjection.projectTaskEvidenceIntoWorkflow(db)
  })
  const rebuiltMultiRunLedger = await workflowApi.listPersistedWorkflowLedger({}, multiRunBackfillRoot)
  assertEqual(rebuiltMultiRunLedger.runs.total, 2, 'multi-run reopen must retain both historical Runs')
  assertEqual(
    rebuiltMultiRunLedger.workItems.items[0].currentRunId,
    currentRun.id,
    'multi-run reopen must keep the current Snapshot Run as the WorkItem owner'
  )
  assertEqual(
    (await workflowApi.verifyPersistedWorkflowLedger(multiRunBackfillRoot)).valid,
    true,
    'rebuilt multi-run ledger must verify after reopen'
  )
  await assertRejects(
    snapshotStore.mutateTaskSnapshotDatabase(userData, (db) => {
      db.run('DELETE FROM workflow_runs WHERE id = ?', ['run-1'])
      return evidenceProjection.projectTaskEvidenceIntoWorkflow(db, { runId: 'run-1' })
    }),
    (error) => String(error).includes('references missing Workflow Run run-1'),
    'Task evidence projection must fail closed for an orphaned Run'
  )
  await assertRejects(
    snapshotStore.mutateTaskSnapshotDatabase(userData, (db) => {
      db.run('DELETE FROM workflow_runs WHERE id = ?', ['run-1'])
      return workflowStore.verifyWorkflowLedger(db)
    }),
    (error) => String(error).includes('references missing run'),
    'deleting a Run referenced by workflow events must fail ledger verification'
  )
  await assertRejects(
    snapshotStore.mutateTaskSnapshotDatabase(userData, (db) => {
      db.run('DELETE FROM task_evidence WHERE evidence_id = ?', ['evidence-run-1'])
      return workflowStore.verifyWorkflowLedger(db)
    }),
    (error) => String(error).includes('references missing Task evidence evidence-run-1'),
    'workflow evidence event must fail closed when its Task evidence source is deleted'
  )
  await assertRejects(
    snapshotStore.mutateTaskSnapshotDatabase(userData, (db) => {
      db.run('DELETE FROM workflow_events WHERE event_id = ?', ['workflow:evidence:evidence-run-1'])
      return workflowStore.verifyWorkflowLedger(db)
    }),
    (error) => String(error).includes('Task evidence evidence-run-1 has no Workflow event'),
    'Task evidence source must fail closed when its Workflow event is deleted'
  )

  const updatedRun = buildRun('run-1', 'session-1', 'task-1', 2, 200)
  await snapshotStore.saveTaskRunBarrier(updatedRun, userData)
  ledger = await workflowApi.listPersistedWorkflowLedger({}, userData)
  assertEqual(ledger.workItems.total, 1, 'revision update must not create a second WorkItem')
  assertEqual(ledger.runs.total, 1, 'revision update must not create a second Run')
  assert(ledger.events.total >= 4, 'revision update must append projection events')

  const runProjection = ledger.runs.items.find((item) => item.id === 'run-1')
  assert(runProjection, 'run-1 projection must be queryable')
  const artifact = await workflowApi.createWorkflowArtifact({
    id: 'artifact-run-1',
    projectId: 'project-1',
    workItemId: runProjection.workItemId,
    runId: runProjection.id,
    kind: 'test_report',
    title: 'Workflow ledger smoke report',
    digest: 'sha256:workflow-ledger-smoke'
  }, userData)
  const pendingAcceptance = await workflowApi.saveWorkflowAcceptance({
    id: 'acceptance-run-1',
    projectId: 'project-1',
    workItemId: runProjection.workItemId,
    criteria: ['Workflow projection and event chain verify'],
    status: 'pending'
  }, userData)
  const workItemBeforeAcceptance = (await workflowApi.listPersistedWorkflowLedger({
    workItemId: runProjection.workItemId
  }, userData)).workItems.items[0]
  const verifyingItem = await workflowApi.transitionWorkflowWorkItem(
    workItemBeforeAcceptance.id,
    'verifying',
    workItemBeforeAcceptance.revision,
    userData
  )
  await assertRejects(
    workflowApi.transitionWorkflowWorkItem(verifyingItem.id, 'done', verifyingItem.revision, userData),
    (error) => String(error).includes('without passed or waived Acceptance'),
    'WorkItem done must fail without Acceptance'
  )
  const link = await workflowApi.createWorkflowEvidenceLink({
    id: 'link-run-1',
    evidenceId: 'evidence-run-1',
    projectId: 'project-1',
    runId: runProjection.id,
    artifactId: artifact.id,
    acceptanceId: pendingAcceptance.id,
    relation: 'verifies'
  }, userData)
  const verifyingAcceptance = await workflowApi.saveWorkflowAcceptance({
    ...pendingAcceptance,
    status: 'verifying',
    evidenceRefs: [link.evidenceId],
    revision: pendingAcceptance.revision + 1,
    updatedAt: 500
  }, userData)
  const passedAcceptance = await workflowApi.saveWorkflowAcceptance({
    ...verifyingAcceptance,
    status: 'passed',
    verifier: 'workflow-ledger-smoke',
    verifiedAt: 600,
    revision: verifyingAcceptance.revision + 1,
    updatedAt: 600
  }, userData)
  assertEqual(passedAcceptance.status, 'passed', 'Acceptance must persist evidence-backed pass')
  const doneItem = await workflowApi.transitionWorkflowWorkItem(
    verifyingItem.id,
    'done',
    verifyingItem.revision,
    userData
  )
  assertEqual(doneItem.status, 'done', 'evidence-backed WorkItem may become done')
  ledger = await workflowApi.listPersistedWorkflowLedger({ workItemId: runProjection.workItemId }, userData)
  assertEqual(ledger.artifacts.total, 1, 'Artifact must be queryable through the WorkItem scope')
  assertEqual(ledger.acceptances.total, 1, 'Acceptance must be queryable through the WorkItem scope')
  assertEqual(ledger.evidenceLinks.total, 1, 'Evidence link must be queryable')

  const retrySnapshot = snapshotStore.buildTaskSnapshot({
    meta: buildMeta('session-retry', 'project-1', {
      orchestrationId: 'dag-1',
      childTaskId: 'task-dag',
      childRole: 'testing'
    }),
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run: buildRun('run-dag-1', 'session-retry', 'task-dag', 1, 300)
  })
  await snapshotStore.saveTaskSnapshot(retrySnapshot, userData)
  const retryRun = buildRun('run-dag-2', 'session-retry-2', 'task-dag', 1, 400)
  const retryMeta = buildMeta('session-retry-2', 'project-1', {
    orchestrationId: 'dag-1',
    childTaskId: 'task-dag',
    childRole: 'testing'
  })
  await snapshotStore.saveTaskSnapshot(snapshotStore.buildTaskSnapshot({
    meta: retryMeta,
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run: retryRun
  }), userData)
  ledger = await workflowApi.listPersistedWorkflowLedger({ projectId: 'project-1' }, userData)
  const dagItems = ledger.workItems.items.filter((item) => item.id === 'work-item:dag:dag-1:task-dag')
  assertEqual(dagItems.length, 1, 'DAG retries must share a stable WorkItem')
  assertEqual(dagItems[0].runIds.length, 2, 'DAG retries must retain both Run IDs')
  await assertRejects(
    workflowApi.createWorkflowEvidenceLink({
      id: 'link-cross-run',
      evidenceId: link.evidenceId,
      projectId: 'project-1',
      runId: 'run-dag-1',
      artifactId: artifact.id,
      acceptanceId: pendingAcceptance.id,
      relation: 'verifies'
    }, userData),
    (error) => String(error).includes('run ownership differs from Task evidence'),
    'Evidence Link must not borrow Task evidence from a different Run'
  )
  await assertRejects(
    workflowApi.createWorkflowEvidenceLink({
      id: 'link-cross-project',
      evidenceId: link.evidenceId,
      projectId: 'project-2',
      runId: runProjection.id,
      artifactId: artifact.id,
      acceptanceId: pendingAcceptance.id,
      relation: 'verifies'
    }, userData),
    (error) => String(error).includes('project ownership differs') || String(error).includes('project boundary'),
    'Evidence Link must not borrow Task evidence across project ownership'
  )

  const goal = await workflowApi.createWorkflowGoal({
    id: 'goal-1',
    projectId: 'project-1',
    title: 'Ship ledger',
    objective: 'Preserve a verifiable workflow chain'
  }, userData)
  assertEqual(goal.status, 'draft', 'explicit Goal starts in draft')
  const explicitItem = await workflowApi.createWorkflowWorkItem({
    id: 'work-explicit',
    projectId: 'project-1',
    goalId: goal.id,
    title: 'Verify projection',
    type: 'testing',
    status: 'backlog'
  }, userData)
  const transitioned = await workflowApi.transitionWorkflowWorkItem(
    explicitItem.id,
    'ready',
    explicitItem.revision,
    userData
  )
  assertEqual(transitioned.status, 'ready', 'WorkItem transition must persist')
  await assertRejects(
    workflowApi.transitionWorkflowWorkItem(explicitItem.id, 'running', explicitItem.revision, userData),
    (error) => String(error).includes('stale_revision'),
    'stale WorkItem transition must fail closed'
  )
  await assertRejects(
    workflowApi.createWorkflowWorkItem({
      id: 'cross-project-item',
      projectId: 'project-2',
      goalId: goal.id,
      title: 'Cross project',
      type: 'custom'
    }, userData),
    (error) => String(error).includes('project boundary'),
    'cross-project Goal link must fail closed'
  )
  await assertRejects(
    workflowApi.createWorkflowGoal({
      id: 'goal-invalid-status',
      projectId: 'project-1',
      title: 'Invalid goal',
      objective: 'Must not persist',
      status: 'not-a-status'
    }, userData),
    (error) => String(error).includes('goal status is invalid'),
    'invalid Goal status must fail before persistence'
  )

  const evidenceEnvelopeRun = buildRun(
    'run-workflow-evidence-envelope',
    'session-workflow-evidence-envelope',
    'task-workflow-evidence-envelope',
    1,
    Date.now()
  )
  await snapshotStore.mutateTaskSnapshotDatabase(userData, (db) => workflowStore.projectTaskRun(
    db,
    evidenceEnvelopeRun,
    {
      projectId: 'project-1',
      goalId: goal.id,
      workItemId: explicitItem.id,
      source: 'explicit'
    }
  ))
  const workflowEvidence = await workflowApi.createWorkflowEvidence({
    evidenceId: 'workflow-evidence-envelope',
    projectId: 'project-1',
    goalId: goal.id,
    workItemId: explicitItem.id,
    runId: evidenceEnvelopeRun.id,
    kind: 'test_result',
    title: 'Workflow evidence envelope fixture',
    summary: 'Binds the Workflow event envelope to its immutable evidence record',
    contentDigest: 'e'.repeat(64)
  }, userData)
  const workflowEvidenceLedger = await workflowApi.listPersistedWorkflowLedger({
    runId: evidenceEnvelopeRun.id,
    eventKind: 'workflow.evidence.recorded'
  }, userData)
  const workflowEvidenceEvent = workflowEvidenceLedger.events.items.find(
    (event) => event.eventId === `workflow:evidence-record:${workflowEvidence.evidenceId}`
  )
  assert(workflowEvidenceEvent, 'Workflow evidence event fixture must be queryable')
  workflowEvidenceCoverage.assertWorkflowEvidenceEventCoverage(
    [workflowEvidence],
    [workflowEvidenceEvent]
  )
  for (const [field, tamperedEvent] of [
    ['projectId', withoutField(workflowEvidenceEvent, 'projectId')],
    ['goalId', withoutField(workflowEvidenceEvent, 'goalId')],
    ['workItemId', withoutField(workflowEvidenceEvent, 'workItemId')],
    ['runId', withoutField(workflowEvidenceEvent, 'runId')],
    ['streamId', { ...workflowEvidenceEvent, streamId: `project:${workflowEvidence.projectId}` }],
    ['occurredAt', { ...workflowEvidenceEvent, occurredAt: workflowEvidenceEvent.occurredAt + 1 }],
    ['correlationId', { ...workflowEvidenceEvent, correlationId: 'tampered-correlation' }],
    ['entityType', { ...workflowEvidenceEvent, entityType: 'run' }],
    ['entityId', { ...workflowEvidenceEvent, entityId: 'tampered-evidence-id' }],
    ['kind', { ...workflowEvidenceEvent, kind: 'workflow.evidence.tampered' }],
    ['payload', { ...workflowEvidenceEvent, payload: { ...workflowEvidenceEvent.payload, title: 'tampered' } }]
  ]) {
    expectCoverageCorruption(
      () => workflowEvidenceCoverage.assertWorkflowEvidenceEventCoverage(
        [workflowEvidence],
        [tamperedEvent]
      ),
      `Workflow evidence event ${field} tampering must fail closed`
    )
  }

  const runItemBeforeStale = (await workflowApi.listPersistedWorkflowLedger({
    workItemId: runProjection.workItemId
  }, userData)).workItems.items[0]
  await snapshotStore.mutateTaskSnapshotDatabase(userData, (db) => workflowStore.projectTaskRun(
    db,
    { ...buildRun('run-1', 'session-1', 'task-1', 1, 50), status: 'queued' },
    { projectId: 'project-1', workItemId: runItemBeforeStale.id }
  ))
  const runItemAfterStale = (await workflowApi.listPersistedWorkflowLedger({
    workItemId: runProjection.workItemId
  }, userData)).workItems.items[0]
  assertEqual(runItemAfterStale.revision, runItemBeforeStale.revision, 'stale Run must not change WorkItem revision')
  assertEqual(runItemAfterStale.status, runItemBeforeStale.status, 'stale Run must not regress WorkItem status')

  await assertRejects(
    snapshotStore.mutateTaskSnapshotDatabase(userData, (db) => workflowStore.appendWorkflowEvent(db, {
      eventId: 'workflow:smoke:bad-seq',
      streamId: `goal:${goal.id}`,
      entityType: 'goal',
      entityId: goal.id,
      kind: 'workflow.smoke',
      payload: { goalId: goal.id },
      occurredAt: 700,
      seq: 999
    }, { projectId: 'project-1', goalId: goal.id })),
    (error) => String(error).includes('is not next sequence'),
    'explicit non-contiguous event sequence must fail closed'
  )
  await snapshotStore.mutateTaskSnapshotDatabase(userData, (db) => workflowStore.appendWorkflowEvent(db, {
    eventId: 'workflow:smoke:scope',
    streamId: `goal:${goal.id}`,
    entityType: 'goal',
    entityId: goal.id,
    kind: 'workflow.smoke',
    payload: { goalId: goal.id },
    occurredAt: 701
  }, { projectId: 'project-1', goalId: goal.id }))
  await assertRejects(
    snapshotStore.mutateTaskSnapshotDatabase(userData, (db) => workflowStore.appendWorkflowEvent(db, {
      eventId: 'workflow:smoke:scope',
      streamId: `goal:${goal.id}`,
      entityType: 'goal',
      entityId: goal.id,
      kind: 'workflow.smoke',
      payload: { goalId: goal.id },
      occurredAt: 701
    }, { projectId: 'project-2', goalId: goal.id })),
    (error) => String(error).includes('different immutable content'),
    'event idempotency must include ownership scope'
  )

  await assertRejects(
    snapshotStore.mutateTaskSnapshotDatabase(userData, (db) => workflowStore.appendWorkflowEvent(db, {
      eventId: 'workflow:smoke:dangling-entity',
      streamId: 'run:missing-run',
      entityType: 'run',
      entityId: 'missing-run',
      kind: 'workflow.smoke',
      payload: { runId: 'missing-run' },
      occurredAt: 702
    }, { projectId: 'project-1', runId: 'missing-run' })),
    (error) => String(error).includes('references missing run'),
    'dangling event entity and scope must fail closed before insert'
  )
  await assertRejects(
    snapshotStore.mutateTaskSnapshotDatabase(userData, (db) => workflowStore.appendWorkflowEvent(db, {
      eventId: 'workflow:smoke:entity-scope-conflict',
      streamId: `run:${runProjection.id}`,
      entityType: 'run',
      entityId: runProjection.id,
      kind: 'workflow.smoke',
      payload: { runId: runProjection.id, workItemId: explicitItem.id },
      occurredAt: 703
    }, {
      projectId: 'project-1',
      workItemId: explicitItem.id,
      runId: runProjection.id
    })),
    (error) => String(error).includes('run/work item scope differs') ||
      String(error).includes('run/work item ownership differs') ||
      String(error).includes('payload workItemId'),
    'event entity, scope, and payload ownership must agree'
  )

  const danglingGoal = await workflowApi.createWorkflowGoal({
    id: 'goal-history-dangling',
    projectId: 'project-1',
    title: 'Historical dangling probe',
    objective: 'Must be rejected when its projection disappears'
  }, userData)
  let deletedGoalRow
  await mutateDatabaseFile(snapshotStore.taskSnapshotsDbFile(userData), (db) => {
    const result = db.exec(
      'SELECT id, project_id, status, revision, updated_at, payload FROM workflow_goals WHERE id = ?',
      [danglingGoal.id]
    )
    deletedGoalRow = result[0]?.values[0]
    db.run('DELETE FROM workflow_goals WHERE id = ?', [danglingGoal.id])
  })
  await assertRejects(
    workflowApi.verifyPersistedWorkflowLedger(userData),
    (error) => String(error).includes('references missing goal'),
    'historical event must fail closed when its entity projection is deleted'
  )
  await mutateDatabaseFile(snapshotStore.taskSnapshotsDbFile(userData), (db) => {
    assert(Array.isArray(deletedGoalRow) && deletedGoalRow.length === 6, 'tamper probe must capture Goal row')
    db.run(
      'INSERT INTO workflow_goals(id, project_id, status, revision, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?)',
      deletedGoalRow
    )
  })

  const orphanRun = buildRun('workflow-orphan-run', 'workflow-orphan-session', 'workflow-orphan-task', 1, 710)
  await snapshotStore.mutateTaskSnapshotDatabase(userData, (db) => insertWorkflowRunRow(
    db,
    orphanRun,
    'workflow-orphan-item',
    'project-1'
  ))
  const orphanRunNewer = buildRun('workflow-orphan-run', 'workflow-orphan-session', 'workflow-orphan-task', 2, 711)
  await snapshotStore.mutateTaskSnapshotDatabase(userData, (db) => workflowStore.projectTaskRun(
    db,
    orphanRunNewer,
    {}
  ))
  const orphanRunLedger = await workflowApi.listPersistedWorkflowLedger({ runId: orphanRun.id }, userData)
  assertEqual(orphanRunLedger.runs.total, 1, 'orphan Run recovery must keep one Run projection')
  assertEqual(orphanRunLedger.runs.items[0].workItemId, 'workflow-orphan-item', 'orphan Run recovery must retain persisted WorkItem ownership')
  assertEqual(
    (await workflowApi.listPersistedWorkflowLedger({ workItemId: 'workflow-orphan-item' }, userData)).workItems.total,
    1,
    'orphan Run recovery must rebuild its missing WorkItem'
  )

  // A partially committed projection can leave a newer WorkflowRun row without
  // its WorkItem. An older TaskRun must recover ownership from the persisted
  // Run payload instead of being discarded as stale.
  const persistedRecoveryRun = buildRun(
    'workflow-persisted-newer-run',
    'workflow-persisted-newer-session',
    'workflow-persisted-newer-task',
    4,
    714
  )
  const staleRecoveryRun = buildRun(
    'workflow-persisted-newer-run',
    'workflow-persisted-newer-session',
    'workflow-persisted-newer-task',
    1,
    715
  )
  await snapshotStore.mutateTaskSnapshotDatabase(userData, (db) => insertWorkflowRunRow(
    db,
    persistedRecoveryRun,
    'workflow-persisted-recovery-item',
    'project-1'
  ))
  await snapshotStore.mutateTaskSnapshotDatabase(userData, (db) => workflowStore.projectTaskRun(
    db,
    staleRecoveryRun,
    {}
  ))
  const recoveredItemId = 'workflow-persisted-recovery-item'
  await snapshotStore.mutateTaskSnapshotDatabase(userData, (db) => workflowStore.appendWorkflowEvent(db, {
    eventId: `workflow:run:${persistedRecoveryRun.id}:revision:${persistedRecoveryRun.revision}:updated:${persistedRecoveryRun.updatedAt}`,
    streamId: `work-item:${recoveredItemId}`,
    entityType: 'run',
    entityId: persistedRecoveryRun.id,
    kind: 'run.recovered',
    payload: {
      runId: persistedRecoveryRun.id,
      workItemId: recoveredItemId,
      taskId: persistedRecoveryRun.taskId,
      status: persistedRecoveryRun.status,
      revision: persistedRecoveryRun.revision,
      attempt: persistedRecoveryRun.attempt
    },
    occurredAt: persistedRecoveryRun.updatedAt,
    correlationId: persistedRecoveryRun.sessionId
  }, {
    projectId: 'project-1',
    workItemId: recoveredItemId,
    runId: persistedRecoveryRun.id,
    sessionId: persistedRecoveryRun.sessionId
  }))
  const recoveredItem = (await workflowApi.listPersistedWorkflowLedger({
    workItemId: recoveredItemId
  }, userData)).workItems.items[0]
  assert(recoveredItem, 'persisted newer Run must rebuild its missing WorkItem')
  assertEqual(recoveredItem.projectId, 'project-1', 'recovered WorkItem must retain persisted Run project ownership')
  assertEqual(recoveredItem.revision, persistedRecoveryRun.revision, 'recovered WorkItem must retain newer Run revision')
  assertEqual(recoveredItem.status, 'running', 'recovered WorkItem status must derive from persisted Run status')
  assertEqual(recoveredItem.currentRunId, persistedRecoveryRun.id, 'recovered WorkItem must point at persisted current Run')
  assertEqual(recoveredItem.runIds.length, 1, 'recovered WorkItem must contain only the persisted Run ID')
  assertEqual(recoveredItem.runIds[0], persistedRecoveryRun.id, 'recovered WorkItem must retain persisted Run ownership')

  const newerRun = buildRun('workflow-newer-run', 'workflow-newer-session', 'workflow-newer-task', 3, 720)
  const olderRun = buildRun('workflow-older-run', 'workflow-older-session', 'workflow-older-task', 1, 721)
  await snapshotStore.mutateTaskSnapshotDatabase(userData, (db) => {
    workflowStore.projectTaskRun(db, newerRun, {
      projectId: 'project-1',
      workItemId: 'workflow-newer-item',
      workItemTitle: 'Newer run owner',
      source: 'recovery'
    })
    const current = workflowStore.findWorkflowWorkItem(db, 'workflow-newer-item')
    assert(current, 'newer WorkItem fixture must be projected')
    workflowStore.projectWorkItem(db, {
      ...current,
      runIds: [newerRun.id, olderRun.id],
      revision: current.revision + 1,
      updatedAt: 722
    })
  })
  await snapshotStore.mutateTaskSnapshotDatabase(userData, (db) => workflowStore.projectTaskRun(
    db,
    olderRun,
    {}
  ))
  const newerItem = (await workflowApi.listPersistedWorkflowLedger({ workItemId: 'workflow-newer-item' }, userData)).workItems.items[0]
  assertEqual(newerItem.currentRunId, newerRun.id, 'older Run backfill must not take over newer WorkItem currentRun')
  assertEqual(newerItem.revision, 4, 'older Run backfill must not regress WorkItem revision')
  assertEqual((await workflowApi.verifyPersistedWorkflowLedger(userData)).valid, true, 'recovered orphan/newer boundaries must verify')

  const page = await workflowApi.listPersistedWorkflowLedger({ limit: 1 }, userData)
  assertEqual(page.workItems.items.length, 1, 'ledger query must honor page size')
  assert(page.workItems.hasMore, 'ledger query must return a cursor for remaining items')
  const secondPage = await workflowApi.listPersistedWorkflowLedger({ limit: 1, cursor: page.workItems.nextCursor }, userData)
  assert(secondPage.workItems.items.length >= 1, 'ledger cursor must advance')

  await snapshotStore.deleteTaskSnapshot('session-1', userData)
  ledger = await workflowApi.listPersistedWorkflowLedger({ runId: 'run-1' }, userData)
  assertEqual(ledger.runs.total, 1, 'deleting a snapshot must retain WorkflowRun projection')
  assertEqual((await workflowApi.verifyPersistedWorkflowLedger(userData)).valid, true, 'ledger remains valid after snapshot deletion')

  await mutateDatabaseFile(snapshotStore.taskSnapshotsDbFile(userData), (db) => {
    db.run("UPDATE workflow_work_items SET project_id = 'tampered-project' WHERE id = ?", [runProjection.workItemId])
  })
  await assertRejects(
    workflowApi.verifyPersistedWorkflowLedger(userData),
    (error) => String(error).includes('payload does not match project_id column'),
    'SQL metadata tampering must fail closed'
  )
  await mutateDatabaseFile(snapshotStore.taskSnapshotsDbFile(userData), (db) => {
    db.run("UPDATE workflow_work_items SET project_id = 'project-1' WHERE id = ?", [runProjection.workItemId])
  })

  let originalGoalState
  await mutateDatabaseFile(snapshotStore.taskSnapshotsDbFile(userData), (db) => {
    const result = db.exec('SELECT status, payload FROM workflow_goals WHERE id = ?', [goal.id])
    originalGoalState = result[0]?.values[0]
    assert(Array.isArray(originalGoalState) && typeof originalGoalState[1] === 'string', 'Goal tamper fixture must exist')
    const payload = JSON.parse(originalGoalState[1])
    db.run(
      'UPDATE workflow_goals SET status = ?, payload = ? WHERE id = ?',
      ['running', JSON.stringify({ ...payload, status: 'running', title: 'tampered without event' }), goal.id]
    )
  })
  await assertRejects(
    workflowApi.verifyPersistedWorkflowLedger(userData),
    (error) => String(error).includes('projection payload differs from current state'),
    'coordinated projection-column and payload tampering must fail latest-event binding'
  )
  await mutateDatabaseFile(snapshotStore.taskSnapshotsDbFile(userData), (db) => {
    assert(Array.isArray(originalGoalState), 'Goal tamper fixture must be restorable')
    db.run(
      'UPDATE workflow_goals SET status = ?, payload = ? WHERE id = ?',
      [originalGoalState[0], originalGoalState[1], goal.id]
    )
  })

  await tamperEventDigest(snapshotStore.taskSnapshotsDbFile(userData))
  await assertRejects(
    workflowApi.verifyPersistedWorkflowLedger(userData),
    (error) => String(error).includes('Workflow ledger corruption'),
    'tampered workflow event must fail closed'
  )
  console.log('workflow ledger smoke: PASS')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function compileSources() {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/task/task-snapshot.ts',
      'src/main/task/workflow-ledger-api.ts',
      'src/main/task/workflow-ledger-store.ts',
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
  writeFileSync(path.join(electronDir, 'index.js'), `export const app = { getPath: () => ${JSON.stringify(userData)} }\n`)
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

function findCompiledModule(root, name) {
  const modulePath = path.join(root, 'main', 'task', name)
  if (!require('node:fs').existsSync(modulePath)) throw new Error(`compiled ${name} not found at ${modulePath}`)
  return modulePath
}

function buildMeta(id, projectId, extra = {}) {
  return {
    id,
    title: `Workflow ${id}`,
    cwd: userData,
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
    effects: [{
      schemaVersion: 1,
      id: `effect-${id}`,
      effectKey: `effect-key-${id}`,
      resourceKey: `resource-key-${id}`,
      sessionId,
      runId: id,
      toolUseId: `tool-${id}`,
      toolName: 'fixture_tool',
      generation: 1,
      revision,
      status: 'confirmed',
      reconcilability: 'queryable',
      target: { kind: 'unsupported', toolName: 'fixture_tool' },
      targetDigest: `target-${id}`,
      intentDigest: `intent-${id}`,
      inputDigest: `input-${id}`,
      evidence: [{
        id: `evidence-${id}`,
        kind: 'execution_result',
        digest: `evidence-digest-${id}`,
        observedAt: 1,
        verifier: 'workflow-ledger-smoke',
        generation: 1
      }],
      createdAt: 1,
      updatedAt
    }]
  }
}

async function tamperEventDigest(dbPath) {
  return mutateDatabaseFile(dbPath, (db) => {
    db.run("UPDATE workflow_events SET record_digest = 'tampered' WHERE seq = 1")
  })
}

function insertWorkflowRunRow(db, run, workItemId, projectId) {
  const payload = {
    schemaVersion: 1,
    id: run.id,
    projectId,
    workItemId,
    sessionId: run.sessionId,
    taskId: run.taskId,
    status: run.status,
    revision: run.revision,
    attempt: run.attempt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    ...(run.error === undefined ? {} : { error: run.error }),
    taskRun: run
  }
  db.run(
    `INSERT INTO workflow_runs(
       id, project_id, goal_id, work_item_id, session_id, task_id,
       status, revision, attempt, updated_at, payload
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      run.id,
      projectId,
      null,
      workItemId,
      run.sessionId,
      run.taskId,
      run.status,
      run.revision,
      run.attempt,
      run.updatedAt,
      JSON.stringify(payload)
    ]
  )
}

async function mutateDatabaseFile(dbPath, mutator) {
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs({ locateFile: (file) => file.endsWith('.wasm') ? require.resolve('sql.js/dist/sql-wasm.wasm') : file })
  const db = new SQL.Database(readFileSync(dbPath))
  try {
    mutator(db)
    writeFileSync(dbPath, db.export())
  } finally {
    db.close()
  }
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

function withoutField(record, field) {
  const copy = { ...record }
  delete copy[field]
  return copy
}

function expectCoverageCorruption(operation, message) {
  try {
    operation()
  } catch (error) {
    if (error?.code === 'WORKFLOW_LEDGER_CORRUPTION') return
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
