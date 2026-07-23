import { createHash } from 'node:crypto'
import type {
  WorkflowAcceptanceRecord,
  WorkflowEvidenceInput,
  WorkflowEvidenceLinkInput,
  WorkflowEvidenceLinkRecord,
  WorkflowEvidenceRecord,
  WorkflowRunRecord
} from '../../shared/workflow-types'
import { mutateTaskSnapshotDatabase } from './task-snapshot'
import { assertWorkflowEvidenceEventCoverage } from './workflow-evidence-event-coverage'
import {
  appendWorkflowEvidence,
  listWorkflowEvidence,
  setupWorkflowEvidenceSchema
} from './workflow-evidence-store'
import {
  findWorkflowAcceptance,
  findWorkflowRun,
  findWorkflowWorkItem,
  readAcceptances,
  readAndVerifyEvents
} from './workflow-ledger-query'
import {
  appendWorkflowEvent,
  linkWorkflowEvidence,
  projectWorkflowAcceptance,
  setupWorkflowLedgerSchema
} from './workflow-ledger-store'
import { materializeWorkflowAcceptanceRepair } from './workflow-acceptance-repair-service'
import {
  matchingAcceptanceCriterionIndexes,
  workflowAcceptanceCriterionId
} from './workflow-acceptance-criterion-policy'

const FAILURE_NAMESPACE = 'caogen.workflow-acceptance-failure.v1'
const ACTOR_PREFIX = 'workflow-acceptance-failure'

export type WorkflowAcceptanceFailureSourceKind = 'cross_validation' | 'test'
interface FailureInputBase {
  sourceEventId: string; projectId: string; goalId?: string; workItemId: string; acceptanceId?: string
  acceptanceRevision?: number; runId?: string
  criterionIndexes?: number[]; title: string; summary?: string; verifier: string; observedAt: number; contentDigest: string
}
export type WorkflowAcceptanceFailureInput =
  | (FailureInputBase & { sourceKind: 'cross_validation'; verdict: 'concerns' | 'blocked' })
  | (FailureInputBase & { sourceKind: 'test'; outcome: 'failed'; exitCode?: number })
export interface WorkflowAcceptanceFailureAudit {
  gate: 'workflow_acceptance_failure_ingress'; authority: 'system'; sourceKind: WorkflowAcceptanceFailureSourceKind
  sourceEventId: string; acceptanceId: string; acceptanceRevision: number; projectId: string; goalId?: string; workItemId: string
  evidenceId: string; actorId: string
}
export interface WorkflowAcceptanceFailurePersistenceResult {
  acceptance: WorkflowAcceptanceRecord; evidence: WorkflowEvidenceRecord; evidenceLinks: WorkflowEvidenceLinkRecord[]
  audit: WorkflowAcceptanceFailureAudit; replayed: boolean
}
export interface WorkflowAcceptanceFailureResult extends WorkflowAcceptanceFailurePersistenceResult {
  repair: { workItemId: string; acceptanceId: string; failedAcceptanceRevision: number; disposition: 'created' | 'existing' }
}

export type WorkflowAcceptanceFailureIngressErrorCode =
  | 'WORKFLOW_FAILURE_INPUT_INVALID'
  | 'WORKFLOW_FAILURE_TARGET_NOT_FOUND'
  | 'WORKFLOW_FAILURE_TARGET_AMBIGUOUS'
  | 'WORKFLOW_FAILURE_PROJECT_BOUNDARY'
  | 'WORKFLOW_FAILURE_GOAL_BOUNDARY'
  | 'WORKFLOW_FAILURE_WORK_ITEM_BOUNDARY'
  | 'WORKFLOW_FAILURE_RUN_BOUNDARY'
  | 'WORKFLOW_FAILURE_TRANSITION_INVALID'
  | 'WORKFLOW_FAILURE_REPLAY_CONFLICT'

export class WorkflowAcceptanceFailureIngressError extends Error {
  constructor(
    readonly code: WorkflowAcceptanceFailureIngressErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message)
    this.name = 'WorkflowAcceptanceFailureIngressError'
  }
}

type NormalizedFailureInput = WorkflowAcceptanceFailureInput
interface FailureTargetBinding { acceptanceId: string; acceptanceRevision: number }

