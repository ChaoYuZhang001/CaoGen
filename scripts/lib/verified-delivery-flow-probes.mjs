import assert from 'node:assert/strict'
import {
  FLOW_ORDER,
  GOAL_ID,
  PROJECT_ID,
  REPORT_GENERATED_AT,
  REVIEW_FAILURE_CANARY,
  REVIEW_V2,
  artifactId,
  stageByName,
  workItemId
} from './verified-delivery-flow-contract.mjs'
import {
  buildEvidenceChainDigest,
  buildOwnershipDigest
} from './verified-delivery-flow-runtime.mjs'
import {
  assertArtifactNotHandedOff,
  assertHandoffArtifact,
  assertPromptCarriesArtifact,
  commandContext,
  findAcceptance,
  requireLifecycle,
  workflowData
} from './verified-delivery-flow-support.mjs'

export async function runProbe(api, payload) {
  switch (payload.checkpoint) {
    case 'artifact': return probeResearchArtifact(api, payload)
    case 'evidence': return probeResearchEvidence(api, payload)
    case 'acceptance': return probeResearchAcceptance(api, payload)
    case 'link': return probeResearchLink(api, payload)
    case 'attachment': return probeResearchAttachment(api, payload)
    case 'failed-review': return probeFailedReview(api, payload)
    case 'repaired-review': return probeRepairedReview(api, payload)
    default: throw probeError(payload.checkpoint)
  }
}

export async function finalReadback(api, payload) {
  const ledgerVerification = await api.workflow.verifyPersistedWorkflowLedger(payload.rootDir)
  const evidenceVerification = await api.workflow.verifyWorkflowEvidence(payload.rootDir)
  const lifecycleVerification = await api.lifecycle.verifyPersistedArtifactLifecycle(payload.rootDir)
  const aggregate = await api.aggregate.createProductionProjectAggregateService(payload.rootDir)
    .verifyLiveProject(PROJECT_ID)
  const { store } = await commandContext(api, payload)
  const workItems = await store.listWorkItems(PROJECT_ID)
  const ledger = await api.workflow.listPersistedWorkflowLedger(
    { projectId: PROJECT_ID, limit: 500 },
    payload.rootDir
  )
  const evidence = await api.workflow.listWorkflowEvidence({ projectId: PROJECT_ID }, payload.rootDir)
  assertFinalCounts({ aggregate, evidence, ledger, lifecycleVerification, workItems })
  assert(JSON.stringify(aggregate).includes(REVIEW_FAILURE_CANARY))
  const studioSnapshot = api.studioResult.buildStudioResultSnapshot(
    reportSession(payload),
    aggregate,
    [],
    REPORT_GENERATED_AT
  )
  const studioExport = api.studioResult.buildStudioResultExport(studioSnapshot)
  assert.equal(studioSnapshot.state, 'ready')
  assert.equal(studioSnapshot.scope.level, 'goal')
  assert.equal(studioSnapshot.summary.runs, 8)
  assert.equal(studioSnapshot.summary.artifacts, 8)
  assert.equal(studioSnapshot.verification.sanitized, true)
  assert.match(studioExport.exportDigest, /^sha256:[a-f0-9]{64}$/)
  assert(!studioExport.json.includes(REVIEW_FAILURE_CANARY))
  assert(studioExport.json.includes('errorDigest'))
  return {
    flowOrder: FLOW_ORDER,
    artifacts: lifecycleVerification.artifacts,
    evidence: evidenceVerification.count,
    acceptances: ledgerVerification.acceptances,
    workItems: workItems.length,
    runs: ledger.runs.items.length,
    completedRuns: ledger.runs.items.filter((run) => run.status === 'completed').length,
    failedRuns: ledger.runs.items.filter((run) => run.status === 'failed').length,
    runErrors: ledger.runs.items.filter((run) => run.error !== undefined).length,
    ownershipDigest: buildOwnershipDigest(workItems, ledger.runs.items),
    evidenceChainDigest: buildEvidenceChainDigest(evidence, ledger),
    deliveryReportDigest: studioExport.exportDigest,
    deliveryResultDigest: studioSnapshot.verification.resultDigest,
    reportSanitized: studioSnapshot.verification.sanitized,
    ledgerValid: ledgerVerification.valid,
    lifecycleValid: lifecycleVerification.valid
  }
}

async function probeResearchArtifact(api, payload) {
  const stage = stageByName('research')
  assert(await api.lifecycle.getPersistedArtifactLifecycle(stage.artifactId, payload.rootDir))
  const data = await workflowData(api, payload)
  assert(!data.evidence.some((item) => item.evidenceId === stage.evidenceId))
  assert(!data.ledger.acceptances.items.some((item) => item.id === stage.acceptanceId))
  await assertArtifactNotHandedOff(api, payload, stage.artifactId, workItemId('requirements'))
  return { checkpoint: 'artifact', durable: true, downstreamBlocked: true }
}

async function probeResearchEvidence(api, payload) {
  const stage = stageByName('research')
  const data = await workflowData(api, payload)
  assert(data.evidence.some((item) => item.evidenceId === stage.evidenceId))
  assert(!data.ledger.acceptances.items.some((item) => item.id === stage.acceptanceId))
  assert(!data.ledger.evidenceLinks.items.some((item) => item.id === stage.evidenceLinkId))
  return { checkpoint: 'evidence', durable: true }
}

