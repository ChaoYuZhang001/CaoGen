import assert from 'node:assert/strict'
import { writeSync } from 'node:fs'
import {
  FLOW_ORDER,
  GOAL_ID,
  OWNER,
  PROJECT_ID,
  REVIEW_FAILURE_CANARY,
  STAGES,
  stageByName
} from './verified-delivery-flow-contract.mjs'
import {
  assertHandoffArtifact,
  assertPromptCarriesArtifact,
  bareDigest,
  commandContext,
  evidenceAuthority,
  ensureRun,
  finalizeWorkItem,
  findAcceptance,
  markStageReady,
  requireLifecycle,
  reviewAuthority,
  transitionPersistedRun,
  upstreamArtifactId
} from './verified-delivery-flow-support.mjs'

export async function seedWorkflow(api, payload) {
  const { commands, store } = await commandContext(api, payload)
  await store.createWorkspace({
    id: PROJECT_ID,
    name: 'Verified delivery flow',
    kind: 'software',
    ownerId: OWNER.id
  })
  await commands.reconcileShadowProjection()
  await commands.createGoal({
    id: GOAL_ID,
    projectId: PROJECT_ID,
    title: 'Deliver a verified staged result',
    objective: FLOW_ORDER.join(' -> '),
    status: 'running',
    createdBy: OWNER.id
  })
  for (const stage of STAGES) {
    await commands.createWorkItem({
      id: stage.workItemId,
      projectId: PROJECT_ID,
      goalId: GOAL_ID,
      type: stage.type,
      title: stage.title,
      dependencyIds: stage.dependencyIds,
      owner: OWNER,
      status: stage.dependencyIds.length === 0 ? 'ready' : 'backlog',
      acceptanceSpec: [{ id: `${stage.workItemId}:criterion`, criterion: stage.criterion, required: true }]
    })
  }
  return { stageCount: STAGES.length, flowOrder: FLOW_ORDER }
}

export async function createStageArtifact(api, payload, stage) {
  const run = await ensureRun(api, payload, stage)
  const result = await registerArtifact(api, payload, stage, run.id)
  return {
    artifactId: result.lifecycle.artifactId,
    digest: result.lifecycle.digest,
    locationKind: result.location.kind,
    version: result.lifecycle.version
  }
}

export async function createStageEvidence(api, payload, stage) {
  const lifecycle = await requireLifecycle(api, payload, stage.artifactId)
  const evidence = await api.workflow.createWorkflowEvidence({
    evidenceId: stage.evidenceId,
    projectId: PROJECT_ID,
    goalId: GOAL_ID,
    workItemId: stage.workItemId,
    runId: stage.runId,
    artifactId: stage.artifactId,
    kind: evidenceKind(stage.name),
    title: `${stage.title} byte verification`,
    contentDigest: bareDigest(lifecycle.digest),
    metadata: { workflowStage: stage.name, reportSafe: true }
  }, payload.rootDir, evidenceAuthority())
  return { evidenceId: evidence.evidenceId, artifactId: evidence.artifactId }
}

export async function createStageAcceptance(api, payload, stage) {
  const acceptance = await api.workflow.saveWorkflowAcceptance({
    id: stage.acceptanceId,
    projectId: PROJECT_ID,
    goalId: GOAL_ID,
    workItemId: stage.workItemId,
    criteria: [stage.criterion]
  }, payload.rootDir)
  return { acceptanceId: acceptance.id, status: acceptance.status, revision: acceptance.revision }
}

export async function createStageLink(api, payload, stage) {
  const link = await api.workflow.createWorkflowEvidenceLink({
    id: stage.evidenceLinkId,
    evidenceId: stage.evidenceId,
    evidenceOrigin: 'workflow',
    projectId: PROJECT_ID,
    runId: stage.runId,
    artifactId: stage.artifactId,
    acceptanceId: stage.acceptanceId,
    relation: 'verifies'
  }, payload.rootDir)
  return { linkId: link.id, acceptanceId: link.acceptanceId, artifactId: link.artifactId }
}

export async function passStagedAcceptance(api, payload, stage) {
  const pending = await findAcceptance(api, payload, stage.acceptanceId)
  assert.equal(pending.status, 'pending')
  const result = await reviewAcceptance(api, payload, stage, 'passed', stage.evidenceId)
  assert.equal(result.acceptance.status, 'passed')
  return {
    acceptanceId: result.acceptance.id,
    status: result.acceptance.status,
    revision: result.acceptance.revision
  }
}

export async function attachAndFinalizeStage(api, payload, stage) {
  await api.handoff.attachProducedArtifactToStage({
    artifactId: stage.artifactId,
    projectId: PROJECT_ID,
    workItemId: stage.workItemId,
    runId: stage.runId,
    rootDir: payload.rootDir
  })
  const workItem = await finalizeWorkItem(api, payload, stage, stage.decision)
  await transitionPersistedRun(api, payload, stage.sessionId, 'completed')
  return { artifactId: stage.artifactId, workItemId: workItem.id, status: workItem.status }
}