export async function ingestWorkflowAcceptanceFailure(
  rawInput: WorkflowAcceptanceFailureInput | unknown,
  rootDir?: string
): Promise<WorkflowAcceptanceFailureResult> {
  const persisted = await persistWorkflowAcceptanceFailure(rawInput, rootDir)
  const materialized = await materializeWorkflowAcceptanceRepair(persisted.acceptance, rootDir)
  return {
    ...persisted,
    repair: {
      workItemId: materialized.repair.repairWorkItemId,
      acceptanceId: materialized.repair.repairAcceptanceId,
      failedAcceptanceRevision: materialized.repair.failedAcceptanceRevision,
      disposition: materialized.repair.disposition
    }
  }
}

/** Durable transaction boundary used by startup-recovery tests and the full ingress. */
export async function persistWorkflowAcceptanceFailure(
  rawInput: WorkflowAcceptanceFailureInput | unknown,
  rootDir?: string
): Promise<WorkflowAcceptanceFailurePersistenceResult> {
  const input = normalizeFailureInput(rawInput)
  return mutateTaskSnapshotDatabase(rootDir, (db) => {
    setupWorkflowLedgerSchema(db)
    setupWorkflowEvidenceSchema(db)
    const workItem = requireBoundWorkItem(db, input)
    const domainInput: NormalizedFailureInput = input.goalId === undefined && workItem.goalId !== undefined
      ? { ...input, goalId: workItem.goalId }
      : input
    const boundRun = assertBoundRun(db, domainInput, workItem.goalId)
    const evidenceId = workflowAcceptanceFailureEvidenceId(domainInput.sourceKind, domainInput.sourceEventId)
    const existingEvidence = listWorkflowEvidence(db, { evidenceId }).at(0)
    const targetBinding = existingEvidence
      ? undefined
      : resolveFailureTargetBinding(db, domainInput, boundRun)
    const acceptance = existingEvidence
      ? acceptanceFromReplay(db, domainInput, existingEvidence, boundRun)
      : resolveBoundAcceptance(db, domainInput, targetBinding!)
    const sourceAcceptanceRevision = existingEvidence
      ? replayBinding(existingEvidence, domainInput).sourceAcceptanceRevision
      : targetBinding!.acceptanceRevision
    const criterionIndexes = resolveCriterionIndexes(
      domainInput.criterionIndexes,
      acceptance,
      domainInput.sourceKind === 'cross_validation' ? 'review_result' : 'test_result'
    )
    const failedAcceptanceRevision = existingEvidence
      ? acceptance.revision
      : acceptance.revision + (acceptance.status === 'pending' ? 2 : 1)
    const evidenceInput = buildEvidenceInput(
      domainInput,
      workItem.goalId,
      acceptance.id,
      sourceAcceptanceRevision,
      failedAcceptanceRevision,
      criterionIndexes
    )
    let evidence: WorkflowEvidenceRecord
    try {
      evidence = appendWorkflowEvidence(db, evidenceInput, {
        source: 'runtime',
        verifier: domainInput.verifier,
        observedAt: domainInput.observedAt,
        createdAt: domainInput.observedAt
      })
    } catch (error) {
      if (!existingEvidence) throw error
      failure(
        'WORKFLOW_FAILURE_REPLAY_CONFLICT',
        `source event ${domainInput.sourceEventId} maps to different immutable failure evidence`,
        domainInput,
        { cause: error instanceof Error ? error.message : String(error) }
      )
    }
    appendEvidenceEvent(db, evidence)
    const evidenceLinks = linkFailureEvidence(db, domainInput, acceptance, evidence, criterionIndexes)

    if (existingEvidence) {
      assertReplayState(acceptance, evidenceLinks, criterionIndexes)
      const audit = buildAudit(domainInput, acceptance, evidence.evidenceId)
      appendAuditEvent(db, audit, domainInput)
      assertWorkflowEvidenceEventCoverage([evidence], readAndVerifyEvents(db))
      return { acceptance, evidence, evidenceLinks, audit, replayed: true }
    }

    const failed = projectFailureAcceptance(db, domainInput, acceptance, evidence.evidenceId, criterionIndexes)
    const audit = buildAudit(domainInput, failed, evidence.evidenceId)
    appendAuditEvent(db, audit, domainInput)
    assertWorkflowEvidenceEventCoverage([evidence], readAndVerifyEvents(db))
    return { acceptance: failed, evidence, evidenceLinks, audit, replayed: false }
  })
}

