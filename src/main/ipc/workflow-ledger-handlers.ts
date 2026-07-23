import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  createWorkflowArtifact,
  createWorkflowArtifactEdge,
  createWorkflowArtifactLocation,
  createWorkflowEvidence,
  createWorkflowEvidenceLink,
  diagnoseWorkflowLedger,
  exportWorkflowLedger,
  listWorkflowLedger,
  listWorkflowArtifactEdges,
  listWorkflowArtifactLocations,
  listWorkflowEvidence,
  planWorkflowLedgerRepair,
  queryWorkflowEvidence,
  saveWorkflowAcceptance,
  queryWorkflowArtifactGraph,
  verifyWorkflowArtifactGraph,
  verifyWorkflowEvidence,
  verifyPersistedWorkflowLedger
} from '../task/workflow-ledger-api'
import {
  planWorkflowAcceptanceReview,
  toWorkflowAcceptanceError,
  type WorkflowAcceptanceReviewAuthority
} from '../task/workflow-acceptance-guard'
import {
  assertWorkflowAcceptanceRetestPlanCurrent,
  openWorkflowAcceptanceRepairCoordinator,
  type WorkflowAcceptanceRepairCoordinator,
  type WorkflowAcceptanceRetestPlan
} from '../task/workflow-acceptance-repair-coordinator'
import {
  materializeWorkflowAcceptanceRepair,
  recoverWorkflowAcceptanceRepairMaterializations
} from '../task/workflow-acceptance-repair-service'
import { setupWorkflowEvidenceSchema } from '../task/workflow-evidence-store'
import {
  linkWorkflowEvidence,
  projectWorkflowAcceptance,
  setupWorkflowLedgerSchema
} from '../task/workflow-ledger-store'
import {
  findWorkflowAcceptance,
  findWorkflowEvidenceLink
} from '../task/workflow-ledger-query'
import { mutateTaskSnapshotDatabase, readTaskSnapshotDatabase } from '../task/task-snapshot'
import type {
  WorkflowAcceptanceInput,
  WorkflowAcceptanceReviewInput,
  WorkflowAcceptanceReviewResult,
  WorkflowArtifactEdgeInput,
  WorkflowArtifactInput,
  WorkflowArtifactLocationInput,
  WorkflowEvidenceLinkInput,
  WorkflowEvidenceCreateInput,
  WorkflowEvidenceKind,
  WorkflowEvidenceScope,
  WorkflowLedgerScope,
  WorkflowArtifactGraphScope,
  WorkflowArtifactEdgeRelation,
  WorkflowArtifactLocationKind,
  WorkflowArtifactLocationAvailability,
  WorkflowLedgerExportOptions
} from '../../shared/workflow-types'
import {
  projectIdsFromMutationResult,
  verifyProductionProjectMutation
} from '../project-aggregate/project-mutation-ingress'

export const LEGACY_WRITE_DISABLED = 'LEGACY_WRITE_DISABLED' as const

const GRAPH_EDGE_RELATIONS = new Set<WorkflowArtifactEdgeRelation>([
  'derived_from', 'produced_from', 'input_to', 'output_of', 'supports', 'verifies',
  'supersedes', 'annotates', 'references', 'depends_on', 'related_to', 'custom'
])
const GRAPH_LOCATION_KINDS = new Set<WorkflowArtifactLocationKind>([
  'blob', 'file', 'workspace', 'url', 'git', 'attachment', 'preview', 'external', 'custom'
])
const GRAPH_LOCATION_AVAILABILITIES = new Set<WorkflowArtifactLocationAvailability>([
  'available', 'pending', 'unavailable', 'deleted', 'unknown'
])
const WORKFLOW_ACCEPTANCE_KEYS = new Set([
  'schemaVersion', 'id', 'projectId', 'goalId', 'workItemId', 'criteria', 'status', 'evidenceRefs',
  'criterionPolicies', 'criterionEvidence', 'verifier', 'verifiedAt', 'waiverReason', 'waivedBy', 'notes', 'revision',
  'createdAt', 'updatedAt'
])
const WORKFLOW_ACCEPTANCE_AUTHORITY_KEYS = [
  'verifier', 'verifiedAt', 'waiverReason', 'waivedBy'
] as const
const RENDERER_ACCEPTANCE_STATUSES = new Set(['pending', 'verifying', 'failed'])
const WORKFLOW_ACCEPTANCE_REVIEW_DECISIONS = new Set(['passed', 'failed', 'retest', 'waived'] as const)
const WORKFLOW_ACCEPTANCE_REVIEW_KEYS = new Set([
  'acceptanceId', 'criterionEvidence', 'decision', 'notes', 'waiverReason'
])
const WORKFLOW_EVIDENCE_KINDS = new Set<WorkflowEvidenceKind>([
  'research_source', 'review_result', 'test_result', 'approval', 'observation',
  'metric', 'security_scan', 'delivery_check', 'custom'
])

