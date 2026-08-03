import type { WorkflowEvidenceInput, WorkflowEvidenceRecord } from '../../shared/workflow-types'
import {
  appendWorkflowEvidence,
  readAllWorkflowEvidenceForIntegrity,
  setupWorkflowEvidenceSchema,
  verifyWorkflowEvidence
} from './workflow-evidence-store'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'

const TABLE = 'workflow_evidence'

export interface WorkflowEvidenceProjectPurgeResult {
  removed: number
  remaining: number
  lastSeq: number
  lastDigest: string
}

export function purgeWorkflowEvidenceProject(
  db: WorkflowLedgerDatabase,
  projectId: string
): WorkflowEvidenceProjectPurgeResult {
  const id = projectId.trim()
  if (!id) throw new WorkflowLedgerCorruptionError('workflow evidence project purge requires projectId')
  setupWorkflowEvidenceSchema(db)
  const records = readAllWorkflowEvidenceForIntegrity(db)
  const remaining = records.filter((record) => record.projectId !== id)
  if (remaining.length === records.length) return unchangedResult(db)
  db.run(`DELETE FROM ${TABLE}`)
  for (const record of remaining) appendExistingEvidence(db, record)
  const verification = verifyWorkflowEvidence(db)
  return {
    removed: records.length - remaining.length,
    remaining: verification.count,
    lastSeq: verification.lastSeq,
    lastDigest: verification.lastDigest
  }
}

function unchangedResult(db: WorkflowLedgerDatabase): WorkflowEvidenceProjectPurgeResult {
  const verification = verifyWorkflowEvidence(db)
  return {
    removed: 0,
    remaining: verification.count,
    lastSeq: verification.lastSeq,
    lastDigest: verification.lastDigest
  }
}

function appendExistingEvidence(db: WorkflowLedgerDatabase, record: WorkflowEvidenceRecord): void {
  const input: WorkflowEvidenceInput = {
    evidenceId: record.evidenceId,
    projectId: record.projectId,
    ...optionalField('goalId', record.goalId),
    ...optionalField('workItemId', record.workItemId),
    ...optionalField('runId', record.runId),
    ...optionalField('artifactId', record.artifactId),
    kind: record.kind,
    title: record.title,
    ...optionalField('summary', record.summary),
    ...optionalField('uri', record.uri),
    ...optionalField('mediaType', record.mediaType),
    source: record.source,
    verifier: record.verifier,
    observedAt: record.observedAt,
    contentDigest: record.contentDigest,
    ...optionalField('metadata', record.metadata)
  }
  appendWorkflowEvidence(db, input, {
    source: record.source,
    verifier: record.verifier,
    observedAt: record.observedAt,
    createdAt: record.createdAt
  })
}

function optionalField<K extends string, T>(key: K, value: T | undefined): Partial<Record<K, T>> {
  return value === undefined ? {} : { [key]: value } as Record<K, T>
}