export function workflowAcceptanceFailureEvidenceId(sourceKind: string, sourceEventId: string): string {
  // A producer event id is unique within its source kind; different source protocols may reuse the same native id.
  return `acceptance-failure:${hash(`${FAILURE_NAMESPACE}\0${sourceKind}\0${sourceEventId}`)}`
}

export function workflowAcceptanceFailureLinkId(
  evidenceId: string,
  acceptanceId: string,
  criterionIndex: number
): string {
  return `acceptance-failure-link:${hash(`${FAILURE_NAMESPACE}\0${evidenceId}\0${acceptanceId}\0${criterionIndex}`)}`
}

function requireBoundWorkItem(
  db: Parameters<typeof findWorkflowWorkItem>[0],
  input: NormalizedFailureInput
) {
  const workItem = findWorkflowWorkItem(db, input.workItemId)
  if (!workItem) failure('WORKFLOW_FAILURE_TARGET_NOT_FOUND', `WorkItem ${input.workItemId} was not found`, input)
  if (workItem.projectId !== input.projectId) {
    failure('WORKFLOW_FAILURE_PROJECT_BOUNDARY', `WorkItem ${input.workItemId} crosses the failure Project boundary`, input)
  }
  if (input.goalId !== undefined && workItem.goalId !== input.goalId) {
    failure('WORKFLOW_FAILURE_GOAL_BOUNDARY', `WorkItem ${input.workItemId} crosses the failure Goal boundary`, input)
  }
  if (input.sourceKind === 'test' && workItem.type !== 'testing') {
    failure('WORKFLOW_FAILURE_WORK_ITEM_BOUNDARY', `test failure requires a testing WorkItem; ${workItem.id} is ${workItem.type}`, input)
  }
  return workItem
}

function assertBoundRun(
  db: Parameters<typeof findWorkflowRun>[0],
  input: NormalizedFailureInput,
  workItemGoalId: string | undefined
): WorkflowRunRecord | undefined {
  if (!input.runId) return undefined
  const run = findWorkflowRun(db, input.runId)
  if (!run) failure('WORKFLOW_FAILURE_TARGET_NOT_FOUND', `Run ${input.runId} was not found`, input)
  if (run.projectId !== input.projectId || run.workItemId !== input.workItemId || run.goalId !== workItemGoalId) {
    failure('WORKFLOW_FAILURE_RUN_BOUNDARY', `Run ${input.runId} crosses the failure domain boundary`, input)
  }
  return run
}

function resolveFailureTargetBinding(
  db: Parameters<typeof readAcceptances>[0],
  input: NormalizedFailureInput,
  run: WorkflowRunRecord | undefined
): FailureTargetBinding {
  if (run) {
    if (!run.acceptanceId || !run.acceptanceRevision) {
      failure(
        'WORKFLOW_FAILURE_RUN_BOUNDARY',
        `Run ${run.id} has no immutable Acceptance revision binding`,
        input,
        { reason: 'run_acceptance_binding_missing' }
      )
    }
    if ((input.acceptanceId && input.acceptanceId !== run.acceptanceId) ||
        (input.acceptanceRevision && input.acceptanceRevision !== run.acceptanceRevision)) {
      failure(
        'WORKFLOW_FAILURE_RUN_BOUNDARY',
        `Run ${run.id} Acceptance revision binding differs from the failure input`,
        input,
        {
          reason: 'run_acceptance_binding_mismatch',
          runAcceptanceId: run.acceptanceId,
          runAcceptanceRevision: run.acceptanceRevision
        }
      )
    }
    return { acceptanceId: run.acceptanceId, acceptanceRevision: run.acceptanceRevision }
  }

  if (input.acceptanceId && input.acceptanceRevision) {
    return { acceptanceId: input.acceptanceId, acceptanceRevision: input.acceptanceRevision }
  }

  const attached = readAcceptances(db).filter((candidate) =>
    candidate.projectId === input.projectId &&
    candidate.workItemId === input.workItemId &&
    (input.goalId === undefined || candidate.goalId === input.goalId)
  )
  const active = attached.filter((candidate) => candidate.status === 'pending' || candidate.status === 'verifying')
  if (active.length > 1) {
    failure('WORKFLOW_FAILURE_TARGET_AMBIGUOUS', `WorkItem ${input.workItemId} has ${active.length} active Acceptances`, input, {
      acceptanceIds: active.map((candidate) => candidate.id).sort()
    })
  }
  failure(
    'WORKFLOW_FAILURE_INPUT_INVALID',
    'failure input requires an immutable Run binding or explicit Acceptance ID and revision',
    input,
    { reason: 'acceptance_revision_binding_missing' }
  )
}

