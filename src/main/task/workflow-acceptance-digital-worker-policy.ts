import { app } from 'electron'
import type {
  DigitalWorker,
  DigitalWorkerAssignment
} from '../../shared/digital-worker-types'
import type { WorkflowWorkItemRecord } from '../../shared/workflow-types'
import { DigitalWorkerStore } from '../digital-worker/domain-store'

export interface DigitalWorkerAcceptanceContext {
  assignment: DigitalWorkerAssignment
  worker: DigitalWorker
  minimumEvidenceCount: number
  requireUserApproval: boolean
}

export type DigitalWorkerAcceptanceResolution =
  | { status: 'not_applicable' }
  | { status: 'resolved'; context: DigitalWorkerAcceptanceContext }
  | {
      status: 'denied'
      message: string
      reason: string
      details: Record<string, unknown>
    }

export function resolveDigitalWorkerAcceptanceContext(
  workItem?: WorkflowWorkItemRecord
): DigitalWorkerAcceptanceResolution {
  if (!workItem) return { status: 'not_applicable' }
  let document
  try {
    document = new DigitalWorkerStore(app.getPath('userData')).read()
  } catch (error) {
    return {
      status: 'denied',
      message: `WorkItem ${workItem.id} cannot resolve its DigitalWorker policy store`,
      reason: 'digital_worker_store_invalid',
      details: { cause: error instanceof Error ? error.message : String(error) }
    }
  }
  const matching = document.assignments.filter((assignment) =>
    assignment.projectId === workItem.projectId && assignment.workItemId === workItem.id
  )
  if (matching.length === 0) return { status: 'not_applicable' }
  const assignment = selectAcceptanceAssignment(matching)
  if (assignment.assigneeKind !== 'digital_worker') return { status: 'not_applicable' }
  const worker = document.workers.find((candidate) => candidate.id === assignment.assigneeId)
  if (!worker || worker.projectId !== workItem.projectId) {
    return {
      status: 'denied',
      message: `WorkItem ${workItem.id} has an invalid DigitalWorker Assignment linkage`,
      reason: worker ? 'digital_worker_project_mismatch' : 'digital_worker_missing',
      details: { assignmentId: assignment.id, workerId: assignment.assigneeId }
    }
  }
  const minimumEvidenceCount = worker.acceptancePolicy.minimumEvidenceCount
  const requireUserApproval = worker.acceptancePolicy.requireUserApproval
  if (
    typeof minimumEvidenceCount !== 'number' ||
    !Number.isSafeInteger(minimumEvidenceCount) ||
    minimumEvidenceCount < 0 ||
    typeof requireUserApproval !== 'boolean'
  ) {
    return {
      status: 'denied',
      message: `DigitalWorker ${worker.id} has an invalid acceptancePolicy`,
      reason: 'acceptance_policy_invalid',
      details: { assignmentId: assignment.id, workerId: worker.id }
    }
  }
  return {
    status: 'resolved',
    context: { assignment, worker, minimumEvidenceCount, requireUserApproval }
  }
}

function selectAcceptanceAssignment(
  assignments: readonly DigitalWorkerAssignment[]
): DigitalWorkerAssignment {
  return [...assignments].sort((left, right) => {
    const statusOrder = Number(right.status === 'active') - Number(left.status === 'active')
    if (statusOrder !== 0) return statusOrder
    if (left.assignedAt !== right.assignedAt) return right.assignedAt - left.assignedAt
    return right.id.localeCompare(left.id)
  })[0]
}
