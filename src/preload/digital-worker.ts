import { ipcRenderer } from 'electron'
import type {
  AcquireLeaseInput,
  AgentDeskApi,
  AssignmentOwnerCoordinateInput,
  AssignmentOwnerCoordinateResult,
  AssignmentOwnerCoordinatorAuditEvent,
  AssignmentOwnerJournalEntry,
  AssignmentOwnerRecoveryResult,
  AssignmentInput,
  DigitalWorker,
  DigitalWorkerApi,
  DigitalWorkerAssignment,
  DigitalWorkerAssignmentListFilter,
  DigitalWorkerAuditEvent,
  DigitalWorkerAuditListFilter,
  DigitalWorkerHeartbeatInput,
  DigitalWorkerLease,
  DigitalWorkerLeaseListFilter,
  DigitalWorkerLifecycleOptions,
  DigitalWorkerListOptions,
  DigitalWorkerReleaseOptions,
  DigitalWorkerReassignInput,
  DigitalWorkerReassignmentResult,
  DigitalWorkerRevisionOptions,
  DigitalWorkerRoleTemplateListOptions,
  DigitalWorkerStoreDocument,
  DigitalWorkerStoreVerification,
  LeaseTokenInput,
  RoleTemplate,
  RoleTemplateInput,
  RoleTemplatePatch
} from '../shared/types'

type DigitalWorkerBridgeApi = Pick<AgentDeskApi, keyof DigitalWorkerApi>

function invokeDigitalWorker<T>(
  action: keyof DigitalWorkerApi,
  payload?: Record<string, unknown>
): Promise<T> {
  const request = payload === undefined ? { action } : { action, payload }
  return ipcRenderer.invoke('digitalWorker:invoke', request)
}