function resolveBoundAcceptance(
  db: Parameters<typeof readAcceptances>[0],
  input: NormalizedFailureInput,
  binding: FailureTargetBinding
): WorkflowAcceptanceRecord {
  const acceptance = readAcceptances(db).find((candidate) =>
    candidate.id === binding.acceptanceId &&
    candidate.projectId === input.projectId &&
    candidate.workItemId === input.workItemId &&
    (input.goalId === undefined || candidate.goalId === input.goalId)
  )
  if (!acceptance) {
    failure('WORKFLOW_FAILURE_TARGET_NOT_FOUND', `Acceptance ${binding.acceptanceId} was not found in the failure domain`, input)
  }
  if (acceptance.revision !== binding.acceptanceRevision) {
    failure(
      'WORKFLOW_FAILURE_TRANSITION_INVALID',
      `Acceptance ${acceptance.id} revision ${binding.acceptanceRevision} is stale; current revision is ${acceptance.revision}`,
      input,
      {
        reason: 'acceptance_revision_stale',
        expectedAcceptanceRevision: binding.acceptanceRevision,
        currentAcceptanceRevision: acceptance.revision
      }
    )
  }
  assertFailureTransition(acceptance, input)
  return acceptance
}

function acceptanceFromReplay(
  db: Parameters<typeof findWorkflowAcceptance>[0],
  input: NormalizedFailureInput,
  evidence: WorkflowEvidenceRecord,
  run: WorkflowRunRecord | undefined
): WorkflowAcceptanceRecord {
  const binding = replayBinding(evidence, input)
  const acceptance = findWorkflowAcceptance(db, binding.acceptanceId)
  if (!acceptance) failure('WORKFLOW_FAILURE_REPLAY_CONFLICT', `failure evidence ${evidence.evidenceId} references a missing Acceptance`, input)
  assertAcceptanceBinding(acceptance, input)
  if (input.acceptanceId && acceptance.id !== input.acceptanceId) {
    failure('WORKFLOW_FAILURE_REPLAY_CONFLICT', `source event ${input.sourceEventId} was already bound to another Acceptance`, input)
  }
  if (input.acceptanceRevision && binding.sourceAcceptanceRevision !== undefined &&
      input.acceptanceRevision !== binding.sourceAcceptanceRevision) {
    failure('WORKFLOW_FAILURE_REPLAY_CONFLICT', `source event ${input.sourceEventId} changed its Acceptance revision binding`, input)
  }
  if (run?.acceptanceId && (run.acceptanceId !== binding.acceptanceId ||
      (binding.sourceAcceptanceRevision !== undefined && run.acceptanceRevision !== binding.sourceAcceptanceRevision))) {
    failure('WORKFLOW_FAILURE_REPLAY_CONFLICT', `source event ${input.sourceEventId} differs from its Run Acceptance binding`, input)
  }
  if (acceptance.status !== 'failed' || acceptance.revision !== binding.failedAcceptanceRevision) {
    failure(
      'WORKFLOW_FAILURE_REPLAY_CONFLICT',
      `source event ${input.sourceEventId} belongs to Acceptance ${acceptance.id} revision ${binding.failedAcceptanceRevision}, not current revision ${acceptance.revision}`,
      input,
      { failedAcceptanceRevision: binding.failedAcceptanceRevision, currentAcceptanceRevision: acceptance.revision }
    )
  }
  return acceptance
}