export function registerWorkflowLedgerIpc(): void {
  void recoverWorkflowAcceptanceRepairs().then((result) => {
    if (result.failures.length > 0) {
      console.error(`[caogen] ${result.failures.length} workflow acceptance repair(s) need manual reconciliation`)
    }
  }).catch((error) => {
    console.error('[caogen] workflow acceptance repair recovery failed', error)
  })
  ipcMain.handle('workflowLedger:list', (event, rawScope: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    return listWorkflowLedger(normalizeScope(rawScope))
  }
  )
  ipcMain.handle('workflowLedger:verify', (event) => {
    assertTrustedWorkflowLedgerSender(event)
    return verifyPersistedWorkflowLedger()
  })
  ipcMain.handle('workflowLedger:export', (event, rawOptions: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    return exportWorkflowLedger(normalizeExportOptions(rawOptions))
  })
  ipcMain.handle('workflowLedger:diagnose', (event) => {
    assertTrustedWorkflowLedgerSender(event)
    return diagnoseWorkflowLedger()
  })
  ipcMain.handle('workflowLedger:repairPlan', (event) => {
    assertTrustedWorkflowLedgerSender(event)
    return planWorkflowLedgerRepair()
  })
  ipcMain.handle('workflowLedger:createGoal', (event) => {
    assertTrustedWorkflowLedgerSender(event)
    return rejectLegacyWorkflowEntityWrite('workflowLedger:createGoal')
  })
  ipcMain.handle('workflowLedger:createWorkItem', (event) => {
    assertTrustedWorkflowLedgerSender(event)
    return rejectLegacyWorkflowEntityWrite('workflowLedger:createWorkItem')
  })
  ipcMain.handle('workflowLedger:createArtifact', (event, rawInput: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    return verifyWorkflowMutation(createWorkflowArtifact(normalizeRecordInput<WorkflowArtifactInput>(rawInput, 'Artifact')))
  })
  ipcMain.handle('workflowLedger:createArtifactEdge', (event, rawInput: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    return verifyWorkflowMutation(createWorkflowArtifactEdge(normalizeArtifactEdgeInput(rawInput)))
  })
  ipcMain.handle('workflowLedger:createArtifactLocation', (event, rawInput: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    return verifyWorkflowMutation(createWorkflowArtifactLocation(normalizeArtifactLocationInput(rawInput)))
  })
  ipcMain.handle('workflowLedger:listArtifactEdges', (event, rawScope: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    return listWorkflowArtifactEdges(normalizeGraphScope(rawScope))
  })
  ipcMain.handle('workflowLedger:listArtifactLocations', (event, rawScope: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    return listWorkflowArtifactLocations(normalizeGraphScope(rawScope))
  })
  ipcMain.handle('workflowLedger:queryArtifactGraph', (event, rawArtifactId: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    return queryWorkflowArtifactGraph(requiredString(rawArtifactId, 'artifactId'))
  })
  ipcMain.handle('workflowLedger:verifyArtifactGraph', (event) => {
    assertTrustedWorkflowLedgerSender(event)
    return verifyWorkflowArtifactGraph()
  })
  ipcMain.handle('workflowLedger:createEvidence', (event, rawInput: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    const input = normalizeWorkflowEvidenceCreateInput(rawInput)
    return verifyWorkflowMutation(createWorkflowEvidence(input, undefined, {
      source: 'runtime',
      verifier: 'renderer-ipc'
    }))
  })
  ipcMain.handle('workflowLedger:listEvidence', (event, rawScope: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    return listWorkflowEvidence(normalizeWorkflowEvidenceScope(rawScope))
  })
  ipcMain.handle('workflowLedger:queryEvidence', (event, rawScope: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    return queryWorkflowEvidence(normalizeWorkflowEvidenceScope(rawScope))
  })
  ipcMain.handle('workflowLedger:verifyEvidence', (event) => {
    assertTrustedWorkflowLedgerSender(event)
    return verifyWorkflowEvidence()
  })
  ipcMain.handle('workflowLedger:saveAcceptance', (event, rawInput: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    return verifyWorkflowMutation(saveWorkflowAcceptance(normalizeWorkflowAcceptanceInput(rawInput)))
  })
  ipcMain.handle('workflowLedger:reviewAcceptance', (event, rawInput: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    return verifyWorkflowMutation(reviewWorkflowAcceptance(
      normalizeWorkflowAcceptanceReviewInput(rawInput),
      workflowAcceptanceUserAuthority(event)
    ))
  })
  ipcMain.handle('workflowLedger:createEvidenceLink', (event, rawInput: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    return verifyWorkflowMutation(
      createWorkflowEvidenceLink(normalizeRecordInput<WorkflowEvidenceLinkInput>(rawInput, 'Evidence link'))
    )
  })
  ipcMain.handle(
    'workflowLedger:transitionWorkItem',
    (event) => {
      assertTrustedWorkflowLedgerSender(event)
      return rejectLegacyWorkflowEntityWrite('workflowLedger:transitionWorkItem')
    }
  )
}