export const digitalWorkerApi: DigitalWorkerBridgeApi = {
  verifyDigitalWorkerStore: (): Promise<DigitalWorkerStoreVerification> =>
    invokeDigitalWorker('verifyDigitalWorkerStore'),
  getDigitalWorkerStoreSnapshot: (): Promise<DigitalWorkerStoreDocument> =>
    invokeDigitalWorker('getDigitalWorkerStoreSnapshot'),
  listDigitalWorkerRoleTemplates: (options?: DigitalWorkerRoleTemplateListOptions): Promise<RoleTemplate[]> =>
    invokeDigitalWorker('listDigitalWorkerRoleTemplates', { options }),
  getDigitalWorkerRoleTemplate: (id: string): Promise<RoleTemplate | null> =>
    invokeDigitalWorker('getDigitalWorkerRoleTemplate', { id }),
  createDigitalWorkerRoleTemplate: (input: RoleTemplateInput): Promise<RoleTemplate> =>
    invokeDigitalWorker('createDigitalWorkerRoleTemplate', { input }),
  updateDigitalWorkerRoleTemplate: (
    id: string,
    patch: RoleTemplatePatch,
    options?: DigitalWorkerRevisionOptions
  ): Promise<RoleTemplate> => invokeDigitalWorker('updateDigitalWorkerRoleTemplate', { id, patch, options }),
  deleteDigitalWorkerRoleTemplate: (id: string, options?: DigitalWorkerRevisionOptions): Promise<boolean> =>
    invokeDigitalWorker('deleteDigitalWorkerRoleTemplate', { id, options }),
  listDigitalWorkers: (options?: DigitalWorkerListOptions): Promise<DigitalWorker[]> =>
    invokeDigitalWorker('listDigitalWorkers', { options }),
  getDigitalWorker: (id: string): Promise<DigitalWorker | null> =>
    invokeDigitalWorker('getDigitalWorker', { id }),
  createDigitalWorker: (input): Promise<DigitalWorker> =>
    invokeDigitalWorker('createDigitalWorker', { input }),
  updateDigitalWorker: (
    id: string,
    patch,
    options?: DigitalWorkerRevisionOptions
  ): Promise<DigitalWorker> => invokeDigitalWorker('updateDigitalWorker', { id, patch, options }),
  activateDigitalWorker: (id: string, options?: DigitalWorkerLifecycleOptions): Promise<DigitalWorker> =>
    invokeDigitalWorker('activateDigitalWorker', { id, options }),
  pauseDigitalWorker: (id: string, options?: DigitalWorkerLifecycleOptions): Promise<DigitalWorker> =>
    invokeDigitalWorker('pauseDigitalWorker', { id, options }),
  resumeDigitalWorker: (id: string, options?: DigitalWorkerLifecycleOptions): Promise<DigitalWorker> =>
    invokeDigitalWorker('resumeDigitalWorker', { id, options }),
  retireDigitalWorker: (id: string, options?: DigitalWorkerLifecycleOptions): Promise<DigitalWorker> =>
    invokeDigitalWorker('retireDigitalWorker', { id, options }),
  deleteDigitalWorker: (id: string, options?: DigitalWorkerRevisionOptions): Promise<boolean> =>
    invokeDigitalWorker('deleteDigitalWorker', { id, options }),
  getDigitalWorkerAssignment: (id: string): Promise<DigitalWorkerAssignment | null> =>
    invokeDigitalWorker('getDigitalWorkerAssignment', { id }),
  listDigitalWorkerAssignments: (filter?: DigitalWorkerAssignmentListFilter): Promise<DigitalWorkerAssignment[]> =>
    invokeDigitalWorker('listDigitalWorkerAssignments', { filter }),
  listDigitalWorkerAssignmentHistory: (
    filter?: Omit<DigitalWorkerAssignmentListFilter, 'includeHistory'>
  ): Promise<DigitalWorkerAssignment[]> => invokeDigitalWorker('listDigitalWorkerAssignmentHistory', { filter }),
  createDigitalWorkerAssignment: (input: AssignmentInput): Promise<DigitalWorkerAssignment> =>
    invokeDigitalWorker('createDigitalWorkerAssignment', { input }),
  releaseDigitalWorkerAssignment: (
    id: string,
    options?: DigitalWorkerRevisionOptions,
    releaseOptions?: DigitalWorkerReleaseOptions
  ): Promise<DigitalWorkerAssignment> => invokeDigitalWorker('releaseDigitalWorkerAssignment', { id, options, releaseOptions }),
  reassignDigitalWorkerAssignment: (input: DigitalWorkerReassignInput): Promise<DigitalWorkerReassignmentResult> =>
    invokeDigitalWorker('reassignDigitalWorkerAssignment', { input }),
  coordinateDigitalWorkerAssignmentOwner: (
    input: AssignmentOwnerCoordinateInput
  ): Promise<AssignmentOwnerCoordinateResult> =>
    invokeDigitalWorker('coordinateDigitalWorkerAssignmentOwner', { input }),
  recoverDigitalWorkerAssignmentOwners: (): Promise<AssignmentOwnerRecoveryResult[]> =>
    invokeDigitalWorker('recoverDigitalWorkerAssignmentOwners'),
  getDigitalWorkerAssignmentOwnerJournal: (requestId: string): Promise<AssignmentOwnerJournalEntry | null> =>
    invokeDigitalWorker('getDigitalWorkerAssignmentOwnerJournal', { requestId }),
  listDigitalWorkerAssignmentOwnerAudit: (
    requestId?: string
  ): Promise<AssignmentOwnerCoordinatorAuditEvent[]> =>
    invokeDigitalWorker('listDigitalWorkerAssignmentOwnerAudit', { requestId }),
  getDigitalWorkerLease: (id: string): Promise<DigitalWorkerLease | null> =>
    invokeDigitalWorker('getDigitalWorkerLease', { id }),
  listDigitalWorkerLeases: (filter?: DigitalWorkerLeaseListFilter): Promise<DigitalWorkerLease[]> =>
    invokeDigitalWorker('listDigitalWorkerLeases', { filter }),
  acquireDigitalWorkerLease: (input: AcquireLeaseInput): Promise<DigitalWorkerLease> =>
    invokeDigitalWorker('acquireDigitalWorkerLease', { input }),
  heartbeatDigitalWorkerLease: (input: DigitalWorkerHeartbeatInput): Promise<DigitalWorkerLease> =>
    invokeDigitalWorker('heartbeatDigitalWorkerLease', { input }),
  releaseDigitalWorkerLease: (input: LeaseTokenInput): Promise<DigitalWorkerLease> =>
    invokeDigitalWorker('releaseDigitalWorkerLease', { input }),
  listDigitalWorkerAuditEvents: (filter?: DigitalWorkerAuditListFilter): Promise<DigitalWorkerAuditEvent[]> =>
    invokeDigitalWorker('listDigitalWorkerAuditEvents', { filter })
}
