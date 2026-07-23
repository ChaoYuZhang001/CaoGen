import type { WorkItem } from '../../shared/project-workspace-types'
import type {
  WorkflowAcceptanceCriterionPolicy,
  WorkflowAcceptanceRecord
} from '../../shared/workflow-types'
import { mutateTaskSnapshotDatabase, readTaskSnapshotDatabase } from './task-snapshot'
import {
  openWorkflowAcceptanceRepairCoordinator,
  workflowAcceptanceRepairAcceptanceId,
  type WorkflowAcceptanceRepairRecoveryResult,
  type WorkflowAcceptanceRepairResult
} from './workflow-acceptance-repair-coordinator'
import { findWorkflowAcceptance, readAcceptances } from './workflow-ledger-query'
import { projectWorkflowAcceptance, setupWorkflowLedgerSchema } from './workflow-ledger-store'
import { normalizeAcceptanceCriterionPolicies } from './workflow-acceptance-criterion-policy'

export interface WorkflowAcceptanceRepairMaterialization {
  repair: WorkflowAcceptanceRepairResult
  repairAcceptance: WorkflowAcceptanceRecord
}

export async function materializeWorkflowAcceptanceRepair(
  acceptance: WorkflowAcceptanceRecord,
  rootDir?: string
): Promise<WorkflowAcceptanceRepairMaterialization> {
  const coordinator = await openWorkflowAcceptanceRepairCoordinator(rootDir)
  const repair = await coordinator.createRepairForFailedAcceptance(acceptance)
  const repairAcceptance = await ensureWorkflowRepairAcceptance(
    repair.repairWorkItem,
    rootDir,
    acceptance.criterionPolicies
  )
  return { repair, repairAcceptance }
}

export async function ensureWorkflowRepairAcceptance(
  repairWorkItem: WorkItem,
  rootDir?: string,
  sourceCriterionPolicies?: readonly WorkflowAcceptanceCriterionPolicy[]
): Promise<WorkflowAcceptanceRecord> {
  return mutateTaskSnapshotDatabase(rootDir, (db) => {
    setupWorkflowLedgerSchema(db)
    const acceptanceId = workflowAcceptanceRepairAcceptanceId(repairWorkItem.id)
    const existing = findWorkflowAcceptance(db, acceptanceId)
    const criteria = repairWorkItem.acceptanceSpec.map((criterion) => criterion.criterion)
    const criterionPolicies = deriveWorkflowRepairCriterionPolicies(sourceCriterionPolicies, repairWorkItem)
    if (existing) {
      const existingCriterionPolicies = normalizeAcceptanceCriterionPolicies(
        existing.criterionPolicies,
        criteria.length
      )
      const bindingMatches = existing.projectId === repairWorkItem.projectId &&
        existing.goalId === repairWorkItem.goalId &&
        existing.workItemId === repairWorkItem.id &&
        JSON.stringify(existing.criteria) === JSON.stringify(criteria) &&
        criterionPoliciesEqual(existingCriterionPolicies, criterionPolicies)
      if (!bindingMatches) throw repairConflict(acceptanceId, repairWorkItem.id)
      return existing
    }
    return projectWorkflowAcceptance(db, {
      id: acceptanceId,
      projectId: repairWorkItem.projectId,
      ...(repairWorkItem.goalId === undefined ? {} : { goalId: repairWorkItem.goalId }),
      workItemId: repairWorkItem.id,
      criteria,
      ...(criterionPolicies === undefined ? {} : { criterionPolicies }),
      status: 'pending'
    }, { caller: 'system', actorId: 'workflow-acceptance-repair' })
  })
}

/**
 * A repair Acceptance is a new immutable record. Preserve the failed
 * Acceptance's evidence semantics while rebinding criterion identity to the
 * deterministic criteria carried by the repair WorkItem.
 */
export function deriveWorkflowRepairCriterionPolicies(
  sourceCriterionPolicies: readonly WorkflowAcceptanceCriterionPolicy[] | undefined,
  repairWorkItem: Pick<WorkItem, 'acceptanceSpec'>
): WorkflowAcceptanceCriterionPolicy[] | undefined {
  if (sourceCriterionPolicies === undefined) return undefined
  const normalized = normalizeAcceptanceCriterionPolicies(
    sourceCriterionPolicies,
    repairWorkItem.acceptanceSpec.length
  )
  if (!normalized) return undefined
  return normalized.map((policy) => {
    const criterion = repairWorkItem.acceptanceSpec[policy.criterionIndex]
    if (!criterion) {
      throw repairConflict('unknown', 'repair-work-item')
    }
    return {
      ...policy,
      criterionId: criterion.id,
      allowedSources: [...policy.allowedSources]
    }
  })
}

function criterionPoliciesEqual(
  left: WorkflowAcceptanceCriterionPolicy[] | undefined,
  right: WorkflowAcceptanceCriterionPolicy[] | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right
  if (left.length !== right.length) return false
  return left.every((policy, index) => {
    const expected = right[index]
    return policy.criterionId === expected.criterionId &&
      policy.criterionIndex === expected.criterionIndex &&
      policy.evidenceKind === expected.evidenceKind &&
      policy.allowedSources.length === expected.allowedSources.length &&
      policy.allowedSources.every((source, sourceIndex) => source === expected.allowedSources[sourceIndex])
  })
}

export async function recoverWorkflowAcceptanceRepairMaterializations(
  rootDir?: string
): Promise<WorkflowAcceptanceRepairRecoveryResult> {
  const failedAcceptances = await readTaskSnapshotDatabase(rootDir, (db) => {
    setupWorkflowLedgerSchema(db)
    return readAcceptances(db).filter((acceptance) => acceptance.status === 'failed')
  })
  if (failedAcceptances.length === 0) return { recovered: [], failures: [] }

  const coordinator = await openWorkflowAcceptanceRepairCoordinator(rootDir)
  const result = await coordinator.recoverPending(failedAcceptances)
  for (const repair of result.recovered) {
    try {
      const failedAcceptance = failedAcceptances.find((candidate) =>
        candidate.id === repair.acceptanceId && candidate.revision === repair.failedAcceptanceRevision
      )
      if (!failedAcceptance) {
        throw new Error(
          `failed Acceptance ${repair.acceptanceId} revision ${repair.failedAcceptanceRevision} disappeared during repair recovery`
        )
      }
      await ensureWorkflowRepairAcceptance(
        repair.repairWorkItem,
        rootDir,
        failedAcceptance.criterionPolicies
      )
    } catch (error) {
      result.failures.push({
        acceptanceId: repair.acceptanceId,
        failedAcceptanceRevision: repair.failedAcceptanceRevision,
        ...(readErrorCode(error) ? { code: readErrorCode(error) } : {}),
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return result
}

function repairConflict(acceptanceId: string, workItemId: string): Error & { code: string } {
  const error = new Error(`repair Acceptance ${acceptanceId} conflicts with WorkItem ${workItemId}`) as Error & { code: string }
  error.name = 'WorkflowAcceptanceRepairConflictError'
  error.code = 'WORKFLOW_REPAIR_CONFLICT'
  return error
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  return typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}