async function verifyWorkflowMutation<T>(mutation: Promise<T>): Promise<T> {
  const result = await mutation
  const projectIds = projectIdsFromMutationResult(result)
  if (projectIds.length === 0) throw new Error('workflow mutation did not resolve a Project ID')
  for (const projectId of projectIds) {
    await verifyProductionProjectMutation(app.getPath('userData'), projectId)
  }
  return result
}

export async function reviewWorkflowAcceptance(
  input: WorkflowAcceptanceReviewInput,
  authority: WorkflowAcceptanceReviewAuthority,
  rootDir?: string
): Promise<WorkflowAcceptanceReviewResult> {
  try {
    let repairCoordinator: WorkflowAcceptanceRepairCoordinator | undefined
    let retestPlan: WorkflowAcceptanceRetestPlan | undefined
    if (input.decision === 'retest') {
      const failedAcceptance = await readAcceptanceForRepair(input.acceptanceId, rootDir)
      repairCoordinator = await openWorkflowAcceptanceRepairCoordinator(rootDir)
      retestPlan = await repairCoordinator.prepareRetest(failedAcceptance, {
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        updatedAt: authority.reviewedAt
      })
    }

    const persisted = await mutateTaskSnapshotDatabase(rootDir, (db) => {
      setupWorkflowLedgerSchema(db)
      setupWorkflowEvidenceSchema(db)
      if (retestPlan) {
        assertWorkflowAcceptanceRetestPlanCurrent(
          findWorkflowAcceptance(db, input.acceptanceId),
          retestPlan
        )
      }
      const plan = planWorkflowAcceptanceReview(db, input, authority)
      for (const linkInput of plan.evidenceLinks) linkWorkflowEvidence(db, linkInput)
      for (const acceptanceInput of plan.acceptanceInputs) {
        projectWorkflowAcceptance(db, acceptanceInput, {
          caller: 'user',
          actorId: authority.actorId
        })
      }
      const acceptance = findWorkflowAcceptance(db, input.acceptanceId)
      if (!acceptance) throw new Error(`workflow acceptance ${input.acceptanceId} disappeared after review`)
      const evidenceLinks = plan.evidenceLinks.map((link) => findWorkflowEvidenceLink(db, link.id))
      if (evidenceLinks.some((link) => !link)) {
        throw new Error(`workflow acceptance ${input.acceptanceId} review evidence link disappeared`)
      }
      return {
        acceptance,
        evidenceLinks: evidenceLinks as NonNullable<(typeof evidenceLinks)[number]>[],
        audit: {
          ...plan.audit,
          acceptanceRevision: acceptance.revision,
          evidenceRefs: [...acceptance.evidenceRefs]
        }
      }
    })
    if (persisted.acceptance.status === 'failed') {
      const { repair } = await materializeWorkflowAcceptanceRepair(persisted.acceptance, rootDir)
      return {
        ...persisted,
        repair: {
          workItemId: repair.repairWorkItemId,
          acceptanceId: repair.repairAcceptanceId,
          failedAcceptanceRevision: repair.failedAcceptanceRevision,
          disposition: repair.disposition
        }
      }
    }
    if (retestPlan) {
      return {
        ...persisted,
        repair: {
          workItemId: retestPlan.repairWorkItemId,
          acceptanceId: retestPlan.repairAcceptanceId,
          failedAcceptanceRevision: retestPlan.failedAcceptanceRevision,
          disposition: 'completed'
        }
      }
    }
    return persisted
  } catch (error) {
    throw toWorkflowAcceptanceError(error, {
      operation: 'reviewWorkflowAcceptance',
      targetType: 'acceptance',
      targetId: input.acceptanceId,
      acceptanceId: input.acceptanceId,
      toStatus: input.decision,
      caller: 'user',
      actorId: authority.actorId
    })
  }
}