export async function completeStage(api, payload, stage) {
  assert(!['research', 'review'].includes(stage.name), `stage ${stage.name} requires a specialized action`)
  await prepareStageForHandoff(api, payload, stage)
  return stageStep(stage, 'finalize', () => attachAndFinalizeStage(api, payload, stage))
}

export async function crashStageHandoffAtCheckpoint(api, payload, stage) {
  const checkpoint = payload.handoffCheckpoint
  assert(
    ['prepared', 'input_edges', 'workitem_reference', 'committed'].includes(checkpoint),
    'handoffCheckpoint is invalid'
  )
  if (stage.name !== 'research') {
    await prepareStageForHandoff(api, payload, stage)
  }
  await api.handoff.attachProducedArtifactToStage({
    artifactId: stage.artifactId,
    projectId: PROJECT_ID,
    workItemId: stage.workItemId,
    runId: stage.runId,
    rootDir: payload.rootDir
  }, {
    onCheckpoint(observed) {
      if (observed !== checkpoint) return
      writeSync(1, JSON.stringify({ ok: true, checkpoint: observed }))
      process.kill(process.pid, 'SIGKILL')
    }
  })
  throw stageCheckpointError(stage.name, checkpoint)
}

export async function recoverStageHandoffAfterCrash(api, payload, stage) {
  const checkpoint = payload.handoffCheckpoint
  const before = await stageAttachmentSnapshot(api, payload, stage)
  assertStageCheckpoint(before, checkpoint)
  const recovery = await api.handoff.recoverProducedArtifactStageAttachments(payload.rootDir)
  if (checkpoint === 'committed') {
    assert(!recovery.recovered.includes(stage.artifactId))
  } else {
    assert(recovery.recovered.includes(stage.artifactId))
  }
  assert.equal(recovery.failures.length, 0)
  const after = await stageAttachmentSnapshot(api, payload, stage)
  assert.equal(after.prepared, true)
  assert.equal(after.committed, true)
  assert.equal(after.workItemReference, true)
  assert.deepEqual(after.edgeSourceIds, after.sourceArtifactIds)
  const workItem = await finalizeWorkItem(api, payload, stage, stage.decision)
  await transitionPersistedRun(api, payload, stage.sessionId, 'completed')
  return {
    artifactId: stage.artifactId,
    checkpoint,
    recovered: recovery.recovered.includes(stage.artifactId),
    sourceArtifactIds: after.sourceArtifactIds,
    workItemId: workItem.id,
    status: workItem.status
  }
}

async function prepareStageForHandoff(api, payload, stage) {
  await stageStep(stage, 'ready', () => markStageReady(api, payload, stage.workItemId))
  await stageStep(stage, 'handoff', () => assertImmediateHandoff(api, payload, stage))
  await stageStep(stage, 'artifact', () => createStageArtifact(api, payload, stage))
  await stageStep(stage, 'evidence', () => createStageEvidence(api, payload, stage))
  await stageStep(stage, 'acceptance', () => createStageAcceptance(api, payload, stage))
  await stageStep(stage, 'link', () => createStageLink(api, payload, stage))
  if (stage.decision === 'waived') {
    await stageStep(stage, 'waiver', () => waiveAcceptance(api, payload, stage))
  } else {
    await stageStep(stage, 'review', () => reviewAcceptance(api, payload, stage, 'passed', stage.evidenceId))
  }
}

export async function prepareReview(api, payload) {
  const stage = stageByName('review')
  await markStageReady(api, payload, stage.workItemId)
  await assertImmediateHandoff(api, payload, stage)
  await createStageArtifact(api, payload, stage)
  await createStageEvidence(api, payload, stage)
  await createStageAcceptance(api, payload, stage)
  await createStageLink(api, payload, stage)
  return { artifactId: stage.artifactId, acceptanceId: stage.acceptanceId, status: 'pending' }
}

export async function failReview(api, payload) {
  const stage = stageByName('review')
  const result = await reviewAcceptance(api, payload, stage, 'failed', stage.evidenceId)
  assert.equal(result.acceptance.status, 'failed')
  assert(result.repair?.workItemId)
  assert(result.repair?.acceptanceId)
  const { store } = await commandContext(api, payload)
  const repair = await store.getWorkItem(result.repair.workItemId)
  assert(repair)
  const repairAcceptance = await findAcceptance(api, payload, result.repair.acceptanceId)
  assert.equal(repairAcceptance.status, 'pending')
  await transitionPersistedRun(
    api,
    payload,
    stage.sessionId,
    'failed',
    REVIEW_FAILURE_CANARY
  )
  return {
    acceptanceId: result.acceptance.id,
    status: result.acceptance.status,
    repairWorkItemId: repair.id,
    repairAcceptanceId: repairAcceptance.id
  }
}

