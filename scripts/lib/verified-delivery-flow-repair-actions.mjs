import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  GOAL_ID,
  PROJECT_ID,
  REVIEW_V2,
  acceptanceId,
  artifactId,
  stageByName,
  workItemId
} from './verified-delivery-flow-contract.mjs'
import {
  acceptanceResult,
  acquireAndTransition,
  commandContext,
  ensureRun,
  evidenceAuthority,
  finalizeWorkItem,
  findAcceptance,
  reviewAuthority,
  sha256,
  transitionPersistedRun
} from './verified-delivery-flow-support.mjs'

export async function repairReview(api, payload) {
  const context = await loadRepairContext(api, payload)
  const repairedArtifact = await createRepairedReviewArtifact(api, payload)
  const repairedEvidence = await createRepairedReviewEvidence(api, payload, repairedArtifact.lifecycle)
  await createRepairedReviewLink(api, payload, context.failed.id)
  const repairEvidence = await createRepairCompletionEvidence(api, payload, context.repairWorkItem)
  await passRepairAcceptance(api, payload, context, repairEvidence.evidenceId)
  await finalizeRepairWorkItem(api, payload, context.repairWorkItem, repairEvidence.evidenceId)
  await retestOriginalAcceptance(api, payload, context, repairedEvidence.evidenceId, repairedArtifact.location.path)
  await attachRepairedReviewArtifact(api, payload)
  await finalizeReviewWorkItem(api, payload, repairedEvidence.evidenceId)
  await transitionPersistedRun(api, payload, REVIEW_V2.sessionId, 'completed')
  await bindRepairDependency(api, payload, context.repairWorkItem.id)
  return {
    repairWorkItemId: context.repairWorkItem.id,
    repairedArtifactId: REVIEW_V2.artifactId,
    supersedesId: artifactId('review'),
    byteIntegrityNegativeCheck: 'workflow_evidence_content_digest_mismatch'
  }
}

async function loadRepairContext(api, payload) {
  const failed = await findAcceptance(api, payload, acceptanceId('review'))
  assert.equal(failed.status, 'failed')
  const repairWorkItemId = api.repair.workflowAcceptanceRepairWorkItemId(failed.id, failed.revision)
  const repairAcceptanceId = api.repair.workflowAcceptanceRepairAcceptanceId(repairWorkItemId)
  const { store } = await commandContext(api, payload)
  const repairWorkItem = await store.getWorkItem(repairWorkItemId)
  assert(repairWorkItem)
  const repairAcceptance = await findAcceptance(api, payload, repairAcceptanceId)
  return { failed, repairAcceptance, repairWorkItem }
}

async function createRepairedReviewArtifact(api, payload) {
  const stage = stageByName('review')
  await ensureRun(api, payload, {
    ...stage,
    runId: REVIEW_V2.runId,
    sessionId: REVIEW_V2.sessionId,
    content: REVIEW_V2.content
  })
  return api.lifecycle.registerPersistedArtifactLifecycle({
    id: REVIEW_V2.artifactId,
    projectId: PROJECT_ID,
    goalId: GOAL_ID,
    workItemId: stage.workItemId,
    runId: REVIEW_V2.runId,
    lineageId: stage.lineageId,
    kind: stage.artifactKind,
    title: 'Repaired review deliverable',
    version: REVIEW_V2.version,
    supersedesId: stage.artifactId,
    provenance: 'explicit',
    mediaType: 'text/plain',
    retention: { mode: 'retain' },
    content: { storageKind: 'blob', bytes: Buffer.from(REVIEW_V2.content) },
    metadata: { workflowStage: 'repair', producer: 'verified_delivery_gate' }
  }, payload.rootDir)
}

function createRepairedReviewEvidence(api, payload, lifecycle) {
  return api.workflow.createWorkflowEvidence({
    evidenceId: REVIEW_V2.evidenceId,
    projectId: PROJECT_ID,
    goalId: GOAL_ID,
    workItemId: workItemId('review'),
    runId: REVIEW_V2.runId,
    artifactId: REVIEW_V2.artifactId,
    kind: 'review_result',
    title: 'Repaired review bytes verified',
    contentDigest: lifecycle.digest.slice('sha256:'.length),
    metadata: { workflowStage: 'repair', reportSafe: true }
  }, payload.rootDir, evidenceAuthority())
}

function createRepairCompletionEvidence(api, payload, repairWorkItem) {
  return api.workflow.createWorkflowEvidence({
    evidenceId: 'verified-evidence-repair-complete',
    projectId: PROJECT_ID,
    goalId: GOAL_ID,
    workItemId: repairWorkItem.id,
    kind: 'test_result',
    title: 'Repair WorkItem completion proof',
    contentDigest: sha256('repair completion verified'),
    metadata: { workflowStage: 'repair', reportSafe: true }
  }, payload.rootDir, evidenceAuthority())
}

