import { ipcRenderer } from 'electron'
import type { ModelAttemptRecoveryApi } from '../shared/model-attempt-types'

export const modelAttemptRecoveryApi: ModelAttemptRecoveryApi = {
  listModelAttemptReconciliations: () =>
    ipcRenderer.invoke('modelAttempts:listReconciliations'),
  resolveModelAttemptReconciliation: (attemptId, expectedRevision, resolution) =>
    ipcRenderer.invoke(
      'modelAttempts:resolveReconciliation',
      attemptId,
      expectedRevision,
      resolution
    )
}