export async function recoverWorkflowAcceptanceRepairs(rootDir?: string) {
  return recoverWorkflowAcceptanceRepairMaterializations(rootDir)
}

async function readAcceptanceForRepair(
  acceptanceId: string,
  rootDir?: string
) {
  return readTaskSnapshotDatabase(rootDir, (db) => {
    setupWorkflowLedgerSchema(db)
    const acceptance = findWorkflowAcceptance(db, acceptanceId)
    if (!acceptance) throw new Error(`workflow acceptance ${acceptanceId} was not found`)
    return acceptance
  })
}

export function rejectLegacyWorkflowEntityWrite(channel: string): never {
  const error = new Error(
    `${LEGACY_WRITE_DISABLED}: ${channel} is disabled; use the ProjectWorkspace command ingress`
  )
  error.name = 'LegacyWorkflowWriteDisabledError'
  Object.assign(error, { code: LEGACY_WRITE_DISABLED, channel })
  throw error
}

function normalizeScope(value: unknown): WorkflowLedgerScope {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) throw new Error('Workflow ledger scope 必须是对象')
  const allowedKeys = new Set([
    'projectId', 'goalId', 'workItemId', 'runId', 'sessionId', 'entityType',
    'entityId', 'eventKind', 'artifactId', 'acceptanceId', 'limit', 'cursor'
  ])
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error('Workflow ledger scope 包含未知字段')
  }
  return {
    projectId: optionalString(value.projectId, 'projectId'),
    goalId: optionalString(value.goalId, 'goalId'),
    workItemId: optionalString(value.workItemId, 'workItemId'),
    runId: optionalString(value.runId, 'runId'),
    sessionId: optionalString(value.sessionId, 'sessionId'),
    entityType: value.entityType === undefined ? undefined : requiredEntityType(value.entityType),
    entityId: optionalString(value.entityId, 'entityId'),
    eventKind: optionalString(value.eventKind, 'eventKind'),
    artifactId: optionalString(value.artifactId, 'artifactId'),
    acceptanceId: optionalString(value.acceptanceId, 'acceptanceId'),
    limit: value.limit === undefined ? undefined : positiveInteger(value.limit, 'limit'),
    cursor: value.cursor === undefined ? undefined : requiredString(value.cursor, 'cursor')
  }
}

