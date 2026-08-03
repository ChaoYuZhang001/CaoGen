import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  FLOW_ORDER,
  GOAL_ID,
  OWNER,
  PROJECT_ID,
  REVIEW_V2,
  artifactId,
  workItemId
} from './verified-delivery-flow-contract.mjs'

export const VERIFIER = 'verified-delivery-flow-required'

export async function commandContext(api, payload) {
  const store = await api.workspaceStore.openProjectWorkspaceStore(payload.rootDir)
  const commands = api.workspaceCommands.createProjectWorkspaceCommandService(store, {
    rootDir: payload.rootDir
  })
  await commands.reconcileShadowProjection()
  return { commands, store }
}

export async function workflowData(api, payload) {
  const [ledger, evidence] = await Promise.all([
    api.workflow.listPersistedWorkflowLedger({ projectId: PROJECT_ID, limit: 500 }, payload.rootDir),
    api.workflow.listWorkflowEvidence({ projectId: PROJECT_ID }, payload.rootDir)
  ])
  return { ledger, evidence }
}

export async function findAcceptance(api, payload, id) {
  const ledger = await api.workflow.listPersistedWorkflowLedger({
    projectId: PROJECT_ID,
    acceptanceId: id,
    limit: 500
  }, payload.rootDir)
  const acceptance = ledger.acceptances.items.find((item) => item.id === id)
  assert(acceptance, `acceptance ${id} is missing`)
  return acceptance
}

export async function requireLifecycle(api, payload, id) {
  const lifecycle = await api.lifecycle.getPersistedArtifactLifecycle(id, payload.rootDir)
  assert(lifecycle, `artifact lifecycle ${id} is missing`)
  return lifecycle
}

export async function ensureRun(api, payload, stage) {
  const existing = await api.snapshot.getTaskSnapshot(stage.sessionId, payload.rootDir)
  if (existing?.run) return existing.run
  const now = Date.now()
  const run = {
    schemaVersion: 1,
    id: stage.runId,
    sessionId: stage.sessionId,
    taskId: `verified-task-${stage.name}`,
    status: 'executing',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: now,
    updatedAt: now + 1,
    steps: [],
    toolExecutions: [],
    effects: []
  }
  const snapshot = api.snapshot.buildTaskSnapshot({
    meta: sessionMeta(stage, payload, run),
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run,
    now: run.updatedAt
  })
  const persisted = await api.snapshot.saveTaskSnapshot(snapshot, payload.rootDir)
  await attachRunReference(api, payload, stage.workItemId, stage.runId)
  assert(persisted.run)
  return persisted.run
}

export async function transitionPersistedRun(api, payload, sessionId, status, error) {
  const snapshot = await api.snapshot.getTaskSnapshot(sessionId, payload.rootDir)
  assert(snapshot?.run, `TaskRun for ${sessionId} is missing`)
  if (snapshot.run.status === status) return snapshot.run
  const now = Math.max(Date.now(), snapshot.run.updatedAt + 1)
  const run = api.taskRun.transitionTaskRun(snapshot.run, status, {
    now,
    ...(error === undefined ? {} : { error })
  })
  const persisted = await api.snapshot.saveTaskSnapshot({
    ...snapshot,
    updatedAt: Math.max(snapshot.updatedAt, run.updatedAt),
    run
  }, payload.rootDir)
  assert.equal(persisted.run?.status, status)
  return persisted.run
}

export async function markStageReady(api, payload, stageWorkItemId) {
  const { commands, store } = await commandContext(api, payload)
  const item = await store.getWorkItem(stageWorkItemId)
  assert(item)
  if (item.status === 'ready') return
  assert.equal(item.status, 'backlog')
  await commands.transitionWorkItem(item.id, 'ready', { expectedRevision: item.revision })
}

