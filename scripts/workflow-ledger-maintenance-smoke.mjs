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

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-workflow-ledger-maintenance-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
mkdirSync(userData, { recursive: true })

try {
  compileSources()
  installElectronStub()
  const snapshotStore = await import(pathToFileURL(findCompiledModule(outDir, 'task-snapshot.js')).href)
  const workflowApi = await import(pathToFileURL(findCompiledModule(outDir, 'workflow-ledger-api.js')).href)
  const workflowStore = await import(pathToFileURL(findCompiledModule(outDir, 'workflow-ledger-store.js')).href)

  const run = buildRun('run-maintenance-1', 'session-maintenance-1', 'task-maintenance-1', 1, 100)
  run.error = 'fixture failure retained only as non-sensitive metadata'
  const snapshot = snapshotStore.buildTaskSnapshot({
    meta: { ...buildMeta('session-maintenance-1', 'project-maintenance'), childTaskId: 'task-maintenance-1' },
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run
  })
  await snapshotStore.saveTaskSnapshot(snapshot, userData)
  const ledger = await workflowApi.listPersistedWorkflowLedger({}, userData)
  const workItem = ledger.workItems.items[0]
  assert(workItem, 'TaskRun projection should create a WorkItem')
  await assertRejects(
    workflowApi.createWorkflowArtifact({
      id: 'artifact-maintenance-secret',
      projectId: 'project-maintenance',
      workItemId: workItem.id,
      runId: run.id,
      kind: 'test_report',
      title: 'Rejected secret fixture',
      uri: `https://example.test/report?token=${['sk', '-uri-secret'].join('')}`,
      digest: 'sha256:rejected-secret-fixture',
      metadata: {
        apiKey: ['sk', '-metadata-secret'].join(''),
        nested: { password: ['never', '-export-this'].join('') }
      }
    }, userData),
    (error) => String(error).includes('secret-free write policy'),
    'Artifact write must reject credential-like metadata and URI values'
  )
  const sourceArtifact = await workflowApi.createWorkflowArtifact({
    id: 'artifact-maintenance-source',
    projectId: 'project-maintenance',
    kind: 'source',
    title: 'Maintenance source fixture',
    digest: 'sha256:maintenance-source'
  }, userData)
  await workflowApi.createWorkflowArtifact({
    id: 'artifact-maintenance-1',
    projectId: 'project-maintenance',
    workItemId: workItem.id,
    runId: run.id,
    kind: 'test_report',
    title: 'Maintenance export fixture',
    uri: 'https://example.test/report',
    digest: 'sha256:maintenance-fixture',
    metadata: {
      visible: 'retained for audit',
      source: 'fixture'
    }
  }, userData)
  await workflowApi.createWorkflowArtifactEdge({
    id: 'edge-maintenance-source-report',
    fromArtifactId: sourceArtifact.id,
    toArtifactId: 'artifact-maintenance-1',
    projectId: 'project-maintenance',
    relation: 'derived_from',
    createdAt: 20
  }, userData)
  await workflowApi.createWorkflowArtifactLocation({
    id: 'location-maintenance-report',
    artifactId: 'artifact-maintenance-1',
    projectId: 'project-maintenance',
    kind: 'url',
    uri: 'https://example.test/report',
    createdAt: 21
  }, userData)
  const acceptance = await workflowApi.saveWorkflowAcceptance({
    id: 'acceptance-maintenance-1',
    projectId: 'project-maintenance',
    workItemId: workItem.id,
    criteria: ['Maintenance export closure remains verifiable'],
    status: 'pending'
  }, userData)
  await workflowApi.createWorkflowEvidenceLink({
    id: 'link-maintenance-1',
    evidenceId: 'evidence-run-maintenance-1',
    projectId: 'project-maintenance',
    runId: run.id,
    artifactId: 'artifact-maintenance-1',
    acceptanceId: acceptance.id,
    relation: 'verifies'
  }, userData)
  const workflowEvidence = await workflowApi.createWorkflowEvidence({
    // Deliberately collide with the Task Effect evidence ID. Origin and event
    // kind, rather than a globally unique string, must keep both chains apart.
    evidenceId: 'evidence-run-maintenance-1',
    projectId: 'project-maintenance',
    workItemId: workItem.id,
    runId: run.id,
    artifactId: 'artifact-maintenance-1',
    kind: 'test_result',
    title: 'Maintenance Workflow Evidence fixture',
    contentDigest: 'a'.repeat(64)
  }, userData, {
    source: 'runtime',
    verifier: 'workflow-ledger-maintenance-smoke',
    observedAt: 22,
    createdAt: 22
  })
  await workflowApi.createWorkflowEvidenceLink({
    id: 'link-maintenance-workflow-evidence',
    evidenceId: workflowEvidence.evidenceId,
    evidenceOrigin: 'workflow',
    projectId: 'project-maintenance',
    runId: run.id,
    artifactId: 'artifact-maintenance-1',
    acceptanceId: acceptance.id,
    relation: 'verifies',
    createdAt: 23
  }, userData)

  const otherRun = buildRun('run-maintenance-other', 'session-maintenance-other', 'task-maintenance-other', 1, 110)
  await snapshotStore.saveTaskSnapshot(snapshotStore.buildTaskSnapshot({
    meta: { ...buildMeta('session-maintenance-other', 'project-other'), childTaskId: 'task-maintenance-other' },
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run: otherRun
  }), userData)
  const otherLedger = await workflowApi.listPersistedWorkflowLedger({ runId: otherRun.id }, userData)
  const otherRunProjection = otherLedger.runs.items.find((candidate) => candidate.id === otherRun.id)
  assert(otherRunProjection, 'unrelated project fixture should create a Run projection')
  const otherWorkItem = (await workflowApi.listPersistedWorkflowLedger({
    workItemId: otherRunProjection.workItemId
  }, userData)).workItems.items[0]
  assert(otherWorkItem, 'unrelated project fixture should create a WorkItem')
  await workflowApi.createWorkflowArtifact({
    id: 'artifact-maintenance-other',
    projectId: 'project-other',
    workItemId: otherWorkItem.id,
    runId: otherRun.id,
    kind: 'test_report',
    title: 'Unrelated project report',
    uri: 'https://example.test/other-report',
    digest: 'sha256:maintenance-other'
  }, userData)

  const dbPath = snapshotStore.taskSnapshotsDbFile(userData)
  const beforeExport = readFileSync(dbPath)
  const firstExport = await workflowApi.exportWorkflowLedger({}, userData)
  const afterExport = readFileSync(dbPath)
  assertEqual(Buffer.compare(beforeExport, afterExport), 0, 'export must not rewrite the database')
  assertEqual(firstExport.verification.valid, true, 'export must include a valid verification')
  assertEqual(firstExport.verification.ledger.valid, true, 'Workflow Ledger chain must verify')
  assertEqual(firstExport.verification.taskEvidence.valid, true, 'Task evidence chain must verify')
  assertEqual(firstExport.verification.workflowEvidence.valid, true, 'Workflow evidence chain must verify')
  assertEqual(firstExport.verification.workflowEvidence.count, 1, 'export verification must count Workflow evidence')
  assert(firstExport.verification.artifactGraph?.valid, 'Artifact Graph must verify in export')
  assertEqual(firstExport.verification.artifactGraph?.edges, 1, 'export verification must count Graph edges')
  assertEqual(firstExport.verification.artifactGraph?.locations, 1, 'export verification must count Graph locations')
  assertEqual(firstExport.ledger.artifactEdges?.total, 1, 'export must include Artifact Graph edges')
  assertEqual(firstExport.ledger.artifactLocations?.total, 1, 'export must include Artifact Graph locations')
  assertEqual(firstExport.ledger.taskEvidence.items.length, 2, 'export must include evidence metadata for both Runs')
  assertEqual(firstExport.ledger.workflowEvidence.total, 1, 'export must include general Workflow evidence')
  assert(
    firstExport.ledger.events.items.some((event) =>
      event.kind === 'workflow.effect.evidence' && event.payload.evidenceId === workflowEvidence.evidenceId
    ),
    'export must retain the Task evidence event when evidence IDs collide'
  )
  assert(
    firstExport.ledger.events.items.some((event) =>
      event.kind === 'workflow.evidence.recorded' && event.payload.evidenceId === workflowEvidence.evidenceId
    ),
    'export must retain the Workflow evidence event when evidence IDs collide'
  )
  assert(firstExport.ledger.runs.items[0] && !('taskRun' in firstExport.ledger.runs.items[0]), 'raw TaskRun payload must be omitted')
  assert(firstExport.ledger.runs.items[0]?.taskRunDigest, 'export must bind the omitted TaskRun with a digest')
  assert(firstExport.json.includes('retained for audit'), 'non-sensitive artifact metadata should remain')
  assert(!firstExport.json.includes(['sk', '-metadata-secret'].join('')), 'rejected artifact secret must not be exported')
  assert(!firstExport.json.includes(['never', '-export-this'].join('')), 'rejected nested credential must not be exported')
  assert(!firstExport.json.includes(['sk', '-uri-secret'].join('')), 'rejected URI credential must not be exported')
  const parsed = JSON.parse(firstExport.json)
  assertEqual(parsed.exportDigest, firstExport.exportDigest, 'JSON must carry the export digest')
  assertEqual(parsed.verification.exportDigest, firstExport.exportDigest, 'verification must bind the export digest')

  const secondExport = await workflowApi.exportWorkflowLedger({}, userData)
  assertEqual(secondExport.json, firstExport.json, 'same source must produce byte-stable JSON')
  assertEqual(secondExport.exportDigest, firstExport.exportDigest, 'same source must produce stable digest')
  const scoped = await workflowApi.exportWorkflowLedger({ scope: { projectId: 'project-maintenance' } }, userData)
  assertEqual(scoped.ledger.workItems.total, 1, 'export scope must filter WorkItems')
  assertEqual(scoped.ledger.runs.total, 1, 'project export must exclude unrelated Runs')
  assertEqual(scoped.ledger.artifacts.total, 2, 'project export must exclude unrelated Artifacts')
  assertEqual(scoped.ledger.artifactEdges?.total, 1, 'project export must include Graph edges')
  assertEqual(scoped.ledger.artifactLocations?.total, 1, 'project export must include Graph locations')
  assertEqual(scoped.ledger.taskEvidence.total, 1, 'project export must retain related Task evidence')
  assertEqual(scoped.ledger.workflowEvidence.total, 1, 'project export must retain related Workflow evidence')

  const artifactScoped = await workflowApi.exportWorkflowLedger({
    scope: { artifactId: 'artifact-maintenance-1' }
  }, userData)
  assertEqual(artifactScoped.ledger.artifacts.total, 2, 'artifact scope must include the closed Graph neighborhood')
  assert(
    artifactScoped.ledger.artifacts.items.some((artifact) => artifact.id === 'artifact-maintenance-1'),
    'artifact scope must retain requested Artifact'
  )
  assertEqual(artifactScoped.ledger.workItems.total, 1, 'artifact scope must include owning WorkItem')
  assertEqual(artifactScoped.ledger.runs.total, 1, 'artifact scope must include owning Run')
  assertEqual(artifactScoped.ledger.acceptances.total, 1, 'artifact scope must include related Acceptance')
  assertEqual(artifactScoped.ledger.evidenceLinks.total, 2, 'artifact scope must include both related Evidence Links')
  assertEqual(artifactScoped.ledger.taskEvidence.total, 1, 'artifact scope must include related Task evidence')
  assertEqual(artifactScoped.ledger.workflowEvidence.total, 1, 'artifact scope must include related Workflow evidence')
  assertEqual(artifactScoped.ledger.artifactEdges?.total, 1, 'artifact scope must include related Graph edge')
  assertEqual(artifactScoped.ledger.artifactLocations?.total, 1, 'artifact scope must include related location')
  assert(!artifactScoped.json.includes('artifact-maintenance-other'), 'artifact scope must exclude unrelated project Artifact')

  const acceptanceScoped = await workflowApi.exportWorkflowLedger({
    scope: { acceptanceId: acceptance.id }
  }, userData)
  assertEqual(acceptanceScoped.ledger.acceptances.total, 1, 'Acceptance scope must select one Acceptance seed')
  assertEqual(acceptanceScoped.ledger.evidenceLinks.total, 2, 'Acceptance scope must include both related Evidence Links')
  assertEqual(acceptanceScoped.ledger.artifacts.total, 2, 'Acceptance scope must include linked Graph neighborhood')
  assertEqual(acceptanceScoped.ledger.runs.total, 1, 'Acceptance scope must include linked Run')
  assertEqual(acceptanceScoped.ledger.workflowEvidence.total, 1, 'Acceptance scope must include linked Workflow evidence')
  assert(!acceptanceScoped.json.includes('artifact-maintenance-other'), 'Acceptance scope must exclude unrelated project Artifact')

  const siblingEvidenceArtifact = await workflowApi.createWorkflowArtifact({
    id: 'artifact-maintenance-evidence-sibling',
    projectId: 'project-maintenance',
    workItemId: workItem.id,
    runId: run.id,
    kind: 'test_report',
    title: 'Sibling evidence closure fixture',
    digest: 'sha256:maintenance-evidence-sibling'
  }, userData)
  const siblingAcceptance = await workflowApi.saveWorkflowAcceptance({
    id: 'acceptance-maintenance-sibling',
    projectId: 'project-maintenance',
    workItemId: workItem.id,
    criteria: ['Sibling evidence remains outside narrow exports'],
    status: 'pending'
  }, userData)
  const siblingWorkflowEvidence = await workflowApi.createWorkflowEvidence({
    evidenceId: 'evidence-workflow-maintenance-sibling',
    projectId: 'project-maintenance',
    workItemId: workItem.id,
    runId: run.id,
    artifactId: siblingEvidenceArtifact.id,
    kind: 'test_result',
    title: 'Sibling Workflow Evidence fixture',
    contentDigest: 'b'.repeat(64)
  }, userData, {
    source: 'runtime',
    verifier: 'workflow-ledger-maintenance-smoke',
    observedAt: 24,
    createdAt: 24
  })
  await workflowApi.createWorkflowEvidenceLink({
    id: 'link-maintenance-workflow-evidence-sibling',
    evidenceId: siblingWorkflowEvidence.evidenceId,
    evidenceOrigin: 'workflow',
    projectId: 'project-maintenance',
    runId: run.id,
    artifactId: siblingEvidenceArtifact.id,
    acceptanceId: siblingAcceptance.id,
    relation: 'verifies',
    createdAt: 25
  }, userData)
  await workflowApi.createWorkflowEvidenceLink({
    id: 'link-maintenance-task-evidence-sibling',
    evidenceId: workflowEvidence.evidenceId,
    projectId: 'project-maintenance',
    runId: run.id,
    artifactId: siblingEvidenceArtifact.id,
    acceptanceId: siblingAcceptance.id,
    relation: 'verifies',
    createdAt: 26
  }, userData)

  const sharedAcceptance = await workflowApi.saveWorkflowAcceptance({
    id: 'acceptance-maintenance-shared-evidence',
    projectId: 'project-maintenance',
    workItemId: workItem.id,
    criteria: ['Shared evidence links remain scoped to this Acceptance'],
    status: 'pending'
  }, userData)
  const sharedWorkflowEvidence = await workflowApi.createWorkflowEvidence({
    evidenceId: 'evidence-workflow-maintenance-shared',
    projectId: 'project-maintenance',
    workItemId: workItem.id,
    kind: 'review_result',
    title: 'Shared Workflow Evidence fixture',
    contentDigest: 'c'.repeat(64)
  }, userData, {
    source: 'runtime',
    verifier: 'workflow-ledger-maintenance-smoke',
    observedAt: 27,
    createdAt: 27
  })
  await workflowApi.createWorkflowEvidenceLink({
    id: 'link-maintenance-shared-evidence-primary',
    evidenceId: sharedWorkflowEvidence.evidenceId,
    evidenceOrigin: 'workflow',
    projectId: 'project-maintenance',
    acceptanceId: sharedAcceptance.id,
    relation: 'verifies',
    createdAt: 28
  }, userData)
  await workflowApi.saveWorkflowAcceptance({
    id: sharedAcceptance.id,
    projectId: sharedAcceptance.projectId,
    workItemId: sharedAcceptance.workItemId,
    criteria: sharedAcceptance.criteria,
    status: sharedAcceptance.status,
    evidenceRefs: [sharedWorkflowEvidence.evidenceId],
    revision: sharedAcceptance.revision + 1,
    createdAt: sharedAcceptance.createdAt
  }, userData)
  await workflowApi.createWorkflowEvidenceLink({
    id: 'link-maintenance-shared-evidence-sibling',
    evidenceId: sharedWorkflowEvidence.evidenceId,
    evidenceOrigin: 'workflow',
    projectId: 'project-maintenance',
    artifactId: siblingEvidenceArtifact.id,
    acceptanceId: siblingAcceptance.id,
    relation: 'supports',
    createdAt: 29
  }, userData)
  const isolatedArtifact = await workflowApi.exportWorkflowLedger({
    scope: { artifactId: 'artifact-maintenance-1' }
  }, userData)
  assert(!isolatedArtifact.json.includes(siblingEvidenceArtifact.id),
    'artifact scope must not fan out through an indirectly selected Run to sibling Workflow evidence')
  assert(!isolatedArtifact.json.includes(siblingWorkflowEvidence.evidenceId),
    'artifact scope must exclude sibling Workflow evidence on the same Run')
  assert(!isolatedArtifact.json.includes(siblingAcceptance.id),
    'artifact scope must exclude sibling Evidence Link owners on the same Run')

  const isolatedAcceptance = await workflowApi.exportWorkflowLedger({
    scope: { acceptanceId: acceptance.id }
  }, userData)
  assert(!isolatedAcceptance.json.includes(siblingEvidenceArtifact.id),
    'Acceptance scope must not fan out through an indirectly selected Run to sibling Artifacts')
  assert(!isolatedAcceptance.json.includes(siblingAcceptance.id),
    'Acceptance evidenceRefs must not absorb another Acceptance link with the same evidenceId')
  assertEqual(isolatedAcceptance.ledger.evidenceLinks.total, 2,
    'Acceptance scope must retain only its own Task and Workflow origin links')

  const sharedAcceptanceExport = await workflowApi.exportWorkflowLedger({
    scope: { acceptanceId: sharedAcceptance.id }
  }, userData)
  assertEqual(sharedAcceptanceExport.ledger.evidenceLinks.total, 1,
    'Acceptance evidenceRefs must retain only the Link attached to the selected Acceptance')
  assert(!sharedAcceptanceExport.json.includes('link-maintenance-shared-evidence-sibling'),
    'Acceptance evidenceRefs must not absorb another Acceptance link with the same evidenceId')
  assert(!sharedAcceptanceExport.json.includes(siblingEvidenceArtifact.id),
    'shared Workflow evidence must not widen Acceptance scope to a sibling Link target')

  const eventScoped = await workflowApi.exportWorkflowLedger({
    scope: { entityType: 'acceptance', entityId: acceptance.id, eventKind: 'acceptance.created' }
  }, userData)
  assert(
    eventScoped.ledger.events.items.some((event) => event.entityId === acceptance.id && event.kind === 'acceptance.created'),
    'entity/event scope must retain the requested Acceptance event'
  )
  assertEqual(eventScoped.ledger.acceptances.total, 1, 'entity/event scope must include event owner Acceptance')
  assertEqual(eventScoped.ledger.workItems.total, 1, 'entity/event scope must include event owner WorkItem')
  assert(!eventScoped.json.includes('artifact-maintenance-other'), 'entity/event scope must exclude unrelated project Artifact')

  await snapshotStore.mutateTaskSnapshotDatabase(userData, (db) => workflowStore.appendWorkflowEvent(db, {
    eventId: 'workflow:session-only:maintenance',
    streamId: 'session:session-maintenance-1',
    entityType: 'system',
    entityId: 'session-maintenance-note',
    kind: 'workflow.session.note',
    payload: { note: 'session-only event retained by project ownership' },
    occurredAt: 220
  }, { sessionId: run.sessionId }))
  await snapshotStore.mutateTaskSnapshotDatabase(userData, (db) => workflowStore.appendWorkflowEvent(db, {
    eventId: 'workflow:session-payload-only:maintenance',
    streamId: 'session:session-maintenance-1',
    entityType: 'system',
    entityId: 'session-maintenance-payload-note',
    kind: 'workflow.session.note',
    payload: {
      runId: run.id,
      sessionId: run.sessionId,
      note: 'payload-only ownership must remain project-scoped'
    },
    occurredAt: 221
  }))
  const projectWithSessionEvent = await workflowApi.exportWorkflowLedger({
    scope: { projectId: 'project-maintenance' }
  }, userData)
  assert(
    projectWithSessionEvent.ledger.events.items.some((event) => event.eventId === 'workflow:session-only:maintenance'),
    'project scope must retain a session-only event owned by a selected project Run'
  )
  assert(
    projectWithSessionEvent.ledger.events.items.some((event) => event.eventId === 'workflow:session-payload-only:maintenance'),
    'project scope must infer payload-only session ownership from a selected project Run'
  )
  const sessionScoped = await workflowApi.exportWorkflowLedger({
    scope: { sessionId: run.sessionId }
  }, userData)
  assertEqual(sessionScoped.ledger.runs.total, 1, 'session scope must select its owning Run')
  assertEqual(sessionScoped.ledger.artifacts.total, 3,
    'session scope must retain both Run Artifacts and the selected Graph neighbor')

  const sharedGoal = {
    schemaVersion: 1,
    id: 'goal-maintenance-shared',
    projectId: 'project-maintenance',
    title: 'Shared goal closure fixture',
    objective: 'Ensure narrow exports do not pull sibling WorkItems',
    status: 'planned',
    revision: 1,
    source: 'explicit',
    createdAt: 300,
    updatedAt: 300
  }
  const parentWorkItem = {
    schemaVersion: 1,
    id: 'work-item-maintenance-parent',
    projectId: 'project-maintenance',
    goalId: sharedGoal.id,
    type: 'planning',
    title: 'Parent closure fixture',
    status: 'ready',
    revision: 1,
    source: 'explicit',
    runIds: [],
    createdAt: 301,
    updatedAt: 301
  }
  const selectedWorkItem = {
    schemaVersion: 1,
    id: 'work-item-maintenance-selected',
    projectId: 'project-maintenance',
    goalId: sharedGoal.id,
    parentId: parentWorkItem.id,
    type: 'analysis',
    title: 'Selected closure fixture',
    status: 'ready',
    revision: 1,
    source: 'explicit',
    runIds: [],
    createdAt: 302,
    updatedAt: 302
  }
  const siblingWorkItem = {
    schemaVersion: 1,
    id: 'work-item-maintenance-sibling',
    projectId: 'project-maintenance',
    goalId: sharedGoal.id,
    type: 'analysis',
    title: 'Sibling must stay outside narrow export',
    status: 'ready',
    revision: 1,
    source: 'explicit',
    runIds: [],
    createdAt: 303,
    updatedAt: 303
  }
  const supersededArtifact = {
    id: 'artifact-maintenance-superseded',
    projectId: 'project-maintenance',
    goalId: sharedGoal.id,
    workItemId: selectedWorkItem.id,
    kind: 'report',
    title: 'Superseded closure fixture',
    version: 1,
    digest: 'sha256:maintenance-superseded',
    provenance: 'explicit',
    createdAt: 304,
    updatedAt: 304
  }
  const selectedClosureArtifact = {
    id: 'artifact-maintenance-selected',
    projectId: 'project-maintenance',
    goalId: sharedGoal.id,
    workItemId: selectedWorkItem.id,
    kind: 'report',
    title: 'Selected closure artifact',
    version: 2,
    digest: 'sha256:maintenance-selected',
    provenance: 'explicit',
    supersedesId: supersededArtifact.id,
    createdAt: 305,
    updatedAt: 305
  }
  const siblingArtifact = {
    id: 'artifact-maintenance-sibling',
    projectId: 'project-maintenance',
    goalId: sharedGoal.id,
    workItemId: siblingWorkItem.id,
    kind: 'report',
    title: 'Sibling artifact must stay outside narrow export',
    version: 1,
    digest: 'sha256:maintenance-sibling',
    provenance: 'explicit',
    createdAt: 306,
    updatedAt: 306
  }
  await snapshotStore.mutateTaskSnapshotDatabase(userData, (db) => {
    workflowStore.projectGoal(db, sharedGoal)
    workflowStore.projectWorkItem(db, parentWorkItem)
    workflowStore.projectWorkItem(db, selectedWorkItem)
    workflowStore.projectWorkItem(db, siblingWorkItem)
    workflowStore.registerWorkflowArtifact(db, supersededArtifact)
    workflowStore.registerWorkflowArtifact(db, selectedClosureArtifact)
    workflowStore.registerWorkflowArtifact(db, siblingArtifact)
  })
  const narrowClosure = await workflowApi.exportWorkflowLedger({
    scope: { artifactId: selectedClosureArtifact.id }
  }, userData)
  assertEqual(narrowClosure.ledger.goals.total, 1, 'artifact scope must include its owning Goal only')
  assertEqual(narrowClosure.ledger.workItems.total, 2, 'artifact scope must include selected WorkItem and its parent only')
  assertEqual(narrowClosure.ledger.artifacts.total, 2, 'artifact scope must include supersedes history without sibling artifacts')
  assert(narrowClosure.ledger.workItems.items.some((item) => item.id === parentWorkItem.id), 'parent WorkItem must remain closed')
  assert(narrowClosure.ledger.artifacts.items.some((artifact) => artifact.id === supersededArtifact.id), 'supersedes Artifact must remain closed')
  assert(!narrowClosure.json.includes(siblingWorkItem.id), 'narrow artifact scope must exclude sibling WorkItem')
  assert(!narrowClosure.json.includes(siblingArtifact.id), 'narrow artifact scope must exclude sibling Artifact')

  const ownershipConflict = await workflowApi.exportWorkflowLedger({
    scope: { goalId: sharedGoal.id, runId: run.id }
  }, userData)
  assertEqual(ownershipConflict.ledger.goals.total, 0, 'conflicting goal/run selectors must produce no Goal seed')
  assertEqual(ownershipConflict.ledger.runs.total, 0, 'conflicting goal/run selectors must produce no Run seed')
  assertEqual(ownershipConflict.ledger.artifacts.total, 0, 'conflicting goal/run selectors must produce no Artifact seed')
  const eventKindConflict = await workflowApi.exportWorkflowLedger({
    scope: { artifactId: selectedClosureArtifact.id, eventKind: 'event.kind.does.not.exist' }
  }, userData)
  assertEqual(eventKindConflict.ledger.artifacts.total, 0, 'artifact plus unmatched event selector must produce no seed')
  await assertRejects(
    workflowApi.exportWorkflowLedger({ scope: { artifactId: null } }, userData),
    (error) => String(error).includes('non-empty string'),
    'null export selectors must fail closed'
  )
  await assertRejects(
    workflowApi.exportWorkflowLedger({ scope: { projectId: '' } }, userData),
    (error) => String(error).includes('non-empty string'),
    'empty export selectors must fail closed'
  )

  const graphThirdArtifact = await workflowApi.createWorkflowArtifact({
    id: 'artifact-maintenance-graph-third',
    projectId: 'project-maintenance',
    kind: 'source',
    title: 'Graph second-hop fixture',
    uri: 'https://example.test/third',
    digest: 'sha256:maintenance-graph-third'
  }, userData)
  await workflowApi.createWorkflowArtifactEdge({
    id: 'edge-maintenance-report-third',
    fromArtifactId: 'artifact-maintenance-1',
    toArtifactId: graphThirdArtifact.id,
    projectId: 'project-maintenance',
    relation: 'derived_from',
    createdAt: 307
  }, userData)
  await workflowApi.createWorkflowArtifactLocation({
    id: 'location-maintenance-source',
    artifactId: sourceArtifact.id,
    projectId: 'project-maintenance',
    kind: 'url',
    uri: 'https://example.test/source',
    createdAt: 308
  }, userData)
  const graphClosed = await workflowApi.exportWorkflowLedger({
    scope: { artifactId: 'artifact-maintenance-1' }
  }, userData)
  assertEqual(graphClosed.ledger.artifacts.total, 3, 'Graph second hop must add its endpoint to the closure')
  assertEqual(graphClosed.ledger.artifactEdges?.total, 2, 'Graph export must retain every selected endpoint edge')
  assertEqual(graphClosed.ledger.artifactLocations?.total, 2, 'Graph export must retain locations for every selected endpoint')
  for (const edge of graphClosed.ledger.artifactEdges?.items ?? []) {
    assert(
      graphClosed.ledger.artifacts.items.some((artifact) => artifact.id === edge.fromArtifactId) &&
        graphClosed.ledger.artifacts.items.some((artifact) => artifact.id === edge.toArtifactId),
      'exported Graph edge endpoints must be present in the Artifact closure'
    )
  }
  assert(
    graphClosed.ledger.events.items.some((event) => event.entityId === 'artifact-edge:edge-maintenance-report-third'),
    'exported Graph row must retain its corresponding Workflow event'
  )
  const graphOwnershipClosed = await workflowApi.exportWorkflowLedger({
    scope: { artifactId: 'artifact-maintenance-1', workItemId: workItem.id }
  }, userData)
  assertEqual(graphOwnershipClosed.ledger.artifactEdges?.total, 2, 'Graph rows must not be dropped by duplicated owner scope filters')

  const conflictingScope = await workflowApi.exportWorkflowLedger({
    scope: { projectId: 'project-other', artifactId: 'artifact-maintenance-1' }
  }, userData)
  assertEqual(conflictingScope.ledger.artifacts.total, 0, 'conflicting project and Artifact scope must not leak records')
  await assertRejects(
    workflowApi.exportWorkflowLedger({ scope: { limit: 1 } }, userData),
    (error) => String(error).includes('must not include pagination'),
    'export must reject pagination options that could silently truncate a bundle'
  )
  await assertRejects(
    workflowApi.exportWorkflowLedger({ scope: { unexpected: 'field' } }, userData),
    (error) => String(error).includes('unknown field'),
    'export must reject unknown scope fields instead of silently widening the export'
  )

  const beforeDiagnostic = readFileSync(dbPath)
  const healthyPlan = await workflowApi.diagnoseWorkflowLedger(userData)
  assertEqual(healthyPlan.status, 'healthy', 'fresh database should not require repair')
  assertEqual(healthyPlan.readOnly, true, 'repair plan must be read-only')
  assertEqual(healthyPlan.canAutoRepair, false, 'repair plan must not auto-repair')
  assertEqual(healthyPlan.writesPerformed, false, 'diagnostic must report no writes')
  assertEqual(healthyPlan.digestRecomputed, false, 'diagnostic must not recompute digests')
  assertEqual(healthyPlan.eventsAppended, false, 'diagnostic must not append events')
  assertEqual(healthyPlan.mutations.length, 0, 'diagnostic must contain no mutations')
  assertEqual(healthyPlan.verification?.workflowEvidence.valid, true, 'healthy repair plan must verify Workflow evidence')
  assertEqual(healthyPlan.verification?.workflowEvidence.count, 3, 'healthy repair plan must count Workflow evidence')
  assertEqual(Buffer.compare(beforeDiagnostic, readFileSync(dbPath)), 0, 'diagnostic must not rewrite the database')

  const pristineBytes = readFileSync(dbPath)
  await mutateDatabaseFile(dbPath, (db) => {
    db.run("UPDATE workflow_events SET record_digest = 'tampered-maintenance' WHERE seq = 1")
  })
  const tamperedBytes = readFileSync(dbPath)
  const repairPlan = await workflowApi.planWorkflowLedgerRepair(userData)
  assertEqual(repairPlan.status, 'repair_required', 'tampered chain must require repair')
  assertEqual(repairPlan.readOnly, true, 'repair diagnostics remain read-only after corruption')
  assertEqual(repairPlan.canAutoRepair, false, 'corrupt chain must not be auto-repaired')
  assertEqual(repairPlan.writesPerformed, false, 'repair diagnosis must not write')
  assertEqual(repairPlan.digestRecomputed, false, 'repair diagnosis must not recompute digests')
  assertEqual(repairPlan.eventsAppended, false, 'repair diagnosis must not append events')
  assertEqual(repairPlan.mutations.length, 0, 'repair diagnosis must not propose implicit mutations')
  assert(repairPlan.verificationError, 'corrupt chain must expose a verification error')
  assert(repairPlan.proposedActions.some((action) => action.kind === 'backup_database'), 'repair must recommend a backup')
  assert(repairPlan.proposedActions.every((action) => action.mutatesLedger === false), 'actions must be non-mutating recommendations')
  assertEqual(Buffer.compare(tamperedBytes, readFileSync(dbPath)), 0, 'repair diagnosis must preserve corrupt bytes')
  await assertRejects(
    workflowApi.exportWorkflowLedger({}, userData),
    (error) => String(error).includes('Workflow ledger corruption'),
    'export must fail closed when the source chain is corrupt'
  )
  assertEqual(Buffer.compare(tamperedBytes, readFileSync(dbPath)), 0, 'failed export must preserve corrupt bytes')
  writeFileSync(dbPath, pristineBytes)

  const unreadableRoot = path.join(tempRoot, 'unreadable-user-data')
  const unreadableDbPath = snapshotStore.taskSnapshotsDbFile(unreadableRoot)
  mkdirSync(unreadableDbPath, { recursive: true })
  await assertRejects(
    workflowApi.exportWorkflowLedger({}, unreadableRoot),
    (error) => !String(error).includes('valid: true'),
    'an unreadable database path must not export a healthy empty ledger'
  )
  const unavailablePlan = await workflowApi.diagnoseWorkflowLedger(unreadableRoot)
  assertEqual(unavailablePlan.status, 'unavailable', 'an unreadable database path must be unavailable')
  assertEqual(unavailablePlan.databaseExists, true, 'unreadable database diagnostics must preserve existence evidence')
  console.log('workflow ledger maintenance smoke: PASS')
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
      'src/main/task/workflow-ledger-maintenance.ts',
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

function buildMeta(id, projectId) {
  return {
    id,
    title: `Maintenance ${id}`,
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
    createdAt: 1
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
        verifier: 'workflow-ledger-maintenance-smoke',
        generation: 1
      }],
      createdAt: 1,
      updatedAt
    }]
  }
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

function assert(value, message) {
  if (!value) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
