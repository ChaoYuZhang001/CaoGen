import type {
  WorkflowAcceptanceRecord,
  WorkflowArtifactRecord,
  WorkflowEvidenceLinkRecord,
  WorkflowEvidenceRecord,
  WorkflowRunRecord,
  WorkflowWorkItemRecord
} from '../../shared/workflow-types'
import { listWorkflowEvidence } from './workflow-evidence-store'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'
import {
  findWorkflowAcceptance,
  findWorkflowArtifact,
  findWorkflowGoal,
  findWorkflowRun,
  findWorkflowWorkItem
} from './workflow-ledger-query'

type EvidenceLinkReferences = {
  artifact: WorkflowArtifactRecord | null
  acceptance: WorkflowAcceptanceRecord | null
  run: WorkflowRunRecord | null
}

type WorkflowEvidenceReferences = {
  goal: { id: string; projectId?: string } | null
  workItem: WorkflowWorkItemRecord | null
  run: WorkflowRunRecord | null
  artifact: WorkflowArtifactRecord | null
}

type WorkflowOwnershipScope = {
  label: string
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  artifactId?: string
}

/** Validate a Workflow-origin link without consulting TaskRun effect evidence. */
export function assertWorkflowEvidenceLinkReferences(
  db: WorkflowLedgerDatabase,
  link: WorkflowEvidenceLinkRecord
): void {
  const evidence = requireWorkflowEvidence(db, link)
  const linked = {
    artifact: link.artifactId ? findWorkflowArtifact(db, link.artifactId) : null,
    acceptance: link.acceptanceId ? findWorkflowAcceptance(db, link.acceptanceId) : null,
    run: link.runId ? findWorkflowRun(db, link.runId) : null
  }
  assertEvidenceLinkReferencePresence(link, linked)

  const owned = {
    goal: evidence.goalId ? findWorkflowGoal(db, evidence.goalId) : null,
    workItem: evidence.workItemId ? findWorkflowWorkItem(db, evidence.workItemId) : null,
    run: evidence.runId ? findWorkflowRun(db, evidence.runId) : null,
    artifact: evidence.artifactId ? findWorkflowArtifact(db, evidence.artifactId) : null
  }
  assertWorkflowEvidenceReferencePresence(link, evidence, owned)
  assertWorkflowEvidenceProjectOwnership(link, evidence, linked, owned)
  assertWorkflowEvidenceScopeAgreement(link, evidence, linked, owned)
}

function assertEvidenceLinkReferencePresence(
  link: WorkflowEvidenceLinkRecord,
  refs: EvidenceLinkReferences
): void {
  if (link.artifactId && !refs.artifact) {
    throw new WorkflowLedgerCorruptionError(`evidence link ${link.id} references missing artifact ${link.artifactId}`)
  }
  if (link.acceptanceId && !refs.acceptance) {
    throw new WorkflowLedgerCorruptionError(`evidence link ${link.id} references missing acceptance ${link.acceptanceId}`)
  }
  if (link.runId && !refs.run) {
    throw new WorkflowLedgerCorruptionError(`evidence link ${link.id} references missing run ${link.runId}`)
  }
}

function assertWorkflowEvidenceReferencePresence(
  link: WorkflowEvidenceLinkRecord,
  evidence: WorkflowEvidenceRecord,
  refs: WorkflowEvidenceReferences
): void {
  for (const [label, id, record] of [
    ['goal', evidence.goalId, refs.goal],
    ['work item', evidence.workItemId, refs.workItem],
    ['run', evidence.runId, refs.run],
    ['artifact', evidence.artifactId, refs.artifact]
  ] as const) {
    if (id && !record) {
      throw new WorkflowLedgerCorruptionError(
        `evidence link ${link.id} references Workflow evidence with missing ${label} ${id}`
      )
    }
  }
}

function assertWorkflowEvidenceProjectOwnership(
  link: WorkflowEvidenceLinkRecord,
  evidence: WorkflowEvidenceRecord,
  linked: EvidenceLinkReferences,
  owned: WorkflowEvidenceReferences
): void {
  if (link.projectId !== evidence.projectId) {
    throw new WorkflowLedgerCorruptionError(
      `evidence link ${link.id} project ownership differs from Workflow evidence`
    )
  }
  for (const owner of [...Object.values(linked), ...Object.values(owned)]) {
    if (owner && owner.projectId !== evidence.projectId) {
      throw new WorkflowLedgerCorruptionError(
        `evidence link ${link.id} crosses project boundary from Workflow evidence`
      )
    }
  }
}

