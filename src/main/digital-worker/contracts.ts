import type {
  AssignmentStatus,
  DigitalWorkerAssignment,
  DigitalWorkerAuditEvent,
  DigitalWorkerStoreDocument,
  LeaseTokenInput,
  WorkerLeaseStatus
} from '../../shared/digital-worker-types'

export interface DigitalWorkerStoreOptions {
  rootDir?: string
  filePath?: string
}

export interface RevisionOptions {
  expectedRevision?: number
  expectedStoreRevision?: number
}

export interface WorkerLifecycleOptions extends RevisionOptions {
  now?: number
}

export interface AssignmentListFilter {
  projectId?: string
  workItemId?: string
  assigneeId?: string
  assigneeKind?: 'digital_worker' | 'human'
  status?: AssignmentStatus
  includeHistory?: boolean
}

export interface LeaseListFilter {
  projectId?: string
  workItemId?: string
  workerId?: string
  status?: WorkerLeaseStatus
  includeExpired?: boolean
}

export interface AuditListFilter {
  projectId?: string
  entityId?: string
  kind?: DigitalWorkerAuditEvent['kind']
}

export interface LeaseHeartbeatInput extends LeaseTokenInput {
  ttlMs?: number
}

export interface ReassignResult {
  released: DigitalWorkerAssignment
  assigned: DigitalWorkerAssignment
}

export interface StoreVerification {
  valid: true
  schemaVersion: number
  revision: number
  counts: {
    roleTemplates: number
    workers: number
    assignments: number
    leases: number
    audit: number
  }
}

export type DigitalWorkerMutation<T> = (document: DigitalWorkerStoreDocument) => T
