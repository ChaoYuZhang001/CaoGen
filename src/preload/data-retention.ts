import { ipcRenderer } from 'electron'
import type {
  AgentDeskApi,
  DataLegalHoldCreateInput,
  DataLegalHoldReleaseInput,
  DataPurgeEvaluationInput,
  DataRetentionPolicyUpdateInput
} from '../shared/types'

export const dataRetentionApi: Pick<AgentDeskApi,
  | 'getDataRetentionAuthority'
  | 'updateDataRetentionPolicy'
  | 'createDataLegalHold'
  | 'releaseDataLegalHold'
  | 'evaluateDataPurge'
  | 'saveDataRetentionAuthorityExport'
  | 'getDataRetentionPendingDeletions'
> = {
  getDataRetentionAuthority: () => ipcRenderer.invoke('dataRetention:get'),
  updateDataRetentionPolicy: (input: DataRetentionPolicyUpdateInput) =>
    ipcRenderer.invoke('dataRetention:updatePolicy', input),
  createDataLegalHold: (input: DataLegalHoldCreateInput) =>
    ipcRenderer.invoke('dataRetention:createLegalHold', input),
  releaseDataLegalHold: (input: DataLegalHoldReleaseInput) =>
    ipcRenderer.invoke('dataRetention:releaseLegalHold', input),
  evaluateDataPurge: (input: DataPurgeEvaluationInput) =>
    ipcRenderer.invoke('dataRetention:evaluatePurge', input),
  saveDataRetentionAuthorityExport: () => ipcRenderer.invoke('dataRetention:saveExport'),
  getDataRetentionPendingDeletions: () => ipcRenderer.invoke('dataRetention:pending')
}