export async function finalizeWorkItem(api, payload, stage, decision) {
  const { commands, store } = await commandContext(api, payload)
  let current = await store.getWorkItem(stage.workItemId)
  assert(current)
  current = await commands.setWorkItemAcceptance(
    current.id,
    acceptanceResult(decision, stage.evidenceId),
    { expectedRevision: current.revision }
  )
  current = await acquireAndTransition(commands, current, 'running')
  current = await commands.transitionWorkItem(current.id, 'verifying', { expectedRevision: current.revision })
  current = await commands.transitionWorkItem(current.id, 'done', { expectedRevision: current.revision })
  assert.equal(current.status, 'done')
  return current
}

export async function acquireAndTransition(commands, item, status) {
  let current = item
  if (!current.lease) {
    current = await commands.acquireWorkItemLease(current.id, {
      expectedRevision: current.revision,
      ownerId: current.owner?.id ?? OWNER.id
    })
  }
  return commands.transitionWorkItem(current.id, status, { expectedRevision: current.revision })
}

export function acceptanceResult(decision, selectedEvidenceId) {
  if (decision === 'waived') {
    return {
      status: 'waived',
      evidenceRefs: [selectedEvidenceId],
      verifiedBy: VERIFIER,
      verifiedAt: Date.now(),
      waiverReason: 'authorized fixture waiver'
    }
  }
  return {
    status: 'passed',
    evidenceRefs: [selectedEvidenceId],
    verifiedBy: VERIFIER,
    verifiedAt: Date.now()
  }
}

export async function assertHandoffArtifact(api, payload, downstreamWorkItemId, expectedArtifactId) {
  const handoff = await api.handoff.resolveWorkflowStageHandoff({
    projectId: PROJECT_ID,
    workItemId: downstreamWorkItemId,
    rootDir: payload.rootDir
  })
  const item = handoff.artifacts.find((candidate) => candidate.artifact.id === expectedArtifactId)
  if (!item) {
    throw contractError(await classifyMissingHandoff(api, payload, downstreamWorkItemId, expectedArtifactId))
  }
  const prompt = await api.handoff.buildWorkflowStageHandoffPrompt(
    handoffSessionMeta(payload, downstreamWorkItemId),
    payload.rootDir
  )
  return { handoff, item, prompt }
}

export function assertPromptCarriesArtifact(prompt, item) {
  if (!prompt.includes(`artifactId: ${item.artifact.id}`)) throw contractError('HANDOFF_PROMPT_ID')
  if (!prompt.includes(`digest: ${item.artifact.digest}`)) throw contractError('HANDOFF_PROMPT_DIGEST')
  const location = item.location?.path ?? item.location?.uri
  if (!location || !prompt.includes(`location: ${location}`)) throw contractError('HANDOFF_PROMPT_LOCATION')
  if (!/do not ask the user to upload or restate them/i.test(prompt)) {
    throw contractError('HANDOFF_PROMPT_RESTATEMENT')
  }
}

export async function assertArtifactNotHandedOff(api, payload, blockedArtifactId, downstreamWorkItemId) {
  const handoff = await api.handoff.resolveWorkflowStageHandoff({
    projectId: PROJECT_ID,
    workItemId: downstreamWorkItemId,
    rootDir: payload.rootDir
  })
  assert(!handoff.artifacts.some((item) => item.artifact.id === blockedArtifactId))
}

export function evidenceAuthority() {
  return { source: 'runtime', verifier: VERIFIER, observedAt: Date.now() }
}

export function reviewAuthority() {
  return {
    actorId: 'verified-delivery-reviewer',
    verifier: VERIFIER,
    reviewedAt: Date.now()
  }
}

export function nextTimestamp(previous) {
  return Math.max(Date.now(), previous + 1)
}