function normalizeGraphScope(value: unknown): WorkflowArtifactGraphScope {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) throw new Error('Artifact Graph scope 必须是对象')
  const allowedKeys = new Set([
    'projectId', 'artifactId', 'fromArtifactId', 'toArtifactId',
    'relation', 'kind', 'availability', 'limit', 'cursor'
  ])
  assertAllowedKeys(value, allowedKeys, 'Artifact Graph scope')
  return {
    projectId: optionalString(value.projectId, 'projectId'),
    artifactId: optionalString(value.artifactId, 'artifactId'),
    fromArtifactId: optionalString(value.fromArtifactId, 'fromArtifactId'),
    toArtifactId: optionalString(value.toArtifactId, 'toArtifactId'),
    relation: optionalEnum(value.relation, 'relation', GRAPH_EDGE_RELATIONS),
    kind: optionalEnum(value.kind, 'kind', GRAPH_LOCATION_KINDS),
    availability: optionalEnum(value.availability, 'availability', GRAPH_LOCATION_AVAILABILITIES),
    limit: value.limit === undefined ? undefined : positiveInteger(value.limit, 'limit'),
    cursor: value.cursor === undefined ? undefined : requiredString(value.cursor, 'cursor')
  }
}

function normalizeArtifactEdgeInput(value: unknown): WorkflowArtifactEdgeInput {
  if (!isRecord(value)) throw new Error('Artifact edge input 必须是对象')
  assertAllowedKeys(value, new Set([
    'id', 'fromArtifactId', 'toArtifactId', 'relation', 'projectId', 'goalId',
    'workItemId', 'runId', 'metadata', 'createdAt', 'updatedAt'
  ]), 'Artifact edge input')
  return {
    id: requiredString(value.id, 'edge id'),
    fromArtifactId: requiredString(value.fromArtifactId, 'fromArtifactId'),
    toArtifactId: requiredString(value.toArtifactId, 'toArtifactId'),
    relation: requiredEnum(value.relation, 'relation', GRAPH_EDGE_RELATIONS),
    ...optionalGraphOwnership(value),
    ...(value.metadata === undefined ? {} : { metadata: metadataObject(value.metadata, 'edge metadata') }),
    ...(value.createdAt === undefined ? {} : { createdAt: finiteNumber(value.createdAt, 'createdAt') }),
    ...(value.updatedAt === undefined ? {} : { updatedAt: finiteNumber(value.updatedAt, 'updatedAt') })
  }
}

function normalizeArtifactLocationInput(value: unknown): WorkflowArtifactLocationInput {
  if (!isRecord(value)) throw new Error('Artifact location input 必须是对象')
  assertAllowedKeys(value, new Set([
    'id', 'artifactId', 'projectId', 'goalId', 'workItemId', 'runId', 'kind', 'uri',
    'path', 'availability', 'checksum', 'sizeBytes', 'mediaType', 'metadata',
    'createdAt', 'updatedAt'
  ]), 'Artifact location input')
  return {
    ...(value.id === undefined ? {} : { id: requiredString(value.id, 'location id') }),
    artifactId: requiredString(value.artifactId, 'artifactId'),
    ...optionalGraphOwnership(value),
    kind: requiredEnum(value.kind, 'kind', GRAPH_LOCATION_KINDS),
    ...(value.uri === undefined ? {} : { uri: optionalString(value.uri, 'uri') }),
    ...(value.path === undefined ? {} : { path: optionalString(value.path, 'path') }),
    availability: value.availability === undefined
      ? undefined
      : requiredEnum(value.availability, 'availability', GRAPH_LOCATION_AVAILABILITIES),
    ...(value.checksum === undefined ? {} : { checksum: optionalString(value.checksum, 'checksum') }),
    ...(value.sizeBytes === undefined ? {} : { sizeBytes: nonNegativeInteger(value.sizeBytes, 'sizeBytes') }),
    ...(value.mediaType === undefined ? {} : { mediaType: optionalString(value.mediaType, 'mediaType') }),
    ...(value.metadata === undefined ? {} : { metadata: metadataObject(value.metadata, 'location metadata') }),
    ...(value.createdAt === undefined ? {} : { createdAt: finiteNumber(value.createdAt, 'createdAt') }),
    ...(value.updatedAt === undefined ? {} : { updatedAt: finiteNumber(value.updatedAt, 'updatedAt') })
  }
}