function assertWorkflowEvidenceScopeAgreement(
  link: WorkflowEvidenceLinkRecord,
  evidence: WorkflowEvidenceRecord,
  linked: EvidenceLinkReferences,
  owned: WorkflowEvidenceReferences
): void {
  const scopes: WorkflowOwnershipScope[] = [
    {
      label: 'evidence link',
      projectId: link.projectId,
      runId: link.runId,
      artifactId: link.artifactId
    },
    {
      label: 'Workflow evidence',
      projectId: evidence.projectId,
      goalId: evidence.goalId,
      workItemId: evidence.workItemId,
      runId: evidence.runId,
      artifactId: evidence.artifactId
    }
  ]
  if (linked.acceptance) {
    scopes.push({
      label: 'acceptance',
      projectId: linked.acceptance.projectId,
      goalId: linked.acceptance.goalId,
      workItemId: linked.acceptance.workItemId
    })
  }
  pushRunScopes(scopes, linked, owned)
  pushArtifactScopes(scopes, linked, owned)
  if (owned.goal) {
    scopes.push({ label: 'Workflow evidence goal', projectId: owned.goal.projectId, goalId: owned.goal.id })
  }
  if (owned.workItem) {
    scopes.push({
      label: 'Workflow evidence work item',
      projectId: owned.workItem.projectId,
      goalId: owned.workItem.goalId,
      workItemId: owned.workItem.id
    })
  }
  assertOwnershipScopeAgreement(link.id, scopes)
}

function pushRunScopes(
  scopes: WorkflowOwnershipScope[],
  linked: EvidenceLinkReferences,
  owned: WorkflowEvidenceReferences
): void {
  for (const [label, record] of [
    ['linked run', linked.run],
    ['Workflow evidence run', owned.run]
  ] as const) {
    if (!record) continue
    scopes.push({
      label,
      projectId: record.projectId,
      goalId: record.goalId,
      workItemId: record.workItemId,
      runId: record.id
    })
  }
}

function pushArtifactScopes(
  scopes: WorkflowOwnershipScope[],
  linked: EvidenceLinkReferences,
  owned: WorkflowEvidenceReferences
): void {
  for (const [label, record] of [
    ['linked artifact', linked.artifact],
    ['Workflow evidence artifact', owned.artifact]
  ] as const) {
    if (!record) continue
    scopes.push({
      label,
      projectId: record.projectId,
      goalId: record.goalId,
      workItemId: record.workItemId,
      runId: record.runId,
      artifactId: record.id
    })
  }
}

function assertOwnershipScopeAgreement(linkId: string, scopes: readonly WorkflowOwnershipScope[]): void {
  const fields = ['goalId', 'workItemId', 'runId', 'artifactId'] as const
  for (let leftIndex = 0; leftIndex < scopes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < scopes.length; rightIndex += 1) {
      const left = scopes[leftIndex]
      const right = scopes[rightIndex]
      for (const field of fields) {
        if (left[field] !== undefined && right[field] !== undefined && left[field] !== right[field]) {
          throw new WorkflowLedgerCorruptionError(
            `evidence link ${linkId} ${left.label}/${right.label} ${field} ownership differs`
          )
        }
      }
    }
  }
}

function requireWorkflowEvidence(
  db: WorkflowLedgerDatabase,
  link: WorkflowEvidenceLinkRecord
): WorkflowEvidenceRecord {
  try {
    const evidence = listWorkflowEvidence(db, { evidenceId: link.evidenceId })[0]
    if (!evidence) {
      throw new WorkflowLedgerCorruptionError(
        `evidence link ${link.id} references missing Workflow evidence ${link.evidenceId}`
      )
    }
    return evidence
  } catch (error) {
    if (error instanceof WorkflowLedgerCorruptionError) throw error
    throw new WorkflowLedgerCorruptionError('workflow_evidence schema is unavailable')
  }
}