function replayBinding(
  evidence: WorkflowEvidenceRecord,
  input: NormalizedFailureInput
): { acceptanceId: string; sourceAcceptanceRevision?: number; failedAcceptanceRevision: number; criterionIndexes: number[] } {
  const metadata = evidence.metadata
  const acceptanceId = metadata?.acceptanceId
  const failedAcceptanceRevision = metadata?.failedAcceptanceRevision
  const sourceAcceptanceRevision = metadata?.sourceAcceptanceRevision
  const criterionIndexes = metadata?.criterionIndexes
  if (typeof acceptanceId !== 'string' || !acceptanceId.trim() ||
      !Number.isSafeInteger(failedAcceptanceRevision) || (failedAcceptanceRevision as number) < 1 ||
      !Array.isArray(criterionIndexes) || criterionIndexes.length === 0 ||
      (sourceAcceptanceRevision !== undefined &&
        (!Number.isSafeInteger(sourceAcceptanceRevision) || (sourceAcceptanceRevision as number) < 1)) ||
      criterionIndexes.some((index) => !Number.isSafeInteger(index) || (index as number) < 0)) {
    failure('WORKFLOW_FAILURE_REPLAY_CONFLICT', `failure evidence ${evidence.evidenceId} has invalid replay metadata`, input)
  }
  return {
    acceptanceId: acceptanceId.trim(),
    ...(sourceAcceptanceRevision === undefined ? {} : { sourceAcceptanceRevision: sourceAcceptanceRevision as number }),
    failedAcceptanceRevision: failedAcceptanceRevision as number,
    criterionIndexes: criterionIndexes as number[]
  }
}

function assertAcceptanceBinding(acceptance: WorkflowAcceptanceRecord, input: NormalizedFailureInput): void {
  if (acceptance.projectId !== input.projectId) failure('WORKFLOW_FAILURE_PROJECT_BOUNDARY', 'Acceptance crosses the failure Project boundary', input)
  if (acceptance.workItemId !== input.workItemId) failure('WORKFLOW_FAILURE_WORK_ITEM_BOUNDARY', 'Acceptance crosses the failure WorkItem boundary', input)
  if (input.goalId !== undefined && acceptance.goalId !== input.goalId) {
    failure('WORKFLOW_FAILURE_GOAL_BOUNDARY', 'Acceptance crosses the failure Goal boundary', input)
  }
}

function assertFailureTransition(acceptance: WorkflowAcceptanceRecord, input: NormalizedFailureInput): void {
  assertAcceptanceBinding(acceptance, input)
  if (acceptance.status !== 'pending' && acceptance.status !== 'verifying') {
    failure(
      'WORKFLOW_FAILURE_TRANSITION_INVALID',
      `Acceptance ${acceptance.id} cannot ingest a failure from ${acceptance.status}`,
      input,
      { acceptanceId: acceptance.id, fromStatus: acceptance.status }
    )
  }
}

function buildEvidenceInput(
  input: NormalizedFailureInput,
  goalId: string | undefined,
  acceptanceId: string,
  sourceAcceptanceRevision: number | undefined,
  failedAcceptanceRevision: number,
  criterionIndexes: readonly number[]
): WorkflowEvidenceInput {
  const binding = {
    acceptanceId,
    ...(sourceAcceptanceRevision === undefined ? {} : { sourceAcceptanceRevision }),
    failedAcceptanceRevision,
    criterionIndexes: [...criterionIndexes]
  }
  return {
    evidenceId: workflowAcceptanceFailureEvidenceId(input.sourceKind, input.sourceEventId),
    projectId: input.projectId,
    ...(goalId === undefined ? {} : { goalId }),
    workItemId: input.workItemId,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    kind: input.sourceKind === 'cross_validation' ? 'review_result' : 'test_result',
    source: 'runtime',
    title: input.title,
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    verifier: input.verifier,
    observedAt: input.observedAt,
    contentDigest: input.contentDigest,
    metadata: input.sourceKind === 'cross_validation'
      ? { ...binding, sourceEventId: input.sourceEventId, sourceKind: input.sourceKind, verdict: input.verdict }
      : {
          ...binding,
          sourceEventId: input.sourceEventId,
          sourceKind: input.sourceKind,
          outcome: input.outcome,
          ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode })
        }
  }
}

function appendEvidenceEvent(db: Parameters<typeof appendWorkflowEvent>[0], evidence: WorkflowEvidenceRecord): void {
  appendWorkflowEvent(db, {
    eventId: `workflow:evidence-record:${evidence.evidenceId}`,
    streamId: evidence.runId ? `run:${evidence.runId}` : `project:${evidence.projectId}`,
    entityType: 'system',
    entityId: evidence.evidenceId,
    kind: 'workflow.evidence.recorded',
    payload: { ...evidence },
    occurredAt: evidence.createdAt,
    correlationId: evidence.runId ?? evidence.workItemId ?? evidence.goalId ?? evidence.evidenceId
  }, {
    projectId: evidence.projectId,
    goalId: evidence.goalId,
    workItemId: evidence.workItemId,
    runId: evidence.runId
  })
}