function optionalGraphOwnership(value: Record<string, unknown>): Pick<WorkflowArtifactEdgeInput, 'projectId' | 'goalId' | 'workItemId' | 'runId'> {
  return {
    ...(value.projectId === undefined ? {} : { projectId: optionalString(value.projectId, 'projectId') }),
    ...(value.goalId === undefined ? {} : { goalId: optionalString(value.goalId, 'goalId') }),
    ...(value.workItemId === undefined ? {} : { workItemId: optionalString(value.workItemId, 'workItemId') }),
    ...(value.runId === undefined ? {} : { runId: optionalString(value.runId, 'runId') })
  }
}

function metadataObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} 必须是对象`)
  return value
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} 必须是有限数字`)
  return value
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} 必须是非负安全整数`)
  }
  return value as number
}

function requiredEnum<T extends string>(value: unknown, label: string, values: ReadonlySet<T>): T {
  if (typeof value !== 'string' || !values.has(value as T)) throw new Error(`${label} 无效`)
  return value as T
}

function optionalEnum<T extends string>(value: unknown, label: string, values: ReadonlySet<T>): T | undefined {
  if (value === undefined || value === null) return undefined
  return requiredEnum(value, label, values)
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} 包含未知字段`)
  }
}

function normalizeExportOptions(value: unknown): WorkflowLedgerExportOptions {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) throw new Error('Workflow ledger export options 必须是对象')
  for (const key of Object.keys(value)) {
    if (key !== 'scope') throw new Error('Workflow ledger export options 包含未知字段')
  }
  if (value.scope === undefined || value.scope === null) return {}
  if (!isRecord(value.scope)) throw new Error('Workflow ledger export scope 必须是对象')
  if (value.scope.limit !== undefined || value.scope.cursor !== undefined) {
    throw new Error('Workflow ledger export scope 不允许分页参数')
  }
  const normalized = normalizeScope(value.scope)
  const { limit: _limit, cursor: _cursor, ...scope } = normalized
  return { scope }
}

function normalizeRecordInput<T>(value: unknown, label: string): T {
  if (!isRecord(value)) throw new Error(`${label} input 必须是对象`)
  return value as T
}

function normalizeWorkflowAcceptanceInput(value: unknown): WorkflowAcceptanceInput {
  if (!isRecord(value)) throw new Error('Acceptance input 必须是对象')
  assertAllowedKeys(value, WORKFLOW_ACCEPTANCE_KEYS, 'Acceptance input')
  for (const key of WORKFLOW_ACCEPTANCE_AUTHORITY_KEYS) {
    if (Object.hasOwn(value, key)) {
      throw new Error(`Acceptance input ${key} 只能由主进程授权`)
    }
  }
  if (value.status !== undefined && (
    typeof value.status !== 'string' || !RENDERER_ACCEPTANCE_STATUSES.has(value.status)
  )) {
    throw new Error('Acceptance input status 不允许 renderer 写入终态授权结果')
  }
  return value as unknown as WorkflowAcceptanceInput
}