function createRepairedReviewLink(api, payload, targetAcceptanceId) {
  return api.workflow.createWorkflowEvidenceLink({
    id: 'verified-link-review-v2',
    evidenceId: REVIEW_V2.evidenceId,
    evidenceOrigin: 'workflow',
    projectId: PROJECT_ID,
    runId: REVIEW_V2.runId,
    artifactId: REVIEW_V2.artifactId,
    acceptanceId: targetAcceptanceId,
    relation: 'verifies'
  }, payload.rootDir)
}

async function passRepairAcceptance(api, payload, context, repairEvidenceId) {
  const result = await api.handlers.reviewWorkflowAcceptance({
    acceptanceId: context.repairAcceptance.id,
    criterionEvidence: [{ criterionIndex: 0, evidenceRefs: [repairEvidenceId] }],
    decision: 'passed',
    notes: 'repair verified'
  }, reviewAuthority(), payload.rootDir)
  assert.equal(result.acceptance.status, 'passed')
}

async function finalizeRepairWorkItem(api, payload, repairWorkItem, repairEvidenceId) {
  const { commands, store } = await commandContext(api, payload)
  let current = await store.getWorkItem(repairWorkItem.id)
  assert(current)
  current = await commands.setWorkItemAcceptance(current.id, acceptanceResult('passed', repairEvidenceId), {
    expectedRevision: current.revision
  })
  current = await acquireAndTransition(commands, current, 'running')
  current = await commands.transitionWorkItem(current.id, 'verifying', { expectedRevision: current.revision })
  current = await commands.transitionWorkItem(current.id, 'done', { expectedRevision: current.revision })
  assert.equal(current.status, 'done')
}

async function retestOriginalAcceptance(api, payload, context, repairedEvidenceId, artifactPath) {
  const retest = await api.handlers.reviewWorkflowAcceptance({
    acceptanceId: context.failed.id,
    criterionEvidence: [],
    decision: 'retest',
    notes: 'repair completed; retest exact bytes'
  }, reviewAuthority(), payload.rootDir)
  assert.equal(retest.acceptance.status, 'verifying')

  const original = readFileSync(artifactPath)
  const tampered = Buffer.from(original)
  tampered[0] ^= 1
  writeFileSync(artifactPath, tampered)
  try {
    await assertByteIntegrityFailure(api, payload, context.failed.id, repairedEvidenceId)
  } finally {
    writeFileSync(artifactPath, original)
  }
  const passed = await api.handlers.reviewWorkflowAcceptance({
    acceptanceId: context.failed.id,
    criterionEvidence: [{ criterionIndex: 0, evidenceRefs: [repairedEvidenceId] }],
    decision: 'passed',
    notes: 'repaired Artifact bytes verified'
  }, reviewAuthority(), payload.rootDir)
  assert.equal(passed.acceptance.status, 'passed')
}

async function assertByteIntegrityFailure(api, payload, targetAcceptanceId, repairedEvidenceId) {
  await assert.rejects(
    api.handlers.reviewWorkflowAcceptance({
      acceptanceId: targetAcceptanceId,
      criterionEvidence: [{ criterionIndex: 0, evidenceRefs: [repairedEvidenceId] }],
      decision: 'passed',
      notes: 'tampered bytes must fail'
    }, reviewAuthority(), payload.rootDir),
    (error) => error?.code === 'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID' &&
      error?.details?.reason === 'workflow_evidence_content_digest_mismatch'
  )
}

function attachRepairedReviewArtifact(api, payload) {
  return api.handoff.attachProducedArtifactToStage({
    artifactId: REVIEW_V2.artifactId,
    projectId: PROJECT_ID,
    workItemId: workItemId('review'),
    runId: REVIEW_V2.runId,
    rootDir: payload.rootDir
  })
}

function finalizeReviewWorkItem(api, payload, repairedEvidenceId) {
  return finalizeWorkItem(api, payload, {
    ...stageByName('review'),
    evidenceId: repairedEvidenceId
  }, 'passed')
}

async function bindRepairDependency(api, payload, repairWorkItemId) {
  const { commands, store } = await commandContext(api, payload)
  const test = await store.getWorkItem(workItemId('test'))
  assert(test)
  if (test.dependencyIds.includes(repairWorkItemId)) return
  await commands.updateWorkItem(test.id, {
    dependencyIds: [...test.dependencyIds, repairWorkItemId]
  }, { expectedRevision: test.revision })
}