function linkFailureEvidence(
  db: Parameters<typeof linkWorkflowEvidence>[0],
  input: NormalizedFailureInput,
  acceptance: WorkflowAcceptanceRecord,
  evidence: WorkflowEvidenceRecord,
  criterionIndexes: readonly number[]
): WorkflowEvidenceLinkRecord[] {
  return criterionIndexes.map((criterionIndex) => linkWorkflowEvidence(db, buildLinkInput(
    input, acceptance, evidence, criterionIndex
  )))
}

function buildLinkInput(
  input: NormalizedFailureInput,
  acceptance: WorkflowAcceptanceRecord,
  evidence: WorkflowEvidenceRecord,
  criterionIndex: number
): WorkflowEvidenceLinkInput {
  return {
    id: workflowAcceptanceFailureLinkId(evidence.evidenceId, acceptance.id, criterionIndex),
    evidenceId: evidence.evidenceId,
    projectId: input.projectId,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    acceptanceId: acceptance.id,
    criterionId: workflowAcceptanceCriterionId(acceptance, criterionIndex),
    evidenceOrigin: 'workflow',
    relation: 'verifies',
    createdAt: evidence.createdAt
  }
}

function projectFailureAcceptance(
  db: Parameters<typeof projectWorkflowAcceptance>[0],
  input: NormalizedFailureInput,
  acceptance: WorkflowAcceptanceRecord,
  evidenceId: string,
  criterionIndexes: readonly number[]
): WorkflowAcceptanceRecord {
  assertFailureTransition(acceptance, input)
  const updatedAt = Math.max(input.observedAt, acceptance.updatedAt)
  const common = {
    ...acceptance,
    evidenceRefs: [...new Set([...acceptance.evidenceRefs, evidenceId])],
    criterionEvidence: mergeCriterionEvidence(acceptance, criterionIndexes, evidenceId),
    verifier: undefined,
    verifiedAt: undefined,
    waiverReason: undefined,
    waivedBy: undefined,
    updatedAt
  }
  let revision = acceptance.revision
  if (acceptance.status === 'pending') {
    revision += 1
    projectWorkflowAcceptance(db, { ...common, status: 'verifying', revision }, failureAuthority(input))
  }
  revision += 1
  return projectWorkflowAcceptance(db, {
    ...common,
    status: 'failed',
    verifier: input.verifier,
    verifiedAt: input.observedAt,
    revision
  }, failureAuthority(input))
}

function mergeCriterionEvidence(
  acceptance: WorkflowAcceptanceRecord,
  criterionIndexes: readonly number[],
  evidenceId: string
): NonNullable<WorkflowAcceptanceRecord['criterionEvidence']> {
  const byIndex = new Map((acceptance.criterionEvidence ?? []).map((item) => [item.criterionIndex, {
    ...item,
    evidenceRefs: [...item.evidenceRefs]
  }]))
  for (const criterionIndex of criterionIndexes) {
    const existing = byIndex.get(criterionIndex)
    byIndex.set(criterionIndex, {
      criterionId: existing?.criterionId ?? workflowAcceptanceCriterionId(acceptance, criterionIndex),
      criterionIndex,
      evidenceRefs: [...new Set([...(existing?.evidenceRefs ?? []), evidenceId])]
    })
  }
  return [...byIndex.values()].sort((left, right) => left.criterionIndex - right.criterionIndex)
}

function assertReplayState(
  acceptance: WorkflowAcceptanceRecord,
  evidenceLinks: readonly WorkflowEvidenceLinkRecord[],
  criterionIndexes: readonly number[]
): void {
  if (acceptance.status !== 'failed') {
    throw new WorkflowAcceptanceFailureIngressError(
      'WORKFLOW_FAILURE_REPLAY_CONFLICT',
      `failure replay requires the bound Acceptance to remain failed; found ${acceptance.status}`,
      { acceptanceId: acceptance.id, acceptanceRevision: acceptance.revision }
    )
  }
  const linkedCriteria = evidenceLinks.map((link) => link.criterionId).sort()
  const expectedCriteria = criterionIndexes.map((index) => workflowAcceptanceCriterionId(acceptance, index)).sort()
  if (JSON.stringify(linkedCriteria) !== JSON.stringify(expectedCriteria)) {
    throw new WorkflowAcceptanceFailureIngressError(
      'WORKFLOW_FAILURE_REPLAY_CONFLICT',
      `failure replay changed criterion coverage for Acceptance ${acceptance.id}`,
      { acceptanceId: acceptance.id }
    )
  }
}