function registerArtifact(api, payload, stage, creatingRunId) {
  return api.lifecycle.registerPersistedArtifactLifecycle({
    id: stage.artifactId,
    projectId: PROJECT_ID,
    goalId: GOAL_ID,
    workItemId: stage.workItemId,
    runId: creatingRunId,
    lineageId: stage.lineageId,
    kind: stage.artifactKind,
    title: stage.artifactTitle,
    version: 1,
    provenance: 'explicit',
    mediaType: 'text/plain',
    retention: { mode: 'retain' },
    content: { storageKind: 'blob', bytes: Buffer.from(stage.content) },
    metadata: { workflowStage: stage.name, producer: 'verified_delivery_gate' }
  }, payload.rootDir)
}

async function assertImmediateHandoff(api, payload, stage) {
  if (stage.dependencyIds.length === 0) return
  const result = await assertHandoffArtifact(api, payload, stage.workItemId, upstreamArtifactId(stage.name))
  assertPromptCarriesArtifact(result.prompt, result.item)
}

async function stageAttachmentSnapshot(api, payload, stage) {
  const ledger = await api.workflow.listPersistedWorkflowLedger(
    { projectId: PROJECT_ID, limit: 500 },
    payload.rootDir
  )
  const prepared = ledger.events.items.find((event) =>
    event.entityId === stage.artifactId && event.kind === 'workflow.artifact.stage.prepared')
  const committed = ledger.events.items.some((event) =>
    event.entityId === stage.artifactId && event.kind === 'workflow.artifact.stage.committed')
  assert(prepared)
  assert(Array.isArray(prepared.payload.sourceArtifactIds))
  const sourceArtifactIds = [...prepared.payload.sourceArtifactIds].sort()
  const edges = await api.workflow.listWorkflowArtifactEdges({
    projectId: PROJECT_ID,
    toArtifactId: stage.artifactId,
    relation: 'input_to',
    limit: 100
  }, payload.rootDir)
  const { store } = await commandContext(api, payload)
  const workItem = await store.getWorkItem(stage.workItemId)
  assert(workItem)
  return {
    prepared: true,
    committed,
    sourceArtifactIds,
    edgeSourceIds: edges.items.map((edge) => edge.fromArtifactId).sort(),
    workItemReference: workItem.artifactRefs.includes(stage.artifactId)
  }
}

function assertStageCheckpoint(snapshot, checkpoint) {
  assert.equal(snapshot.prepared, true)
  assert.equal(snapshot.committed, checkpoint === 'committed')
  assert.equal(
    snapshot.workItemReference,
    checkpoint === 'workitem_reference' || checkpoint === 'committed'
  )
  const edgesExpected = checkpoint !== 'prepared'
  assert.deepEqual(snapshot.edgeSourceIds, edgesExpected ? snapshot.sourceArtifactIds : [])
}

function stageCheckpointError(stageName, checkpoint) {
  const error = new Error('stage checkpoint was not reached')
  Object.assign(error, {
    code: `VERIFIED_DELIVERY_${stageName.toUpperCase()}_${checkpoint.toUpperCase()}_NOT_REACHED`
  })
  return error
}

async function waiveAcceptance(api, payload, stage) {
  const result = await api.handlers.reviewWorkflowAcceptance({
    acceptanceId: stage.acceptanceId,
    criterionEvidence: [],
    decision: 'waived',
    waiverReason: 'fixture waiver verifies authorized downstream handoff'
  }, reviewAuthority(), payload.rootDir)
  assert.equal(result.acceptance.status, 'waived')
}

function reviewAcceptance(api, payload, stage, decision, selectedEvidenceId) {
  return api.handlers.reviewWorkflowAcceptance({
    acceptanceId: stage.acceptanceId,
    criterionEvidence: [{ criterionIndex: 0, evidenceRefs: [selectedEvidenceId] }],
    decision,
    notes: `${stage.name} ${decision} by verified-delivery gate`
  }, reviewAuthority(), payload.rootDir)
}

function evidenceKind(stageName) {
  if (stageName === 'review') return 'review_result'
  if (stageName === 'delivery') return 'delivery_check'
  return 'test_result'
}

async function stageStep(stage, step, action) {
  try {
    return await action()
  } catch (error) {
    if (error && typeof error === 'object' &&
        !String(error.code ?? '').startsWith('VERIFIED_DELIVERY_')) {
      error.code = `VERIFIED_DELIVERY_${stage.name.toUpperCase()}_${step.toUpperCase()}`
    }
    throw error
  }
}