async function probeResearchAcceptance(api, payload) {
  const stage = stageByName('research')
  const data = await workflowData(api, payload)
  const acceptance = data.ledger.acceptances.items.find((item) => item.id === stage.acceptanceId)
  assert.equal(acceptance?.status, 'pending')
  assert(!data.ledger.evidenceLinks.items.some((item) => item.id === stage.evidenceLinkId))
  await assertArtifactNotHandedOff(api, payload, stage.artifactId, workItemId('requirements'))
  return { checkpoint: 'acceptance', durable: true, downstreamBlocked: true }
}

async function probeResearchLink(api, payload) {
  const stage = stageByName('research')
  const data = await workflowData(api, payload)
  assert(data.ledger.evidenceLinks.items.some((item) => item.id === stage.evidenceLinkId))
  assert.equal(data.ledger.acceptances.items.find((item) => item.id === stage.acceptanceId)?.status, 'pending')
  await assertArtifactNotHandedOff(api, payload, stage.artifactId, workItemId('requirements'))
  return { checkpoint: 'link', durable: true, downstreamBlocked: true }
}

async function probeResearchAttachment(api, payload) {
  const stage = stageByName('research')
  const { store } = await commandContext(api, payload)
  const workItem = await store.getWorkItem(stage.workItemId)
  assert.equal(workItem?.status, 'done')
  assert(workItem?.artifactRefs.includes(stage.artifactId))
  const handoff = await assertHandoffArtifact(api, payload, workItemId('requirements'), stage.artifactId)
  assertPromptCarriesArtifact(handoff.prompt, handoff.item)
  return { checkpoint: 'workitem_attachment', durable: true, downstreamAllowed: true }
}

async function probeFailedReview(api, payload) {
  const stage = stageByName('review')
  const failed = await findAcceptance(api, payload, stage.acceptanceId)
  assert.equal(failed.status, 'failed')
  const repairId = api.repair.workflowAcceptanceRepairWorkItemId(failed.id, failed.revision)
  const repairAcceptanceId = api.repair.workflowAcceptanceRepairAcceptanceId(repairId)
  const { store } = await commandContext(api, payload)
  assert(await store.getWorkItem(repairId))
  assert.equal((await findAcceptance(api, payload, repairAcceptanceId)).status, 'pending')
  const { ledger } = await workflowData(api, payload)
  assert(ledger.evidenceLinks.items.some((link) =>
    link.artifactId === stage.artifactId && link.acceptanceId === failed.id
  ))
  await assertArtifactNotHandedOff(api, payload, stage.artifactId, workItemId('test'))
  return { checkpoint: 'failed_acceptance', repairWorkItemCreated: true, repairAcceptanceCreated: true }
}

async function probeRepairedReview(api, payload) {
  const oldLifecycle = await requireLifecycle(api, payload, artifactId('review'))
  const nextLifecycle = await requireLifecycle(api, payload, REVIEW_V2.artifactId)
  assert.equal(nextLifecycle.version, oldLifecycle.version + 1)
  assert.equal(nextLifecycle.supersedesId, oldLifecycle.artifactId)
  const graph = await api.workflow.queryWorkflowArtifactGraph(REVIEW_V2.artifactId, payload.rootDir)
  assert(graph.outbound.some((edge) =>
    edge.relation === 'supersedes' && edge.toArtifactId === oldLifecycle.artifactId
  ))
  const handoff = await assertHandoffArtifact(api, payload, workItemId('test'), REVIEW_V2.artifactId)
  assert(!handoff.handoff.artifacts.some((item) => item.artifact.id === oldLifecycle.artifactId))
  assertPromptCarriesArtifact(handoff.prompt, handoff.item)
  const verification = await api.lifecycle.verifyPersistedArtifactLifecycle(payload.rootDir)
  assert(verification.artifacts >= 6)
  return { checkpoint: 'repaired_review', version: 2, historyPreserved: true, bytesVerified: true }
}

function assertFinalCounts(input) {
  assert.equal(input.lifecycleVerification.artifacts, 8)
  assert.equal(input.evidence.length, 9)
  assert.equal(input.ledger.acceptances.items.length, 8)
  assert.equal(input.workItems.length, 8)
  assert.equal(input.ledger.runs.items.length, 8)
  assert(input.workItems.every((item) => item.status === 'done'))
  assert.equal(input.ledger.runs.items.filter((run) => run.status === 'completed').length, 7)
  assert.equal(input.ledger.runs.items.filter((run) => run.status === 'failed').length, 1)
  assert.equal(
    input.ledger.runs.items.filter((run) => run.error === REVIEW_FAILURE_CANARY).length,
    1
  )
  assert.equal(input.aggregate.workflow.artifacts.length, 8)
  assert(input.ledger.acceptances.items.every((item) => item.status === 'passed' || item.status === 'waived'))
}

function reportSession(payload) {
  return {
    id: 'verified-delivery-report-session',
    title: 'Verified delivery report',
    cwd: payload.workspaceRoot,
    projectId: PROJECT_ID,
    workspaceId: PROJECT_ID,
    goalId: GOAL_ID,
    model: 'synthetic-verified-delivery-model',
    providerId: 'synthetic-verified-delivery-provider',
    permissionMode: 'default',
    status: 'idle',
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt: 1
  }
}

function probeError(checkpoint) {
  const error = new Error('unknown verified-delivery checkpoint')
  Object.assign(error, {
    code: `VERIFIED_DELIVERY_PROBE_${String(checkpoint).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
  })
  return error
}