function buildAudit(
  input: NormalizedFailureInput,
  acceptance: WorkflowAcceptanceRecord,
  evidenceId: string
): WorkflowAcceptanceFailureAudit {
  return {
    gate: 'workflow_acceptance_failure_ingress',
    authority: 'system',
    sourceKind: input.sourceKind,
    sourceEventId: input.sourceEventId,
    acceptanceId: acceptance.id,
    acceptanceRevision: acceptance.revision,
    projectId: input.projectId,
    ...(acceptance.goalId === undefined ? {} : { goalId: acceptance.goalId }),
    workItemId: input.workItemId,
    evidenceId,
    actorId: `${ACTOR_PREFIX}:${input.sourceKind}`
  }
}

function appendAuditEvent(
  db: Parameters<typeof appendWorkflowEvent>[0],
  audit: WorkflowAcceptanceFailureAudit,
  input: NormalizedFailureInput
): void {
  appendWorkflowEvent(db, {
    eventId: `workflow:acceptance-failure:${hash(`${input.sourceKind}\0${input.sourceEventId}`)}`,
    streamId: `acceptance:${audit.acceptanceId}`,
    entityType: 'acceptance',
    entityId: audit.acceptanceId,
    kind: 'workflow.acceptance.failure_ingested',
    payload: { ...audit },
    occurredAt: input.observedAt,
    causationId: input.sourceEventId,
    correlationId: input.runId ?? input.workItemId
  }, {
    projectId: input.projectId,
    goalId: audit.goalId,
    workItemId: input.workItemId,
    runId: input.runId
  })
}

function resolveCriterionIndexes(
  requested: readonly number[] | undefined,
  acceptance: WorkflowAcceptanceRecord,
  evidenceKind: 'review_result' | 'test_result'
): number[] {
  const policyMatches = requested === undefined
    ? matchingAcceptanceCriterionIndexes(acceptance, evidenceKind, 'runtime')
    : undefined
  if (policyMatches && policyMatches.length !== 1) {
    throw new WorkflowAcceptanceFailureIngressError(
      'WORKFLOW_FAILURE_INPUT_INVALID',
      `failure producer must resolve exactly one compatible criterion for Acceptance ${acceptance.id}`,
      { acceptanceId: acceptance.id, evidenceKind, source: 'runtime', matchCount: policyMatches.length }
    )
  }
  const indexes = requested ?? policyMatches ??
    acceptance.criteria.map((_, index) => index)
  if (indexes.length === 0) {
    throw new WorkflowAcceptanceFailureIngressError(
      'WORKFLOW_FAILURE_INPUT_INVALID',
      'failure criterionIndexes must not be empty',
      { acceptanceId: acceptance.id }
    )
  }
  const unique = [...new Set(indexes)]
  if (unique.length !== indexes.length || unique.some((index) =>
    !Number.isSafeInteger(index) || index < 0 || index >= acceptance.criteria.length
  )) {
    throw new WorkflowAcceptanceFailureIngressError(
      'WORKFLOW_FAILURE_INPUT_INVALID',
      `failure criterionIndexes are invalid for Acceptance ${acceptance.id}`,
      { acceptanceId: acceptance.id, criterionIndexes: [...indexes] }
    )
  }
  return unique.sort((left, right) => left - right)
}

function failureAuthority(input: NormalizedFailureInput): { caller: 'system'; actorId: string } {
  return { caller: 'system', actorId: `${ACTOR_PREFIX}:${input.sourceKind}` }
}