function normalizeWorkflowAcceptanceReviewInput(value: unknown): WorkflowAcceptanceReviewInput {
  if (!isRecord(value)) throw new Error('Acceptance review input 必须是对象')
  assertAllowedKeys(value, WORKFLOW_ACCEPTANCE_REVIEW_KEYS, 'Acceptance review input')
  if (!Array.isArray(value.criterionEvidence)) {
    throw new Error('Acceptance review criterionEvidence 必须是数组')
  }
  return {
    acceptanceId: requiredString(value.acceptanceId, 'acceptanceId'),
    criterionEvidence: value.criterionEvidence.map((selection, index) => {
      if (!isRecord(selection)) throw new Error(`Acceptance review criterionEvidence[${index}] 必须是对象`)
      assertAllowedKeys(
        selection,
        new Set(['criterionIndex', 'evidenceRefs']),
        `Acceptance review criterionEvidence[${index}]`
      )
      if (!Array.isArray(selection.evidenceRefs)) {
        throw new Error(`Acceptance review criterionEvidence[${index}].evidenceRefs 必须是数组`)
      }
      return {
        criterionIndex: nonNegativeInteger(selection.criterionIndex, `criterionEvidence[${index}].criterionIndex`),
        evidenceRefs: [...new Set(selection.evidenceRefs.map((evidenceId, evidenceIndex) =>
          requiredString(evidenceId, `criterionEvidence[${index}].evidenceRefs[${evidenceIndex}]`)
        ))]
      }
    }),
    decision: requiredEnum(value.decision, 'decision', WORKFLOW_ACCEPTANCE_REVIEW_DECISIONS),
    ...(value.notes === undefined ? {} : { notes: optionalReviewString(value.notes, 'notes') }),
    ...(value.waiverReason === undefined
      ? {}
      : { waiverReason: optionalReviewString(value.waiverReason, 'waiverReason') })
  }
}

function normalizeWorkflowEvidenceCreateInput(value: unknown): WorkflowEvidenceCreateInput {
  if (!isRecord(value)) throw new Error('Workflow evidence input 必须是对象')
  assertAllowedKeys(value, new Set([
    'evidenceId', 'projectId', 'goalId', 'workItemId', 'runId', 'artifactId',
    'kind', 'title', 'summary', 'uri', 'mediaType', 'contentDigest', 'metadata'
  ]), 'Workflow evidence input')
  const contentDigest = requiredString(value.contentDigest, 'contentDigest').toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(contentDigest)) throw new Error('contentDigest 必须是 64 位十六进制 SHA-256')
  return {
    evidenceId: requiredString(value.evidenceId, 'evidenceId'),
    projectId: requiredString(value.projectId, 'projectId'),
    ...(value.goalId === undefined ? {} : { goalId: optionalString(value.goalId, 'goalId') }),
    ...(value.workItemId === undefined ? {} : { workItemId: optionalString(value.workItemId, 'workItemId') }),
    ...(value.runId === undefined ? {} : { runId: optionalString(value.runId, 'runId') }),
    ...(value.artifactId === undefined ? {} : { artifactId: optionalString(value.artifactId, 'artifactId') }),
    kind: requiredEnum(value.kind, 'kind', WORKFLOW_EVIDENCE_KINDS),
    title: requiredString(value.title, 'title'),
    ...(value.summary === undefined ? {} : { summary: optionalString(value.summary, 'summary') }),
    ...(value.uri === undefined ? {} : { uri: optionalString(value.uri, 'uri') }),
    ...(value.mediaType === undefined ? {} : { mediaType: optionalString(value.mediaType, 'mediaType') }),
    contentDigest,
    ...(value.metadata === undefined ? {} : { metadata: metadataObject(value.metadata, 'evidence metadata') })
  }
}

function normalizeWorkflowEvidenceScope(value: unknown): WorkflowEvidenceScope {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) throw new Error('Workflow evidence scope 必须是对象')
  assertAllowedKeys(value, new Set([
    'evidenceId', 'projectId', 'goalId', 'workItemId', 'runId', 'artifactId', 'kind',
    'limit', 'cursor'
  ]), 'Workflow evidence scope')
  return {
    ...(value.evidenceId === undefined ? {} : { evidenceId: optionalString(value.evidenceId, 'evidenceId') }),
    ...(value.projectId === undefined ? {} : { projectId: optionalString(value.projectId, 'projectId') }),
    ...(value.goalId === undefined ? {} : { goalId: optionalString(value.goalId, 'goalId') }),
    ...(value.workItemId === undefined ? {} : { workItemId: optionalString(value.workItemId, 'workItemId') }),
    ...(value.runId === undefined ? {} : { runId: optionalString(value.runId, 'runId') }),
    ...(value.artifactId === undefined ? {} : { artifactId: optionalString(value.artifactId, 'artifactId') }),
    ...(value.kind === undefined ? {} : { kind: requiredEnum(value.kind, 'kind', WORKFLOW_EVIDENCE_KINDS) }),
    ...(value.limit === undefined ? {} : { limit: positiveInteger(value.limit, 'limit') }),
    ...(value.cursor === undefined ? {} : { cursor: requiredString(value.cursor, 'cursor') })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return requiredString(value, label)
}

