import { ipcRenderer } from 'electron'
import type {
  AgentDeskApi,
  SupervisorApprovalInput,
  SupervisorLeaseOptions,
  SupervisorMutationOptions,
  SupervisorRunInput,
  SupervisorStateApi
} from '../shared/types'

type SupervisorBridgeApi = Pick<AgentDeskApi, keyof SupervisorStateApi>

function invoke<T>(action: string, payload?: Record<string, unknown>): Promise<T> {
  return ipcRenderer.invoke('supervisor:invoke', payload === undefined ? { action } : { action, payload })
}

export const supervisorApi: SupervisorBridgeApi = {
  listSupervisorRuns: (options) => invoke('list', { options }),
  getSupervisorRun: (id) => invoke('get', { id }),
  listSupervisorEvents: (runId) => invoke('events', { runId }),
  createSupervisorRun: (input: SupervisorRunInput, options?: SupervisorMutationOptions) =>
    invoke('create', { input, options }),
  acquireSupervisorLease: (id: string, options: SupervisorLeaseOptions) =>
    invoke('lease:acquire', { id, options }),
  heartbeatSupervisorLease: (id: string, options: SupervisorLeaseOptions) =>
    invoke('lease:heartbeat', { id, options }),
  releaseSupervisorLease: (id: string, options: SupervisorLeaseOptions) =>
    invoke('lease:release', { id, options }),
  startSupervisorRun: (id: string, options: SupervisorLeaseOptions) =>
    invoke('start', { id, options }),
  pauseSupervisorRun: (id: string, options: SupervisorLeaseOptions) =>
    invoke('pause', { id, options }),
  resumeSupervisorRun: (id: string, options: SupervisorLeaseOptions) =>
    invoke('resume', { id, options }),
  requestSupervisorApproval: (
    id: string,
    approval: { id: string; reason?: string },
    options: SupervisorLeaseOptions
  ) => invoke('approval:request', { id, approval, options }),
  resolveSupervisorApproval: (id: string, input: SupervisorApprovalInput) =>
    invoke('approval:resolve', { id, input }),
  blockSupervisorRun: (id: string, options: SupervisorLeaseOptions) =>
    invoke('block', { id, options }),
  reconcileSupervisorRun: (id: string, options: SupervisorLeaseOptions) =>
    invoke('reconcile', { id, options }),
  failSupervisorRun: (id: string, error: string, options: SupervisorLeaseOptions) =>
    invoke('fail', { id, error, options }),
  completeSupervisorRun: (id: string, options: SupervisorLeaseOptions) =>
    invoke('complete', { id, options }),
  cancelSupervisorRun: (id: string, options?: SupervisorMutationOptions) =>
    invoke('cancel', { id, options }),
  retrySupervisorRun: (id: string, options?: SupervisorMutationOptions) =>
    invoke('retry', { id, options }),
  reassignSupervisorLease: (id: string, ownerId: string, options: SupervisorLeaseOptions) =>
    invoke('lease:reassign', { id, ownerId, options }),
  recoverSupervisorLeases: () => invoke('recover')
}