export function bareDigest(value) {
  const match = /^sha256:([a-f0-9]{64})$/.exec(value)
  assert(match, 'sha256 digest is required')
  return match[1]
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function upstreamArtifactId(stageName) {
  if (stageName === 'test') return REVIEW_V2.artifactId
  const index = FLOW_ORDER.indexOf(stageName)
  if (index <= 0) throw new Error(`stage ${stageName} has no upstream stage`)
  const previous = FLOW_ORDER[index - 1] === 'repair' ? 'review' : FLOW_ORDER[index - 1]
  return artifactId(previous)
}

function sessionMeta(stage, payload, run) {
  return {
    id: run.sessionId,
    title: `${stage.title} verified-delivery run`,
    cwd: payload.workspaceRoot,
    projectId: PROJECT_ID,
    workspaceId: PROJECT_ID,
    goalId: GOAL_ID,
    workItemId: stage.workItemId,
    childTaskId: run.taskId,
    model: 'synthetic-verified-delivery-model',
    providerId: 'synthetic-verified-delivery-provider',
    permissionMode: 'default',
    status: 'running',
    sdkSessionId: `sdk-${run.id}`,
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt: run.createdAt
  }
}

async function attachRunReference(api, payload, stageWorkItemId, stageRunId) {
  const { commands, store } = await commandContext(api, payload)
  const item = await store.getWorkItem(stageWorkItemId)
  assert(item)
  if (item.runRefs.includes(stageRunId)) return
  await commands.updateWorkItem(item.id, {
    runRefs: [...item.runRefs, stageRunId]
  }, { expectedRevision: item.revision })
}

function handoffSessionMeta(payload, downstreamWorkItemId) {
  return {
    id: `handoff-${downstreamWorkItemId}`,
    title: 'Verified delivery handoff',
    cwd: payload.workspaceRoot,
    projectId: PROJECT_ID,
    workspaceId: PROJECT_ID,
    goalId: GOAL_ID,
    workItemId: downstreamWorkItemId,
    model: 'synthetic-verified-delivery-model',
    providerId: 'synthetic-verified-delivery-provider',
    permissionMode: 'default',
    status: 'running',
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt: 1
  }
}

function contractError(reason) {
  const error = new Error('verified-delivery handoff contract failed')
  Object.assign(error, { code: `VERIFIED_DELIVERY_${reason}` })
  return error
}

async function classifyMissingHandoff(api, payload, downstreamWorkItemId, expectedArtifactId) {
  const { ledger } = await workflowData(api, payload)
  const artifact = ledger.artifacts.items.find((item) => item.id === expectedArtifactId)
  if (!artifact) return 'HANDOFF_ARTIFACT_NOT_PERSISTED'
  const links = ledger.evidenceLinks.items.filter((item) => item.artifactId === expectedArtifactId)
  if (links.length === 0) return 'HANDOFF_ARTIFACT_LINK_MISSING'
  const acceptanceIds = new Set(links.map((item) => item.acceptanceId).filter(Boolean))
  if (acceptanceIds.size === 0) return 'HANDOFF_ACCEPTANCE_LINK_MISSING'
  const acceptances = ledger.acceptances.items.filter((item) => acceptanceIds.has(item.id))
  if (acceptances.length !== acceptanceIds.size) return 'HANDOFF_ACCEPTANCE_NOT_PERSISTED'
  if (!acceptances.every((item) => item.status === 'passed' || item.status === 'waived')) {
    return 'HANDOFF_ACCEPTANCE_NOT_TERMINAL'
  }
  const { store } = await commandContext(api, payload)
  const downstream = await store.getWorkItem(downstreamWorkItemId)
  if (!downstream?.dependencyIds.includes(artifact.workItemId)) return 'HANDOFF_DEPENDENCY_MISSING'
  const locations = await api.workflow.listWorkflowArtifactLocations({
    projectId: PROJECT_ID,
    artifactId: expectedArtifactId,
    limit: 500
  }, payload.rootDir)
  if (!locations.items.some((location) => location.availability === 'available')) {
    return 'HANDOFF_LOCATION_UNAVAILABLE'
  }
  return 'HANDOFF_ARTIFACT_FILTERED'
}
