import assert from 'node:assert/strict'
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
  return stageStep(stage, 'finalize', () => attachAndFinalizeStage(api, payload, stage))
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