function requiredEntityType(value: unknown): WorkflowLedgerScope['entityType'] {
  if (!isEntityType(value)) throw new Error('Workflow ledger entityType 无效')
  return value
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 必须是非空字符串`)
  const normalized = value.trim()
  if (normalized.length > 256 || /[\0-\x1F\x7F]/.test(normalized)) {
    throw new Error(`${label} 格式无效`)
  }
  return normalized
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`${label} 必须是正整数`)
  return value as number
}

function optionalReviewString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 必须是非空字符串`)
  const normalized = value.trim()
  if (normalized.length > 2000 || /[\0-\x1F\x7F]/.test(normalized)) {
    throw new Error(`${label} 格式无效`)
  }
  return normalized
}

function isEntityType(value: unknown): value is WorkflowLedgerScope['entityType'] {
  return value === 'goal' || value === 'work_item' || value === 'run' ||
    value === 'artifact' || value === 'acceptance' || value === 'system'
}

/**
 * Workflow Ledger is renderer-facing and must never be callable by an
 * arbitrary WebContents (including a remote page opened by the app).
 * Production uses a file:// renderer; development uses localhost Vite.
 */
export function assertTrustedWorkflowLedgerSender(event: unknown, trustedSenders?: readonly unknown[]): void {
  if (!isTrustedWorkflowLedgerSender(event, trustedSenders)) {
    throw new Error('Workflow ledger IPC sender is not trusted')
  }
}

export function isTrustedWorkflowLedgerSender(event: unknown, trustedSenders?: readonly unknown[]): boolean {
  if (!isRecord(event)) return false
  const sender = event.sender
  if (!sender || typeof sender !== 'object') return false
  const isDestroyed = (sender as { isDestroyed?: () => boolean }).isDestroyed
  if (typeof isDestroyed === 'function' && isDestroyed.call(sender)) return false
  const owned = trustedSenders
    ? trustedSenders.includes(sender)
    : BrowserWindow.getAllWindows().some((window) => window.webContents === sender)
  if (!owned) return false
  const frame = event.senderFrame
  const mainFrame = (sender as { mainFrame?: unknown }).mainFrame
  if (!frame || typeof frame !== 'object' || frame !== mainFrame) return false
  const rawUrl = typeof (frame as { url?: unknown }).url === 'string'
    ? (frame as { url: string }).url
    : ''
  return isTrustedRendererUrl(rawUrl)
}

function workflowAcceptanceUserAuthority(event: unknown): WorkflowAcceptanceReviewAuthority {
  if (!isRecord(event) || !isRecord(event.sender)) {
    throw new Error('Workflow acceptance review requires a trusted renderer sender')
  }
  const senderId = event.sender.id
  if (!Number.isSafeInteger(senderId) || (senderId as number) <= 0) {
    throw new Error('Workflow acceptance review sender identity is unavailable')
  }
  const actorId = `local-user:webcontents-${senderId}`
  return { actorId, verifier: actorId, reviewedAt: Date.now() }
}

function isTrustedRendererUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    const developmentUrl = process.env.ELECTRON_RENDERER_URL
    if (developmentUrl) {
      const expected = new URL(developmentUrl)
      return url.origin === expected.origin && url.pathname === expected.pathname
    }
    const expected = pathToFileURL(join(__dirname, '../renderer/index.html'))
    return url.protocol === 'file:' && url.href === expected.href
  } catch {
    return false
  }
}