function normalizeFailureInput(value: unknown): NormalizedFailureInput {
  const record = strictRecord(value, 'workflow failure input')
  const commonKeys = [
    'sourceEventId', 'sourceKind', 'projectId', 'goalId', 'workItemId', 'acceptanceId',
    'acceptanceRevision', 'runId', 'criterionIndexes', 'title', 'summary', 'verifier', 'observedAt', 'contentDigest'
  ]
  const sourceKind = requiredText(record.sourceKind, 'sourceKind', 32)
  const allowed = new Set(sourceKind === 'cross_validation'
    ? [...commonKeys, 'verdict']
    : sourceKind === 'test'
      ? [...commonKeys, 'outcome', 'exitCode']
      : commonKeys)
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) failure('WORKFLOW_FAILURE_INPUT_INVALID', `workflow failure input contains unsupported field ${key}`, record)
  }
  const common = {
    sourceEventId: requiredText(record.sourceEventId, 'sourceEventId', 256),
    projectId: requiredText(record.projectId, 'projectId', 256),
    ...optionalTextField('goalId', record.goalId, 256),
    workItemId: requiredText(record.workItemId, 'workItemId', 256),
    ...optionalTextField('acceptanceId', record.acceptanceId, 256),
    ...optionalRevisionField('acceptanceRevision', record.acceptanceRevision),
    ...optionalTextField('runId', record.runId, 256),
    ...(record.criterionIndexes === undefined
      ? {}
      : { criterionIndexes: integerArray(record.criterionIndexes, 'criterionIndexes') }),
    title: requiredText(record.title, 'title', 256),
    ...optionalTextField('summary', record.summary, 4000),
    verifier: requiredText(record.verifier, 'verifier', 256),
    observedAt: timestamp(record.observedAt, 'observedAt'),
    contentDigest: digest(record.contentDigest)
  }
  if (sourceKind === 'cross_validation') {
    if (record.verdict !== 'concerns' && record.verdict !== 'blocked') {
      failure('WORKFLOW_FAILURE_INPUT_INVALID', 'cross-validation failure verdict must be concerns or blocked', record)
    }
    return { ...common, sourceKind, verdict: record.verdict }
  }
  if (sourceKind === 'test') {
    if (record.outcome !== 'failed') failure('WORKFLOW_FAILURE_INPUT_INVALID', 'test failure outcome must be failed', record)
    if (record.exitCode !== undefined && (!Number.isSafeInteger(record.exitCode) || record.exitCode === 0)) {
      failure('WORKFLOW_FAILURE_INPUT_INVALID', 'test failure exitCode must be a non-zero safe integer', record)
    }
    return {
      ...common,
      sourceKind,
      outcome: 'failed',
      ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode as number })
    }
  }
  failure('WORKFLOW_FAILURE_INPUT_INVALID', `unsupported failure sourceKind ${sourceKind}`, record)
}

function strictRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkflowAcceptanceFailureIngressError('WORKFLOW_FAILURE_INPUT_INVALID', `${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') failure('WORKFLOW_FAILURE_INPUT_INVALID', `${label} must be text`, { [label]: value })
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    failure('WORKFLOW_FAILURE_INPUT_INVALID', `${label} is invalid`, { [label]: value })
  }
  return normalized
}

function optionalTextField<K extends string>(
  key: K,
  value: unknown,
  maxLength: number
): { [P in K]?: string } {
  return value === undefined ? {} : { [key]: requiredText(value, key, maxLength) } as { [P in K]?: string }
}

function optionalRevisionField<K extends string>(key: K, value: unknown): { [P in K]?: number } {
  return value === undefined ? {} : { [key]: revision(value, key) } as { [P in K]?: number }
}

function integerArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => !Number.isSafeInteger(item))) {
    failure('WORKFLOW_FAILURE_INPUT_INVALID', `${label} must be a non-empty safe-integer array`, { [label]: value })
  }
  return [...value] as number[]
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    failure('WORKFLOW_FAILURE_INPUT_INVALID', `${label} must be a non-negative safe integer`, { [label]: value })
  }
  return value as number
}

function revision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    failure('WORKFLOW_FAILURE_INPUT_INVALID', `${label} must be a positive safe integer`, { [label]: value })
  }
  return value as number
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value.trim())) {
    failure('WORKFLOW_FAILURE_INPUT_INVALID', 'contentDigest must be 64 hexadecimal characters', { contentDigest: value })
  }
  return value.trim().toLowerCase()
}

function failure(
  code: WorkflowAcceptanceFailureIngressErrorCode,
  message: string,
  input: object,
  details: Record<string, unknown> = {}
): never {
  const context = input as Partial<NormalizedFailureInput>
  throw new WorkflowAcceptanceFailureIngressError(code, message, {
    sourceEventId: context.sourceEventId,
    sourceKind: context.sourceKind,
    projectId: context.projectId,
    goalId: context.goalId,
    workItemId: context.workItemId,
    acceptanceId: context.acceptanceId,
    acceptanceRevision: context.acceptanceRevision,
    runId: context.runId,
    ...details
  })
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
