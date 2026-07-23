import type {
  AssignmentInput,
  AssignmentOwnerJournalEntry,
  DigitalWorkerReleaseOptions,
  DigitalWorkerRevisionOptions
} from '../../shared/digital-worker-types'
import type { AssignmentOwnerCrashPoint } from './errors'

export interface AssignmentOwnerCoordinatorOptions {
  rootDir: string
  faultInjector?: (
    point: AssignmentOwnerCrashPoint,
    entry: AssignmentOwnerJournalEntry
  ) => void | Promise<void>
}

export interface AssignmentOwnerCreateRequest {
  requestId: string
  input: AssignmentInput
  expectedWorkItemRevision?: number
  expectedProjectStoreRevision?: number
  expectedDigitalWorkerStoreRevision?: number
  ownerDisplayName?: string
}

export interface AssignmentOwnerReleaseRequest {
  requestId: string
  assignmentId: string
  options?: DigitalWorkerRevisionOptions
  releaseOptions?: DigitalWorkerReleaseOptions
}

export interface AssignmentOwnerReassignRequest {
  requestId: string
  currentAssignmentId: string
  nextInput: AssignmentInput
  expectedRevision?: number
  expectedStoreRevision?: number
  now?: number
  reason?: string
  ownerDisplayName?: string
}
